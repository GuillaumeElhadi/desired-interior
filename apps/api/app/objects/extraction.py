"""Object extraction via BiRefNet on fal.ai.

BiRefNet (fal-ai/birefnet/v2) removes the background and produces a
PNG with a clean alpha channel in a single call — no separate
alpha-matting step required.
"""

import base64
from typing import Any

import structlog

from app.cloud.fal_client import AsyncFalClient

_log = structlog.get_logger()

_BIREFNET_ENDPOINT = "fal-ai/birefnet/v2"


async def extract_object(
    image_bytes: bytes,
    content_type: str,
    fal: AsyncFalClient,
) -> dict[str, Any]:
    b64 = base64.b64encode(image_bytes).decode()
    image_url = f"data:{content_type};base64,{b64}"

    _log.info("object_extract_start", size_bytes=len(image_bytes))

    result = await fal.run(
        _BIREFNET_ENDPOINT,
        {
            "image_url": image_url,
            "output_format": "png",
            "refine_foreground": True,
        },
    )

    parsed = _parse_result(result)
    _log.info("object_extract_done", url=parsed["url"])
    return parsed


def _parse_result(result: dict[str, Any]) -> dict[str, Any]:
    img = result.get("image") or {}
    return {
        "url": img.get("url", ""),
        "width": img.get("width", 0),
        "height": img.get("height", 0),
        "content_type": img.get("content_type", "image/png"),
    }
