"""Tests for the /settings endpoint."""

from unittest.mock import MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.settings import get_settings


@pytest.fixture(autouse=True)
def reset_settings():
    """Restore the original fal_key after each test."""
    original_key = get_settings().fal_key
    yield
    get_settings().fal_key = original_key


@pytest.mark.asyncio
async def test_update_fal_key_sets_key() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/settings", json={"fal_key": "test-key-123"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert get_settings().fal_key == "test-key-123"


@pytest.mark.asyncio
async def test_update_fal_key_empty_string_clears_key() -> None:
    get_settings().fal_key = "existing-key"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/settings", json={"fal_key": ""})
    assert resp.status_code == 200
    assert get_settings().fal_key is None


@pytest.mark.asyncio
async def test_update_settings_null_fal_key_does_not_change_key() -> None:
    get_settings().fal_key = "keep-me"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/settings", json={"fal_key": None})
    assert resp.status_code == 200
    assert get_settings().fal_key == "keep-me"


@pytest.mark.asyncio
async def test_update_settings_rebuilds_fal_client() -> None:
    with (
        patch("app.settings_router.init_fal_client") as mock_init,
        patch("app.settings_router.build_fal_client") as mock_build,
    ):
        mock_build.return_value = MagicMock()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/settings", json={"fal_key": "new-key"})
    assert resp.status_code == 200
    mock_build.assert_called_once()
    mock_init.assert_called_once()


@pytest.mark.asyncio
async def test_update_settings_rejects_key_too_long() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/settings", json={"fal_key": "x" * 201})
    assert resp.status_code == 422
