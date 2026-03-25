"""Phase 3C: Agentic Video Wall API — AI-driven camera layout, attention tracking."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.services.agentic_video_wall_service import agentic_video_wall_service

router = APIRouter(prefix="/api/video-wall-ai", tags=["agentic-video-wall"])


@router.get("/layout")
async def get_layout(
    grid_cols: int = Query(4, ge=1, le=12),
    grid_rows: int = Query(3, ge=1, le=8),
    db: AsyncSession = Depends(get_db),
):
    try:
        layout = await agentic_video_wall_service.get_activity_ranked_layout(
            db, grid_cols=grid_cols, grid_rows=grid_rows,
        )
        return layout
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/auto-focus")
async def get_auto_focus(db: AsyncSession = Depends(get_db)):
    try:
        return await agentic_video_wall_service.get_auto_focus_cameras(db)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/smart-grid")
async def get_smart_grid(db: AsyncSession = Depends(get_db)):
    try:
        return await agentic_video_wall_service.get_smart_grid(db)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/attention")
async def record_attention(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        result = await agentic_video_wall_service.record_operator_attention(
            db,
            operator_id=data.get("operator_id"),
            camera_id=data.get("camera_id"),
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/attention-gaps")
async def attention_gaps(db: AsyncSession = Depends(get_db)):
    try:
        return await agentic_video_wall_service.check_attention_gaps(db)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/heat-scores")
async def heat_scores(db: AsyncSession = Depends(get_db)):
    try:
        return await agentic_video_wall_service.get_camera_heat_scores(db)
    except Exception as e:
        raise HTTPException(400, str(e))
