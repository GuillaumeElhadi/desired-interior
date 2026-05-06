"""SHA-256-keyed disk cache for scene preprocessing results.

Cache root: ~/Library/Caches/InteriorVision/scenes/<sha256>/result.json
"""

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

import structlog

_log = structlog.get_logger()


def get_cache_root() -> Path:
    """Returns the cache root directory. Override in tests via monkeypatch."""
    return Path.home() / "Library" / "Caches" / "InteriorVision" / "scenes"


def compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _result_path(sha256: str) -> Path:
    return get_cache_root() / sha256 / "result.json"


def load_cached(sha256: str) -> dict[str, Any] | None:
    path = _result_path(sha256)
    if not path.exists():
        return None
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        _log.debug("scene_cache_hit", sha256=sha256)
        return result
    except (json.JSONDecodeError, OSError, ValueError) as exc:
        _log.warning("scene_cache_corrupted", sha256=sha256, error=str(exc))
        shutil.rmtree(get_cache_root() / sha256, ignore_errors=True)
        return None


def save_cached(sha256: str, result: dict[str, Any]) -> None:
    cache_dir = get_cache_root() / sha256
    cache_dir.mkdir(parents=True, exist_ok=True)
    _result_path(sha256).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    _log.debug("scene_cache_saved", sha256=sha256)
