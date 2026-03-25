"""Background CLIP embedding pipeline.

Periodically embeds frames from active cameras, stores in Qdrant,
and detects visual anomalies via embedding distance.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional

from backend.config import settings

logger = logging.getLogger(__name__)


class CLIPPipeline:
    """Async background pipeline that embeds camera frames via CLIP."""

    def __init__(self):
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._last_embed_time: Dict[str, float] = {}
        self._last_embedding: Dict[str, List[float]] = {}
        self._frames_embedded: int = 0
        self._anomalies_detected: int = 0
        self._last_cleanup: float = 0.0
        self._anomaly_log: List[Dict] = []  # recent anomalies (ring buffer)

    async def start(self):
        """Start the background embedding loop."""
        if not settings.CLIP_ENABLED:
            logger.info("CLIP pipeline disabled (CLIP_ENABLED=false)")
            return

        if self._running:
            return

        self._running = True
        self._task = asyncio.create_task(self._embed_loop())
        logger.info(
            "CLIP pipeline started: interval=%ds threshold=%.2f",
            settings.CLIP_EMBED_INTERVAL,
            settings.CLIP_ANOMALY_THRESHOLD,
        )

    async def stop(self):
        """Gracefully stop the pipeline."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("CLIP pipeline stopped")

    async def _embed_loop(self):
        """Main loop: iterate cameras, embed frames at interval."""
        # Delay startup to let cameras initialize
        await asyncio.sleep(5)

        # Lazy imports to avoid circular dependencies
        from backend.services.clip_embedder import clip_embedder
        from backend.services.vector_store import vector_store

        # Warm up model on first run
        try:
            clip_embedder._ensure_loaded()
            logger.info("CLIP model warmed up for pipeline")
        except Exception as e:
            logger.error("CLIP model failed to load, pipeline disabled: %s", e)
            self._running = False
            return

        while self._running:
            try:
                await self._process_cameras(clip_embedder, vector_store)
                await self._maybe_cleanup(vector_store)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("CLIP pipeline error: %s", e)

            await asyncio.sleep(1)  # check interval every second

    async def _process_cameras(self, clip_embedder, vector_store):
        """Process all active cameras."""
        try:
            from backend.services.video_capture import capture_manager
        except (ImportError, AttributeError):
            return

        now = time.time()
        streams = capture_manager.list_streams()

        for camera_id, stream in streams.items():
            if not stream.is_running:
                continue

            # Throttle per camera
            last = self._last_embed_time.get(camera_id, 0)
            if now - last < settings.CLIP_EMBED_INTERVAL:
                continue

            result = stream.get_latest_frame()
            if result is None:
                continue

            timestamp, frame = result

            try:
                # Embed frame
                vector = await clip_embedder.embed_frame(frame)
                ts_iso = datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()

                # Check for anomaly (compare with previous embedding)
                anomaly_score = 0.0
                is_anomaly = False
                prev = self._last_embedding.get(camera_id)
                if prev is not None:
                    anomaly_score = clip_embedder.compute_distance(prev, vector)
                    if anomaly_score > settings.CLIP_ANOMALY_THRESHOLD:
                        is_anomaly = True
                        self._anomalies_detected += 1
                        self._record_anomaly(camera_id, ts_iso, anomaly_score)
                        logger.info(
                            "Visual anomaly: camera=%s score=%.3f",
                            camera_id, anomaly_score,
                        )

                # Store embedding in Qdrant
                point_id = str(uuid.uuid4())
                await vector_store.upsert_frame_embedding(
                    point_id=point_id,
                    vector=vector,
                    camera_id=camera_id,
                    timestamp=ts_iso,
                    metadata={
                        "anomaly_score": round(anomaly_score, 4),
                        "is_anomaly": is_anomaly,
                    },
                )

                self._last_embed_time[camera_id] = now
                self._last_embedding[camera_id] = vector
                self._frames_embedded += 1

            except Exception as e:
                logger.warning("CLIP embed failed for camera %s: %s", camera_id, e)

    def _record_anomaly(self, camera_id: str, timestamp: str, score: float):
        """Record anomaly in ring buffer (max 100)."""
        self._anomaly_log.append({
            "camera_id": camera_id,
            "timestamp": timestamp,
            "anomaly_score": round(score, 4),
        })
        if len(self._anomaly_log) > 100:
            self._anomaly_log = self._anomaly_log[-100:]

        # Publish via Redis for WebSocket broadcast
        try:
            asyncio.create_task(self._publish_anomaly(camera_id, timestamp, score))
        except Exception:
            pass

    async def _publish_anomaly(self, camera_id: str, timestamp: str, score: float):
        """Publish anomaly to Redis pub/sub for WebSocket clients."""
        try:
            import json
            import redis.asyncio as aioredis
            r = aioredis.from_url(settings.REDIS_URL)
            await r.publish("ch:visual_anomalies", json.dumps({
                "camera_id": camera_id,
                "timestamp": timestamp,
                "anomaly_score": round(score, 4),
            }))
            await r.aclose()
        except Exception:
            pass

    async def _maybe_cleanup(self, vector_store):
        """Periodically delete old embeddings to prevent Qdrant growth."""
        now = time.time()
        if now - self._last_cleanup < 3600:  # check every hour
            return

        self._last_cleanup = now
        cutoff = datetime.now(timezone.utc) - timedelta(hours=settings.CLIP_RETENTION_HOURS)
        cutoff_iso = cutoff.isoformat()
        deleted = await vector_store.delete_old_embeddings(cutoff_iso)
        if deleted:
            logger.info("CLIP cleanup: deleted %d old embeddings (>%dh)", deleted, settings.CLIP_RETENTION_HOURS)

    def get_stats(self) -> Dict:
        """Pipeline stats."""
        return {
            "running": self._running,
            "frames_embedded": self._frames_embedded,
            "anomalies_detected": self._anomalies_detected,
            "cameras_tracking": len(self._last_embed_time),
            "embed_interval_s": settings.CLIP_EMBED_INTERVAL,
            "anomaly_threshold": settings.CLIP_ANOMALY_THRESHOLD,
            "retention_hours": settings.CLIP_RETENTION_HOURS,
        }

    def get_recent_anomalies(self, limit: int = 20) -> List[Dict]:
        """Return recent anomalies."""
        return list(reversed(self._anomaly_log[-limit:]))


# Singleton
clip_pipeline = CLIPPipeline()
