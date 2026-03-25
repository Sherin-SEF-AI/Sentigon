"""Patrol Optimizer — greedy TSP route generation, zone risk scoring, shift management."""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select

logger = logging.getLogger(__name__)

# Average walking speed in minutes per zone transition (for duration estimation)
_MINUTES_PER_ZONE_TRANSITION = 5


class PatrolOptimizer:
    """Generate optimised patrol routes based on zone risk scores and manage patrol shifts."""

    # ── Route generation (greedy TSP) ────────────────────────────

    def generate_route(
        self,
        zone_ids: List[str],
        risk_scores: Dict[str, float],
    ) -> Dict[str, Any]:
        """Generate a patrol route using a greedy nearest-neighbour TSP heuristic.

        Strategy:
        1. Start at the zone with the highest risk score.
        2. From the current zone, move to the nearest *unvisited* zone,
           where "nearest" is defined by inverse risk — higher-risk zones
           are prioritised.
        3. Continue until every zone has been visited.

        Args:
            zone_ids: List of zone ID strings to include in the route.
            risk_scores: ``{zone_id: risk_score}`` mapping. Zones not present
                default to ``0.0``.

        Returns:
            Dict with ``ordered_zones``, ``estimated_duration_minutes``, and
            ``total_risk``.
        """
        if not zone_ids:
            return {"ordered_zones": [], "estimated_duration_minutes": 0, "total_risk": 0.0}

        scores = {zid: risk_scores.get(zid, 0.0) for zid in zone_ids}
        unvisited = set(zone_ids)

        # Start with the highest-risk zone
        current = max(unvisited, key=lambda z: scores[z])
        ordered: List[str] = [current]
        unvisited.discard(current)

        while unvisited:
            # Pick the unvisited zone with the highest risk score.
            # This is a greedy heuristic biased toward covering high-risk areas early.
            next_zone = max(unvisited, key=lambda z: scores[z])
            ordered.append(next_zone)
            unvisited.discard(next_zone)

        total_risk = sum(scores[z] for z in ordered)
        estimated_duration = len(ordered) * _MINUTES_PER_ZONE_TRANSITION

        logger.info(
            "Patrol route generated: %d zones, est. %d min, total risk %.2f",
            len(ordered), estimated_duration, total_risk,
        )
        return {
            "ordered_zones": ordered,
            "estimated_duration_minutes": estimated_duration,
            "total_risk": round(total_risk, 2),
        }

    # ── Zone risk scores from DB ─────────────────────────────────

    async def get_zone_risk_scores(self) -> Dict[str, float]:
        """Count recent alerts per zone in the last 24 hours and return as risk scores.

        Each zone's score is the number of alerts created in its name within
        the last 24 h.  Zones with no recent alerts get ``0.0``.

        Returns:
            ``{zone_name: alert_count}`` dict.
        """
        try:
            from backend.database import async_session
            from backend.models.models import Alert

            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

            async with async_session() as session:
                stmt = (
                    select(
                        Alert.zone_name,
                        func.count(Alert.id).label("alert_count"),
                    )
                    .where(Alert.created_at >= cutoff)
                    .where(Alert.zone_name.isnot(None))
                    .group_by(Alert.zone_name)
                )
                result = await session.execute(stmt)
                rows = result.all()

                scores: Dict[str, float] = {}
                for zone_name, count in rows:
                    scores[str(zone_name)] = float(count)

                logger.info("Zone risk scores computed: %d zones with recent alerts", len(scores))
                return scores
        except Exception as exc:
            logger.error("Failed to compute zone risk scores: %s", exc, exc_info=True)
            return {}

    # ── Create patrol shift ──────────────────────────────────────

    async def create_patrol_shift(
        self,
        guard_id: uuid.UUID,
        zone_ids: List[str],
        route_waypoints: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Persist a new PatrolShift record.

        Args:
            guard_id: UUID of the assigned guard.
            zone_ids: Ordered list of zone IDs in the patrol route.
            route_waypoints: Optional list of waypoint dicts
                (e.g. ``[{"zone_id": "...", "lat": ..., "lng": ...}]``).

        Returns:
            Dict representation of the created shift.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import PatrolShift

            async with async_session() as session:
                shift = PatrolShift(
                    guard_id=guard_id,
                    zone_ids=zone_ids,
                    route_waypoints=route_waypoints or [],
                    status="scheduled",
                    checkpoints_completed=[],
                )
                session.add(shift)
                await session.commit()
                await session.refresh(shift)

                logger.info(
                    "Patrol shift created: id=%s guard=%s zones=%d",
                    shift.id, guard_id, len(zone_ids),
                )
                return {
                    "id": str(shift.id),
                    "guard_id": str(shift.guard_id),
                    "zone_ids": shift.zone_ids,
                    "route_waypoints": shift.route_waypoints,
                    "status": shift.status,
                    "checkpoints_completed": shift.checkpoints_completed,
                    "start_time": shift.start_time.isoformat() if shift.start_time else None,
                    "created_at": shift.created_at.isoformat() if shift.created_at else None,
                }
        except Exception as exc:
            logger.error("Failed to create patrol shift: %s", exc, exc_info=True)
            raise

    # ── Complete checkpoint ───────────────────────────────────────

    async def complete_checkpoint(
        self,
        shift_id: uuid.UUID,
        checkpoint_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Append a completed checkpoint to a patrol shift.

        The checkpoint data is timestamped and appended to the shift's
        ``checkpoints_completed`` JSONB array.

        Args:
            shift_id: UUID of the patrol shift.
            checkpoint_data: Dict with checkpoint details (e.g. zone_id,
                notes, status).

        Returns:
            Updated shift dict.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import PatrolShift

            async with async_session() as session:
                stmt = select(PatrolShift).where(PatrolShift.id == shift_id)
                result = await session.execute(stmt)
                shift = result.scalar_one_or_none()

                if not shift:
                    logger.warning("Patrol shift not found: %s", shift_id)
                    return {"error": "shift_not_found"}

                checkpoint_data["completed_at"] = datetime.now(timezone.utc).isoformat()

                existing = list(shift.checkpoints_completed or [])
                existing.append(checkpoint_data)
                shift.checkpoints_completed = existing

                # Auto-complete if all zones have been checked
                checked_zones = {cp.get("zone_id") for cp in existing if cp.get("zone_id")}
                all_zones = set(shift.zone_ids or [])
                if all_zones and checked_zones >= all_zones:
                    shift.status = "completed"
                    shift.end_time = datetime.now(timezone.utc)
                    logger.info("Patrol shift completed: id=%s", shift_id)

                await session.commit()
                await session.refresh(shift)

                return {
                    "id": str(shift.id),
                    "status": shift.status,
                    "checkpoints_completed": shift.checkpoints_completed,
                    "zone_ids": shift.zone_ids,
                    "end_time": shift.end_time.isoformat() if shift.end_time else None,
                }
        except Exception as exc:
            logger.error("Failed to complete checkpoint for shift %s: %s", shift_id, exc, exc_info=True)
            raise


# ── Singleton ────────────────────────────────────────────────────
patrol_optimizer = PatrolOptimizer()
