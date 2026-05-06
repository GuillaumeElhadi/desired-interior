from enum import StrEnum
from typing import Any

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    version: str


class LogLevel(StrEnum):
    DEBUG = "debug"
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


class LogEntry(BaseModel):
    level: LogLevel
    message: str
    correlation_id: str
    timestamp: str
    context: dict[str, Any] = {}


class LogRequest(BaseModel):
    entries: list[LogEntry]


# ErrorResponse is backend-internal: used by _RequestIdMiddleware to build the
# JSON 500 body. It is not registered as a FastAPI response model and therefore
# does not appear in openapi.json or packages/shared-types. The shape is
# documented in docs/IPC.md under "Error response schema".
class ErrorResponse(BaseModel):
    error: str
    message: str
    request_id: str
