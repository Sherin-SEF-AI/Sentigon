from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db

router = APIRouter(prefix="/api/lpr-db", tags=["lpr-database"])

@router.post("/search")
async def search_plates(data: dict, db: AsyncSession = Depends(get_db)):
    from backend.services.lpr_enhanced_service import lpr_enhanced_service
    return await lpr_enhanced_service.search_plates(db, data)

@router.get("/vehicle/{plate}")
async def vehicle_profile(plate: str, db: AsyncSession = Depends(get_db)):
    from backend.services.lpr_enhanced_service import lpr_enhanced_service
    return await lpr_enhanced_service.get_vehicle_full_profile(db, plate)

@router.get("/parking/{zone_id}")
async def parking_status(zone_id: str, db: AsyncSession = Depends(get_db)):
    from backend.services.lpr_enhanced_service import lpr_enhanced_service
    return await lpr_enhanced_service.manage_parking(db, zone_id)

@router.post("/gate/{gate_id}/action")
async def gate_action(gate_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    from backend.services.lpr_enhanced_service import lpr_enhanced_service
    return await lpr_enhanced_service.trigger_gate_action(db, gate_id, data["plate_text"], data["action"])

@router.post("/bolo")
async def create_bolo(data: dict, db: AsyncSession = Depends(get_db)):
    from backend.services.lpr_enhanced_service import lpr_enhanced_service
    return await lpr_enhanced_service.create_bolo_alert(db, data)

@router.get("/bolo/check/{plate}")
async def check_bolo(plate: str, db: AsyncSession = Depends(get_db)):
    from backend.services.lpr_enhanced_service import lpr_enhanced_service
    return await lpr_enhanced_service.check_plate_against_bolo(db, plate)

@router.get("/entry-exit-log")
async def entry_exit_log(plate: str = None, time_from: str = None, time_to: str = None, db: AsyncSession = Depends(get_db)):
    from backend.services.lpr_enhanced_service import lpr_enhanced_service
    return await lpr_enhanced_service.get_entry_exit_log(db, plate, time_from, time_to)

@router.get("/parking/analytics")
async def parking_analytics(zone_id: str = None, db: AsyncSession = Depends(get_db)):
    from backend.services.lpr_enhanced_service import lpr_enhanced_service
    return await lpr_enhanced_service.get_parking_analytics(db, zone_id)
