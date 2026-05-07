"""SHA-256 disk cache for object extraction results.

Cache root: ~/Library/Caches/InteriorVision/objects/<sha256>/result.json
"""

from pathlib import Path
from typing import Any

from app.disk_cache import compute_sha256  # noqa: F401 — re-exported
from app.disk_cache import load_cached as _load
from app.disk_cache import save_cached as _save


def get_cache_root() -> Path:
    """Override in tests via monkeypatch."""
    return Path.home() / "Library" / "Caches" / "InteriorVision" / "objects"


def load_cached(sha256: str) -> dict[str, Any] | None:
    return _load(sha256, get_cache_root())


def save_cached(sha256: str, result: dict[str, Any]) -> None:
    _save(sha256, result, get_cache_root())
