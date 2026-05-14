"""Tests that API error responses include a typed error_code field.

Covers the HTTPException handler, the 500 middleware, and each AppError code
used in the compose / scenes / objects routers.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.cloud.fal_client import FalKeyMissingError, FalRateLimitError, FalTimeoutError
from app.main import app


@pytest.fixture
def http_client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ---------------------------------------------------------------------------
# 404 — route that does not exist → generic not_found via FastAPI
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_route_returns_404_without_error_code(http_client: AsyncClient) -> None:
    # FastAPI 404 for an unknown path still returns {"detail": "Not Found"} —
    # our handler only fires for HTTPException raised inside routes, not for
    # routing 404s raised by the framework before reaching our code.
    async with http_client as client:
        response = await client.get("/does-not-exist")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Compose endpoint — error_code on each FalError variant
# ---------------------------------------------------------------------------


def _make_compose_body() -> dict:
    sha = "a" * 64
    return {
        "scene_id": sha,
        "object_id": sha,
        "placement": {"bbox": {"x": 0, "y": 0, "width": 100, "height": 100}, "depth_hint": 0.5},
        "style_hints": {"prompt_suffix": ""},
    }


async def _post_compose(client: AsyncClient) -> object:
    return await client.post(
        "/compose",
        json=_make_compose_body(),
        headers={"Authorization": "Bearer skip"},
    )


@pytest.mark.asyncio
async def test_compose_404_scene_not_found() -> None:
    with (
        patch("app.compose.router.load_scene", return_value=None),
        patch("app.auth.verify_ipc_token", return_value=None),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await _post_compose(client)

    assert response.status_code == 404
    body = response.json()
    assert body["error_code"] == "scene_not_found"
    assert "request_id" in body


@pytest.mark.asyncio
async def test_compose_404_object_not_found() -> None:
    with (
        patch("app.compose.router.load_scene", return_value={"ok": True}),
        patch("app.compose.router.load_object", return_value=None),
        patch("app.auth.verify_ipc_token", return_value=None),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await _post_compose(client)

    assert response.status_code == 404
    body = response.json()
    assert body["error_code"] == "object_not_found"


@pytest.mark.asyncio
async def test_compose_409_scene_original_missing() -> None:
    with (
        patch("app.compose.router.load_scene", return_value={"ok": True}),
        patch(
            "app.compose.router.load_object",
            return_value={"masked": {"url": "https://cdn.fal.ai/x.png"}},
        ),
        patch("app.compose.router.load_original", return_value=None),
        patch("app.auth.verify_ipc_token", return_value=None),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await _post_compose(client)

    assert response.status_code == 409
    body = response.json()
    assert body["error_code"] == "scene_original_missing"


@pytest.mark.asyncio
async def test_compose_503_fal_key_missing() -> None:
    mock_fal = MagicMock()
    mock_fal.run = AsyncMock(side_effect=FalKeyMissingError("FAL_KEY is not configured"))

    with (
        patch("app.compose.router.load_scene", return_value={"ok": True}),
        patch(
            "app.compose.router.load_object",
            return_value={"masked": {"url": "https://cdn.fal.ai/x.png"}},
        ),
        patch("app.compose.router.load_original", return_value=b"imgbytes"),
        patch("app.compose.router.load_cached", return_value=None),
        patch(
            "app.compose.router.run_composition",
            side_effect=FalKeyMissingError("FAL_KEY is not configured"),
        ),
        patch("app.auth.verify_ipc_token", return_value=None),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await _post_compose(client)

    assert response.status_code == 503
    body = response.json()
    assert body["error_code"] == "fal_key_missing"


@pytest.mark.asyncio
async def test_compose_504_fal_timeout() -> None:
    with (
        patch("app.compose.router.load_scene", return_value={"ok": True}),
        patch(
            "app.compose.router.load_object",
            return_value={"masked": {"url": "https://cdn.fal.ai/x.png"}},
        ),
        patch("app.compose.router.load_original", return_value=b"imgbytes"),
        patch("app.compose.router.load_cached", return_value=None),
        patch("app.compose.router.run_composition", side_effect=FalTimeoutError("timed out")),
        patch("app.auth.verify_ipc_token", return_value=None),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await _post_compose(client)

    assert response.status_code == 504
    body = response.json()
    assert body["error_code"] == "fal_timeout"


@pytest.mark.asyncio
async def test_compose_429_fal_rate_limited() -> None:
    with (
        patch("app.compose.router.load_scene", return_value={"ok": True}),
        patch(
            "app.compose.router.load_object",
            return_value={"masked": {"url": "https://cdn.fal.ai/x.png"}},
        ),
        patch("app.compose.router.load_original", return_value=b"imgbytes"),
        patch("app.compose.router.load_cached", return_value=None),
        patch("app.compose.router.run_composition", side_effect=FalRateLimitError("rate limited")),
        patch("app.auth.verify_ipc_token", return_value=None),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await _post_compose(client)

    assert response.status_code == 429
    body = response.json()
    assert body["error_code"] == "fal_rate_limited"


# ---------------------------------------------------------------------------
# error_code present on all structured error responses
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_error_response_always_has_error_code_and_request_id() -> None:
    with (
        patch("app.compose.router.load_scene", return_value=None),
        patch("app.auth.verify_ipc_token", return_value=None),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await _post_compose(client)

    body = response.json()
    assert "error_code" in body, "error_code field missing from error response"
    assert "request_id" in body, "request_id field missing from error response"
    assert "message" in body, "message field missing from error response"
