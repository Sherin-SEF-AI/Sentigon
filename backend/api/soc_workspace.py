from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.soc_workspace_service import soc_workspace_service

router = APIRouter(prefix="/api/workspace", tags=["workspace"])

@router.get("/")
async def get_workspace(user_id: str = Query(...), db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.get_workspace(db, user_id)

@router.put("/")
async def save_workspace(data: dict, db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.save_workspace(db, data["user_id"], data)

@router.post("/reset")
async def reset_workspace(data: dict, db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.reset_workspace(db, data["user_id"])

@router.get("/widgets")
async def available_widgets():
    return soc_workspace_service.get_available_widgets()

@router.get("/widgets/{widget_type}/data")
async def widget_data(widget_type: str, db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.get_widget_data(db, widget_type)

@router.get("/shift-briefing")
async def shift_briefing(db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.generate_shift_briefing(db)

@router.get("/operator-metrics")
async def operator_metrics(user_id: str = None, days: int = 7, db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.get_operator_metrics(db, user_id, days)
