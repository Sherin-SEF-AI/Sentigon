"""Settings API — system actions: clear cache, reset analytics, export config, backup."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from backend.api.auth import get_current_user, require_role
from backend.models.models import UserRole

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ── GET /api/settings ─────────────────────────────────────────
# Returns current system configuration snapshot for export.

@router.get("")
async def get_settings(
    _user=Depends(get_current_user),
):
    """Return a snapshot of current system configuration."""
    from backend.services.operation_mode import operation_mode_service

    try:
        mode_status = await operation_mode_service.get_status()
    except Exception:
        mode_status = {}

    try:
        perf_mode = await operation_mode_service.get_performance_mode()
    except Exception:
        perf_mode = "standard"

    try:
        ai_provider = await operation_mode_service.get_ai_provider()
    except Exception:
        ai_provider = "auto"

    try:
        from backend.services.video_capture import capture_manager
        streams = capture_manager.list_streams()
        camera_count = len(streams)
        active_cameras = sum(1 for s in streams.values() if s.is_running)
    except Exception:
        camera_count = 0
        active_cameras = 0

    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "operation_mode": {
            "mode": mode_status.get("mode", "autonomous"),
            "auto_approve_timeout": mode_status.get("auto_approve_timeout", 300),
            "pending_count": mode_status.get("pending_count", 0),
        },
        "performance_mode": perf_mode,
        "ai_provider": ai_provider,
        "cameras": {
            "total": camera_count,
            "active": active_cameras,
        },
    }


# ── POST /api/settings/clear-cache ────────────────────────────

@router.post("/clear-cache")
async def clear_cache(
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Flush in-memory caches (Redis if available, internal LRU caches)."""
    results: dict = {}

    # Attempt Redis flush
    try:
        import redis.asyncio as aioredis
        from backend.config import settings

        r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        await r.flushdb()
        await r.aclose()
        results["redis"] = "flushed"
        logger.info("settings.clear_cache", redis="flushed")
    except Exception as exc:
        results["redis"] = f"skipped: {exc}"
        logger.warning("settings.clear_cache.redis", error=str(exc))

    # Clear any in-process LRU / functools caches that are registered
    try:
        import gc
        import functools
        cleared = 0
        for obj in gc.get_objects():
            if isinstance(obj, functools._lru_cache_wrapper):
                obj.cache_clear()
                cleared += 1
        results["lru_caches_cleared"] = cleared
        logger.info("settings.clear_cache.lru", count=cleared)
    except Exception as exc:
        results["lru_caches"] = f"skipped: {exc}"

    return JSONResponse(
        status_code=200,
        content={
            "message": "Cache cleared successfully",
            "details": results,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )


# ── POST /api/settings/reset-analytics ────────────────────────

@router.post("/reset-analytics")
async def reset_analytics(
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Delete all Event rows (raw analytics data). Alerts, cameras, etc. are preserved."""
    from backend.database import async_session
    from backend.models import Event
    from sqlalchemy import delete

    async with async_session() as session:
        result = await session.execute(delete(Event))
        deleted = result.rowcount
        await session.commit()

    logger.info("settings.reset_analytics", deleted=deleted)

    return JSONResponse(
        status_code=200,
        content={
            "message": f"Analytics reset: {deleted} event records removed",
            "deleted_count": deleted,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )


# ── POST /api/settings/backup ─────────────────────────────────

@router.post("/backup")
async def system_backup(
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Create a configuration backup snapshot — returns a JSON manifest of current state."""
    from backend.database import async_session
    from backend.models import Camera, Zone, Alert, User
    from sqlalchemy import select, func

    async with async_session() as session:
        cam_count = (await session.execute(select(func.count(Camera.id)))).scalar_one()
        zone_count = (await session.execute(select(func.count(Zone.id)))).scalar_one()
        alert_count = (await session.execute(select(func.count(Alert.id)))).scalar_one()
        user_count = (await session.execute(select(func.count(User.id)))).scalar_one()

    # Gather current operational config
    try:
        from backend.services.operation_mode import operation_mode_service
        mode_status = await operation_mode_service.get_status()
        perf_mode = await operation_mode_service.get_performance_mode()
        ai_provider = await operation_mode_service.get_ai_provider()
    except Exception:
        mode_status = {}
        perf_mode = "standard"
        ai_provider = "auto"

    backup_manifest = {
        "backup_created_at": datetime.now(timezone.utc).isoformat(),
        "version": "1.0",
        "record_counts": {
            "cameras": cam_count,
            "zones": zone_count,
            "alerts": alert_count,
            "users": user_count,
        },
        "configuration": {
            "operation_mode": mode_status.get("mode", "autonomous"),
            "auto_approve_timeout": mode_status.get("auto_approve_timeout", 300),
            "performance_mode": perf_mode,
            "ai_provider": ai_provider,
        },
    }

    logger.info("settings.backup", manifest=backup_manifest)

    return JSONResponse(
        status_code=200,
        content={
            "message": "System backup completed successfully",
            "manifest": backup_manifest,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )
