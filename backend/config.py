"""Application configuration via Pydantic Settings."""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parent.parent / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Database ──────────────────────────────────────────────
    DATABASE_URL: str = "postgresql+asyncpg://sentinel:sentinel_secret@localhost:5432/sentinel_ai"
    DATABASE_URL_SYNC: str = "postgresql+psycopg2://sentinel:sentinel_secret@localhost:5432/sentinel_ai"

    # ── Redis ─────────────────────────────────────────────────
    REDIS_URL: str = "redis://localhost:6379/0"

    # ── JWT ───────────────────────────────────────────────────
    # No insecure default: must be supplied via environment in any non-dev env.
    # Generate with: python -c "import secrets; print(secrets.token_hex(32))"
    JWT_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 480

    # ── Ollama AI (all models) ─────────────────────────────────
    OLLAMA_HOST: str = "http://localhost:11434"

    # Model tiers — intelligent routing
    # Tier 1: Heavy reasoning (investigations, forensics, copilot)
    OLLAMA_REASONING_MODEL: str = "gemma3:4b"
    # Tier 2: Standard tasks (perception agents, text analysis)
    OLLAMA_STANDARD_MODEL: str = "gemma3:4b"
    # Tier 3: Vision analysis (frame analysis, image understanding)
    OLLAMA_VISION_MODEL: str = "gemma3:4b"
    # Tier 4: Fast/lightweight (quick classifications, simple responses)
    OLLAMA_FAST_MODEL: str = "gemma3:4b"
    # Fallback models (tried in order if primary fails)
    OLLAMA_FALLBACK_MODELS: str = "qwen3.5:0.8b"

    # Legacy alias
    OLLAMA_TEXT_MODEL: str = "gemma3:4b"

    # ── AI Provider ────────────────────────────────────────
    AI_PROVIDER: str = "gemini"  # Primary: Gemini, Fallback: Ollama
    # No hardcoded key: supply via GEMINI_API_KEY env var. Any committed key is compromised.
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.1-flash-lite-preview"  # Fast, cheap — agents/perception
    GEMINI_STANDARD_MODEL: str = "gemini-3-flash-preview"  # Standard — analysis/copilot
    GEMINI_PRO_MODEL: str = "gemini-3.1-pro-preview"  # Deep reasoning — investigations
    GEMINI_RATE_LIMIT: int = 10  # Max requests per minute (safe limit to prevent suspension)
    GEMINI_ENABLED: bool = True

    # ── CLIP Video Embedding ──────────────────────────────
    HF_TOKEN: str = ""
    CLIP_MODEL_NAME: str = "ViT-B-32"
    CLIP_PRETRAINED: str = "laion2b_s34b_b79k"
    CLIP_EMBEDDING_DIM: int = 512
    CLIP_DEVICE: str = "auto"  # "auto" | "cpu" | "cuda"
    CLIP_EMBED_INTERVAL: int = 3  # seconds between embeddings per camera
    CLIP_BATCH_SIZE: int = 4
    CLIP_ANOMALY_THRESHOLD: float = 0.35  # cosine distance for scene change
    CLIP_ENABLED: bool = True
    CLIP_RETENTION_HOURS: int = 48  # auto-delete embeddings older than this

    # ── GPU / CUDA ─────────────────────────────────────────
    YOLO_DEVICE: str = "auto"  # "auto" | "cpu" | "cuda" | "cuda:0"
    GPU_HALF_PRECISION: bool = True  # FP16 for faster inference on RTX cards

    # ── Qdrant ────────────────────────────────────────────────
    QDRANT_HOST: str = "localhost"
    QDRANT_PORT: int = 6333
    QDRANT_COLLECTION: str = "sentinel_events"

    # ── Embedding (local sentence-transformers, not Ollama) ───
    EMBEDDING_MODEL: str = "all-MiniLM-L6-v2"
    EMBEDDING_DIM: int = 384

    # ── App ───────────────────────────────────────────────────
    APP_NAME: str = "SENTINEL AI"
    APP_ENV: str = "development"
    LOG_LEVEL: str = "INFO"
    CORS_ORIGINS: str = '["http://localhost:3000","http://localhost:3737","http://localhost:8000"]'

    # ── Celery ────────────────────────────────────────────────
    CELERY_BROKER_URL: str = "redis://localhost:6379/1"

    # ── Video ─────────────────────────────────────────────────
    MAX_CAMERAS: int = 16
    FRAME_BUFFER_SIZE: int = 30
    DEFAULT_FPS: int = 15

    # ── Auto Recording ──────────────────────────────────────
    AUTO_RECORD_ENABLED: bool = True
    AUTO_RECORD_CHUNK_MINUTES: int = 5
    AUTO_RECORD_DIR: str = "recordings/auto"
    AUTO_RECORD_RETENTION_HOURS: int = 72  # auto-delete chunks older than this

    # ── Autonomous Threat Response ────────────────────────────
    AUTONOMOUS_RESPONSE_ENABLED: bool = True
    FACILITY_LATITUDE: float = 24.7136  # Default: Riyadh
    FACILITY_LONGITUDE: float = 46.6753
    EMERGENCY_SEARCH_RADIUS_KM: float = 5.0

    # ── Slack Integration ────────────────────────────────────
    SLACK_SIGNING_SECRET: str = ""

    # ── SSO / Identity ────────────────────────────────────────
    # Disabled by default: the current SSO/LDAP implementation is a stub and
    # has mixed public/protected routes. Do NOT enable in production until it
    # is backed by a real identity provider and each route is auth-gated.
    SSO_ENABLED: bool = False

    # ── Admin seed ────────────────────────────────────────────
    # No default password: when empty, admin seeding is skipped (see lifespan).
    DEFAULT_ADMIN_EMAIL: str = "admin@sentinel.local"
    DEFAULT_ADMIN_PASSWORD: str = ""

    @property
    def cors_origin_list(self) -> List[str]:
        if isinstance(self.CORS_ORIGINS, list):
            return self.CORS_ORIGINS
        return json.loads(self.CORS_ORIGINS)

    @property
    def is_production(self) -> bool:
        return self.APP_ENV.lower() not in ("development", "dev", "local", "test")

    @model_validator(mode="after")
    def _enforce_required_secrets(self) -> "Settings":
        """Fail fast on insecure configuration outside development.

        In development we fill safe ephemeral defaults so the app still runs;
        in any other environment, required secrets MUST be supplied explicitly.
        """
        insecure_jwt = {"", "change-me-in-production"}

        if self.is_production:
            missing = []
            if self.JWT_SECRET_KEY in insecure_jwt:
                missing.append("JWT_SECRET_KEY")
            if self.GEMINI_ENABLED and not self.GEMINI_API_KEY:
                missing.append("GEMINI_API_KEY")
            if missing:
                raise ValueError(
                    "Refusing to start in '%s': missing/insecure required secrets: %s. "
                    "Set them via environment variables (see .env.example)."
                    % (self.APP_ENV, ", ".join(missing))
                )
        else:
            # Development convenience: deterministic-but-local placeholder so the
            # app boots without ceremony. NOT used in production (guarded above).
            if self.JWT_SECRET_KEY == "":
                self.JWT_SECRET_KEY = "dev-only-insecure-secret-do-not-use-in-prod"

        return self


settings = Settings()
