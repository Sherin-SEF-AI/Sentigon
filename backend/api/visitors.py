from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.visitor_service import visitor_service

router = APIRouter(prefix="/api/visitors", tags=["visitors"])

@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    return await visitor_service.get_visitor_stats(db)

@router.get("/")
async def list_visitors(status: str = None, date: str = None, search: str = None, limit: int = 50, offset: int = 0, db: AsyncSession = Depends(get_db)):
    return await visitor_service.get_visitors(db, status, date, search, limit, offset)

@router.post("/")
async def pre_register(data: dict, db: AsyncSession = Depends(get_db)):
    return await visitor_service.pre_register(db, data)

@router.get("/overstays")
async def get_overstays(db: AsyncSession = Depends(get_db)):
    return await visitor_service.check_overstays(db)

@router.get("/watchlist")
async def get_watchlist(active_only: bool = True, db: AsyncSession = Depends(get_db)):
    return await visitor_service.get_watchlist(db, active_only)

@router.post("/watchlist")
async def add_to_watchlist(data: dict, db: AsyncSession = Depends(get_db)):
    return await visitor_service.add_to_watchlist(db, data)

@router.delete("/watchlist/{entry_id}")
async def remove_from_watchlist(entry_id: str, db: AsyncSession = Depends(get_db)):
    if not await visitor_service.remove_from_watchlist(db, entry_id):
        raise HTTPException(404, "Entry not found")
    return {"deleted": True}

@router.post("/screen")
async def screen_watchlist(data: dict, db: AsyncSession = Depends(get_db)):
    return await visitor_service.screen_watchlist(db, data["first_name"], data["last_name"], data.get("email"))

@router.get("/{visitor_id}")
async def get_visitor(visitor_id: str, db: AsyncSession = Depends(get_db)):
    v = await visitor_service.get_visitor(db, visitor_id)
    if not v:
        raise HTTPException(404, "Visitor not found")
    return v

@router.post("/{visitor_id}/check-in")
async def check_in(visitor_id: str, data: dict = {}, db: AsyncSession = Depends(get_db)):
    try:
        return await visitor_service.check_in(db, visitor_id, data.get("photo_base64"))
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.post("/{visitor_id}/check-out")
async def check_out(visitor_id: str, db: AsyncSession = Depends(get_db)):
    try:
        return await visitor_service.check_out(db, visitor_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.post("/{visitor_id}/zone-access")
async def log_zone_access(visitor_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await visitor_service.log_zone_access(db, visitor_id, data["zone_id"], data["direction"])
    except ValueError as e:
        raise HTTPException(400, str(e))
