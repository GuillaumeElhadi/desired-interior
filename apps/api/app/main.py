import importlib.metadata
import os
import uuid

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Receive, Scope, Send

from app.logging_config import configure_logging
from app.schemas import ErrorResponse, HealthResponse, LogRequest

configure_logging()

_log = structlog.get_logger()

app = FastAPI(title="Interior Vision API")

# tauri://localhost — production webview origin
# http://tauri.localhost — alternate production origin (Windows/Linux)
# http://localhost:5173 — Vite dev server origin (pnpm tauri dev)
# The IPC token is the real auth boundary; allowing loopback origins is safe.
_ALLOWED_ORIGINS = [
    "tauri://localhost",
    "http://tauri.localhost",
    "http://localhost:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_LEVEL_FN: dict[str, str] = {
    "debug": "debug",
    "info": "info",
    "warn": "warning",
    "error": "error",
}


class _RequestIdMiddleware:
    """Pure-ASGI middleware: stamps every response with X-Request-ID and catches
    unhandled exceptions to return a structured JSON 500 rather than a bare crash.

    Catches at this layer (outside ExceptionMiddleware) so the response is fully
    sent before the call stack unwinds — Starlette's ServerErrorMiddleware would
    otherwise re-raise after calling any app-level exception handler, causing the
    ASGI transport to propagate the exception to the caller.
    """

    def __init__(self, inner: ASGIApp) -> None:
        self._inner = inner

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._inner(scope, receive, send)
            return

        request_id = str(uuid.uuid4())
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)

        response_started = False

        async def _send_with_id(message: dict) -> None:  # type: ignore[type-arg]
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                MutableHeaders(scope=message).append("X-Request-ID", request_id)
            await send(message)

        try:
            await self._inner(scope, receive, _send_with_id)
        except Exception as exc:
            if response_started:
                raise  # can't send a new response; let it propagate
            request = Request(scope)
            _log.error("unhandled_exception", exc_info=exc, path=str(request.url.path))
            error_body = ErrorResponse(
                error="internal_server_error",
                message="An unexpected error occurred.",
                request_id=request_id,
            ).model_dump()
            resp = JSONResponse(status_code=500, content=error_body)
            resp.headers["X-Request-ID"] = request_id
            await resp(scope, receive, send)


app.add_middleware(_RequestIdMiddleware)


async def _verify_ipc_token(authorization: str | None = Header(default=None)) -> None:
    token = os.environ.get("IPC_TOKEN")
    if token is None:
        return  # dev mode: IPC_TOKEN not set, auth skipped
    if authorization is None or authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="invalid IPC token")


@app.get("/health", dependencies=[Depends(_verify_ipc_token)])
def health() -> HealthResponse:
    try:
        version = importlib.metadata.version("interior-vision-api")
    except importlib.metadata.PackageNotFoundError:
        version = "0.0.0"
    return HealthResponse(status="ok", version=version)


@app.post("/logs", dependencies=[Depends(_verify_ipc_token)])
async def receive_logs(body: LogRequest) -> Response:
    for entry in body.entries:
        bound = _log.bind(
            correlation_id=entry.correlation_id,
            source="frontend",
            **entry.context,
        )
        log_fn = getattr(bound, _LEVEL_FN.get(entry.level, "info"))
        log_fn(entry.message, frontend_ts=entry.timestamp)
    return Response(status_code=204)
