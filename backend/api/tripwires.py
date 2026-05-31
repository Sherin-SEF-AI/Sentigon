"""Tripwire (line-crossing) configuration API."""
from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models.tripwire_models import Tripwire
from backend.services.tripwire_service import tripwire_service

router = APIRouter(prefix="/api/tripwires", tags=["tripwires"])

_DIRECTIONS = {"both", "left_to_right", "right_to_left"}


class TripwireCreate(BaseModel):
    camera_id: uuid.UUID
    name: str = "Tripwire"
    point_a: List[float] = Field(min_length=2, max_length=2)
    point_b: List[float] = Field(min_length=2, max_length=2)
    direction: str = "both"
    classes: List[str] = Field(default_factory=lambda: ["person"])
    severity: str = "medium"


class TripwireOut(BaseModel):
    id: uuid.UUID
    camera_id: uuid.UUID
    name: str
    point_a: List[float]
    point_b: List[float]
    direction: str
    classes: List[str]
    severity: str
    is_active: bool

    model_config = {"from_attributes": True}


@router.get("", response_model=List[TripwireOut])
async def list_tripwires(
    camera_id: Optional[uuid.UUID] = None, db: AsyncSession = Depends(get_db)
):
    query = select(Tripwire)
    if camera_id is not None:
        query = query.where(Tripwire.camera_id == camera_id)
    rows = (await db.execute(query)).scalars().all()
    return [TripwireOut.model_validate(r) for r in rows]


@router.post("", response_model=TripwireOut, status_code=201)
async def create_tripwire(body: TripwireCreate, db: AsyncSession = Depends(get_db)):
    if body.direction not in _DIRECTIONS:
        raise HTTPException(status_code=422, detail=f"direction must be one of {sorted(_DIRECTIONS)}")
    wire = Tripwire(
        camera_id=body.camera_id,
        name=body.name,
        point_a=body.point_a,
        point_b=body.point_b,
        direction=body.direction,
        classes=body.classes or ["person"],
        severity=body.severity,
    )
    db.add(wire)
    await db.flush()
    await db.refresh(wire)
    tripwire_service.invalidate_cache(str(body.camera_id))
    return TripwireOut.model_validate(wire)


@router.delete("/{tripwire_id}", status_code=204)
async def delete_tripwire(tripwire_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    wire = (await db.execute(select(Tripwire).where(Tripwire.id == tripwire_id))).scalar_one_or_none()
    if not wire:
        raise HTTPException(status_code=404, detail="Tripwire not found")
    cam = str(wire.camera_id)
    await db.delete(wire)
    tripwire_service.invalidate_cache(cam)
    return None
