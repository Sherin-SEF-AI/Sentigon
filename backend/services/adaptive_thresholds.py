"""Adaptive thresholds cache — wires learned baselines into the hot loop.

`baseline_learning_service.get_adaptive_thresholds` returns per-camera/zone
thresholds (mean + 2*std of learned-normal), but it is async and hits the DB —
too expensive to call per frame from the synchronous detection loop. This cache
bridges the gap: an async `refresh()` (called on a throttle from the monitoring
agent, which already holds a DB session) populates an in-memory table, and a
fast sync `get()` lets hot-loop code (e.g. temporal_behaviour) read a learned
threshold, transparently falling back to the caller's hard-coded default when no
fresh baseline exists.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_TTL_SECONDS = 900.0  # a cached threshold older than this is treated as absent


class AdaptiveThresholds:
    def __init__(self) -> None:
        # camera_id(str) -> {metric: value, "_t": fetched_at}
        self._cache: Dict[str, Dict[str, Any]] = {}

    def get(self, camera_id: str, key: str, default: float) -> float:
        """Return a fresh learned threshold for the camera, else `default`."""
        entry = self._cache.get(str(camera_id))
        if not entry:
            return default
        if time.time() - entry.get("_t", 0.0) > _TTL_SECONDS:
            return default
        val = entry.get(key)
        return float(val) if isinstance(val, (int, float)) else default

    def source(self, camera_id: str) -> str:
        entry = self._cache.get(str(camera_id))
        if not entry or time.time() - entry.get("_t", 0.0) > _TTL_SECONDS:
            return "default"
        return entry.get("source", "default")

    async def refresh(self, db, camera_id: str, zone_id: Optional[str] = None) -> None:
        """Pull the latest learned thresholds for a camera into the cache."""
        try:
            from backend.services.baseline_learning_service import baseline_learning_service
            cam_uuid = uuid.UUID(str(camera_id))
            zone_uuid = uuid.UUID(str(zone_id)) if zone_id else None
            thr = await baseline_learning_service.get_adaptive_thresholds(db, cam_uuid, zone_uuid)
            thr["_t"] = time.time()
            self._cache[str(camera_id)] = thr
        except Exception as exc:  # noqa: BLE001 — never let threshold refresh break the loop
            logger.debug("adaptive_thresholds.refresh failed for %s: %s", camera_id, exc)


adaptive_thresholds = AdaptiveThresholds()
