"""Shift Logbook API — manage operator shifts, handovers, and summaries."""
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
from backend.models.models import UserRole
from backend.models.phase2_models import ShiftLogbook

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/shift-logbook", tags=["shift-logbook"])


# ── Schemas ───────────────────────────────────────────────────

class ShiftStartRequest(BaseModel):
    notes: Optional[str] = None


class HandoverNotesRequest(BaseModel):
    handover_notes: str = Field(..., min_length=1, description="Handover notes for next shift")


class ShiftEndRequest(BaseModel):
    summary: str = Field(..., min_length=1, description="Shift summary")
    handover_notes: Optional[str] = None


class ShiftResponse(BaseModel):
    id: str
    shift_start: Optional[str]
    shift_end: Optional[str]
    operator_id: Optional[str]
    notes: Optional[str]
    handover_notes: Optional[str]
    status: str
    alerts_during_shift: list
    summary: Optional[str]
    created_at: Optional[str]


# ── Helpers ───────────────────────────────────────────────────

def _fmt_shift(s: ShiftLogbook) -> dict:
    return {
        "id": str(s.id),
        "shift_start": s.shift_start.isoformat() if s.shift_start else None,
        "shift_end": s.shift_end.isoformat() if s.shift_end else None,
        "operator_id": str(s.operator_id) if s.operator_id else None,
        "notes": s.notes,
        "handover_notes": s.handover_notes,
        "status": s.status or "active",
        "alerts_during_shift": s.alerts_during_shift or [],
        "summary": s.summary,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


# ── Endpoints ─────────────────────────────────────────────────

@router.get("/", response_model=List[dict])
async def list_shifts(
    limit: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None, description="Filter by status: active, ended, handed_over"),
    _user=Depends(get_current_user),
):
    """List shift logbook entries."""
    try:
        async with async_session() as session:
            stmt = select(ShiftLogbook).order_by(desc(ShiftLogbook.shift_start)).limit(limit)

            if status:
                stmt = stmt.where(ShiftLogbook.status == status)

            result = await session.execute(stmt)
            return [_fmt_shift(s) for s in result.scalars().all()]
    except Exception as e:
        logger.error(f"Error listing shifts: {e}")
        raise HTTPException(status_code=500, detail="Failed to list shifts")


@router.post("/start", response_model=dict, status_code=201)
async def start_shift(
    body: ShiftStartRequest,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Start a new operator shift."""
    try:
        async with async_session() as session:
            # Check if operator already has an active shift
            existing = await session.execute(
                select(ShiftLogbook).where(
                    ShiftLogbook.operator_id == user.id,
                    ShiftLogbook.status == "active",
                )
            )
            if existing.scalar_one_or_none():
                raise HTTPException(
                    status_code=409,
                    detail="Operator already has an active shift. End it before starting a new one.",
                )

            shift = ShiftLogbook(
                shift_start=datetime.now(timezone.utc),
                operator_id=user.id,
                notes=body.notes,
                status="active",
                alerts_during_shift=[],
            )
            session.add(shift)
            await session.commit()
            await session.refresh(shift)
            return _fmt_shift(shift)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting shift: {e}")
        raise HTTPException(status_code=500, detail="Failed to start shift")


@router.put("/{shift_id}/handover", response_model=dict)
async def add_handover_notes(
    shift_id: uuid.UUID,
    body: HandoverNotesRequest,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Add handover notes to an active shift."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(ShiftLogbook).where(ShiftLogbook.id == shift_id)
            )
            shift = result.scalar_one_or_none()
            if not shift:
                raise HTTPException(status_code=404, detail="Shift not found")
            if shift.status != "active":
                raise HTTPException(status_code=409, detail="Shift is not active")

            shift.handover_notes = body.handover_notes
            shift.status = "handed_over"
            await session.commit()
            await session.refresh(shift)
            return _fmt_shift(shift)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding handover notes to shift {shift_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to add handover notes")


@router.post("/{shift_id}/end", response_model=dict)
async def end_shift(
    shift_id: uuid.UUID,
    body: ShiftEndRequest,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """End a shift with a summary."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(ShiftLogbook).where(ShiftLogbook.id == shift_id)
            )
            shift = result.scalar_one_or_none()
            if not shift:
                raise HTTPException(status_code=404, detail="Shift not found")
            if shift.status == "ended":
                raise HTTPException(status_code=409, detail="Shift already ended")

            shift.shift_end = datetime.now(timezone.utc)
            shift.summary = body.summary
            if body.handover_notes:
                shift.handover_notes = body.handover_notes
            shift.status = "ended"
            await session.commit()
            await session.refresh(shift)
            return _fmt_shift(shift)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error ending shift {shift_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to end shift")


@router.get("/{shift_id}", response_model=dict)
async def get_shift_detail(
    shift_id: uuid.UUID,
    _user=Depends(get_current_user),
):
    """Get detailed information for a specific shift."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(ShiftLogbook).where(ShiftLogbook.id == shift_id)
            )
            shift = result.scalar_one_or_none()
            if not shift:
                raise HTTPException(status_code=404, detail="Shift not found")

            data = _fmt_shift(shift)
            # Calculate duration if shift has ended
            if shift.shift_start and shift.shift_end:
                duration_seconds = int((shift.shift_end - shift.shift_start).total_seconds())
                data["duration_seconds"] = duration_seconds
                data["duration_hours"] = round(duration_seconds / 3600, 2)
            elif shift.shift_start:
                elapsed = int((datetime.now(timezone.utc) - shift.shift_start).total_seconds())
                data["elapsed_seconds"] = elapsed
                data["elapsed_hours"] = round(elapsed / 3600, 2)

            return data
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching shift {shift_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch shift details")
