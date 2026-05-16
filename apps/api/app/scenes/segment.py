"""Point-based SAM segmentation — powers the interactive erase mode (task 5.9).

Accepts a click coordinate in the original image, runs fal-ai/sam-3-1/image with
a foreground point prompt, binarises the returned mask, and returns the mask as a
PNG data URL alongside the bounding box and confidence score.
"""

import base64
import hashlib
import io
from pathlib import Path
from typing import Any

import structlog
from PIL import Image

from app.cloud.fal_client import AsyncFalClient, FalMalformedResponseError
from app.disk_cache import compute_sha256
from app.disk_cache import load_cached as _load
from app.disk_cache import load_raw as _load_raw
from app.disk_cache import save_cached as _save
from app.disk_cache import save_raw as _save_raw

_log = structlog.get_logger()

_SAM_ENDPOINT = "fal-ai/sam2/image"
_MASK_FILENAME = "mask.png"


# ---------------------------------------------------------------------------
# Segment cache
# ---------------------------------------------------------------------------


def get_segment_cache_root() -> Path:
    """Override in tests via monkeypatch."""
    return Path.home() / "Library" / "Caches" / "InteriorVision" / "segments"


def _segment_cache_key(scene_sha: str, x: int, y: int) -> str:
    parts = f"{scene_sha}:{x}:{y}"
    return hashlib.sha256(parts.encode()).hexdigest()


def _load_segment_cache(cache_key: str) -> dict[str, Any] | None:
    root = get_segment_cache_root()
    meta = _load(cache_key, root)
    if meta is None:
        return None
    raw = _load_raw(cache_key, _MASK_FILENAME, root)
    if raw is None:
        return None
    meta["mask_url"] = "data:image/png;base64," + base64.b64encode(raw).decode()
    return meta


def _save_segment_cache(cache_key: str, meta: dict[str, Any], mask_bytes: bytes) -> None:
    root = get_segment_cache_root()
    _save(cache_key, {k: v for k, v in meta.items() if k != "mask_url"}, root)
    _save_raw(cache_key, _MASK_FILENAME, mask_bytes, root)


# ---------------------------------------------------------------------------
# Core segmentation logic
# ---------------------------------------------------------------------------


async def run_segment_point(
    scene_bytes: bytes,
    x: int,
    y: int,
    fal: AsyncFalClient,
) -> tuple[bytes, list[float], float]:
    """Run SAM 3.1 with a foreground point prompt.

    Returns (binary_mask_png_bytes, bbox_pixels, score).
    bbox_pixels is [x, y, w, h] in original image pixel coordinates.
    """
    scene_sha = compute_sha256(scene_bytes)
    scene_data_url = "data:image/jpeg;base64," + base64.b64encode(scene_bytes).decode()

    _log.debug("segment_point_fal_call", scene_sha=scene_sha, x=x, y=y)

    # SAM 2 uses "prompts" (not "point_prompts") with {x, y, label}.
    result = await fal.run(
        _SAM_ENDPOINT,
        {
            "image_url": scene_data_url,
            "prompts": [{"x": x, "y": y, "label": 1}],
            "output_format": "png",
        },
    )

    # SAM 2 may return the mask in "image" (primary) or "masks" list.
    masks = result.get("masks") or []
    primary_image = result.get("image") or {}
    mask_url = (masks[0].get("url") if masks else None) or primary_image.get("url", "")
    if not mask_url:
        raise FalMalformedResponseError(
            f"SAM 2 returned no mask URL; keys present: {list(result.keys())}"
        )

    # Fetch and binarise the mask PNG (white = object, black = background)
    mask_bytes_raw = await fal.fetch_bytes(mask_url)
    img = Image.open(io.BytesIO(mask_bytes_raw)).convert("L")
    mask_w, mask_h = img.size
    binary_img = img.point(lambda p: 255 if p > 128 else 0, "L")
    buf = io.BytesIO()
    binary_img.save(buf, "PNG")
    binary_mask_bytes = buf.getvalue()

    # Derive bbox from the mask itself (bounding box of white pixels).
    bbox_pil = binary_img.getbbox()  # returns (x_min, y_min, x_max, y_max) or None
    if bbox_pil:
        bx, by, bx2, by2 = bbox_pil
        bbox = [float(bx), float(by), float(bx2 - bx), float(by2 - by)]
    else:
        bbox = [0.0, 0.0, float(mask_w), float(mask_h)]

    return binary_mask_bytes, bbox, 1.0


async def segment_point(
    scene_bytes: bytes,
    x: int,
    y: int,
    fal: AsyncFalClient,
) -> dict[str, Any]:
    """Public entry point — handles caching around run_segment_point."""
    scene_sha = compute_sha256(scene_bytes)
    cache_key = _segment_cache_key(scene_sha, x, y)

    cached = _load_segment_cache(cache_key)
    if cached is not None:
        _log.debug("segment_point_cache_hit", cache_key=cache_key)
        return cached

    mask_bytes, bbox, score = await run_segment_point(scene_bytes, x, y, fal)

    meta: dict[str, Any] = {"bbox": bbox, "score": score}
    _save_segment_cache(cache_key, meta, mask_bytes)

    mask_url = "data:image/png;base64," + base64.b64encode(mask_bytes).decode()
    return {"mask_url": mask_url, "bbox": bbox, "score": score}
