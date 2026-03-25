from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.video_wall_service import video_wall_service

router = APIRouter(prefix="/api/video-wall", tags=["video-wall"])

@router.get("/layouts")
async def list_layouts(db: AsyncSession = Depends(get_db)):
    return await video_wall_service.get_layouts(db)

@router.post("/layouts")
async def create_layout(data: dict, db: AsyncSession = Depends(get_db)):
    return await video_wall_service.create_layout(db, data)

@router.get("/layouts/default")
async def get_default_layout(db: AsyncSession = Depends(get_db)):
    return await video_wall_service.get_default_layout(db)

@router.get("/layouts/{layout_id}")
async def get_layout(layout_id: str, db: AsyncSession = Depends(get_db)):
    l = await video_wall_service.get_layout(db, layout_id)
    if not l:
        raise HTTPException(404, "Layout not found")
    return l

@router.put("/layouts/{layout_id}")
async def update_layout(layout_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await video_wall_service.update_layout(db, layout_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.delete("/layouts/{layout_id}")
async def delete_layout(layout_id: str, db: AsyncSession = Depends(get_db)):
    if not await video_wall_service.delete_layout(db, layout_id):
        raise HTTPException(404, "Layout not found")
    return {"deleted": True}

@router.post("/layouts/{layout_id}/set-default")
async def set_default(layout_id: str, db: AsyncSession = Depends(get_db)):
    try:
        return await video_wall_service.set_default_layout(db, layout_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.get("/cameras")
async def get_cameras(db: AsyncSession = Depends(get_db)):
    return await video_wall_service.get_camera_streams(db)

@router.post("/ptz/{camera_id}")
async def ptz_control(camera_id: str, data: dict):
    return await video_wall_service.ptz_control(camera_id, data["direction"], data.get("speed", 0.5))

@router.post("/ptz/{camera_id}/preset")
async def ptz_preset(camera_id: str, data: dict):
    return await video_wall_service.ptz_goto_preset(camera_id, data["preset"])

@router.get("/overlays/{camera_id}")
async def get_overlays(camera_id: str):
    return await video_wall_service.get_ai_overlays(camera_id)
