from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.behavioral_analytics_service import behavioral_analytics_service

router = APIRouter(prefix="/api/behavioral", tags=["behavioral-analytics"])

@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    return await behavioral_analytics_service.get_stats(db)

@router.get("/events")
async def list_events(event_type: str = None, zone_id: str = None, resolved: bool = None, limit: int = 50, db: AsyncSession = Depends(get_db)):
    return await behavioral_analytics_service.get_behavioral_events(db, event_type, zone_id, resolved, limit)

@router.get("/loitering")
async def get_loitering(zone_id: str = None, threshold: float = 300, db: AsyncSession = Depends(get_db)):
    return await behavioral_analytics_service.detect_loitering(db, zone_id, threshold)

@router.get("/crowd-flow")
async def crowd_flow(zone_id: str = Query(...), time_from: str = Query(...), time_to: str = Query(...), db: AsyncSession = Depends(get_db)):
    return await behavioral_analytics_service.analyze_crowd_flow(db, zone_id, time_from, time_to)

@router.get("/tailgating")
async def tailgating(db: AsyncSession = Depends(get_db)):
    return await behavioral_analytics_service.detect_tailgating(db)

@router.get("/unusual-access")
async def unusual_access(hours: int = 24, db: AsyncSession = Depends(get_db)):
    return await behavioral_analytics_service.detect_unusual_access(db, hours)

@router.get("/occupancy")
async def occupancy_compliance(db: AsyncSession = Depends(get_db)):
    return await behavioral_analytics_service.get_occupancy_compliance(db)

@router.post("/events/{event_id}/resolve")
async def resolve_event(event_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await behavioral_analytics_service.resolve_event(db, event_id, data.get("user_id"))
    except ValueError as e:
        raise HTTPException(400, str(e))
