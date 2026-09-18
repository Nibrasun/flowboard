"""Resolve a pasted link to a directly playable video URL — no download.

Add-link on VR nodes must not download anything locally: a lightweight
probe (HEAD, then ranged GET for magic bytes) decides whether the URL is
already a direct media file; TikTok share links are resolved from the
page's embedded JSON; anything else falls back to an optional
self-hosted cobalt instance (TikTok / YouTube / Instagram / ...).

Only at Generate time does the worker fetch bytes (streamed, in-memory)
and push them straight to Flow — never written to storage/media.

Env:
    FLOWBOARD_COBALT_API_URL — base URL of a self-hosted cobalt API
    instance, e.g. http://localhost:9000 . Empty = generic share-link
    resolving disabled (direct links + TikTok still work).
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

COBALT_API_URL = os.getenv("FLOWBOARD_COBALT_API_URL", "").strip().rstrip("/")
COBALT_TIMEOUT_S = 20.0
HEAD_TIMEOUT_S = 10.0

DIRECT_VIDEO_EXTS = (".mp4", ".webm", ".mov")


class ResolveError(Exception):
    """Machine-readable resolve failure (message IS the error code)."""


def _looks_direct(path: str) -> bool:
    return path.lower().rstrip("/").endswith(DIRECT_VIDEO_EXTS)


_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
_PROBE_CHUNK_MAX = 65536


def _looks_video_magic(head: bytes) -> bool:
    """True if the first bytes are an MP4/MOV (ftyp) or WebM (EBML) container."""
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return True
    return len(head) >= 4 and head[:4] == b"\x1a\x45\xdf\xa3"


async def _probe(url: str) -> tuple[Optional[str], bytes]:
    """Identify the URL without downloading the body.

    Returns (content-type or None, first-chunk bytes, possibly empty).
    HEAD first; many hosts reject HEAD (405) or block unknown UAs, so fall
    back to a ranged GET (first 64 KB) which also yields magic bytes for
    extensionless / signed URLs. Total network failure → (None, b"").
    """
    try:
        async with httpx.AsyncClient(
            timeout=HEAD_TIMEOUT_S,
            follow_redirects=True,
            headers={"User-Agent": _BROWSER_UA},
        ) as client:
            try:
                resp = await client.head(url)
                if resp.status_code == 200:
                    mime = (resp.headers.get("content-type", "") or "").lower().split(";")[0].strip()
                    if mime:
                        return mime, b""
            except httpx.HTTPError:
                pass
            try:
                async with client.stream(
                    "GET", url, headers={"Range": f"bytes=0-{_PROBE_CHUNK_MAX - 1}"}
                ) as resp:
                    if resp.status_code not in (200, 206, 416):
                        return None, b""
                    mime = (resp.headers.get("content-type", "") or "").lower().split(";")[0].strip()
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in resp.aiter_bytes(16384):
                        chunks.append(chunk)
                        total += len(chunk)
                        if total >= _PROBE_CHUNK_MAX:
                            break
                    return mime or None, b"".join(chunks)
            except httpx.HTTPError:
                return None, b""
    except Exception:
        return None, b""


TIKTOK_HOSTS = ("tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com")
_TIKTOK_ADDR_RES = (
    re.compile(r'"playAddr"\s*:\s*"((?:[^"\\]|\\.)+)"'),
    re.compile(r'"downloadAddr"\s*:\s*"((?:[^"\\]|\\.)+)"'),
)


def _is_tiktok_host(host: str) -> bool:
    host = (host or "").lower()
    return host in TIKTOK_HOSTS or host.endswith(".tiktok.com")


def _unescape_url(raw: str) -> Optional[str]:
    try:
        url = json.loads(f'"{raw}"')
    except ValueError:
        return None
    if isinstance(url, str) and url.startswith("http"):
        return url.replace("\\/", "/")
    return None


async def _fetch_page(url: str) -> str:
    """GET a share page's HTML (follows short-link redirects)."""
    try:
        async with httpx.AsyncClient(
            timeout=20.0,
            follow_redirects=True,
            headers={
                "User-Agent": _BROWSER_UA,
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://www.tiktok.com/",
            },
        ) as client:
            resp = await client.get(url)
    except httpx.HTTPError as exc:
        raise ResolveError(f"tiktok_unreachable: {exc!r}"[:200])
    if resp.status_code == 404:
        raise ResolveError("tiktok_not_found")
    if resp.status_code != 200:
        raise ResolveError(f"tiktok_http_{resp.status_code}")
    return resp.text


async def _resolve_tiktok(url: str) -> dict[str, Any]:
    """Resolve a TikTok share/short link from the page's embedded JSON.

    Prefers watermark-free playAddr, falls back to downloadAddr. The
    candidate is verified with a probe; if the CDN won't answer the
    probe, the first candidate is still returned (the worker validates
    magic bytes at Generate time and reports clearly on failure).
    """
    html = await _fetch_page(url)
    candidates: list[str] = []
    for rx in _TIKTOK_ADDR_RES:
        for m in rx.finditer(html):
            real = _unescape_url(m.group(1))
            if real and real not in candidates:
                candidates.append(real)
    if not candidates:
        raise ResolveError(
            "tiktok_blocked: tidak ada URL video di halaman (login wall / captcha / video privat)"
        )
    for cand in candidates:
        mime, head = await _probe(cand)
        if (mime and mime.startswith("video/")) or (head and _looks_video_magic(head)):
            return {"mode": "direct", "url": cand, "mime": mime or "video/mp4", "provider": "tiktok"}
    logger.warning("tiktok probe unverified, returning first of %d candidates", len(candidates))
    return {"mode": "direct", "url": candidates[0], "provider": "tiktok"}


async def _cobalt_resolve(url: str) -> dict[str, Any]:
    """Ask the cobalt instance to resolve a share link. No bytes fetched."""
    if not COBALT_API_URL:
        raise ResolveError("cobalt_not_configured")
    try:
        async with httpx.AsyncClient(timeout=COBALT_TIMEOUT_S) as client:
            resp = await client.post(
                f"{COBALT_API_URL}/",
                headers={"Accept": "application/json", "Content-Type": "application/json"},
                json={
                    "url": url,
                    "downloadMode": "auto",
                    "videoQuality": "1080",
                    "filenameStyle": "basic",
                },
            )
    except httpx.HTTPError as exc:
        raise ResolveError(f"cobalt_unreachable: {exc!r}"[:200])
    try:
        data = resp.json()
    except ValueError:
        raise ResolveError(f"cobalt_bad_response: http_{resp.status_code}")
    status = data.get("status")
    if status in ("tunnel", "redirect") and isinstance(data.get("url"), str):
        return {"mode": "direct", "url": data["url"], "provider": "cobalt"}
    if status == "picker" and isinstance(data.get("picker"), list):
        items = [
            {"type": it.get("type", "video"), "url": it.get("url"), "thumb": it.get("thumb")}
            for it in data["picker"]
            if isinstance(it, dict) and isinstance(it.get("url"), str)
        ]
        items = [it for it in items if it["type"] in ("video", "gif")]
        if not items:
            raise ResolveError("cobalt_picker_empty")
        if len(items) == 1:
            return {"mode": "direct", "url": items[0]["url"], "provider": "cobalt"}
        return {"mode": "picker", "items": items, "provider": "cobalt"}
    if status == "local-processing":
        raise ResolveError("cobalt_needs_local_processing")
    code = ""
    if isinstance(data.get("error"), dict):
        code = str(data["error"].get("code") or "")
    raise ResolveError(f"cobalt_error: {code or 'unknown'}"[:200])


async def resolve_video_url(url: str) -> dict[str, Any]:
    """Resolve ``url`` to a directly playable video URL.

    Returns ``{"mode": "direct", "url", ...}`` or
    ``{"mode": "picker", "items": [...]}``. Raises ResolveError.
    Never downloads more than the first 64 KB (probe only).
    """
    parsed = urlparse(url)
    mime, head = await _probe(url)
    if mime and mime.startswith("video/"):
        return {"mode": "direct", "url": url, "mime": mime}
    if mime and mime.startswith("image/"):
        raise ResolveError("not_a_video")
    if head and _looks_video_magic(head):
        # Extensionless / signed direct link (CDN token URL, ?download=1).
        return {"mode": "direct", "url": url, "mime": mime or "video/mp4"}
    if _looks_direct(parsed.path or "") and (
        not mime or ("html" not in mime and not mime.startswith("text/"))
    ):
        # HEAD blocked but path is explicit; worker re-validates magic
        # bytes at Generate time.
        out: dict[str, Any] = {"mode": "direct", "url": url}
        if mime:
            out["mime"] = mime
        return out
    if not mime and not head:
        # Host unreachable from the agent (DNS/timeout/blocked) and no
        # direct-looking path, so say so instead of blaming cobalt.
        if _is_tiktok_host(parsed.hostname or ""):
            # Page fetch gives a sharper error (404 / wall / unreachable).
            return await _resolve_tiktok(url)
        raise ResolveError("unreachable: agent tidak bisa menjangkau URL ini")
    if _is_tiktok_host(parsed.hostname or ""):
        # Share page (probe saw HTML) — scrape playAddr from page JSON.
        return await _resolve_tiktok(url)
    # Looks like some other page / share link (YouTube / IG / ...) → cobalt.
    return await _cobalt_resolve(url)


async def fetch_video_bytes(url: str, max_bytes: int) -> tuple[bytes, str]:
    """Stream GET ``url`` into memory (never disk). Returns (bytes, header mime).

    Raises ResolveError on network failure / oversize / empty.
    """
    try:
        async with httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True,
            headers={"User-Agent": _BROWSER_UA},
        ) as client:
            async with client.stream("GET", url) as resp:
                if resp.status_code != 200:
                    raise ResolveError(f"fetch_status_{resp.status_code}")
                mime = (resp.headers.get("content-type", "") or "").lower().split(";")[0].strip()
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.aiter_bytes(1024 * 256):
                    total += len(chunk)
                    if total > max_bytes:
                        raise ResolveError(f"file_too_large: {total} > {max_bytes}")
                    chunks.append(chunk)
    except httpx.HTTPError as exc:
        raise ResolveError(f"fetch_failed: {exc!r}"[:200])
    raw = b"".join(chunks)
    if not raw:
        raise ResolveError("empty_response_body")
    return raw, mime
