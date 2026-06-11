"""BOLO (Be On the Lookout) API — manage and check BOLO entries."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user, require_role
from backend.database import get_db, async_session
from backend.models.advanced_models import VehicleSighting
from backend.models.models import UserRole
from backend.models.phase2_models import BOLOEntry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bolo", tags=["bolo"])


# ── Schemas ───────────────────────────────────────────────────

class BOLOCreate(BaseModel):
    bolo_type: str = Field(..., description="'person' or 'vehicle'")
    description: dict = Field(default_factory=dict)
    plate_text: Optional[str] = None
    severity: str = "high"
    reason: Optional[str] = None
    expires_at: Optional[datetime] = None
    image_path: Optional[str] = None


class BOLOUpdate(BaseModel):
    bolo_type: Optional[str] = None
    description: Optional[dict] = None
    plate_text: Optional[str] = None
    severity: Optional[str] = None
    reason: Optional[str] = None
    active: Optional[bool] = None
    expires_at: Optional[datetime] = None
    image_path: Optional[str] = None


class BOLOResponse(BaseModel):
    id: str
    bolo_type: str
    description: dict
    plate_text: Optional[str]
    severity: str
    reason: Optional[str]
    active: bool
    expires_at: Optional[str]
    image_path: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class PlateCheckRequest(BaseModel):
    plate_text: str = Field(..., description="Plate number to check")


class PlateCheckResponse(BaseModel):
    plate_text: str
    match_found: bool
    matching_bolos: List[dict] = []


# ── Helpers ───────────────────────────────────────────────────

def _fmt_bolo(b: BOLOEntry) -> dict:
    return {
        "id": str(b.id),
        "bolo_type": b.bolo_type,
        "description": b.description or {},
        "plate_text": b.plate_text,
        "severity": b.severity,
        "reason": b.reason,
        "active": b.active,
        "expires_at": b.expires_at.isoformat() if b.expires_at else None,
        "image_path": b.image_path,
        "created_at": b.created_at.isoformat() if b.created_at else None,
        "updated_at": b.updated_at.isoformat() if b.updated_at else None,
    }


# ── Endpoints ─────────────────────────────────────────────────

@router.get("/", response_model=List[dict])
async def list_bolos(
    bolo_type: Optional[str] = Query(None, description="Filter by type: person or vehicle"),
    active_only: bool = Query(True, description="Show only active BOLOs"),
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """List active BOLO entries with optional type filter."""
    try:
        async with async_session() as session:
            stmt = select(BOLOEntry).order_by(desc(BOLOEntry.created_at)).limit(limit)

            if active_only:
                stmt = stmt.where(BOLOEntry.active == True)
            if bolo_type:
                stmt = stmt.where(BOLOEntry.bolo_type == bolo_type)

            result = await session.execute(stmt)
            return [_fmt_bolo(b) for b in result.scalars().all()]
    except Exception as e:
        logger.error(f"Error listing BOLOs: {e}")
        raise HTTPException(status_code=500, detail="Failed to list BOLO entries")


@router.post("/", response_model=dict, status_code=201)
async def create_bolo(
    body: BOLOCreate,
    user=Depends(require_role(UserRole.ADMIN)),
):
    """Create a new BOLO entry (admin only)."""
    try:
        async with async_session() as session:
            entry = BOLOEntry(
                bolo_type=body.bolo_type,
                description=body.description,
                plate_text=body.plate_text.upper().strip() if body.plate_text else None,
                severity=body.severity,
                reason=body.reason,
                expires_at=body.expires_at,
                image_path=body.image_path,
                created_by=user.id,
                active=True,
            )
            session.add(entry)
            await session.commit()
            await session.refresh(entry)
            return _fmt_bolo(entry)
    except Exception as e:
        logger.error(f"Error creating BOLO: {e}")
        raise HTTPException(status_code=500, detail="Failed to create BOLO entry")


@router.put("/{bolo_id}", response_model=dict)
async def update_bolo(
    bolo_id: uuid.UUID,
    body: BOLOUpdate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Update an existing BOLO entry (admin only)."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(BOLOEntry).where(BOLOEntry.id == bolo_id)
            )
            entry = result.scalar_one_or_none()
            if not entry:
                raise HTTPException(status_code=404, detail="BOLO entry not found")

            update_data = body.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                if field == "plate_text" and value:
                    value = value.upper().strip()
                setattr(entry, field, value)

            entry.updated_at = datetime.now(timezone.utc)
            await session.commit()
            await session.refresh(entry)
            return _fmt_bolo(entry)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating BOLO {bolo_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to update BOLO entry")


@router.delete("/{bolo_id}", response_model=dict)
async def deactivate_bolo(
    bolo_id: uuid.UUID,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Deactivate a BOLO entry (soft delete, admin only)."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(BOLOEntry).where(BOLOEntry.id == bolo_id)
            )
            entry = result.scalar_one_or_none()
            if not entry:
                raise HTTPException(status_code=404, detail="BOLO entry not found")

            entry.active = False
            entry.updated_at = datetime.now(timezone.utc)
            await session.commit()
            return {"status": "deactivated", "id": str(bolo_id)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deactivating BOLO {bolo_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to deactivate BOLO entry")


class EnrollAppearanceRequest(BaseModel):
    image_base64: str = Field(..., description="Reference image (base64 JPEG/PNG)")
    bbox: Optional[List[float]] = Field(None, description="[x1,y1,x2,y2]; whole image if omitted")


@router.post("/{bolo_id}/enroll-appearance")
async def enroll_appearance(bolo_id: uuid.UUID, body: EnrollAppearanceRequest, _user=Depends(get_current_user)):
    """Enroll a person BOLO with a CLIP appearance embedding from a reference
    image so the real-time matcher can flag this person across cameras."""
    import base64
    import cv2
    import numpy as np
    from backend.services.appearance_embedder import appearance_embedding
    from backend.services.bolo_service import bolo_service

    try:
        raw = base64.b64decode(body.image_base64.split(",", 1)[-1])
        frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image_base64")
    if frame is None:
        raise HTTPException(status_code=400, detail="Could not decode image")

    h, w = frame.shape[:2]
    bbox = body.bbox or [0, 0, w, h]
    emb = appearance_embedding(frame, bbox)
    if not emb:
        raise HTTPException(status_code=422, detail="Could not compute appearance embedding")

    ok = await bolo_service.enroll_appearance(bolo_id, emb)
    if not ok:
        raise HTTPException(status_code=404, detail="BOLO not found")
    return {"enrolled": True, "bolo_id": str(bolo_id), "embedding_dim": len(emb)}


@router.get("/{bolo_id}/sightings", response_model=List[dict])
async def get_bolo_sightings(
    bolo_id: uuid.UUID,
    limit: int = Query(100, ge=1, le=500),
    _user=Depends(get_current_user),
):
    """List sightings logged for a BOLO entry.

    Vehicle BOLOs with a plate are matched against recorded vehicle sightings;
    other BOLO types have no sighting source and return an empty list.
    """
    try:
        async with async_session() as session:
            bolo = (await session.execute(
                select(BOLOEntry).where(BOLOEntry.id == bolo_id)
            )).scalar_one_or_none()
            if not bolo:
                raise HTTPException(status_code=404, detail="BOLO entry not found")

            if bolo.bolo_type == "vehicle" and bolo.plate_text:
                result = await session.execute(
                    select(VehicleSighting)
                    .where(VehicleSighting.plate_text == bolo.plate_text.upper().strip())
                    .order_by(desc(VehicleSighting.timestamp))
                    .limit(limit)
                )
                sightings = result.scalars().all()
                return [
                    {
                        "id": str(s.id),
                        "bolo_id": str(bolo_id),
                        "plate_text": s.plate_text or "",
                        "camera_id": str(s.camera_id),
                        "vehicle_type": s.vehicle_type,
                        "vehicle_color": s.vehicle_color,
                        "confidence": s.plate_confidence,
                        "direction": s.vehicle_direction,
                        "frame_path": s.frame_path,
                        "timestamp": s.timestamp.isoformat() if s.timestamp else None,
                    }
                    for s in sightings
                ]

            return []
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching sightings for BOLO {bolo_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch BOLO sightings")


@router.post("/check-plate", response_model=PlateCheckResponse)
async def check_plate_against_bolos(
    body: PlateCheckRequest,
    _user=Depends(get_current_user),
):
    """Check a plate number against active BOLO entries."""
    plate = body.plate_text.upper().strip()
    try:
        async with async_session() as session:
            result = await session.execute(
                select(BOLOEntry).where(
                    BOLOEntry.active == True,
                    BOLOEntry.bolo_type == "vehicle",
                    BOLOEntry.plate_text == plate,
                )
            )
            matches = result.scalars().all()

            # Also try partial matching via bolo_service if available
            try:
                from backend.services.bolo_service import bolo_service
                service_matches = await bolo_service.check_plate_match(plate)
                if service_matches:
                    return PlateCheckResponse(
                        plate_text=plate,
                        match_found=True,
                        matching_bolos=service_matches,
                    )
            except ImportError:
                pass

            return PlateCheckResponse(
                plate_text=plate,
                match_found=len(matches) > 0,
                matching_bolos=[_fmt_bolo(m) for m in matches],
            )
    except Exception as e:
        logger.error(f"Error checking plate {plate}: {e}")
        raise HTTPException(status_code=500, detail="Failed to check plate against BOLOs")
