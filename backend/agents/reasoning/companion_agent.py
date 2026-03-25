"""Companion Discovery Agent — detects co-moving entity pairs.

For zones with 2+ tracked persons, computes pairwise proximity and
behavioral synchronization from ByteTrack trajectories, logs companion
links, and publishes discoveries to CH_CORRELATION.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_CORRELATION, CH_PERCEPTIONS

logger = logging.getLogger(__name__)

_MAX_CAMERAS_PER_CYCLE = 3
_MIN_PERSONS_FOR_ANALYSIS = 2
_MIN_PROXIMITY_SECONDS = 15.0
_MIN_SYNC_SCORE = 0.3
_MAX_PROXIMITY_PIXELS = 200  # Max distance in pixels to consider "proximate"


class CompanionDiscoveryAgent(BaseAgent):
    """Reasoning-tier agent for discovering co-moving entity pairs.

    On each cycle:
    1. Finds cameras with 2+ active person tracks.
    2. Computes pairwise proximity distances over trajectory windows.
    3. Calculates velocity correlation (behavioral sync score).
    4. If proximity + sync exceed thresholds, logs as companion link.
    5. Publishes discoveries to CH_CORRELATION for other agents.
    """

    def __init__(self) -> None:
        super().__init__(
            name="companion_discovery",
            role="Companion & Group Detection",
            description=(
                "Discovers co-moving entity pairs by analyzing pairwise "
                "proximity duration and velocity correlation from ByteTrack "
                "trajectories. Identifies groups, escorts, and suspicious "
                "coordinated movement."
            ),
            tier="reasoning",
            model_name="deepseek-v3.1:671b-cloud",
            tool_names=[
                "get_current_detections",
                "get_tracking_trajectory",
                "create_alert",
                "store_observation",
            ],
            subscriptions=[CH_CORTEX, CH_PERCEPTIONS],
            cycle_interval=10.0,
            token_budget_per_cycle=10000,
        )
        self._camera_index = 0
        # Track already-discovered pairs to avoid duplicates (expires on track loss)
        self._known_pairs: dict[str, dict] = {}  # "cam:trackA:trackB" -> info
        self._discovery_count = 0

    async def think(self, context: dict) -> dict:
        """Main companion discovery loop."""
        from backend.services.yolo_detector import yolo_detector
        from backend.services.video_capture import capture_manager

        inbox = context.get("inbox_messages", [])

        # Handle Cortex directives
        for msg in inbox:
            if msg.get("type") == "force_companion_check":
                camera_id = msg.get("camera_id")
                if camera_id:
                    await self._analyze_camera(camera_id)

        # Find cameras with 2+ persons
        camera_ids = self._get_cameras_with_multiple_persons()
        if not camera_ids:
            return {"status": "idle", "reason": "no_cameras_with_multiple_persons"}

        # Round-robin
        start = self._camera_index % len(camera_ids)
        batch = []
        for i in range(_MAX_CAMERAS_PER_CYCLE):
            idx = (start + i) % len(camera_ids)
            batch.append(camera_ids[idx])
            if len(batch) >= len(camera_ids):
                break
        self._camera_index = (start + len(batch)) % max(len(camera_ids), 1)

        results = []
        for camera_id in batch:
            try:
                discoveries = await self._analyze_camera(camera_id)
                results.extend(discoveries)
            except Exception as exc:
                logger.error("Companion analysis failed for camera %s: %s", camera_id, exc)

        new_discoveries = sum(1 for r in results if r.get("new_discovery"))

        return {
            "status": "processed" if results else "idle",
            "cameras_analyzed": len(batch),
            "pairs_analyzed": len(results),
            "new_discoveries": new_discoveries,
            "total_known_pairs": len(self._known_pairs),
            "total_discoveries": self._discovery_count,
        }

    async def _analyze_camera(self, camera_id: str) -> list[dict]:
        """Compute pairwise proximity and sync for all persons in a camera."""
        from backend.services.yolo_detector import yolo_detector

        tracked = yolo_detector.get_tracked_objects(camera_id)
        persons = [obj for obj in tracked if obj.class_name == "person" and obj.dwell_time >= 2.0]

        if len(persons) < _MIN_PERSONS_FOR_ANALYSIS:
            return []

        results = []

        # Compute all pairwise comparisons
        for i in range(len(persons)):
            for j in range(i + 1, len(persons)):
                person_a = persons[i]
                person_b = persons[j]

                pair_key = f"{camera_id}:{min(person_a.track_id, person_b.track_id)}:{max(person_a.track_id, person_b.track_id)}"

                # Current distance
                ax, ay = person_a.center
                bx, by = person_b.center
                distance = math.sqrt((ax - bx) ** 2 + (ay - by) ** 2)

                if distance > _MAX_PROXIMITY_PIXELS:
                    continue

                # Compute how long they've been proximate
                proximity_duration = self._compute_proximity_duration(person_a, person_b)

                # Compute velocity correlation (behavioral sync)
                sync_score = self._compute_velocity_correlation(person_a, person_b)

                # Determine link type
                link_type = "proximity"
                if sync_score >= _MIN_SYNC_SCORE:
                    link_type = "both" if proximity_duration >= _MIN_PROXIMITY_SECONDS else "behavioral"

                is_companion = (
                    (proximity_duration >= _MIN_PROXIMITY_SECONDS and distance < _MAX_PROXIMITY_PIXELS)
                    or sync_score >= 0.5
                )

                result = {
                    "camera_id": camera_id,
                    "track_a": person_a.track_id,
                    "track_b": person_b.track_id,
                    "distance_px": round(distance, 1),
                    "proximity_duration_s": round(proximity_duration, 1),
                    "sync_score": round(sync_score, 3),
                    "link_type": link_type,
                    "is_companion": is_companion,
                    "new_discovery": False,
                }

                if is_companion and pair_key not in self._known_pairs:
                    result["new_discovery"] = True
                    self._known_pairs[pair_key] = {
                        "first_seen": datetime.now(timezone.utc).isoformat(),
                        "proximity_duration": proximity_duration,
                        "sync_score": sync_score,
                    }
                    self._discovery_count += 1

                    # Persist to DB
                    try:
                        from backend.database import async_session
                        from backend.models.phase2_models import CompanionLink

                        async with async_session() as session:
                            link = CompanionLink(
                                entity_a_track_id=person_a.track_id,
                                entity_b_track_id=person_b.track_id,
                                camera_id=camera_id,
                                proximity_duration_seconds=proximity_duration,
                                behavioral_sync_score=sync_score,
                                link_type=link_type,
                            )
                            session.add(link)
                            await session.commit()
                    except Exception as exc:
                        logger.warning("Failed to persist companion link: %s", exc)

                    # Publish to correlation channel
                    await self.send_message(CH_CORRELATION, {
                        "type": "companion_discovered",
                        "camera_id": camera_id,
                        "track_a": person_a.track_id,
                        "track_b": person_b.track_id,
                        "distance_px": round(distance, 1),
                        "proximity_duration_s": round(proximity_duration, 1),
                        "sync_score": round(sync_score, 3),
                        "link_type": link_type,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

                    await self.log_action("companion_discovered", {
                        "camera_id": camera_id,
                        "track_a": person_a.track_id,
                        "track_b": person_b.track_id,
                        "sync_score": round(sync_score, 3),
                        "proximity_duration": round(proximity_duration, 1),
                        "decision": (
                            f"Companion pair: tracks {person_a.track_id} & "
                            f"{person_b.track_id} (sync={sync_score:.2f}, "
                            f"proximity={proximity_duration:.0f}s)"
                        ),
                    })

                results.append(result)

        # Clean stale pair keys
        active_tids = {obj.track_id for obj in tracked}
        stale_keys = [
            k for k in self._known_pairs
            if k.startswith(f"{camera_id}:")
            and not all(
                int(tid) in active_tids
                for tid in k.split(":")[1:]
                if tid.isdigit()
            )
        ]
        for k in stale_keys:
            del self._known_pairs[k]

        return results

    @staticmethod
    def _compute_proximity_duration(person_a, person_b) -> float:
        """Estimate how long two persons have been near each other.

        Uses the overlap of their dwell times as a proxy: both must have
        been tracked for the minimum of their dwell times, and we check
        their trajectory overlap.
        """
        min_dwell = min(person_a.dwell_time, person_b.dwell_time)

        traj_a = person_a.trajectory
        traj_b = person_b.trajectory

        if not traj_a or not traj_b:
            return 0.0

        # Check last N trajectory points for proximity
        overlap_len = min(len(traj_a), len(traj_b), 50)
        if overlap_len < 3:
            return 0.0

        proximate_frames = 0
        for k in range(1, overlap_len + 1):
            ax, ay = traj_a[-k]
            bx, by = traj_b[-k]
            dist = math.sqrt((ax - bx) ** 2 + (ay - by) ** 2)
            if dist < _MAX_PROXIMITY_PIXELS:
                proximate_frames += 1

        # Convert frames to seconds (assume ~10 FPS)
        proximity_seconds = proximate_frames * 0.1
        return min(proximity_seconds, min_dwell)

    @staticmethod
    def _compute_velocity_correlation(person_a, person_b) -> float:
        """Compute velocity correlation between two trajectories.

        Returns a value between 0 (uncorrelated) and 1 (perfectly synchronized).
        Uses dot product of velocity vectors normalized by magnitudes.
        """
        traj_a = person_a.trajectory
        traj_b = person_b.trajectory

        if not traj_a or not traj_b:
            return 0.0

        overlap_len = min(len(traj_a), len(traj_b), 30)
        if overlap_len < 5:
            return 0.0

        # Compute velocity vectors for both trajectories
        dot_sum = 0.0
        mag_a_sum = 0.0
        mag_b_sum = 0.0
        valid_count = 0

        for k in range(1, overlap_len):
            # Velocity A
            vax = traj_a[-k][0] - traj_a[-k - 1][0]
            vay = traj_a[-k][1] - traj_a[-k - 1][1]
            # Velocity B
            vbx = traj_b[-k][0] - traj_b[-k - 1][0]
            vby = traj_b[-k][1] - traj_b[-k - 1][1]

            mag_a = math.sqrt(vax ** 2 + vay ** 2)
            mag_b = math.sqrt(vbx ** 2 + vby ** 2)

            if mag_a < 0.5 and mag_b < 0.5:
                # Both stationary — count as correlated
                dot_sum += 1.0
                mag_a_sum += 1.0
                mag_b_sum += 1.0
                valid_count += 1
                continue

            if mag_a < 0.1 or mag_b < 0.1:
                continue

            # Normalized dot product
            dot = (vax * vbx + vay * vby) / (mag_a * mag_b)
            dot_sum += max(dot, 0)  # Only positive correlation
            mag_a_sum += 1.0
            mag_b_sum += 1.0
            valid_count += 1

        if valid_count < 3:
            return 0.0

        return min(dot_sum / valid_count, 1.0)

    @staticmethod
    def _get_cameras_with_multiple_persons() -> list[str]:
        """Get cameras with 2+ active person tracks."""
        from backend.services.video_capture import capture_manager
        from backend.services.yolo_detector import yolo_detector

        camera_ids = []
        streams = capture_manager.list_streams()
        for cam_id, stream in streams.items():
            if not stream.is_running:
                continue
            person_count = yolo_detector.get_person_count(cam_id)
            if person_count >= _MIN_PERSONS_FOR_ANALYSIS:
                camera_ids.append(cam_id)
        return camera_ids
