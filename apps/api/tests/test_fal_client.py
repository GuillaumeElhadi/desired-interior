"""Unit tests for the fal.ai cloud client wrapper.

All tests are fully offline — the fal SDK is mocked at the AsyncClient level.
The @pytest.mark.live suite requires FAL_KEY and hits the real API.
"""

import os
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.cloud.fal_client import (
    AsyncFalClient,
    FalError,
    FalMalformedResponseError,
    FalRateLimitError,
    FalTimeoutError,
    build_fal_client,
)
from app.settings import Settings

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ENDPOINT = "fal-ai/flux/schnell"
_ARGS: dict[str, Any] = {"prompt": "test", "num_images": 1}
_OK_RESULT: dict[str, Any] = {"images": [{"url": "https://cdn.fal.ai/test.png"}]}


def _make_client(
    key: str | None = "test-key",
    timeout_s: float = 60.0,
    max_retries: int = 1,
) -> AsyncFalClient:
    return AsyncFalClient(key=key, timeout_s=timeout_s, max_retries=max_retries)


def _http_error(status: int) -> httpx.HTTPStatusError:
    req = httpx.Request("POST", "https://fal.run/test")
    resp = httpx.Response(status, request=req)
    return httpx.HTTPStatusError(f"HTTP {status}", request=req, response=resp)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_sdk_run() -> AsyncMock:
    """Patch fal_client.AsyncClient so no network calls are made."""
    mock_run = AsyncMock(return_value=_OK_RESULT)
    mock_instance = MagicMock()
    mock_instance.run = mock_run
    with patch("app.cloud.fal_client._fal_sdk.AsyncClient", return_value=mock_instance):
        yield mock_run


# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_success(mock_sdk_run: AsyncMock) -> None:
    result = await _make_client().run(_ENDPOINT, _ARGS)
    assert result == _OK_RESULT
    mock_sdk_run.assert_awaited_once_with(_ENDPOINT, arguments=_ARGS)


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_raises_fal_timeout_on_asyncio_timeout(mock_sdk_run: AsyncMock) -> None:
    mock_sdk_run.side_effect = TimeoutError()
    with pytest.raises(FalTimeoutError, match="timed out"):
        await _make_client(timeout_s=30.0).run(_ENDPOINT, _ARGS)


@pytest.mark.asyncio
async def test_run_raises_fal_timeout_on_httpx_timeout(mock_sdk_run: AsyncMock) -> None:
    mock_sdk_run.side_effect = httpx.TimeoutException("read timeout")
    with pytest.raises(FalTimeoutError, match="timed out"):
        await _make_client().run(_ENDPOINT, _ARGS)


# ---------------------------------------------------------------------------
# Rate limit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_raises_fal_rate_limit_on_429(mock_sdk_run: AsyncMock) -> None:
    mock_sdk_run.side_effect = _http_error(429)
    with pytest.raises(FalRateLimitError, match="rate limit"):
        await _make_client().run(_ENDPOINT, _ARGS)


@pytest.mark.asyncio
async def test_rate_limit_is_retried(mock_sdk_run: AsyncMock) -> None:
    mock_sdk_run.side_effect = [_http_error(429), _OK_RESULT]
    result = await _make_client(max_retries=2).run(_ENDPOINT, _ARGS)
    assert result == _OK_RESULT
    assert mock_sdk_run.await_count == 2


# ---------------------------------------------------------------------------
# Other HTTP errors (not retried)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_raises_fal_error_on_5xx(mock_sdk_run: AsyncMock) -> None:
    mock_sdk_run.side_effect = _http_error(503)
    with pytest.raises(FalError, match="HTTP 503"):
        await _make_client().run(_ENDPOINT, _ARGS)


# ---------------------------------------------------------------------------
# Malformed response
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_raises_malformed_when_result_not_dict(mock_sdk_run: AsyncMock) -> None:
    mock_sdk_run.return_value = ["not", "a", "dict"]
    with pytest.raises(FalMalformedResponseError):
        await _make_client().run(_ENDPOINT, _ARGS)


@pytest.mark.asyncio
async def test_run_raises_malformed_when_result_is_string(mock_sdk_run: AsyncMock) -> None:
    mock_sdk_run.return_value = "unexpected string"
    with pytest.raises(FalMalformedResponseError):
        await _make_client().run(_ENDPOINT, _ARGS)


# ---------------------------------------------------------------------------
# Missing key
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_raises_fal_error_when_key_is_none() -> None:
    # No SDK mock needed — client is never created when key=None
    client = AsyncFalClient(key=None, timeout_s=60.0, max_retries=1)
    with pytest.raises(FalError, match="FAL_KEY"):
        await client.run(_ENDPOINT, _ARGS)


# ---------------------------------------------------------------------------
# Settings integration
# ---------------------------------------------------------------------------


def test_build_fal_client_from_settings() -> None:
    s = Settings(fal_key="sk-test", fal_timeout_s=30.0, fal_max_retries=2)
    with patch("app.cloud.fal_client._fal_sdk.AsyncClient"):
        client = build_fal_client(s)
    assert client._timeout_s == 30.0
    assert client._max_retries == 2


def test_settings_fal_key_optional() -> None:
    s = Settings(fal_key=None)
    assert s.fal_key is None


# ---------------------------------------------------------------------------
# Live tests — require real FAL_KEY, skipped otherwise
# ---------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.asyncio
async def test_live_flux_schnell() -> None:
    key = os.environ.get("FAL_KEY")
    if not key:
        pytest.skip("FAL_KEY not set")
    client = AsyncFalClient(key=key, timeout_s=120.0, max_retries=2)
    result = await client.run(
        "fal-ai/flux/schnell",
        {"prompt": "a plain white square, minimal", "num_images": 1, "image_size": "square_hd"},
    )
    assert isinstance(result, dict)
    assert "images" in result
    assert len(result["images"]) >= 1
    assert result["images"][0].get("url", "").startswith("https://")
