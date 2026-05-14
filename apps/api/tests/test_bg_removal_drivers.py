"""Unit tests for pluggable background-removal drivers (task 4.7)."""

import os
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.cloud.fal_client import (
    AsyncFalClient,
    FalMalformedResponseError,
    FalRateLimitError,
    FalTimeoutError,
)
from app.objects.background_removal import ExtractionResult, build_bg_driver
from app.objects.background_removal.birefnet import BiRefNetDriver
from app.objects.background_removal.birefnet import _parse_result as birefnet_parse
from app.objects.background_removal.bria import BriaDriver
from app.objects.background_removal.bria import _parse_result as bria_parse

_BIREFNET_RESPONSE = {
    "image": {
        "url": "https://cdn.fal.ai/birefnet.png",
        "width": 512,
        "height": 512,
        "content_type": "image/png",
    }
}

_BRIA_RESPONSE = {
    "image": {
        "url": "https://cdn.fal.ai/bria.png",
        "width": 256,
        "height": 256,
        "content_type": "image/png",
    }
}


def _mock_fal(return_value: dict) -> AsyncFalClient:
    mock = MagicMock(spec=AsyncFalClient)
    mock.run = AsyncMock(return_value=return_value)
    return mock


# ---------------------------------------------------------------------------
# build_bg_driver factory
# ---------------------------------------------------------------------------


def test_build_bg_driver_birefnet() -> None:
    driver = build_bg_driver("birefnet")
    assert isinstance(driver, BiRefNetDriver)
    assert driver.backend_name == "birefnet"


def test_build_bg_driver_bria() -> None:
    driver = build_bg_driver("bria")
    assert isinstance(driver, BriaDriver)
    assert driver.backend_name == "bria"


# ---------------------------------------------------------------------------
# BiRefNetDriver
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_birefnet_driver_returns_extraction_result() -> None:
    fal = _mock_fal(_BIREFNET_RESPONSE)
    driver = BiRefNetDriver()
    result = await driver.remove(b"fake_bytes", content_type="image/png", fal=fal)

    assert isinstance(result, ExtractionResult)
    assert result.url == "https://cdn.fal.ai/birefnet.png"
    assert result.width == 512
    assert result.height == 512
    assert result.content_type == "image/png"


@pytest.mark.asyncio
async def test_birefnet_driver_calls_correct_endpoint() -> None:
    fal = _mock_fal(_BIREFNET_RESPONSE)
    driver = BiRefNetDriver()
    await driver.remove(b"img", content_type="image/jpeg", fal=fal)

    fal.run.assert_awaited_once()
    endpoint, args = fal.run.call_args[0]
    assert endpoint == "fal-ai/birefnet/v2"
    assert args["output_format"] == "png"
    assert args["refine_foreground"] is True
    assert args["image_url"].startswith("data:image/jpeg;base64,")


@pytest.mark.asyncio
async def test_birefnet_driver_propagates_fal_timeout() -> None:
    fal = MagicMock(spec=AsyncFalClient)
    fal.run = AsyncMock(side_effect=FalTimeoutError("timed out"))
    driver = BiRefNetDriver()
    with pytest.raises(FalTimeoutError):
        await driver.remove(b"img", content_type="image/png", fal=fal)


@pytest.mark.asyncio
async def test_birefnet_driver_propagates_rate_limit() -> None:
    fal = MagicMock(spec=AsyncFalClient)
    fal.run = AsyncMock(side_effect=FalRateLimitError("rate limited"))
    driver = BiRefNetDriver()
    with pytest.raises(FalRateLimitError):
        await driver.remove(b"img", content_type="image/png", fal=fal)


def test_birefnet_parse_result_standard_shape() -> None:
    result = birefnet_parse(_BIREFNET_RESPONSE)
    assert result.url == "https://cdn.fal.ai/birefnet.png"
    assert result.width == 512
    assert result.height == 512
    assert result.content_type == "image/png"


def test_birefnet_parse_result_missing_image_key() -> None:
    result = birefnet_parse({})
    assert result.url == ""
    assert result.width == 0
    assert result.height == 0
    assert result.content_type == "image/png"


def test_birefnet_parse_result_null_image_key() -> None:
    result = birefnet_parse({"image": None})
    assert result.url == ""


# ---------------------------------------------------------------------------
# BriaDriver
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bria_driver_returns_extraction_result() -> None:
    fal = _mock_fal(_BRIA_RESPONSE)
    driver = BriaDriver()
    result = await driver.remove(b"fake_bytes", content_type="image/png", fal=fal)

    assert isinstance(result, ExtractionResult)
    assert result.url == "https://cdn.fal.ai/bria.png"
    assert result.width == 256
    assert result.height == 256
    assert result.content_type == "image/png"


@pytest.mark.asyncio
async def test_bria_driver_calls_correct_endpoint() -> None:
    fal = _mock_fal(_BRIA_RESPONSE)
    driver = BriaDriver()
    await driver.remove(b"img", content_type="image/jpeg", fal=fal)

    fal.run.assert_awaited_once()
    endpoint, args = fal.run.call_args[0]
    assert endpoint == "fal-ai/bria/remove-background"
    assert args["image_url"].startswith("data:image/jpeg;base64,")


@pytest.mark.asyncio
async def test_bria_driver_propagates_fal_timeout() -> None:
    fal = MagicMock(spec=AsyncFalClient)
    fal.run = AsyncMock(side_effect=FalTimeoutError("timed out"))
    driver = BriaDriver()
    with pytest.raises(FalTimeoutError):
        await driver.remove(b"img", content_type="image/png", fal=fal)


@pytest.mark.asyncio
async def test_bria_driver_propagates_rate_limit() -> None:
    fal = MagicMock(spec=AsyncFalClient)
    fal.run = AsyncMock(side_effect=FalRateLimitError("rate limited"))
    driver = BriaDriver()
    with pytest.raises(FalRateLimitError):
        await driver.remove(b"img", content_type="image/png", fal=fal)


@pytest.mark.asyncio
async def test_bria_driver_raises_on_missing_url() -> None:
    fal = _mock_fal({"image": {"width": 100, "height": 100}})  # url missing
    driver = BriaDriver()
    with pytest.raises(FalMalformedResponseError):
        await driver.remove(b"img", content_type="image/png", fal=fal)


@pytest.mark.asyncio
async def test_bria_driver_raises_on_empty_response() -> None:
    fal = _mock_fal({})
    driver = BriaDriver()
    with pytest.raises(FalMalformedResponseError):
        await driver.remove(b"img", content_type="image/png", fal=fal)


def test_bria_parse_result_standard_shape() -> None:
    result = bria_parse(_BRIA_RESPONSE)
    assert result.url == "https://cdn.fal.ai/bria.png"
    assert result.width == 256
    assert result.height == 256
    assert result.content_type == "image/png"


def test_bria_parse_result_missing_url_raises() -> None:
    with pytest.raises(FalMalformedResponseError):
        bria_parse({"image": {}})


# ---------------------------------------------------------------------------
# Live integration test — Bria driver (requires FAL_KEY)
# ---------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.asyncio
async def test_live_bria_driver_returns_alpha_png() -> None:
    import io
    from pathlib import Path

    from PIL import Image

    from app.cloud.fal_client import build_fal_client
    from app.settings import get_settings

    key = os.environ.get("FAL_KEY")
    if not key:
        pytest.skip("FAL_KEY not set")

    settings = get_settings()
    real_fal = build_fal_client(settings)
    driver = BriaDriver()

    fixture = Path(__file__).parent / "fixtures" / "objects" / "chair.png"
    image_bytes = fixture.read_bytes()

    result = await driver.remove(image_bytes, content_type="image/png", fal=real_fal)
    assert result.url.startswith("https://")
    assert result.content_type == "image/png"

    from app.cloud.fal_client import build_fal_client as _build

    fal_for_download = _build(settings)
    png_bytes = await fal_for_download.fetch_bytes(result.url)
    img = Image.open(io.BytesIO(png_bytes))
    assert img.mode == "RGBA", f"Expected RGBA, got {img.mode}"
    alpha = [p[3] for p in img.getdata()]
    assert min(alpha) == 0, "No transparent pixels — background not removed"
    assert max(alpha) == 255, "No opaque pixels — object not preserved"
