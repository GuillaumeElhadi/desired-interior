# ADR 0006 — Canvas library: Konva.js + react-konva

**Status:** Accepted
**Date:** 2026-05-08
**Task:** 3.3 (Canvas + interactive placement)

## Context

Task 3.3 requires an interactive 2D canvas on which furniture objects can be dragged, scaled, rotated, and depth-hinted over a room photograph. The implementation needed:

- Pixel-precise drag, scale, and rotate for arbitrary image nodes
- A `Transformer` (multi-handle bounding box) that works across mouse and trackpad
- Keyboard nudge, snap-to-surface, and per-object selection
- Persistence integration with the existing SQLite store

The options evaluated were:

| Option                     | Pros                                                                                               | Cons                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Konva.js + react-konva** | Mature (10+ years), React-first API, built-in Transformer, no native canvas dep in CI with vi.mock | `react-konva@19.x` targets React 19 peer dep (project uses React 18); `its-fine` bridge adds one indirect dep |
| **Fabric.js**              | Widely used, good docs                                                                             | No React-native API; requires imperative imperative bridging; larger bundle                                   |
| **Pixi.js**                | Higher performance (WebGL)                                                                         | Overkill for interior design scale; no built-in Transformer; steeper learning curve                           |
| **Raw Canvas API + SVG**   | Zero deps                                                                                          | Large amount of custom code needed for hit-testing, transform handles, keyboard management; error-prone       |

## Decision

Use **Konva.js `^8.4.2`** and **react-konva `^18.2.2`** as the sole canvas rendering layer.

`react-konva@18.x` is the React 18–compatible release line; `react-konva@19.x` requires React 19 and ships `its-fine@2.x` which accesses React 19 internals that are absent in React 18, causing a module-evaluation crash (blank white screen, no ErrorBoundary recovery). The project will upgrade to React 19 + react-konva@19 in a dedicated `chore(deps)` PR; until then, the `^8.4.2` / `^18.2.2` pair is the correct choice.

## Consequences

- `konva` and `react-konva` are added to `apps/desktop/package.json`. These are the only canvas/2D-scene libraries in the codebase; new canvas work must use Konva, not introduce a second library.
- Vitest tests mock `react-konva` and `konva` entirely (no native canvas dep in CI).
- A follow-up `chore(deps)` PR should upgrade React to 19 to eliminate the `its-fine` peer-dep mismatch flagged in the security audit.
