"""Pluggable background-removal driver layer.

Callers depend on BackgroundRemovalDriver (Protocol) and ExtractionResult only.
Concrete drivers live in birefnet.py and bria.py; import them only via build_bg_driver.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from app.cloud.fal_client import AsyncFalClient


@dataclass
class ExtractionResult:
    url: str
    width: int
    height: int
    content_type: str


class BackgroundRemovalDriver(Protocol):
    @property
    def backend_name(self) -> str:
        pass

    async def remove(
        self,
        image_bytes: bytes,
        *,
        content_type: str,
        fal: AsyncFalClient,
    ) -> ExtractionResult:
        pass


def build_bg_driver(backend: str) -> BackgroundRemovalDriver:
    from app.objects.background_removal.birefnet import BiRefNetDriver
    from app.objects.background_removal.bria import BriaDriver

    if backend == "birefnet":
        return BiRefNetDriver()
    return BriaDriver()
