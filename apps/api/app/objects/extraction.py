"""Object extraction via BiRefNet on fal.ai + parallel object-type classification.

BiRefNet (fal-ai/birefnet/v2) removes the background and produces a
PNG with a clean alpha channel in a single call.

In parallel, a lightweight vision model classifies the object as
"wall" (paintings, frames, mirrors) or "floor" (furniture, plants).
The classification is best-effort: failures fall back to "floor".
"""

import asyncio
import base64
from typing import Any

import structlog

from app.cloud.fal_client import AsyncFalClient, FalError

_log = structlog.get_logger()

_BIREFNET_ENDPOINT = "fal-ai/birefnet/v2"
_MOONDREAM_ENDPOINT = "fal-ai/moondream2/visual-query"

_CLASSIFY_PROMPT = (
    "Is this object typically hung on a wall (like a painting, frame, mirror) "
    "or placed on the floor (like furniture, a plant, a lamp)? "
    "Answer with one word only: 'wall' or 'floor'."
)


async def extract_object(
    image_bytes: bytes,
    content_type: str,
    fal: AsyncFalClient,
) -> dict[str, Any]:
    b64 = base64.b64encode(image_bytes).decode()
    image_url = f"data:{content_type};base64,{b64}"

    _log.info("object_extract_start", size_bytes=len(image_bytes))

    # Run BiRefNet + classification in parallel — no added latency
    birefnet_result, object_type = await asyncio.gather(
        fal.run(
            _BIREFNET_ENDPOINT,
            {
                "image_url": image_url,
                "output_format": "png",
                "refine_foreground": True,
            },
        ),
        _classify_object_type(image_url, fal),
    )

    parsed = _parse_result(birefnet_result)
    parsed["object_type"] = object_type
    _log.info("object_extract_done", url=parsed["url"], object_type=object_type)
    return parsed


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


def _parse_result(result: dict[str, Any]) -> dict[str, Any]:
    img = result.get("image") or {}
    return {
        "url": img.get("url", ""),
        "width": img.get("width", 0),
        "height": img.get("height", 0),
        "content_type": img.get("content_type", "image/png"),
    }
