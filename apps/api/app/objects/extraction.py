"""Object extraction via a pluggable BackgroundRemovalDriver + parallel object-type classification.

The driver (BiRefNet or Bria) removes the background and produces a PNG with a
clean alpha channel. In parallel, Moondream classifies the object as "wall" or
"floor". Classification is best-effort: failures fall back to "floor".
"""

import asyncio
import base64
from typing import Any

import structlog

from app.cloud.fal_client import AsyncFalClient, FalError
from app.objects.background_removal import BackgroundRemovalDriver

_log = structlog.get_logger()

_MOONDREAM_ENDPOINT = "fal-ai/moondream2/visual-query"

_CLASSIFY_PROMPT = (
    "Is this object typically hung on a wall (like a painting, frame, mirror) "
    "or placed on the floor (like furniture, a plant, a lamp)? "
    "Answer with one word only: 'wall' or 'floor'."
)


async def extract_object(
    image_bytes: bytes,
    content_type: str,
    driver: BackgroundRemovalDriver,
    fal: AsyncFalClient,
) -> dict[str, Any]:
    b64 = base64.b64encode(image_bytes).decode()
    image_url = f"data:{content_type};base64,{b64}"

    _log.info("object_extract_start", size_bytes=len(image_bytes), backend=driver.backend_name)

    # Run background removal + classification in parallel — no added latency
    bg_result, object_type = await asyncio.gather(
        driver.remove(image_bytes, content_type=content_type, fal=fal),
        _classify_object_type(image_url, fal),
    )

    result = {
        "url": bg_result.url,
        "width": bg_result.width,
        "height": bg_result.height,
        "content_type": bg_result.content_type,
        "object_type": object_type,
    }
    _log.info("object_extract_done", url=result["url"], object_type=object_type)
    return result


async def _classify_object_type(image_url: str, fal: AsyncFalClient) -> str:
    """Classify the object as 'wall' or 'floor'. Falls back to 'floor' on error."""
    try:
        result = await fal.run(
            _MOONDREAM_ENDPOINT,
            {
                "image_url": image_url,
                "prompt": _CLASSIFY_PROMPT,
            },
        )
        answer = str(result.get("output", "")).strip().lower()
        if "wall" in answer:
            return "wall"
        return "floor"
    except FalError as exc:
        _log.warning("object_classification_failed", error=str(exc))
        return "floor"
