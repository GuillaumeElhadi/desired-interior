"""Fast preview composition via fal-ai/flux-lora/inpainting at 4 inference steps.

Reuses mask, prompt, and result-parsing helpers from composition.py.
The only difference from the final render is num_inference_steps=4 (~1-2 s).
"""

import base64
from typing import Any

import structlog

from app.cloud.fal_client import AsyncFalClient
from app.compose.composition import (
    _build_placement_mask,
    _build_prompt,
    _parse_result,
)
from app.schemas import PlacementSpec, StyleHints

_log = structlog.get_logger()

_FLUX_LORA_INPAINTING_ENDPOINT = "fal-ai/flux-lora/inpainting"
_PREVIEW_STEPS = 4


async def run_preview(
    scene_image_bytes: bytes,
    scene_content_type: str,
    object_url: str,
    placement: PlacementSpec,
    style_hints: StyleHints,
    fal: AsyncFalClient,
) -> dict[str, Any]:
    scene_b64 = base64.b64encode(scene_image_bytes).decode()
    scene_data_url = f"data:{scene_content_type};base64,{scene_b64}"

    mask_bytes = _build_placement_mask(scene_image_bytes, placement)
    mask_b64 = base64.b64encode(mask_bytes).decode()
    mask_data_url = f"data:image/png;base64,{mask_b64}"

    prompt = _build_prompt(style_hints)

    _log.info(
        "preview_start",
        object_url=object_url,
        steps=_PREVIEW_STEPS,
        bbox_x=placement.bbox.x,
        bbox_y=placement.bbox.y,
    )

    result = await fal.run(
        _FLUX_LORA_INPAINTING_ENDPOINT,
        {
            "image_url": scene_data_url,
            "mask_url": mask_data_url,
            "prompt": prompt,
            "num_inference_steps": _PREVIEW_STEPS,
        },
    )

    parsed = _parse_result(result)
    _log.info("preview_done", url=parsed["url"])
    return parsed
