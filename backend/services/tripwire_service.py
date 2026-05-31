"""Tripwire (line-crossing) detection service.

Loads per-camera tripwires (with a short cache), checks tracked objects'
trajectories against them, and emits crossing events. Dedup state keeps a single
crossing from re-firing every frame while the object straddles the line.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.tripwire_models import Tripwire
from backend.services.line_crossing import latest_crossing

logger = structlog.get_logger()

_CACHE_TTL_SECONDS = 30.0
_DEDUP_SECONDS = 5.0  # min gap between fires for the same (tripwire, track)


class TripwireService:
    def __init__(self) -> None:
        # camera_id -> (loaded_at, [tripwire dicts])
        self._cache: Dict[str, tuple[float, List[Dict[str, Any]]]] = {}
        # (tripwire_id, track_id) -> last_fire_monotonic
        self._last_fire: Dict[tuple, float] = {}

    async def load_for_camera(self, db: AsyncSession, camera_id: str) -> List[Dict[str, Any]]:
        """Return active tripwires for a camera (cached for a few seconds)."""
        import uuid as _uuid

        now = time.monotonic()
        cached = self._cache.get(camera_id)
        if cached and (now - cached[0]) < _CACHE_TTL_SECONDS:
            return cached[1]

        try:
            rows = (
                await db.execute(
                    select(Tripwire).where(
                        Tripwire.camera_id == _uuid.UUID(camera_id),
                        Tripwire.is_active.is_(True),
                    )
                )
            ).scalars().all()
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("tripwire.load_failed", camera_id=camera_id, error=str(e))
            return self._cache.get(camera_id, (0, []))[1]

        wires = [
            {
                "id": str(w.id),
                "name": w.name,
                "a": tuple(w.point_a),
                "b": tuple(w.point_b),
                "direction": w.direction or "both",
                "classes": set(w.classes or ["person"]),
                "severity": w.severity or "medium",
            }
            for w in rows
        ]
        self._cache[camera_id] = (now, wires)
        return wires

    def check_object(
        self, wire: Dict[str, Any], track_id: Optional[int], class_name: str,
        trajectory: List, now_monotonic: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """Check one tracked object against one tripwire. Returns a crossing
        event dict if it just crossed in a matching direction, else None.

        Pure of DB; deduped per (tripwire, track) within a short window.
        """
        if class_name not in wire["classes"]:
            return None
        direction = latest_crossing(trajectory, wire["a"], wire["b"])
        if direction is None:
            return None
        want = wire["direction"]
        if want != "both" and want != direction:
            return None

        now = now_monotonic if now_monotonic is not None else time.monotonic()
        key = (wire["id"], track_id)
        last = self._last_fire.get(key, 0.0)
        if now - last < _DEDUP_SECONDS:
            return None
        self._last_fire[key] = now

        return {
            "signature": "tripwire_crossing",
            "description": f"{class_name} crossed tripwire '{wire['name']}' ({direction})",
            "severity": wire["severity"],
            "confidence": 0.9,
            "detection_method": "line_crossing",
            "tripwire_id": wire["id"],
            "tripwire_name": wire["name"],
            "direction": direction,
            "track_id": track_id,
        }

    async def check_camera(
        self, db: AsyncSession, camera_id: str, tracked_objects: List[Any],
    ) -> List[Dict[str, Any]]:
        """Check all tracked objects on a camera against its tripwires.

        ``tracked_objects`` are yolo_detector TrackedObject instances (with
        ``class_name``, ``track_id``, ``trajectory``). Returns crossing events.
        """
        wires = await self.load_for_camera(db, camera_id)
        if not wires:
            return []
        events: List[Dict[str, Any]] = []
        now = time.monotonic()
        for obj in tracked_objects:
            traj = getattr(obj, "trajectory", None) or []
            if len(traj) < 2:
                continue
            cls = getattr(obj, "class_name", "")
            tid = getattr(obj, "track_id", None)
            for wire in wires:
                evt = self.check_object(wire, tid, cls, traj, now_monotonic=now)
                if evt:
                    events.append(evt)
        return events

    def invalidate_cache(self, camera_id: Optional[str] = None) -> None:
        """Drop cached tripwires (call after create/update/delete)."""
        if camera_id is None:
            self._cache.clear()
        else:
            self._cache.pop(camera_id, None)


tripwire_service = TripwireService()
