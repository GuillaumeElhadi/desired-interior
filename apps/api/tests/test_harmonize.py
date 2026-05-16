"""Tests for POST /compose/harmonize — Harmonizer endpoint (task 5.4)."""

import io
from pathlib import Path
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
from app.compose import harmonize_cache as harmonize_cache_module
from app.compose.harmonize import make_harmonize_cache_key
from app.dependencies import get_fal_client
from app.main import app
from app.objects import cache as obj_cache_module
from app.scenes import cache as scene_cache_module
from app.schemas import BoundingBox, ObjectPlacement, PlacementSpec

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SCENE_ID = "a" * 64
_OBJECT_ID = "b" * 64

_SCENE_CACHE_ENTRY = {
    "scene_id": _SCENE_ID,
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
    "object_id": _OBJECT_ID,
    "masked": {
        "url": "https://cdn.fal.ai/extracted.png",
        "width": 64,
        "height": 64,
        "content_type": "image/png",
        "object_type": "floor",
    },
}

_VALID_BODY = {
    "scene_id": _SCENE_ID,
    "objects": [
        {
            "object_id": _OBJECT_ID,
            "placement": {
                "bbox": {"x": 50.0, "y": 80.0, "width": 100.0, "height": 100.0},
                "depth_hint": 0.4,
                "rotation": 0.0,
            },
        }
    ],
    "harmonize_strength": 0.35,
}

_FAL_HARMONIZE_RESPONSE = {"images": [{"url": "https://cdn.fal.ai/harmonized.jpg"}]}

# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------


def _make_jpeg(width: int = 256, height: int = 256) -> bytes:
    img = Image.new("RGB", (width, height), (150, 130, 110))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def _make_png_rgba(width: int = 64, height: int = 64) -> bytes:
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for x in range(16, width - 16):
        for y in range(16, height - 16):
            img.putpixel((x, y), (180, 120, 60, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_harmonize_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(harmonize_cache_module, "get_cache_root", lambda: tmp_path)
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
def mock_fal(tmp_path: Path) -> AsyncMock:
    """Mock fal client: fetch_bytes returns RGBA PNG, run returns harmonized image."""
    png_bytes = _make_png_rgba()
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.fetch_bytes = AsyncMock(return_value=png_bytes)
    mock_client.run = AsyncMock(return_value=_FAL_HARMONIZE_RESPONSE)
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    yield mock_client
    app.dependency_overrides.clear()


def _seed_caches(scene_image_bytes: bytes) -> None:
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    scene_cache_module.save_original(_SCENE_ID, scene_image_bytes)
    obj_cache_module.save_cached(_OBJECT_ID, _OBJECT_CACHE_ENTRY)


# ---------------------------------------------------------------------------
# Cache unit tests
# ---------------------------------------------------------------------------


def test_harmonize_cache_miss_returns_none(tmp_harmonize_cache: Path) -> None:
    assert harmonize_cache_module.load_cached("nonexistent") is None


def test_harmonize_cache_save_and_hit(tmp_harmonize_cache: Path) -> None:
    # Cache now stores JPEG bytes in result.jpg and reconstructs the data URL on load.
    import base64

    raw = _make_jpeg()
    data_url = f"data:image/jpeg;base64,{base64.b64encode(raw).decode()}"
    data = {
        "harmonize_id": "xyz",
        "image": {"url": data_url, "content_type": "image/jpeg"},
    }
    harmonize_cache_module.save_cached("xyz", data)
    assert harmonize_cache_module.load_cached("xyz") == data


# ---------------------------------------------------------------------------
# Cache key tests
# ---------------------------------------------------------------------------


def _make_op(object_id: str = _OBJECT_ID) -> ObjectPlacement:
    return ObjectPlacement(
        object_id=object_id,
        placement=PlacementSpec(bbox=BoundingBox(x=10, y=20, width=50, height=60)),
    )


def test_harmonize_cache_key_is_deterministic() -> None:
    ops = [_make_op()]
    k1 = make_harmonize_cache_key(_SCENE_ID, ops, "flux", 0.35, None)
    k2 = make_harmonize_cache_key(_SCENE_ID, ops, "flux", 0.35, None)
    assert k1 == k2
    assert len(k1) == 64


def test_harmonize_cache_key_differs_on_backend() -> None:
    ops = [_make_op()]
    k_flux = make_harmonize_cache_key(_SCENE_ID, ops, "flux", 0.35, None)
    k_sdxl = make_harmonize_cache_key(_SCENE_ID, ops, "sdxl", 0.35, None)
    assert k_flux != k_sdxl


def test_harmonize_cache_key_differs_on_strength() -> None:
    ops = [_make_op()]
    k1 = make_harmonize_cache_key(_SCENE_ID, ops, "flux", 0.35, None)
    k2 = make_harmonize_cache_key(_SCENE_ID, ops, "flux", 0.40, None)
    assert k1 != k2


def test_harmonize_cache_key_stable_across_object_order() -> None:
    op1 = _make_op("a" * 64)
    op2 = _make_op("b" * 64)
    k1 = make_harmonize_cache_key(_SCENE_ID, [op1, op2], "flux", 0.35, None)
    k2 = make_harmonize_cache_key(_SCENE_ID, [op2, op1], "flux", 0.35, None)
    assert k1 == k2


# ---------------------------------------------------------------------------
# Schema validation tests
# ---------------------------------------------------------------------------


def test_harmonize_request_rejects_strength_below_range() -> None:
    from app.schemas import HarmonizeRequest

    with pytest.raises(Exception):
        HarmonizeRequest(scene_id=_SCENE_ID, objects=[_make_op()], harmonize_strength=0.14)


def test_harmonize_request_rejects_strength_above_range() -> None:
    from app.schemas import HarmonizeRequest

    with pytest.raises(Exception):
        HarmonizeRequest(scene_id=_SCENE_ID, objects=[_make_op()], harmonize_strength=0.56)


def test_harmonize_request_rejects_empty_objects() -> None:
    from app.schemas import HarmonizeRequest

    with pytest.raises(Exception):
        HarmonizeRequest(scene_id=_SCENE_ID, objects=[], harmonize_strength=0.35)


def test_harmonize_request_rejects_too_many_objects() -> None:
    from app.schemas import HarmonizeRequest

    with pytest.raises(Exception):
        HarmonizeRequest(
            scene_id=_SCENE_ID,
            objects=[_make_op("a" * 63 + str(i)[-1]) for i in range(21)],
            harmonize_strength=0.35,
        )


def test_harmonize_request_rejects_seed_out_of_range() -> None:
    from app.schemas import HarmonizeRequest

    with pytest.raises(Exception):
        HarmonizeRequest(scene_id=_SCENE_ID, objects=[_make_op()], harmonize_strength=0.35, seed=-1)
    with pytest.raises(Exception):
        HarmonizeRequest(
            scene_id=_SCENE_ID,
            objects=[_make_op()],
            harmonize_strength=0.35,
            seed=2**32,
        )


def test_harmonize_request_accepts_valid_strength_boundaries() -> None:
    from app.schemas import HarmonizeRequest

    r_low = HarmonizeRequest(scene_id=_SCENE_ID, objects=[_make_op()], harmonize_strength=0.15)
    r_high = HarmonizeRequest(scene_id=_SCENE_ID, objects=[_make_op()], harmonize_strength=0.55)
    assert r_low.harmonize_strength == 0.15
    assert r_high.harmonize_strength == 0.55


# ---------------------------------------------------------------------------
# Router integration tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_harmonize_returns_image_url(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: MagicMock,
) -> None:
    _seed_caches(_make_jpeg())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/harmonize", json=_VALID_BODY)

    assert resp.status_code == 200
    data = resp.json()
    # run_harmonize now downloads the model output and re-composites the original
    # object pixels on top, returning a data URL instead of the raw CDN URL.
    assert data["image"]["url"].startswith("data:image/jpeg;base64,")
    assert data["image"]["content_type"] == "image/jpeg"
    assert data["harmonize_id"]
    mock_fal.run.assert_awaited_once()


@pytest.mark.asyncio
async def test_harmonize_cache_hit_skips_fal(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: MagicMock,
) -> None:
    _seed_caches(_make_jpeg())
    ops = [ObjectPlacement(**_VALID_BODY["objects"][0])]
    from app.settings import get_settings

    cache_key = make_harmonize_cache_key(
        _SCENE_ID, ops, get_settings().harmonizer_backend, 0.35, None
    )
    import base64

    cached_raw = _make_jpeg()
    cached_data_url = f"data:image/jpeg;base64,{base64.b64encode(cached_raw).decode()}"
    harmonize_cache_module.save_cached(
        cache_key,
        {
            "harmonize_id": cache_key,
            "image": {"url": cached_data_url, "content_type": "image/jpeg"},
        },
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/harmonize", json=_VALID_BODY)

    assert resp.status_code == 200
    assert resp.json()["image"]["url"].startswith("data:image/jpeg;base64,")
    mock_fal.run.assert_not_awaited()


@pytest.mark.asyncio
async def test_harmonize_result_is_cached(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: MagicMock,
) -> None:
    _seed_caches(_make_jpeg())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/harmonize", json=_VALID_BODY)

    assert resp.status_code == 200
    harmonize_id = resp.json()["harmonize_id"]
    assert harmonize_cache_module.load_cached(harmonize_id) is not None


@pytest.mark.asyncio
async def test_harmonize_missing_scene_returns_404(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: MagicMock,
) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/harmonize", json=_VALID_BODY)

    assert resp.status_code == 404
    assert "scene" in resp.json()["message"].lower()


@pytest.mark.asyncio
async def test_harmonize_missing_object_returns_404(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: MagicMock,
) -> None:
    scene_image = _make_jpeg()
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    scene_cache_module.save_original(_SCENE_ID, scene_image)
    # Deliberately NOT saving the object cache entry

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/harmonize", json=_VALID_BODY)

    assert resp.status_code == 404
    assert "object" in resp.json()["message"].lower()


@pytest.mark.asyncio
async def test_harmonize_missing_original_returns_409(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: MagicMock,
) -> None:
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    obj_cache_module.save_cached(_OBJECT_ID, _OBJECT_CACHE_ENTRY)
    # Deliberately NOT saving original image bytes

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose/harmonize", json=_VALID_BODY)

    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_harmonize_fal_timeout_returns_504(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    png_bytes = _make_png_rgba()
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.fetch_bytes = AsyncMock(return_value=png_bytes)
    mock_client.run = AsyncMock(side_effect=FalTimeoutError("timed out"))
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    try:
        _seed_caches(_make_jpeg())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose/harmonize", json=_VALID_BODY)
        assert resp.status_code == 504
        assert resp.json()["error_code"] == "fal_timeout"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_harmonize_fal_rate_limit_returns_429(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    png_bytes = _make_png_rgba()
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.fetch_bytes = AsyncMock(return_value=png_bytes)
    mock_client.run = AsyncMock(side_effect=FalRateLimitError("rate limited"))
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    try:
        _seed_caches(_make_jpeg())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose/harmonize", json=_VALID_BODY)
        assert resp.status_code == 429
        assert resp.json()["error_code"] == "fal_rate_limited"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_harmonize_malformed_response_returns_502(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    png_bytes = _make_png_rgba()
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.fetch_bytes = AsyncMock(return_value=png_bytes)
    mock_client.run = AsyncMock(side_effect=FalMalformedResponseError("no images"))
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    try:
        _seed_caches(_make_jpeg())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose/harmonize", json=_VALID_BODY)
        assert resp.status_code == 502
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_harmonize_sdxl_fallback_calls_sdxl_endpoint(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.settings import get_settings

    monkeypatch.setenv("HARMONIZER_BACKEND", "sdxl")
    get_settings.cache_clear()
    try:
        png_bytes = _make_png_rgba()
        mock_client = MagicMock(spec=AsyncFalClient)
        mock_client.fetch_bytes = AsyncMock(return_value=png_bytes)
        mock_client.run = AsyncMock(return_value=_FAL_HARMONIZE_RESPONSE)
        app.dependency_overrides[get_fal_client] = lambda: mock_client

        _seed_caches(_make_jpeg())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose/harmonize", json=_VALID_BODY)

        assert resp.status_code == 200
        called_endpoint = mock_client.run.call_args[0][0]
        assert "sdxl" in called_endpoint or "stable-diffusion" in called_endpoint
    finally:
        app.dependency_overrides.clear()
        monkeypatch.delenv("HARMONIZER_BACKEND", raising=False)
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_harmonize_untrusted_url_returns_502(
    tmp_harmonize_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    """fal.ai returning a non-CDN URL must be rejected with 502."""
    png_bytes = _make_png_rgba()
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.fetch_bytes = AsyncMock(return_value=png_bytes)
    mock_client.run = AsyncMock(
        return_value={"images": [{"url": "https://evil.example.com/img.jpg"}]}
    )
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    try:
        _seed_caches(_make_jpeg())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose/harmonize", json=_VALID_BODY)
        assert resp.status_code == 502
    finally:
        app.dependency_overrides.clear()
