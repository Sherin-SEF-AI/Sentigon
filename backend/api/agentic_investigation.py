"""Phase 3C: Agentic Investigation API — NL-driven investigations and evidence packaging."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.services.agentic_investigation_service import agentic_investigation_service

router = APIRouter(prefix="/api/investigations", tags=["investigations"])


@router.post("/")
async def start_investigation(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        result = await agentic_investigation_service.start_investigation(
            db,
            query_text=data.get("query_text", ""),
            incident_id=data.get("incident_id"),
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/")
async def list_investigations(
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await agentic_investigation_service.list_investigations(db, limit=limit, offset=offset)
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/follow-subject")
async def follow_subject(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        result = await agentic_investigation_service.follow_subject(
            db,
            entity_description=data.get("entity_description", ""),
            time_range_hours=data.get("time_range_hours", 2),
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/{investigation_id}/evidence-package")
async def generate_evidence_package(investigation_id: str, db: AsyncSession = Depends(get_db)):
    try:
        result = await agentic_investigation_service.generate_evidence_package(
            db, session_id=investigation_id,
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/{investigation_id}")
async def get_investigation(investigation_id: str, db: AsyncSession = Depends(get_db)):
    try:
        result = await agentic_investigation_service.get_investigation(db, session_id=investigation_id)
        if not result:
            raise HTTPException(404, "Investigation not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))
