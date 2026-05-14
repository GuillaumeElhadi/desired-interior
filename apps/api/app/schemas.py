import re
from enum import StrEnum
from typing import Annotated, Any

from pydantic import BaseModel, Field, field_validator

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _validate_sha256(v: str) -> str:
    if not _SHA256_RE.match(v):
        raise ValueError("must be a 64-character lowercase hex SHA-256 string")
    return v


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


# ---------------------------------------------------------------------------
# Composition (task 2.4)
# ---------------------------------------------------------------------------


class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class PlacementSpec(BaseModel):
    bbox: BoundingBox
    depth_hint: float = 0.5
    rotation: float = 0.0


class StyleHints(BaseModel):
    prompt_suffix: Annotated[str, Field(max_length=300, pattern=r"^[\w\s,\.\-'\"!?()]*$")] = ""


class ComposeRequest(BaseModel):
    scene_id: str
    object_id: str
    placement: PlacementSpec
    style_hints: StyleHints = StyleHints()

    @field_validator("scene_id", "object_id")
    @classmethod
    def validate_sha256_id(cls, v: str) -> str:
        return _validate_sha256(v)


class ComposedImage(BaseModel):
    url: str
    content_type: str = "image/jpeg"


class ComposeResponse(BaseModel):
    composition_id: str
    image: ComposedImage


class PreviewComposeResponse(BaseModel):
    preview_id: str
    image: ComposedImage


# ---------------------------------------------------------------------------
# Settings (task 4.2)
# ---------------------------------------------------------------------------


class UpdateSettingsRequest(BaseModel):
    fal_key: Annotated[str | None, Field(max_length=200)] = None


class UpdateSettingsResponse(BaseModel):
    ok: bool


# ErrorResponse is backend-internal: used by _RequestIdMiddleware to build the
# JSON 500 body. It is not registered as a FastAPI response model and therefore
# does not appear in openapi.json or packages/shared-types. The shape is
# documented in docs/IPC.md under "Error response schema".
class ErrorResponse(BaseModel):
    error: str
    error_code: str
    message: str
    request_id: str
