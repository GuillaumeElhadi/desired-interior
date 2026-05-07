import structlog
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.auth import verify_ipc_token
from app.cloud.fal_client import AsyncFalClient, FalError, FalRateLimitError, FalTimeoutError
from app.dependencies import get_fal_client
from app.objects.cache import compute_sha256, load_cached, save_cached
from app.objects.extraction import extract_object
from app.schemas import ExtractResponse

_log = structlog.get_logger()
router = APIRouter(prefix="/objects", tags=["objects"])

_ACCEPTED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}


@router.post("/extract", dependencies=[Depends(verify_ipc_token)])
async def extract(
    image: UploadFile = File(..., description="Object photo (JPEG / PNG / WEBP)"),
    fal: AsyncFalClient = Depends(get_fal_client),
) -> ExtractResponse:
    content_type = image.content_type or "image/jpeg"
    if content_type not in _ACCEPTED_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported media type {content_type!r}. Accepted: {sorted(_ACCEPTED_TYPES)}",
        )

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image file")

    sha256 = compute_sha256(image_bytes)
    _log.info("object_extract_request", sha256=sha256, content_type=content_type)

    cached = load_cached(sha256)
    if cached is not None:
        return ExtractResponse(**cached)

    try:
        result = await extract_object(image_bytes, content_type, fal)
    except FalTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except FalRateLimitError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except FalError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    response = ExtractResponse(object_id=sha256, masked=result)
    save_cached(sha256, response.model_dump())
    return response
