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


# ---------------------------------------------------------------------------
# Scene preprocessing (task 2.2)
# ---------------------------------------------------------------------------


class DepthMap(BaseModel):
    url: str
    width: int
    height: int


class MaskResult(BaseModel):
    url: str
    label: str = ""
    score: float = 0.0
    area: int = 0
    bbox: list[float] = []


class SceneMetadata(BaseModel):
    dominant_surface: str
    lighting_hint: str
    light_direction: str
    color_temperature: str


class PreprocessResponse(BaseModel):
    scene_id: str
    depth_map: DepthMap
    masks: list[MaskResult]
    metadata: SceneMetadata


# ---------------------------------------------------------------------------
# Object extraction (task 2.3)
# ---------------------------------------------------------------------------


class ExtractedObject(BaseModel):
    url: str
    width: int
    height: int
    content_type: str = "image/png"


class ExtractResponse(BaseModel):
    object_id: str
    masked: ExtractedObject


# ErrorResponse is backend-internal: used by _RequestIdMiddleware to build the
# JSON 500 body. It is not registered as a FastAPI response model and therefore
# does not appear in openapi.json or packages/shared-types. The shape is
# documented in docs/IPC.md under "Error response schema".
class ErrorResponse(BaseModel):
    error: str
    message: str
    request_id: str
