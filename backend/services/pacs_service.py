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


class PACSService:
    def __init__(self):
        self.doors: Dict[str, DoorController] = {}
        self.badge_holders: Dict[str, BadgeHolder] = {}
        self.access_log: List[AccessEvent] = []
        self.max_log_size = 10000
        self._callbacks: List[Callable] = []
        self._alert_callback: Optional[Callable] = None
        self._door_monitor_task: Optional[asyncio.Task] = None
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
        door.locked = False
        door.state = DoorState.UNLOCKED

        async def _relock():
            await asyncio.sleep(duration)
            door.locked = True
            if door.state == DoorState.UNLOCKED:
                door.state = DoorState.CLOSED
        asyncio.create_task(_relock())
        return True

    async def lock_door(self, door_id: str) -> bool:
        door = self.doors.get(door_id)
        if not door:
            return False
        door.locked = True
        door.state = DoorState.LOCKED
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

    async def shutdown(self):
        if self._door_monitor_task:
            self._door_monitor_task.cancel()


pacs_service = PACSService()
