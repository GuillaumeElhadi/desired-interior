"""Scene preprocessing: depth estimation + segmentation via fal.ai.

Calls fal-ai/imageutils/depth and fal-ai/sam in parallel.
Derives structured scene metadata from the results using Pillow.
"""

import asyncio
import base64
import io
from collections import defaultdict
from typing import Any

import structlog
from PIL import Image, ImageStat

from app.cloud.fal_client import AsyncFalClient

# Pillow decompression-bomb guard: ~6700×6000 px, well above any realistic
# segmentation or room photo size, prevents OOM from crafted images.
Image.MAX_IMAGE_PIXELS = 40_000_000

_log = structlog.get_logger()

_DEPTH_ENDPOINT = "fal-ai/imageutils/depth"

# fal-ai/sam2 (everything mode) was removed. fal-ai/sam (YOLO-World + SAM)
# is the live replacement. It accepts a text_prompt for open-vocab detection
# and returns a single colour-coded PNG where each detected region has a
# distinct colour on a black background. Per-region bboxes and areas are
# extracted via Pillow rather than received as a structured masks array.
_SAM_ENDPOINT = "fal-ai/sam"
_SAM_TEXT_PROMPT = (
    "floor, wall, ceiling, sofa, armchair, chair, dining chair, table, coffee table, "
    "rug, carpet, window, door, plant, lamp, shelf, bookcase, bed, dresser, wardrobe, "
    "curtain, picture frame, mirror, cushion, pillow"
)

# Minimum pixel count (in the downsampled processing image) for a colour
# region to be treated as a real segment rather than a JPEG/PNG artefact.
_MIN_SEGMENT_PIXELS = 30


async def run_preprocessing(
    image_bytes: bytes,
    content_type: str,
    fal: AsyncFalClient,
) -> dict[str, Any]:
    b64 = base64.b64encode(image_bytes).decode()
    image_data_url = f"data:{content_type};base64,{b64}"

    _log.info("scene_preprocess_start", size_bytes=len(image_bytes))

    depth_result, sam_result = await asyncio.gather(
        fal.run(_DEPTH_ENDPOINT, {"image_url": image_data_url}),
        fal.run(_SAM_ENDPOINT, {"image_url": image_data_url, "text_prompt": _SAM_TEXT_PROMPT}),
        return_exceptions=True,
    )

    if isinstance(sam_result, Exception):
        _log.warning("sam_unavailable", error=str(sam_result))
        sam_result = {}

    if isinstance(depth_result, Exception):
        raise depth_result

    depth_map = _extract_depth_map(depth_result)
    masks = await _extract_masks_from_result(sam_result, fal)
    metadata = _derive_metadata(masks, image_bytes)

    _log.info("scene_preprocess_done", masks_count=len(masks))

    return {"depth_map": depth_map, "masks": masks, "metadata": metadata}


# ---------------------------------------------------------------------------
# Mask extraction
# ---------------------------------------------------------------------------


async def _extract_masks_from_result(
    result: dict[str, Any], fal: AsyncFalClient
) -> list[dict[str, Any]]:
    """Extract masks from a fal-ai/sam result.

    fal-ai/sam returns a colour-coded segmentation image; we download it via
    the fal client and extract per-region bboxes with Pillow.  Falls back to
    the legacy list format so the function stays forward-compatible with any
    future API change.
    """
    sam_image_url = (result.get("image") or {}).get("url")
    if sam_image_url:
        try:
            png_bytes = await fal.fetch_bytes(sam_image_url)
            masks = _regions_from_segmentation_png(png_bytes)
            if masks:
                return masks
        except Exception as exc:
            _log.warning("sam_image_extraction_failed", error=str(exc))

    # Legacy path: structured masks list (forward-compat with any future API)
    return _extract_masks(result)


def _regions_from_segmentation_png(png_bytes: bytes) -> list[dict[str, Any]]:
    """Extract per-region bboxes from a colour-coded segmentation PNG.

    fal-ai/sam returns a PNG where each detected segment is painted a distinct
    non-black colour on a black background.  A single pass groups pixels by
    colour; bboxes and areas are computed per group.
    """
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    orig_w, orig_h = img.size

    # Downsample to bound processing time while keeping bbox accuracy
    MAX_DIM = 512
    scale = min(MAX_DIM / orig_w, MAX_DIM / orig_h, 1.0)
    if scale < 1.0:
        proc_w = int(orig_w * scale)
        proc_h = int(orig_h * scale)
        img = img.resize((proc_w, proc_h), Image.Resampling.NEAREST)
    else:
        proc_w, proc_h = orig_w, orig_h
    inv = 1.0 / scale

    # Single-pass grouping of pixel positions by colour
    pixel_data = img.get_flattened_data()
    color_positions: dict[tuple[int, int, int], list[int]] = defaultdict(list)
    for idx, color in enumerate(pixel_data):
        color_positions[color].append(idx)  # type: ignore[index]

    min_px = max(_MIN_SEGMENT_PIXELS, int(proc_w * proc_h * 0.001))
    masks: list[dict[str, Any]] = []

    for color, positions in color_positions.items():
        r, g, b = color
        # Skip near-black background
        if r < 20 and g < 20 and b < 20:
            continue
        if len(positions) < min_px:
            continue

        xs = [p % proc_w for p in positions]
        ys = [p // proc_w for p in positions]

        x1 = int(min(xs) * inv)
        y1 = int(min(ys) * inv)
        x2 = int(max(xs) * inv)
        y2 = int(max(ys) * inv)
        area = int(len(positions) * inv * inv)

        masks.append(
            {
                "url": "",
                "label": "",
                "score": 1.0,
                "area": area,
                "bbox": [x1, y1, x2 - x1, y2 - y1],
                "surface_type": "unknown",
            }
        )

    masks.sort(key=lambda m: m["area"], reverse=True)
    _label_dominant_surfaces(masks, orig_h)
    return masks


def _label_dominant_surfaces(masks: list[dict[str, Any]], img_height: int) -> None:
    """Mark the largest mask in each half as wall/floor; leave others as 'unknown'.

    Only the dominant background regions get a surface_type — small masks of
    detected objects (chairs, sofas) remain 'unknown' and are ignored for
    surface-based auto-placement.
    """
    if img_height <= 0:
        return
    best_wall = None
    best_floor = None
    for m in masks:
        bbox = m.get("bbox") or []
        if len(bbox) < 4:
            continue
        cy = bbox[1] + bbox[3] / 2
        cy_norm = cy / img_height
        if cy_norm < 0.50 and best_wall is None:
            best_wall = m
        elif cy_norm >= 0.55 and best_floor is None:
            best_floor = m
        if best_wall is not None and best_floor is not None:
            break
    if best_wall is not None:
        best_wall["surface_type"] = "wall"
    if best_floor is not None:
        best_floor["surface_type"] = "floor"


def _extract_masks(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Parse a legacy masks-list SAM response (kept for forward-compat)."""
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
                "surface_type": "unknown",
            }
        )
    return masks


# ---------------------------------------------------------------------------
# Depth map
# ---------------------------------------------------------------------------


def _extract_depth_map(result: dict[str, Any]) -> dict[str, Any]:
    img = result.get("image") or {}
    return {
        "url": img.get("url", ""),
        "width": img.get("width", 0),
        "height": img.get("height", 0),
    }


# ---------------------------------------------------------------------------
# Metadata derivation
# ---------------------------------------------------------------------------


def _derive_metadata(masks: list[dict[str, Any]], image_bytes: bytes) -> dict[str, Any]:
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
    """Classify dominant surface from mask positions.

    Takes the largest mask by area; classifies by the centroid's normalised
    y-position (0 = top, 1 = bottom).
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
        if bbox[2] > w:
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

    Uses ImageStat on a 64x64 thumbnail for fast analysis (< 1 ms).
    """
    thumb = img.resize((64, 64), Image.Resampling.LANCZOS)
    stat = ImageStat.Stat(thumb)
    r_mean, g_mean, b_mean = stat.mean[:3]
    luminance = 0.299 * r_mean + 0.587 * g_mean + 0.114 * b_mean

    if luminance > 185:
        lighting_hint = "bright"
    elif luminance < 75:
        lighting_hint = "dark"
    else:
        lighting_hint = "neutral"

    rb_diff = r_mean - b_mean
    if rb_diff > 25:
        color_temperature = "warm"
    elif rb_diff < -25:
        color_temperature = "cool"
    else:
        color_temperature = "neutral"

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
