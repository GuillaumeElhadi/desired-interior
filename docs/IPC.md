# IPC Contract — Tauri ↔ Python Sidecar

## Overview

The Tauri desktop shell communicates with the Python FastAPI sidecar over HTTP on `127.0.0.1` using a randomly assigned port. All traffic stays on the loopback interface — nothing leaves the machine.

## Sidecar lifecycle

| Event                     | Behavior                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App starts (`setup()`)    | Rust binds an ephemeral port via `TcpListener::bind("127.0.0.1:0")`, spawns the sidecar with `--host 127.0.0.1 --port <N>`, stores `http://127.0.0.1:<N>` in `ApiState` |
| `RunEvent::ExitRequested` | Rust calls `CommandChild::kill()` on the stored handle                                                                                                                  |
| Sidecar crash             | `CommandChild` handle becomes invalid; frontend HTTP calls fail with a network error (surfaced as an error state in the UI)                                             |

## Tauri command

```
api_base_url() → Result<String, String>
```

- **Rust definition:** `apps/desktop/src-tauri/src/lib.rs`
- **JS binding:** `invoke("api_base_url")` via `@tauri-apps/api/core`
- **Frontend wrapper:** `getApiBaseUrl()` in `apps/desktop/src/lib/api.ts`
- **Returns:** `"http://127.0.0.1:<port>"` where `<port>` is the ephemeral port chosen at startup
- **Error:** Returns `Err("sidecar not yet started")` if called before `setup()` completes (should not happen in normal flow)

## HTTP endpoints

| Method | Path      | Description    | Response body                          |
| ------ | --------- | -------------- | -------------------------------------- |
| `GET`  | `/health` | Liveness probe | `{"status": "ok", "version": "x.y.z"}` |

All endpoints accept and return `application/json`. New endpoints added in `apps/api/app/` must be documented here and wrapped in `apps/desktop/src/lib/api.ts`.

## Security model

- Sidecar binds only to `127.0.0.1`. No external network exposure.
- No authentication on the sidecar HTTP API — loopback binding is the security boundary.
- The Tauri webview origin is `tauri://localhost`, not a browser HTTP origin, so standard CORS does not apply.
- The capability `shell:allow-execute` in `capabilities/default.json` is scoped to `interior-vision-api` with `sidecar: true`, preventing execution of arbitrary binaries.

## Adding new endpoints

1. Add the FastAPI route in `apps/api/app/`.
2. Add a row to the endpoints table above.
3. Add the TypeScript wrapper to `apps/desktop/src/lib/api.ts`.
4. If the endpoint introduces new Pydantic models, run `pnpm codegen` (task 1.4) to regenerate shared types.
5. Add tests for both the Python route (pytest) and the TS wrapper (Vitest).
