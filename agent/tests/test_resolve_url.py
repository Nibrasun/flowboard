"""Link-only VR (Add-link without download).

POST /api/resolve-url resolves to a streamable URL without fetching any
body; the worker fetches bytes in-memory at Generate time and pushes
straight to Flow (never to storage/media).
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flowboard.services.url_resolve import ResolveError
from flowboard.worker import processor as proc


def test_resolve_url_direct_passthrough(client, monkeypatch):
    import flowboard.routes.resolve as resolve_route

    monkeypatch.setattr(resolve_route, "_is_public_host", lambda host: True)
    monkeypatch.setattr(
        resolve_route,
        "resolve_video_url",
        AsyncMock(return_value={"mode": "direct", "url": "https://cdn.example.com/clip.mp4"}),
    )
    r = client.post("/api/resolve-url", json={"url": "https://cdn.example.com/clip.mp4"})
    assert r.status_code == 200
    assert r.json()["mode"] == "direct"


def test_resolve_url_picker_passthrough(client, monkeypatch):
    import flowboard.routes.resolve as resolve_route

    monkeypatch.setattr(resolve_route, "_is_public_host", lambda host: True)
    items = [{"type": "video", "url": "https://x/a.mp4"}, {"type": "video", "url": "https://x/b.mp4"}]
    monkeypatch.setattr(
        resolve_route,
        "resolve_video_url",
        AsyncMock(return_value={"mode": "picker", "items": items}),
    )
    r = client.post("/api/resolve-url", json={"url": "https://share.example.com/v/123"})
    assert r.status_code == 200
    assert r.json()["items"] == items


def test_resolve_url_rejects_non_http(client):
    r = client.post("/api/resolve-url", json={"url": "ftp://x/clip.mp4"})
    assert r.status_code == 400


def test_resolve_url_rejects_private_host(client):
    r = client.post("/api/resolve-url", json={"url": "http://127.0.0.1/clip.mp4"})
    assert r.status_code == 400


def test_resolve_url_cobalt_unconfigured_maps_to_422(client, monkeypatch):
    import flowboard.routes.resolve as resolve_route

    monkeypatch.setattr(resolve_route, "_is_public_host", lambda host: True)

    async def _boom(url: str):
        raise ResolveError("cobalt_not_configured")

    monkeypatch.setattr(resolve_route, "resolve_video_url", _boom)
    r = client.post("/api/resolve-url", json={"url": "https://share.example.com/v/123"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_resolve_accepts_magic_bytes_without_extension(monkeypatch):
    """Extensionless CDN/signed URL: ranged-GET magic bytes prove video."""
    import flowboard.services.url_resolve as ur

    ftyp = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 32
    monkeypatch.setattr(ur, "_probe", AsyncMock(return_value=("application/octet-stream", ftyp)))
    out = await ur.resolve_video_url("https://cdn.example.com/watch?token=abc")
    assert out["mode"] == "direct"
    assert out["url"] == "https://cdn.example.com/watch?token=abc"


@pytest.mark.asyncio
async def test_resolve_explicit_path_accepted_when_head_blocked(monkeypatch):
    import flowboard.services.url_resolve as ur

    monkeypatch.setattr(ur, "_probe", AsyncMock(return_value=(None, b"")))
    out = await ur.resolve_video_url("https://cdn.example.com/clip.mp4")
    assert out["mode"] == "direct"


@pytest.mark.asyncio
async def test_resolve_page_without_cobalt_raises(monkeypatch):
    import flowboard.services.url_resolve as ur

    monkeypatch.setattr(ur, "_probe", AsyncMock(return_value=("text/html", b"<html>")))
    with pytest.raises(ResolveError):
        await ur.resolve_video_url("https://share.example.com/v/123")


@pytest.mark.asyncio
async def test_resolve_unreachable_host_raises_unreachable(monkeypatch):
    import flowboard.services.url_resolve as ur

    monkeypatch.setattr(ur, "_probe", AsyncMock(return_value=(None, b"")))
    with pytest.raises(ResolveError, match="unreachable"):
        await ur.resolve_video_url("https://down.example.com/watch?v=1")


@pytest.mark.asyncio
async def test_resolve_tiktok_share_link_from_page_json(monkeypatch):
    import flowboard.services.url_resolve as ur

    html = (
        '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">'
        '{"a": 1, "playAddr": "https:\\/\\/cdn.example.com\\/v.mp4"}'
        "</script>"
    )
    monkeypatch.setattr(ur, "_fetch_page", AsyncMock(return_value=html))
    ftyp = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 32
    monkeypatch.setattr(ur, "_probe", AsyncMock(side_effect=[
        ("text/html", b"<html>"),
        ("video/mp4", ftyp),
    ]))
    out = await ur.resolve_video_url("https://www.tiktok.com/@meisya3_5/video/7661066865220848903")
    assert out["mode"] == "direct"
    assert out["url"] == "https://cdn.example.com/v.mp4"
    assert out["provider"] == "tiktok"


@pytest.mark.asyncio
async def test_resolve_tiktok_blocked_page_raises(monkeypatch):
    import flowboard.services.url_resolve as ur

    monkeypatch.setattr(ur, "_fetch_page", AsyncMock(return_value="<html>captcha</html>"))
    monkeypatch.setattr(ur, "_probe", AsyncMock(return_value=("text/html", b"<html>")))
    with pytest.raises(ResolveError, match="tiktok_blocked"):
        await ur.resolve_video_url("https://www.tiktok.com/@x/video/1")


@pytest.mark.asyncio
async def test_gen_video_routes_url_to_v2v(monkeypatch):
    """reference_video_url (no media_id) → lazy ingest → gen_video_v2v."""
    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0.01)
    monkeypatch.setattr(
        proc,
        "_ingest_reference_url",
        AsyncMock(return_value=("vid-lazy-1", None)),
    )
    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_video = AsyncMock()  # must NOT be called
        m.return_value.gen_video_v2v = AsyncMock(return_value={
            "media_id": "media-123",
            "workflow_id": "wf-1",
        })
        m.return_value.check_v2v_status = AsyncMock(return_value={
            "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
            "done": True,
            "error": None,
            "media_entries": [{"media_id": "media-123", "url": "https://x/media-123", "mediaType": "video"}],
        })
        result, err = await proc._handle_gen_video({
            "prompt": "dance",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "start_media_id": "img-1",
            "reference_video_url": "https://cdn.example.com/clip.mp4",
        })

    assert err is None
    assert result["media_ids"] == ["media-123"]
    m.return_value.gen_video_v2v.assert_awaited_once_with(
        prompt="dance",
        project_id="8b62385c-4916-4abd-b01f-b28173d8eb04",
        video_media_id="vid-lazy-1",
        image_media_ids=["img-1"],
    )


@pytest.mark.asyncio
async def test_gen_video_url_ingest_failure_is_hard_error(monkeypatch):
    monkeypatch.setattr(
        proc,
        "_ingest_reference_url",
        AsyncMock(return_value=(None, "ref_url_not_video: 'text/html'")),
    )
    with patch("flowboard.worker.processor.get_flow_sdk"):
        result, err = await proc._handle_gen_video({
            "prompt": "dance",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "start_media_id": "img-1",
            "reference_video_url": "https://cdn.example.com/page.html",
        })
    assert result == {}
    assert err == "ref_url_not_video: 'text/html'"
