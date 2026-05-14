from app.cloud.fal_client import AsyncFalClient
from app.objects.background_removal import BackgroundRemovalDriver

_fal_client: AsyncFalClient | None = None
_bg_driver: BackgroundRemovalDriver | None = None


def init_fal_client(client: AsyncFalClient) -> None:
    global _fal_client
    _fal_client = client


def get_fal_client() -> AsyncFalClient:
    if _fal_client is None:
        raise RuntimeError("fal client not initialised — call init_fal_client() at startup")
    return _fal_client


def init_bg_driver(driver: BackgroundRemovalDriver) -> None:
    global _bg_driver
    _bg_driver = driver


def get_bg_driver() -> BackgroundRemovalDriver:
    if _bg_driver is None:
        raise RuntimeError("bg driver not initialised — call init_bg_driver() at startup")
    return _bg_driver
