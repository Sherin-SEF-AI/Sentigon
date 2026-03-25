"""Tamper Detection API — baseline management and tamper check endpoints."""
from __future__ import annotations

import base64
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc

from backend.api.auth import get_current_user
from backend.database import async_session
from backend.models.advanced_models import CameraBaseline

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tamper", tags=["tamper"])


def _fmt_baseline(b: CameraBaseline) -> dict:
    return {
        "id": str(b.id),
        "camera_id": str(b.camera_id),
        "baseline_frame_path": b.baseline_frame_path,
        "captured_at": b.captured_at.isoformat() if b.captured_at else None,
        "ssim_threshold": b.ssim_threshold,
        "active": b.active,
    }


# ── Baselines ─────────────────────────────────────────────────


@router.get("/baselines")
async def list_baselines(
    active_only: bool = Query(False),
    _user=Depends(get_current_user),
):
    """List all camera baselines."""
    from backend.modules.tamper_detection import tamper_detection

    baselines = await tamper_detection.get_baselines()
    if active_only:
        baselines = [b for b in baselines if b.get("active")]
    return {"baselines": baselines}


@router.post("/baseline/{camera_id}")
async def capture_baseline(
    camera_id: str,
    _user=Depends(get_current_user),
):
    """Capture a new baseline frame for the specified camera."""
    from backend.services.video_capture import capture_manager
    from backend.modules.tamper_detection import tamper_detection

    stream = capture_manager.get_stream(camera_id)
    if stream is None or not stream.is_running:
        raise HTTPException(status_code=404, detail=f"Camera {camera_id} not available")

    frame_bytes = stream.encode_jpeg()
    if frame_bytes is None:
        raise HTTPException(status_code=500, detail="Failed to capture frame")

    path = await tamper_detection.capture_baseline(camera_id, frame_bytes)
    if not path:
        raise HTTPException(status_code=500, detail="Failed to save baseline")

    return {
        "success": True,
        "camera_id": camera_id,
        "baseline_path": path,
        "message": f"Baseline captured for camera {camera_id}",
    }


# ── Tamper Checks ─────────────────────────────────────────────


@router.post("/check/{camera_id}")
async def run_tamper_check(
    camera_id: str,
    _user=Depends(get_current_user),
):
    """Run a tamper check on the specified camera (SSIM + Gemini)."""
    from backend.services.video_capture import capture_manager
    from backend.modules.tamper_detection import tamper_detection

    stream = capture_manager.get_stream(camera_id)
    if stream is None or not stream.is_running:
        raise HTTPException(status_code=404, detail=f"Camera {camera_id} not available")

    frame_bytes = stream.encode_jpeg()
    if frame_bytes is None:
        raise HTTPException(status_code=500, detail="Failed to capture frame")

    result = await tamper_detection.check_tamper(camera_id, frame_bytes)
    return result


@router.get("/events")
async def tamper_events(
    camera_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    _user=Depends(get_current_user),
):
    """Get recent tamper detection events from alerts."""
    from backend.models.models import Alert
    import uuid

    async with async_session() as session:
        query = select(Alert).where(
            Alert.threat_type.in_(["camera_tamper", "scene_modification"])
        )
        if camera_id:
            query = query.where(Alert.source_camera == uuid.UUID(camera_id))
        query = query.order_by(desc(Alert.created_at)).limit(limit)

        result = await session.execute(query)
        alerts = result.scalars().all()

        return {
            "events": [
                {
                    "id": str(a.id),
                    "camera_id": str(a.source_camera) if a.source_camera else None,
                    "title": a.title,
                    "description": a.description,
                    "severity": a.severity.value if a.severity else "medium",
                    "threat_type": a.threat_type,
                    "confidence": a.confidence,
                    "status": a.status.value if a.status else "active",
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                    "metadata": a.metadata_ if hasattr(a, "metadata_") else {},
                }
                for a in alerts
            ],
            "total": len(alerts),
        }


@router.get("/status")
async def tamper_status(
    _user=Depends(get_current_user),
):
    """Get tamper detection system status — cameras with/without baselines."""
    from backend.services.video_capture import capture_manager
    from backend.modules.tamper_detection import tamper_detection

    streams = capture_manager.list_streams()
    baselines = await tamper_detection.get_baselines()

    # Build set of camera IDs with active baselines
    active_baseline_cameras = {
        b["camera_id"] for b in baselines if b.get("active")
    }

    cameras_status = []
    for cam_id, stream in streams.items():
        cameras_status.append({
            "camera_id": cam_id,
            "streaming": stream.is_running,
            "has_baseline": cam_id in active_baseline_cameras,
        })

    return {
        "total_cameras": len(cameras_status),
        "with_baseline": sum(1 for c in cameras_status if c["has_baseline"]),
        "without_baseline": sum(1 for c in cameras_status if not c["has_baseline"]),
        "cameras": cameras_status,
    }
