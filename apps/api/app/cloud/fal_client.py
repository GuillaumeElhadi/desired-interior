"""Thin async wrapper around the fal-client SDK.

THIS IS THE ONLY FILE ALLOWED TO IMPORT fal_client.
All other modules must import AsyncFalClient and the domain exceptions
from here — never the SDK directly.
"""

import asyncio
from typing import Any

import fal_client as _fal_sdk
import httpx
import structlog
from tenacity import (
    AsyncRetrying,
    RetryError,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from app.settings import Settings

_log = structlog.get_logger()


# ---------------------------------------------------------------------------
# Domain exceptions — callers catch these, not httpx or SDK internals.
# ---------------------------------------------------------------------------


class FalError(Exception):
    """Base class for all fal.ai errors."""


class FalTimeoutError(FalError):
    """The fal.ai request exceeded the configured timeout."""


class FalRateLimitError(FalError):
    """fal.ai returned HTTP 429 — request was rate-limited."""


class FalMalformedResponseError(FalError):
    """fal.ai returned a response that does not match the expected shape."""


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class AsyncFalClient:
    """Async fal.ai client with timeout enforcement, retry, and error normalisation.

    Instantiate once per process via build_fal_client(settings).
    """

    def __init__(self, *, key: str | None, timeout_s: float, max_retries: int) -> None:
        self._timeout_s = timeout_s
        self._max_retries = max_retries
        # Defer errors about missing key to call time so the sidecar can
        # start and serve non-ML endpoints without FAL_KEY configured.
        self._sdk_client = _fal_sdk.AsyncClient(key=key) if key is not None else None

    async def run(self, endpoint: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Call a fal.ai model endpoint and return the result dict.

        Retries on transient errors (timeout, rate limit) with exponential
        backoff+jitter. Raises domain exceptions for all failure modes.
        """
        try:
            async for attempt in AsyncRetrying(
                stop=stop_after_attempt(self._max_retries),
                wait=wait_exponential_jitter(initial=1, max=30, jitter=2),
                retry=retry_if_exception_type((FalTimeoutError, FalRateLimitError)),
                reraise=True,
            ):
                with attempt:
                    return await self._call(endpoint, arguments)
        except RetryError as exc:
            raise FalError(f"fal.ai call to {endpoint!r} failed after retries") from exc
        # unreachable — reraise=True means the last exception is re-raised directly
        raise AssertionError("unreachable")  # pragma: no cover

    _ALLOWED_HOSTS = (".fal.ai", ".fal.run")
    _MAX_FETCH_BYTES = 50 * 1024 * 1024  # 50 MB

    async def fetch_bytes(self, url: str) -> bytes:
        """Download raw bytes from a fal.ai CDN URL.

        Validates scheme (https only) and host (*.fal.ai / *.fal.run) before
        connecting to prevent SSRF.  Caps response body at 50 MB.
        """
        parsed = httpx.URL(url)
        if parsed.scheme != "https" or not any(
            parsed.host.endswith(h) for h in self._ALLOWED_HOSTS
        ):
            raise FalMalformedResponseError(f"fetch_bytes: untrusted URL blocked: {url!r}")
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as http:
            resp = await http.get(url)
            resp.raise_for_status()
            if len(resp.content) > self._MAX_FETCH_BYTES:
                raise FalMalformedResponseError(
                    f"fetch_bytes: response too large ({len(resp.content)} bytes)"
                )
            return resp.content

    async def _call(self, endpoint: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if self._sdk_client is None:
            raise FalError(
                "FAL_KEY is not configured — set FAL_KEY env var or add it to .env.local"
            )

        _log.debug("fal_call_start", endpoint=endpoint)
        try:
            async with asyncio.timeout(self._timeout_s):
                result = await self._sdk_client.run(endpoint, arguments=arguments)
        except TimeoutError as exc:
            _log.warning("fal_timeout", endpoint=endpoint, timeout_s=self._timeout_s)
            raise FalTimeoutError(
                f"fal.ai call to {endpoint!r} timed out after {self._timeout_s}s"
            ) from exc
        except httpx.TimeoutException as exc:
            _log.warning("fal_timeout", endpoint=endpoint)
            raise FalTimeoutError(f"fal.ai call to {endpoint!r} timed out") from exc
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status == 429:
                _log.warning("fal_rate_limited", endpoint=endpoint)
                raise FalRateLimitError(f"fal.ai rate limit exceeded for {endpoint!r}") from exc
            _log.error("fal_http_error", endpoint=endpoint, status=status)
            raise FalError(f"fal.ai HTTP {status} for {endpoint!r}") from exc
        except FalError:
            raise
        except Exception as exc:
            _log.error("fal_unexpected_error", endpoint=endpoint, exc_info=exc)
            raise FalError(f"fal.ai call to {endpoint!r} failed: {exc}") from exc

        if not isinstance(result, dict):
            raise FalMalformedResponseError(
                f"fal.ai returned {type(result).__name__!r} for {endpoint!r}, expected dict"
            )

        _log.debug("fal_call_done", endpoint=endpoint)
        return result


def build_fal_client(settings: Settings) -> AsyncFalClient:
    return AsyncFalClient(
        key=settings.fal_key,
        timeout_s=settings.fal_timeout_s,
        max_retries=settings.fal_max_retries,
    )
