"""Generic SHA-256-keyed disk cache shared by all pipeline stages.

Each caller provides its own root via get_cache_root() wrapper functions
(see app/scenes/cache.py, app/objects/cache.py) so the root is
overridable in tests via monkeypatch without touching this module.
"""

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

import structlog

_log = structlog.get_logger()


def compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_cached(sha256: str, root: Path) -> dict[str, Any] | None:
    path = root / sha256 / "result.json"
    if not path.exists():
        return None
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        _log.debug("cache_hit", sha256=sha256, root=str(root))
        return result
    except (json.JSONDecodeError, OSError, ValueError) as exc:
        _log.warning("cache_corrupted", sha256=sha256, error=str(exc))
        shutil.rmtree(root / sha256, ignore_errors=True)
        return None


def save_cached(sha256: str, result: dict[str, Any], root: Path) -> None:
    cache_dir = root / sha256
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    _log.debug("cache_saved", sha256=sha256)


def load_raw(sha256: str, filename: str, root: Path) -> bytes | None:
    path = root / sha256 / filename
    if not path.exists():
        return None
    try:
        return path.read_bytes()
    except OSError as exc:
        _log.warning("cache_raw_read_error", sha256=sha256, filename=filename, error=str(exc))
        return None


def save_raw(sha256: str, filename: str, data: bytes, root: Path) -> None:
    cache_dir = root / sha256
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / filename).write_bytes(data)
    _log.debug("cache_raw_saved", sha256=sha256, filename=filename)
