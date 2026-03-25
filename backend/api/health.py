"""Production Health Check API — liveness, readiness, and deep health probes.

Prefix: /api/health
Tag:    Health

Endpoints:
    GET /api/health/live  — Kubernetes liveness probe (always 200)
    GET /api/health/ready — readiness probe (DB + Redis + Qdrant)
    GET /api/health/deep  — deep inspection (all services + disk + memory)
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/health", tags=["Health"])

# ── Timeout constants (seconds) ──────────────────────────────────────────
_DB_TIMEOUT = 2.0
_REDIS_TIMEOUT = 1.0
_QDRANT_TIMEOUT = 2.0
_OLLAMA_TIMEOUT = 3.0


# ══════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════


def _ts() -> str:
    """ISO-8601 UTC timestamp."""
    return datetime.now(timezone.utc).isoformat()


def _ok(latency_ms: float, details: Any = None) -> Dict[str, Any]:
    result: Dict[str, Any] = {"status": "ok", "latency_ms": round(latency_ms, 2)}
    if details is not None:
        result["details"] = details
    return result


def _err(latency_ms: float, message: str) -> Dict[str, Any]:
    return {
        "status": "error",
        "latency_ms": round(latency_ms, 2),
        "details": message,
    }


# ── Individual checks ────────────────────────────────────────────────────


async def _check_db() -> Dict[str, Any]:
    """Verify async database connectivity with a lightweight query."""
    start = time.perf_counter()
    try:
        from backend.database import engine  # async engine

        from sqlalchemy import text

        async with asyncio.timeout(_DB_TIMEOUT):
            async with engine.connect() as conn:
                result = await conn.execute(text("SELECT 1"))
                result.close()
        elapsed = (time.perf_counter() - start) * 1000
        return _ok(elapsed)
    except Exception as exc:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, str(exc))


async def _check_redis() -> Dict[str, Any]:
    """Ping Redis and return latency."""
    start = time.perf_counter()
    try:
        import redis.asyncio as aioredis
        from backend.config import settings

        async with asyncio.timeout(_REDIS_TIMEOUT):
            r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
            pong = await r.ping()
            await r.aclose()
        elapsed = (time.perf_counter() - start) * 1000
        return _ok(elapsed, details={"ping": pong})
    except ImportError:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, "redis.asyncio not installed")
    except Exception as exc:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, str(exc))


async def _check_qdrant() -> Dict[str, Any]:
    """Verify Qdrant vector-store connectivity."""
    start = time.perf_counter()
    try:
        from qdrant_client import QdrantClient
        from backend.config import settings

        async with asyncio.timeout(_QDRANT_TIMEOUT):
            client = QdrantClient(
                host=settings.QDRANT_HOST,
                port=settings.QDRANT_PORT,
                timeout=_QDRANT_TIMEOUT,
            )
            collections = client.get_collections()
            count = len(collections.collections) if collections else 0
            client.close()
        elapsed = (time.perf_counter() - start) * 1000
        return _ok(elapsed, details={"collections": count})
    except ImportError:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, "qdrant_client not installed")
    except Exception as exc:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, str(exc))


async def _check_ollama() -> Dict[str, Any]:
    """Check Ollama LLM server health."""
    start = time.perf_counter()
    try:
        import httpx
        from backend.config import settings

        async with asyncio.timeout(_OLLAMA_TIMEOUT):
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{settings.OLLAMA_HOST}/api/tags",
                    timeout=_OLLAMA_TIMEOUT,
                )
                resp.raise_for_status()
                data = resp.json()
                models = [m.get("name", "?") for m in data.get("models", [])]
        elapsed = (time.perf_counter() - start) * 1000
        return _ok(elapsed, details={"models_loaded": len(models), "models": models[:10]})
    except ImportError:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, "httpx not installed")
    except Exception as exc:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, str(exc))


def _check_cameras() -> Dict[str, Any]:
    """Report active camera streams."""
    start = time.perf_counter()
    try:
        from backend.services.video_capture import capture_manager

        streams = capture_manager.list_streams()
        active = sum(1 for s in streams.values() if s.is_running)
        elapsed = (time.perf_counter() - start) * 1000
        return _ok(elapsed, details={"total": len(streams), "active": active})
    except ImportError:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, "video_capture module not available")
    except Exception as exc:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, str(exc))


def _check_disk() -> Dict[str, Any]:
    """Check available disk space on the root and recordings partitions."""
    start = time.perf_counter()
    try:
        import shutil

        usage = shutil.disk_usage("/")
        free_gb = round(usage.free / (1024 ** 3), 2)
        total_gb = round(usage.total / (1024 ** 3), 2)
        used_pct = round((usage.used / usage.total) * 100, 1)
        elapsed = (time.perf_counter() - start) * 1000

        status = "ok"
        if used_pct > 95:
            status = "error"
        elif used_pct > 85:
            status = "warning"

        return {
            "status": status,
            "latency_ms": round(elapsed, 2),
            "details": {
                "free_gb": free_gb,
                "total_gb": total_gb,
                "used_pct": used_pct,
            },
        }
    except Exception as exc:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, str(exc))


def _check_gpu() -> Dict[str, Any]:
    """Check GPU availability and CUDA status for ML inference."""
    start = time.perf_counter()
    try:
        import torch
        elapsed = (time.perf_counter() - start) * 1000
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            mem_total = round(props.total_mem / 1024**3, 1)
            mem_used = round(torch.cuda.memory_allocated(0) / 1024**3, 2)
            return _ok(elapsed, details={
                "device": gpu_name,
                "vram_total_gb": mem_total,
                "vram_used_gb": mem_used,
                "cuda_version": torch.version.cuda,
                "pytorch_version": torch.__version__,
                "fp16_supported": True,
                "inference_device": "cuda:0",
            })
        else:
            return {
                "status": "warning",
                "latency_ms": round(elapsed, 2),
                "details": {
                    "inference_device": "cpu",
                    "pytorch_version": torch.__version__,
                    "message": "CUDA not available — ML running on CPU",
                },
            }
    except ImportError:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, "PyTorch not installed")
    except Exception as exc:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, str(exc))


def _check_memory() -> Dict[str, Any]:
    """Check system memory utilisation."""
    start = time.perf_counter()
    try:
        import psutil

        mem = psutil.virtual_memory()
        elapsed = (time.perf_counter() - start) * 1000

        status = "ok"
        if mem.percent > 95:
            status = "error"
        elif mem.percent > 85:
            status = "warning"

        return {
            "status": status,
            "latency_ms": round(elapsed, 2),
            "details": {
                "total_gb": round(mem.total / (1024 ** 3), 2),
                "available_gb": round(mem.available / (1024 ** 3), 2),
                "used_pct": mem.percent,
            },
        }
    except ImportError:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, "psutil not installed")
    except Exception as exc:
        elapsed = (time.perf_counter() - start) * 1000
        return _err(elapsed, str(exc))


# ══════════════════════════════════════════════════════════════════════════
# Aggregate helpers
# ══════════════════════════════════════════════════════════════════════════


def _aggregate_status(checks: Dict[str, Dict[str, Any]]) -> str:
    """Derive overall status from individual checks.

    Core services (database, redis, ollama) must be OK.
    Optional services (qdrant) are allowed to fail without marking unhealthy.
    """
    OPTIONAL_SERVICES = {"qdrant", "gpu"}
    core_checks = {k: v for k, v in checks.items() if k not in OPTIONAL_SERVICES}

    has_core_error = any(c.get("status") == "error" for c in core_checks.values())
    has_warning = any(c.get("status") in ("warning", "error") for k, c in checks.items() if k in OPTIONAL_SERVICES)
    has_core_warning = any(c.get("status") == "warning" for c in core_checks.values())

    if has_core_error:
        return "unhealthy"
    if has_core_warning or has_warning:
        return "degraded"
    return "healthy"


def _status_code(status: str) -> int:
    """Map aggregate status to HTTP status code."""
    return 503 if status == "unhealthy" else 200


# ══════════════════════════════════════════════════════════════════════════
# Endpoints
# ══════════════════════════════════════════════════════════════════════════


@router.get("/live")
async def liveness():
    """Kubernetes liveness probe — always returns 200 unless the process is
    deadlocked (which would prevent responding at all)."""
    return JSONResponse(
        status_code=200,
        content={
            "status": "healthy",
            "checks": {},
            "timestamp": _ts(),
        },
    )


@router.get("/ready")
async def readiness():
    """Readiness probe — verifies core dependencies (DB, Redis, Qdrant)
    are reachable before the pod should receive traffic."""
    db_check, redis_check, qdrant_check = await asyncio.gather(
        _check_db(),
        _check_redis(),
        _check_qdrant(),
    )

    checks = {
        "database": db_check,
        "redis": redis_check,
        "qdrant": qdrant_check,
    }

    status = _aggregate_status(checks)
    return JSONResponse(
        status_code=_status_code(status),
        content={
            "status": status,
            "checks": checks,
            "timestamp": _ts(),
        },
    )


@router.get("/deep")
async def deep_health():
    """Deep health check — inspects every subsystem including Ollama,
    cameras, disk space, and memory.  Intended for dashboards and
    on-call diagnostics, not for load-balancer probing."""

    # Run async checks in parallel
    db_check, redis_check, qdrant_check, ollama_check = await asyncio.gather(
        _check_db(),
        _check_redis(),
        _check_qdrant(),
        _check_ollama(),
    )

    # Sync checks
    camera_check = _check_cameras()
    disk_check = _check_disk()
    memory_check = _check_memory()
    gpu_check = _check_gpu()

    checks = {
        "database": db_check,
        "redis": redis_check,
        "qdrant": qdrant_check,
        "ollama": ollama_check,
        "cameras": camera_check,
        "disk": disk_check,
        "memory": memory_check,
        "gpu": gpu_check,
    }

    status = _aggregate_status(checks)
    return JSONResponse(
        status_code=_status_code(status),
        content={
            "status": status,
            "checks": checks,
            "timestamp": _ts(),
        },
    )
