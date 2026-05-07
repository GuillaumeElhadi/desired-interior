# ML Pipeline

> **Cloud-only in V1.** All inference runs on fal.ai. No local model loading.
> See ADR 0005 (structured logging) for why cloud was chosen over local M1 inference.

## Overview

The pipeline takes a room photo and one or more object photos and produces a
photorealistic composite. Three stages, each backed by a dedicated fal.ai model:

```
Room photo ──► Preprocessing ──► Scene metadata (depth map + segmentation)
                                         │
Object photo ─► Extraction ──────────────┤
                                         │
                            Composition ◄─┘
                                         │
                                  Result image URL
```

## Models

| Stage               | fal.ai endpoint                               | Purpose                                            |
| ------------------- | --------------------------------------------- | -------------------------------------------------- |
| Scene preprocessing | `fal-ai/imageutils/depth` (Depth Anything V2) | Depth map estimation                               |
| Scene preprocessing | `fal-ai/sam2` (SAM 2)                         | Segmentation masks                                 |
| Object extraction   | `fal-ai/birefnet/v2` (BiRefNet)               | Background removal + alpha mask                    |
| Composition         | `fal-ai/flux-pro/v1/fill` (Flux Fill Pro)     | Inpainting: place object at bbox using text prompt |

> **Note**: Flux Fill (`fal-ai/flux-pro/v1/fill`) does not accept a reference image input.
> The extracted object URL is stored for future reference-conditioning (Redux / IP-Adapter)
> when fal.ai adds that capability. For V1, the composition prompt describes the object and
> style hints.

## Request flow

```
FastAPI route
    └─► AsyncFalClient.run(endpoint, arguments)
            └─► fal_client.AsyncClient.run(...)   # SDK call, 60 s timeout
                    └─► fal.ai cloud GPU
                            └─► result dict (image URL, metadata)
```

The `AsyncFalClient` wrapper (in `app/cloud/fal_client.py`) is the **only**
entry point to the SDK. It handles:

- **Timeout**: `asyncio.timeout(settings.fal_timeout_s)`, default 60 s
- **Retry**: exponential backoff+jitter via tenacity, retries on
  `FalTimeoutError` and `FalRateLimitError`, up to `settings.fal_max_retries`
  (default 3)
- **Error normalisation**: SDK exceptions → domain exceptions
  (`FalTimeoutError`, `FalRateLimitError`, `FalMalformedResponseError`, `FalError`)

## Latency budget

| Stage               | Target p95 | Model                     |
| ------------------- | ---------- | ------------------------- |
| Scene preprocessing | ≤ 8 s      | Depth Anything V2 + SAM 2 |
| Object extraction   | ≤ 5 s      | BiRefNet v2               |
| Composition         | ≤ 15 s     | Flux Fill Pro (1024×1024) |
| **End-to-end**      | **≤ 30 s** | —                         |

Results are cached by image SHA-256 (tasks 2.2 and 2.3) so repeat calls are
served from disk in < 50 ms.

## Configuration

| Env var           | Default | Description                                    |
| ----------------- | ------- | ---------------------------------------------- |
| `FAL_KEY`         | —       | fal.ai API key — **required** for ML endpoints |
| `FAL_TIMEOUT_S`   | `60.0`  | Per-call timeout in seconds                    |
| `FAL_MAX_RETRIES` | `3`     | Max retry attempts (transient errors only)     |

Set in `.env.local` for local development (gitignored). In production (Tauri
sidecar), pass via `IPC_TOKEN`-protected environment — never hardcode.

## Adding a new model call

1. Add a new FastAPI route in `apps/api/app/` that uses `Depends(get_fal_client)`.
2. Call `await fal_client.run("fal-ai/<model>", {...})` — never import `fal_client` SDK directly.
3. Catch domain exceptions (`FalTimeoutError`, `FalRateLimitError`, etc.) and
   return appropriate HTTP error responses.
4. Add the endpoint to `docs/IPC.md` and run `pnpm codegen` if new Pydantic
   models are introduced.
5. Mock `app.cloud.fal_client._fal_sdk.AsyncClient` in tests — never make live
   calls in the unit test suite (use `@pytest.mark.live` for those).
