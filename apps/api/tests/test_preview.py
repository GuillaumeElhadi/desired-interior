"""Tests for the /compose/preview endpoint: cache, preview function, and router."""

import io
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from app.cloud.fal_client import AsyncFalClient, FalError, FalRateLimitError, FalTimeoutError
from app.compose import preview_cache as preview_cache_module
from app.compose.composition import make_cache_key
from app.dependencies import get_fal_client
from app.main import app
from app.objects import cache as obj_cache_module
from app.scenes import cache as scene_cache_module

_PREVIEW_RESPONSE = {
    "images": [
        {
            "url": "https://cdn.fal.ai/preview.jpg",
            "content_type": "image/jpeg",
        }
    ],
    "prompt": "Photorealistic furniture piece…",
}

_SCENE_CACHE_ENTRY = {
    "scene_id": "a" * 64,
    "depth_map": {"url": "https://cdn.fal.ai/depth.png", "width": 256, "height": 256},
    "masks": [],
    "metadata": {
        "dominant_surface": "floor",
        "lighting_hint": "neutral",
        "light_direction": "ambient",
        "color_temperature": "neutral",
    },
}

_OBJECT_CACHE_ENTRY = {
    "object_id": "b" * 64,
    "masked": {
        "url": "https://cdn.fal.ai/extracted.png",
        "width": 256,
        "height": 256,
        "content_type": "image/png",
    },
}

_SCENE_ID = "a" * 64
_OBJECT_ID = "b" * 64

_VALID_BODY = {
    "scene_id": _SCENE_ID,
    "object_id": _OBJECT_ID,
    "placement": {
        "bbox": {"x": 50.0, "y": 80.0, "width": 100.0, "height": 120.0},
        "depth_hint": 0.4,
    },
    "style_hints": {"prompt_suffix": ""},
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_jpeg(width: int = 256, height: int = 256) -> bytes:
    img = Image.new("RGB", (width, height), (150, 130, 110))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture
def tmp_preview_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    preview_tmp = tmp_path / "preview"
    preview_tmp.mkdir()
    monkeypatch.setattr(preview_cache_module, "get_cache_root", lambda: preview_tmp)
    return preview_tmp


@pytest.fixture
def tmp_compose_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from app.compose import cache as compose_cache_module

    compose_tmp = tmp_path / "compose"
    compose_tmp.mkdir()
    monkeypatch.setattr(compose_cache_module, "get_cache_root", lambda: compose_tmp)
    return compose_tmp


@pytest.fixture
def tmp_scene_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    scene_tmp = tmp_path / "scenes"
    scene_tmp.mkdir()
    monkeypatch.setattr(scene_cache_module, "get_cache_root", lambda: scene_tmp)
    return scene_tmp


@pytest.fixture
def tmp_obj_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    obj_tmp = tmp_path / "objects"
    obj_tmp.mkdir()
    monkeypatch.setattr(obj_cache_module, "get_cache_root", lambda: obj_tmp)
    return obj_tmp


@pytest.fixture
def mock_fal() -> AsyncMock:
    mock_run = AsyncMock(return_value=_PREVIEW_RESPONSE)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.run = mock_run
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    yield mock_run
    app.dependency_overrides.clear()


def _fal_error_override(side_effect: Exception) -> None:
    mock_run = AsyncMock(side_effect=side_effect)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.run = mock_run
    app.dependency_overrides[get_fal_client] = lambda: mock_client


def _seed_caches(scene_image_bytes: bytes) -> None:
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    scene_cache_module.save_original(_SCENE_ID, scene_image_bytes)
    obj_cache_module.save_cached(_OBJECT_ID, _OBJECT_CACHE_ENTRY)


# ---------------------------------------------------------------------------
# Preview disk cache unit tests
# ---------------------------------------------------------------------------


def test_preview_cache_miss_returns_none(tmp_preview_cache: Path) -> None:
    assert preview_cache_module.load_cached("nonexistent") is None


def test_preview_cache_save_and_hit(tmp_preview_cache: Path) -> None:
    data = {
        "preview_id": "xyz",
        "image": {"url": "https://cdn.fal.ai/preview.jpg", "content_type": "image/jpeg"},
    }
    preview_cache_module.save_cached("xyz", data)
    assert preview_cache_module.load_cached("xyz") == data


# ---------------------------------------------------------------------------
# Router integration tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_preview_cache_miss_calls_fal_with_4_steps(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    _seed_caches(_make_jpeg())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/preview", json=_VALID_BODY)

    assert resp.status_code == 200
    data = resp.json()
    assert data["image"]["url"] == "https://cdn.fal.ai/preview.jpg"
    assert "preview_id" in data
    assert mock_fal.await_count == 1

    # Verify the fal call used the right endpoint and 4 inference steps
    call_args = mock_fal.call_args
    assert call_args[0][0] == "fal-ai/flux-lora/inpainting"
    assert call_args[0][1]["num_inference_steps"] == 4


@pytest.mark.asyncio
async def test_preview_cache_hit_skips_fal(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    from app.schemas import PlacementSpec, StyleHints

    _seed_caches(_make_jpeg())

    placement = PlacementSpec(**_VALID_BODY["placement"])
    hints = StyleHints(**_VALID_BODY.get("style_hints", {}))
    cache_key = make_cache_key(_SCENE_ID, _OBJECT_ID, placement, hints)
    preview_cache_module.save_cached(
        cache_key,
        {
            "preview_id": cache_key,
            "image": {"url": "https://cdn.fal.ai/cached-preview.jpg", "content_type": "image/jpeg"},
        },
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/preview", json=_VALID_BODY)

    assert resp.status_code == 200
    assert resp.json()["image"]["url"] == "https://cdn.fal.ai/cached-preview.jpg"
    mock_fal.assert_not_awaited()


@pytest.mark.asyncio
async def test_preview_missing_scene_returns_404(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    obj_cache_module.save_cached(_OBJECT_ID, _OBJECT_CACHE_ENTRY)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/preview", json=_VALID_BODY)
    assert resp.status_code == 404
    assert "Scene" in resp.json()["message"]


@pytest.mark.asyncio
async def test_preview_missing_object_returns_404(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/preview", json=_VALID_BODY)
    assert resp.status_code == 404
    assert "Object" in resp.json()["message"]


@pytest.mark.asyncio
async def test_preview_missing_original_returns_409(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    obj_cache_module.save_cached(_OBJECT_ID, _OBJECT_CACHE_ENTRY)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/preview", json=_VALID_BODY)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_preview_fal_timeout_returns_504(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    _fal_error_override(FalTimeoutError("timed out"))
    _seed_caches(_make_jpeg())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose/preview", json=_VALID_BODY)
        assert resp.status_code == 504
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_preview_fal_rate_limit_returns_429(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    _fal_error_override(FalRateLimitError("rate limited"))
    _seed_caches(_make_jpeg())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose/preview", json=_VALID_BODY)
        assert resp.status_code == 429
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_preview_fal_generic_error_returns_502(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    _fal_error_override(FalError("unexpected"))
    _seed_caches(_make_jpeg())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose/preview", json=_VALID_BODY)
        assert resp.status_code == 502
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_preview_response_shape(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    _seed_caches(_make_jpeg())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/preview", json=_VALID_BODY)

    assert resp.status_code == 200
    data = resp.json()
    assert "preview_id" in data
    assert len(data["preview_id"]) == 64
    assert "image" in data
    assert data["image"]["url"] != ""
    assert data["image"]["content_type"] == "image/jpeg"


@pytest.mark.asyncio
async def test_preview_cache_isolated_from_compose_cache(
    tmp_preview_cache: Path,
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    """A cached preview must NOT appear in the compose cache, and vice versa."""
    from app.compose import cache as compose_cache_module

    _seed_caches(_make_jpeg())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/preview", json=_VALID_BODY)

    assert resp.status_code == 200
    preview_id = resp.json()["preview_id"]

    # Preview cache should have it
    assert preview_cache_module.load_cached(preview_id) is not None
    # Compose cache must NOT have it
    assert compose_cache_module.load_cached(preview_id) is None


# ---------------------------------------------------------------------------
# Regression guard: final /compose still uses 28 steps
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_final_compose_uses_28_steps(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    _seed_caches(_make_jpeg())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)

    assert resp.status_code == 200
    assert mock_fal.await_count == 1
    call_args = mock_fal.call_args
    assert call_args[0][0] == "fal-ai/flux-lora/inpainting"
    assert call_args[0][1]["num_inference_steps"] == 28


# ---------------------------------------------------------------------------
# Live test
# ---------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.asyncio
async def test_live_preview_returns_image_url(
    tmp_preview_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    key = os.environ.get("FAL_KEY")
    if not key:
        pytest.skip("FAL_KEY not set")

    _seed_caches(_make_jpeg(512, 512))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/preview", json=_VALID_BODY)

    assert resp.status_code == 200, resp.text
    assert resp.json()["image"]["url"].startswith("https://")
