"""SHA-256 disk cache for preview composition results.

Cache root: ~/Library/Caches/InteriorVision/preview/<sha256>/result.json
Kept separate from the final-render compose cache to avoid mixing quality tiers.
"""

from pathlib import Path
from typing import Any

from app.disk_cache import load_cached as _load
from app.disk_cache import save_cached as _save

__all__ = ["get_cache_root", "load_cached", "save_cached"]


def get_cache_root() -> Path:
    """Override in tests via monkeypatch."""
    return Path.home() / "Library" / "Caches" / "InteriorVision" / "preview"


def load_cached(cache_key: str) -> dict[str, Any] | None:
    return _load(cache_key, get_cache_root())


def save_cached(cache_key: str, result: dict[str, Any]) -> None:
    _save(cache_key, result, get_cache_root())
