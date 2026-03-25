"""Camera CRUD API endpoints for SENTINEL AI."""

from __future__ import annotations

import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import Query
from sqlalchemy import desc

from backend.config import settings
from backend.database import get_db
from backend.models import Camera, User, Event
from backend.models.models import UserRole, CameraStatus
from backend.schemas import CameraCreate, CameraUpdate, CameraResponse
from backend.api.auth import get_current_user, require_role

router = APIRouter(prefix="/api/cameras", tags=["cameras"])


# ── List all cameras ─────────────────────────────────────────

@router.get("", response_model=List[CameraResponse])
async def list_cameras(
    is_active: bool | None = None,
    status_filter: str | None = None,
    zone_id: uuid.UUID | None = None,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Return all cameras, with optional filters."""
    query = select(Camera).order_by(Camera.created_at.desc())

    if is_active is not None:
        query = query.where(Camera.is_active == is_active)
    if status_filter is not None:
        query = query.where(Camera.status == CameraStatus(status_filter))
    if zone_id is not None:
        query = query.where(Camera.zone_id == zone_id)

    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    return [CameraResponse.model_validate(c) for c in result.scalars().all()]


# ── Create a camera ──────────────────────────────────────────

@router.post("", response_model=CameraResponse, status_code=status.HTTP_201_CREATED)
async def create_camera(
    body: CameraCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_role(UserRole.OPERATOR)),
):
    """Create a new camera. Requires at least operator role."""
    camera = Camera(
        name=body.name,
        source=body.source,
        location=body.location,
        fps=body.fps,
        resolution=body.resolution,
        zone_id=body.zone_id,
        config=body.config,
        status=CameraStatus.OFFLINE,
        is_active=True,
    )
    db.add(camera)
    await db.flush()
    await db.refresh(camera)
    return CameraResponse.model_validate(camera)


# ── Get single camera ────────────────────────────────────────

@router.get("/{camera_id}", response_model=CameraResponse)
async def get_camera(
    camera_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Retrieve a single camera by ID."""
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    camera = result.scalar_one_or_none()
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")
    return CameraResponse.model_validate(camera)


# ── Update camera ────────────────────────────────────────────

@router.patch("/{camera_id}", response_model=CameraResponse)
async def update_camera(
    camera_id: uuid.UUID,
    body: CameraUpdate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_role(UserRole.OPERATOR)),
):
    """Partially update a camera. Requires at least operator role."""
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    camera = result.scalar_one_or_none()
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if field == "status" and value is not None:
            setattr(camera, field, CameraStatus(value))
        else:
            setattr(camera, field, value)

    await db.flush()
    await db.refresh(camera)
    return CameraResponse.model_validate(camera)


# ── Delete camera ────────────────────────────────────────────

@router.delete("/{camera_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_camera(
    camera_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Delete a camera. Requires admin role."""
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    camera = result.scalar_one_or_none()
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")

    await db.delete(camera)
    await db.flush()
    return None


# ── Start camera capture ─────────────────────────────────────

@router.post("/{camera_id}/start", response_model=CameraResponse)
async def start_camera(
    camera_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_role(UserRole.OPERATOR)),
):
    """Set camera status to ONLINE (start capture). Requires operator role."""
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    camera = result.scalar_one_or_none()
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")

    if not camera.is_active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Camera is deactivated. Re-activate it before starting capture.",
        )

    if camera.status == CameraStatus.ONLINE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Camera is already online.",
        )

    # Start the actual video capture stream
    from backend.services.video_capture import capture_manager

    cam_id_str = str(camera_id)
    stream = capture_manager.get_stream(cam_id_str)
    if stream is None:
        stream = capture_manager.add_camera(
            camera_id=cam_id_str,
            source=camera.source,
            fps=camera.fps or 15,
        )
    if not stream.is_running:
        if not stream.start():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Cannot open video source: {stream.error or camera.source}",
            )

    camera.status = CameraStatus.ONLINE
    await db.flush()
    await db.refresh(camera)
    return CameraResponse.model_validate(camera)


# ── Stop camera capture ──────────────────────────────────────

@router.post("/{camera_id}/stop", response_model=CameraResponse)
async def stop_camera(
    camera_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_role(UserRole.OPERATOR)),
):
    """Set camera status to OFFLINE (stop capture). Requires operator role."""
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    camera = result.scalar_one_or_none()
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")

    if camera.status == CameraStatus.OFFLINE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Camera is already offline.",
        )

    # Stop the actual video capture stream
    from backend.services.video_capture import capture_manager

    cam_id_str = str(camera_id)
    capture_manager.stop_camera(cam_id_str)

    camera.status = CameraStatus.OFFLINE
    await db.flush()
    await db.refresh(camera)
    return CameraResponse.model_validate(camera)


# ── Camera events ────────────────────────────────────────────

@router.get("/{camera_id}/events")
async def camera_events(
    camera_id: uuid.UUID,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Get recent events for a specific camera."""
    # Verify camera exists
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    camera = result.scalar_one_or_none()
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")

    stmt = (
        select(Event)
        .where(Event.camera_id == camera_id)
        .order_by(desc(Event.timestamp))
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    events = result.scalars().all()

    return [
        {
            "id": str(e.id),
            "camera_id": str(e.camera_id),
            "zone_id": str(e.zone_id) if e.zone_id else None,
            "event_type": e.event_type,
            "description": e.description,
            "severity": e.severity.value if e.severity else "info",
            "confidence": e.confidence,
            "detections": e.detections,
            "frame_url": e.frame_url,
            "embedding_id": e.embedding_id,
            "gemini_analysis": e.gemini_analysis,
            "timestamp": e.timestamp.isoformat() if e.timestamp else None,
        }
        for e in events
    ]
