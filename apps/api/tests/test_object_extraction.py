"""Tests for object extraction: disk_cache refactor, extraction logic, and router."""

import io
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from app.cloud.fal_client import AsyncFalClient, FalRateLimitError, FalTimeoutError
from app.dependencies import get_fal_client
from app.disk_cache import compute_sha256
from app.main import app
from app.objects import cache as obj_cache_module
from app.objects.extraction import _parse_result
from app.scenes import cache as scene_cache_module

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "objects"
FIXTURE_NAMES = ["chair.png", "table.png", "lamp.png", "sofa.png", "plant.png"]

_BIREFNET_RESPONSE = {
    "image": {
        "url": "https://cdn.fal.ai/extracted.png",
        "width": 256,
        "height": 256,
        "content_type": "image/png",
    }
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_obj_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(obj_cache_module, "get_cache_root", lambda: tmp_path)
    return tmp_path


_MOONDREAM_FLOOR_RESPONSE = {"output": "floor"}


@pytest.fixture
def mock_fal() -> AsyncMock:
    """Route fal.run() by endpoint: BiRefNet → mask response, Moondream → classification."""

    async def dispatch(endpoint: str, _args: dict) -> dict:
        if "moondream" in endpoint:
            return _MOONDREAM_FLOOR_RESPONSE
        return _BIREFNET_RESPONSE

    mock_run = AsyncMock(side_effect=dispatch)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.run = mock_run
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    yield mock_run
    app.dependency_overrides.clear()


def _fal_override(side_effect: Exception) -> None:
    mock_run = AsyncMock(side_effect=side_effect)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.run = mock_run
    app.dependency_overrides[get_fal_client] = lambda: mock_client


# ---------------------------------------------------------------------------
# disk_cache generic tests (covers the shared module via objects cache)
# ---------------------------------------------------------------------------


def test_disk_cache_miss_returns_none(tmp_obj_cache: Path) -> None:
    assert obj_cache_module.load_cached("nonexistent") is None


def test_disk_cache_save_and_hit(tmp_obj_cache: Path) -> None:
    data = {"object_id": "abc", "masked": {"url": "u", "width": 1, "height": 1}}
    obj_cache_module.save_cached("abc", data)
    assert obj_cache_module.load_cached("abc") == data


def test_disk_cache_corrupted_json_clears_entry(tmp_obj_cache: Path) -> None:
    sha = "badentry"
    d = tmp_obj_cache / sha
    d.mkdir()
    (d / "result.json").write_text("not-json", encoding="utf-8")
    assert obj_cache_module.load_cached(sha) is None
    assert not d.exists()


def test_disk_cache_empty_file_clears_entry(tmp_obj_cache: Path) -> None:
    sha = "emptyfile"
    d = tmp_obj_cache / sha
    d.mkdir()
    (d / "result.json").write_bytes(b"")
    assert obj_cache_module.load_cached(sha) is None


def test_scenes_cache_still_works_after_refactor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Verify scenes/cache thin wrapper still passes through correctly."""
    monkeypatch.setattr(scene_cache_module, "get_cache_root", lambda: tmp_path)
    data = {"scene_id": "x"}
    scene_cache_module.save_cached("x", data)
    assert scene_cache_module.load_cached("x") == data


# ---------------------------------------------------------------------------
# Extraction logic unit tests
# ---------------------------------------------------------------------------


def test_parse_result_standard_shape() -> None:
    r = _parse_result(_BIREFNET_RESPONSE)
    assert r["url"] == "https://cdn.fal.ai/extracted.png"
    assert r["width"] == 256
    assert r["height"] == 256
    assert r["content_type"] == "image/png"


def test_parse_result_missing_image_key() -> None:
    r = _parse_result({})
    assert r["url"] == ""
    assert r["width"] == 0
    assert r["height"] == 0
    assert r["content_type"] == "image/png"


def test_parse_result_null_image_key() -> None:
    r = _parse_result({"image": None})
    assert r["url"] == ""


# ---------------------------------------------------------------------------
# Router integration tests (all offline)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_extract_cache_miss_calls_fal_and_caches(
    tmp_obj_cache: Path, mock_fal: AsyncMock
) -> None:
    png = _make_png()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/objects/extract", files={"image": ("obj.png", png, "image/png")})
    assert resp.status_code == 200
    data = resp.json()
    assert data["masked"]["url"] == "https://cdn.fal.ai/extracted.png"
    assert data["masked"]["object_type"] == "floor"
    # Two parallel fal.run calls: BiRefNet (mask) + Moondream2 (classification)
    assert mock_fal.await_count == 2
    assert (tmp_obj_cache / data["object_id"] / "result.json").exists()


@pytest.mark.asyncio
async def test_extract_classifies_wall_when_moondream_says_wall(tmp_obj_cache: Path) -> None:
    """Moondream returning 'wall' → object_type == 'wall' in the response."""

    async def dispatch(endpoint: str, _args: dict) -> dict:
        if "moondream" in endpoint:
            return {"output": "wall"}
        return _BIREFNET_RESPONSE

    mock_run = AsyncMock(side_effect=dispatch)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.run = mock_run
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/objects/extract", files={"image": ("obj.png", _make_png(), "image/png")}
            )
        assert resp.status_code == 200
        assert resp.json()["masked"]["object_type"] == "wall"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_extract_falls_back_to_floor_on_classification_error(tmp_obj_cache: Path) -> None:
    """Moondream call raising FalError → object_type falls back to 'floor', extraction succeeds."""

    from app.cloud.fal_client import FalError as _FalError

    async def dispatch(endpoint: str, _args: dict) -> dict:
        if "moondream" in endpoint:
            raise _FalError("classification down")
        return _BIREFNET_RESPONSE

    mock_run = AsyncMock(side_effect=dispatch)
    mock_client = MagicMock(spec=AsyncFalClient)
    mock_client.run = mock_run
    app.dependency_overrides[get_fal_client] = lambda: mock_client
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/objects/extract", files={"image": ("obj.png", _make_png(), "image/png")}
            )
        assert resp.status_code == 200
        assert resp.json()["masked"]["object_type"] == "floor"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_extract_cache_hit_skips_fal(tmp_obj_cache: Path, mock_fal: AsyncMock) -> None:
    png = _make_png()
    sha256 = compute_sha256(png)
    obj_cache_module.save_cached(
        sha256,
        {
            "object_id": sha256,
            "masked": {
                "url": "https://cdn.fal.ai/cached.png",
                "width": 64,
                "height": 64,
                "content_type": "image/png",
            },
        },
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/objects/extract", files={"image": ("obj.png", png, "image/png")})
    assert resp.status_code == 200
    assert resp.json()["masked"]["url"] == "https://cdn.fal.ai/cached.png"
    mock_fal.assert_not_awaited()


@pytest.mark.asyncio
async def test_extract_fal_timeout_returns_504(tmp_obj_cache: Path) -> None:
    _fal_override(FalTimeoutError("timed out"))
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/objects/extract", files={"image": ("obj.png", _make_png(), "image/png")}
            )
        assert resp.status_code == 504
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_extract_fal_rate_limit_returns_429(tmp_obj_cache: Path) -> None:
    _fal_override(FalRateLimitError("rate limited"))
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/objects/extract", files={"image": ("obj.png", _make_png(), "image/png")}
            )
        assert resp.status_code == 429
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_extract_unsupported_type_returns_415(tmp_obj_cache: Path) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post(
            "/objects/extract", files={"image": ("doc.pdf", b"%PDF", "application/pdf")}
        )
    assert resp.status_code == 415


@pytest.mark.asyncio
async def test_extract_empty_file_returns_400(tmp_obj_cache: Path) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/objects/extract", files={"image": ("empty.png", b"", "image/png")})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Parametrised fixture tests (offline — verify the full pipeline per image)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture_name", FIXTURE_NAMES)
@pytest.mark.asyncio
async def test_extract_with_each_fixture_offline(
    fixture_name: str, tmp_obj_cache: Path, mock_fal: AsyncMock
) -> None:
    image_bytes = (FIXTURES_DIR / fixture_name).read_bytes()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post(
            "/objects/extract",
            files={"image": (fixture_name, image_bytes, "image/png")},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["object_id"] == compute_sha256(image_bytes)
    assert data["masked"]["url"] != ""
    # Two parallel fal.run calls: BiRefNet (mask) + Moondream2 (classification)
    assert mock_fal.await_count == 2
    mock_fal.reset_mock()


# ---------------------------------------------------------------------------
# Live tests — call real BiRefNet and validate alpha channel
# ---------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.parametrize("fixture_name", FIXTURE_NAMES)
@pytest.mark.asyncio
async def test_live_extract_has_alpha(fixture_name: str, tmp_obj_cache: Path) -> None:
    import httpx

    key = os.environ.get("FAL_KEY")
    if not key:
        pytest.skip("FAL_KEY not set")

    image_bytes = (FIXTURES_DIR / fixture_name).read_bytes()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post(
            "/objects/extract",
            files={"image": (fixture_name, image_bytes, "image/png")},
        )
    assert resp.status_code == 200, resp.text
    masked_url = resp.json()["masked"]["url"]
    assert masked_url.startswith("https://")

    # Download the result and verify alpha channel
    async with httpx.AsyncClient() as http:
        png_resp = await http.get(masked_url)
    assert png_resp.status_code == 200

    img = Image.open(io.BytesIO(png_resp.content))
    assert img.mode == "RGBA", f"Expected RGBA, got {img.mode} for {fixture_name}"

    alpha = [p[3] for p in img.getdata()]
    assert min(alpha) == 0, f"No transparent pixels in {fixture_name} — background not removed"
    assert max(alpha) == 255, f"No opaque pixels in {fixture_name} — object not preserved"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_png(width: int = 32, height: int = 32) -> bytes:
    img = Image.new("RGB", (width, height), (180, 160, 140))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
