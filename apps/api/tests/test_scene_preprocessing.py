"""Tests for scene preprocessing: cache hit/miss/corrupted + router error handling."""

import io
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from app.cloud.fal_client import AsyncFalClient, FalRateLimitError, FalTimeoutError
from app.dependencies import get_fal_client
from app.main import app
from app.scenes import cache as cache_module
from app.scenes.preprocessing import (
    _analyse_lighting,
    _estimate_surface,
    _extract_masks,
    _regions_from_segmentation_png,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DEPTH_RESPONSE = {"image": {"url": "https://cdn.fal.ai/depth.png", "width": 512, "height": 512}}

# fal-ai/sam returns a colour-coded segmentation image, not a masks list.
_SAM_RESPONSE = {
    "image": {
        "url": "https://cdn.fal.ai/segmented.png",
        "width": 64,
        "height": 64,
        "content_type": "image/png",
    }
}

# Legacy masks-list format kept for _extract_masks backward-compat tests.
_LEGACY_SAM2_RESPONSE = {
    "masks": [
        {
            "url": "https://cdn.fal.ai/mask0.png",
            "label": "floor",
            "score": 0.95,
            "area": 50000,
            "bbox": [0, 300, 512, 512],
        },
        {
            "url": "https://cdn.fal.ai/mask1.png",
            "label": "wall",
            "score": 0.88,
            "area": 30000,
            "bbox": [0, 0, 512, 300],
        },
    ]
}


def _make_jpeg(width: int = 32, height: int = 32, color: tuple = (128, 128, 128)) -> bytes:
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def _make_segmentation_png(width: int = 64, height: int = 64) -> bytes:
    """Synthetic colour-coded segmentation PNG with two distinct regions.

    Top half: blue  (wall)
    Bottom half: red (floor)
    """
    img = Image.new("RGB", (width, height), (0, 0, 0))
    for y in range(height):
        for x in range(width):
            img.putpixel((x, y), (0, 0, 255) if y < height // 2 else (255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def tmp_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(cache_module, "get_cache_root", lambda: tmp_path)
    return tmp_path


@pytest.fixture
def mock_fal() -> AsyncMock:
    """Override get_fal_client with a mock that returns depth + SAM responses."""
    mock_run = AsyncMock(side_effect=[_DEPTH_RESPONSE, _SAM_RESPONSE])
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.run = mock_run
    mock_client.fetch_bytes = AsyncMock(return_value=_make_segmentation_png())
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    yield mock_run
    app.dependency_overrides.clear()


def _fal_override(side_effect: Exception):
    mock_run = AsyncMock(side_effect=side_effect)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.run = mock_run
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    return mock_client


# ---------------------------------------------------------------------------
# Cache unit tests
# ---------------------------------------------------------------------------


def test_cache_miss_returns_none(tmp_cache: Path) -> None:
    assert cache_module.load_cached("nonexistent") is None


def test_cache_save_and_hit(tmp_cache: Path) -> None:
    data = {"scene_id": "abc", "depth_map": {}, "masks": [], "metadata": {}}
    cache_module.save_cached("abc", data)
    loaded = cache_module.load_cached("abc")
    assert loaded == data


def test_cache_corrupted_json_returns_none_and_deletes(tmp_cache: Path) -> None:
    sha = "deadbeef"
    cache_dir = tmp_cache / sha
    cache_dir.mkdir()
    (cache_dir / "result.json").write_text("this is not json", encoding="utf-8")

    result = cache_module.load_cached(sha)

    assert result is None
    assert not cache_dir.exists()


def test_cache_corrupted_empty_file_returns_none(tmp_cache: Path) -> None:
    sha = "empty123"
    cache_dir = tmp_cache / sha
    cache_dir.mkdir()
    (cache_dir / "result.json").write_bytes(b"")

    result = cache_module.load_cached(sha)
    assert result is None


# ---------------------------------------------------------------------------
# Segmentation PNG extraction unit tests
# ---------------------------------------------------------------------------


def test_regions_from_segmentation_png_two_regions() -> None:
    png = _make_segmentation_png(64, 64)
    masks = _regions_from_segmentation_png(png)
    # Must detect exactly two regions (blue wall + red floor)
    assert len(masks) == 2
    areas = sorted(m["area"] for m in masks)
    # Both halves are roughly equal in size
    assert areas[0] > 0
    assert all(m["bbox"] and len(m["bbox"]) == 4 for m in masks)


def test_regions_from_segmentation_png_bbox_covers_half_image() -> None:
    W, H = 64, 64
    png = _make_segmentation_png(W, H)
    masks = _regions_from_segmentation_png(png)
    # Largest region should span the full width
    largest = max(masks, key=lambda m: m["area"])
    x, y, w, h = largest["bbox"]
    assert w >= W - 2  # allow 1px rounding
    assert h >= H // 2 - 2


def test_regions_from_segmentation_png_empty_black_image() -> None:
    img = Image.new("RGB", (64, 64), (0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    masks = _regions_from_segmentation_png(buf.getvalue())
    assert masks == []


def test_regions_from_segmentation_png_sorted_by_area_desc() -> None:
    png = _make_segmentation_png(64, 64)
    masks = _regions_from_segmentation_png(png)
    areas = [m["area"] for m in masks]
    assert areas == sorted(areas, reverse=True)


# ---------------------------------------------------------------------------
# Legacy _extract_masks backward-compat tests
# ---------------------------------------------------------------------------


def test_extract_masks_standard_shape() -> None:
    masks = _extract_masks(_LEGACY_SAM2_RESPONSE)
    assert len(masks) == 2
    assert masks[0]["url"] == "https://cdn.fal.ai/mask0.png"
    assert masks[0]["label"] == "floor"
    assert masks[0]["score"] == pytest.approx(0.95)


def test_extract_masks_empty_response() -> None:
    assert _extract_masks({}) == []


def test_extract_masks_alternate_keys() -> None:
    result = {"segments": [{"mask_url": "https://cdn.fal.ai/s.png", "area": 100}]}
    masks = _extract_masks(result)
    assert masks[0]["url"] == "https://cdn.fal.ai/s.png"


# ---------------------------------------------------------------------------
# Metadata unit tests
# ---------------------------------------------------------------------------


def test_estimate_surface_floor_dominant() -> None:
    masks = _extract_masks(_LEGACY_SAM2_RESPONSE)
    img = Image.new("RGB", (512, 512))
    surface = _estimate_surface(masks, img)
    assert surface == "floor"


def test_estimate_surface_no_masks() -> None:
    img = Image.new("RGB", (512, 512))
    assert _estimate_surface([], img) == "unknown"


def test_analyse_lighting_bright_image() -> None:
    img = Image.new("RGB", (64, 64), (230, 230, 230))
    hint, direction, temp = _analyse_lighting(img)
    assert hint == "bright"


def test_analyse_lighting_dark_image() -> None:
    img = Image.new("RGB", (64, 64), (40, 40, 40))
    hint, direction, temp = _analyse_lighting(img)
    assert hint == "dark"


def test_analyse_lighting_warm_image() -> None:
    img = Image.new("RGB", (64, 64), (200, 150, 100))
    _, _, temp = _analyse_lighting(img)
    assert temp == "warm"


def test_analyse_lighting_cool_image() -> None:
    img = Image.new("RGB", (64, 64), (100, 150, 200))
    _, _, temp = _analyse_lighting(img)
    assert temp == "cool"


def test_analyse_lighting_overhead() -> None:
    img = Image.new("RGB", (64, 64))
    for y in range(64):
        for x in range(64):
            lum = int(255 * (1 - y / 64))
            img.putpixel((x, y), (lum, lum, lum))
    _, direction, _ = _analyse_lighting(img)
    assert direction == "overhead"


# ---------------------------------------------------------------------------
# Router integration tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_preprocess_cache_miss_calls_fal_and_caches(
    tmp_cache: Path, mock_fal: AsyncMock
) -> None:
    # mock_fal fixture already configures fetch_bytes to return a synthetic PNG
    jpeg = _make_jpeg()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/scenes/preprocess", files={"image": ("room.jpg", jpeg, "image/jpeg")}
        )

    assert response.status_code == 200
    data = response.json()
    assert "scene_id" in data
    assert data["depth_map"]["url"] == "https://cdn.fal.ai/depth.png"
    # Two colour regions extracted from the synthetic PNG
    assert len(data["masks"]) == 2
    assert all(m["bbox"] for m in data["masks"])
    assert mock_fal.await_count == 2

    sha256 = data["scene_id"]
    assert (tmp_cache / sha256 / "result.json").exists()


@pytest.mark.asyncio
async def test_preprocess_sam_failure_still_returns_200(
    tmp_cache: Path,
) -> None:
    """SAM failure must not block preprocessing — depth + lighting always work."""
    mock_run = AsyncMock(side_effect=[_DEPTH_RESPONSE, Exception("sam 404")])
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.run = mock_run
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    try:
        jpeg = _make_jpeg()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/scenes/preprocess", files={"image": ("room.jpg", jpeg, "image/jpeg")}
            )
        assert response.status_code == 200
        data = response.json()
        assert data["masks"] == []
        assert "dominant_surface" in data["metadata"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_preprocess_cache_hit_skips_fal(tmp_cache: Path, mock_fal: AsyncMock) -> None:
    jpeg = _make_jpeg()
    sha256 = cache_module.compute_sha256(jpeg)

    cached_payload = {
        "scene_id": sha256,
        "depth_map": {"url": "https://cdn.fal.ai/cached.png", "width": 512, "height": 512},
        "masks": [],
        "metadata": {
            "dominant_surface": "floor",
            "lighting_hint": "neutral",
            "light_direction": "ambient",
            "color_temperature": "neutral",
        },
    }
    cache_module.save_cached(sha256, cached_payload)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/scenes/preprocess", files={"image": ("room.jpg", jpeg, "image/jpeg")}
        )

    assert response.status_code == 200
    assert response.json()["depth_map"]["url"] == "https://cdn.fal.ai/cached.png"
    mock_fal.assert_not_awaited()


@pytest.mark.asyncio
async def test_preprocess_fal_timeout_returns_504(tmp_cache: Path) -> None:
    _fal_override(FalTimeoutError("timed out"))
    try:
        jpeg = _make_jpeg()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/scenes/preprocess", files={"image": ("room.jpg", jpeg, "image/jpeg")}
            )
        assert response.status_code == 504
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_preprocess_fal_rate_limit_returns_429(tmp_cache: Path) -> None:
    _fal_override(FalRateLimitError("rate limited"))
    try:
        jpeg = _make_jpeg()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/scenes/preprocess", files={"image": ("room.jpg", jpeg, "image/jpeg")}
            )
        assert response.status_code == 429
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_preprocess_unsupported_type_returns_415(tmp_cache: Path) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/scenes/preprocess",
            files={"image": ("doc.pdf", b"%PDF-1", "application/pdf")},
        )
    assert response.status_code == 415


@pytest.mark.asyncio
async def test_preprocess_empty_file_returns_400(tmp_cache: Path) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/scenes/preprocess",
            files={"image": ("empty.jpg", b"", "image/jpeg")},
        )
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# Live test
# ---------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.asyncio
async def test_live_preprocess_real_image(tmp_cache: Path) -> None:
    import os

    key = os.environ.get("FAL_KEY")
    if not key:
        pytest.skip("FAL_KEY not set")

    jpeg = _make_jpeg(width=512, height=512, color=(150, 130, 110))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/scenes/preprocess", files={"image": ("room.jpg", jpeg, "image/jpeg")}
        )
    assert response.status_code == 200
    data = response.json()
    assert data["depth_map"]["url"].startswith("https://")
    assert "dominant_surface" in data["metadata"]
    # With the new SAM endpoint, we expect at least one mask
    assert len(data["masks"]) >= 1
    assert all(len(m["bbox"]) == 4 for m in data["masks"])
