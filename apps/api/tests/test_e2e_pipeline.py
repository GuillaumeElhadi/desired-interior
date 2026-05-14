"""End-to-end pipeline test: preprocess → extract → compose against real fal.ai.

Skipped when FAL_KEY is not set. Marked @pytest.mark.e2e so the CI e2e job
can target it explicitly with `pytest -m e2e` without affecting the normal
offline test run.

All three disk caches are redirected to tmp_path so the production cache at
~/Library/Caches/InteriorVision/ is never touched.
"""

import io
import os
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from app.compose import cache as compose_cache_module
from app.main import app
from app.objects import cache as obj_cache_module
from app.scenes import cache as scene_cache_module

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "objects"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_room_jpeg(width: int = 512, height: int = 512) -> bytes:
    """Generate a minimal synthetic room image: warm floor gradient + grey wall."""
    img = Image.new("RGB", (width, height))
    pixels = img.load()
    assert pixels is not None
    for y in range(height):
        for x in range(width):
            if y > height * 2 // 3:
                # Floor — warm beige gradient
                r = min(255, 180 + (y - height * 2 // 3) // 3)
                pixels[x, y] = (r, 160, 120)
            else:
                # Wall — cool grey
                pixels[x, y] = (210, 210, 215)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def all_caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect all three pipeline caches to isolated tmp dirs."""
    scenes_root = tmp_path / "scenes"
    objects_root = tmp_path / "objects"
    compose_root = tmp_path / "compose"
    scenes_root.mkdir()
    objects_root.mkdir()
    compose_root.mkdir()
    monkeypatch.setattr(scene_cache_module, "get_cache_root", lambda: scenes_root)
    monkeypatch.setattr(obj_cache_module, "get_cache_root", lambda: objects_root)
    monkeypatch.setattr(compose_cache_module, "get_cache_root", lambda: compose_root)
    return tmp_path


# ---------------------------------------------------------------------------
# E2E test
# ---------------------------------------------------------------------------


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_full_pipeline_room_plus_chair(all_caches: Path) -> None:
    """Upload a synthetic room + fixture chair, assert a composed JPEG is returned.

    Pipeline steps exercised:
      1. POST /scenes/preprocess  → depth map + segmentation + scene metadata
      2. POST /objects/extract    → background-removed chair PNG
      3. POST /compose            → Flux Fill inpaints chair into room
    """
    if not os.environ.get("FAL_KEY"):
        pytest.skip("FAL_KEY not set — skipping live E2E test")

    room_bytes = _make_room_jpeg()
    chair_bytes = (FIXTURES_DIR / "chair.png").read_bytes()

    # ------------------------------------------------------------------
    # Step 1 — Scene preprocessing
    # ------------------------------------------------------------------
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post(
            "/scenes/preprocess",
            files={"image": ("room.jpg", room_bytes, "image/jpeg")},
        )
    assert resp.status_code == 200, f"/scenes/preprocess failed: {resp.text}"
    scene_payload = resp.json()
    scene_id: str = scene_payload["scene_id"]
    assert len(scene_id) == 64, f"scene_id is not a SHA-256 hex string: {scene_id!r}"
    assert scene_payload["depth_map"]["url"].startswith("https://")
    assert isinstance(scene_payload["masks"], list)

    # ------------------------------------------------------------------
    # Step 2 — Object extraction
    # ------------------------------------------------------------------
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post(
            "/objects/extract",
            files={"image": ("chair.png", chair_bytes, "image/png")},
        )
    assert resp.status_code == 200, f"/objects/extract failed: {resp.text}"
    object_payload = resp.json()
    object_id: str = object_payload["object_id"]
    assert len(object_id) == 64, f"object_id is not a SHA-256 hex string: {object_id!r}"
    assert object_payload["masked"]["url"].startswith("https://")

    # ------------------------------------------------------------------
    # Step 3 — Composition
    # ------------------------------------------------------------------
    compose_body = {
        "scene_id": scene_id,
        "object_id": object_id,
        "placement": {
            "bbox": {"x": 100.0, "y": 200.0, "width": 200.0, "height": 200.0},
            "depth_hint": 0.5,
        },
        "style_hints": {"prompt_suffix": "photorealistic, matching lighting"},
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/compose", json=compose_body)
    assert resp.status_code == 200, f"/compose failed: {resp.text}"
    compose_payload = resp.json()
    composition_id: str = compose_payload["composition_id"]
    image_url: str = compose_payload["image"]["url"]

    assert len(composition_id) == 64
    # Composition now returns a JPEG data URL (PIL compositing, no fal.ai round-trip)
    assert image_url.startswith("data:image/jpeg;base64,"), (
        f"Expected JPEG data URL, got: {image_url!r}"
    )

    # ------------------------------------------------------------------
    # Step 4 — Decode and verify the composed image
    # ------------------------------------------------------------------
    import base64 as _base64

    raw_bytes = _base64.b64decode(image_url.split(",", 1)[1])
    composed = Image.open(io.BytesIO(raw_bytes))
    assert composed.mode in ("RGB", "RGBA"), f"Unexpected image mode: {composed.mode}"
    assert composed.width > 0
    assert composed.height > 0

    # ------------------------------------------------------------------
    # Step 5 — Verify caching: second compose call must be served from cache
    # ------------------------------------------------------------------
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp2 = await c.post("/compose", json=compose_body)
    assert resp2.status_code == 200
    assert resp2.json()["composition_id"] == composition_id, "Cache miss on identical request"
    assert resp2.json()["image"]["url"] == image_url, "Different URL returned on cache hit"
