"""Motion-transfer (v2v) routing inside the `gen_video` worker handler.

When the dispatch carries `reference_video_media_id`, `_handle_gen_video`
must route to `sdk.gen_video_v2v` + `sdk.check_v2v_status` instead of the
Veo i2v batch path — this is the wiring the frontend's GenerationDialog
(uploaded reference video) and generation.ts (`reference_video_media_id`
param) already assume, per their own comments.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flowboard.worker import processor as proc


@pytest.mark.asyncio
async def test_gen_video_routes_to_v2v_when_reference_video_present(monkeypatch):
    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0.01)
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
            "reference_video_media_id": "vid-ref-1",
        })

    assert err is None
    assert result["media_ids"] == ["media-123"]
    # Poll is addressed by workflow id, with the media id along for the entry.
    m.return_value.check_v2v_status.assert_awaited_with("wf-1", "media-123")
    m.return_value.gen_video.assert_not_called()
    m.return_value.gen_video_v2v.assert_awaited_once_with(
        prompt="dance",
        project_id="8b62385c-4916-4abd-b01f-b28173d8eb04",
        video_media_id="vid-ref-1",
        image_media_ids=["img-1"],
    )


@pytest.mark.asyncio
async def test_gen_video_v2v_uses_start_media_ids_list_when_present(monkeypatch):
    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0.01)
    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_video_v2v = AsyncMock(return_value={"media_id": "media-9", "workflow_id": "wf-9"})
        m.return_value.check_v2v_status = AsyncMock(return_value={
            "done": True,
            "error": None,
            "media_entries": [{"media_id": "media-9", "url": "https://x/media-9", "mediaType": "video"}],
        })
        await proc._handle_gen_video({
            "prompt": "dance",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "start_media_ids": ["img-1", "img-2"],
            "reference_video_media_id": "vid-ref-1",
        })
        kwargs = m.return_value.gen_video_v2v.call_args.kwargs
        assert kwargs["image_media_ids"] == ["img-1", "img-2"]


@pytest.mark.asyncio
async def test_gen_video_v2v_surfaces_dispatch_error():
    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_video_v2v = AsyncMock(return_value={
            "error": "agent_did_not_dispatch_a_job",
        })
        result, err = await proc._handle_gen_video({
            "prompt": "dance",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "start_media_id": "img-1",
            "reference_video_media_id": "vid-ref-1",
        })
        assert err == "agent_did_not_dispatch_a_job"


@pytest.mark.asyncio
async def test_gen_video_v2v_surfaces_terminal_failure_status(monkeypatch):
    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0.01)
    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_video_v2v = AsyncMock(return_value={"media_id": "media-9", "workflow_id": "wf-9"})
        m.return_value.check_v2v_status = AsyncMock(return_value={
            "done": True,
            "status": "MEDIA_GENERATION_STATUS_FAILED",
            "error": "MEDIA_GENERATION_STATUS_FAILED",
            "media_entries": [],
        })
        result, err = await proc._handle_gen_video({
            "prompt": "dance",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "start_media_id": "img-1",
            "reference_video_media_id": "vid-ref-1",
        })
        assert err == "MEDIA_GENERATION_STATUS_FAILED"


@pytest.mark.asyncio
async def test_gen_video_without_reference_video_still_uses_veo_path():
    """Regression guard — the normal i2v path must be untouched when no
    reference video is present."""
    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_video = AsyncMock(return_value={"operation_names": []})
        m.return_value.gen_video_v2v = AsyncMock()
        result, err = await proc._handle_gen_video({
            "prompt": "x",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "start_media_id": "src-1",
            "paygate_tier": "PAYGATE_TIER_ONE",
        })
        m.return_value.gen_video.assert_awaited_once()
        m.return_value.gen_video_v2v.assert_not_called()
        assert err == "no_operations_returned"


@pytest.mark.asyncio
async def test_gen_video_v2v_needs_a_workflow_id_to_poll(monkeypatch):
    """Dispatch without a workflow id can't be polled — fail fast instead of
    burning the full 5-minute poll window."""
    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0.01)
    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_video_v2v = AsyncMock(return_value={"media_id": "media-9"})
        m.return_value.check_v2v_status = AsyncMock()
        _, err = await proc._handle_gen_video({
            "prompt": "dance",
            "project_id": "8b62385c-4916-4abd-b01f-b28173d8eb04",
            "start_media_id": "img-1",
            "reference_video_media_id": "vid-ref-1",
        })
    assert err == "no_workflow_id_returned"
    m.return_value.check_v2v_status.assert_not_awaited()
