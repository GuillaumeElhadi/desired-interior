"""SHA-256 disk cache for scene preprocessing results.

Thin wrapper over app.disk_cache — keeping the public API identical so
existing code and tests require no changes.

Cache root: ~/Library/Caches/InteriorVision/scenes/<sha256>/result.json
"""

from pathlib import Path
from typing import Any

from app.disk_cache import compute_sha256
from app.disk_cache import load_cached as _load
from app.disk_cache import save_cached as _save

__all__ = ["compute_sha256", "get_cache_root", "load_cached", "save_cached"]


def get_cache_root() -> Path:
    """Override in tests via monkeypatch."""
    return Path.home() / "Library" / "Caches" / "InteriorVision" / "scenes"


def load_cached(sha256: str) -> dict[str, Any] | None:
    return _load(sha256, get_cache_root())


def save_cached(sha256: str, result: dict[str, Any]) -> None:
    _save(sha256, result, get_cache_root())
