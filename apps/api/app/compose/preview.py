"""Fast preview composition — delegates to run_composition.

With PIL-based compositing there is no longer a quality/speed trade-off
between preview and final render: both produce the same faithful composite
locally without a fal.ai round-trip, so the same function serves both.
"""

from typing import Any

from app.cloud.fal_client import AsyncFalClient
from app.compose.composition import run_composition
from app.schemas import PlacementSpec, StyleHints


async def run_preview(
    scene_image_bytes: bytes,
    scene_content_type: str,
    object_url: str,
    placement: PlacementSpec,
    style_hints: StyleHints,
    fal: AsyncFalClient,
    surface_type: str = "floor",
) -> dict[str, Any]:
    return await run_composition(
        scene_image_bytes=scene_image_bytes,
        scene_content_type=scene_content_type,
        object_url=object_url,
        placement=placement,
        style_hints=style_hints,
        fal=fal,
        surface_type=surface_type,
    )
