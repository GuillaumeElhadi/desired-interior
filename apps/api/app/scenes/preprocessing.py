"""Scene preprocessing: depth estimation + segmentation via fal.ai.

Calls fal-ai/imageutils/depth and fal-ai/sam2 in parallel.
Derives structured scene metadata from the results using Pillow.
"""

import asyncio
import base64
import io
from typing import Any

import structlog
from PIL import Image, ImageStat

from app.cloud.fal_client import AsyncFalClient

_log = structlog.get_logger()

_DEPTH_ENDPOINT = "fal-ai/imageutils/depth"
# SAM 2 in automatic/everything mode — pass image_url only, no prompts.
# Returns all detected segments. If the live API requires prompts, add a
# center-point fallback and update this constant.
_SAM2_ENDPOINT = "fal-ai/sam2"


async def run_preprocessing(
    image_bytes: bytes,
    content_type: str,
    fal: AsyncFalClient,
) -> dict[str, Any]:
    b64 = base64.b64encode(image_bytes).decode()
    image_data_url = f"data:{content_type};base64,{b64}"

    _log.info("scene_preprocess_start", size_bytes=len(image_bytes))

    depth_result, sam2_result = await asyncio.gather(
        fal.run(_DEPTH_ENDPOINT, {"image_url": image_data_url}),
        fal.run(_SAM2_ENDPOINT, {"image_url": image_data_url}),
    )

    depth_map = _extract_depth_map(depth_result)
    masks = _extract_masks(sam2_result)
    metadata = _derive_metadata(sam2_result, image_bytes)

    _log.info("scene_preprocess_done", masks_count=len(masks))

    return {"depth_map": depth_map, "masks": masks, "metadata": metadata}


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------


def _extract_depth_map(result: dict[str, Any]) -> dict[str, Any]:
    img = result.get("image") or {}
    return {
        "url": img.get("url", ""),
        "width": img.get("width", 0),
        "height": img.get("height", 0),
    }


def _extract_masks(result: dict[str, Any]) -> list[dict[str, Any]]:
    # SAM2 "everything" mode returns segments under various possible keys.
    # Handle the most common response shapes gracefully.
    raw = result.get("masks") or result.get("segments") or result.get("objects") or []
    masks = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        url = item.get("url") or item.get("mask_url") or (item.get("image") or {}).get("url", "")
        masks.append(
            {
                "url": url,
                "label": item.get("label", ""),
                "score": float(item.get("score") or item.get("predicted_iou") or 0.0),
                "area": int(item.get("area") or 0),
                "bbox": item.get("bbox") or [],
            }
        )
    return masks


# ---------------------------------------------------------------------------
# Metadata derivation
# ---------------------------------------------------------------------------


def _derive_metadata(sam2_result: dict[str, Any], image_bytes: bytes) -> dict[str, Any]:
    masks = _extract_masks(sam2_result)
    img = _load_image(image_bytes)

    dominant_surface = _estimate_surface(masks, img)
    lighting_hint, light_direction, color_temperature = _analyse_lighting(img)

    return {
        "dominant_surface": dominant_surface,
        "lighting_hint": lighting_hint,
        "light_direction": light_direction,
        "color_temperature": color_temperature,
    }


def _load_image(image_bytes: bytes) -> Image.Image:
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def _estimate_surface(masks: list[dict[str, Any]], img: Image.Image) -> str:
    """Classify dominant surface from SAM2 mask positions.

    Strategy: take the largest mask by area; classify by the centroid's
    normalised y-position (0 = top, 1 = bottom).
    """
    if not masks:
        return "unknown"

    w, h = img.size
    if w == 0 or h == 0:
        return "unknown"

    sorted_masks = sorted(masks, key=lambda m: m.get("area") or 0, reverse=True)

    for mask in sorted_masks[:5]:
        bbox = mask.get("bbox") or []
        if len(bbox) < 4:
            continue
        # bbox may be [x, y, width, height] or [x1, y1, x2, y2]
        # Detect by checking if bbox[2] > bbox[0] (x2 > x1 → xyxy format)
        if bbox[2] > w:
            # Likely [x, y, w, h] format
            y_center = (bbox[1] + bbox[3] / 2) / h
        else:
            y_center = (bbox[1] + bbox[3]) / 2 / h

        if y_center > 0.65:
            return "floor"
        elif y_center < 0.25:
            return "ceiling"
        else:
            return "wall"

    return "mixed"


def _analyse_lighting(img: Image.Image) -> tuple[str, str, str]:
    """Return (lighting_hint, light_direction, color_temperature) via Pillow.

    Uses ImageStat on a 64×64 thumbnail for fast analysis (< 1 ms).
    """
    thumb = img.resize((64, 64), Image.Resampling.LANCZOS)
    stat = ImageStat.Stat(thumb)
    r_mean, g_mean, b_mean = stat.mean[:3]
    luminance = 0.299 * r_mean + 0.587 * g_mean + 0.114 * b_mean

    # --- Brightness ---
    if luminance > 185:
        lighting_hint = "bright"
    elif luminance < 75:
        lighting_hint = "dark"
    else:
        lighting_hint = "neutral"

    # --- Color temperature ---
    rb_diff = r_mean - b_mean
    if rb_diff > 25:
        color_temperature = "warm"
    elif rb_diff < -25:
        color_temperature = "cool"
    else:
        color_temperature = "neutral"

    # --- Light direction: compare top/bottom/left/right quadrant luminance ---
    w, h = img.size

    def _region_lum(region: Image.Image) -> float:
        s = ImageStat.Stat(region)
        r, g, b = s.mean[:3]
        return 0.299 * r + 0.587 * g + 0.114 * b

    top_lum = _region_lum(img.crop((0, 0, w, h // 3)))
    bot_lum = _region_lum(img.crop((0, 2 * h // 3, w, h)))
    left_lum = _region_lum(img.crop((0, 0, w // 3, h)))
    right_lum = _region_lum(img.crop((2 * w // 3, 0, w, h)))

    tb_diff = top_lum - bot_lum
    lr_diff = left_lum - right_lum

    if tb_diff > 30:
        light_direction = "overhead"
    elif tb_diff < -30:
        light_direction = "bottom"
    elif lr_diff > 30:
        light_direction = "left"
    elif lr_diff < -30:
        light_direction = "right"
    else:
        light_direction = "ambient"

    return lighting_hint, light_direction, color_temperature
