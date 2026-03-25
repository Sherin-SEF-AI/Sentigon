"""Video Summary API — highlight reel and timelapse generation."""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.api.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/video-summary", tags=["video-summary"])


# ── Request schemas ───────────────────────────────────────────


class HighlightRequest(BaseModel):
    camera_id: str
    start_time: str  # ISO format
    end_time: str    # ISO format
    threshold: str = "medium"  # low|medium|high|critical


class TimelapseRequest(BaseModel):
    camera_id: str
    start_time: str  # ISO format
    end_time: str    # ISO format
    speed_factor: int = 60


# ── Endpoints ─────────────────────────────────────────────────


@router.post("/highlight")
async def create_highlight(
    body: HighlightRequest,
    _user=Depends(get_current_user),
):
    """Generate a highlight reel for a camera in the given time range."""
    from backend.modules.video_summary import video_summary_gen

    try:
        start = datetime.fromisoformat(body.start_time)
        end = datetime.fromisoformat(body.end_time)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Invalid time format. Use ISO 8601 (e.g. 2026-02-16T08:00:00Z)",
        )

    if end <= start:
        raise HTTPException(status_code=400, detail="end_time must be after start_time")

    result = await video_summary_gen.generate_highlight(
        camera_id=body.camera_id,
        start_time=start,
        end_time=end,
        threshold=body.threshold,
    )

    return result


@router.post("/timelapse")
async def create_timelapse(
    body: TimelapseRequest,
    _user=Depends(get_current_user),
):
    """Generate a timelapse for a camera in the given time range."""
    from backend.modules.video_summary import video_summary_gen

    try:
        start = datetime.fromisoformat(body.start_time)
        end = datetime.fromisoformat(body.end_time)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Invalid time format. Use ISO 8601.",
        )

    if end <= start:
        raise HTTPException(status_code=400, detail="end_time must be after start_time")

    result = await video_summary_gen.generate_timelapse(
        camera_id=body.camera_id,
        start_time=start,
        end_time=end,
        speed_factor=body.speed_factor,
    )

    return result


@router.get("/list")
async def list_summaries(
    camera_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    _user=Depends(get_current_user),
):
    """List generated video summaries."""
    from backend.modules.video_summary import video_summary_gen

    summaries = await video_summary_gen.get_summaries(
        camera_id=camera_id, limit=limit,
    )
    return {"summaries": summaries}


@router.get("/{summary_id}")
async def get_summary(
    summary_id: str,
    _user=Depends(get_current_user),
):
    """Get summary metadata."""
    from backend.modules.video_summary import video_summary_gen

    summary = await video_summary_gen.get_summary(summary_id)
    if not summary:
        raise HTTPException(status_code=404, detail="Summary not found")
    return summary


@router.get("/{summary_id}/download")
async def download_summary(
    summary_id: str,
    _user=Depends(get_current_user),
):
    """Download the generated MP4 file."""
    from backend.modules.video_summary import video_summary_gen

    summary = await video_summary_gen.get_summary(summary_id)
    if not summary:
        raise HTTPException(status_code=404, detail="Summary not found")

    file_path = summary.get("file_path")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Summary file not found")

    return FileResponse(
        file_path,
        media_type="video/mp4",
        filename=os.path.basename(file_path),
    )


@router.delete("/{summary_id}")
async def delete_summary(
    summary_id: str,
    _user=Depends(get_current_user),
):
    """Delete a summary and its file."""
    from backend.modules.video_summary import video_summary_gen

    success = await video_summary_gen.delete_summary(summary_id)
    if not success:
        raise HTTPException(status_code=404, detail="Summary not found")
    return {"success": True, "deleted": summary_id}
