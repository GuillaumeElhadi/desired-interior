import importlib.metadata
import uuid

import structlog
from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Receive, Scope, Send

from app.auth import verify_ipc_token
from app.cloud.fal_client import build_fal_client
from app.dependencies import init_fal_client
from app.logging_config import configure_logging
from app.objects.router import router as objects_router
from app.scenes.router import router as scenes_router
from app.schemas import ErrorResponse, HealthResponse, LogRequest
from app.settings import Settings

configure_logging()

_log = structlog.get_logger()

settings = Settings()
init_fal_client(build_fal_client(settings))

if settings.fal_key is None:
    _log.warning(
        "fal_key_missing",
        hint="ML endpoints will raise FalError until FAL_KEY is configured",
    )

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
app.include_router(scenes_router)
app.include_router(objects_router)


@app.get("/health", dependencies=[Depends(verify_ipc_token)])
def health() -> HealthResponse:
    try:
        version = importlib.metadata.version("interior-vision-api")
    except importlib.metadata.PackageNotFoundError:
        version = "0.0.0"
    return HealthResponse(status="ok", version=version)


@app.post("/logs", dependencies=[Depends(verify_ipc_token)])
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
