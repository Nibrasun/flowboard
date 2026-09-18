"""User image/video upload to Google Flow.

Multipart upload that base64-encodes the bytes, hands them to
``FlowSDK.upload_image`` (which goes through the extension to
``/v1/flow/uploadImage``), and on success caches the bytes locally keyed by
the Flow-issued media_id.

Images and short reference videos share the same route — Flow's uploadImage
is a generic media upload (the ``imageBytes`` field carries any media the
``mimeType`` describes; video is how the v2v motion-transfer chat agent
receives its reference clip). The route sniffs magic bytes to classify
video vs image, applies the right size cap and mime allowlist, and records
the Asset row with ``kind`` = ``image`` | ``video``.

Design choices:
- Run synchronously rather than through the worker queue. Upload is one
  round-trip and the caller (character node UI / v2v dialog) needs the
  media_id immediately.
- Project-scoped: Flow's uploadImage requires ``clientContext.projectId``.
  Frontend must call ``ensureBoardProject`` first and pass the ``project_id``.
- Size caps and mime allowlists applied here as defence-in-depth;
  the route never trusts the browser-supplied content-type alone.
"""
from __future__ import annotations

import base64
import ipaddress
import logging
import socket
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Asset
from flowboard.services import media as media_service
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["upload"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB (images)
MAX_VIDEO_UPLOAD_BYTES = 200 * 1024 * 1024  # 200 MB (reference video clips)
ALLOWED_UPLOAD_MIMES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}
ALLOWED_VIDEO_MIMES = {
    "video/mp4",
    "video/webm",
    "video/quicktime",
}
_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
}


def _sniff_video_mime(raw: bytes) -> Optional[str]:
    """Detect mp4/mov/webm from magic bytes.

    MP4 and QuickTime both start with a size+``ftyp`` box — the major brand
    (bytes 8-12) disambiguates: ``qt  `` → QuickTime, anything else → MP4.
    WebM (EBML container) starts with the 0x1A45DFA3 doc-id marker.
    """
    if len(raw) < 12:
        return None
    if raw[4:8] == b"ftyp":
        brand = raw[8:12]
        if brand == b"qt  ":
            return "video/quicktime"
        return "video/mp4"
    if raw[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    return None


def _sniff_image_mime(raw: bytes) -> Optional[str]:
    """Detect mime from magic bytes — used when the remote server doesn't send
    a usable Content-Type or when we want to reject a lying Content-Type."""
    if len(raw) < 12:
        return None
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def _classify_aspect(width: int, height: int) -> str:
    """Classify a pixel size into Flow's IMAGE_ASPECT_RATIO_* enum so the
    frontend can default a downstream gen-dialog to match the upstream
    asset's aspect (matches what `dispatchGeneration` later persists for
    AI-generated nodes)."""
    if width <= 0 or height <= 0:
        return "IMAGE_ASPECT_RATIO_LANDSCAPE"
    ratio = width / height
    # 10% tolerance band around 1:1 → square. flowkit / Veo's enums only
    # have square / portrait / landscape — anything ratio-close maps to
    # the nearest bucket.
    if 0.91 <= ratio <= 1.1:
        return "IMAGE_ASPECT_RATIO_SQUARE"
    if ratio > 1.1:
        return "IMAGE_ASPECT_RATIO_LANDSCAPE"
    return "IMAGE_ASPECT_RATIO_PORTRAIT"


def _sniff_image_dimensions(raw: bytes) -> Optional[tuple[int, int]]:
    """Extract (width, height) from PNG / JPEG / WebP / GIF magic-block
    headers without spinning up Pillow — same defence-in-depth philosophy
    as ``_sniff_image_mime``. Returns None when format is unknown or the
    header is truncated."""
    if len(raw) < 24:
        return None
    # PNG: IHDR after the 8-byte sig holds width, height as big-endian u32
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        try:
            w = int.from_bytes(raw[16:20], "big")
            h = int.from_bytes(raw[20:24], "big")
            return w, h
        except Exception:  # noqa: BLE001
            return None
    # GIF: 6-byte sig + 2 bytes width LE + 2 bytes height LE
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        try:
            w = int.from_bytes(raw[6:8], "little")
            h = int.from_bytes(raw[8:10], "little")
            return w, h
        except Exception:  # noqa: BLE001
            return None
    # WebP (VP8/VP8L/VP8X) — only handle the simple lossy VP8 case fully;
    # we still extract via the VP8X chunk for the extended format.
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        chunk = raw[12:16]
        if chunk == b"VP8 " and len(raw) >= 30:
            w = int.from_bytes(raw[26:28], "little") & 0x3FFF
            h = int.from_bytes(raw[28:30], "little") & 0x3FFF
            return w, h
        if chunk == b"VP8L" and len(raw) >= 25:
            b = raw[21:25]
            w = ((b[1] & 0x3F) << 8 | b[0]) + 1
            h = ((b[3] & 0x0F) << 10 | b[2] << 2 | (b[1] & 0xC0) >> 6) + 1
            return w, h
        if chunk == b"VP8X" and len(raw) >= 30:
            w = (int.from_bytes(raw[24:27], "little") & 0xFFFFFF) + 1
            h = (int.from_bytes(raw[27:30], "little") & 0xFFFFFF) + 1
            return w, h
        return None
    # JPEG: scan for SOF0/SOF1/SOF2 marker (FFC0..FFC3 etc.)
    if raw.startswith(b"\xff\xd8\xff"):
        i = 2
        n = len(raw)
        sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
        try:
            while i < n - 9:
                if raw[i] != 0xFF:
                    return None
                marker = raw[i + 1]
                # Standalone markers / restart markers — skip without length
                if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                    i += 2
                    continue
                # Segment with length
                seg_len = int.from_bytes(raw[i + 2 : i + 4], "big")
                if marker in sof_markers:
                    h = int.from_bytes(raw[i + 5 : i + 7], "big")
                    w = int.from_bytes(raw[i + 7 : i + 9], "big")
                    return w, h
                i += 2 + seg_len
            return None
        except Exception:  # noqa: BLE001
            return None
    return None


def _is_public_host(host: str) -> bool:
    """Reject SSRF targets — link uploads must point to a public host, never
    loopback / private / link-local. The agent runs on the user's box; without
    this, a malicious link could pivot to the local network."""
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False
        if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


async def _ingest_media_bytes(
    raw: bytes,
    mime: str,
    project_id: str,
    file_name: str,
    node_id: Optional[int],
    *,
    kind: str = "image",
) -> dict:
    """Push bytes to Flow, cache locally, upsert Asset row.

    ``kind`` is recorded on the Asset row (``image`` | ``video``) so the
    media cache / status API can distinguish upload provenance. Images go
    through ``uploadImage``; videos go through the labs.google resumable
    ``upload-video`` endpoint (``uploadImage`` 400s on video bytes with
    INVALID_ARGUMENT) — see ``FlowSDK.upload_video``.
    """
    if kind == "video":
        resp = await get_flow_sdk().upload_video(
            video_bytes=raw,
            mime_type=mime,
            project_id=project_id,
            file_name=file_name,
        )
    else:
        image_b64 = base64.b64encode(raw).decode("ascii")
        resp = await get_flow_sdk().upload_image(
            image_base64=image_b64,
            mime_type=mime,
            project_id=project_id,
            file_name=file_name,
        )
    if resp.get("error"):
        raise HTTPException(
            status_code=502,
            detail={"message": resp["error"], "stage": resp.get("stage"), "raw": resp.get("raw")},
        )
    media_id = resp.get("media_id")
    if not isinstance(media_id, str) or not media_service.is_valid_media_id(media_id):
        raise HTTPException(
            status_code=502,
            detail={"message": "invalid media_id from Flow", "raw": resp.get("raw")},
        )
    ext = _EXT_BY_MIME.get(mime, ".bin")
    cache_path = media_service.MEDIA_CACHE_DIR / f"{media_id}{ext}"
    try:
        cache_path.write_bytes(raw)
    except OSError as exc:
        logger.error("failed to write upload cache %s: %s", cache_path, exc)
        raise HTTPException(status_code=500, detail="failed to cache upload")
    with get_session() as s:
        row = s.exec(
            select(Asset).where(Asset.uuid_media_id == media_id)
        ).first()
        if row is None:
            row = Asset(
                uuid_media_id=media_id,
                kind=kind,
                local_path=str(cache_path),
                mime=mime,
                node_id=node_id,
            )
        else:
            row.local_path = str(cache_path)
            row.mime = mime
            if node_id is not None and row.node_id is None:
                row.node_id = node_id
        s.add(row)
        s.commit()
    out: dict = {"media_id": media_id, "mime": mime, "size": len(raw), "kind": kind}
    if kind == "image":
        dims = _sniff_image_dimensions(raw)
        if dims is not None:
            w, h = dims
            out["width"] = w
            out["height"] = h
            out["aspect_ratio"] = _classify_aspect(w, h)
    return out


@router.post("/upload")
async def upload_image(
    project_id: str = Form(...),
    node_id: Optional[int] = Form(default=None),
    file: UploadFile = File(...),
):
    if not is_valid_project_id(project_id):
        raise HTTPException(status_code=400, detail="invalid project_id")

    mime = (file.content_type or "").lower().split(";")[0].strip()
    is_video = mime in ALLOWED_VIDEO_MIMES
    if not is_video and mime not in ALLOWED_UPLOAD_MIMES:
        raise HTTPException(
            status_code=415,
            detail=f"unsupported mime: {mime!r}; allowed: {sorted(ALLOWED_UPLOAD_MIMES | ALLOWED_VIDEO_MIMES)}",
        )

    # Read with a hard cap so a hostile client can't OOM us by streaming
    # forever. Read MAX+1 bytes; if we got more than MAX, reject.
    # Videos get a much larger budget than images (reference clips are
    # typically 5–50 MB; the 200 MB ceiling covers 4K sources).
    cap = MAX_VIDEO_UPLOAD_BYTES if is_video else MAX_UPLOAD_BYTES
    raw = await file.read(cap + 1)
    size = len(raw)
    if size == 0:
        raise HTTPException(status_code=400, detail="empty file")
    if size > cap:
        raise HTTPException(
            status_code=413,
            detail=f"file too large: {size} > {cap}",
        )

    # Magic-byte sniff is the source of truth (a browser may lie about
    # content-type). For video we also fall back to sniffing when the
    # declared type is ambiguous; a mismatch between declared and sniffed
    # type is resolved in favour of the bytes.
    if is_video:
        sniffed = _sniff_video_mime(raw)
        if sniffed is None:
            raise HTTPException(
                status_code=415,
                detail=f"not a recognized video container (content-type {mime!r}, no ftyp/EBML magic)",
            )
        mime = sniffed
    else:
        sniffed = _sniff_image_mime(raw)
        if sniffed is None:
            raise HTTPException(
                status_code=415,
                detail=f"not an image (content-type {mime!r}, no magic bytes match)",
            )
        mime = sniffed

    file_name = file.filename or f"upload{_EXT_BY_MIME.get(mime, '')}"
    out = await _ingest_media_bytes(
        raw, mime, project_id, file_name, node_id,
        kind="video" if is_video else "image",
    )
    logger.info("upload: media_id=%s size=%d mime=%s kind=%s", out["media_id"], size, mime, out["kind"])
    return out


class UrlUploadBody(BaseModel):
    url: str
    project_id: str
    node_id: Optional[int] = None


@router.post("/upload-url")
async def upload_image_from_url(body: UrlUploadBody):
    """Fetch an image or video at ``body.url`` server-side, validate, then push it
    through the same Flow upload pipeline as ``/upload``. CORS-free
    alternative to having the browser fetch the URL itself. Video URLs
    (mp4/webm/mov) are ingested with ``kind="video"`` so VR nodes can
    Add-link a motion clip the same way visual assets link images."""
    if not is_valid_project_id(body.project_id):
        raise HTTPException(status_code=400, detail="invalid project_id")

    parsed = urlparse(body.url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="url must be http(s)")
    if not parsed.netloc:
        raise HTTPException(status_code=400, detail="url missing host")
    if not _is_public_host(parsed.hostname or ""):
        raise HTTPException(status_code=400, detail="url host not public")

    try:
        async with httpx.AsyncClient(
            timeout=15.0, follow_redirects=True, headers={"User-Agent": "Flowboard/0.1"}
        ) as client:
            resp = await client.get(body.url)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"fetch failed: {exc}")

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502, detail=f"fetch returned status {resp.status_code}"
        )

    raw = resp.content
    size = len(raw)
    if size == 0:
        raise HTTPException(status_code=502, detail="empty response body")

    mime = (resp.headers.get("content-type", "") or "").lower().split(";")[0].strip()
    # Server's Content-Type is the hint; magic-byte sniff is the source of
    # truth (a misconfigured server, or one returning text/html for an HTTP
    # error masquerading as 200, must not slip through). Both image and
    # video containers are accepted — VR nodes fetch mp4/webm/mov clips.
    sniffed = _sniff_image_mime(raw) or _sniff_video_mime(raw)
    allowed = ALLOWED_UPLOAD_MIMES | ALLOWED_VIDEO_MIMES
    if mime not in allowed:
        if sniffed is None:
            raise HTTPException(
                status_code=415,
                detail=f"not an image or video (content-type {mime!r}, no magic bytes match)",
            )
        mime = sniffed
    elif sniffed is not None and sniffed != mime:
        # Trust the magic bytes if they disagree.
        mime = sniffed
    kind = "video" if mime in ALLOWED_VIDEO_MIMES else "image"
    cap = MAX_VIDEO_UPLOAD_BYTES if kind == "video" else MAX_UPLOAD_BYTES
    if size > cap:
        raise HTTPException(
            status_code=413, detail=f"file too large: {size} > {cap}"
        )

    # Derive a filename from the URL path or fall back to a generic one.
    path_name = (parsed.path.rstrip("/").rsplit("/", 1)[-1] or kind).lower()
    if "." not in path_name:
        path_name = path_name + _EXT_BY_MIME.get(mime, "")

    out = await _ingest_media_bytes(raw, mime, body.project_id, path_name, body.node_id, kind=kind)
    logger.info(
        "upload-url: media_id=%s size=%d mime=%s host=%s",
        out["media_id"], size, mime, parsed.netloc,
    )
    return out
