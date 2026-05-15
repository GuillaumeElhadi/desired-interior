import structlog
from fastapi import APIRouter, Depends

from app.auth import verify_ipc_token
from app.cloud.fal_client import (
    AsyncFalClient,
    FalError,
    FalKeyMissingError,
    FalRateLimitError,
    FalTimeoutError,
)
from app.compose import harmonize_cache
from app.compose import preview_cache as preview_cache_module
from app.compose.cache import load_cached, save_cached
from app.compose.composition import make_cache_key, run_composition
from app.compose.harmonize import make_harmonize_cache_key, run_harmonize
from app.compose.preview import run_preview
from app.dependencies import get_fal_client
from app.exceptions import AppError
from app.objects.cache import load_cached as load_object
from app.scenes.cache import load_cached as load_scene
from app.scenes.cache import load_original
from app.schemas import (
    ComposedImage,
    ComposeRequest,
    ComposeResponse,
    HarmonizeRequest,
    HarmonizeResponse,
    PreviewComposeResponse,
)
from app.settings import get_settings

_log = structlog.get_logger()
router = APIRouter(prefix="/compose", tags=["compose"])


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


@router.post("", dependencies=[Depends(verify_ipc_token)])
async def compose(
    body: ComposeRequest,
    fal: AsyncFalClient = Depends(get_fal_client),
) -> ComposeResponse:
    scene_data = load_scene(body.scene_id)
    if scene_data is None:
        raise AppError(
            status_code=404,
            error_code="scene_not_found",
            message="Scene not found — re-upload the room photo.",
        )

    object_data = load_object(body.object_id)
    if object_data is None:
        raise AppError(
            status_code=404,
            error_code="object_not_found",
            message="Object not found — re-upload the furniture photo.",
        )

    scene_image_bytes = load_original(body.scene_id)
    if scene_image_bytes is None:
        raise AppError(
            status_code=409,
            error_code="scene_original_missing",
            message=(
                f"Original image for scene {body.scene_id!r} is not cached. "
                "Re-run /scenes/preprocess to rebuild the cache."
            ),
        )

    masked = object_data.get("masked") or {}
    object_url: str = masked.get("url", "")
    surface_type: str = masked.get("object_type", "floor")
    depth_map_url: str = (scene_data.get("depth_map") or {}).get("url", "")
    cache_key = make_cache_key(
        body.scene_id, body.object_id, body.placement, body.style_hints, surface_type
    )
    _log.info(
        "compose_request",
        scene_id=body.scene_id,
        object_id=body.object_id,
        cache_key=cache_key,
        surface_type=surface_type,
    )

    cached = load_cached(cache_key)
    if cached is not None:
        if "mask_url" in cached:
            return ComposeResponse(**cached)
        # Pre-task-5.3 cache entry is missing the new fields — discard and re-run
        _log.info("compose_cache_stale", cache_key=cache_key)

    scene_content_type = "image/jpeg"

    try:
        result = await run_composition(
            scene_image_bytes=scene_image_bytes,
            scene_content_type=scene_content_type,
            object_url=object_url,
            placement=body.placement,
            style_hints=body.style_hints,
            fal=fal,
            surface_type=surface_type,
        )
    except FalError as exc:
        raise _fal_error_to_app_error(exc) from exc

    response = ComposeResponse(
        composition_id=cache_key,
        image=ComposedImage(url=result["url"], content_type=result["content_type"]),
        composite_url=result["url"],
        mask_url=result["mask_url"],
        depth_map_url=depth_map_url,
    )
    save_cached(cache_key, response.model_dump())
    return response


@router.post("/preview", dependencies=[Depends(verify_ipc_token)])
async def compose_preview(
    body: ComposeRequest,
    fal: AsyncFalClient = Depends(get_fal_client),
) -> PreviewComposeResponse:
    scene_data = load_scene(body.scene_id)
    if scene_data is None:
        raise AppError(
            status_code=404,
            error_code="scene_not_found",
            message="Scene not found — re-upload the room photo.",
        )

    object_data = load_object(body.object_id)
    if object_data is None:
        raise AppError(
            status_code=404,
            error_code="object_not_found",
            message="Object not found — re-upload the furniture photo.",
        )

    scene_image_bytes = load_original(body.scene_id)
    if scene_image_bytes is None:
        raise AppError(
            status_code=409,
            error_code="scene_original_missing",
            message=(
                f"Original image for scene {body.scene_id!r} is not cached. "
                "Re-run /scenes/preprocess to rebuild the cache."
            ),
        )

    masked = object_data.get("masked") or {}
    object_url: str = masked.get("url", "")
    surface_type: str = masked.get("object_type", "floor")
    cache_key = make_cache_key(
        body.scene_id, body.object_id, body.placement, body.style_hints, surface_type
    )
    _log.info(
        "preview_request",
        scene_id=body.scene_id,
        object_id=body.object_id,
        cache_key=cache_key,
        surface_type=surface_type,
    )

    cached = preview_cache_module.load_cached(cache_key)
    if cached is not None:
        return PreviewComposeResponse(**cached)

    scene_content_type = "image/jpeg"

    try:
        result = await run_preview(
            scene_image_bytes=scene_image_bytes,
            scene_content_type=scene_content_type,
            object_url=object_url,
            placement=body.placement,
            style_hints=body.style_hints,
            fal=fal,
            surface_type=surface_type,
        )
    except FalError as exc:
        raise _fal_error_to_app_error(exc) from exc

    response = PreviewComposeResponse(
        preview_id=cache_key,
        image=ComposedImage(url=result["url"], content_type=result["content_type"]),
    )
    preview_cache_module.save_cached(cache_key, response.model_dump())
    return response


@router.post("/harmonize", dependencies=[Depends(verify_ipc_token)])
async def harmonize(
    body: HarmonizeRequest,
    fal: AsyncFalClient = Depends(get_fal_client),
) -> HarmonizeResponse:
    scene_data = load_scene(body.scene_id)
    if scene_data is None:
        raise AppError(
            status_code=404,
            error_code="scene_not_found",
            message="Scene not found — re-upload the room photo.",
        )

    scene_image_bytes = load_original(body.scene_id)
    if scene_image_bytes is None:
        raise AppError(
            status_code=409,
            error_code="scene_original_missing",
            message=(
                f"Original image for scene {body.scene_id!r} is not cached. "
                "Re-run /scenes/preprocess to rebuild the cache."
            ),
        )

    depth_map_url: str = (scene_data.get("depth_map") or {}).get("url", "")

    objects = []
    for op in body.objects:
        object_data = load_object(op.object_id)
        if object_data is None:
            raise AppError(
                status_code=404,
                error_code="object_not_found",
                message=f"Object {op.object_id!r} not found — re-upload the furniture photo.",
            )
        masked = object_data.get("masked") or {}
        objects.append((masked.get("url", ""), masked.get("object_type", "floor"), op.placement))

    backend = get_settings().harmonizer_backend
    cache_key = make_harmonize_cache_key(
        body.scene_id, body.objects, backend, body.harmonize_strength, body.seed
    )
    _log.info(
        "harmonize_request",
        scene_id=body.scene_id,
        num_objects=len(body.objects),
        backend=backend,
        strength=body.harmonize_strength,
        cache_key=cache_key,
    )

    cached = harmonize_cache.load_cached(cache_key)
    if cached is not None:
        return HarmonizeResponse(**cached)

    try:
        result = await run_harmonize(
            scene_image_bytes=scene_image_bytes,
            depth_map_url=depth_map_url,
            objects=objects,
            harmonize_strength=body.harmonize_strength,
            seed=body.seed,
            fal=fal,
            backend=backend,
        )
    except FalError as exc:
        raise _fal_error_to_app_error(exc) from exc

    response = HarmonizeResponse(
        harmonize_id=cache_key,
        image=ComposedImage(url=result["url"], content_type=result["content_type"]),
    )
    harmonize_cache.save_cached(cache_key, response.model_dump())
    return response
