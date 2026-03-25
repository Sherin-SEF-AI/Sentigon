"""Zone management — polygon containment, occupancy tracking, breach detection."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models import Zone

logger = logging.getLogger(__name__)


class ZoneManager:
    """Manages spatial zones with polygon containment, occupancy tracking,
    and breach detection using ray-casting point-in-polygon tests."""

    def __init__(self) -> None:
        self._occupancy_cache: Dict[str, int] = {}  # zone_id -> count

    # ── Point-in-polygon (ray-casting algorithm) ─────────────

    @staticmethod
    def check_point_in_zone(
        polygon: List[List[float]],
        point: Tuple[float, float],
    ) -> bool:
        """Return True if *point* (x, y) lies inside the given *polygon*.

        Uses the ray-casting (even-odd) algorithm.  The polygon is a list
        of ``[x, y]`` vertices; the last edge connecting the final vertex
        back to the first is implicit.
        """
        if not polygon or len(polygon) < 3:
            return False

        x, y = point
        n = len(polygon)
        inside = False

        j = n - 1
        for i in range(n):
            xi, yi = polygon[i][0], polygon[i][1]
            xj, yj = polygon[j][0], polygon[j][1]

            # Check if the ray from (x, y) going right crosses edge (i, j)
            if ((yi > y) != (yj > y)) and (
                x < (xj - xi) * (y - yi) / (yj - yi) + xi
            ):
                inside = not inside
            j = i

        return inside

    # ── Occupancy tracking ───────────────────────────────────

    async def update_occupancy(
        self,
        zone_id: str,
        count: int,
    ) -> Dict[str, Any]:
        """Persist a new occupancy count for *zone_id* and return zone state.

        Returns a dict with the updated values and a flag indicating
        whether the zone's ``max_occupancy`` has been exceeded.
        """
        self._occupancy_cache[zone_id] = count

        try:
            async with async_session() as session:
                result = await session.execute(
                    select(Zone).where(Zone.id == uuid.UUID(zone_id))
                )
                zone = result.scalar_one_or_none()
                if zone is None:
                    logger.warning("Zone not found for occupancy update: %s", zone_id)
                    return {"zone_id": zone_id, "error": "zone_not_found"}

                zone.current_occupancy = count
                await session.commit()

                exceeded = (
                    zone.max_occupancy is not None and count > zone.max_occupancy
                )

                state = {
                    "zone_id": zone_id,
                    "zone_name": zone.name,
                    "zone_type": zone.zone_type,
                    "current_occupancy": count,
                    "max_occupancy": zone.max_occupancy,
                    "exceeded": exceeded,
                    "alert_on_breach": zone.alert_on_breach,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }

                if exceeded:
                    logger.warning(
                        "Zone '%s' occupancy exceeded: %d / %d",
                        zone.name,
                        count,
                        zone.max_occupancy,
                    )

                return state

        except Exception as exc:
            logger.error("Failed to update occupancy for zone %s: %s", zone_id, exc)
            return {"zone_id": zone_id, "error": str(exc)}

    # ── Breach detection ─────────────────────────────────────

    async def check_zone_breaches(
        self,
        detections: List[Dict[str, Any]],
        zones: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        """Check a set of detections against zone polygons for breaches.

        Parameters
        ----------
        detections:
            Each detection dict should contain at minimum:
            ``{"class": str, "bbox": [x1, y1, x2, y2], "confidence": float}``.
            The centre-point of the bounding box is used for the containment
            test.
        zones:
            Optional pre-fetched list of zone dicts.  If *None* the active
            restricted zones are loaded from the database.  Each zone dict
            must include ``id``, ``name``, ``zone_type``, ``polygon``,
            ``alert_on_breach``, and ``max_occupancy``.

        Returns
        -------
        A list of breach records (may be empty).
        """
        if zones is None:
            zones = await self._load_active_restricted_zones()

        if not zones or not detections:
            return []

        breaches: List[Dict[str, Any]] = []

        for zone in zones:
            polygon = zone.get("polygon")
            if not polygon or len(polygon) < 3:
                continue

            zone_id = str(zone["id"])
            zone_name = zone.get("name", "unknown")
            zone_type = zone.get("zone_type", "general")

            persons_in_zone = 0

            for det in detections:
                bbox = det.get("bbox")
                if bbox is None or len(bbox) < 4:
                    continue

                # Centre point of the bounding box
                cx = (bbox[0] + bbox[2]) / 2.0
                cy = (bbox[1] + bbox[3]) / 2.0

                if self.check_point_in_zone(polygon, (cx, cy)):
                    det_class = det.get("class", "unknown")

                    if det_class == "person":
                        persons_in_zone += 1

                    # Restricted zone breach
                    if zone_type == "restricted":
                        breaches.append({
                            "type": "zone_breach",
                            "zone_id": zone_id,
                            "zone_name": zone_name,
                            "zone_type": zone_type,
                            "detection_class": det_class,
                            "detection_confidence": det.get("confidence", 0.0),
                            "point": [cx, cy],
                            "alert_on_breach": zone.get("alert_on_breach", False),
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        })

            # Occupancy breach
            max_occ = zone.get("max_occupancy")
            if max_occ is not None and persons_in_zone > max_occ:
                breaches.append({
                    "type": "occupancy_exceeded",
                    "zone_id": zone_id,
                    "zone_name": zone_name,
                    "zone_type": zone_type,
                    "current_count": persons_in_zone,
                    "max_occupancy": max_occ,
                    "alert_on_breach": zone.get("alert_on_breach", False),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

            # Keep cache in sync
            self._occupancy_cache[zone_id] = persons_in_zone

        if breaches:
            logger.info("Zone breach check found %d breach(es)", len(breaches))

        return breaches

    # ── Helpers ───────────────────────────────────────────────

    async def _load_active_restricted_zones(self) -> List[Dict[str, Any]]:
        """Fetch all active zones that are restricted or have alert_on_breach."""
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(Zone).where(
                        Zone.is_active == True,  # noqa: E712
                    )
                )
                zones = result.scalars().all()

                return [
                    {
                        "id": str(z.id),
                        "name": z.name,
                        "zone_type": z.zone_type,
                        "polygon": z.polygon,
                        "max_occupancy": z.max_occupancy,
                        "alert_on_breach": z.alert_on_breach,
                    }
                    for z in zones
                    if z.zone_type == "restricted" or z.alert_on_breach
                ]
        except Exception as exc:
            logger.error("Failed to load zones: %s", exc)
            return []

    async def get_zone_states(self) -> List[Dict[str, Any]]:
        """Return current occupancy state for all active zones."""
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(Zone).where(Zone.is_active == True).order_by(Zone.name)  # noqa: E712
                )
                zones = result.scalars().all()

                return [
                    {
                        "zone_id": str(z.id),
                        "zone_name": z.name,
                        "zone_type": z.zone_type,
                        "current_occupancy": z.current_occupancy or 0,
                        "max_occupancy": z.max_occupancy,
                        "exceeded": (
                            z.max_occupancy is not None
                            and (z.current_occupancy or 0) > z.max_occupancy
                        ),
                    }
                    for z in zones
                ]
        except Exception as exc:
            logger.error("Failed to get zone states: %s", exc)
            return []

    def get_cached_occupancy(self, zone_id: str) -> Optional[int]:
        """Return the in-memory cached occupancy (may be stale)."""
        return self._occupancy_cache.get(zone_id)


# Singleton
zone_manager = ZoneManager()
