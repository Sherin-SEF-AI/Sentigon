"""Physical Access Control System — ingest and query door/access events."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc, func

from backend.api.auth import get_current_user, require_role
from backend.database import async_session
from backend.models.models import UserRole
from backend.models.phase2_models import AccessEvent

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/pacs", tags=["pacs"])

# Second router for the /api/access-control namespace (door control actions)
ac_router = APIRouter(prefix="/api/access-control", tags=["access-control"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class AccessEventCreate(BaseModel):
    user_identifier: str = Field(..., description="Badge ID or person identifier")
    door_id: str = Field(..., description="Door / access point identifier")
    event_type: str = Field(..., description="granted, denied, forced, held_open, tailgating")
    camera_id: Optional[str] = Field(None, description="Associated camera")
    metadata: Optional[dict] = Field(default_factory=dict)


class AccessEventResponse(BaseModel):
    id: str
    user_identifier: Optional[str] = None
    door_id: Optional[str] = None
    event_type: str
    camera_id: Optional[str] = None
    metadata: Optional[dict] = None
    created_at: Optional[str] = None

    class Config:
        from_attributes = True


# ── Helpers ───────────────────────────────────────────────────────────────────

ANOMALY_EVENT_TYPES = {"forced", "held_open", "tailgating"}

ANOMALY_SEVERITY_MAP = {
    "forced": "critical",
    "tailgating": "high",
    "held_open": "medium",
}


def _fmt_badge_holder(h) -> dict:
    """Serialise a pacs_service BadgeHolder dataclass to a dict."""
    return {
        "id": h.card_number,
        "card_number": h.card_number,
        "name": h.name,
        "department": h.department or None,
        "access_level": h.access_level,
        "zones_allowed": h.zones_allowed or [],
        "valid_from": h.valid_from.isoformat() if h.valid_from else None,
        "valid_until": h.valid_until.isoformat() if h.valid_until else None,
        "is_active": h.is_active,
        "photo_url": h.photo_url,
    }


def _fmt_event(e: AccessEvent) -> dict:
    return {
        "id": str(e.id),
        "user_identifier": e.user_identifier,
        "door_id": e.door_id,
        "event_type": e.event_type,
        "camera_id": e.camera_id,
        "metadata": e.event_metadata or {},
        "created_at": e.created_at.isoformat() if hasattr(e, "created_at") and e.created_at else (
            e.timestamp.isoformat() if hasattr(e, "timestamp") and e.timestamp else None
        ),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/events", response_model=List[dict])
async def list_access_events(
    door_id: Optional[str] = Query(None, description="Filter by door ID"),
    event_type: Optional[str] = Query(None, description="Filter: granted, denied, forced, held_open, tailgating"),
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(100, ge=1, le=1000),
    _user=Depends(get_current_user),
):
    """List access events with optional filters."""
    try:
        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

            # Support both created_at and timestamp columns
            ts_col = getattr(AccessEvent, "created_at", None) or getattr(AccessEvent, "timestamp", None)
            stmt = (
                select(AccessEvent)
                .where(ts_col >= cutoff)
                .order_by(desc(ts_col))
                .limit(limit)
            )

            if door_id:
                stmt = stmt.where(AccessEvent.door_id == door_id)
            if event_type:
                stmt = stmt.where(AccessEvent.event_type == event_type)

            result = await session.execute(stmt)
            return [_fmt_event(e) for e in result.scalars().all()]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list access events")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/events", response_model=dict, status_code=201)
async def ingest_access_event(
    body: AccessEventCreate,
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Ingest a new physical-access event."""
    try:
        async with async_session() as session:
            event = AccessEvent(
                user_identifier=body.user_identifier,
                door_id=body.door_id,
                event_type=body.event_type,
                camera_id=body.camera_id,
                event_metadata=body.metadata or {},
            )
            # Set timestamp if model uses that column name
            if hasattr(AccessEvent, "timestamp"):
                event.timestamp = datetime.now(timezone.utc)
            session.add(event)
            await session.commit()
            await session.refresh(event)
            return _fmt_event(event)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to ingest access event")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/doors", response_model=List[dict])
async def list_doors(_user=Depends(get_current_user)):
    """Aggregate unique door_ids with event counts from the last 24 hours."""
    try:
        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            ts_col = getattr(AccessEvent, "created_at", None) or getattr(AccessEvent, "timestamp", None)
            stmt = (
                select(
                    AccessEvent.door_id,
                    func.count(AccessEvent.id).label("event_count"),
                )
                .where(ts_col >= cutoff)
                .where(AccessEvent.door_id.isnot(None))
                .group_by(AccessEvent.door_id)
                .order_by(desc("event_count"))
            )
            result = await session.execute(stmt)
            rows = result.all()

            return [
                {"door_id": row.door_id, "event_count": row.event_count}
                for row in rows
            ]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list doors")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/anomalies", response_model=List[dict])
async def list_anomalies(_user=Depends(get_current_user)):
    """List anomalous access events (forced, held_open, tailgating) from the last 24 hours."""
    try:
        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            ts_col = getattr(AccessEvent, "created_at", None) or getattr(AccessEvent, "timestamp", None)
            stmt = (
                select(AccessEvent)
                .where(ts_col >= cutoff)
                .where(AccessEvent.event_type.in_(list(ANOMALY_EVENT_TYPES)))
                .order_by(desc(ts_col))
            )
            result = await session.execute(stmt)
            events = result.scalars().all()

            anomalies = []
            for e in events:
                data = _fmt_event(e)
                data["severity"] = ANOMALY_SEVERITY_MAP.get(e.event_type, "medium")
                anomalies.append(data)

            return anomalies
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list anomalies")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/badge-holders", response_model=List[dict])
async def list_badge_holders(_user=Depends(get_current_user)):
    """List badge holders registered with the PACS service."""
    try:
        from backend.services.pacs_service import pacs_service
        await pacs_service.ensure_hydrated()
        return [_fmt_badge_holder(h) for h in pacs_service.badge_holders.values()]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list badge holders")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/badge-holders/{holder_id}", response_model=dict)
async def get_badge_holder(holder_id: str, _user=Depends(get_current_user)):
    """Get a single badge holder by card number; 404 if not found."""
    try:
        from backend.services.pacs_service import pacs_service
        await pacs_service.ensure_hydrated()
        holder = pacs_service.badge_holders.get(holder_id)
        if not holder:
            raise HTTPException(status_code=404, detail=f"Badge holder '{holder_id}' not found")
        return _fmt_badge_holder(holder)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to get badge holder %s", holder_id)
        raise HTTPException(status_code=500, detail=str(exc))


# ── Badge-holder + door CRUD (persisted via pacs_service write-through) ─────────

def _fmt_door(d) -> dict:
    """Serialise a pacs_service DoorController to a dict."""
    return {
        "id": d.door_id,
        "door_id": d.door_id,
        "name": d.name,
        "location": d.location or None,
        "zone": d.zone or None,
        "locked": d.locked,
        "state": d.state.value if hasattr(d.state, "value") else str(d.state),
        "requires_access_level": d.requires_access_level,
        "anti_passback_enabled": d.anti_passback_enabled,
        "camera_id": d.camera_id,
    }


@router.post("/badge-holders", response_model=dict, status_code=201)
async def create_badge_holder(body: dict, _user=Depends(require_role(UserRole.ANALYST))):
    """Register a badge holder (persisted)."""
    from backend.services.pacs_service import pacs_service
    try:
        holder = await pacs_service.save_badge_holder(body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _fmt_badge_holder(holder)


@router.put("/badge-holders/{holder_id}", response_model=dict)
async def update_badge_holder(holder_id: str, body: dict, _user=Depends(require_role(UserRole.ANALYST))):
    """Update an existing badge holder (persisted)."""
    from backend.services.pacs_service import pacs_service
    await pacs_service.ensure_hydrated()
    if holder_id not in pacs_service.badge_holders:
        raise HTTPException(status_code=404, detail="Badge holder not found")
    holder = await pacs_service.save_badge_holder({**body, "card_number": holder_id})
    return _fmt_badge_holder(holder)


@router.delete("/badge-holders/{holder_id}", response_model=dict)
async def delete_badge_holder(holder_id: str, _user=Depends(require_role(UserRole.ANALYST))):
    """Remove a badge holder (persisted)."""
    from backend.services.pacs_service import pacs_service
    if not await pacs_service.remove_badge_holder(holder_id):
        raise HTTPException(status_code=404, detail="Badge holder not found")
    return {"deleted": True, "card_number": holder_id}


@router.get("/doors-config", response_model=List[dict])
async def list_door_config(_user=Depends(get_current_user)):
    """List configured/persisted doors (distinct from event-derived /doors)."""
    from backend.services.pacs_service import pacs_service
    await pacs_service.ensure_hydrated()
    return [_fmt_door(d) for d in pacs_service.doors.values()]


@router.post("/doors-config", response_model=dict, status_code=201)
async def create_door(body: dict, _user=Depends(require_role(UserRole.ANALYST))):
    """Create a door (persisted)."""
    from backend.services.pacs_service import pacs_service
    door = await pacs_service.save_door(body)
    return _fmt_door(door)


@router.put("/doors-config/{door_id}", response_model=dict)
async def update_door(door_id: str, body: dict, _user=Depends(require_role(UserRole.ANALYST))):
    """Update a door (persisted)."""
    from backend.services.pacs_service import pacs_service
    await pacs_service.ensure_hydrated()
    if door_id not in pacs_service.doors:
        raise HTTPException(status_code=404, detail="Door not found")
    door = await pacs_service.save_door({**body, "door_id": door_id})
    return _fmt_door(door)


@router.delete("/doors-config/{door_id}", response_model=dict)
async def delete_door(door_id: str, _user=Depends(require_role(UserRole.ANALYST))):
    """Remove a door (persisted)."""
    from backend.services.pacs_service import pacs_service
    if not await pacs_service.remove_door(door_id):
        raise HTTPException(status_code=404, detail="Door not found")
    return {"deleted": True, "door_id": door_id}


# ── /api/access-control endpoints ─────────────────────────────────────────────
#
# Door state is derived from the most recent AccessEvent for each door_id.
# Lock/unlock actions create a synthetic access event to record the operator
# command and update the effective door state returned by GET /doors.

_LOCK_EVENT_TYPE = "operator_lock"
_UNLOCK_EVENT_TYPE = "operator_unlock"

_DERIVED_STATE: dict[str, str] = {}  # in-memory override map: door_id -> state


@ac_router.get("/doors", response_model=List[dict])
async def ac_list_doors(_user=Depends(get_current_user)):
    """List doors with their current state derived from access events."""
    try:
        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            ts_col = getattr(AccessEvent, "timestamp", None) or getattr(AccessEvent, "created_at", None)

            # Get unique door IDs with latest event time and event type
            stmt = (
                select(
                    AccessEvent.door_id,
                    func.max(ts_col).label("last_event_time"),
                    func.count(AccessEvent.id).label("event_count"),
                )
                .where(ts_col >= cutoff)
                .where(AccessEvent.door_id.isnot(None))
                .group_by(AccessEvent.door_id)
                .order_by(desc("last_event_time"))
            )
            result = await session.execute(stmt)
            rows = result.all()

            # For each door get the latest event type to derive state
            doors = []
            for row in rows:
                door_id = row.door_id
                # Operator overrides take precedence
                state = _DERIVED_STATE.get(door_id)
                if state is None:
                    # Derive from the most recent event
                    latest_stmt = (
                        select(AccessEvent.event_type)
                        .where(AccessEvent.door_id == door_id)
                        .where(ts_col >= cutoff)
                        .order_by(desc(ts_col))
                        .limit(1)
                    )
                    ev_result = await session.execute(latest_stmt)
                    latest_type = ev_result.scalar_one_or_none()
                    if latest_type == _LOCK_EVENT_TYPE or latest_type == "granted":
                        state = "locked"
                    elif latest_type == _UNLOCK_EVENT_TYPE:
                        state = "unlocked"
                    elif latest_type == "forced":
                        state = "forced"
                    elif latest_type == "held_open":
                        state = "held_open"
                    else:
                        state = "unknown"

                doors.append({
                    "id": door_id,
                    "name": door_id,
                    "door_id": door_id,
                    "state": state,
                    "last_event_time": row.last_event_time.isoformat() if row.last_event_time else None,
                    "zone": None,
                })

            return doors
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list doors for access-control")
        raise HTTPException(status_code=500, detail=str(exc))


@ac_router.post("/doors/{door_id}/lock", response_model=dict)
async def ac_lock_door(
    door_id: str,
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Lock a specific door by recording an operator_lock event."""
    try:
        async with async_session() as session:
            event = AccessEvent(
                user_identifier=getattr(_user, "email", "operator"),
                door_id=door_id,
                event_type=_LOCK_EVENT_TYPE,
                camera_id=None,
                event_metadata={"action": "lock", "operator": getattr(_user, "email", "operator")},
            )
            if hasattr(AccessEvent, "timestamp"):
                event.timestamp = datetime.now(timezone.utc)
            session.add(event)
            await session.commit()

        _DERIVED_STATE[door_id] = "locked"
        logger.info("door.lock", door_id=door_id, user=getattr(_user, "email", "operator"))
        return {"door_id": door_id, "state": "locked", "success": True}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to lock door")
        raise HTTPException(status_code=500, detail=str(exc))


@ac_router.post("/doors/{door_id}/unlock", response_model=dict)
async def ac_unlock_door(
    door_id: str,
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Unlock a specific door by recording an operator_unlock event."""
    try:
        async with async_session() as session:
            event = AccessEvent(
                user_identifier=getattr(_user, "email", "operator"),
                door_id=door_id,
                event_type=_UNLOCK_EVENT_TYPE,
                camera_id=None,
                event_metadata={"action": "unlock", "operator": getattr(_user, "email", "operator")},
            )
            if hasattr(AccessEvent, "timestamp"):
                event.timestamp = datetime.now(timezone.utc)
            session.add(event)
            await session.commit()

        _DERIVED_STATE[door_id] = "unlocked"
        logger.info("door.unlock", door_id=door_id, user=getattr(_user, "email", "operator"))
        return {"door_id": door_id, "state": "unlocked", "success": True}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to unlock door")
        raise HTTPException(status_code=500, detail=str(exc))


@ac_router.post("/emergency-lockdown", response_model=dict)
async def ac_emergency_lockdown(
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Trigger facility-wide emergency lockdown — locks all known doors."""
    try:
        operator = getattr(_user, "email", "operator")
        locked_doors: list[str] = []

        async with async_session() as session:
            # Find all door IDs with events in the last 7 days
            cutoff = datetime.now(timezone.utc) - timedelta(days=7)
            ts_col = getattr(AccessEvent, "timestamp", None) or getattr(AccessEvent, "created_at", None)
            stmt = (
                select(AccessEvent.door_id)
                .where(ts_col >= cutoff)
                .where(AccessEvent.door_id.isnot(None))
                .distinct()
            )
            result = await session.execute(stmt)
            door_ids = [row[0] for row in result.all()]

            # Create a lockdown event for each door
            now = datetime.now(timezone.utc)
            for door_id in door_ids:
                event = AccessEvent(
                    user_identifier=operator,
                    door_id=door_id,
                    event_type=_LOCK_EVENT_TYPE,
                    camera_id=None,
                    event_metadata={
                        "action": "emergency_lockdown",
                        "operator": operator,
                    },
                )
                if hasattr(AccessEvent, "timestamp"):
                    event.timestamp = now
                session.add(event)
                _DERIVED_STATE[door_id] = "locked"
                locked_doors.append(door_id)

            await session.commit()

        logger.warning(
            "emergency.lockdown",
            operator=operator,
            doors_locked=len(locked_doors),
        )
        return {
            "success": True,
            "doors_locked": len(locked_doors),
            "locked_door_ids": locked_doors,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to execute emergency lockdown")
        raise HTTPException(status_code=500, detail=str(exc))
