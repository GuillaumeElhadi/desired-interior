"""Runtime settings endpoint — hot-reloads FAL_KEY without restarting the sidecar."""

import asyncio

import structlog
from fastapi import APIRouter, Depends

from app.auth import verify_ipc_token
from app.cloud.fal_client import build_fal_client
from app.dependencies import init_fal_client
from app.schemas import UpdateSettingsRequest, UpdateSettingsResponse
from app.settings import get_settings

_log = structlog.get_logger()
router = APIRouter(prefix="/settings", tags=["settings"])

# Guards concurrent calls to update_settings. The asyncio event loop is
# single-threaded, so this is a belt-and-suspenders measure for future-proofing
# (e.g., if workers > 1 is ever added).
_update_lock = asyncio.Lock()


@router.post("", dependencies=[Depends(verify_ipc_token)])
async def update_settings(body: UpdateSettingsRequest) -> UpdateSettingsResponse:
    """Update runtime settings and rebuild any affected clients.

    Currently supports updating FAL_KEY. The fal client is rebuilt immediately
    so subsequent ML calls use the new key — no sidecar restart required.
    """
    async with _update_lock:
        settings = get_settings()

        if body.fal_key is not None:
            settings.fal_key = body.fal_key or None
            init_fal_client(build_fal_client(settings))
            _log.info("settings_updated", fal_key_set=settings.fal_key is not None)

    return UpdateSettingsResponse(ok=True)
