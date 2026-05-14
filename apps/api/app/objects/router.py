import structlog
from fastapi import APIRouter, Depends, File, UploadFile

from app.auth import verify_ipc_token
from app.cloud.fal_client import (
    AsyncFalClient,
    FalError,
    FalKeyMissingError,
    FalRateLimitError,
    FalTimeoutError,
)
from app.dependencies import get_bg_driver, get_fal_client
from app.exceptions import AppError
from app.objects.background_removal import BackgroundRemovalDriver
from app.objects.cache import compute_sha256, load_cached, save_cached
from app.objects.extraction import extract_object
from app.schemas import ExtractResponse

_log = structlog.get_logger()
router = APIRouter(prefix="/objects", tags=["objects"])

_ACCEPTED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}


def _fal_error_to_app_error(exc: FalError) -> AppError:
    if isinstance(exc, FalKeyMissingError):
        return AppError(
            status_code=503, error_code="fal_key_missing", message="ML service is not configured."
        )
    if isinstance(exc, FalTimeoutError):
        return AppError(status_code=504, error_code="fal_timeout", message="ML service timed out.")
    if isinstance(exc, FalRateLimitError):
        return AppError(
            status_code=429, error_code="fal_rate_limited", message="ML service rate limit reached."
        )
    return AppError(
        status_code=502, error_code="fal_error", message="ML service returned an error."
    )


@router.post("/extract", dependencies=[Depends(verify_ipc_token)])
async def extract(
    image: UploadFile = File(..., description="Object photo (JPEG / PNG / WEBP)"),
    driver: BackgroundRemovalDriver = Depends(get_bg_driver),
    fal: AsyncFalClient = Depends(get_fal_client),
) -> ExtractResponse:
    content_type = image.content_type or "image/jpeg"
    if content_type not in _ACCEPTED_TYPES:
        raise AppError(
            status_code=415,
            error_code="unsupported_media_type",
            message=f"Unsupported media type {content_type!r}. Accepted: {sorted(_ACCEPTED_TYPES)}",
        )

    image_bytes = await image.read()
    if not image_bytes:
        raise AppError(status_code=400, error_code="empty_file", message="Empty image file")

    sha256 = compute_sha256(image_bytes)
    backend = driver.backend_name
    _log.info("object_extract_request", sha256=sha256, content_type=content_type, backend=backend)

    cached = load_cached(sha256, backend=backend)
    if cached is not None:
        return ExtractResponse(**cached)

    try:
        result = await extract_object(image_bytes, content_type, driver, fal)
    except FalError as exc:
        raise _fal_error_to_app_error(exc) from exc

    response = ExtractResponse(object_id=sha256, masked=result)
    save_cached(sha256, response.model_dump(), backend=backend)
    return response
