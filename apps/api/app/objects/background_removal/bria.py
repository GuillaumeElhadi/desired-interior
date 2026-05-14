"""Bria background-removal driver (fal-ai/bria/remove-background)."""

from __future__ import annotations

import base64
from typing import Any

from app.cloud.fal_client import AsyncFalClient, FalMalformedResponseError
from app.objects.background_removal import ExtractionResult

_ENDPOINT = "fal-ai/bria/remove-background"


class BriaDriver:
    @property
    def backend_name(self) -> str:
        return "bria"

    async def remove(
        self,
        image_bytes: bytes,
        *,
        content_type: str,
        fal: AsyncFalClient,
    ) -> ExtractionResult:
        b64 = base64.b64encode(image_bytes).decode()
        image_url = f"data:{content_type};base64,{b64}"
        result = await fal.run(_ENDPOINT, {"image_url": image_url})
        return _parse_result(result)


def _parse_result(result: dict[str, Any]) -> ExtractionResult:
    img = result.get("image") or {}
    if not img.get("url"):
        raise FalMalformedResponseError(f"Bria response missing 'image.url': {result!r}")
    return ExtractionResult(
        url=img["url"],
        width=img.get("width", 0),
        height=img.get("height", 0),
        content_type=img.get("content_type", "image/png"),
    )
