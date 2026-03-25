from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.incident_lifecycle_service import incident_lifecycle_service

router = APIRouter(prefix="/api/incidents", tags=["incidents"])

@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    return await incident_lifecycle_service.get_incident_stats(db)

@router.get("/")
async def list_incidents(status: str = None, severity: str = None, date_from: str = None, date_to: str = None, assigned_to: str = None, limit: int = 50, offset: int = 0, db: AsyncSession = Depends(get_db)):
    return await incident_lifecycle_service.list_incidents(db, status, severity, date_from, date_to, assigned_to, limit, offset)

@router.get("/{incident_id}")
async def get_incident(incident_id: str, db: AsyncSession = Depends(get_db)):
    inc = await incident_lifecycle_service.get_incident(db, incident_id)
    if not inc:
        raise HTTPException(404, "Incident not found")
    return inc

@router.post("/")
async def create_incident(data: dict, db: AsyncSession = Depends(get_db)):
    return await incident_lifecycle_service.create_incident(db, data)

@router.patch("/{incident_id}/status")
async def update_status(incident_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await incident_lifecycle_service.update_status(db, incident_id, data["status"], data.get("user_id"), data.get("notes"))
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.post("/{incident_id}/assign")
async def assign_incident(incident_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await incident_lifecycle_service.assign_incident(db, incident_id, data["user_id"])
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.post("/{incident_id}/merge")
async def merge_incidents(incident_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await incident_lifecycle_service.merge_incidents(db, incident_id, data["merge_ids"])
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.post("/{incident_id}/evidence")
async def attach_evidence(incident_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await incident_lifecycle_service.attach_evidence(db, incident_id, data["evidence_type"], data["reference_id"])
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.get("/{incident_id}/timeline")
async def get_timeline(incident_id: str, db: AsyncSession = Depends(get_db)):
    return await incident_lifecycle_service.get_incident_timeline(db, incident_id)

@router.post("/{incident_id}/ai-summary")
async def generate_summary(incident_id: str, db: AsyncSession = Depends(get_db)):
    try:
        summary = await incident_lifecycle_service.generate_ai_summary(db, incident_id)
        return {"summary": summary}
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.get("/sla-report")
async def sla_report(db: AsyncSession = Depends(get_db)):
    return await incident_lifecycle_service.get_incident_stats(db)
