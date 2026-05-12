"""Object composition via Flux Fill on fal.ai.

Pipeline:
  1. Build a binary placement mask (white rectangle on black canvas) from the
     bbox in PlacementSpec.
  2. Call fal-ai/flux-pro/v1/fill with the scene image, placement mask, and a
     prompt derived from style_hints.

Reference-image conditioning (Redux / IP-Adapter) is not yet supported by
the fal-ai/flux-pro/v1/fill endpoint. The object_url is currently unused but
accepted for future use when reference conditioning becomes available.
"""

import base64
import hashlib
import io
from typing import Any

import structlog
from PIL import Image, ImageDraw

from app.cloud.fal_client import AsyncFalClient
from app.schemas import PlacementSpec, StyleHints

_log = structlog.get_logger()

_FLUX_LORA_INPAINTING_ENDPOINT = "fal-ai/flux-lora/inpainting"
_FINAL_STEPS = 28

_DEFAULT_PROMPT = (
    "Photorealistic furniture piece placed in the room, matching perspective, "
    "lighting, and shadow of the surrounding environment."
)


def make_cache_key(
    scene_id: str, object_id: str, placement: PlacementSpec, style_hints: StyleHints
) -> str:
    """Stable cache key that captures all inputs that affect the output."""
    bbox = placement.bbox
    parts = (
        f"{scene_id}:{object_id}:"
        f"{bbox.x:.4f},{bbox.y:.4f},{bbox.width:.4f},{bbox.height:.4f}:"
        f"{placement.depth_hint:.4f}:"
        f"{style_hints.prompt_suffix}"
    )
    return hashlib.sha256(parts.encode()).hexdigest()


async def run_composition(
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
        "composition_start",
        object_url=object_url,
        bbox_x=placement.bbox.x,
        bbox_y=placement.bbox.y,
        bbox_w=placement.bbox.width,
        bbox_h=placement.bbox.height,
    )

    result = await fal.run(
        _FLUX_LORA_INPAINTING_ENDPOINT,
        {
            "image_url": scene_data_url,
            "mask_url": mask_data_url,
            "prompt": prompt,
            "num_inference_steps": _FINAL_STEPS,
        },
    )

    parsed = _parse_result(result)
    _log.info("composition_done", url=parsed["url"])
    return parsed


def _build_placement_mask(scene_image_bytes: bytes, placement: PlacementSpec) -> bytes:
    """Return a PNG mask: white rectangle at the placement bbox, black elsewhere."""
    with Image.open(io.BytesIO(scene_image_bytes)) as img:
        w, h = img.size

    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)

    bbox = placement.bbox
    x0 = int(bbox.x)
    y0 = int(bbox.y)
    x1 = int(bbox.x + bbox.width)
    y1 = int(bbox.y + bbox.height)

    x0, x1 = max(0, x0), min(w, x1)
    y0, y1 = max(0, y0), min(h, y1)

    draw.rectangle([x0, y0, x1, y1], fill=255)

    buf = io.BytesIO()
    mask.save(buf, format="PNG")
    return buf.getvalue()


def _build_prompt(style_hints: StyleHints) -> str:
    parts = [_DEFAULT_PROMPT]
    if style_hints.prompt_suffix:
        parts.append(style_hints.prompt_suffix)
    return " ".join(parts)


def _parse_result(result: dict[str, Any]) -> dict[str, Any]:
    images = result.get("images") or []
    first = images[0] if images else {}
    return {
        "url": first.get("url", ""),
        "content_type": first.get("content_type", "image/jpeg"),
    }
