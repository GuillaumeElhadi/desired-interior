# ADR-0008 — AI Harmonizer: proxy-then-harmonize pipeline for photorealistic integration

- **Status**: Accepted
- **Date**: 2026-05-16
- **Builds on**: [ADR-0007 — PIL compositing over Flux Fill](0007-pil-compositing-over-flux-fill.md)
- **Implemented by**: tasks 5.3, 5.4, 5.5, 5.6
- **Tuning results**: [`docs/harmonizer_tuning.md`](../harmonizer_tuning.md)

## Context

ADR-0007 replaced the original Flux Fill inpainting call with deterministic PIL alpha-compositing. This solved the faithfulness problem — the user's exact object pixels now appear in the output — but introduced a different shortcoming: pasted objects look like cutouts. The alpha edge is hard, the object retains its own lighting, and cast shadows (where they exist) are synthetic ellipses rendered by PIL rather than perspective-accurate predictions from the scene geometry.

Task 4.5 added deterministic PIL shadow rendering as a low-cost partial workaround. The shadows are plausible but not realistic: they ignore the actual light direction in the photo, they are always the same elliptical shape, and they cannot model light bounce or colour temperature shifts between the scene and the pasted object.

The result is visually acceptable for a quick placement preview but falls short of the product's stated goal — **photorealistic** interior decoration, not compositing. Users testing the proxy output described it as "a fake Photoshop job", even after the shadow rendering was added.

Phase 5 reintroduces a generative pass now that the faithfulness contract is firmly established. The key constraint that ADR-0007 identified still holds:

> "adds back the round-trip latency and cost of a generative call" and "introduces a tunable `strength` parameter — too high and we drift back toward hallucination"

The Harmonizer's design is specifically engineered to honour that constraint: the generative model is allowed to touch only a **halo ring** around the object boundary, and the object's original pixels are explicitly restored on top of the model output before the result is returned.

## Decision

Implement a two-stage pipeline: `POST /compose` (PIL proxy) → `POST /compose/harmonize` (AI harmonization pass). The Harmonizer is opt-in — the default workflow remains the instant PIL composite. The user explicitly triggers harmonization via the **Harmonize** toggle in the result view.

### Stage 1 — proxy composite (unchanged)

`run_composition()` in `apps/api/app/compose/composition.py` produces:

1. A JPEG data URL of the scene with all placed objects alpha-composited (exact pixels, PIL only, no model call).
2. A binary B/W union mask PNG: white = pixels occupied by any placed object's alpha footprint, black = background.
3. The cached depth map URL from scene preprocessing (passed through, never recomputed).

### Stage 2 — harmonization pass (`run_harmonize()` in `apps/api/app/compose/harmonize.py`)

**Input**: the PIL composite, the union mask, the depth map URL, `harmonize_strength`, `seed?`.

**Pipeline**:

1. **Sequential re-composite**: call `run_composition()` once per placed object to re-derive the per-object binary masks and the final composite incrementally. OR-accumulate the binary masks into a union mask (using `ImageChops.lighter` — per-pixel max on L-channel images).

2. **Halo mask construction**: convert the union mask into a transition-zone mask via `_build_harmonize_mask(union_mask, halo_px=32)`:
   - Dilate the union mask by `2 × halo_px + 1 = 65` pixels using `ImageFilter.MaxFilter`.
   - Subtract the original union mask from the dilated version.
   - Result: a 32-pixel ring _around_ the object boundary. White = blend here. Black = preserve (both the object interior and the background far from the object are untouched by the model).

3. **fal.ai call**: send the composite image and halo mask to `fal-ai/flux-pro/v1/fill`:
   - `image_url`: the PIL composite (base64 data URL).
   - `mask_url`: the halo mask PNG (base64 data URL).
   - `prompt`: fixed suffix — `"preserve object identity, integrate lighting and cast shadows naturally, photorealistic interior, no new objects"`.
   - `strength`: `harmonize_strength ∈ [0.15, 0.55]`, required, no server-side default (the UI pre-selects per-surface defaults from task 5.6).
   - `control_loras`: when `depth_map_url` is non-empty, includes `InstantX/FLUX.1-dev-Controlnet-Depth` at `conditioning_scale=0.45` for perspective-aware shadow integration.

4. **Object pixel restoration**: download the model output via `AsyncFalClient.fetch_bytes`. Paste the original PIL composite's object pixels back on top, using the binary union mask as the paste mask. This step guarantees pixel-perfect preservation of the user's object regardless of what the model did inside the masked region.

5. Return a JPEG data URL of the restored composite.

### Backends

| `HARMONIZER_BACKEND` | Endpoint                                | Default                                                  |
| -------------------- | --------------------------------------- | -------------------------------------------------------- |
| `flux` (default)     | `fal-ai/flux-pro/v1/fill`               | Yes — primary path, the product's core value proposition |
| `sdxl`               | `fal-ai/stable-diffusion-xl-inpainting` | No — opt-in cost optimisation only                       |

SDXL is **never** the default. It is a cost-optimisation option surfaced to users who understand the trade-off (lower per-call cost, shorter latency, weaker scene-lighting integration).

### Tuned defaults (from task 5.6 A/B bench)

| Surface type | Default `harmonize_strength` | Rationale                                                                                                                             |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `wall`       | **0.30**                     | Flat perpendicular integration plane; lower strength avoids colour drift and hallucinated texture on frames / mirrors                 |
| `floor`      | **0.38**                     | Receding perspective plane; slightly higher strength needed for convincing cast-shadow blending and floor colour-temperature matching |

ControlNet depth conditioning weight: **0.45** (default, inactive when no depth map is cached).

See [`docs/harmonizer_tuning.md`](../harmonizer_tuning.md) for the full A/B grid, methodology, and contact-sheet PNGs.

### fal.ai boundary

All fal.ai calls originate from `apps/api/app/cloud/fal_client.py` via `AsyncFalClient.run` and `AsyncFalClient.fetch_bytes`. No fal SDK import is present in `harmonize.py` or `router.py`. The `architecture-keeper` agent enforces this on every PR touching backend code.

The SSRF allowlist (`.fal.ai`, `.fal.run`, `.fal.media`) was established in task 4.4 and covers the CDN hosts used by harmonized image downloads.

### Cache

Results are cached at `~/Library/Caches/InteriorVision/harmonize/<hash>/`, keyed on:

```
SHA-256(scene_id : sorted_placements : backend : harmonize_strength : seed : controlnet_weight)
```

Cache hits return in < 50 ms. The harmonize cache is separate from the compose cache — identical placement parameters that differ only in `harmonize_strength` produce distinct cache entries.

### Latency budget

| Backend             | Target p95 (1024×1024) |
| ------------------- | ---------------------- |
| Flux Fill (primary) | ≤ 25 s                 |
| SDXL (fallback)     | ≤ 15 s                 |
| Cache hit           | < 50 ms                |

## Alternatives considered

### A. Full-frame img2img (no mask)

Send the entire PIL composite to a low-strength img2img call without any masking. Simple to implement; no mask construction step.

**Rejected**: without a mask, the model has license to alter the entire scene — furniture, walls, room structure — above strength ≈ 0.25. Object identity is not guaranteed. The key lesson from the original Flux Fill path (ADR-0007) was that unconstrained generative calls hallucinate. A maskless img2img is the same failure mode at lower strength.

### B. Interior-object mask (mask the object itself)

Mask the object's interior and ask Flux Fill to regenerate it in the context of the scene. The hope is that the model would regenerate the object with correct lighting baked in.

**Rejected**: Flux Fill, even at low strength, regenerates its masked region from scratch rather than blending. The regenerated object diverges visibly from the user's uploaded photo above strength ≈ 0.20. This reproduces the original ADR-0007 problem (hallucination, unfaithfulness) and directly contradicts the user expectation set by the proxy.

### C. PIL shadows only, no generative pass

Keep task 4.5's synthetic shadow rendering and accept its limitations. The workflow remains fully deterministic, offline-capable, and instant.

**Deferred, not rejected**: this remains the default experience until the user opts into harmonization. The PIL proxy is fast, faithful, and useful. The Harmonizer is an enhancement, not a replacement.

## Consequences

### Gained

- **Photorealistic integration**: cast shadows, edge softening, and light-bounce are derived from the scene's actual pixel distribution rather than synthetic PIL geometry.
- **Faithfulness preserved**: the pixel-restoration step (stage 2, step 4) re-asserts the user's exact object pixels after the model runs. Faithfulness is no longer a property of the model's behaviour — it is enforced in code.
- **Opt-in path**: users who want instant results keep the PIL proxy. Users who want photoreal output click Harmonize. The two paths share the same composite and mask pipeline.
- **Per-surface defaults**: the bench-derived defaults (0.30 wall / 0.38 floor) give most users a good out-of-the-box result without needing to tune the slider.

### Lost / trade-offs

- **Latency**: the harmonize path adds 10–25 s per request vs. the sub-second proxy.
- **Cost**: each harmonize call consumes fal.ai GPU credits. SDXL backend is provided as a cost-optimisation escape hatch.
- **Determinism**: model output at a given strength is stochastic (seeded when `seed` is provided, unseeded otherwise). The cache eliminates repeat costs for identical inputs.

### Security

`AsyncFalClient.fetch_bytes` is called to download the harmonized image from fal.ai CDN. The SSRF allowlist enforced in `harmonize.py` restricts accepted hosts to `.fal.ai`, `.fal.run`, and `.fal.media`. The byte-stream is immediately decoded as a JPEG via PIL (no arbitrary code execution path).

## Follow-ups

- If `fal-ai/flux-pro/v1/fill` gains first-class ControlNet Depth support (beyond the current `control_loras` LoRA path), update the conditioning argument in `run_harmonize()`.
- `depth_hint`-driven perspective correction for floor objects placed at varying depths (tracked in backlog, referenced in ADR-0007 follow-ups).
- Re-run the bench with real room photos and real depth maps when a representative fixture set is available; current bench uses synthetic 512×512 rooms.
