"""SENTINEL AI — FastAPI application with lifespan, CORS, and router mounting."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler

# ── Log Rotation (10 MB max, 5 backups) ─────────────────────────
_log_dir = os.path.join(os.path.dirname(__file__), "..")
_log_file = os.path.join(_log_dir, "backend.log")
_file_handler = RotatingFileHandler(_log_file, maxBytes=10_000_000, backupCount=5)
_file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
logging.getLogger().addHandler(_file_handler)

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.config import settings

# ── Structured Logging ────────────────────────────────────────

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.dev.set_exc_info,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.dev.ConsoleRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(
        logging.getLevelName(settings.LOG_LEVEL)
    ),
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()

# ── Background task handle ────────────────────────────────────
_monitor_task: asyncio.Task | None = None
_stream_task: asyncio.Task | None = None
_expiration_task: asyncio.Task | None = None
_threat_intel_task: asyncio.Task | None = None
_schedule_task: asyncio.Task | None = None
_clip_pipeline_task: asyncio.Task | None = None
_auto_recorder_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown sequence."""
    global _monitor_task, _stream_task, _expiration_task, _threat_intel_task, _schedule_task

    logger.info("sentinel.startup", app=settings.APP_NAME, env=settings.APP_ENV)

    # 1. Run DB migrations (via Alembic programmatically)
    try:
        from alembic.config import Config as AlembicConfig
        from alembic import command as alembic_cmd
        import os

        alembic_ini = os.path.join(os.path.dirname(__file__), "..", "alembic.ini")
        if os.path.exists(alembic_ini):
            alembic_cfg = AlembicConfig(alembic_ini)
            alembic_cmd.upgrade(alembic_cfg, "head")
            logger.info("sentinel.migrations", status="applied")
    except Exception as e:
        logger.warning("sentinel.migrations", status="skipped", error=str(e))

    # 2. Create tables directly as fallback
    try:
        from backend.database import engine, Base
        from backend.models import models  # noqa: ensure models imported
        try:
            from backend.models import phase2b_models  # noqa: Phase 2B tables
        except Exception:
            pass
        try:
            from backend.models import phase3_models  # noqa: Phase 3 tables
        except Exception:
            pass
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("sentinel.tables", status="ensured")
    except Exception as e:
        logger.error("sentinel.tables", status="failed", error=str(e))

    # 3-4. Initialize Qdrant, sync threat engine, seed admin (parallel)
    async def _init_qdrant():
        try:
            from backend.services.vector_store import vector_store
            vector_store.initialize()
            logger.info("sentinel.qdrant", status="initialized")
        except Exception as e:
            logger.warning("sentinel.qdrant", status="skipped", error=str(e))

    async def _init_threat_engine():
        try:
            from backend.services.threat_engine import ThreatEngine
            te = ThreatEngine()
            await te.sync_from_db()
            logger.info("sentinel.threat_engine", status="synced", signatures=te.get_signature_count())
        except Exception as e:
            logger.warning("sentinel.threat_engine", status="skipped", error=str(e))

    async def _seed_admin():
        try:
            from backend.database import async_session
            from backend.models import User
            from backend.models.models import UserRole
            from backend.api.auth import hash_password
            from sqlalchemy import select
            async with async_session() as session:
                result = await session.execute(
                    select(User).where(User.email == settings.DEFAULT_ADMIN_EMAIL)
                )
                if not result.scalar_one_or_none():
                    admin = User(
                        email=settings.DEFAULT_ADMIN_EMAIL,
                        hashed_password=hash_password(settings.DEFAULT_ADMIN_PASSWORD),
                        full_name="System Administrator",
                        role=UserRole.ADMIN,
                    )
                    session.add(admin)
                    await session.commit()
                    logger.info("sentinel.seed", user=settings.DEFAULT_ADMIN_EMAIL)
                else:
                    logger.info("sentinel.seed", status="admin_exists")
        except Exception as e:
            logger.warning("sentinel.seed", status="skipped", error=str(e))

    await asyncio.gather(_init_qdrant(), _init_threat_engine(), _seed_admin())

    # 4b. Preload YOLO models to avoid cold-start latency
    try:
        from backend.services.yolo_detector import preload as yolo_preload
        yolo_preload()
        logger.info("sentinel.yolo_preload", status="complete")
    except Exception as e:
        logger.warning("sentinel.yolo_preload", status="skipped", error=str(e))

    # 5. Enumerate webcams, register in DB, and start capture
    try:
        from backend.services.video_capture import capture_manager
        import uuid as _uuid

        webcams = capture_manager.enumerate_webcams()
        logger.info("sentinel.webcams", found=len(webcams), devices=webcams)

        # Phase A: Try to register cameras in the database
        cam_id_map: dict[str, str] = {}  # source -> camera_id
        try:
            from backend.database import async_session
            from backend.models import Camera
            from backend.models.models import CameraStatus
            from sqlalchemy import select

            async with async_session() as session:
                for cam in webcams:
                    idx = cam["index"]
                    source_str = str(idx)
                    cam_name = f"Webcam {idx}"

                    existing = await session.execute(
                        select(Camera).where(Camera.source == source_str)
                    )
                    db_cam = existing.scalar_one_or_none()

                    if db_cam is None:
                        db_cam = Camera(
                            name=cam_name,
                            source=source_str,
                            location="Local",
                            status=CameraStatus.ONLINE,
                            fps=15,
                            resolution=cam.get("resolution", "640x480"),
                            is_active=True,
                        )
                        session.add(db_cam)
                        await session.flush()
                        logger.info("sentinel.camera.registered", name=cam_name, id=str(db_cam.id))
                    else:
                        db_cam.status = CameraStatus.ONLINE
                        logger.info("sentinel.camera.existing", name=db_cam.name, id=str(db_cam.id))

                    cam_id_map[source_str] = str(db_cam.id)

                # Mark webcam-type cameras that aren't physically present as OFFLINE
                enumerated_sources = {str(c["index"]) for c in webcams}
                all_db = await session.execute(
                    select(Camera).where(Camera.is_active.is_(True))
                )
                for db_cam in all_db.scalars().all():
                    # Only set webcam sources (digit-only) offline if not detected
                    if db_cam.source.isdigit() and db_cam.source not in enumerated_sources:
                        db_cam.status = CameraStatus.OFFLINE
                        logger.info("sentinel.camera.offline", name=db_cam.name, id=str(db_cam.id))

                await session.commit()
        except Exception as db_err:
            logger.warning("sentinel.webcams.db", status="skipped", error=str(db_err))

        # Phase B: Start camera capture for physically available webcams
        for cam in webcams:
            idx = cam["index"]
            source_str = str(idx)
            cam_id = cam_id_map.get(source_str) or str(_uuid.uuid4())
            cam_name = f"Webcam {idx}"

            stream = capture_manager.add_camera(
                camera_id=cam_id,
                source=source_str,
                fps=15,
            )
            if stream.start():
                logger.info("sentinel.camera.streaming", name=cam_name, source=source_str, id=cam_id)
            else:
                logger.warning("sentinel.camera.failed", name=cam_name, source=source_str)

        # Phase C: Start non-webcam cameras that are marked ONLINE in DB
        try:
            from backend.database import async_session as _as
            async with _as() as session:
                result = await session.execute(
                    select(Camera).where(
                        Camera.is_active.is_(True),
                        Camera.status == CameraStatus.ONLINE,
                    )
                )
                for db_cam in result.scalars().all():
                    cam_id_str = str(db_cam.id)
                    if capture_manager.get_stream(cam_id_str) is not None:
                        continue  # Already started (e.g., webcam)
                    stream = capture_manager.add_camera(
                        camera_id=cam_id_str,
                        source=db_cam.source,
                        fps=db_cam.fps or 15,
                    )
                    if stream.start():
                        logger.info("sentinel.camera.streaming", name=db_cam.name, source=db_cam.source, id=cam_id_str)
                    else:
                        db_cam.status = CameraStatus.ERROR
                        logger.warning("sentinel.camera.failed", name=db_cam.name, source=db_cam.source)
                await session.commit()
        except Exception as e:
            logger.warning("sentinel.cameras.non_webcam", status="skipped", error=str(e))

    except Exception as e:
        logger.warning("sentinel.webcams", status="skipped", error=str(e))

    # 6. Initialize and start multi-agent system
    try:
        from backend.agents.agent_registry import agent_registry
        from backend.agents.consolidated_registry import setup_consolidated_agents
        setup_consolidated_agents()
        await agent_registry.start_all()
        logger.info("sentinel.agents", status="started", count=len(agent_registry.all_agents))
    except Exception as e:
        logger.error("sentinel.agents", status="FAILED", error=str(e))

    # 7. Start monitoring agent (background)
    try:
        from backend.agents.monitoring_agent import monitoring_agent
        _monitor_task = asyncio.create_task(monitoring_agent.start_monitoring())
        logger.info("sentinel.monitoring", status="started")
    except Exception as e:
        logger.warning("sentinel.monitoring", status="skipped", error=str(e))

    # 8. Start frame broadcast (background)
    try:
        from backend.api.ws import stream_all_cameras
        _stream_task = asyncio.create_task(stream_all_cameras())
        logger.info("sentinel.streaming", status="started")
    except Exception as e:
        logger.warning("sentinel.streaming", status="skipped", error=str(e))

    # 9. Start HITL pending action expiration checker (background)
    try:
        async def _check_expirations_loop():
            while True:
                try:
                    from backend.services.pending_action_service import pending_action_service
                    await pending_action_service.check_expirations()
                except Exception as e:
                    logger.debug("expiration_check.error", error=str(e))
                await asyncio.sleep(30)

        _expiration_task = asyncio.create_task(_check_expirations_loop())
        logger.info("sentinel.expiration_checker", status="started")
    except Exception as e:
        logger.warning("sentinel.expiration_checker", status="skipped", error=str(e))

    # 10. Start threat intel feed polling (background)
    try:
        from backend.services.threat_intel_service import threat_intel_service
        _threat_intel_task = asyncio.create_task(threat_intel_service.poll_external_feeds())
        logger.info("sentinel.threat_intel_polling", status="started")
    except Exception as e:
        logger.warning("sentinel.threat_intel_polling", status="skipped", error=str(e))

    # 11. Start adaptive schedule checker (background)
    try:
        async def _check_schedule_loop():
            while True:
                try:
                    from backend.services.operation_mode import operation_mode_service
                    await operation_mode_service.check_and_apply_schedule()
                except Exception as e:
                    logger.debug("schedule_check.error", error=str(e))
                await asyncio.sleep(60)

        _schedule_task = asyncio.create_task(_check_schedule_loop())
        logger.info("sentinel.schedule_checker", status="started")
    except Exception as e:
        logger.warning("sentinel.schedule_checker", status="skipped", error=str(e))

    # ── CLIP Embedding Pipeline ────────────────────────────────
    global _clip_pipeline_task
    try:
        from backend.services.clip_pipeline import clip_pipeline
        _clip_pipeline_task = asyncio.create_task(clip_pipeline.start())
        logger.info("sentinel.clip_pipeline", status="started")
    except Exception as e:
        logger.warning("sentinel.clip_pipeline", status="skipped", error=str(e))

    # ── Auto Video Recording ────────────────────────────────────
    global _auto_recorder_task
    try:
        from backend.services.auto_recorder import auto_recorder
        _auto_recorder_task = asyncio.create_task(auto_recorder.start())
        logger.info("sentinel.auto_recorder", status="started")
    except Exception as e:
        logger.warning("sentinel.auto_recorder", status="skipped", error=str(e))

    # ── Startup summary ────────────────────────────────────────
    _startup_services = {
        "tables": "sentinel.tables",
        "qdrant": "sentinel.qdrant",
        "agents": "sentinel.agents",
        "monitoring": "sentinel.monitoring",
        "streaming": "sentinel.streaming",
        "clip_pipeline": "sentinel.clip_pipeline",
    }
    logger.info("sentinel.ready", message="SENTINEL AI is operational")

    yield  # ── App is running ──

    # ── Shutdown ──
    logger.info("sentinel.shutdown", message="Shutting down...")

    if _monitor_task:
        _monitor_task.cancel()
    if _stream_task:
        _stream_task.cancel()
    if _expiration_task:
        _expiration_task.cancel()
    if _threat_intel_task:
        _threat_intel_task.cancel()

    # Stop auto-recorder
    try:
        from backend.services.auto_recorder import auto_recorder
        await auto_recorder.stop()
    except Exception:
        pass

    # Stop CLIP pipeline
    try:
        from backend.services.clip_pipeline import clip_pipeline
        await clip_pipeline.stop()
    except Exception:
        pass

    try:
        from backend.agents.agent_registry import agent_registry
        await agent_registry.stop_all()
        logger.info("sentinel.agents", status="stopped")
    except Exception:
        pass

    try:
        from backend.services.video_capture import capture_manager
        capture_manager.stop_all()
    except Exception:
        pass

    try:
        from backend.database import engine
        await engine.dispose()
    except Exception:
        pass

    logger.info("sentinel.shutdown", status="complete")


# ── App ───────────────────────────────────────────────────────

app = FastAPI(
    title=settings.APP_NAME,
    description="Agentic Physical Security Intelligence Platform",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate Limiting
try:
    from backend.middleware.rate_limit import RateLimitMiddleware
    app.add_middleware(RateLimitMiddleware)
except Exception as _rl_err:
    pass  # Rate limiting not available


# ── Audit Logging Middleware ──────────────────────────────────

@app.middleware("http")
async def audit_log_middleware(request: Request, call_next):
    response = await call_next(request)

    # Log non-GET mutations for audit trail
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        try:
            from backend.database import async_session
            from backend.models import AuditLog

            async with async_session() as session:
                log_entry = AuditLog(
                    action=f"{request.method} {request.url.path}",
                    resource_type=request.url.path.split("/")[2] if len(request.url.path.split("/")) > 2 else None,
                    ip_address=request.client.host if request.client else None,
                    details={"status_code": response.status_code},
                )
                session.add(log_entry)
                await session.commit()
        except Exception:
            pass  # Don't fail requests due to audit logging

    return response


# ── Global Exception Handler ─────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("unhandled_error", path=request.url.path, error=str(exc))
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


# ── Mount Routers ────────────────────────────────────────────

from backend.api.auth import router as auth_router
from backend.api.ws import router as ws_router

app.include_router(auth_router)
app.include_router(ws_router)

# Lazy-mount optional routers (graceful if files missing during dev)
_optional_routers = [
    ("backend.api.cameras", "router"),
    ("backend.api.zones", "router"),
    ("backend.api.alerts", "router"),
    ("backend.api.cases", "router"),
    ("backend.api.search", "router"),
    ("backend.api.forensics", "router"),
    ("backend.api.analytics", "router"),
    ("backend.api.agents", "router"),
    ("backend.api.threat_config", "router"),
    ("backend.api.lpr", "router"),
    ("backend.api.audio", "router"),
    ("backend.api.copilot", "router"),
    ("backend.api.environmental", "router"),
    ("backend.api.reid", "router"),
    ("backend.api.threat_intel", "router"),
    ("backend.api.compliance", "router"),
    ("backend.api.evidence", "router_cases"),
    ("backend.api.evidence", "upload_router"),
    ("backend.api.operation_mode", "router"),
    ("backend.api.incident_replay", "router"),
    ("backend.api.tamper", "router"),
    ("backend.api.webhooks", "router"),
    ("backend.api.slack_commands", "router"),
    ("backend.api.video_summary", "router"),
    ("backend.api.threat_signatures", "router"),
    # Phase 2 routers
    ("backend.api.bolo", "router"),
    ("backend.api.shift_logbook", "router"),
    ("backend.api.patrol", "router"),
    ("backend.api.vip", "router"),
    ("backend.api.insider_threat", "router"),
    ("backend.api.pacs", "router"),
    ("backend.api.pacs", "ac_router"),
    ("backend.api.sop", "router"),
    ("backend.api.dispatch_view", "router"),
    ("backend.api.companion", "router"),
    ("backend.api.global_overwatch", "router"),
    ("backend.api.link_analysis", "router"),
    ("backend.api.crowd_protocols", "router"),
    ("backend.api.visual_search", "router"),
    ("backend.api.video_archive", "router"),
    ("backend.api.threat_response", "router"),
    ("backend.api.emergency_services", "router"),
    # Intelligence layer
    ("backend.api.intelligence", "router"),
    # GIS / Mapping
    ("backend.api.gis", "router"),
    # Physical security integrations
    ("backend.api.alarm_panels", "router"),
    ("backend.api.vms", "router"),
    ("backend.api.iot_sensors", "router"),
    ("backend.api.intercom", "router"),
    # SSO / Identity
    ("backend.api.sso", "router"),
    # Evidence chain-of-custody
    ("backend.api.evidence_chain", "router"),
    # Production infrastructure
    ("backend.api.health", "router"),
    # Phase 2B routers
    ("backend.api.incidents", "router"),
    ("backend.api.visitors", "router"),
    ("backend.api.mass_notifications", "router"),
    ("backend.api.forensic_search", "router"),
    ("backend.api.behavioral_analytics", "router"),
    ("backend.api.video_wall", "router"),
    ("backend.api.floor_plan_engine", "router"),
    ("backend.api.privacy", "router"),
    ("backend.api.siem", "router"),
    ("backend.api.multi_site", "router"),
    ("backend.api.soc_workspace", "router"),
    ("backend.api.lpr_enhanced", "router"),
    # Phase 3 routers — Context-Aware Intelligence & Agentic Ops
    ("backend.api.context_intelligence", "router"),
    ("backend.api.baselines", "router"),
    ("backend.api.intent_classification", "router"),
    ("backend.api.alarm_correlation", "router"),
    ("backend.api.feedback", "router"),
    ("backend.api.agentic_investigation", "router"),
    ("backend.api.agentic_video_wall", "router"),
    ("backend.api.nl_alerts", "router"),
    ("backend.api.entity_tracking", "router"),
    ("backend.api.weapon_detection", "router"),
    ("backend.api.safety_detection", "router"),
    ("backend.api.silhouette", "router"),
    ("backend.api.compliance_dashboard", "router"),
    # ONVIF camera integration
    ("backend.api.onvif", "router"),
    # Settings system actions
    ("backend.api.settings", "router"),
    # Industry templates & guided setup
    ("backend.api.setup", "router"),
    # Emergency codes — no auth, must always work
    ("backend.api.emergency", "router"),
    # License management & multi-tenancy
    ("backend.api.license", "router"),
    ("backend.api.license", "admin_router"),
    # Advanced integrations — elevators, BMS, body cameras, compliance audit
    ("backend.api.building_systems", "router"),
]

for module_path, attr in _optional_routers:
    try:
        import importlib
        mod = importlib.import_module(module_path)
        app.include_router(getattr(mod, attr))
    except Exception as e:
        import traceback
        print(f"ROUTER SKIP: {module_path} -> {e}")
        traceback.print_exc()
        logger.warning("router.skip", module=module_path, error=str(e))


# ── Health Check ──────────────────────────────────────────────

@app.get("/health")
async def health():
    checks = {"app": settings.APP_NAME, "env": settings.APP_ENV}
    status = "healthy"

    # DB check
    try:
        from backend.database import engine as _db_engine
        from sqlalchemy import text
        async with _db_engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "down"
        status = "degraded"

    # Redis check
    try:
        import redis.asyncio as aioredis
        from backend.config import settings as s
        r = aioredis.from_url(s.REDIS_URL)
        await r.ping()
        await r.aclose()
        checks["redis"] = "ok"
    except Exception:
        checks["redis"] = "down"
        status = "degraded"

    # Cameras
    try:
        from backend.services.video_capture import capture_manager
        streams = capture_manager.list_streams()
        active = sum(1 for st in streams.values() if st.is_running)
        checks["cameras"] = {"total": len(streams), "active": active}
    except Exception:
        checks["cameras"] = "unavailable"

    # Agents
    try:
        from backend.agents.agent_registry import agent_registry
        agents = agent_registry.all_agents
        checks["agents"] = {"total": len(agents), "running": sum(1 for a in agents.values() if a.is_running)}
    except Exception:
        checks["agents"] = "unavailable"

    checks["status"] = status
    return checks


@app.get("/api/status")
async def system_status():
    from backend.services.video_capture import capture_manager
    from backend.services.notification_service import ws_manager

    streams = capture_manager.list_streams()
    return {
        "status": "operational",
        "cameras": {
            "total": len(streams),
            "active": sum(1 for s in streams.values() if s.is_running),
        },
        "websockets": {
            "connections": ws_manager.active_count,
            "channels": ws_manager.channel_counts,
        },
    }
