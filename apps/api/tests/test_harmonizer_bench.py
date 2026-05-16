"""Harmonizer bench tests (task 5.6).

Non-live: verifies the bench script structure without calling fal.ai.
Live (@pytest.mark.live): runs a single real bench cell against fal.ai.

Run all bench tests:
    uv run pytest -m bench --no-cov -v

Run only non-live:
    uv run pytest -m "bench and not live" --no-cov -v
"""

from __future__ import annotations

import base64
import io
import os
from pathlib import Path

import pytest
from PIL import Image

from app.cloud.fal_client import AsyncFalClient
from app.compose.harmonize import DEFAULT_STRENGTH_FLOOR, DEFAULT_STRENGTH_WALL

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
FIXTURES_DIR = Path(__file__).parent / "fixtures" / "objects"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_jpeg(width: int = 256, height: int = 256) -> bytes:
    img = Image.new("RGB", (width, height), (180, 160, 140))
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
# Non-live: structural / import tests
# ---------------------------------------------------------------------------


@pytest.mark.bench
def test_bench_defaults_are_in_valid_range() -> None:
    assert 0.15 <= DEFAULT_STRENGTH_WALL <= 0.55, "Wall default outside [0.15, 0.55]"
    assert 0.15 <= DEFAULT_STRENGTH_FLOOR <= 0.55, "Floor default outside [0.15, 0.55]"


@pytest.mark.bench
def test_bench_wall_default_le_floor_default() -> None:
    assert DEFAULT_STRENGTH_WALL <= DEFAULT_STRENGTH_FLOOR, (
        "Wall default should be ≤ floor default (wall objects need less blending)"
    )


@pytest.mark.bench
def test_bench_script_importable() -> None:
    """The bench script must be importable without side effects."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "harmonizer_bench", SCRIPTS_DIR / "harmonizer_bench.py"
    )
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    assert hasattr(mod, "run_bench")
    assert hasattr(mod, "_FULL_STRENGTHS")
    assert hasattr(mod, "_QUICK_STRENGTHS")


@pytest.mark.bench
def test_bench_dry_run(tmp_path: Path) -> None:
    """--dry-run must exit 0 and produce no output files."""
    import subprocess
    import sys

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS_DIR / "harmonizer_bench.py"),
            "--dry-run",
            "--output-dir",
            str(tmp_path),
        ],
        capture_output=True,
        text=True,
        cwd=str(SCRIPTS_DIR.parent),  # apps/api
    )
    assert result.returncode == 0, (
        f"dry-run failed:\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}"
    )
    # No CSV or PNG should be written in dry-run mode
    assert not list(tmp_path.glob("*.csv")), "dry-run should not write CSV"
    assert not list(tmp_path.glob("*.png")), "dry-run should not write PNG"


@pytest.mark.bench
def test_bench_object_fixtures_exist() -> None:
    """All expected object fixtures used by the bench must be present."""
    expected = ["chair.png", "lamp.png", "plant.png", "sofa.png", "table.png"]
    for name in expected:
        assert (FIXTURES_DIR / name).exists(), f"Missing bench fixture: {name}"


@pytest.mark.bench
def test_bench_room_jpeg_generation() -> None:
    """The synthetic room generator produces a valid JPEG."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "harmonizer_bench", SCRIPTS_DIR / "harmonizer_bench.py"
    )
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)  # type: ignore[union-attr]

    jpeg_bytes = mod._make_room_jpeg(width=256, height=256)
    img = Image.open(io.BytesIO(jpeg_bytes))
    assert img.format == "JPEG"
    assert img.size == (256, 256)


# ---------------------------------------------------------------------------
# Live: single real bench cell via fal.ai
# ---------------------------------------------------------------------------


@pytest.mark.bench
@pytest.mark.live
async def test_bench_flux_floor_single_cell() -> None:
    """Live: one real harmonize cell — DEFAULT_STRENGTH_FLOOR, backend=flux, surface=floor."""
    fal_key = os.environ.get("FAL_KEY")
    if not fal_key:
        pytest.skip("FAL_KEY not set")

    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "harmonizer_bench", SCRIPTS_DIR / "harmonizer_bench.py"
    )
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)  # type: ignore[union-attr]

    fal = AsyncFalClient(key=fal_key, timeout_s=60.0, max_retries=1)
    scene_bytes = mod._make_room_jpeg()
    chair_path = FIXTURES_DIR / "chair.png"
    obj_bytes = chair_path.read_bytes()
    obj_data_url = "data:image/png;base64," + base64.b64encode(obj_bytes).decode()

    fixture = mod.BenchFixture(
        object_name="chair",
        surface_type="floor",
        scene_bytes=scene_bytes,
        object_data_url=obj_data_url,
        placement=mod._FLOOR_PLACEMENT,
    )

    result = await mod._bench_cell(
        fal=fal,
        fixture=fixture,
        strength=DEFAULT_STRENGTH_FLOOR,
        controlnet_weight=0.0,
        backend="flux",
        depth_map_url="",
        dry_run=False,
    )

    assert result.ok, f"Live bench cell failed: {result.error}"
    assert result.latency_s is not None
    assert result.latency_s <= 25.0, f"Flux p95 budget exceeded: {result.latency_s:.1f}s"
    assert result.result_url is not None
    assert result.result_url.startswith("https://")
