import structlog
from fastapi import APIRouter, Depends, HTTPException

from app.auth import verify_ipc_token
from app.cloud.fal_client import AsyncFalClient, FalError, FalRateLimitError, FalTimeoutError
from app.compose.cache import load_cached, save_cached
from app.compose.composition import make_cache_key, run_composition
from app.dependencies import get_fal_client
from app.objects.cache import load_cached as load_object
from app.scenes.cache import load_cached as load_scene
from app.scenes.cache import load_original
from app.schemas import ComposedImage, ComposeRequest, ComposeResponse

_log = structlog.get_logger()
router = APIRouter(prefix="/compose", tags=["compose"])


@router.post("", dependencies=[Depends(verify_ipc_token)])
async def compose(
    body: ComposeRequest,
    fal: AsyncFalClient = Depends(get_fal_client),
) -> ComposeResponse:
    scene_data = load_scene(body.scene_id)
    if scene_data is None:
        raise HTTPException(status_code=404, detail=f"Scene {body.scene_id!r} not found in cache")

    object_data = load_object(body.object_id)
    if object_data is None:
        raise HTTPException(status_code=404, detail=f"Object {body.object_id!r} not found in cache")

    scene_image_bytes = load_original(body.scene_id)
    if scene_image_bytes is None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Original image for scene {body.scene_id!r} is not cached. "
                "Re-run /scenes/preprocess to rebuild the cache."
            ),
        )

    object_url: str = (object_data.get("masked") or {}).get("url", "")
    cache_key = make_cache_key(body.scene_id, body.object_id, body.placement, body.style_hints)
    _log.info(
        "compose_request",
        scene_id=body.scene_id,
        object_id=body.object_id,
        cache_key=cache_key,
    )

    cached = load_cached(cache_key)
    if cached is not None:
        return ComposeResponse(**cached)

    # Detect original content type from cached scene metadata (depth_map content_type
    # is not stored, so fall back to JPEG which is the most common upload format).
    scene_content_type = "image/jpeg"

    try:
        result = await run_composition(
            scene_image_bytes=scene_image_bytes,
            scene_content_type=scene_content_type,
            object_url=object_url,
            placement=body.placement,
            style_hints=body.style_hints,
            fal=fal,
        )
    except FalTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except FalRateLimitError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except FalError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    response = ComposeResponse(
        composition_id=cache_key,
        image=ComposedImage(url=result["url"], content_type=result["content_type"]),
    )
    save_cached(cache_key, response.model_dump())
    return response
