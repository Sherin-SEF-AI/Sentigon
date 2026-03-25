from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.forensic_search_service import forensic_search_service

router = APIRouter(prefix="/api/forensic-search", tags=["forensic-search"])

@router.post("/attributes")
async def search_attributes(data: dict, db: AsyncSession = Depends(get_db)):
    return await forensic_search_service.search_by_attributes(db, data)

@router.post("/vehicles")
async def search_vehicles(data: dict, db: AsyncSession = Depends(get_db)):
    return await forensic_search_service.search_vehicles(db, data)

@router.post("/similarity")
async def search_similarity(data: dict):
    return await forensic_search_service.search_by_similarity(data["query"], data.get("top_k", 20))

@router.post("/cross-camera")
async def cross_camera(data: dict, db: AsyncSession = Depends(get_db)):
    return await forensic_search_service.cross_camera_journey(db, data.get("track_id"), data.get("appearance_desc"), data.get("time_from"), data.get("time_to"))

@router.post("/timeline")
async def timeline(data: dict, db: AsyncSession = Depends(get_db)):
    return await forensic_search_service.timeline_search(db, data["camera_id"], data["time_from"], data["time_to"], data.get("event_types"))

@router.post("/save")
async def save_search(data: dict, db: AsyncSession = Depends(get_db)):
    return await forensic_search_service.save_search(db, data["search_type"], data["query"], data.get("results", []), data.get("user_id"))

@router.get("/history")
async def search_history(user_id: str = None, limit: int = 20, db: AsyncSession = Depends(get_db)):
    return await forensic_search_service.get_search_history(db, user_id, limit)
