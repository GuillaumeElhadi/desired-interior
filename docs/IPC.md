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

| Method | Path                 | Description                | Request body                          | Response body / status      |
| ------ | -------------------- | -------------------------- | ------------------------------------- | --------------------------- |
| `GET`  | `/health`            | Liveness probe             | —                                     | `HealthResponse` (JSON)     |
| `POST` | `/logs`              | Receive frontend logs      | `LogRequest` (JSON)                   | `204 No Content`            |
| `POST` | `/scenes/preprocess` | Scene depth + segmentation | `multipart/form-data` — field `image` | `PreprocessResponse` (JSON) |
| `POST` | `/objects/extract`   | Object background removal  | `multipart/form-data` — field `image` | `ExtractResponse` (JSON)    |

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

### Error response schema

All unhandled exceptions return a structured JSON body:

```json
{
  "error": "internal_server_error",
  "message": "An unexpected error occurred.",
  "request_id": "<per-request UUID set by the middleware>"
}
```

The `X-Request-ID` response header contains the same UUID.

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
