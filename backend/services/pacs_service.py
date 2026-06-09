"""
Physical Access Control System (PACS) integration service.
Supports badge reader events, door control, anti-passback logic,
Wiegand format parsing, and emergency lockdown.
"""
import asyncio
import logging
import time
from typing import Optional, Dict, List, Any, Callable
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime

logger = logging.getLogger(__name__)


class AccessDecision(Enum):
    GRANTED = "granted"
    DENIED = "denied"
    ANTI_PASSBACK = "anti_passback"
    TAILGATING = "tailgating"
    DURESS = "duress"
    EXPIRED = "expired"
    UNKNOWN_CARD = "unknown_card"


class DoorState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HELD_OPEN = "held_open"
    FORCED_OPEN = "forced_open"
    LOCKED = "locked"
    UNLOCKED = "unlocked"
    ERROR = "error"


@dataclass
class BadgeHolder:
    card_number: str
    name: str
    department: str = ""
    access_level: int = 0
    zones_allowed: List[str] = field(default_factory=list)
    valid_from: Optional[datetime] = None
    valid_until: Optional[datetime] = None
    is_active: bool = True
    photo_url: Optional[str] = None
    anti_passback_zone: Optional[str] = None


@dataclass
class DoorController:
    door_id: str
    name: str
    location: str = ""
    zone: str = ""
    state: DoorState = DoorState.CLOSED
    locked: bool = True
    reader_in: Optional[str] = None
    reader_out: Optional[str] = None
    held_open_timeout: int = 30
    requires_access_level: int = 1
    anti_passback_enabled: bool = False
    camera_id: Optional[int] = None
    last_event_time: float = 0
    events_today: int = 0
    _held_open_since: Optional[float] = None


@dataclass
class AccessEvent:
    event_id: str
    timestamp: float
    door_id: str
    card_number: Optional[str]
    holder_name: Optional[str]
    decision: AccessDecision
    direction: str = "in"
    reader_id: Optional[str] = None
    details: str = ""


class WiegandParser:
    @staticmethod
    def parse_26bit(data: int) -> Dict[str, int]:
        facility = (data >> 17) & 0xFF
        card = (data >> 1) & 0xFFFF
        return {"facility": facility, "card": card, "format": "W26"}

    @staticmethod
    def parse_34bit(data: int) -> Dict[str, int]:
        facility = (data >> 17) & 0xFFFF
        card = (data >> 1) & 0xFFFF
        return {"facility": facility, "card": card, "format": "W34"}


class PacsAdapter:
    """Hardware abstraction for door actuation.

    The service owns access decisions and state tracking; the adapter is the
    seam where the *physical* lock is driven. Swap ``SimulatedPacsAdapter`` for
    a real driver (HID, Genetec, Lenel, …) by implementing ``actuate``.
    """

    async def actuate(self, door: "DoorController", lock: bool) -> bool:
        raise NotImplementedError


class SimulatedPacsAdapter(PacsAdapter):
    """Software adapter — updates in-memory door state (no physical hardware)."""

    async def actuate(self, door: "DoorController", lock: bool) -> bool:
        door.locked = lock
        door.state = DoorState.LOCKED if lock else DoorState.UNLOCKED
        return True


class PACSService:
    def __init__(self):
        self.doors: Dict[str, DoorController] = {}
        self.badge_holders: Dict[str, BadgeHolder] = {}
        self.access_log: List[AccessEvent] = []
        self.max_log_size = 10000
        self._callbacks: List[Callable] = []
        self._alert_callback: Optional[Callable] = None
        self._door_monitor_task: Optional[asyncio.Task] = None
        # Pluggable hardware seam — simulated by default (no real PACS hardware).
        self.adapter: PacsAdapter = SimulatedPacsAdapter()
        self._hydrated = False
        self._stats = {
            "total_events": 0, "granted": 0, "denied": 0,
            "forced_doors": 0, "held_doors": 0,
            "anti_passback_violations": 0,
        }

    def register_door(self, door: DoorController):
        self.doors[door.door_id] = door
        logger.info("Registered door: %s (%s)", door.name, door.door_id)

    def register_badge_holder(self, holder: BadgeHolder):
        self.badge_holders[holder.card_number] = holder

    def on_access_event(self, callback: Callable):
        self._callbacks.append(callback)

    def set_alert_callback(self, callback: Callable):
        self._alert_callback = callback

    async def start_monitoring(self):
        self._door_monitor_task = asyncio.create_task(self._monitor_doors())

    async def _monitor_doors(self):
        while True:
            try:
                now = time.time()
                for door in self.doors.values():
                    if door.state == DoorState.OPEN and door._held_open_since:
                        held = now - door._held_open_since
                        if held > door.held_open_timeout:
                            door.state = DoorState.HELD_OPEN
                            self._stats["held_doors"] += 1
                            if self._alert_callback:
                                await self._alert_callback({
                                    "type": "door_held_open", "door": door.name,
                                    "zone": door.zone, "duration": int(held),
                                    "camera_id": door.camera_id, "severity": "high",
                                })
            except Exception as e:
                logger.error("Door monitor error: %s", e)
            await asyncio.sleep(5)

    async def process_badge_read(self, door_id: str, card_number: str,
                                  direction: str = "in") -> AccessEvent:
        now = time.time()
        door = self.doors.get(door_id)
        holder = self.badge_holders.get(card_number)
        decision = AccessDecision.GRANTED
        details = ""

        if not door:
            decision = AccessDecision.DENIED
            details = "Unknown door"
        elif not holder:
            decision = AccessDecision.UNKNOWN_CARD
            details = f"Unrecognized card: {card_number}"
        elif not holder.is_active:
            decision = AccessDecision.EXPIRED
            details = f"Card disabled for {holder.name}"
        elif holder.valid_until and datetime.now() > holder.valid_until:
            decision = AccessDecision.EXPIRED
            details = f"Card expired for {holder.name}"
        elif holder.access_level < (door.requires_access_level if door else 0):
            decision = AccessDecision.DENIED
            details = f"Insufficient access level for {holder.name}"
        elif door and door.zone and holder.zones_allowed and door.zone not in holder.zones_allowed:
            decision = AccessDecision.DENIED
            details = f"{holder.name} not authorized for zone {door.zone}"
        elif door and door.anti_passback_enabled and holder.anti_passback_zone == door.zone and direction == "in":
            decision = AccessDecision.ANTI_PASSBACK
            details = f"Anti-passback: {holder.name} already in {door.zone}"
            self._stats["anti_passback_violations"] += 1

        if decision == AccessDecision.GRANTED and door:
            details = f"Access granted for {holder.name}"
            if door.anti_passback_enabled and holder:
                holder.anti_passback_zone = door.zone if direction == "in" else None
            await self.unlock_door(door_id, duration=5)

        self._stats["total_events"] += 1
        self._stats["granted" if decision == AccessDecision.GRANTED else "denied"] += 1

        event = AccessEvent(
            event_id=f"evt_{door_id}_{int(now)}", timestamp=now,
            door_id=door_id, card_number=card_number,
            holder_name=holder.name if holder else None,
            decision=decision, direction=direction, details=details,
        )
        if door:
            door.last_event_time = now
            door.events_today += 1
        await self._emit_event(event)

        if decision != AccessDecision.GRANTED and self._alert_callback:
            sev = "critical" if decision in (AccessDecision.ANTI_PASSBACK, AccessDecision.DURESS) else "medium"
            await self._alert_callback({
                "type": "access_denied", "door": door.name if door else door_id,
                "decision": decision.value, "card": card_number,
                "holder": holder.name if holder else "Unknown",
                "details": details, "severity": sev,
                "camera_id": door.camera_id if door else None,
            })
        return event

    async def report_door_forced(self, door_id: str):
        door = self.doors.get(door_id)
        if not door:
            return
        door.state = DoorState.FORCED_OPEN
        self._stats["forced_doors"] += 1
        event = AccessEvent(
            event_id=f"forced_{door_id}_{int(time.time())}",
            timestamp=time.time(), door_id=door_id,
            card_number=None, holder_name=None,
            decision=AccessDecision.DENIED,
            details=f"FORCED OPEN: {door.name}",
        )
        await self._emit_event(event)
        if self._alert_callback:
            await self._alert_callback({
                "type": "door_forced_open", "door": door.name,
                "zone": door.zone, "camera_id": door.camera_id,
                "severity": "critical",
            })

    async def unlock_door(self, door_id: str, duration: int = 5) -> bool:
        door = self.doors.get(door_id)
        if not door:
            return False
        await self.adapter.actuate(door, lock=False)

        async def _relock():
            await asyncio.sleep(duration)
            await self.adapter.actuate(door, lock=True)
            if door.state == DoorState.LOCKED:
                door.state = DoorState.CLOSED
        asyncio.create_task(_relock())
        return True

    async def lock_door(self, door_id: str) -> bool:
        door = self.doors.get(door_id)
        if not door:
            return False
        await self.adapter.actuate(door, lock=True)
        return True

    async def lockdown(self, zone: str = None) -> int:
        count = 0
        for door in self.doors.values():
            if zone and door.zone != zone:
                continue
            door.locked = True
            door.state = DoorState.LOCKED
            count += 1
        logger.warning("LOCKDOWN: %d doors locked%s", count, f" in zone {zone}" if zone else "")
        return count

    async def _emit_event(self, event: AccessEvent):
        self.access_log.append(event)
        if len(self.access_log) > self.max_log_size:
            self.access_log = self.access_log[-self.max_log_size:]
        for cb in self._callbacks:
            try:
                if asyncio.iscoroutinefunction(cb):
                    await cb(event)
                else:
                    cb(event)
            except Exception as e:
                logger.error("PACS callback error: %s", e)

    def get_access_log(self, door_id: str = None, card_number: str = None,
                       decision: str = None, limit: int = 100) -> List[Dict]:
        events = self.access_log
        if door_id:
            events = [e for e in events if e.door_id == door_id]
        if card_number:
            events = [e for e in events if e.card_number == card_number]
        if decision:
            events = [e for e in events if e.decision.value == decision]
        return [
            {"event_id": e.event_id, "timestamp": e.timestamp, "door_id": e.door_id,
             "door_name": self.doors[e.door_id].name if e.door_id in self.doors else e.door_id,
             "card_number": e.card_number, "holder_name": e.holder_name,
             "decision": e.decision.value, "direction": e.direction, "details": e.details}
            for e in events[-limit:]
        ]

    def get_status(self) -> Dict:
        return {
            "doors": {did: {
                "name": d.name, "location": d.location, "zone": d.zone,
                "state": d.state.value, "locked": d.locked,
                "events_today": d.events_today, "camera_id": d.camera_id,
            } for did, d in self.doors.items()},
            "badge_holders_count": len(self.badge_holders),
            "stats": self._stats,
        }

    # ── Persistence (write-through cache over the DB) ─────────────

    async def ensure_hydrated(self) -> None:
        """Load doors + badge holders from the DB into memory once."""
        if self._hydrated:
            return
        try:
            from sqlalchemy import select
            from backend.database import async_session
            from backend.models.pacs_models import PacsDoor, PacsBadgeHolder
            async with async_session() as s:
                for r in (await s.execute(select(PacsDoor))).scalars().all():
                    self.doors[r.door_id] = DoorController(
                        door_id=r.door_id, name=r.name, location=r.location or "",
                        zone=r.zone or "", locked=r.locked,
                        reader_in=r.reader_in, reader_out=r.reader_out,
                        held_open_timeout=r.held_open_timeout or 30,
                        requires_access_level=r.requires_access_level or 1,
                        anti_passback_enabled=r.anti_passback_enabled,
                        camera_id=r.camera_id,
                        state=DoorState.LOCKED if r.locked else DoorState.CLOSED,
                    )
                for r in (await s.execute(select(PacsBadgeHolder))).scalars().all():
                    self.badge_holders[r.card_number] = BadgeHolder(
                        card_number=r.card_number, name=r.name,
                        department=r.department or "", access_level=r.access_level or 0,
                        zones_allowed=r.zones_allowed or [],
                        valid_from=r.valid_from, valid_until=r.valid_until,
                        is_active=r.is_active, photo_url=r.photo_url,
                        anti_passback_zone=r.anti_passback_zone,
                    )
            self._hydrated = True
        except Exception as e:  # noqa: BLE001
            logger.warning("PACS hydrate failed: %s", e)

    async def save_door(self, data: Dict[str, Any]) -> DoorController:
        """Create or update a door (DB + in-memory)."""
        await self.ensure_hydrated()
        from sqlalchemy import select
        from backend.database import async_session
        from backend.models.pacs_models import PacsDoor
        door_id = str(data.get("door_id") or f"door_{int(time.time()*1000)}")
        async with async_session() as s:
            row = (await s.execute(select(PacsDoor).where(PacsDoor.door_id == door_id))).scalar_one_or_none()
            if row is None:
                row = PacsDoor(door_id=door_id)
                s.add(row)
            for f in ("name", "location", "zone", "reader_in", "reader_out",
                      "held_open_timeout", "requires_access_level",
                      "anti_passback_enabled", "camera_id", "locked"):
                if f in data and data[f] is not None:
                    setattr(row, f, data[f])
            if row.name is None:
                row.name = f"Door {door_id}"
            await s.commit()
            await s.refresh(row)
        door = DoorController(
            door_id=row.door_id, name=row.name, location=row.location or "",
            zone=row.zone or "", locked=row.locked,
            reader_in=row.reader_in, reader_out=row.reader_out,
            held_open_timeout=row.held_open_timeout or 30,
            requires_access_level=row.requires_access_level or 1,
            anti_passback_enabled=row.anti_passback_enabled, camera_id=row.camera_id,
            state=DoorState.LOCKED if row.locked else DoorState.CLOSED,
        )
        self.doors[door_id] = door
        return door

    async def remove_door(self, door_id: str) -> bool:
        await self.ensure_hydrated()
        from sqlalchemy import delete
        from backend.database import async_session
        from backend.models.pacs_models import PacsDoor
        async with async_session() as s:
            await s.execute(delete(PacsDoor).where(PacsDoor.door_id == door_id))
            await s.commit()
        return self.doors.pop(door_id, None) is not None

    async def save_badge_holder(self, data: Dict[str, Any]) -> BadgeHolder:
        """Create or update a badge holder (DB + in-memory)."""
        await self.ensure_hydrated()
        from sqlalchemy import select
        from backend.database import async_session
        from backend.models.pacs_models import PacsBadgeHolder
        card = str(data.get("card_number") or "").strip()
        if not card:
            raise ValueError("card_number is required")
        async with async_session() as s:
            row = (await s.execute(select(PacsBadgeHolder).where(PacsBadgeHolder.card_number == card))).scalar_one_or_none()
            if row is None:
                row = PacsBadgeHolder(card_number=card)
                s.add(row)
            for f in ("name", "department", "access_level", "zones_allowed",
                      "valid_from", "valid_until", "is_active", "photo_url",
                      "anti_passback_zone"):
                if f in data and data[f] is not None:
                    setattr(row, f, data[f])
            if row.name is None:
                row.name = card
            await s.commit()
            await s.refresh(row)
        holder = BadgeHolder(
            card_number=row.card_number, name=row.name,
            department=row.department or "", access_level=row.access_level or 0,
            zones_allowed=row.zones_allowed or [], valid_from=row.valid_from,
            valid_until=row.valid_until, is_active=row.is_active,
            photo_url=row.photo_url, anti_passback_zone=row.anti_passback_zone,
        )
        self.badge_holders[card] = holder
        return holder

    async def remove_badge_holder(self, card_number: str) -> bool:
        await self.ensure_hydrated()
        from sqlalchemy import delete
        from backend.database import async_session
        from backend.models.pacs_models import PacsBadgeHolder
        async with async_session() as s:
            await s.execute(delete(PacsBadgeHolder).where(PacsBadgeHolder.card_number == card_number))
            await s.commit()
        return self.badge_holders.pop(card_number, None) is not None

    async def shutdown(self):
        if self._door_monitor_task:
            self._door_monitor_task.cancel()


pacs_service = PACSService()
