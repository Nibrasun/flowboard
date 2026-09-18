"""POST /api/resolve-url — resolve a pasted link to a streamable video URL.

Pure metadata: one HEAD request, or one JSON call to the optional
self-hosted cobalt instance. Nothing is downloaded, nothing is cached,
no project_id involved. The URL is stored on the VR node as-is and only
fetched (in-memory) at Generate time.
"""
from __future__ import annotations

import logging
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.services.url_resolve import ResolveError, resolve_video_url
from flowboard.routes.upload import _is_public_host

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["resolve"])


class ResolveUrlBody(BaseModel):
    url: str


@router.post("/resolve-url")
async def resolve_url(body: ResolveUrlBody) -> dict[str, Any]:
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url required")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="url must be http(s)")
    if not parsed.netloc:
        raise HTTPException(status_code=400, detail="url missing host")
    if not _is_public_host(parsed.hostname or ""):
        raise HTTPException(status_code=400, detail="url host not public")
    try:
        out = await resolve_video_url(url)
    except ResolveError as exc:
        msg = str(exc)
        if msg == "cobalt_not_configured":
            raise HTTPException(
                status_code=422,
                detail="bukan link video langsung — tempel URL mp4/webm/mov atau TikTok, "
                "atau set FLOWBOARD_COBALT_API_URL untuk link YouTube/IG",
            )
        raise HTTPException(status_code=502, detail=msg)
    logger.info("resolve-url: mode=%s host=%s", out.get("mode"), parsed.netloc)
    return out
