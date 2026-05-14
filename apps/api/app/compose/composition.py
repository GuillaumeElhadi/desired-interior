"""Object composition via PIL/Pillow alpha-compositing.

Pipeline:
  1. Download the extracted object PNG (with alpha channel, from BiRefNet) via fetch_bytes.
  2. Resize the object to the placement bbox dimensions.
  3. Apply rotation around the object centre (clockwise, matching Konva's convention).
  4. Add a soft shadow appropriate for the surface type (floor → ground shadow,
     wall → drop shadow).
  5. Alpha-composite the object onto the scene at the correct position.
  6. Encode the result as a JPEG base64 data URL — no fal.ai call required.
"""

import base64
import hashlib
import io
from typing import Any

import structlog
from PIL import Image, ImageDraw, ImageFilter

from app.cloud.fal_client import AsyncFalClient
from app.schemas import PlacementSpec, StyleHints

# Decompression-bomb guard. Set here independently of preprocessing.py so the
# guard does not depend on module import order.
Image.MAX_IMAGE_PIXELS = 40_000_000

_log = structlog.get_logger()

# Hard cap on the composited output dimensions before JPEG encoding, to keep
# the base64 data URL returned over IPC bounded in size.
_MAX_OUTPUT_DIM = 4096


def make_cache_key(
    scene_id: str,
    object_id: str,
    placement: PlacementSpec,
    style_hints: StyleHints,
    surface_type: str = "floor",
) -> str:
    """Stable cache key that captures all inputs that affect the output."""
    bbox = placement.bbox
    parts = (
        f"{scene_id}:{object_id}:"
        f"{bbox.x:.4f},{bbox.y:.4f},{bbox.width:.4f},{bbox.height:.4f}:"
        f"{placement.depth_hint:.4f}:"
        f"{placement.rotation:.4f}:"
        f"{surface_type}:"
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
    surface_type: str = "floor",
) -> dict[str, Any]:
    # 1. Open scene (downscale if it exceeds the output cap to keep the data URL bounded)
    scene = Image.open(io.BytesIO(scene_image_bytes)).convert("RGBA")
    if max(scene.size) > _MAX_OUTPUT_DIM:
        scale = _MAX_OUTPUT_DIM / max(scene.size)
        scene = scene.resize(
            (int(scene.size[0] * scale), int(scene.size[1] * scale)), Image.LANCZOS
        )
    scene_w, scene_h = scene.size

    # 2. Download extracted object (PNG with alpha from BiRefNet CDN)
    object_bytes = await fal.fetch_bytes(object_url)
    obj = Image.open(io.BytesIO(object_bytes)).convert("RGBA")

    # 3. Resize to placement bbox dimensions
    bbox = placement.bbox
    target_w = max(1, int(round(bbox.width)))
    target_h = max(1, int(round(bbox.height)))
    obj_resized = obj.resize((target_w, target_h), Image.LANCZOS)

    # 4. Rotation around centre (clockwise degrees, matching Konva's convention)
    if placement.rotation:
        obj_final = obj_resized.rotate(-placement.rotation, expand=True, resample=Image.BICUBIC)
    else:
        obj_final = obj_resized

    fin_w, fin_h = obj_final.size

    # 5. Paste position: centre of the rotated image aligned on the bbox centre
    cx = bbox.x + target_w / 2
    cy = bbox.y + target_h / 2
    paste_x = int(round(cx - fin_w / 2))
    paste_y = int(round(cy - fin_h / 2))

    # 6. Clip object to scene bounds (handle partial out-of-frame placement)
    clip_left = max(0, -paste_x)
    clip_top = max(0, -paste_y)
    clip_right = max(0, paste_x + fin_w - scene_w)
    clip_bottom = max(0, paste_y + fin_h - scene_h)
    if clip_left or clip_top or clip_right or clip_bottom:
        obj_final = obj_final.crop((clip_left, clip_top, fin_w - clip_right, fin_h - clip_bottom))
    paste_x = max(0, paste_x)
    paste_y = max(0, paste_y)

    # 7. Add a shadow layer for realism
    scene_with_shadow = _apply_shadow(scene, obj_final, paste_x, paste_y, surface_type)

    # 8. Alpha-composite the object on top
    scene_with_shadow.paste(obj_final, (paste_x, paste_y), obj_final)

    # 9. Encode as JPEG base64 data URL
    buf = io.BytesIO()
    scene_with_shadow.convert("RGB").save(buf, format="JPEG", quality=92)
    data_url = f"data:image/jpeg;base64,{base64.b64encode(buf.getvalue()).decode()}"

    _log.info(
        "composition_done",
        scene_w=scene_w,
        scene_h=scene_h,
        target_w=target_w,
        target_h=target_h,
        rotation=placement.rotation,
        paste_x=paste_x,
        paste_y=paste_y,
        surface_type=surface_type,
    )
    return {"url": data_url, "content_type": "image/jpeg"}


def _apply_shadow(
    scene: Image.Image,
    obj: Image.Image,
    paste_x: int,
    paste_y: int,
    surface_type: str,
) -> Image.Image:
    """Add a soft shadow appropriate for the surface type.

    floor: elliptical ground shadow at the object's base
    wall:  drop-shadow (offset darkened silhouette) for a 'mounted' look
    """
    shadow_layer = Image.new("RGBA", scene.size, (0, 0, 0, 0))
    fin_w, fin_h = obj.size

    if surface_type == "floor":
        sw = max(1, int(fin_w * 0.9))
        sh = max(1, int(fin_h * 0.12))
        sx = paste_x + (fin_w - sw) // 2
        sy = paste_y + fin_h - sh // 2
        draw = ImageDraw.Draw(shadow_layer)
        draw.ellipse([sx, sy, sx + sw, sy + sh], fill=(0, 0, 0, 110))
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=15))
    elif surface_type == "wall":
        alpha = obj.split()[3].point(lambda p: int(p * 0.45))
        sil = Image.new("RGBA", obj.size, (0, 0, 0, 0))
        sil.putalpha(alpha)
        sil = sil.filter(ImageFilter.GaussianBlur(radius=4))
        shadow_layer.paste(sil, (paste_x + 4, paste_y + 4), sil)

    return Image.alpha_composite(scene, shadow_layer)
