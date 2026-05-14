"""BiRefNet background-removal driver (fal-ai/birefnet/v2)."""

from __future__ import annotations

import base64
from typing import Any

from app.cloud.fal_client import AsyncFalClient
from app.objects.background_removal import ExtractionResult

_ENDPOINT = "fal-ai/birefnet/v2"


class BiRefNetDriver:
    @property
    def backend_name(self) -> str:
        return "birefnet"

    async def remove(
        self,
        image_bytes: bytes,
        *,
        content_type: str,
        fal: AsyncFalClient,
    ) -> ExtractionResult:
        b64 = base64.b64encode(image_bytes).decode()
        image_url = f"data:{content_type};base64,{b64}"
        result = await fal.run(
            _ENDPOINT,
            {
                "image_url": image_url,
                "output_format": "png",
                "refine_foreground": True,
            },
        )
        return _parse_result(result)


def _parse_result(result: dict[str, Any]) -> ExtractionResult:
    img = result.get("image") or {}
    return ExtractionResult(
        url=img.get("url", ""),
        width=img.get("width", 0),
        height=img.get("height", 0),
        content_type=img.get("content_type", "image/png"),
    )
