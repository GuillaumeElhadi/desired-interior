"""Tests for the composition endpoint: cache, mask generation, and router."""

import io
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from app.cloud.fal_client import AsyncFalClient, FalError, FalRateLimitError, FalTimeoutError
from app.compose import cache as compose_cache_module
from app.compose.composition import _build_placement_mask, _parse_result, make_cache_key
from app.dependencies import get_fal_client
from app.disk_cache import compute_sha256
from app.main import app
from app.objects import cache as obj_cache_module
from app.scenes import cache as scene_cache_module
from app.schemas import BoundingBox, ComposeRequest, PlacementSpec, StyleHints

OBJECT_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "objects"

_FLUX_FILL_RESPONSE = {
    "images": [
        {
            "url": "https://cdn.fal.ai/composed.jpg",
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
    "style_hints": {"prompt_suffix": "Scandinavian style."},
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
def tmp_compose_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(compose_cache_module, "get_cache_root", lambda: tmp_path)
    return tmp_path


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
    mock_run = AsyncMock(return_value=_FLUX_FILL_RESPONSE)
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


def _seed_caches(
    scene_cache_root: Path,
    obj_cache_root: Path,
    scene_image_bytes: bytes,
) -> None:
    """Write both cache entries needed for a successful compose call."""
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    scene_cache_module.save_original(_SCENE_ID, scene_image_bytes)
    obj_cache_module.save_cached(_OBJECT_ID, _OBJECT_CACHE_ENTRY)


# ---------------------------------------------------------------------------
# Compose disk cache unit tests
# ---------------------------------------------------------------------------


def test_compose_cache_miss_returns_none(tmp_compose_cache: Path) -> None:
    assert compose_cache_module.load_cached("nonexistent") is None


def test_compose_cache_save_and_hit(tmp_compose_cache: Path) -> None:
    data = {
        "composition_id": "xyz",
        "image": {"url": "https://cdn.fal.ai/composed.jpg", "content_type": "image/jpeg"},
    }
    compose_cache_module.save_cached("xyz", data)
    assert compose_cache_module.load_cached("xyz") == data


# ---------------------------------------------------------------------------
# Composition logic unit tests
# ---------------------------------------------------------------------------


def _hints(suffix: str = "") -> StyleHints:
    return StyleHints(prompt_suffix=suffix)


def test_make_cache_key_is_deterministic() -> None:
    placement = PlacementSpec(bbox=BoundingBox(x=10, y=20, width=50, height=60), depth_hint=0.3)
    k1 = make_cache_key("s1", "o1", placement, _hints())
    k2 = make_cache_key("s1", "o1", placement, _hints())
    assert k1 == k2
    assert len(k1) == 64


def test_make_cache_key_differs_on_bbox_change() -> None:
    p1 = PlacementSpec(bbox=BoundingBox(x=10, y=20, width=50, height=60))
    p2 = PlacementSpec(bbox=BoundingBox(x=10, y=20, width=51, height=60))
    assert make_cache_key("s", "o", p1, _hints()) != make_cache_key("s", "o", p2, _hints())


def test_make_cache_key_differs_on_style_hints() -> None:
    placement = PlacementSpec(bbox=BoundingBox(x=10, y=20, width=50, height=60))
    assert make_cache_key("s", "o", placement, _hints("modern")) != make_cache_key(
        "s", "o", placement, _hints("rustic")
    )


def test_build_placement_mask_shape() -> None:
    jpeg_bytes = _make_jpeg(256, 256)
    placement = PlacementSpec(bbox=BoundingBox(x=50, y=80, width=100, height=100))
    mask_bytes = _build_placement_mask(jpeg_bytes, placement)
    mask = Image.open(io.BytesIO(mask_bytes))
    assert mask.mode == "L"
    assert mask.size == (256, 256)


def test_build_placement_mask_white_region() -> None:
    jpeg_bytes = _make_jpeg(256, 256)
    placement = PlacementSpec(bbox=BoundingBox(x=50, y=80, width=100, height=100))
    mask_bytes = _build_placement_mask(jpeg_bytes, placement)
    mask = Image.open(io.BytesIO(mask_bytes))
    pixels = mask.tobytes()  # mode L: each byte is one pixel value 0-255
    # Center of the white rectangle must be 255
    center_idx = (80 + 50) * 256 + (50 + 50)
    assert pixels[center_idx] == 255
    # Corner of the image must be black
    assert pixels[0] == 0


def test_build_placement_mask_clamps_to_image_bounds() -> None:
    jpeg_bytes = _make_jpeg(256, 256)
    # bbox extends past the right and bottom edges
    placement = PlacementSpec(bbox=BoundingBox(x=200, y=200, width=200, height=200))
    mask_bytes = _build_placement_mask(jpeg_bytes, placement)
    mask = Image.open(io.BytesIO(mask_bytes))
    assert mask.size == (256, 256)


def test_parse_result_standard() -> None:
    r = _parse_result(_FLUX_FILL_RESPONSE)
    assert r["url"] == "https://cdn.fal.ai/composed.jpg"
    assert r["content_type"] == "image/jpeg"


def test_parse_result_empty_images_list() -> None:
    r = _parse_result({"images": []})
    assert r["url"] == ""
    assert r["content_type"] == "image/jpeg"


def test_parse_result_missing_key() -> None:
    r = _parse_result({})
    assert r["url"] == ""


# ---------------------------------------------------------------------------
# Schema validation tests
# ---------------------------------------------------------------------------

_VALID_SHA256 = "a" * 64


def test_compose_request_rejects_non_hex_scene_id() -> None:
    import pytest

    with pytest.raises(Exception):
        ComposeRequest(
            scene_id="not-a-sha256",
            object_id=_VALID_SHA256,
            placement=PlacementSpec(bbox=BoundingBox(x=0, y=0, width=10, height=10)),
        )


def test_compose_request_rejects_path_traversal_scene_id() -> None:
    import pytest

    with pytest.raises(Exception):
        ComposeRequest(
            scene_id="../../../etc/passwd" + "a" * 32,
            object_id=_VALID_SHA256,
            placement=PlacementSpec(bbox=BoundingBox(x=0, y=0, width=10, height=10)),
        )


def test_compose_request_rejects_long_prompt_suffix() -> None:
    import pytest

    with pytest.raises(Exception):
        ComposeRequest(
            scene_id=_VALID_SHA256,
            object_id=_VALID_SHA256,
            placement=PlacementSpec(bbox=BoundingBox(x=0, y=0, width=10, height=10)),
            style_hints=StyleHints(prompt_suffix="x" * 301),
        )


def test_compose_request_accepts_valid_sha256_ids() -> None:
    req = ComposeRequest(
        scene_id=_VALID_SHA256,
        object_id=_VALID_SHA256,
        placement=PlacementSpec(bbox=BoundingBox(x=0, y=0, width=10, height=10)),
    )
    assert req.scene_id == _VALID_SHA256


# ---------------------------------------------------------------------------
# Router integration tests (all offline)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_compose_cache_miss_calls_fal_and_caches(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_image = _make_jpeg()
    _seed_caches(tmp_scene_cache, tmp_obj_cache, scene_image)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)

    assert resp.status_code == 200
    data = resp.json()
    assert data["image"]["url"] == "https://cdn.fal.ai/composed.jpg"
    assert mock_fal.await_count == 1
    assert compose_cache_module.load_cached(data["composition_id"]) is not None


@pytest.mark.asyncio
async def test_compose_cache_hit_skips_fal(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_image = _make_jpeg()
    _seed_caches(tmp_scene_cache, tmp_obj_cache, scene_image)

    # Prime cache — style_hints must match _VALID_BODY exactly
    placement = PlacementSpec(**_VALID_BODY["placement"])
    hints = StyleHints(**_VALID_BODY.get("style_hints", {}))
    cache_key = make_cache_key(_SCENE_ID, _OBJECT_ID, placement, hints)
    compose_cache_module.save_cached(
        cache_key,
        {
            "composition_id": cache_key,
            "image": {"url": "https://cdn.fal.ai/cached.jpg", "content_type": "image/jpeg"},
        },
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)

    assert resp.status_code == 200
    assert resp.json()["image"]["url"] == "https://cdn.fal.ai/cached.jpg"
    mock_fal.assert_not_awaited()


@pytest.mark.asyncio
async def test_compose_missing_scene_returns_404(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    obj_cache_module.save_cached(_OBJECT_ID, _OBJECT_CACHE_ENTRY)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)
    assert resp.status_code == 404
    assert "Scene" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_compose_missing_object_returns_404(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    # No object in cache

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)
    assert resp.status_code == 404
    assert "Object" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_compose_missing_original_image_returns_409(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    # Scene result cached but original.bin missing
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    obj_cache_module.save_cached(_OBJECT_ID, _OBJECT_CACHE_ENTRY)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_compose_fal_timeout_returns_504(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    _fal_error_override(FalTimeoutError("timed out"))
    _seed_caches(tmp_scene_cache, tmp_obj_cache, _make_jpeg())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose", json=_VALID_BODY)
        assert resp.status_code == 504
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_compose_fal_rate_limit_returns_429(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    _fal_error_override(FalRateLimitError("rate limited"))
    _seed_caches(tmp_scene_cache, tmp_obj_cache, _make_jpeg())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose", json=_VALID_BODY)
        assert resp.status_code == 429
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_compose_fal_generic_error_returns_502(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    _fal_error_override(FalError("unexpected"))
    _seed_caches(tmp_scene_cache, tmp_obj_cache, _make_jpeg())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose", json=_VALID_BODY)
        assert resp.status_code == 502
    finally:
        app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Fixture-based offline test — exercises with real furniture images
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture_name", ["chair.png", "table.png", "lamp.png"])
@pytest.mark.asyncio
async def test_compose_with_fixture_images(
    fixture_name: str,
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    object_bytes = (OBJECT_FIXTURES_DIR / fixture_name).read_bytes()
    object_id = compute_sha256(object_bytes)
    obj_cache_module.save_cached(
        object_id,
        {
            "object_id": object_id,
            "masked": {
                "url": "https://cdn.fal.ai/extracted.png",
                "width": 256,
                "height": 256,
                "content_type": "image/png",
            },
        },
    )

    scene_image = _make_jpeg(512, 512)
    scene_id = compute_sha256(scene_image)
    scene_cache_module.save_cached(scene_id, {**_SCENE_CACHE_ENTRY, "scene_id": scene_id})
    scene_cache_module.save_original(scene_id, scene_image)

    body = {
        "scene_id": scene_id,
        "object_id": object_id,
        "placement": {
            "bbox": {"x": 100.0, "y": 150.0, "width": 200.0, "height": 200.0},
            "depth_hint": 0.5,
        },
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=body)

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["image"]["url"] != ""
    assert mock_fal.await_count == 1
    mock_fal.reset_mock()


# ---------------------------------------------------------------------------
# Live test — calls real Flux Fill and validates a URL is returned
# ---------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.asyncio
async def test_live_compose_returns_image_url(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    key = os.environ.get("FAL_KEY")
    if not key:
        pytest.skip("FAL_KEY not set")

    scene_image = _make_jpeg(512, 512)
    scene_id = compute_sha256(scene_image)
    scene_cache_module.save_cached(scene_id, {**_SCENE_CACHE_ENTRY, "scene_id": scene_id})
    scene_cache_module.save_original(scene_id, scene_image)

    object_bytes = (OBJECT_FIXTURES_DIR / "chair.png").read_bytes()
    object_id = compute_sha256(object_bytes)
    obj_cache_module.save_cached(
        object_id,
        {
            "object_id": object_id,
            "masked": {
                "url": "https://cdn.fal.ai/extracted.png",
                "width": 256,
                "height": 256,
                "content_type": "image/png",
            },
        },
    )

    body = {
        "scene_id": scene_id,
        "object_id": object_id,
        "placement": {
            "bbox": {"x": 100.0, "y": 150.0, "width": 200.0, "height": 200.0},
            "depth_hint": 0.5,
        },
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=body)

    assert resp.status_code == 200, resp.text
    assert resp.json()["image"]["url"].startswith("https://")
