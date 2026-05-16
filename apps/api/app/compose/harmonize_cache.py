"""Disk cache for harmonization results.

Cache root: ~/Library/Caches/InteriorVision/harmonize/<sha256>/result.json
"""

from pathlib import Path
from typing import Any

from app.disk_cache import load_cached as _load
from app.disk_cache import save_cached as _save

__all__ = ["get_cache_root", "load_cached", "save_cached"]


def get_cache_root() -> Path:
    """Override in tests via monkeypatch."""
    return Path.home() / "Library" / "Caches" / "InteriorVision" / "harmonize"


def load_cached(cache_key: str) -> dict[str, Any] | None:
    return _load(cache_key, get_cache_root())


def save_cached(cache_key: str, result: dict[str, Any]) -> None:
    _save(cache_key, result, get_cache_root())
