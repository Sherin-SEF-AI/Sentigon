from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.privacy_engine_service import privacy_engine_service

router = APIRouter(prefix="/api/privacy", tags=["privacy"])

@router.get("/retention-policies")
async def list_policies(db: AsyncSession = Depends(get_db)):
    return await privacy_engine_service.get_retention_policies(db)

@router.post("/retention-policies")
async def create_policy(data: dict, db: AsyncSession = Depends(get_db)):
    return await privacy_engine_service.create_retention_policy(db, data)

@router.put("/retention-policies/{policy_id}")
async def update_policy(policy_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await privacy_engine_service.update_retention_policy(db, policy_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.delete("/retention-policies/{policy_id}")
async def delete_policy(policy_id: str, db: AsyncSession = Depends(get_db)):
    if not await privacy_engine_service.delete_retention_policy(db, policy_id):
        raise HTTPException(404, "Policy not found")
    return {"deleted": True}

@router.post("/retention/enforce")
async def enforce_retention(db: AsyncSession = Depends(get_db)):
    return await privacy_engine_service.enforce_retention(db)

@router.post("/blur-video")
async def blur_video(data: dict):
    try:
        return await privacy_engine_service.blur_faces_in_video(data["input_path"], data["output_path"])
    except Exception as e:
        raise HTTPException(400, str(e))

@router.get("/requests")
async def list_requests(status: str = None, db: AsyncSession = Depends(get_db)):
    return await privacy_engine_service.get_privacy_requests(db, status)

@router.post("/requests")
async def create_request(data: dict, db: AsyncSession = Depends(get_db)):
    return await privacy_engine_service.create_privacy_request(db, data)

@router.post("/requests/{request_id}/process")
async def process_request(request_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await privacy_engine_service.process_privacy_request(db, request_id, data["processor_id"])
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.get("/requests/{request_id}")
async def get_request(request_id: str, db: AsyncSession = Depends(get_db)):
    r = await privacy_engine_service.get_privacy_request(db, request_id)
    if not r:
        raise HTTPException(404, "Request not found")
    return r

@router.get("/audit-trail")
async def audit_trail(resource_type: str = None, user_id: str = None, time_from: str = None, time_to: str = None, limit: int = 100, db: AsyncSession = Depends(get_db)):
    return await privacy_engine_service.get_audit_trail(db, resource_type, user_id, time_from, time_to, limit)

@router.post("/compliance-report")
async def compliance_report(data: dict, db: AsyncSession = Depends(get_db)):
    return await privacy_engine_service.generate_compliance_report(db, data["report_type"])
