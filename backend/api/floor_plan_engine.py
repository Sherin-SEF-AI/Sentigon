from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db

router = APIRouter(prefix="/api/floor-plans", tags=["floor-plans-engine"])

@router.post("/devices")
async def place_device(data: dict, db: AsyncSession = Depends(get_db)):
    from backend.services.floor_plan_engine_service import floor_plan_engine_service
    return await floor_plan_engine_service.place_device(db, data)

@router.put("/devices/{placement_id}")
async def update_device(placement_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    from backend.services.floor_plan_engine_service import floor_plan_engine_service
    try:
        return await floor_plan_engine_service.update_device_placement(db, placement_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.delete("/devices/{placement_id}")
async def remove_device(placement_id: str, db: AsyncSession = Depends(get_db)):
    from backend.services.floor_plan_engine_service import floor_plan_engine_service
    if not await floor_plan_engine_service.remove_device(db, placement_id):
        raise HTTPException(404, "Device placement not found")
    return {"deleted": True}

@router.get("/{floor_plan_id}/devices")
async def get_devices(floor_plan_id: str, db: AsyncSession = Depends(get_db)):
    from backend.services.floor_plan_engine_service import floor_plan_engine_service
    return await floor_plan_engine_service.get_floor_plan_devices(db, floor_plan_id)

@router.get("/{floor_plan_id}/status")
async def get_device_status(floor_plan_id: str, db: AsyncSession = Depends(get_db)):
    from backend.services.floor_plan_engine_service import floor_plan_engine_service
    return await floor_plan_engine_service.get_device_status(db, floor_plan_id)

@router.get("/{floor_plan_id}/incidents")
async def get_floor_incidents(floor_plan_id: str, db: AsyncSession = Depends(get_db)):
    from backend.services.floor_plan_engine_service import floor_plan_engine_service
    return await floor_plan_engine_service.get_active_incidents_on_floor(db, floor_plan_id)

@router.post("/{floor_plan_id}/pathfind")
async def pathfind(floor_plan_id: str, data: dict):
    from backend.services.floor_plan_engine_service import floor_plan_engine_service
    return await floor_plan_engine_service.calculate_shortest_path(floor_plan_id, tuple(data["from"]), tuple(data["to"]))
