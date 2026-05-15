# IPC Contract — Tauri ↔ Python Sidecar

## Overview

The Tauri desktop shell communicates with the Python FastAPI sidecar over HTTP on `127.0.0.1` using a randomly assigned port. All traffic stays on the loopback interface — nothing leaves the machine.

## Sidecar lifecycle

| Event                     | Behavior                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App starts (`setup()`)    | Rust binds an ephemeral port via `TcpListener::bind("127.0.0.1:0")`, spawns the sidecar with `--host 127.0.0.1 --port <N>`, stores `http://127.0.0.1:<N>` in `ApiState` |
| `RunEvent::ExitRequested` | Rust calls `CommandChild::kill()` on the stored handle                                                                                                                  |
| Sidecar crash             | `CommandChild` handle becomes invalid; frontend HTTP calls fail with a network error (surfaced as an error state in the UI)                                             |

## Tauri commands

### `api_base_url() → Result<String, String>`

- **Rust definition:** `apps/desktop/src-tauri/src/lib.rs`
- **JS binding:** `invoke("api_base_url")` via `@tauri-apps/api/core`
- **Frontend wrapper:** `getApiBaseUrl()` in `apps/desktop/src/lib/api.ts`
- **Returns:** `"http://127.0.0.1:<port>"` where `<port>` is the ephemeral port chosen at startup

### `ipc_token() → Result<String, String>`

- **JS binding:** `invoke("ipc_token")` via `@tauri-apps/api/core`
- **Returns:** The 128-bit random hex token generated at startup. Must be sent as `Authorization: Bearer <token>` on every HTTP request to the sidecar.

## HTTP endpoints

| Method | Path                 | Description                                                                                                                                                                  | Request body                          | Response body / status          |
| ------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------- |
| `GET`  | `/health`            | Liveness probe. Response includes `{status, version, bg_removal_backend}` where `bg_removal_backend` ∈ `{"birefnet","bria"}` (diagnostic field, not in shared-types schema). | —                                     | `HealthResponse` (JSON)         |
| `POST` | `/logs`              | Receive frontend logs                                                                                                                                                        | `LogRequest` (JSON)                   | `204 No Content`                |
| `POST` | `/scenes/preprocess` | Scene depth + segmentation                                                                                                                                                   | `multipart/form-data` — field `image` | `PreprocessResponse` (JSON)     |
| `POST` | `/objects/extract`   | Object background removal                                                                                                                                                    | `multipart/form-data` — field `image` | `ExtractResponse` (JSON)        |
| `POST` | `/compose/preview`   | Faithful object placement on the scene (local PIL alpha-composite — see ADR-0007)                                                                                            | `ComposeRequest` (JSON)               | `PreviewComposeResponse` (JSON) |
| `POST` | `/compose`           | Same composition path as `/compose/preview`; kept distinct for cache isolation only                                                                                          | `ComposeRequest` (JSON)               | `ComposeResponse` (JSON)        |
| `POST` | `/settings`          | Hot-reload runtime settings                                                                                                                                                  | `UpdateSettingsRequest` (JSON)        | `UpdateSettingsResponse` (JSON) |
| `POST` | `/compose/harmonize` | Generative harmonisation pass — Flux Fill img2img + ControlNet Depth (primary) or SDXL img2img (fallback via `HARMONIZER_BACKEND=sdxl`). **Backend lands in task 5.4.**      | `HarmonizeRequest` (JSON)             | `HarmonizeResponse` (JSON)      |

All endpoints accept and return `application/json`. New endpoints added in `apps/api/app/` must be documented here and wrapped in `apps/desktop/src/lib/api.ts`.

### `LogRequest` schema

```json
{
  "entries": [
    {
      "level": "debug | info | warn | error",
      "message": "human-readable message",
      "correlation_id": "<session UUID — generated once per frontend session>",
      "timestamp": "<ISO 8601>",
      "context": { "key": "any JSON-serialisable value" }
    }
  ]
}
```

### `ComposeRequest` schema

```json
{
  "scene_id": "<SHA-256 returned by /scenes/preprocess>",
  "object_id": "<SHA-256 returned by /objects/extract>",
  "placement": {
    "bbox": { "x": 50, "y": 80, "width": 200, "height": 200 },
    "depth_hint": 0.5,
    "rotation": 0.0
  },
  "style_hints": {
    "prompt_suffix": "Scandinavian style, warm lighting."
  }
}
```

`bbox` coordinates are in pixels relative to the original room image. `depth_hint` is a normalised depth value (0 = foreground, 1 = background). `rotation` is in clockwise degrees, matching Konva's convention; the object is rotated around its centre. `style_hints` is optional and currently unused by the local compositing path (kept in the schema for forward compatibility — see ADR-0007).

**Prerequisite**: `/scenes/preprocess` must have been called with the room image before `/compose` — it writes the original image bytes to disk so the composition step can retrieve them. A `409 Conflict` is returned if the original is missing from cache.

### `ComposeResponse` schema

```json
{
  "composition_id": "<SHA-256 of the composition inputs — used as cache key>",
  "image": {
    "url": "data:image/jpeg;base64,<base64-encoded JPEG bytes>",
    "content_type": "image/jpeg"
  },
  "composite_url": "data:image/jpeg;base64,<base64-encoded JPEG bytes>",
  "mask_url": "data:image/png;base64,<base64-encoded binary B/W PNG>",
  "depth_map_url": "https://<fal.ai CDN host>/depth.png"
}
```

- **`image`** (back-compat) — nested object kept for consumers that predate task 5.3; `image.url` is identical to `composite_url`.
- **`composite_url`** — canonical `data:image/jpeg;base64,…` data URL of the composited scene; fed to `<img src>`.
- **`mask_url`** — `data:image/png;base64,…` data URL of a binary B/W mask the same resolution as the composite. White pixels mark the placed object's alpha footprint after rotation/scale; black is background. Strictly binary (0 or 255 only — no anti-aliasing). Used as the inpainting mask by the Harmonizer (task 5.4).
- **`depth_map_url`** — HTTPS URL pointing to the scene's depth map on the fal.ai CDN (produced by `/scenes/preprocess`; passed through from cache). Host is constrained to `*.fal.ai`, `*.fal.run`, or `*.fal.media`. May be an empty string `""` if the scene was preprocessed before task 5.3 landed and the depth URL is unavailable.

The `url` inside `image` is a `data:` URL — no external CDN fetch on the composite. See [ADR-0007](adr/0007-pil-compositing-over-flux-fill.md) for the rationale (faithful placement of the user's exact object).

**Latency budget (final)**: < 500 ms p95 for 1024×1024 (local PIL composite + JPEG encode + mask PNG encode + one CDN download for the masked object PNG). Cached compositions returned in < 50 ms. No fal.ai inference call is made by `/compose`.

### `PreviewComposeResponse` schema

```json
{
  "preview_id": "<SHA-256 of the composition inputs — used as preview cache key>",
  "image": {
    "url": "data:image/jpeg;base64,<base64-encoded JPEG bytes>",
    "content_type": "image/jpeg"
  }
}
```

**Latency budget (preview)**: identical to `/compose` — the preview now uses the same local PIL path. The endpoint is kept distinct from `/compose` only so the two caches stay isolated (`~/Library/Caches/InteriorVision/preview/` vs `~/Library/Caches/InteriorVision/compose/`); behaviour and quality are identical.

### `UpdateSettingsRequest` / `UpdateSettingsResponse` schema

```json
// Request
{ "fal_key": "fal_..." }

// Response
{ "ok": true }
```

Calling `POST /settings` with a `fal_key` rebuilds the fal.ai client immediately — no sidecar restart required. Pass an empty string `""` to clear the key (equivalent to unconfiguring it). Fields set to `null` are ignored (no-op). `fal_key` is validated to ≤ 200 characters.

### `HarmonizeRequest` / `HarmonizeResponse` schema

> **Status: forward declaration.** The frontend wrapper (`harmonize()` in `api.ts`) and these types exist as of task 5.2. The backend route (`POST /compose/harmonize`) and the Pydantic models are implemented in task 5.4. The `pnpm codegen` run in task 5.3 will move these types from the local `api.ts` declaration into `packages/shared-types`.

```json
// HarmonizeRequest
{
  "scene_id": "<SHA-256 returned by /scenes/preprocess>",
  "object_ids": ["<SHA-256 returned by /objects/extract>"],
  "harmonize_strength": 0.35,
  "seed": 42
}
```

- `harmonize_strength` — required, clamped to `[0.15, 0.55]` by the backend. No server-side default (see task 5.6 for the benchmarked recommended value). The UI slider in task 5.5 exposes this field.
- `seed` — optional. When absent the backend picks a random seed; supply it to reproduce a result.
- `object_ids` — list of all object SHA-256 hashes currently placed on the canvas (used to build the binary composition mask and the cache key).

```json
// HarmonizeResponse
{
  "url": "data:image/jpeg;base64,<base64-encoded harmonised JPEG>"
}
```

The `url` is a `data:` URL containing the harmonised JPEG inline (same convention as `/compose`). The backend also returns the binary B/W mask and depth map URLs (see task 5.3), but the frontend only consumes `url` in task 5.2.

**Latency budget**: p95 ≤ 25 s for 1024×1024 on Flux Fill (primary), ≤ 15 s on SDXL (fallback). Cache hit on identical inputs < 50 ms.

### Error response schema

All error responses (HTTP 4xx/5xx raised by route handlers, plus unhandled 500s) return a structured JSON body:

```json
{
  "error": "<error_code>",
  "error_code": "<error_code>",
  "message": "Human-readable description.",
  "request_id": "<per-request UUID set by the middleware>"
}
```

Both `error` and `error_code` carry the same typed code (the duplicate exists for backwards compatibility). The `X-Request-ID` response header contains the same UUID.

**Typed error codes** (use `error_code` on the frontend for classification):

| `error_code`             | HTTP status | Cause                                              |
| ------------------------ | ----------- | -------------------------------------------------- |
| `fal_key_missing`        | 503         | `FAL_KEY` not configured — direct user to Settings |
| `fal_timeout`            | 504         | fal.ai call timed out — retry                      |
| `fal_rate_limited`       | 429         | fal.ai rate limit — wait and retry                 |
| `fal_error`              | 502         | Generic fal.ai error — retry                       |
| `scene_not_found`        | 404         | Scene not in cache — re-upload room photo          |
| `object_not_found`       | 404         | Object not in cache — re-upload object photo       |
| `scene_original_missing` | 409         | Original image missing from cache — re-preprocess  |
| `unsupported_media_type` | 415         | File format not accepted                           |
| `empty_file`             | 400         | Zero-byte upload                                   |
| `unauthorized`           | 401         | IPC token rejected — restart app                   |
| `internal_server_error`  | 500         | Unhandled exception                                |

## Security model

- Sidecar binds only to `127.0.0.1`. No external network exposure.
- **IPC token**: Rust generates a 128-bit random token at startup (`/dev/urandom`), passes it to the sidecar via `IPC_TOKEN` env var. All routes verify `Authorization: Bearer <token>`. Token is exposed to the frontend only via `invoke("ipc_token")` (not in the DOM or localStorage).
- **CORS**: Sidecar allows `tauri://localhost`, `http://tauri.localhost`, and `http://localhost:5173` (the Vite dev server origin, always permitted). Cross-origin browser tabs cannot access the API.
- The capability `shell:allow-execute` in `capabilities/default.json` is scoped to `interior-vision-api` with `sidecar: true`, preventing execution of arbitrary binaries.
- **Dev mode**: When `IPC_TOKEN` is not set (e.g., running `uv run uvicorn` directly), auth is skipped so the dev workflow is unaffected.

## Adding new endpoints

1. Add the FastAPI route in `apps/api/app/`.
2. Add a row to the endpoints table above.
3. Add the TypeScript wrapper to `apps/desktop/src/lib/api.ts`.
4. If the endpoint introduces new Pydantic models, run `pnpm codegen` (task 1.4) to regenerate shared types.
5. Add tests for both the Python route (pytest) and the TS wrapper (Vitest).
