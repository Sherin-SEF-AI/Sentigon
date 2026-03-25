"""Elevator monitoring and control service.

Supports BACnet and REST API protocols for elevator controller integration.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

@dataclass
class ElevatorStatus:
    id: str
    name: str
    floor: int
    direction: str  # "up", "down", "idle"
    door_state: str  # "open", "closed", "opening", "closing"
    in_service: bool = True
    occupancy: int = 0
    last_updated: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class ElevatorService:
    def __init__(self):
        self._elevators: Dict[str, ElevatorStatus] = {}
        self._emergency_recall_active = False
        self._locked_elevators: set = set()

    def register_elevator(self, elevator_id: str, name: str, floor: int = 1) -> ElevatorStatus:
        status = ElevatorStatus(id=elevator_id, name=name, floor=floor, direction="idle", door_state="closed")
        self._elevators[elevator_id] = status
        return status

    def get_all_status(self) -> List[dict]:
        return [
            {**vars(e), "locked": e.id in self._locked_elevators, "emergency_recall": self._emergency_recall_active}
            for e in self._elevators.values()
        ]

    def get_status(self, elevator_id: str) -> Optional[dict]:
        e = self._elevators.get(elevator_id)
        return {**vars(e), "locked": e.id in self._locked_elevators} if e else None

    async def emergency_recall(self, target_floor: int = 1) -> dict:
        self._emergency_recall_active = True
        recalled = []
        for e in self._elevators.values():
            e.floor = target_floor
            e.direction = "idle"
            e.door_state = "open"
            e.last_updated = datetime.now(timezone.utc).isoformat()
            recalled.append(e.id)
        logger.warning("Emergency recall: %d elevators to floor %d", len(recalled), target_floor)
        return {"recalled": recalled, "target_floor": target_floor}

    async def cancel_emergency_recall(self) -> dict:
        self._emergency_recall_active = False
        for e in self._elevators.values():
            e.door_state = "closed"
        return {"status": "cancelled"}

    async def lock_elevator(self, elevator_id: str) -> dict:
        if elevator_id not in self._elevators:
            return {"error": "Elevator not found"}
        self._locked_elevators.add(elevator_id)
        return {"locked": True, "elevator_id": elevator_id}

    async def unlock_elevator(self, elevator_id: str) -> dict:
        self._locked_elevators.discard(elevator_id)
        return {"locked": False, "elevator_id": elevator_id}


elevator_service = ElevatorService()
