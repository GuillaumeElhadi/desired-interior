"""Tests for the composition endpoint: cache, PIL compositing, and router."""

import base64
import io
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from app.cloud.fal_client import AsyncFalClient, FalMalformedResponseError
from app.compose import cache as compose_cache_module
from app.compose.composition import make_cache_key
from app.dependencies import get_fal_client
from app.disk_cache import compute_sha256
from app.main import app
from app.objects import cache as obj_cache_module
from app.scenes import cache as scene_cache_module
from app.schemas import BoundingBox, ComposeRequest, PlacementSpec, StyleHints

OBJECT_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "objects"

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
# Helpers
# ---------------------------------------------------------------------------


def _make_jpeg(width: int = 256, height: int = 256) -> bytes:
    img = Image.new("RGB", (width, height), (150, 130, 110))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def _make_png_rgba(width: int = 32, height: int = 32) -> bytes:
    """RGBA PNG fixture simulating a BiRefNet-extracted object."""
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for x in range(8, width - 8):
        for y in range(8, height - 8):
            img.putpixel((x, y), (180, 120, 60, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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
    """Mock fal client whose fetch_bytes returns a valid RGBA PNG."""
    png_bytes = _make_png_rgba()
    mock_fetch = AsyncMock(return_value=png_bytes)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.fetch_bytes = mock_fetch
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    yield mock_fetch
    app.dependency_overrides.clear()


def _fal_error_override(side_effect: Exception) -> None:
    mock_fetch = AsyncMock(side_effect=side_effect)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.fetch_bytes = mock_fetch
    app.dependency_overrides[get_fal_client] = lambda: mock_client


def _seed_caches(
    scene_cache_root: Path,
    obj_cache_root: Path,
    scene_image_bytes: bytes,
) -> None:
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
        "image": {"url": "data:image/jpeg;base64,abc", "content_type": "image/jpeg"},
        "composite_url": "data:image/jpeg;base64,abc",
        "mask_url": "data:image/png;base64,def",
        "depth_map_url": "https://cdn.fal.ai/depth.png",
    }
    compose_cache_module.save_cached("xyz", data)
    assert compose_cache_module.load_cached("xyz") == data


# ---------------------------------------------------------------------------
# Composition cache key unit tests
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


def test_make_cache_key_differs_on_rotation() -> None:
    p1 = PlacementSpec(bbox=BoundingBox(x=10, y=20, width=50, height=60), rotation=0.0)
    p2 = PlacementSpec(bbox=BoundingBox(x=10, y=20, width=50, height=60), rotation=45.0)
    assert make_cache_key("s", "o", p1, _hints()) != make_cache_key("s", "o", p2, _hints())


def test_make_cache_key_differs_on_style_hints() -> None:
    placement = PlacementSpec(bbox=BoundingBox(x=10, y=20, width=50, height=60))
    assert make_cache_key("s", "o", placement, _hints("modern")) != make_cache_key(
        "s", "o", placement, _hints("rustic")
    )


# ---------------------------------------------------------------------------
# Schema validation tests
# ---------------------------------------------------------------------------

_VALID_SHA256 = "a" * 64


def test_compose_request_rejects_non_hex_scene_id() -> None:
    with pytest.raises(Exception):
        ComposeRequest(
            scene_id="not-a-sha256",
            object_id=_VALID_SHA256,
            placement=PlacementSpec(bbox=BoundingBox(x=0, y=0, width=10, height=10)),
        )


def test_compose_request_rejects_long_prompt_suffix() -> None:
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


def test_placement_spec_rotation_defaults_to_zero() -> None:
    p = PlacementSpec(bbox=BoundingBox(x=0, y=0, width=10, height=10))
    assert p.rotation == 0.0


# ---------------------------------------------------------------------------
# ComposeResponse depth_map_url validator
# ---------------------------------------------------------------------------


def _base_response(depth_map_url: str) -> dict:
    return {
        "composition_id": "a" * 64,
        "image": {"url": "data:image/jpeg;base64,abc", "content_type": "image/jpeg"},
        "composite_url": "data:image/jpeg;base64,abc",
        "mask_url": "data:image/png;base64,def",
        "depth_map_url": depth_map_url,
    }


def test_compose_response_accepts_empty_depth_map_url() -> None:
    from app.schemas import ComposeResponse

    r = ComposeResponse(**_base_response(""))
    assert r.depth_map_url == ""


def test_compose_response_accepts_valid_fal_cdn_url() -> None:
    from app.schemas import ComposeResponse

    r = ComposeResponse(**_base_response("https://cdn.fal.ai/depth.png"))
    assert r.depth_map_url == "https://cdn.fal.ai/depth.png"


def test_compose_response_rejects_non_fal_depth_map_url() -> None:
    from app.schemas import ComposeResponse

    with pytest.raises(Exception, match="allowlist"):
        ComposeResponse(**_base_response("https://evil.example.com/depth.png"))


def test_compose_response_rejects_http_depth_map_url() -> None:
    from app.schemas import ComposeResponse

    with pytest.raises(Exception, match="HTTPS"):
        ComposeResponse(**_base_response("http://cdn.fal.ai/depth.png"))


# ---------------------------------------------------------------------------
# Router integration tests (offline)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_compose_returns_data_url(
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
    assert data["image"]["url"].startswith("data:image/jpeg;base64,")
    assert data["image"]["content_type"] == "image/jpeg"
    assert data["composite_url"].startswith("data:image/jpeg;base64,")
    assert data["mask_url"].startswith("data:image/png;base64,")
    assert data["depth_map_url"] == "https://cdn.fal.ai/depth.png"
    assert mock_fal.await_count == 1


@pytest.mark.asyncio
async def test_compose_result_is_valid_jpeg(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_image = _make_jpeg(256, 256)
    _seed_caches(tmp_scene_cache, tmp_obj_cache, scene_image)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)

    assert resp.status_code == 200
    url = resp.json()["image"]["url"]
    b64 = url.split(",", 1)[1]
    img_bytes = base64.b64decode(b64)
    img = Image.open(io.BytesIO(img_bytes))
    assert img.mode == "RGB"
    assert img.size == (256, 256)


@pytest.mark.asyncio
async def test_compose_mask_is_strictly_binary(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_image = _make_jpeg(256, 256)
    _seed_caches(tmp_scene_cache, tmp_obj_cache, scene_image)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)

    assert resp.status_code == 200
    data = resp.json()

    # Decode mask and composite
    mask_b64 = data["mask_url"].split(",", 1)[1]
    mask_img = Image.open(io.BytesIO(base64.b64decode(mask_b64)))
    composite_b64 = data["composite_url"].split(",", 1)[1]
    composite_img = Image.open(io.BytesIO(base64.b64decode(composite_b64)))

    # Mask must be same resolution as the composite
    assert mask_img.size == composite_img.size

    # Mask pixels must be strictly binary (no anti-aliasing leakage).
    # PIL histogram returns 256 bucket counts; only bins 0 and 255 may be non-zero.
    mask_l = mask_img.convert("L")
    hist = mask_l.histogram()
    non_binary = sum(count for i, count in enumerate(hist) if count > 0 and i not in (0, 255))
    assert non_binary == 0, f"Non-binary pixels found in mask (count: {non_binary})"

    # At least some white pixels (the object footprint) must exist
    assert hist[255] > 0, "Mask has no white pixels — object not composited"


@pytest.mark.asyncio
async def test_compose_depth_map_url_passthrough(
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
    assert resp.json()["depth_map_url"] == "https://cdn.fal.ai/depth.png"


@pytest.mark.asyncio
async def test_compose_cache_hit_skips_fetch(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_image = _make_jpeg()
    _seed_caches(tmp_scene_cache, tmp_obj_cache, scene_image)

    placement = PlacementSpec(**_VALID_BODY["placement"])
    hints = StyleHints(**_VALID_BODY.get("style_hints", {}))
    cache_key = make_cache_key(_SCENE_ID, _OBJECT_ID, placement, hints)
    compose_cache_module.save_cached(
        cache_key,
        {
            "composition_id": cache_key,
            "image": {"url": "data:image/jpeg;base64,cached", "content_type": "image/jpeg"},
            "composite_url": "data:image/jpeg;base64,cached",
            "mask_url": "data:image/png;base64,cached_mask",
            "depth_map_url": "https://cdn.fal.ai/depth.png",
        },
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)

    assert resp.status_code == 200
    assert resp.json()["image"]["url"] == "data:image/jpeg;base64,cached"
    mock_fal.assert_not_awaited()


@pytest.mark.asyncio
async def test_compose_result_is_cached(
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
    composition_id = resp.json()["composition_id"]
    assert compose_cache_module.load_cached(composition_id) is not None


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
    assert "Scene" in resp.json()["message"]


@pytest.mark.asyncio
async def test_compose_missing_object_returns_404(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)
    assert resp.status_code == 404
    assert "Object" in resp.json()["message"]


@pytest.mark.asyncio
async def test_compose_missing_original_image_returns_409(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
    mock_fal: AsyncMock,
) -> None:
    scene_cache_module.save_cached(_SCENE_ID, _SCENE_CACHE_ENTRY)
    obj_cache_module.save_cached(_OBJECT_ID, _OBJECT_CACHE_ENTRY)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=_VALID_BODY)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_compose_bad_object_url_returns_502(
    tmp_compose_cache: Path,
    tmp_scene_cache: Path,
    tmp_obj_cache: Path,
) -> None:
    _fal_error_override(FalMalformedResponseError("untrusted URL blocked"))
    _seed_caches(tmp_scene_cache, tmp_obj_cache, _make_jpeg())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/compose", json=_VALID_BODY)
        assert resp.status_code == 502
    finally:
        app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Fixture-based offline test — real furniture PNG fixtures
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

    mock_fetch_bytes = AsyncMock(return_value=object_bytes)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.fetch_bytes = mock_fetch_bytes
    app.dependency_overrides[get_fal_client] = lambda: mock_client

    try:
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
        assert resp.json()["image"]["url"].startswith("data:image/jpeg;base64,")
    finally:
        app.dependency_overrides.clear()
