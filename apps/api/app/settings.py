from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables and .env.local.

    ML-related fields are optional so the sidecar can start and serve
    non-ML endpoints (health, logs) without a FAL_KEY configured.
    """

    fal_key: str | None = None
    fal_timeout_s: float = 60.0
    fal_max_retries: int = 3
    bg_removal_backend: Literal["birefnet", "bria"] = "birefnet"
    harmonizer_backend: Literal["flux", "sdxl"] = "flux"
    scene_clean_backend: Literal["lama", "flux"] = "lama"

    model_config = SettingsConfigDict(
        env_file=".env.local",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the singleton Settings instance (created once at first call)."""
    return Settings()
