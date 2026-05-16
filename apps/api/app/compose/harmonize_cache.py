"""Disk cache for harmonization results.

Cache root: ~/Library/Caches/InteriorVision/harmonize/<sha256>/
  result.json — metadata (harmonize_id, content_type); no image bytes inline
  result.jpg  — raw JPEG bytes stored separately to avoid multi-MB JSON blobs
"""

import base64
from pathlib import Path
from typing import Any

from app.disk_cache import load_cached as _load
from app.disk_cache import load_raw as _load_raw
from app.disk_cache import save_cached as _save
from app.disk_cache import save_raw as _save_raw

__all__ = ["get_cache_root", "load_cached", "save_cached"]

_IMAGE_FILENAME = "result.jpg"


def get_cache_root() -> Path:
    """Override in tests via monkeypatch."""
    return Path.home() / "Library" / "Caches" / "InteriorVision" / "harmonize"


def load_cached(cache_key: str) -> dict[str, Any] | None:
    root = get_cache_root()
    meta = _load(cache_key, root)
    if meta is None:
        return None
    raw = _load_raw(cache_key, _IMAGE_FILENAME, root)
    if raw is None:
        # Legacy entry without separate image file — discard and re-run.
        return None
    data_url = f"data:image/jpeg;base64,{base64.b64encode(raw).decode()}"
    meta.setdefault("image", {})["url"] = data_url
    return meta


def save_cached(cache_key: str, result: dict[str, Any]) -> None:
    root = get_cache_root()
    image_url: str = (result.get("image") or {}).get("url", "")
    if image_url.startswith("data:"):
        _, encoded = image_url.split(",", 1)
        raw_bytes = base64.b64decode(encoded)
        _save_raw(cache_key, _IMAGE_FILENAME, raw_bytes, root)
        meta = {k: v for k, v in result.items() if k != "image"}
        meta["image"] = {k: v for k, v in result["image"].items() if k != "url"}
        _save(cache_key, meta, root)
    else:
        _save(cache_key, result, root)
