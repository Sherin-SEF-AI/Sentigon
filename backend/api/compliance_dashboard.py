"""Phase 3E: Compliance Dashboard API — privacy compliance scoring, PIA, data flows."""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import get_db
from backend.models.phase2b_models import DataRetentionPolicy
from backend.services.compliance_dashboard_service import compliance_dashboard_service

router = APIRouter(prefix="/api/compliance-dashboard", tags=["compliance-dashboard"])


@router.post("/assess")
async def run_assessment(
    framework: str = Query("gdpr"),
    scope: str = Query("global"),
    scope_id: str = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await compliance_dashboard_service.assess_compliance(
            db, framework=framework, scope=scope, scope_id=scope_id,
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/scorecard")
async def get_scorecard(
    framework: str = Query(None),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await compliance_dashboard_service.get_scorecard(db, framework=framework)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/history")
async def compliance_history(
    framework: str = None,
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await compliance_dashboard_service.get_compliance_history(db, framework=framework, limit=limit)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/issues")
async def compliance_issues(
    severity: str = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        return await compliance_dashboard_service.get_issues(db, severity=severity)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/pia")
async def generate_pia(
    camera_id: str = None,
    zone_id: str = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        return await compliance_dashboard_service.generate_pia(
            db, camera_id=camera_id, zone_id=zone_id,
        )
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/erasure-status")
async def erasure_status(db: AsyncSession = Depends(get_db)):
    try:
        return await compliance_dashboard_service.check_erasure_status(db)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/data-flows")
async def data_flows(db: AsyncSession = Depends(get_db)):
    try:
        return await compliance_dashboard_service.get_data_flow_map(db)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/redaction-queue")
async def redaction_queue(db: AsyncSession = Depends(get_db)):
    """Pending video/face redaction tasks.

    There is no dedicated redaction-job queue model in this system —
    redaction is configured per-zone (SilhouetteConfig) and applied inline
    on export — so there is no backlog of queued redaction tasks to report.
    Returns honest zero counts rather than fabricated work items.
    """
    try:
        return {"pending": 0, "in_progress": 0, "completed": 0}
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/retention-policies")
async def retention_policies(db: AsyncSession = Depends(get_db)):
    """Configured data-retention policies.

    Returns persisted DataRetentionPolicy rows when present. If none are
    configured, derives policies from the real recording/embedding retention
    settings so the dashboard reflects actual system behaviour.
    """
    try:
        result = await db.execute(
            select(DataRetentionPolicy).where(DataRetentionPolicy.is_active == True)  # noqa: E712
        )
        policies = result.scalars().all()

        if policies:
            return [
                {
                    "id": str(p.id),
                    "name": p.name,
                    "retention_days": p.retention_days,
                    "data_type": p.data_type,
                    "last_purge": p.last_purge_at.isoformat() if p.last_purge_at else None,
                    "next_purge": (
                        (p.last_purge_at + timedelta(days=p.retention_days)).isoformat()
                        if p.last_purge_at else None
                    ),
                }
                for p in policies
            ]

        # No policies configured — derive from real retention settings.
        derived = [
            {
                "id": "recordings",
                "name": "Continuous Recordings",
                "retention_days": round(settings.AUTO_RECORD_RETENTION_HOURS / 24, 2),
                "data_type": "video_recording",
                "last_purge": None,
                "next_purge": None,
            },
            {
                "id": "embeddings",
                "name": "CLIP Frame Embeddings",
                "retention_days": round(settings.CLIP_RETENTION_HOURS / 24, 2),
                "data_type": "vector_embedding",
                "last_purge": None,
                "next_purge": None,
            },
        ]
        return derived
    except Exception as e:
        raise HTTPException(400, str(e))
