"""Tests for POST /scenes/segment-point — point-based SAM segmentation (task 5.9)."""

import base64
import io
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from app.cloud.fal_client import (
    AsyncFalClient,
    FalMalformedResponseError,
    FalRateLimitError,
    FalTimeoutError,
)
from app.dependencies import get_fal_client
from app.main import app
from app.scenes import cache as scene_cache_module
from app.scenes.segment import (
    _segment_cache_key,
    run_segment_point,
    segment_point,
)

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

_SCENE_ID = "a" * 64
_W, _H = 256, 256


def _make_jpeg(width: int = _W, height: int = _H) -> bytes:
    img = Image.new("RGB", (width, height), (120, 100, 80))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def _make_grayscale_png(width: int = _W, height: int = _H, value: int = 200) -> bytes:
    img = Image.new("L", (width, height), value)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _mock_fal_response(
    mask_png: bytes | None = None,
    boxes: list | None = None,
    scores: list | None = None,
) -> dict:
    if mask_png is None:
        mask_png = _make_grayscale_png()
    mask_b64 = base64.b64encode(mask_png).decode()
    return {
        "masks": [
            {
                "url": f"data:image/png;base64,{mask_b64}",
                "width": _W,
                "height": _H,
                "content_type": "image/png",
            }
        ],
        "boxes": boxes if boxes is not None else [[0.5, 0.5, 0.4, 0.3]],
        "scores": scores if scores is not None else [0.92],
    }


def _make_fal_client(
    response: dict | None = None, *, raise_exc: Exception | None = None
) -> AsyncFalClient:
    fal = MagicMock(spec=AsyncFalClient)
    if raise_exc is not None:
        fal.run = AsyncMock(side_effect=raise_exc)
        fal.fetch_bytes = AsyncMock(return_value=b"")
    else:
        fal_response = response or _mock_fal_response()
        fal.run = AsyncMock(return_value=fal_response)
        masks = fal_response.get("masks") or []
        if masks:
            mask_bytes = base64.b64decode(masks[0]["url"].split(",", 1)[1])
        else:
            mask_bytes = b""
        fal.fetch_bytes = AsyncMock(return_value=mask_bytes)
    return fal


# ---------------------------------------------------------------------------
# Unit tests: run_segment_point
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_segment_point_returns_binary_mask_and_bbox():
    scene_bytes = _make_jpeg()
    fal = _make_fal_client()

    mask_bytes, bbox, score = await run_segment_point(scene_bytes, x=100, y=80, fal=fal)

    # Mask must be a valid PNG
    img = Image.open(io.BytesIO(mask_bytes))
    assert img.size == (_W, _H)

    # All pixels must be strictly binary
    gray = img.convert("L")
    assert all(p in (0, 255) for p in gray.tobytes())

    # BBox normalised [0.5, 0.5, 0.4, 0.3] → pixel [x=52, y=89.6, w=102.4, h=76.8]
    assert len(bbox) == 4
    assert bbox[2] == pytest.approx(0.4 * _W)  # width
    assert bbox[3] == pytest.approx(0.3 * _H)  # height

    assert score == pytest.approx(0.92)


@pytest.mark.asyncio
async def test_run_segment_point_calls_sam_with_correct_payload():
    scene_bytes = _make_jpeg()
    fal = _make_fal_client()

    await run_segment_point(scene_bytes, x=50, y=120, fal=fal)

    call_args = fal.run.call_args
    endpoint, payload = call_args[0][0], call_args[0][1]
    assert endpoint == "fal-ai/sam-3-1/image"
    assert payload["point_prompts"] == [{"x": 50, "y": 120, "label": 1}]
    assert payload["apply_mask"] is False
    assert payload["include_boxes"] is True


@pytest.mark.asyncio
async def test_run_segment_point_raises_on_empty_masks():
    fal = _make_fal_client({"masks": [], "boxes": [], "scores": []})
    fal.fetch_bytes = AsyncMock(return_value=b"")
    with pytest.raises(FalMalformedResponseError):
        await run_segment_point(_make_jpeg(), x=0, y=0, fal=fal)


@pytest.mark.asyncio
async def test_run_segment_point_binarises_grayscale_mask():
    # Mask with mixed values — should come out strictly 0 or 255
    img = Image.new("L", (_W, _H), 0)
    for i in range(_W):
        for j in range(_H // 2):
            img.putpixel((i, j), 180)  # > 128 → becomes 255
    buf = io.BytesIO()
    img.save(buf, "PNG")
    mixed_png = buf.getvalue()

    fal = _make_fal_client(_mock_fal_response(mask_png=mixed_png))
    fal.fetch_bytes = AsyncMock(return_value=mixed_png)

    mask_bytes, _, _ = await run_segment_point(_make_jpeg(), x=10, y=10, fal=fal)
    result = Image.open(io.BytesIO(mask_bytes)).convert("L")
    assert all(p in (0, 255) for p in result.tobytes())


# ---------------------------------------------------------------------------
# Unit tests: segment_point (caching wrapper)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_segment_point_cache_hit_skips_fal(tmp_path, monkeypatch):
    monkeypatch.setattr("app.scenes.segment.get_segment_cache_root", lambda: tmp_path)

    scene_bytes = _make_jpeg()
    fal = _make_fal_client()

    result1 = await segment_point(scene_bytes, x=30, y=40, fal=fal)
    result2 = await segment_point(scene_bytes, x=30, y=40, fal=fal)

    assert fal.run.call_count == 1  # second call hits cache
    assert result1["mask_url"] == result2["mask_url"]
    assert result1["bbox"] == result2["bbox"]


@pytest.mark.asyncio
async def test_segment_point_different_coords_use_separate_cache(tmp_path, monkeypatch):
    monkeypatch.setattr("app.scenes.segment.get_segment_cache_root", lambda: tmp_path)

    scene_bytes = _make_jpeg()
    fal = _make_fal_client()

    await segment_point(scene_bytes, x=10, y=20, fal=fal)
    await segment_point(scene_bytes, x=50, y=60, fal=fal)

    assert fal.run.call_count == 2


# ---------------------------------------------------------------------------
# Integration tests: POST /scenes/segment-point
# ---------------------------------------------------------------------------


@pytest.fixture
def _scene_in_cache(tmp_path, monkeypatch):
    """Pre-populate the scenes cache with a fake JPEG so the route can load it."""
    monkeypatch.setattr(scene_cache_module, "get_cache_root", lambda: tmp_path / "scenes")
    scene_bytes = _make_jpeg()
    scene_cache_module.save_original(_SCENE_ID, scene_bytes)
    return scene_bytes


@pytest.fixture
def _segment_cache_tmp(tmp_path, monkeypatch):
    monkeypatch.setattr("app.scenes.segment.get_segment_cache_root", lambda: tmp_path / "segments")


@pytest.fixture
def _mock_fal(monkeypatch):
    fal = _make_fal_client()
    app.dependency_overrides[get_fal_client] = lambda: fal
    yield fal
    app.dependency_overrides.pop(get_fal_client, None)


@pytest.mark.asyncio
async def test_segment_point_success(_scene_in_cache, _segment_cache_tmp, _mock_fal):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/scenes/segment-point",
            json={"scene_id": _SCENE_ID, "x": 100, "y": 80},
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mask_url"].startswith("data:image/png;base64,")
    assert len(body["bbox"]) == 4
    assert 0.0 <= body["score"] <= 1.0


@pytest.mark.asyncio
async def test_segment_point_404_when_scene_missing(
    _segment_cache_tmp, _mock_fal, tmp_path, monkeypatch
):
    monkeypatch.setattr(scene_cache_module, "get_cache_root", lambda: tmp_path / "empty")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/scenes/segment-point",
            json={"scene_id": _SCENE_ID, "x": 0, "y": 0},
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 404
    assert resp.json()["error_code"] == "scene_not_found"


@pytest.mark.asyncio
async def test_segment_point_422_invalid_scene_id(_mock_fal):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/scenes/segment-point",
            json={"scene_id": "not-a-sha256", "x": 0, "y": 0},
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_segment_point_504_on_timeout(_scene_in_cache, _segment_cache_tmp, monkeypatch):
    fal = _make_fal_client(raise_exc=FalTimeoutError("timeout"))
    app.dependency_overrides[get_fal_client] = lambda: fal
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/scenes/segment-point",
                json={"scene_id": _SCENE_ID, "x": 50, "y": 50},
                headers={"Authorization": "Bearer test-token"},
            )
        assert resp.status_code == 504
        assert resp.json()["error_code"] == "fal_timeout"
    finally:
        app.dependency_overrides.pop(get_fal_client, None)


@pytest.mark.asyncio
async def test_segment_point_429_on_rate_limit(_scene_in_cache, _segment_cache_tmp, monkeypatch):
    fal = _make_fal_client(raise_exc=FalRateLimitError("rate limited"))
    app.dependency_overrides[get_fal_client] = lambda: fal
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/scenes/segment-point",
                json={"scene_id": _SCENE_ID, "x": 10, "y": 10},
                headers={"Authorization": "Bearer test-token"},
            )
        assert resp.status_code == 429
        assert resp.json()["error_code"] == "fal_rate_limited"
    finally:
        app.dependency_overrides.pop(get_fal_client, None)


@pytest.mark.asyncio
async def test_segment_cache_key_is_deterministic():
    k1 = _segment_cache_key("a" * 64, 10, 20)
    k2 = _segment_cache_key("a" * 64, 10, 20)
    k3 = _segment_cache_key("a" * 64, 11, 20)
    assert k1 == k2
    assert k1 != k3
