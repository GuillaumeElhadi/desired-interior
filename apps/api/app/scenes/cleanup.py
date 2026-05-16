"""Scene cleanup pipeline — LaMa inpainting (primary) or Flux Fill erase (fallback)."""

import base64
import hashlib
import io
from typing import Any

import structlog
from PIL import Image

from app.cloud.fal_client import AsyncFalClient, FalMalformedResponseError
from app.disk_cache import compute_sha256
from app.exceptions import AppError

_log = structlog.get_logger()

_LAMA_ENDPOINT = "fal-ai/lama"
_FLUX_ENDPOINT = "fal-ai/flux-pro/v1/fill"
_MAX_MASK_COVERAGE = 0.20


def decode_png_data_url(data_url: str) -> bytes:
    """Decode a data:image/png;base64,... URL to raw bytes."""
    _, encoded = data_url.split(",", 1)
    return base64.b64decode(encoded, validate=True)


def validate_mask(mask_bytes: bytes, scene_width: int, scene_height: int) -> float:
    """Validate mask dimensions, binary-ness, and coverage. Returns coverage fraction.

    Raises AppError (422) on validation failure.
    """
    img = Image.open(io.BytesIO(mask_bytes)).convert("L")
    w, h = img.size
    if w != scene_width or h != scene_height:
        raise AppError(
            status_code=422,
            error_code="mask_resolution_mismatch",
            message=f"Mask size {w}×{h} must match scene {scene_width}×{scene_height}.",
        )
    raw = img.tobytes()
    total = len(raw)
    if any(b not in (0, 255) for b in raw):
        raise AppError(
            status_code=422,
            error_code="mask_not_binary",
            message="Mask must be strictly binary (pixels must be 0 or 255 only).",
        )
    white_count = raw.count(255)
    coverage = white_count / total
    if coverage > _MAX_MASK_COVERAGE:
        raise AppError(
            status_code=422,
            error_code="mask_coverage_exceeded",
            message=(
                f"Mask covers {coverage:.1%} of pixels; "
                f"maximum allowed is {_MAX_MASK_COVERAGE:.0%}."
            ),
        )
    return coverage


def make_clean_cache_key(scene_sha: str, mask_sha: str, backend: str) -> str:
    parts = f"{scene_sha}:{mask_sha}:{backend}"
    return hashlib.sha256(parts.encode()).hexdigest()


async def run_scene_clean(
    scene_bytes: bytes,
    mask_bytes: bytes,
    scene_preprocess: dict[str, Any],
    backend: str,
    prompt_hint: str | None,
    fal: AsyncFalClient,
) -> tuple[bytes, str]:
    """Run the cleanup pipeline. Returns (jpeg_bytes, cache_key).

    validate_mask is called here so callers that skip the router still get validation.
    """
    scene_width = scene_preprocess["depth_map"]["width"]
    scene_height = scene_preprocess["depth_map"]["height"]
    validate_mask(mask_bytes, scene_width, scene_height)

    scene_data_url = "data:image/jpeg;base64," + base64.b64encode(scene_bytes).decode()
    mask_data_url = "data:image/png;base64," + base64.b64encode(mask_bytes).decode()

    mask_sha = compute_sha256(mask_bytes)
    scene_sha = compute_sha256(scene_bytes)
    cache_key = make_clean_cache_key(scene_sha, mask_sha, backend)

    _log.debug("scene_clean_fal_call", backend=backend, cache_key=cache_key)

    if backend == "flux":
        prompt = (
            prompt_hint + ", " if prompt_hint else ""
        ) + "empty space, blank wall, photorealistic interior, no objects"
        arguments: dict[str, Any] = {
            "image_url": scene_data_url,
            "mask_url": mask_data_url,
            "prompt": prompt,
            "num_inference_steps": 20,
            "strength": 0.95,
        }
        fal_result = await fal.run(_FLUX_ENDPOINT, arguments)
    else:
        arguments = {"image_url": scene_data_url, "mask_url": mask_data_url}
        fal_result = await fal.run(_LAMA_ENDPOINT, arguments)

    # LaMa returns {"image": {"url": "..."}};
    # Flux Fill returns {"images": [{"url": "..."}]} — same shape as the Harmonizer.
    if backend == "flux":
        result_url = ((fal_result.get("images") or [{}])[0]).get("url", "")
    else:
        result_url = (fal_result.get("image") or {}).get("url", "")
    if not result_url:
        raise FalMalformedResponseError("No image URL in cleanup response")

    jpeg_bytes = await fal.fetch_bytes(result_url)
    return jpeg_bytes, cache_key
