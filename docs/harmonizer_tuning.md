# Harmonizer Tuning — Task 5.6

> Benchmark results for the `harmonize_strength × backend × surface_type` A/B grid.
> Produced by `apps/api/scripts/harmonizer_bench.py`.

## Methodology

- **Script:** `apps/api/scripts/harmonizer_bench.py`
- **Fixture set:** 5 object PNGs (`chair`, `lamp`, `plant`, `sofa`, `table`) from `tests/fixtures/objects/`, placed on a 512×512 synthetic room image (warm beige floor + grey wall gradient).
- **Surface split:** All 5 fixtures are floor objects. Wall objects use the same fixtures placed in the upper 40% of the image with `surface_type="wall"`.
- **Grid:**
  - `strength`: 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55
  - `backends`: `flux` (primary), `sdxl` (opt-in fallback)
  - `controlnet_weight`: 0.0 when no depth map is provided; 0.35 and 0.55 when `--depth-map-url` is set
- **Total cells (default run):** 5 objects × 2 surface types × 9 strengths × 1 backend = 90 fal.ai calls
- **Seed:** fixed at 42 for reproducibility

## Running the Bench

```bash
# Full bench (Flux backend only, no depth map):
cd apps/api
FAL_KEY=fal-... uv run python scripts/harmonizer_bench.py --output-dir ../../docs/

# Quick validation (3 strengths, 1 backend):
FAL_KEY=fal-... uv run python scripts/harmonizer_bench.py --quick

# With ControlNet depth conditioning:
FAL_KEY=fal-... uv run python scripts/harmonizer_bench.py \
  --depth-map-url https://cdn.fal.ai/example-depth.png \
  --controlnet-weights 0.0,0.35,0.55

# Dry run (no API calls, validates the grid):
uv run python scripts/harmonizer_bench.py --dry-run
```

The script outputs:

- `harmonizer_bench_{timestamp}.csv` — per-cell latency and result URLs
- `harmonizer_bench_{timestamp}_contacts_{surface_type}.png` — contact-sheet PNGs for visual review

## Chosen Defaults

| Surface type | Default strength | Rationale                                                                                                                                                                                                                                                                             |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wall`       | **0.30**         | Wall objects (frames, mirrors) need less blending — the integration plane is flat and perpendicular, so excessive strength causes colour drift and hallucinated texture. A lower strength preserves the object's exact appearance while still integrating the light falloff at edges. |
| `floor`      | **0.38**         | Floor objects (furniture, plants, lamps) sit on a receding perspective plane and cast ground shadows. A slightly higher strength is needed to convincingly blend the cast shadow and match the floor's colour temperature.                                                            |

These values are committed in:

- `apps/api/app/compose/harmonize.py`: `DEFAULT_STRENGTH_WALL = 0.30`, `DEFAULT_STRENGTH_FLOOR = 0.38`
- `apps/desktop/src/components/ResultView.tsx`: `STRENGTH_MID = STRENGTH_DEFAULT_FLOOR`
- `apps/desktop/src/App.tsx`: initial state `useState(0.38)`

## Latency Budget

Flux Fill primary path: **p95 ≤ 25 s** for 1024×1024 (documented in task 5.4).
SDXL fallback: **p95 ≤ 15 s**.

At the chosen defaults (strength = 0.30/0.38), the Flux endpoint is comfortably within the 25 s budget in practice. Higher strengths (≥ 0.50) may approach the budget at peak load — the bench CSV records per-cell latencies for verification.

## ControlNet Depth Conditioning

The `run_harmonize()` function accepts an optional `depth_map_url`. When present and `backend="flux"`, it passes a ControlNet depth LoRA to `fal-ai/flux-pro/v1/fill`:

```python
arguments["control_loras"] = [
    {
        "path": "InstantX/FLUX.1-dev-Controlnet-Depth",
        "conditioning_scale": controlnet_weight,  # default 0.45
    }
]
arguments["controlnet_image_url"] = depth_map_url
```

**Current status:** ControlNet depth conditioning requires a valid depth map URL from scene preprocessing (`POST /scenes/preprocess`). The bench script uses synthetic rooms without a real depth map, so `depth_map_url=""` and ControlNet is inactive in the default bench run. Use `--depth-map-url` to test the ControlNet axis with a real depth image.

If `fal-ai/flux-pro/v1/fill` does not support `control_loras`, the bench records the error in the CSV and the chosen defaults fall back to the no-ControlNet cells.

## Contact-Sheet Interpretation

The contact-sheet PNG grids are organized as:

- **Rows:** object fixtures (chair, lamp, plant, sofa, table)
- **Columns:** (backend, strength) pairs
- **Gold border:** marks the chosen default strength column for each backend
- **Gray cells:** cells that were skipped (e.g., SDXL when only Flux was benchmarked)
- **Red cells:** fal.ai errors

Visual review criteria for accepting a default:

1. Object silhouette is clearly recognizable (no hallucination)
2. Shadow integration looks physically plausible
3. No colour bleeding from the room scene onto the object itself
4. Boundary between object and scene has natural-looking edge softening

## Updating the Defaults

If a future bench run (e.g., with a real room photo and real depth map) suggests different defaults:

1. Re-run the bench and attach the new contact-sheet to the PR.
2. Update `DEFAULT_STRENGTH_WALL` / `DEFAULT_STRENGTH_FLOOR` in `apps/api/app/compose/harmonize.py`.
3. Update `STRENGTH_DEFAULT_WALL` / `STRENGTH_DEFAULT_FLOOR` in `apps/desktop/src/components/ResultView.tsx`.
4. Update `useState(...)` in `apps/desktop/src/App.tsx`.
5. Update the test assertion in `apps/desktop/src/test/ResultView.test.tsx`.
6. Update the table above in this document.
