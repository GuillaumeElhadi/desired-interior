from app.cloud.fal_client import AsyncFalClient

_fal_client: AsyncFalClient | None = None


def init_fal_client(client: AsyncFalClient) -> None:
    global _fal_client
    _fal_client = client


def get_fal_client() -> AsyncFalClient:
    if _fal_client is None:
        raise RuntimeError("fal client not initialised — call init_fal_client() at startup")
    return _fal_client
