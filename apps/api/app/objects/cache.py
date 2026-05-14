"""SHA-256 disk cache for object extraction results.

Cache root: ~/Library/Caches/InteriorVision/objects/<backend>/<sha256>/result.json

The backend segment prevents cross-backend cache hits when BG_REMOVAL_BACKEND
is toggled between "birefnet" and "bria".
"""

from pathlib import Path
from typing import Any

from app.disk_cache import compute_sha256
from app.disk_cache import load_cached as _load
from app.disk_cache import save_cached as _save

__all__ = ["compute_sha256", "get_cache_root", "load_cached", "save_cached"]


def get_cache_root() -> Path:
    """Override in tests via monkeypatch."""
    return Path.home() / "Library" / "Caches" / "InteriorVision" / "objects"


def load_cached(sha256: str, backend: str = "birefnet") -> dict[str, Any] | None:
    return _load(sha256, get_cache_root() / backend)


def save_cached(sha256: str, result: dict[str, Any], backend: str = "birefnet") -> None:
    _save(sha256, result, get_cache_root() / backend)
