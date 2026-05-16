import base64

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
from app.dependencies import get_fal_client
from app.exceptions import AppError
from app.scenes import cleanup_cache
from app.scenes.cache import compute_sha256, load_cached, load_original, save_cached, save_original
from app.scenes.cleanup import (
    decode_png_data_url,
    make_clean_cache_key,
    run_scene_clean,
    validate_mask,
)
from app.scenes.preprocessing import run_preprocessing
from app.schemas import CleanSceneRequest, CleanSceneResponse, PreprocessResponse
from app.settings import get_settings

_log = structlog.get_logger()
router = APIRouter(prefix="/scenes", tags=["scenes"])

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


@router.post("/preprocess", dependencies=[Depends(verify_ipc_token)])
async def preprocess(
    image: UploadFile = File(..., description="Room photo (JPEG / PNG / WEBP)"),
    fal: AsyncFalClient = Depends(get_fal_client),
) -> PreprocessResponse:
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
    _log.info("scene_preprocess_request", sha256=sha256, content_type=content_type)

    cached = load_cached(sha256)
    if cached is not None:
        return PreprocessResponse(**cached)

    try:
        result = await run_preprocessing(image_bytes, content_type, fal)
    except FalError as exc:
        raise _fal_error_to_app_error(exc) from exc

    save_original(sha256, image_bytes)
    response = PreprocessResponse(scene_id=sha256, **result)
    save_cached(sha256, response.model_dump())
    return response


@router.post("/clean", dependencies=[Depends(verify_ipc_token)])
async def clean_scene(
    body: CleanSceneRequest,
    fal: AsyncFalClient = Depends(get_fal_client),
) -> CleanSceneResponse:
    # 1. Load original scene bytes + preprocessing metadata
    scene_bytes = load_original(body.scene_id)
    if scene_bytes is None:
        raise AppError(
            status_code=404,
            error_code="scene_not_found",
            message=f"Scene {body.scene_id!r} not found in cache.",
        )
    scene_preprocess = load_cached(body.scene_id)
    if scene_preprocess is None:
        raise AppError(
            status_code=409,
            error_code="scene_preprocess_missing",
            message="Scene preprocessing result missing; re-run preprocess.",
        )

    # 2. Decode mask and compute cache key early for logging
    mask_bytes = decode_png_data_url(body.mask)
    mask_sha = compute_sha256(mask_bytes)
    backend = get_settings().scene_clean_backend
    cache_key = make_clean_cache_key(body.scene_id, mask_sha, backend)

    _log.info("scene_clean_request", scene_id=body.scene_id, backend=backend, cache_key=cache_key)

    # 3. Cache hit — skip validation and fal call
    cached = cleanup_cache.load_cached(cache_key)
    if cached is not None:
        return CleanSceneResponse(**cached)

    # 4. Validate mask before calling fal (fast 422 on bad input)
    validate_mask(
        mask_bytes,
        scene_preprocess["depth_map"]["width"],
        scene_preprocess["depth_map"]["height"],
    )

    # 5. Run pipeline
    try:
        jpeg_bytes, cleaned_scene_id = await run_scene_clean(
            scene_bytes, mask_bytes, scene_preprocess, backend, body.prompt_hint, fal
        )
    except FalError as exc:
        raise _fal_error_to_app_error(exc) from exc

    # 6. Store cleaned image in scenes cache so /compose accepts cleaned_scene_id
    save_original(cleaned_scene_id, jpeg_bytes)
    cleaned_preprocess = {**scene_preprocess, "scene_id": cleaned_scene_id}
    save_cached(cleaned_scene_id, cleaned_preprocess)

    # 7. Build response and persist in cleanup cache
    cleaned_url = "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode()
    response = CleanSceneResponse(
        cleaned_scene_id=cleaned_scene_id,
        cleaned_url=cleaned_url,
        content_type="image/jpeg",
    )
    cleanup_cache.save_cached(cache_key, response.model_dump(), jpeg_bytes)
    return response
