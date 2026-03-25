"""Adaptive Behavioral Baselines — per-camera, per-hour scene learning.

Each camera learns what "normal" looks like for each hour of each day:
- CLIP embedding baselines per camera per time bucket
- Occupancy/flow histograms (person_count, avg_speed, direction)
- Z-score anomaly detection against learned normals

A busy lobby at 9am has different "normal" than the same lobby at 2am.
"""
from __future__ import annotations

import logging
import math
import numpy as np
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from backend.config import settings

logger = logging.getLogger(__name__)

# Number of time buckets: 7 days × 24 hours = 168 buckets per camera
_DAYS = 7
_HOURS = 24
_TOTAL_BUCKETS = _DAYS * _HOURS


class BaselineBucket:
    """Stores running statistics for a single (camera, day, hour) bucket."""

    def __init__(self) -> None:
        self.person_count_sum: float = 0.0
        self.person_count_sq_sum: float = 0.0
        self.vehicle_count_sum: float = 0.0
        self.avg_speed_sum: float = 0.0
        self.avg_speed_sq_sum: float = 0.0
        self.clip_embedding_sum: Optional[np.ndarray] = None  # Running sum for mean
        self.observation_count: int = 0
        self.last_updated: Optional[str] = None

    def update(self, person_count: int, vehicle_count: int = 0,
               avg_speed: float = 0.0, clip_embedding: Optional[np.ndarray] = None) -> None:
        """Add a new observation to the running statistics."""
        self.person_count_sum += person_count
        self.person_count_sq_sum += person_count ** 2
        self.vehicle_count_sum += vehicle_count
        self.avg_speed_sum += avg_speed
        self.avg_speed_sq_sum += avg_speed ** 2
        self.observation_count += 1
        self.last_updated = datetime.now(timezone.utc).isoformat()

        if clip_embedding is not None:
            if self.clip_embedding_sum is None:
                self.clip_embedding_sum = clip_embedding.copy()
            else:
                self.clip_embedding_sum += clip_embedding

    @property
    def mean_person_count(self) -> float:
        if self.observation_count == 0:
            return 0.0
        return self.person_count_sum / self.observation_count

    @property
    def std_person_count(self) -> float:
        if self.observation_count < 2:
            return 0.0
        mean = self.mean_person_count
        variance = (self.person_count_sq_sum / self.observation_count) - mean ** 2
        return math.sqrt(max(variance, 0.0))

    @property
    def mean_speed(self) -> float:
        if self.observation_count == 0:
            return 0.0
        return self.avg_speed_sum / self.observation_count

    @property
    def std_speed(self) -> float:
        if self.observation_count < 2:
            return 0.0
        mean = self.mean_speed
        variance = (self.avg_speed_sq_sum / self.observation_count) - mean ** 2
        return math.sqrt(max(variance, 0.0))

    @property
    def mean_clip_embedding(self) -> Optional[np.ndarray]:
        if self.clip_embedding_sum is None or self.observation_count == 0:
            return None
        return self.clip_embedding_sum / self.observation_count

    def z_score_person_count(self, value: int) -> float:
        """Calculate Z-score for person count against this bucket's baseline."""
        std = self.std_person_count
        if std < 0.1:  # Not enough variance
            return 0.0 if abs(value - self.mean_person_count) < 1 else 2.0
        return (value - self.mean_person_count) / std

    def z_score_speed(self, value: float) -> float:
        """Calculate Z-score for average speed against baseline."""
        std = self.std_speed
        if std < 0.01:
            return 0.0 if abs(value - self.mean_speed) < 0.5 else 2.0
        return (value - self.mean_speed) / std

    def clip_deviation(self, embedding: np.ndarray) -> float:
        """Calculate cosine distance from baseline CLIP embedding."""
        baseline = self.mean_clip_embedding
        if baseline is None:
            return 0.0
        # Cosine similarity
        norm_a = np.linalg.norm(embedding)
        norm_b = np.linalg.norm(baseline)
        if norm_a < 1e-6 or norm_b < 1e-6:
            return 0.0
        similarity = float(np.dot(embedding, baseline) / (norm_a * norm_b))
        return 1.0 - similarity  # Convert to distance (0 = identical, 1 = orthogonal)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "mean_person_count": round(self.mean_person_count, 1),
            "std_person_count": round(self.std_person_count, 2),
            "mean_speed": round(self.mean_speed, 2),
            "std_speed": round(self.std_speed, 2),
            "observation_count": self.observation_count,
            "has_clip_baseline": self.clip_embedding_sum is not None,
            "last_updated": self.last_updated,
        }


class SceneBaselineService:
    """Manages per-camera, per-time-bucket behavioral baselines.

    Learns what "normal" looks like for each camera at each hour of each
    day of the week, enabling context-aware anomaly detection.
    """

    def __init__(self) -> None:
        # {camera_id: {(day_of_week, hour): BaselineBucket}}
        self._baselines: Dict[str, Dict[Tuple[int, int], BaselineBucket]] = defaultdict(dict)
        self._anomaly_threshold_z = 2.5  # Z-score threshold for flagging
        self._clip_deviation_threshold = 0.35  # Cosine distance threshold

    def _get_bucket_key(self, ts: Optional[datetime] = None) -> Tuple[int, int]:
        """Get the (day_of_week, hour) key for the given timestamp."""
        if ts is None:
            ts = datetime.now(timezone.utc)
        return (ts.weekday(), ts.hour)

    def _get_bucket(self, camera_id: str, key: Tuple[int, int]) -> BaselineBucket:
        """Get or create a baseline bucket."""
        if key not in self._baselines[camera_id]:
            self._baselines[camera_id][key] = BaselineBucket()
        return self._baselines[camera_id][key]

    def update_baseline(
        self,
        camera_id: str,
        person_count: int,
        vehicle_count: int = 0,
        avg_speed: float = 0.0,
        clip_embedding: Optional[np.ndarray] = None,
        timestamp: Optional[datetime] = None,
    ) -> None:
        """Update the baseline for a camera at the current time bucket."""
        key = self._get_bucket_key(timestamp)
        bucket = self._get_bucket(camera_id, key)
        bucket.update(person_count, vehicle_count, avg_speed, clip_embedding)

    def check_anomaly(
        self,
        camera_id: str,
        person_count: int,
        vehicle_count: int = 0,
        avg_speed: float = 0.0,
        clip_embedding: Optional[np.ndarray] = None,
        timestamp: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Check if current observation deviates significantly from baseline.

        Returns anomaly scores and whether thresholds are exceeded.
        """
        key = self._get_bucket_key(timestamp)
        bucket = self._get_bucket(camera_id, key)

        # Not enough data for reliable baseline
        if bucket.observation_count < 10:
            return {
                "is_anomaly": False,
                "reason": "insufficient_baseline",
                "observation_count": bucket.observation_count,
                "z_score_persons": 0.0,
                "z_score_speed": 0.0,
                "clip_deviation": 0.0,
                "baseline": bucket.to_dict(),
            }

        z_persons = bucket.z_score_person_count(person_count)
        z_speed = bucket.z_score_speed(avg_speed)
        clip_dev = bucket.clip_deviation(clip_embedding) if clip_embedding is not None else 0.0

        anomalies = []
        if abs(z_persons) > self._anomaly_threshold_z:
            direction = "higher" if z_persons > 0 else "lower"
            anomalies.append(
                f"Person count ({person_count}) is {abs(z_persons):.1f}σ {direction} "
                f"than normal ({bucket.mean_person_count:.0f}±{bucket.std_person_count:.1f})"
            )

        if abs(z_speed) > self._anomaly_threshold_z and avg_speed > 0:
            direction = "faster" if z_speed > 0 else "slower"
            anomalies.append(
                f"Movement speed is {abs(z_speed):.1f}σ {direction} than normal"
            )

        if clip_dev > self._clip_deviation_threshold:
            anomalies.append(
                f"Visual scene deviates {clip_dev:.2f} from baseline "
                f"(threshold: {self._clip_deviation_threshold})"
            )

        is_anomaly = len(anomalies) > 0
        severity = "info"
        if is_anomaly:
            max_z = max(abs(z_persons), abs(z_speed), clip_dev * 5)
            if max_z > 4.0:
                severity = "critical"
            elif max_z > 3.5:
                severity = "high"
            elif max_z > 3.0:
                severity = "medium"
            else:
                severity = "low"

        return {
            "is_anomaly": is_anomaly,
            "severity": severity,
            "anomalies": anomalies,
            "z_score_persons": round(z_persons, 2),
            "z_score_speed": round(z_speed, 2),
            "clip_deviation": round(clip_dev, 3),
            "baseline": bucket.to_dict(),
            "current": {
                "person_count": person_count,
                "vehicle_count": vehicle_count,
                "avg_speed": round(avg_speed, 2),
            },
            "time_bucket": {
                "day_of_week": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][key[0]],
                "hour": f"{key[1]:02d}:00",
            },
        }

    def get_camera_profile(self, camera_id: str) -> Dict[str, Any]:
        """Get the full baseline profile for a camera across all time buckets."""
        if camera_id not in self._baselines:
            return {"camera_id": camera_id, "status": "no_baseline", "buckets": {}}

        day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        buckets = {}
        total_obs = 0

        for (dow, hour), bucket in self._baselines[camera_id].items():
            key_str = f"{day_names[dow]}_{hour:02d}"
            buckets[key_str] = bucket.to_dict()
            total_obs += bucket.observation_count

        return {
            "camera_id": camera_id,
            "status": "active",
            "total_observations": total_obs,
            "active_buckets": len(buckets),
            "total_possible_buckets": _TOTAL_BUCKETS,
            "coverage_pct": round(len(buckets) / _TOTAL_BUCKETS * 100, 1),
            "buckets": buckets,
        }

    def get_all_camera_summaries(self) -> List[Dict[str, Any]]:
        """Get a summary of baselines for all cameras."""
        summaries = []
        for camera_id in self._baselines:
            profile = self.get_camera_profile(camera_id)
            summaries.append({
                "camera_id": camera_id,
                "total_observations": profile["total_observations"],
                "active_buckets": profile["active_buckets"],
                "coverage_pct": profile["coverage_pct"],
            })
        return sorted(summaries, key=lambda x: x["total_observations"], reverse=True)

    def get_current_expected(self, camera_id: str) -> Dict[str, Any]:
        """Get what the baseline expects for a camera right now."""
        key = self._get_bucket_key()
        bucket = self._get_bucket(camera_id, key)
        day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

        return {
            "camera_id": camera_id,
            "time_bucket": f"{day_names[key[0]]} {key[1]:02d}:00",
            "expected_person_count": round(bucket.mean_person_count, 1),
            "person_count_range": (
                f"{max(0, bucket.mean_person_count - 2*bucket.std_person_count):.0f}"
                f"-{bucket.mean_person_count + 2*bucket.std_person_count:.0f}"
            ),
            "expected_speed": round(bucket.mean_speed, 2),
            "observations": bucket.observation_count,
            "confidence": "high" if bucket.observation_count > 50 else "medium" if bucket.observation_count > 20 else "low",
        }


# ── Singleton ─────────────────────────────────────────────────────
scene_baseline = SceneBaselineService()
