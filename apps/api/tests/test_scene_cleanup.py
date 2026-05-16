"""Tests for POST /scenes/clean — Scene cleanup endpoint (task 5.8)."""

import base64
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
from app.dependencies import get_fal_client
from app.exceptions import AppError
from app.main import app
from app.scenes import cache as scene_cache_module
from app.scenes import cleanup_cache as cleanup_cache_module
from app.scenes.cleanup import make_clean_cache_key, validate_mask

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SCENE_ID = "a" * 64
_W, _H = 256, 256

_SCENE_CACHE_ENTRY = {
    "scene_id": _SCENE_ID,
    "depth_map": {"url": "https://cdn.fal.ai/depth.png", "width": _W, "height": _H},
    "masks": [],
    "metadata": {
        "dominant_surface": "floor",
        "lighting_hint": "neutral",
        "light_direction": "ambient",
        "color_temperature": "neutral",
    },
}

_FAL_LAMA_RESPONSE = {"image": {"url": "https://cdn.fal.ai/cleaned.jpg"}}
_FAL_FLUX_RESPONSE = {"images": [{"url": "https://cdn.fal.ai/cleaned_flux.jpg"}]}

# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------


def _make_jpeg(width: int = _W, height: int = _H) -> bytes:
    img = Image.new("RGB", (width, height), (150, 130, 110))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def _make_binary_png(width: int = _W, height: int = _H, coverage: float = 0.05) -> bytes:
    """Strictly binary PNG mask — `coverage` fraction of pixels are white."""
    img = Image.new("L", (width, height), 0)
    white_count = int(width * height * coverage)
    for i in range(white_count):
        x, y = i % width, i // width
        img.putpixel((x, y), 255)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _png_data_url(png_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode()


def _valid_mask_data_url(coverage: float = 0.05) -> str:
    return _png_data_url(_make_binary_png(coverage=coverage))


def _valid_body(mask_data_url: str | None = None) -> dict:
    return {
        "scene_id": _SCENE_ID,
        "mask": mask_data_url or _valid_mask_data_url(),
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_scene_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    scene_tmp = tmp_path / "scenes"
    scene_tmp.mkdir()
    monkeypatch.setattr(scene_cache_module, "get_cache_root", lambda: scene_tmp)
    return scene_tmp


@pytest.fixture
def tmp_cleanup_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    clean_tmp = tmp_path / "scenes-clean"
    clean_tmp.mkdir()
    monkeypatch.setattr(cleanup_cache_module, "get_cache_root", lambda: clean_tmp)
    return clean_tmp


@pytest.fixture
def mock_fal() -> MagicMock:
    jpeg_bytes = _make_jpeg()
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.fetch_bytes = AsyncMock(return_value=jpeg_bytes)
    mock_client.run = AsyncMock(return_value=_FAL_LAMA_RESPONSE)
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    yield mock_client
    app.dependency_overrides.clear()


def _seed_scene(scene_bytes: bytes | None = None) -> None:
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    scene_cache_module.save_original(_SCENE_ID, scene_bytes or _make_jpeg())


# ---------------------------------------------------------------------------
# Cache unit tests
# ---------------------------------------------------------------------------


def test_cleanup_cache_miss_returns_none(tmp_cleanup_cache: Path) -> None:
    assert cleanup_cache_module.load_cached("nonexistent") is None


def test_cleanup_cache_save_and_hit(tmp_cleanup_cache: Path) -> None:
    raw = _make_jpeg()
    data_url = f"data:image/jpeg;base64,{base64.b64encode(raw).decode()}"
    meta = {"cleaned_scene_id": "z" * 64, "content_type": "image/jpeg"}
    cleanup_cache_module.save_cached("z" * 64, meta, raw)
    loaded = cleanup_cache_module.load_cached("z" * 64)
    assert loaded is not None
    assert loaded["cleaned_url"] == data_url
    assert loaded["cleaned_scene_id"] == "z" * 64


def test_cleanup_cache_missing_binary_returns_none(tmp_cleanup_cache: Path) -> None:
    # Save metadata but no binary file — simulates a corrupted/partial entry.
    from app.disk_cache import save_cached as _save

    root = cleanup_cache_module.get_cache_root()
    _save("partial", {"cleaned_scene_id": "x" * 64, "content_type": "image/jpeg"}, root)
    assert cleanup_cache_module.load_cached("partial") is None


# ---------------------------------------------------------------------------
# Cache key tests
# ---------------------------------------------------------------------------


def test_clean_cache_key_is_deterministic() -> None:
    k1 = make_clean_cache_key(_SCENE_ID, "b" * 64, "lama")
    k2 = make_clean_cache_key(_SCENE_ID, "b" * 64, "lama")
    assert k1 == k2
    assert len(k1) == 64


def test_clean_cache_key_differs_on_backend() -> None:
    k_lama = make_clean_cache_key(_SCENE_ID, "b" * 64, "lama")
    k_flux = make_clean_cache_key(_SCENE_ID, "b" * 64, "flux")
    assert k_lama != k_flux


def test_clean_cache_key_differs_on_mask() -> None:
    k1 = make_clean_cache_key(_SCENE_ID, "b" * 64, "lama")
    k2 = make_clean_cache_key(_SCENE_ID, "c" * 64, "lama")
    assert k1 != k2


# ---------------------------------------------------------------------------
# Mask validation unit tests
# ---------------------------------------------------------------------------


def test_validate_mask_accepts_valid_mask() -> None:
    mask = _make_binary_png(coverage=0.05)
    coverage = validate_mask(mask, _W, _H)
    assert 0.04 < coverage < 0.06


def test_validate_mask_rejects_wrong_resolution() -> None:
    mask = _make_binary_png(width=128, height=128)
    with pytest.raises(AppError) as exc_info:
        validate_mask(mask, _W, _H)
    assert exc_info.value.status_code == 422
    assert "mask_resolution_mismatch" in exc_info.value.error_code


def test_validate_mask_rejects_non_binary() -> None:
    img = Image.new("L", (_W, _H), 128)  # all grey pixels
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    with pytest.raises(AppError) as exc_info:
        validate_mask(buf.getvalue(), _W, _H)
    assert exc_info.value.status_code == 422
    assert "mask_not_binary" in exc_info.value.error_code


def test_validate_mask_rejects_exceeding_coverage() -> None:
    mask = _make_binary_png(coverage=0.25)
    with pytest.raises(AppError) as exc_info:
        validate_mask(mask, _W, _H)
    assert exc_info.value.status_code == 422
    assert "mask_coverage_exceeded" in exc_info.value.error_code


def test_validate_mask_accepts_boundary_coverage() -> None:
    mask = _make_binary_png(coverage=0.20)
    coverage = validate_mask(mask, _W, _H)
    assert coverage <= 0.20


# ---------------------------------------------------------------------------
# Schema validation tests
# ---------------------------------------------------------------------------


def test_clean_request_rejects_bad_scene_id() -> None:
    from app.schemas import CleanSceneRequest

    with pytest.raises(Exception):
        CleanSceneRequest(scene_id="not-a-sha256", mask=_valid_mask_data_url())


def test_clean_request_rejects_non_png_mask() -> None:
    from app.schemas import CleanSceneRequest

    jpeg_b64 = base64.b64encode(_make_jpeg()).decode()
    with pytest.raises(Exception):
        CleanSceneRequest(
            scene_id=_SCENE_ID,
            mask=f"data:image/jpeg;base64,{jpeg_b64}",
        )


def test_clean_request_accepts_valid_input() -> None:
    from app.schemas import CleanSceneRequest

    req = CleanSceneRequest(scene_id=_SCENE_ID, mask=_valid_mask_data_url())
    assert req.scene_id == _SCENE_ID
    assert req.prompt_hint is None


# ---------------------------------------------------------------------------
# Router integration — happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clean_lama_happy_path(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    _seed_scene()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body())

    assert resp.status_code == 200
    data = resp.json()
    assert data["cleaned_url"].startswith("data:image/jpeg;base64,")
    assert data["content_type"] == "image/jpeg"
    assert len(data["cleaned_scene_id"]) == 64
    mock_fal.run.assert_awaited_once()
    call_endpoint = mock_fal.run.call_args[0][0]
    assert "lama" in call_endpoint


@pytest.mark.asyncio
async def test_clean_flux_fallback_path(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.scenes import router as router_module
    from app.settings import Settings

    # Flux Fill returns {"images": [{"url": "..."}]}, not {"image": {"url": "..."}}.
    mock_fal.run.return_value = _FAL_FLUX_RESPONSE
    monkeypatch.setattr(router_module, "get_settings", lambda: Settings(scene_clean_backend="flux"))
    _seed_scene()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body())

    assert resp.status_code == 200
    call_endpoint = mock_fal.run.call_args[0][0]
    assert "flux" in call_endpoint
    call_args = mock_fal.run.call_args[0]
    assert len(call_args) == 2
    assert "prompt" in call_args[1]


@pytest.mark.asyncio
async def test_clean_stores_cleaned_scene_for_compose(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    _seed_scene()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body())

    assert resp.status_code == 200
    cleaned_id = resp.json()["cleaned_scene_id"]

    # cleaned_scene_id must be loadable from the scenes cache so /compose can use it
    assert scene_cache_module.load_original(cleaned_id) is not None
    assert scene_cache_module.load_cached(cleaned_id) is not None
    cached_preprocess = scene_cache_module.load_cached(cleaned_id)
    assert cached_preprocess["scene_id"] == cleaned_id


# ---------------------------------------------------------------------------
# Router integration — cache hit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clean_cache_hit_skips_fal(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    _seed_scene()
    body = _valid_body()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r1 = await c.post("/scenes/clean", json=body)
        r2 = await c.post("/scenes/clean", json=body)

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["cleaned_scene_id"] == r2.json()["cleaned_scene_id"]
    # fal.run only called once — second request is a cache hit
    mock_fal.run.assert_awaited_once()


# ---------------------------------------------------------------------------
# Router integration — 404 / 409
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clean_missing_scene_returns_404(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body())

    assert resp.status_code == 404
    assert resp.json()["error_code"] == "scene_not_found"


@pytest.mark.asyncio
async def test_clean_missing_preprocess_returns_409(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    # Only store original.bin, not result.json
    scene_cache_module.save_original(_SCENE_ID, _make_jpeg())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body())

    assert resp.status_code == 409
    assert resp.json()["error_code"] == "scene_preprocess_missing"


# ---------------------------------------------------------------------------
# Router integration — mask validation (422)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clean_wrong_resolution_mask_returns_422(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    _seed_scene()
    mask = _png_data_url(_make_binary_png(width=64, height=64, coverage=0.05))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body(mask))

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "mask_resolution_mismatch"


@pytest.mark.asyncio
async def test_clean_non_binary_mask_returns_422(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    _seed_scene()
    img = Image.new("L", (_W, _H), 128)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    mask = _png_data_url(buf.getvalue())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body(mask))

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "mask_not_binary"


@pytest.mark.asyncio
async def test_clean_mask_exceeds_coverage_returns_422(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    _seed_scene()
    mask = _png_data_url(_make_binary_png(coverage=0.25))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body(mask))

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "mask_coverage_exceeded"


# ---------------------------------------------------------------------------
# Router integration — fal error paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clean_timeout_returns_504(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    mock_fal.run.side_effect = FalTimeoutError("timed out")
    _seed_scene()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body())

    assert resp.status_code == 504
    assert resp.json()["error_code"] == "fal_timeout"


@pytest.mark.asyncio
async def test_clean_rate_limit_returns_429(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    mock_fal.run.side_effect = FalRateLimitError("rate limited")
    _seed_scene()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body())

    assert resp.status_code == 429
    assert resp.json()["error_code"] == "fal_rate_limited"


@pytest.mark.asyncio
async def test_clean_malformed_response_returns_502(
    tmp_scene_cache: Path,
    tmp_cleanup_cache: Path,
    mock_fal: MagicMock,
) -> None:
    mock_fal.run.return_value = {}  # no image URL in response
    mock_fal.fetch_bytes.side_effect = FalMalformedResponseError("no url")
    _seed_scene()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/scenes/clean", json=_valid_body())

    assert resp.status_code == 502
