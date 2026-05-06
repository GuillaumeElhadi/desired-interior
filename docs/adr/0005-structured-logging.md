# ADR 0005 — Structured logging with structlog

**Date:** 2026-05-06
**Status:** Accepted

## Context

The app consists of two separate runtimes: a Tauri/React frontend and a Python FastAPI sidecar. Both need observable log output. Without a consistent logging strategy:

- Errors in the Python sidecar produce bare `traceback` text with no machine-readable fields, making log aggregation and alerting difficult once the product is in real use.
- The frontend has no way to send diagnostic information to the sidecar, so crashes are invisible unless the user has DevTools open.
- There is no correlation between a frontend-initiated action and the backend log lines it produces.

## Decision

Use **structlog** (`>=25.1`) as the sole logging library for the Python sidecar:

- **JSON renderer in production** (when `IPC_TOKEN` is set — i.e., when launched by Tauri): every log line is a self-contained JSON object with `event`, `level`, `timestamp`, `request_id`, and arbitrary structured fields. This is ready for forwarding to any log aggregator.
- **ConsoleRenderer in dev** (when `IPC_TOKEN` is absent — i.e., when running `uv run uvicorn` directly): coloured, human-readable output for fast iteration.
- Detection is via `os.environ.get("IPC_TOKEN")`, the same env var already used to gate auth. No new configuration surface.

Add a **`POST /logs` endpoint** on the sidecar. The frontend generates a session-scoped UUID (`correlationId`) using `crypto.randomUUID()` at startup and sends it with every log entry. The backend echoes it into structlog's context for that request, linking frontend events to backend log lines.

Add a **`_RequestIdMiddleware`** (pure ASGI, not `BaseHTTPMiddleware`) that stamps every response with `X-Request-ID` and catches unhandled exceptions to return a structured JSON 500 instead of a bare crash.

## Alternatives considered

| Alternative                                               | Rejected because                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Python stdlib `logging`                                   | No structured fields without third-party formatters; awkward async integration                                                   |
| `loguru`                                                  | Good API but no native contextvars support; structlog's processor pipeline is more composable                                    |
| OpenTelemetry                                             | Correct for distributed tracing but significantly heavier; overkill for a single-machine desktop app in V1                       |
| Forwarding frontend logs over Tauri IPC (instead of HTTP) | Would bypass the FastAPI layer and make logs inconsistent with backend request logs; HTTP keeps the correlation contract uniform |

## Consequences

- `structlog>=25.1` is a production dependency of `apps/api`. It has no native extensions and adds ~1 MB to the PyInstaller bundle.
- Frontend log shipping is fire-and-forget: failures are silently swallowed in `logger.ts` to prevent logging errors from affecting the UI.
- The `POST /logs` endpoint is protected by the IPC token (same as all other routes). Sidecar-free dev mode (`IPC_TOKEN` unset) skips auth, consistent with ADR 0003.
- When the hex-layer split happens (`app/domain/`, `app/infrastructure/`), `logging_config.py` should move to `app/infrastructure/` — it performs I/O (writes to stderr) and reads from the environment.
