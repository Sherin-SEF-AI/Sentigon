"""Phase 3E: Compliance Dashboard API — privacy compliance scoring, PIA, data flows."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
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
