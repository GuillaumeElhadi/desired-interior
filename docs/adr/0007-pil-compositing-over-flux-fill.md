# ADR-0007 — Replace Flux Fill generative inpainting with local PIL alpha-compositing for object placement

- **Status**: Accepted
- **Date**: 2026-05-14
- **Supersedes (partially)**: ML pipeline section of [ADR-0003 sidecar packaging](0003-sidecar-packaging.md) — only the composition step changes, all other ML steps (BiRefNet extraction, Depth Anything V2, SAM) remain cloud-based.

## Context

The original composition pipeline (introduced in task 2.4) sent the scene image, a binary placement mask, and a text prompt to `fal-ai/flux-lora/inpainting`. The **object image was never sent to the model** — the source code admitted this in a comment: `# Reference-image conditioning (Redux / IP-Adapter) is not yet supported by the fal-ai/flux-pro/v1/fill endpoint. The object_url is currently unused but accepted for future use.`

The model therefore hallucinated furniture-shaped pixels inside the masked rectangle, guided only by the prompt and by surrounding scene context. The output was **inspired by** the user's intent rather than **faithful to** the actual object they uploaded. User feedback during task 4.3 testing was unambiguous: the composited image "doesn't correspond to what I want — I wanted the objects to integrate into the decor, at the right depth and scale; instead it generates an image inspired by my decor and my objects, nothing faithful."

We considered three options before deciding.

## Decision

Switch `/compose` and `/compose/preview` from a generative-inpainting model call to **deterministic local PIL/Pillow alpha-compositing** of the BiRefNet-extracted object PNG onto the scene image.

The new pipeline (`apps/api/app/compose/composition.py`):

1. Open the scene image with PIL.
2. Download the BiRefNet-masked object PNG via `AsyncFalClient.fetch_bytes` (CDN download only — no fal.ai inference).
3. Resize the object to the placement bbox, rotate around its centre to match Konva's transform.
4. Alpha-composite onto the scene.
5. Encode as a base64 JPEG `data:` URL and return it through the existing `ComposeResponse` shape.

`/compose/preview` becomes a thin delegate to `run_composition` — the previous fast/slow quality split (4-step preview vs 28-step final) collapses because there is no more model inference. The two endpoints are kept distinct only to preserve cache isolation.

## Alternatives considered

### A. Flux Fill + IP-Adapter / Redux reference conditioning

The intended-but-unimplemented original design. Requires either a fal.ai endpoint that accepts a reference image alongside the inpainting mask (none existed at the time of writing), or stacking two separate calls (Flux Redux → Flux Fill) which doubles latency and cost while still not guaranteeing object identity.

**Rejected**: no first-class fal.ai endpoint exists; output is still probabilistic, not faithful.

### B. Local PIL composite + AI harmonization pass

PIL paste, then a low-strength img2img call to blend lighting, shadows, and edges. Quality would be higher (object integrated into scene lighting), but:

- adds back the round-trip latency and cost of a generative call
- introduces a tunable `strength` parameter — too high and we drift back toward hallucination, too low and the AI pass is wasted
- the user complaint was about faithfulness, not visual integration

**Deferred** as a future enhancement once the faithfulness contract is established. A separate task (4.5) introduces deterministic PIL shadow rendering as a cheaper, non-generative compromise for visual integration.

### C. Direct PIL composite only (chosen)

Maximally faithful. The user's exact object pixels end up in the output, at the position, scale, and rotation they chose. No model inference, no latency, no cost, no graphics card, no probabilistic output.

## Consequences

### Gained

- **Faithfulness**: the output now contains the user's exact object. No hallucination.
- **Latency**: `/compose` and `/compose/preview` drop from ~3 s and ~15 s p95 respectively to < 500 ms (one CDN fetch + local PIL ops).
- **Cost**: no fal.ai inference cost per render. Only the upstream BiRefNet extraction (already paid once per object) and Moondream classification (added in task 4.5) remain.
- **Determinism**: same inputs always produce identical output bytes — caching becomes more meaningful and bug reproduction is straightforward.
- **Offline-tolerant**: once the BiRefNet result is cached, `/compose` works without any network call.

### Lost

- **Scene-lighting integration**: pasted objects retain their own lighting and have hard alpha edges. Task 4.5 adds deterministic shadow rendering as a partial compensation; full lighting harmonisation is deferred to a future generative pass if needed.
- **Perspective correction**: the object is placed flat at the user-specified bbox. The `depth_hint` field is accepted in the schema but is currently unused — a future task may use it to apply a perspective transform.
- **Style hints**: `style_hints.prompt_suffix` no longer affects output. Kept in the schema for forward compatibility (it would resurface if option B above is ever revisited).

### Cache invalidation

Cached compositions written under the previous Flux Fill path are still valid in shape (same `ComposeResponse` schema) but contain the old hallucinated URLs. They will be served from cache until the user re-renders the same placement. No automated migration — the cache directory can be purged manually if a fresh render is required.

### Security

`AsyncFalClient.fetch_bytes` is now exercised by the composition path (previously only by SAM mask download). The SSRF allowlist had to be widened to include `.fal.media` because the BiRefNet result CDN sits on that domain. See the security audit attached to the task 4.4 PR for the residual risks (stream-based size check, decompression-bomb guard placement).

## Follow-ups

- Task 4.5: add deterministic PIL shadow rendering (elliptical ground shadow for floor objects, drop-shadow for wall objects).
- Future: revisit a low-strength AI harmonisation pass once the faithfulness contract is firmly established.
- Future: implement `depth_hint`-driven perspective correction for floor objects placed at varying depths.
