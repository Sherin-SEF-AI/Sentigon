"""
Companion Analyzer Service
Pairwise proximity analysis from ByteTrack trajectories.
Discovers companion links between tracked persons based on proximity and behavioral sync.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Pixel-space proximity threshold (proxy for ~2 metres at typical camera angles)
_PROXIMITY_THRESHOLD_PX = 100

# Minimum co-proximity duration in seconds to qualify as a companion link
_MIN_PROXIMITY_DURATION_S = 10.0


class CompanionAnalyzer:
    """Discover companion pairs from tracked-object proximity and behavioural sync."""

    # ── Pairwise proximity analysis ──────────────────────────────

    async def compute_pairwise_proximity(
        self, tracked_persons: List[Dict]
    ) -> List[Dict]:
        """For each pair of persons, compute average distance, co-occurrence
        duration, and proximity score.

        Args:
            tracked_persons: List of dicts with keys: track_id, trajectory
                (list of {x, y, timestamp}), camera_id, and optionally
                center (x, y) and dwell_time (float).

        Returns:
            List of pairwise proximity result dicts.
        """
        results: List[Dict] = []
        n = len(tracked_persons)

        for i in range(n):
            for j in range(i + 1, n):
                person_a = tracked_persons[i]
                person_b = tracked_persons[j]

                traj_a = person_a.get("trajectory", [])
                traj_b = person_b.get("trajectory", [])

                # If trajectories have timestamp-indexed points, use them
                if traj_a and traj_b and isinstance(traj_a[0], dict):
                    pair_result = self._proximity_from_trajectories(
                        person_a, person_b, traj_a, traj_b
                    )
                else:
                    # Fallback: use center positions and dwell_time
                    pair_result = self._proximity_from_centers(person_a, person_b)

                if pair_result:
                    results.append(pair_result)

        return results

    def _proximity_from_trajectories(
        self,
        person_a: Dict,
        person_b: Dict,
        traj_a: List[Dict],
        traj_b: List[Dict],
    ) -> Optional[Dict]:
        """Compute proximity metrics from timestamp-indexed trajectory points."""
        # Build timestamp-indexed positions for person B
        b_by_time: Dict[Any, Dict] = {}
        for point in traj_b:
            ts = point.get("timestamp")
            if ts is not None:
                b_by_time[ts] = point

        distances: List[float] = []
        co_occurrence_timestamps: List[Any] = []

        for point_a in traj_a:
            ts_a = point_a.get("timestamp")
            if ts_a is not None and ts_a in b_by_time:
                point_b = b_by_time[ts_a]
                dist = self._euclidean_dict(point_a, point_b)
                distances.append(dist)
                co_occurrence_timestamps.append(ts_a)

        if not distances:
            return None

        avg_distance = sum(distances) / len(distances)

        # Co-occurrence duration
        co_occurrence_timestamps.sort()
        if len(co_occurrence_timestamps) >= 2:
            if isinstance(co_occurrence_timestamps[0], (int, float)):
                co_occurrence_duration = float(
                    co_occurrence_timestamps[-1] - co_occurrence_timestamps[0]
                )
            else:
                co_occurrence_duration = float(len(co_occurrence_timestamps))
        else:
            co_occurrence_duration = 0.0

        # Proximity score: inverse of average distance, scaled by co-occurrence
        if avg_distance > 0:
            proximity_score = min(
                1.0,
                (1.0 / avg_distance) * min(co_occurrence_duration, 300) / 300,
            )
        else:
            proximity_score = 1.0

        return {
            "person_a_track_id": person_a.get("track_id"),
            "person_b_track_id": person_b.get("track_id"),
            "average_distance": round(avg_distance, 4),
            "co_occurrence_duration": round(co_occurrence_duration, 2),
            "co_occurrence_frames": len(distances),
            "proximity_score": round(proximity_score, 4),
            "camera_id": person_a.get("camera_id"),
        }

    def _proximity_from_centers(
        self, person_a: Dict, person_b: Dict
    ) -> Optional[Dict]:
        """Compute proximity metrics from center positions and dwell_time."""
        center_a = person_a.get("center")
        center_b = person_b.get("center")
        if not center_a or not center_b:
            return None

        distance = self._euclidean_tuple(center_a, center_b)
        if distance > _PROXIMITY_THRESHOLD_PX:
            return None

        co_duration = min(
            person_a.get("dwell_time", 0),
            person_b.get("dwell_time", 0),
        )

        if co_duration < _MIN_PROXIMITY_DURATION_S:
            return None

        if distance > 0:
            proximity_score = min(
                1.0,
                (1.0 / distance) * min(co_duration, 300) / 300,
            )
        else:
            proximity_score = 1.0

        return {
            "person_a_track_id": person_a.get("track_id"),
            "person_b_track_id": person_b.get("track_id"),
            "average_distance": round(distance, 4),
            "co_occurrence_duration": round(co_duration, 2),
            "co_occurrence_frames": 1,
            "proximity_score": round(proximity_score, 4),
            "camera_id": person_a.get("camera_id"),
        }

    # ── Behavioural sync ─────────────────────────────────────────

    def compute_behavioral_sync(
        self,
        person_a_trajectory: List,
        person_b_trajectory: List,
    ) -> float:
        """Velocity correlation between two trajectories (Pearson-like).

        Accepts trajectories as either:
        - List of dicts: [{x, y, timestamp}, ...]
        - List of tuples: [(x, y), ...]

        Returns:
            A float in [-1, 1] (clamped to [0, 1] for scoring):
            1.0 = perfectly synchronised movement
            0.0 = no correlation
        """

        def _velocities_from_dicts(traj: List[Dict]) -> List[float]:
            sorted_traj = sorted(traj, key=lambda p: p.get("timestamp", 0))
            vels: List[float] = []
            for k in range(1, len(sorted_traj)):
                prev = sorted_traj[k - 1]
                curr = sorted_traj[k]
                dt = curr.get("timestamp", 0) - prev.get("timestamp", 0)
                if dt > 0:
                    dx = curr.get("x", 0) - prev.get("x", 0)
                    dy = curr.get("y", 0) - prev.get("y", 0)
                    vels.append(math.sqrt(dx * dx + dy * dy) / dt)
            return vels

        def _velocities_from_tuples(traj: List[Tuple]) -> List[float]:
            vels: List[float] = []
            for k in range(1, len(traj)):
                dx = traj[k][0] - traj[k - 1][0]
                dy = traj[k][1] - traj[k - 1][1]
                vels.append(math.sqrt(dx * dx + dy * dy))
            return vels

        # Detect trajectory format
        if not person_a_trajectory or not person_b_trajectory:
            return 0.0

        if isinstance(person_a_trajectory[0], dict):
            vels_a = _velocities_from_dicts(person_a_trajectory)
            vels_b = _velocities_from_dicts(person_b_trajectory)
        else:
            vels_a = _velocities_from_tuples(person_a_trajectory)
            vels_b = _velocities_from_tuples(person_b_trajectory)

        if not vels_a or not vels_b:
            return 0.0

        # Align to shorter
        n = min(len(vels_a), len(vels_b))
        vels_a = vels_a[:n]
        vels_b = vels_b[:n]

        if n < 2:
            return 0.0

        mean_a = sum(vels_a) / n
        mean_b = sum(vels_b) / n

        cov = sum((vels_a[k] - mean_a) * (vels_b[k] - mean_b) for k in range(n))
        var_a = sum((v - mean_a) ** 2 for v in vels_a)
        var_b = sum((v - mean_b) ** 2 for v in vels_b)

        denom = math.sqrt(var_a * var_b)
        if denom < 1e-9:
            return 0.0

        r = cov / denom  # Pearson r in [-1, 1]
        return round(max(r, 0.0), 3)  # Clamp negatives to 0

    # ── Companion discovery pipeline ─────────────────────────────

    async def discover_companions(
        self,
        tracked_persons: List[Dict],
        min_proximity_seconds: float = 30,
        min_sync_score: float = 0.3,
    ) -> List[Dict]:
        """Full pipeline returning companion link candidates.

        Steps:
        1. Compute pairwise proximity for all person pairs.
        2. Filter by minimum co-occurrence duration.
        3. Compute behavioral sync for qualifying pairs.
        4. Filter by minimum sync score.
        5. Classify link type.

        Args:
            tracked_persons: List of tracked person dicts with trajectories.
            min_proximity_seconds: Minimum co-occurrence duration threshold.
            min_sync_score: Minimum behavioral sync score threshold.

        Returns:
            List of companion link candidate dicts.
        """
        proximity_results = await self.compute_pairwise_proximity(tracked_persons)

        # Build trajectory lookup by track_id
        traj_by_id: Dict[Any, List] = {
            p.get("track_id"): p.get("trajectory", []) for p in tracked_persons
        }

        companions: List[Dict] = []

        for pair in proximity_results:
            if pair["co_occurrence_duration"] < min_proximity_seconds:
                continue

            traj_a = traj_by_id.get(pair["person_a_track_id"], [])
            traj_b = traj_by_id.get(pair["person_b_track_id"], [])

            sync_score = self.compute_behavioral_sync(traj_a, traj_b)

            if sync_score < min_sync_score:
                continue

            # Classify link type
            if sync_score > 0.7 and pair["proximity_score"] > 0.7:
                link_type = "confirmed_companion"
            elif sync_score > 0.5 or pair["proximity_score"] > 0.5:
                link_type = "probable_companion"
            else:
                link_type = "possible_companion"

            companions.append({
                "person_a_track_id": pair["person_a_track_id"],
                "person_b_track_id": pair["person_b_track_id"],
                "camera_id": pair.get("camera_id"),
                "average_distance": pair["average_distance"],
                "co_occurrence_duration": pair["co_occurrence_duration"],
                "proximity_score": pair["proximity_score"],
                "sync_score": sync_score,
                "link_type": link_type,
            })

        if companions:
            logger.info(
                "Discovered %d companion links from %d tracked persons",
                len(companions),
                len(tracked_persons),
            )
        return companions

    # ── Persist companion link ───────────────────────────────────

    async def persist_companion_link(
        self,
        entity_a_track_id: str,
        entity_b_track_id: str,
        camera_id: str,
        proximity_duration: float,
        sync_score: float,
        link_type: str,
    ) -> Dict:
        """Save a companion link to the DB CompanionLink table.

        Args:
            entity_a_track_id: Track ID of the first entity.
            entity_b_track_id: Track ID of the second entity.
            camera_id: Camera identifier.
            proximity_duration: Duration in seconds the pair was proximate.
            sync_score: Behavioral synchronization score (0-1).
            link_type: Classification of the link (e.g. confirmed_companion).

        Returns:
            Dict with the persisted companion link data.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import CompanionLink

            async with async_session() as session:
                link = CompanionLink(
                    entity_a_track_id=entity_a_track_id,
                    entity_b_track_id=entity_b_track_id,
                    camera_id=camera_id,
                    proximity_duration_seconds=proximity_duration,
                    behavioral_sync_score=sync_score,
                    link_type=link_type,
                )
                session.add(link)
                await session.commit()
                await session.refresh(link)

                result = {
                    "id": str(link.id),
                    "entity_a_track_id": link.entity_a_track_id,
                    "entity_b_track_id": link.entity_b_track_id,
                    "camera_id": link.camera_id,
                    "proximity_duration": link.proximity_duration_seconds,
                    "sync_score": link.behavioral_sync_score,
                    "link_type": link.link_type,
                    "created_at": link.created_at.isoformat() if link.created_at else None,
                }

                logger.info(
                    "Persisted companion link %s between %s and %s",
                    result["id"],
                    entity_a_track_id,
                    entity_b_track_id,
                )
                return result

        except Exception as exc:
            logger.error(
                "Failed to persist companion link (tracks %s-%s): %s",
                entity_a_track_id,
                entity_b_track_id,
                exc,
                exc_info=True,
            )
            return {
                "error": str(exc),
                "entity_a_track_id": entity_a_track_id,
                "entity_b_track_id": entity_b_track_id,
                "status": "failed",
            }

    # ── Query companion links ────────────────────────────────────

    async def get_companion_links(
        self,
        camera_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Query companion links from the database.

        Args:
            camera_id: Optional filter by camera.
            limit: Max rows to return.

        Returns:
            List of companion-link dicts ordered by creation time (newest first).
        """
        try:
            from sqlalchemy import select

            from backend.database import async_session
            from backend.models.phase2_models import CompanionLink

            async with async_session() as session:
                stmt = select(CompanionLink).order_by(
                    CompanionLink.created_at.desc()
                )

                if camera_id:
                    stmt = stmt.where(CompanionLink.camera_id == camera_id)

                stmt = stmt.limit(limit)
                result = await session.execute(stmt)
                links = result.scalars().all()

                return [
                    {
                        "id": str(lnk.id),
                        "entity_a_track_id": lnk.entity_a_track_id,
                        "entity_b_track_id": lnk.entity_b_track_id,
                        "camera_id": lnk.camera_id,
                        "proximity_duration_seconds": lnk.proximity_duration_seconds,
                        "behavioral_sync_score": lnk.behavioral_sync_score,
                        "link_type": lnk.link_type,
                        "created_at": lnk.created_at.isoformat()
                        if lnk.created_at
                        else None,
                    }
                    for lnk in links
                ]
        except Exception as exc:
            logger.error(
                "Failed to query companion links: %s", exc, exc_info=True
            )
            return []

    # ── Internal helpers ─────────────────────────────────────────

    @staticmethod
    def _euclidean_dict(p1: Dict, p2: Dict) -> float:
        """Euclidean distance between two dict points with x, y keys."""
        dx = p1.get("x", 0) - p2.get("x", 0)
        dy = p1.get("y", 0) - p2.get("y", 0)
        return math.sqrt(dx * dx + dy * dy)

    @staticmethod
    def _euclidean_tuple(
        p1: Tuple[float, float], p2: Tuple[float, float]
    ) -> float:
        """Euclidean distance between two 2D tuple points."""
        dx = p1[0] - p2[0]
        dy = p1[1] - p2[1]
        return math.sqrt(dx * dx + dy * dy)


# ── Singleton ────────────────────────────────────────────────────
companion_analyzer = CompanionAnalyzer()
