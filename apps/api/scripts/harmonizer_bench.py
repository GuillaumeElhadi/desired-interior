"""Harmonizer A/B benchmarking harness — task 5.6.

Runs the harmonizer pipeline across a grid of strength × backend × surface_type,
split into wall vs floor fixture sets. Outputs a CSV of latency/results and a
contact-sheet PNG for visual review.

Usage:
    uv run python scripts/harmonizer_bench.py [OPTIONS]

Options:
    --output-dir PATH         Directory for CSV + contact-sheet (default: ../../docs/)
    --backends BACKENDS       Comma-separated backends, e.g. "flux,sdxl" (default: "flux")
    --strengths STRENGTHS     Comma-separated float values (default: benchmark grid)
    --depth-map-url URL       Optional depth map URL for ControlNet testing
    --controlnet-weights CWS  Comma-separated weights, only used with --depth-map-url
    --dry-run                 Log the grid without making any fal.ai calls (exit 0)
    --quick                   Reduced grid: 3 strengths × 1 backend (CI-friendly)

Environment:
    FAL_KEY   fal.ai API key (required unless --dry-run)

Example (full bench):
    FAL_KEY=fal-... uv run python scripts/harmonizer_bench.py --output-dir ../../docs/

Example (CI live test):
    FAL_KEY=fal-... uv run python scripts/harmonizer_bench.py --quick --backends flux
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import csv
import io
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import NamedTuple

# Allow running from the scripts/ subdirectory or from apps/api/.
_repo_api = Path(__file__).parent.parent
sys.path.insert(0, str(_repo_api))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from app.cloud.fal_client import AsyncFalClient, FalError  # noqa: E402
from app.compose.harmonize import (  # noqa: E402
    DEFAULT_STRENGTH_FLOOR,
    DEFAULT_STRENGTH_WALL,
    run_harmonize,
)
from app.schemas import BoundingBox, PlacementSpec  # noqa: E402

FIXTURES_DIR = Path(__file__).parent.parent / "tests" / "fixtures" / "objects"

# ---------------------------------------------------------------------------
# Grid defaults
# ---------------------------------------------------------------------------

_FULL_STRENGTHS = [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55]
_QUICK_STRENGTHS = [0.25, 0.35, 0.45]

# Placements: bboxes relative to a 512×512 scene image.
# Wall placement: centred in upper 40% of the image.
_WALL_PLACEMENT = PlacementSpec(
    bbox=BoundingBox(x=156.0, y=60.0, width=200.0, height=150.0),
    depth_hint=0.3,
    rotation=0.0,
)
# Floor placement: centred in lower 40% of the image.
_FLOOR_PLACEMENT = PlacementSpec(
    bbox=BoundingBox(x=156.0, y=290.0, width=200.0, height=150.0),
    depth_hint=0.7,
    rotation=0.0,
)

# Object fixtures mapped to their natural surface type.
_OBJECT_SURFACE = {
    "chair.png": "floor",
    "lamp.png": "floor",
    "plant.png": "floor",
    "sofa.png": "floor",
    "table.png": "floor",
}


# ---------------------------------------------------------------------------
# Synthetic room generation
# ---------------------------------------------------------------------------


def _make_room_jpeg(width: int = 512, height: int = 512) -> bytes:
    """Warm-floor + grey-wall synthetic room identical to the e2e test fixture."""
    img = Image.new("RGB", (width, height))
    pixels = img.load()
    assert pixels is not None
    for y in range(height):
        for x in range(width):
            if y > height * 2 // 3:
                r = min(255, 180 + (y - height * 2 // 3) // 3)
                pixels[x, y] = (r, 160, 120)
            else:
                pixels[x, y] = (210, 210, 215)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Bench cell
# ---------------------------------------------------------------------------


class BenchResult(NamedTuple):
    surface_type: str
    backend: str
    strength: float
    controlnet_weight: float
    object_name: str
    latency_s: float | None
    ok: bool
    error: str | None
    result_url: str | None


class BenchFixture(NamedTuple):
    object_name: str
    surface_type: str
    scene_bytes: bytes
    object_data_url: str
    placement: PlacementSpec


async def _bench_cell(
    fal: AsyncFalClient,
    fixture: BenchFixture,
    strength: float,
    controlnet_weight: float,
    backend: str,
    depth_map_url: str,
    dry_run: bool,
) -> BenchResult:
    if dry_run:
        print(
            f"  [dry-run] {fixture.surface_type}/{fixture.object_name} "
            f"strength={strength:.2f} cw={controlnet_weight:.2f} backend={backend}"
        )
        return BenchResult(
            surface_type=fixture.surface_type,
            backend=backend,
            strength=strength,
            controlnet_weight=controlnet_weight,
            object_name=fixture.object_name,
            latency_s=None,
            ok=True,
            error=None,
            result_url=None,
        )

    t0 = time.perf_counter()
    try:
        result = await run_harmonize(
            scene_image_bytes=fixture.scene_bytes,
            depth_map_url=depth_map_url,
            objects=[(fixture.object_data_url, fixture.surface_type, fixture.placement)],
            harmonize_strength=strength,
            seed=42,
            fal=fal,
            backend=backend,
            controlnet_weight=controlnet_weight,
        )
        elapsed = time.perf_counter() - t0
        print(
            f"  OK  {fixture.surface_type}/{fixture.object_name} "
            f"strength={strength:.2f} cw={controlnet_weight:.2f} backend={backend} "
            f"— {elapsed:.1f}s"
        )
        return BenchResult(
            surface_type=fixture.surface_type,
            backend=backend,
            strength=strength,
            controlnet_weight=controlnet_weight,
            object_name=fixture.object_name,
            latency_s=elapsed,
            ok=True,
            error=None,
            result_url=result["url"],
        )
    except FalError as exc:
        elapsed = time.perf_counter() - t0
        print(
            f"  ERR {fixture.surface_type}/{fixture.object_name} "
            f"strength={strength:.2f} backend={backend} — {type(exc).__name__} ({elapsed:.1f}s)"
        )
        return BenchResult(
            surface_type=fixture.surface_type,
            backend=backend,
            strength=strength,
            controlnet_weight=controlnet_weight,
            object_name=fixture.object_name,
            latency_s=elapsed,
            ok=False,
            error=type(exc).__name__,
            result_url=None,
        )


# ---------------------------------------------------------------------------
# Contact-sheet builder
# ---------------------------------------------------------------------------


def _build_contact_sheet(
    results: list[BenchResult],
    scene_bytes: bytes,
    title: str,
    fal: AsyncFalClient,
) -> Image.Image:
    """Build a PIL contact-sheet from bench results for one surface_type.

    Rows: objects; columns: (backend, strength) combinations.
    Result images are downloaded from fal.ai CDN via httpx.
    """
    import httpx

    _CDN_HOSTS = (".fal.ai", ".fal.run", ".fal.media")
    _MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB guard

    def _safe_fetch(url: str) -> bytes | None:
        """Fetch a result image only when it passes the fal.ai CDN allowlist."""
        if not url.startswith("https://"):
            return None
        host = url.split("/")[2]
        if not any(host.endswith(h) for h in _CDN_HOSTS):
            return None
        with httpx.stream("GET", url, timeout=30, follow_redirects=False) as resp:
            resp.raise_for_status()
            raw = resp.read()
            if len(raw) > _MAX_IMAGE_BYTES:
                return None
        return raw

    strengths = sorted({r.strength for r in results})
    backends = sorted({r.backend for r in results})
    objects = sorted({r.object_name for r in results})

    cell_w, cell_h = 200, 150
    label_h = 30
    n_cols = len(strengths) * len(backends)
    n_rows = len(objects)

    sheet_w = n_cols * cell_w + 60
    sheet_h = n_rows * (cell_h + label_h) + 60
    sheet = Image.new("RGB", (sheet_w, sheet_h), (240, 240, 240))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=10)
    except TypeError:
        font = ImageFont.load_default()

    # Column headers
    for col_idx, (backend, strength) in enumerate((b, s) for b in backends for s in strengths):
        x = 60 + col_idx * cell_w + cell_w // 2
        header = f"{backend[:4]}\n{strength:.2f}"
        draw.text((x - 20, 5), header, fill=(60, 60, 60), font=font)

    # Row headers + cells
    for row_idx, obj_name in enumerate(objects):
        y_base = 60 + row_idx * (cell_h + label_h)
        draw.text((2, y_base + cell_h // 2), obj_name[:8], fill=(60, 60, 60), font=font)

        for col_idx, (backend, strength) in enumerate((b, s) for b in backends for s in strengths):
            x = 60 + col_idx * cell_w
            y = y_base

            match_results = [
                r
                for r in results
                if r.object_name == obj_name
                and r.backend == backend
                and abs(r.strength - strength) < 0.001
                and r.ok
                and r.result_url
            ]

            if match_results and match_results[0].result_url:
                try:
                    raw = _safe_fetch(match_results[0].result_url)
                    if raw is None:
                        raise ValueError("blocked by CDN allowlist or size limit")
                    cell_img = Image.open(io.BytesIO(raw)).convert("RGB")
                    cell_img = cell_img.resize((cell_w, cell_h), Image.LANCZOS)
                    sheet.paste(cell_img, (x, y))
                except Exception:
                    draw.rectangle([x, y, x + cell_w, y + cell_h], fill=(200, 180, 180))
                    draw.text(
                        (x + 4, y + cell_h // 2), "download error", fill=(120, 0, 0), font=font
                    )
            elif not match_results:
                draw.rectangle([x, y, x + cell_w, y + cell_h], fill=(200, 200, 220))
                # Show defaults marker
                marker = ""
                if backend == "flux":
                    default = DEFAULT_STRENGTH_WALL if "wall" in title else DEFAULT_STRENGTH_FLOOR
                    if abs(strength - default) < 0.001:
                        marker = "★ default"
                draw.text(
                    (x + 4, y + cell_h // 2), f"skipped\n{marker}", fill=(80, 80, 80), font=font
                )
            else:
                draw.rectangle([x, y, x + cell_w, y + cell_h], fill=(220, 180, 180))
                err = match_results[0].error or "error"
                draw.text((x + 4, y + cell_h // 2), err[:20], fill=(120, 0, 0), font=font)

            # Mark the default strength column
            if backend == "flux":
                default = DEFAULT_STRENGTH_WALL if "wall" in title else DEFAULT_STRENGTH_FLOOR
                if abs(strength - default) < 0.001:
                    draw.rectangle(
                        [x, y, x + cell_w - 1, y + cell_h - 1], outline=(255, 180, 0), width=3
                    )

    draw.text((sheet_w // 2 - 100, sheet_h - 20), title, fill=(0, 0, 0), font=font)
    return sheet


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def run_bench(
    strengths: list[float],
    backends: list[float],
    controlnet_weights: list[float],
    depth_map_url: str,
    output_dir: Path,
    dry_run: bool,
) -> list[BenchResult]:
    fal_key = os.environ.get("FAL_KEY")
    if not dry_run and not fal_key:
        print("ERROR: FAL_KEY environment variable is required (or use --dry-run)", file=sys.stderr)
        sys.exit(1)

    fal = AsyncFalClient(
        key=fal_key or "",
        timeout_s=60.0,
        max_retries=2,
    )

    scene_bytes = _make_room_jpeg()

    # Build fixtures: one per (object, surface_type)
    fixtures: list[BenchFixture] = []
    for obj_path in sorted(FIXTURES_DIR.glob("*.png")):
        obj_bytes = obj_path.read_bytes()
        obj_data_url = "data:image/png;base64," + base64.b64encode(obj_bytes).decode()
        surface_type = _OBJECT_SURFACE.get(obj_path.name, "floor")
        placement = _WALL_PLACEMENT if surface_type == "wall" else _FLOOR_PLACEMENT
        fixtures.append(
            BenchFixture(
                object_name=obj_path.stem,
                surface_type=surface_type,
                scene_bytes=scene_bytes,
                object_data_url=obj_data_url,
                placement=placement,
            )
        )

    total_cells = len(fixtures) * len(strengths) * len(backends) * len(controlnet_weights)
    print(
        f"\nHarmonizer bench — {total_cells} cells "
        f"({'dry-run' if dry_run else 'LIVE'})\n"
        f"  Fixtures : {len(fixtures)} objects\n"
        f"  Strengths: {strengths}\n"
        f"  Backends : {backends}\n"
        f"  CW       : {controlnet_weights}\n"
        f"  Depth map: {depth_map_url or '(none)'}\n"
    )

    results: list[BenchResult] = []
    for fixture in fixtures:
        print(f"\n[{fixture.surface_type}/{fixture.object_name}]")
        for backend in backends:
            for strength in strengths:
                for cw in controlnet_weights:
                    result = await _bench_cell(
                        fal=fal,
                        fixture=fixture,
                        strength=strength,
                        controlnet_weight=cw,
                        backend=backend,
                        depth_map_url=depth_map_url,
                        dry_run=dry_run,
                    )
                    results.append(result)

    return results


def _write_csv(results: list[BenchResult], output_path: Path) -> None:
    with output_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "surface_type",
                "backend",
                "strength",
                "controlnet_weight",
                "object_name",
                "latency_s",
                "ok",
                "error",
                "result_url",
            ]
        )
        for r in results:
            writer.writerow(
                [
                    r.surface_type,
                    r.backend,
                    f"{r.strength:.2f}",
                    f"{r.controlnet_weight:.2f}",
                    r.object_name,
                    f"{r.latency_s:.2f}" if r.latency_s is not None else "",
                    r.ok,
                    r.error or "",
                    r.result_url or "",
                ]
            )
    print(f"\nCSV → {output_path}")


def _write_contact_sheets(
    results: list[BenchResult],
    output_dir: Path,
    timestamp: str,
    fal: None,
) -> None:
    for surface_type in ["wall", "floor"]:
        subset = [r for r in results if r.surface_type == surface_type and r.ok and r.result_url]
        if not subset:
            print(f"  No successful results for surface_type={surface_type!r}, skipping sheet.")
            continue
        title = f"Harmonizer bench — {surface_type} — {timestamp}"
        sheet = _build_contact_sheet(subset, b"", title, fal)  # type: ignore[arg-type]
        out = output_dir / f"harmonizer_bench_{timestamp}_contacts_{surface_type}.png"
        sheet.save(str(out))
        print(f"Contact sheet ({surface_type}) → {out}")


def _print_summary(results: list[BenchResult]) -> None:
    print("\n--- Summary ---")
    ok = [r for r in results if r.ok]
    fail = [r for r in results if not r.ok]
    latencies = [r.latency_s for r in ok if r.latency_s is not None]

    print(f"Total cells : {len(results)}")
    print(f"Succeeded   : {len(ok)}")
    print(f"Failed      : {len(fail)}")

    if latencies:
        latencies_sorted = sorted(latencies)
        n = len(latencies_sorted)
        p50 = latencies_sorted[n // 2]
        p95 = latencies_sorted[min(int(n * 0.95), n - 1)]
        print(f"Latency p50 : {p50:.1f}s")
        print(f"Latency p95 : {p95:.1f}s  (budget: ≤25s for Flux, ≤15s for SDXL)")
        budget_ok = all(
            r.latency_s is not None and r.latency_s <= (25.0 if r.backend == "flux" else 15.0)
            for r in ok
            if r.latency_s is not None
        )
        print(f"Budget      : {'PASS' if budget_ok else 'FAIL — some cells exceeded budget'}")

    # Per-surface defaults
    for surface_type in ["wall", "floor"]:
        default = DEFAULT_STRENGTH_WALL if surface_type == "wall" else DEFAULT_STRENGTH_FLOOR
        subset = [
            r
            for r in ok
            if r.surface_type == surface_type
            and r.backend == "flux"
            and abs(r.strength - default) < 0.001
        ]
        lats = [r.latency_s for r in subset if r.latency_s is not None]
        if lats:
            avg = sum(lats) / len(lats)
            print(
                f"Default {surface_type}: strength={default:.2f}, "
                f"avg_latency={avg:.1f}s over {len(lats)} cells"
            )

    if fail:
        print("\nFailed cells:")
        for r in fail:
            print(
                f"  {r.surface_type}/{r.object_name} s={r.strength:.2f} "
                f"backend={r.backend}: {r.error}"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Harmonizer A/B benchmark harness")
    parser.add_argument(
        "--output-dir", default="../../docs/", help="Output directory for CSV + PNG"
    )
    parser.add_argument("--backends", default="flux", help="Comma-separated backends")
    parser.add_argument("--strengths", default="", help="Comma-separated strength values")
    parser.add_argument("--depth-map-url", default="", help="Depth map URL for ControlNet testing")
    parser.add_argument(
        "--controlnet-weights",
        default="0.0",
        help="Comma-separated controlnet weights (only active with --depth-map-url)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Log grid without fal.ai calls")
    parser.add_argument("--quick", action="store_true", help="Reduced grid for quick validation")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    backends = [b.strip() for b in args.backends.split(",") if b.strip()]
    strengths = (
        [float(s.strip()) for s in args.strengths.split(",") if s.strip()]
        if args.strengths
        else (_QUICK_STRENGTHS if args.quick else _FULL_STRENGTHS)
    )
    controlnet_weights = [float(w.strip()) for w in args.controlnet_weights.split(",") if w.strip()]

    # ControlNet weights only apply when a depth map URL is provided.
    if not args.depth_map_url and controlnet_weights != [0.0]:
        controlnet_weights = [0.0]

    results = asyncio.run(
        run_bench(
            strengths=strengths,
            backends=backends,
            controlnet_weights=controlnet_weights,
            depth_map_url=args.depth_map_url,
            output_dir=output_dir,
            dry_run=args.dry_run,
        )
    )

    timestamp = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%S")

    if not args.dry_run:
        _write_csv(results, output_dir / f"harmonizer_bench_{timestamp}.csv")
        _write_contact_sheets(results, output_dir, timestamp, None)

    _print_summary(results)
    print("\nDefaults committed in harmonize.py:")
    print(f"  wall  = {DEFAULT_STRENGTH_WALL:.2f}")
    print(f"  floor = {DEFAULT_STRENGTH_FLOOR:.2f}")


if __name__ == "__main__":
    main()
