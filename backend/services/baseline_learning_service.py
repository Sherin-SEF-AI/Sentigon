"""Baseline Learning Service — Phase 3A adaptive threshold engine.

Learns what "normal" looks like for each camera/zone at each 15-minute
time slot of each day of the week by maintaining running mean and
standard deviation in the ``ActivityBaseline`` table.

Key capabilities:
- Incremental online mean/variance (Welford's algorithm) so baselines
  update without re-scanning history.
- Anomaly scoring against learned baselines (z-score based).
- Adaptive threshold generation (mean + k*std) that replaces hard-coded
  thresholds in the threat engine.
- Full baseline rebuild from historical Event data (last N days).
"""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import delete, select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Event
from backend.models.phase3_models import ActivityBaseline

logger = logging.getLogger(__name__)

# Anomaly scoring constants
_EPSILON = 0.1          # Added to std to avoid division by zero
_ANOMALY_THRESHOLD = 2.0  # z-score above which we flag as anomalous
_SIGMA_MULTIPLIER = 2.0   # For adaptive threshold: mean + k*std
_REBUILD_DAYS = 7          # Historical window for baseline rebuild


def _current_slot(ts: Optional[datetime] = None) -> int:
    """Return the 15-minute time-slot index (0-95) for *ts*."""
    if ts is None:
        ts = datetime.now(timezone.utc)
    return ts.hour * 4 + ts.minute // 15


def _current_day(ts: Optional[datetime] = None) -> int:
    """Return day-of-week (0=Monday, 6=Sunday)."""
    if ts is None:
        ts = datetime.now(timezone.utc)
    return ts.weekday()


class BaselineLearningService:
    """Manages per-camera, per-zone, per-time-slot activity baselines
    stored in PostgreSQL via the ``ActivityBaseline`` model."""

    # ------------------------------------------------------------------
    # Record a single observation (incremental update)
    # ------------------------------------------------------------------

    async def record_observation(
        self,
        db: AsyncSession,
        camera_id: uuid.UUID,
        zone_id: Optional[uuid.UUID],
        person_count: float,
        vehicle_count: float,
        movement_intensity: float,
        dwell_time: float,
        timestamp: Optional[datetime] = None,
    ) -> None:
        """Record one observation and update the running baseline using
        Welford's online algorithm for incremental mean/variance.

        Creates a new ``ActivityBaseline`` row if none exists for the
        camera + zone + day_of_week + time_slot combination; otherwise
        updates the existing row in-place.
        """
        ts = timestamp or datetime.now(timezone.utc)
        day = _current_day(ts)
        slot = _current_slot(ts)

        try:
            # Attempt to fetch existing baseline row
            query = select(ActivityBaseline).where(
                and_(
                    ActivityBaseline.camera_id == camera_id,
                    ActivityBaseline.day_of_week == day,
                    ActivityBaseline.time_slot == slot,
                )
            )
            if zone_id:
                query = query.where(ActivityBaseline.zone_id == zone_id)
            else:
                query = query.where(ActivityBaseline.zone_id.is_(None))

            result = await db.execute(query)
            baseline = result.scalars().first()

            if baseline is None:
                # First observation for this combination — create row
                baseline = ActivityBaseline(
                    camera_id=camera_id,
                    zone_id=zone_id,
                    day_of_week=day,
                    time_slot=slot,
                    avg_person_count=person_count,
                    std_person_count=0.0,
                    avg_vehicle_count=vehicle_count,
                    std_vehicle_count=0.0,
                    avg_movement_intensity=movement_intensity,
                    std_movement_intensity=0.0,
                    avg_dwell_time=dwell_time,
                    sample_count=1,
                    person_count_threshold=max(person_count * 2, 5.0),
                    vehicle_count_threshold=max(vehicle_count * 2, 3.0),
                    movement_threshold=max(movement_intensity * 2, 0.8),
                )
                db.add(baseline)
                await db.flush()
                return

            # Welford's incremental update
            n = baseline.sample_count + 1

            baseline.avg_person_count, baseline.std_person_count = self._welford_update(
                baseline.avg_person_count or 0.0,
                baseline.std_person_count or 0.0,
                baseline.sample_count,
                person_count,
            )
            baseline.avg_vehicle_count, baseline.std_vehicle_count = self._welford_update(
                baseline.avg_vehicle_count or 0.0,
                baseline.std_vehicle_count or 0.0,
                baseline.sample_count,
                vehicle_count,
            )
            baseline.avg_movement_intensity, baseline.std_movement_intensity = self._welford_update(
                baseline.avg_movement_intensity or 0.0,
                baseline.std_movement_intensity or 0.0,
                baseline.sample_count,
                movement_intensity,
            )
            # Dwell time — simple running average (no std tracked in model)
            baseline.avg_dwell_time = (
                (baseline.avg_dwell_time or 0.0) * baseline.sample_count + dwell_time
            ) / n

            baseline.sample_count = n

            # Recompute adaptive thresholds
            baseline.person_count_threshold = (
                baseline.avg_person_count + _SIGMA_MULTIPLIER * baseline.std_person_count
            )
            baseline.vehicle_count_threshold = (
                baseline.avg_vehicle_count + _SIGMA_MULTIPLIER * baseline.std_vehicle_count
            )
            baseline.movement_threshold = (
                baseline.avg_movement_intensity + _SIGMA_MULTIPLIER * baseline.std_movement_intensity
            )

            await db.flush()

        except Exception:
            logger.exception(
                "Failed to record observation for camera=%s zone=%s day=%d slot=%d",
                camera_id, zone_id, day, slot,
            )

    # ------------------------------------------------------------------
    # Get baseline for current time slot
    # ------------------------------------------------------------------

    async def get_baseline(
        self,
        db: AsyncSession,
        camera_id: uuid.UUID,
        zone_id: Optional[uuid.UUID] = None,
        timestamp: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Return the current baseline for a camera/zone at the current
        (or specified) time slot.

        Returns a dict with learned averages, standard deviations,
        thresholds, and sample count.
        """
        ts = timestamp or datetime.now(timezone.utc)
        day = _current_day(ts)
        slot = _current_slot(ts)

        try:
            query = select(ActivityBaseline).where(
                and_(
                    ActivityBaseline.camera_id == camera_id,
                    ActivityBaseline.day_of_week == day,
                    ActivityBaseline.time_slot == slot,
                )
            )
            if zone_id:
                query = query.where(
                    or_(ActivityBaseline.zone_id == zone_id, ActivityBaseline.zone_id.is_(None))
                )
            query = query.order_by(ActivityBaseline.sample_count.desc())

            result = await db.execute(query)
            baseline = result.scalars().first()
        except Exception:
            logger.exception("Failed to fetch baseline for camera %s", camera_id)
            baseline = None

        if baseline is None:
            return {
                "status": "no_baseline",
                "camera_id": str(camera_id),
                "zone_id": str(zone_id) if zone_id else None,
                "day_of_week": day,
                "time_slot": slot,
                "sample_count": 0,
            }

        return {
            "status": "active",
            "camera_id": str(camera_id),
            "zone_id": str(baseline.zone_id) if baseline.zone_id else None,
            "day_of_week": baseline.day_of_week,
            "time_slot": baseline.time_slot,
            "sample_count": baseline.sample_count,
            "avg_person_count": round(baseline.avg_person_count or 0.0, 2),
            "std_person_count": round(baseline.std_person_count or 0.0, 3),
            "person_count_threshold": round(baseline.person_count_threshold or 5.0, 2),
            "avg_vehicle_count": round(baseline.avg_vehicle_count or 0.0, 2),
            "std_vehicle_count": round(baseline.std_vehicle_count or 0.0, 3),
            "vehicle_count_threshold": round(baseline.vehicle_count_threshold or 3.0, 2),
            "avg_movement_intensity": round(baseline.avg_movement_intensity or 0.0, 3),
            "std_movement_intensity": round(baseline.std_movement_intensity or 0.0, 3),
            "movement_threshold": round(baseline.movement_threshold or 0.8, 3),
            "avg_dwell_time": round(baseline.avg_dwell_time or 0.0, 1),
            "updated_at": baseline.updated_at.isoformat() if baseline.updated_at else None,
        }

    # ------------------------------------------------------------------
    # Compute anomaly score
    # ------------------------------------------------------------------

    async def compute_anomaly_score(
        self,
        db: AsyncSession,
        camera_id: uuid.UUID,
        zone_id: Optional[uuid.UUID],
        current_values: Dict[str, float],
        timestamp: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Compare *current_values* against the learned baseline.

        Expected keys in *current_values*:
            ``person_count``, ``vehicle_count``, ``movement_intensity``

        Returns per-metric anomaly z-scores plus an overall composite
        score and a boolean ``is_anomalous``.
        """
        baseline_info = await self.get_baseline(db, camera_id, zone_id, timestamp)

        if baseline_info["status"] == "no_baseline" or baseline_info.get("sample_count", 0) < 5:
            return {
                "person_anomaly": 0.0,
                "vehicle_anomaly": 0.0,
                "movement_anomaly": 0.0,
                "overall_anomaly": 0.0,
                "is_anomalous": False,
                "reason": "insufficient_baseline",
                "sample_count": baseline_info.get("sample_count", 0),
            }

        person_z = self._z_score(
            current_values.get("person_count", 0),
            baseline_info["avg_person_count"],
            baseline_info["std_person_count"],
        )
        vehicle_z = self._z_score(
            current_values.get("vehicle_count", 0),
            baseline_info["avg_vehicle_count"],
            baseline_info["std_vehicle_count"],
        )
        movement_z = self._z_score(
            current_values.get("movement_intensity", 0),
            baseline_info["avg_movement_intensity"],
            baseline_info["std_movement_intensity"],
        )

        # Overall = weighted RMS of individual z-scores
        overall = math.sqrt(
            (person_z ** 2 * 0.5 + vehicle_z ** 2 * 0.3 + movement_z ** 2 * 0.2)
        )

        is_anomalous = (
            overall > _ANOMALY_THRESHOLD
            or person_z > _ANOMALY_THRESHOLD
            or vehicle_z > _ANOMALY_THRESHOLD
            or movement_z > _ANOMALY_THRESHOLD
        )

        return {
            "person_anomaly": round(person_z, 3),
            "vehicle_anomaly": round(vehicle_z, 3),
            "movement_anomaly": round(movement_z, 3),
            "overall_anomaly": round(overall, 3),
            "is_anomalous": is_anomalous,
            "sample_count": baseline_info["sample_count"],
            "baseline": {
                "avg_person_count": baseline_info["avg_person_count"],
                "avg_vehicle_count": baseline_info["avg_vehicle_count"],
                "avg_movement_intensity": baseline_info["avg_movement_intensity"],
            },
            "current": current_values,
        }

    # ------------------------------------------------------------------
    # Adaptive thresholds
    # ------------------------------------------------------------------

    async def get_adaptive_thresholds(
        self,
        db: AsyncSession,
        camera_id: uuid.UUID,
        zone_id: Optional[uuid.UUID] = None,
        timestamp: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Return auto-computed thresholds (mean + 2*std) for each
        metric.  These replace hard-coded thresholds in the threat
        engine and adapt to each camera's learned normal behavior.
        """
        baseline_info = await self.get_baseline(db, camera_id, zone_id, timestamp)

        if baseline_info["status"] == "no_baseline":
            # Fall back to sensible hard-coded defaults
            return {
                "source": "default",
                "person_count_threshold": 5.0,
                "vehicle_count_threshold": 3.0,
                "movement_threshold": 0.8,
                "dwell_time_threshold": 120.0,
                "sample_count": 0,
            }

        avg_p = baseline_info["avg_person_count"]
        std_p = baseline_info["std_person_count"]
        avg_v = baseline_info["avg_vehicle_count"]
        std_v = baseline_info["std_vehicle_count"]
        avg_m = baseline_info["avg_movement_intensity"]
        std_m = baseline_info["std_movement_intensity"]
        avg_d = baseline_info["avg_dwell_time"]

        return {
            "source": "learned",
            "person_count_threshold": round(avg_p + _SIGMA_MULTIPLIER * std_p, 2),
            "vehicle_count_threshold": round(avg_v + _SIGMA_MULTIPLIER * std_v, 2),
            "movement_threshold": round(avg_m + _SIGMA_MULTIPLIER * std_m, 3),
            "dwell_time_threshold": round(max(avg_d * 2.0, 60.0), 1),
            "sample_count": baseline_info["sample_count"],
            "updated_at": baseline_info.get("updated_at"),
        }

    # ------------------------------------------------------------------
    # Rebuild baselines from historical Event data
    # ------------------------------------------------------------------

    async def rebuild_baselines(
        self,
        db: AsyncSession,
        camera_id: Optional[uuid.UUID] = None,
        days: int = _REBUILD_DAYS,
    ) -> Dict[str, Any]:
        """Rebuild baselines from historical Event data for the last
        *days* days.

        Groups events by (camera_id, day_of_week, time_slot) and
        computes aggregate mean/std for person_count, vehicle_count,
        and movement_intensity extracted from the Event.detections JSONB.

        If *camera_id* is provided, only that camera's baselines are
        rebuilt; otherwise all cameras are processed.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        rebuilt = 0
        errors = 0

        try:
            # Build the base query for historical events
            event_query = select(Event).where(Event.timestamp >= cutoff)
            if camera_id:
                event_query = event_query.where(Event.camera_id == camera_id)
            event_query = event_query.order_by(Event.timestamp)

            result = await db.execute(event_query)
            events = result.scalars().all()

            if not events:
                return {"status": "no_events", "rebuilt": 0, "errors": 0}

            # Aggregate into buckets: (camera_id, zone_id, day, slot) -> list of observations
            buckets: Dict[tuple, List[Dict[str, float]]] = {}
            for event in events:
                ts = event.timestamp
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                day = ts.weekday()
                slot = _current_slot(ts)
                key = (event.camera_id, event.zone_id, day, slot)

                detections = event.detections or {}
                person_count = float(detections.get("person_count", 0))
                vehicle_count = float(detections.get("vehicle_count", 0))

                # Extract movement intensity: average confidence of
                # detected objects as a proxy when no explicit field exists.
                objects = detections.get("objects", [])
                movement_intensity = 0.0
                if objects:
                    movement_intensity = sum(
                        float(o.get("confidence", 0)) for o in objects
                    ) / len(objects)

                dwell_time = 0.0
                for obj in objects:
                    dwell_time = max(dwell_time, float(obj.get("dwell_time", 0)))

                if key not in buckets:
                    buckets[key] = []
                buckets[key].append({
                    "person_count": person_count,
                    "vehicle_count": vehicle_count,
                    "movement_intensity": movement_intensity,
                    "dwell_time": dwell_time,
                })

            # Delete existing baselines that will be rebuilt
            if camera_id:
                await db.execute(
                    delete(ActivityBaseline).where(
                        ActivityBaseline.camera_id == camera_id
                    )
                )
            else:
                # Delete only baselines for cameras that appear in the event data
                cam_ids = list({k[0] for k in buckets.keys()})
                if cam_ids:
                    await db.execute(
                        delete(ActivityBaseline).where(
                            ActivityBaseline.camera_id.in_(cam_ids)
                        )
                    )
            await db.flush()

            # Create fresh baseline rows from aggregated data
            for (cam_id, zone_id_val, day, slot), observations in buckets.items():
                try:
                    n = len(observations)
                    if n == 0:
                        continue

                    pc = [o["person_count"] for o in observations]
                    vc = [o["vehicle_count"] for o in observations]
                    mi = [o["movement_intensity"] for o in observations]
                    dt = [o["dwell_time"] for o in observations]

                    avg_p, std_p = self._batch_mean_std(pc)
                    avg_v, std_v = self._batch_mean_std(vc)
                    avg_m, std_m = self._batch_mean_std(mi)
                    avg_d = sum(dt) / n if n else 0.0

                    baseline = ActivityBaseline(
                        camera_id=cam_id,
                        zone_id=zone_id_val,
                        day_of_week=day,
                        time_slot=slot,
                        avg_person_count=avg_p,
                        std_person_count=std_p,
                        avg_vehicle_count=avg_v,
                        std_vehicle_count=std_v,
                        avg_movement_intensity=avg_m,
                        std_movement_intensity=std_m,
                        avg_dwell_time=avg_d,
                        sample_count=n,
                        person_count_threshold=avg_p + _SIGMA_MULTIPLIER * std_p,
                        vehicle_count_threshold=avg_v + _SIGMA_MULTIPLIER * std_v,
                        movement_threshold=avg_m + _SIGMA_MULTIPLIER * std_m,
                    )
                    db.add(baseline)
                    rebuilt += 1
                except Exception:
                    logger.exception(
                        "Failed to rebuild baseline for cam=%s day=%d slot=%d",
                        cam_id, day, slot,
                    )
                    errors += 1

            await db.flush()

        except Exception:
            logger.exception("Baseline rebuild failed")
            return {"status": "error", "rebuilt": rebuilt, "errors": errors + 1}

        logger.info(
            "Baseline rebuild complete: %d baselines created, %d errors",
            rebuilt, errors,
        )
        return {
            "status": "complete",
            "rebuilt": rebuilt,
            "errors": errors,
            "days_scanned": days,
            "camera_id": str(camera_id) if camera_id else "all",
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _welford_update(
        old_mean: float,
        old_std: float,
        old_n: int,
        new_value: float,
    ) -> tuple[float, float]:
        """Welford's online algorithm for incremental mean and standard
        deviation.

        Given the previous (mean, std, n) and a new observation, return
        the updated (mean, std).
        """
        if old_n <= 0:
            return (new_value, 0.0)

        n = old_n + 1
        # Reconstruct running sums from stored mean/std
        old_variance = old_std ** 2
        # M2 = variance * (n-1)
        m2 = old_variance * old_n

        delta = new_value - old_mean
        new_mean = old_mean + delta / n
        delta2 = new_value - new_mean
        m2 = m2 + delta * delta2

        new_variance = m2 / n if n > 1 else 0.0
        new_std = math.sqrt(max(new_variance, 0.0))
        return (new_mean, new_std)

    @staticmethod
    def _z_score(current: float, mean: float, std: float) -> float:
        """Compute z-score with epsilon-guarded denominator."""
        return abs(current - mean) / (std + _EPSILON)

    @staticmethod
    def _batch_mean_std(values: List[float]) -> tuple[float, float]:
        """Compute mean and population std from a list of values."""
        n = len(values)
        if n == 0:
            return (0.0, 0.0)
        mean = sum(values) / n
        if n < 2:
            return (mean, 0.0)
        variance = sum((v - mean) ** 2 for v in values) / n
        return (mean, math.sqrt(max(variance, 0.0)))


# ── Module-level singleton ───────────────────────────────────────────

baseline_learning_service = BaselineLearningService()
