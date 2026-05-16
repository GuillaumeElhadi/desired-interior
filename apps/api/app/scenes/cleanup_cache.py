"""Cache for scene-cleanup results.

Root: ~/Library/Caches/InteriorVision/scenes-clean/<cache_key>/
  result.json  — {cleaned_scene_id, content_type}  (no large blobs)
  clean.jpg    — raw JPEG bytes  (reconstructed as data URL on load)
"""

import base64
from pathlib import Path
from typing import Any

from app.disk_cache import load_cached as _load
from app.disk_cache import load_raw as _load_raw
from app.disk_cache import save_cached as _save
from app.disk_cache import save_raw as _save_raw

__all__ = ["get_cache_root", "load_cached", "save_cached"]

_CLEAN_FILENAME = "clean.jpg"


def get_cache_root() -> Path:
    """Override in tests via monkeypatch."""
    return Path.home() / "Library" / "Caches" / "InteriorVision" / "scenes-clean"


def load_cached(cache_key: str) -> dict[str, Any] | None:
    root = get_cache_root()
    meta = _load(cache_key, root)
    if meta is None:
        return None
    raw = _load_raw(cache_key, _CLEAN_FILENAME, root)
    if raw is None:
        return None
    meta["cleaned_url"] = f"data:image/jpeg;base64,{base64.b64encode(raw).decode()}"
    return meta


def save_cached(cache_key: str, result: dict[str, Any], jpeg_bytes: bytes) -> None:
    root = get_cache_root()
    _save(cache_key, {k: v for k, v in result.items() if k != "cleaned_url"}, root)
    _save_raw(cache_key, _CLEAN_FILENAME, jpeg_bytes, root)
