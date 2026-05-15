"""Harmonizer: Flux Fill img2img + ControlNet Depth (primary) or SDXL img2img (fallback).

Pipeline for a given list of placed objects:
  1. Sequential PIL composite using run_composition() — one pass per object.
  2. OR-accumulate binary masks from each pass into a union mask.
  3. Call fal-ai/flux-pro/v1/fill (primary) or fal-ai/stable-diffusion-xl-inpainting
     (SDXL fallback) with the composite, union mask, depth map URL, and strength.
  4. Return the harmonized image URL from fal.ai.

Latency budget (documented, not enforced at runtime):
  - Flux Fill primary: p95 ≤ 25 s for 1024×1024
  - SDXL fallback:     p95 ≤ 15 s for 1024×1024
  - Cache hit:         < 50 ms
"""

import base64
import hashlib
import io
from typing import Any

import structlog
from PIL import Image, ImageChops

from app.cloud.fal_client import AsyncFalClient, FalMalformedResponseError
from app.compose.composition import run_composition
from app.schemas import ObjectPlacement, PlacementSpec, StyleHints

_FAL_CDN_HOSTS = (".fal.ai", ".fal.run", ".fal.media")

_log = structlog.get_logger()

_FLUX_ENDPOINT = "fal-ai/flux-pro/v1/fill"
_SDXL_ENDPOINT = "fal-ai/stable-diffusion-xl-inpainting"

_HARMONIZE_PROMPT = (
    "preserve object identity, integrate lighting and cast shadows naturally, "
    "photorealistic interior, no new objects"
)


def make_harmonize_cache_key(
    scene_id: str,
    objects: list[ObjectPlacement],
    backend: str,
    harmonize_strength: float,
    seed: int | None,
) -> str:
    """Stable cache key covering all inputs that affect the harmonized output."""
    sorted_objs = sorted(objects, key=lambda o: o.object_id)
    obj_parts = ":".join(
        f"{o.object_id}:"
        f"{o.placement.bbox.x:.4f},{o.placement.bbox.y:.4f},"
        f"{o.placement.bbox.width:.4f},{o.placement.bbox.height:.4f}:"
        f"{o.placement.depth_hint:.4f}:{o.placement.rotation:.4f}"
        for o in sorted_objs
    )
    parts = f"{scene_id}:{obj_parts}:{backend}:{harmonize_strength:.4f}:{seed}"
    return hashlib.sha256(parts.encode()).hexdigest()


async def run_harmonize(
    scene_image_bytes: bytes,
    depth_map_url: str,
    objects: list[tuple[str, str, PlacementSpec]],
    harmonize_strength: float,
    seed: int | None,
    fal: AsyncFalClient,
    backend: str = "flux",
) -> dict[str, Any]:
    """Run the harmonization pipeline and return the result dict.

    Args:
        scene_image_bytes: Raw bytes of the original room JPEG.
        depth_map_url: HTTPS URL of the scene depth map (may be empty string).
        objects: List of (object_url, surface_type, placement) tuples.
        harmonize_strength: Inpainting strength ∈ [0.15, 0.55].
        seed: Optional reproducibility seed.
        fal: Async fal.ai client.
        backend: "flux" (default) or "sdxl".

    Returns:
        {"url": <harmonized image URL>, "content_type": "image/jpeg"}
    """
    # 1. Sequential PIL composite + union mask
    current_bytes = scene_image_bytes
    union_mask: Image.Image | None = None

    for object_url, surface_type, placement in objects:
        result = await run_composition(
            scene_image_bytes=current_bytes,
            scene_content_type="image/jpeg",
            object_url=object_url,
            placement=placement,
            style_hints=StyleHints(),
            fal=fal,
            surface_type=surface_type,
        )
        # Decode composite back to JPEG bytes for the next iteration
        composite_b64 = result["url"].split(",", 1)[1]
        current_bytes = base64.b64decode(composite_b64)

        # OR-accumulate binary masks (ImageChops.lighter = per-pixel max on L images)
        mask_b64 = result["mask_url"].split(",", 1)[1]
        mask_img = Image.open(io.BytesIO(base64.b64decode(mask_b64))).convert("L")
        if union_mask is None:
            union_mask = mask_img
        else:
            union_mask = ImageChops.lighter(union_mask, mask_img)

    # Encode final composite and union mask as data URLs
    composite_data_url = f"data:image/jpeg;base64,{base64.b64encode(current_bytes).decode()}"

    mask_buf = io.BytesIO()
    union_mask.save(mask_buf, format="PNG")  # type: ignore[union-attr]
    mask_data_url = f"data:image/png;base64,{base64.b64encode(mask_buf.getvalue()).decode()}"

    # 2. Build fal.ai arguments (shared between backends)
    arguments: dict[str, Any] = {
        "image_url": composite_data_url,
        "mask_url": mask_data_url,
        "prompt": _HARMONIZE_PROMPT,
        "strength": harmonize_strength,
    }
    if seed is not None:
        arguments["seed"] = seed

    # 3. Select endpoint and call fal.ai
    endpoint = _FLUX_ENDPOINT if backend == "flux" else _SDXL_ENDPOINT
    _log.info(
        "harmonize_start",
        backend=backend,
        endpoint=endpoint,
        strength=harmonize_strength,
        num_objects=len(objects),
        has_depth_map=bool(depth_map_url),
    )

    fal_result = await fal.run(endpoint, arguments)

    images = fal_result.get("images") or []
    if not images or not images[0].get("url"):
        raise FalMalformedResponseError(f"{endpoint!r} returned no images in response")

    harmonized_url = str(images[0]["url"])

    # Validate the returned URL against the fal.ai CDN allowlist — same guard
    # used for depth_map_url — to prevent SSRF if a misconfigured backend returns
    # an attacker-controlled host.
    if not harmonized_url.startswith("https://"):
        raise FalMalformedResponseError(f"{endpoint!r} returned a non-HTTPS harmonized URL")
    host = harmonized_url.split("/")[2]
    if not any(host.endswith(h) for h in _FAL_CDN_HOSTS):
        raise FalMalformedResponseError(
            f"{endpoint!r} returned a harmonized URL from untrusted host {host!r}"
        )

    _log.info("harmonize_done", backend=backend, url=harmonized_url[:80])
    return {"url": harmonized_url, "content_type": "image/jpeg"}
