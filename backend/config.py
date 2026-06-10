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

    # Model tiers — intelligent routing.
    # Defaults are LOCAL Ollama models so the system is fully functional out of
    # the box without a .env. Override per-deployment as needed.
    # Tier 1: Heavy reasoning (investigations, forensics, copilot)
    OLLAMA_REASONING_MODEL: str = "qwen2.5:7b"
    # Tier 2: Standard tasks (perception agents, text analysis)
    OLLAMA_STANDARD_MODEL: str = "qwen2.5:7b"
    # Tier 3: Vision analysis (frame analysis, image understanding)
    OLLAMA_VISION_MODEL: str = "qwen2.5vl:7b"
    # Tier 4: Fast/lightweight (quick classifications, simple responses)
    OLLAMA_FAST_MODEL: str = "qwen2.5:7b"
    # Fallback models (tried in order if primary fails) — stays local.
    OLLAMA_FALLBACK_MODELS: str = "qwen2.5:7b"

    # Legacy alias
    OLLAMA_TEXT_MODEL: str = "qwen2.5:7b"

    # ── AI Provider ────────────────────────────────────────
    # LOCAL-FIRST by default: all AI runs through Ollama. Cloud (Gemini) is an
    # optional opt-in — set AI_PROVIDER=gemini, GEMINI_ENABLED=true and supply
    # GEMINI_API_KEY to enable the cloud path (with automatic Ollama fallback).
    AI_PROVIDER: str = "ollama"
    # No hardcoded key: supply via GEMINI_API_KEY env var. Any committed key is compromised.
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.1-flash-lite-preview"  # Fast, cheap — agents/perception
    GEMINI_STANDARD_MODEL: str = "gemini-3-flash-preview"  # Standard — analysis/copilot
    GEMINI_PRO_MODEL: str = "gemini-3.1-pro-preview"  # Deep reasoning — investigations
    GEMINI_RATE_LIMIT: int = 10  # Max requests per minute (safe limit to prevent suspension)
    # Cloud disabled by default — flip to true (with a key) to use Gemini as primary.
    GEMINI_ENABLED: bool = False

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
    # Cross-camera re-ID appearance embedding: when True, use a CLIP crop
    # embedding (richer/more robust) instead of the fast HSV colour histogram.
    # Off by default (CLIP is heavyweight); enable on GPU-backed deployments.
    REID_USE_CLIP: bool = False

    # ── GPU / CUDA ─────────────────────────────────────────
    YOLO_DEVICE: str = "auto"  # "auto" | "cpu" | "cuda" | "cuda:0"
    GPU_HALF_PRECISION: bool = True  # FP16 for faster inference on RTX cards

    # ── Object detector (pluggable) ────────────────────────
    # DETECTOR_TYPE selects the backbone; all are ultralytics-native:
    #   "rtdetr"     — RT-DETR transformer, NMS-free, strong on small/occluded
    #                  objects (default). DETECTOR_MODEL e.g. rtdetr-l.pt
    #   "yolo-world" — open-vocabulary: detects OPEN_VOCAB_CLASSES by text prompt
    #   "yolo11" / "yolov8" — classic YOLO (yolo11m.pt / yolov8n.pt)
    DETECTOR_TYPE: str = "rtdetr"
    DETECTOR_MODEL: str = "rtdetr-l.pt"   # empty → derived from DETECTOR_TYPE
    YOLO_CONFIDENCE: float = 0.35
    TRACKER_CONFIG: str = "botsort.yaml"  # BoT-SORT re-ID (vs "bytetrack.yaml")
    # Open-vocabulary threat prompts (used only when DETECTOR_TYPE="yolo-world").
    OPEN_VOCAB_CLASSES: list = [
        "person", "car", "truck", "bus", "motorcycle", "bicycle",
        "knife", "gun", "rifle", "pistol", "weapon",
        "fire", "smoke",
        "backpack", "handbag", "suitcase",
        "person lying on the ground", "person climbing a fence",
    ]
    POSE_MODEL: str = "yolov8n-pose.pt"   # bumped in increment 2

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
    # Rate limiting can be disabled (e.g. in tests) to avoid 429s under load.
    RATE_LIMIT_ENABLED: bool = True

    # Persistence (corroboration) gate: a non-critical threat must recur for the
    # same camera+signature before it raises an alert — kills single-frame
    # false positives. critical/high bypass. Disable to alert on first sighting.
    PERSISTENCE_GATE_ENABLED: bool = True
    PERSISTENCE_MIN_OCCURRENCES: int = 2
    PERSISTENCE_WINDOW_SECONDS: float = 10.0

    # Minimum confidence a threat must reach before it is persisted as an
    # event/alert. Filters low-confidence hallucinations (e.g. a vision model
    # loosely mentioning a threat word) so only genuine detections surface.
    MIN_THREAT_CONFIDENCE: float = 0.6
    LOG_LEVEL: str = "INFO"
    # Echo every SQL statement (with bound parameters) to the logs. Off by
    # default — it is extremely verbose and leaks PII into logs. Enable only for
    # local query debugging.
    SQL_ECHO: bool = False
    CORS_ORIGINS: str = '["http://localhost:3000","http://localhost:3737","http://localhost:8000"]'

    # ── Celery ────────────────────────────────────────────────
    CELERY_BROKER_URL: str = "redis://localhost:6379/1"

    # ── Video ─────────────────────────────────────────────────
    MAX_CAMERAS: int = 16
    FRAME_BUFFER_SIZE: int = 30
    DEFAULT_FPS: int = 15
    # Live detection uses the verified-vision pipeline: structured scene
    # intelligence + an adversarial verifier, so only threats a skeptic confirms
    # against the frame become alerts (hallucination-resistant). Set False to
    # fall back to the legacy keyword scene analyzer.
    VISION_VERIFIED_DETECTION: bool = True

    # Run AI threat analysis on local USB/laptop webcams (digit-only sources).
    # Off by default: a laptop webcam pointed at a desk is not a security feed,
    # and analysing it only produces hallucinated detections. Webcams still
    # stream to the video wall; real network cameras (RTSP/ONVIF URLs) are
    # always analysed regardless of this flag.
    WEBCAM_MONITORING_ENABLED: bool = False

    # ── Auto Recording ──────────────────────────────────────
    AUTO_RECORD_ENABLED: bool = True
    AUTO_RECORD_CHUNK_MINUTES: int = 5
    AUTO_RECORD_DIR: str = "recordings/auto"
    AUTO_RECORD_RETENTION_HOURS: int = 72  # auto-delete chunks older than this

    # ── Autonomous Threat Response ────────────────────────────
    # Off by default: the pipeline can take real outward actions (recording, SOP
    # activation, emergency-services lookup, operator notification). Enable only
    # deliberately. Even when enabled, SHADOW_MODE logs the planned actions
    # without executing them, and responses are skipped below CONFIDENCE_MIN so a
    # hallucinated low-confidence detection cannot trigger real actions.
    AUTONOMOUS_RESPONSE_ENABLED: bool = False
    AUTONOMOUS_RESPONSE_CONFIDENCE_MIN: float = 0.75
    AUTONOMOUS_RESPONSE_SHADOW_MODE: bool = True
    # How often the red-team agent runs an adversarial probe (seconds). Hourly by
    # default — every 5 min was alert-fatigue noise.
    RED_TEAM_INTERVAL_SECONDS: int = 3600

    # Multi-tenant administration. Off by default: this is a single-deployment
    # product with no per-tenant data isolation, so creating additional tenants
    # is a no-op surface. Enabling it only re-exposes the tenant CRUD.
    MULTI_TENANT_ENABLED: bool = False
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
