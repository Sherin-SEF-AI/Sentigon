"""Automatic chunk-based video recording for all active cameras.

Starts on app startup. Records every camera in 5-minute MP4 chunks,
persists each chunk as a Recording row, and cleans up old files.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import time
import threading
import uuid
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional

import cv2

from backend.config import settings

logger = logging.getLogger(__name__)


class _ChunkState:
    """Tracks one active recording chunk for a camera."""

    __slots__ = (
        "camera_id", "output_path", "writer", "fps",
        "resolution", "start_time", "frame_count", "running",
    )

    def __init__(self, camera_id: str, output_path: str, fps: int, resolution: tuple):
        self.camera_id = camera_id
        self.output_path = output_path
        self.fps = fps
        self.resolution = resolution
        self.start_time = datetime.now(timezone.utc)
        self.frame_count = 0
        self.running = True
        self.writer: Optional[cv2.VideoWriter] = None


class AutoRecorder:
    """Background service that auto-records all cameras in fixed-length chunks."""

    def __init__(self):
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._chunks: Dict[str, _ChunkState] = {}
        self._chunk_threads: Dict[str, threading.Thread] = {}
        self._total_chunks_saved = 0

    async def start(self):
        """Start the auto-recording loop."""
        if not settings.AUTO_RECORD_ENABLED:
            logger.info("Auto-recording disabled (AUTO_RECORD_ENABLED=false)")
            return

        if self._running:
            return

        os.makedirs(settings.AUTO_RECORD_DIR, exist_ok=True)
        self._running = True
        self._task = asyncio.create_task(self._main_loop())
        logger.info(
            "Auto-recorder started: chunk=%dm dir=%s retention=%dh",
            settings.AUTO_RECORD_CHUNK_MINUTES,
            settings.AUTO_RECORD_DIR,
            settings.AUTO_RECORD_RETENTION_HOURS,
        )

    async def stop(self):
        """Stop all recordings gracefully."""
        self._running = False
        # Signal all chunk threads to stop
        for state in self._chunks.values():
            state.running = False
        # Wait for threads
        for t in self._chunk_threads.values():
            if t.is_alive():
                t.join(timeout=3.0)
        self._chunks.clear()
        self._chunk_threads.clear()
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Auto-recorder stopped, %d total chunks saved", self._total_chunks_saved)

    async def _main_loop(self):
        """Main loop: start chunks, rotate on interval, cleanup old files."""
        # Wait for cameras to initialize
        await asyncio.sleep(8)

        chunk_seconds = settings.AUTO_RECORD_CHUNK_MINUTES * 60

        while self._running:
            try:
                from backend.services.video_capture import capture_manager
                streams = capture_manager.list_streams()

                for camera_id, stream in streams.items():
                    if not stream.is_running:
                        continue

                    chunk = self._chunks.get(camera_id)

                    if chunk is None or not chunk.running:
                        # Start a new chunk for this camera
                        self._start_chunk(camera_id, stream)
                    else:
                        # Check if chunk exceeded duration
                        elapsed = (datetime.now(timezone.utc) - chunk.start_time).total_seconds()
                        if elapsed >= chunk_seconds:
                            # Rotate: stop current, save, start new
                            await self._rotate_chunk(camera_id, stream)

                # Periodic cleanup of old recordings
                await self._maybe_cleanup()

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Auto-recorder loop error: %s", e)

            await asyncio.sleep(2)

    def _start_chunk(self, camera_id: str, stream) -> None:
        """Start recording a new chunk for a camera."""
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        safe_id = camera_id[:12]
        filename = f"{safe_id}_{ts}.mp4"
        output_path = os.path.join(settings.AUTO_RECORD_DIR, filename)

        fps = stream.fps or settings.DEFAULT_FPS
        resolution = stream.resolution or (640, 480)

        state = _ChunkState(
            camera_id=camera_id,
            output_path=output_path,
            fps=fps,
            resolution=resolution,
        )

        # Stop old thread if still around
        old_thread = self._chunk_threads.get(camera_id)
        if old_thread and old_thread.is_alive():
            old_state = self._chunks.get(camera_id)
            if old_state:
                old_state.running = False
            old_thread.join(timeout=2.0)

        self._chunks[camera_id] = state

        thread = threading.Thread(
            target=self._record_thread,
            args=(state, stream),
            name=f"autorec-{safe_id}",
            daemon=True,
        )
        self._chunk_threads[camera_id] = thread
        thread.start()

    def _record_thread(self, state: _ChunkState, stream) -> None:
        """Background thread that writes frames to an MP4 chunk."""
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(state.output_path, fourcc, state.fps, state.resolution)

        if not writer.isOpened():
            logger.error("AutoRec: failed to open writer for %s", state.camera_id)
            state.running = False
            return

        state.writer = writer
        frame_interval = 1.0 / state.fps

        try:
            while state.running:
                result = stream.get_latest_frame()
                if result is not None:
                    _, frame = result
                    h, w = frame.shape[:2]
                    if (w, h) != state.resolution:
                        frame = cv2.resize(frame, state.resolution)
                    writer.write(frame)
                    state.frame_count += 1
                time.sleep(frame_interval)
        except Exception as e:
            logger.error("AutoRec thread error for %s: %s", state.camera_id, e)
        finally:
            writer.release()
            state.running = False

    async def _rotate_chunk(self, camera_id: str, stream) -> None:
        """Stop the current chunk, save to DB, start a new one."""
        old_state = self._chunks.get(camera_id)
        if old_state:
            old_state.running = False

        old_thread = self._chunk_threads.get(camera_id)
        if old_thread and old_thread.is_alive():
            await asyncio.to_thread(old_thread.join, 3.0)

        # Persist the completed chunk
        if old_state and old_state.frame_count > 0:
            await self._save_chunk(old_state)

        # Start fresh chunk
        self._start_chunk(camera_id, stream)

    @staticmethod
    def _reencode_to_h264(file_path: str) -> bool:
        """Re-encode mp4v chunk to H.264 for browser playback compatibility."""
        if not shutil.which("ffmpeg"):
            return False
        tmp = file_path + ".h264.mp4"
        try:
            result = subprocess.run(
                [
                    "ffmpeg", "-y", "-i", file_path,
                    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                    "-movflags", "+faststart",
                    "-an", tmp,
                ],
                capture_output=True, timeout=120,
            )
            if result.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 0:
                os.replace(tmp, file_path)
                return True
            logger.warning("AutoRec: ffmpeg returned %d for %s", result.returncode, file_path)
        except subprocess.TimeoutExpired:
            logger.warning("AutoRec: ffmpeg timed out for %s", file_path)
        except Exception as e:
            logger.warning("AutoRec: re-encode error for %s: %s", file_path, e)
        # Clean up temp file on failure
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False

    async def _save_chunk(self, state: _ChunkState) -> None:
        """Persist a completed chunk as a Recording row."""
        try:
            from sqlalchemy import select
            from backend.database import async_session
            from backend.models import Recording, Camera
            from backend.models.models import RecordingType

            # Re-encode to H.264 for browser compatibility (in thread to avoid blocking)
            codec = "mp4v"
            if os.path.exists(state.output_path) and os.path.getsize(state.output_path) > 100:
                ok = await asyncio.to_thread(self._reencode_to_h264, state.output_path)
                if ok:
                    codec = "h264"

            file_size = None
            if os.path.exists(state.output_path):
                file_size = os.path.getsize(state.output_path)

            end_time = datetime.now(timezone.utc)
            duration = (end_time - state.start_time).total_seconds()

            async with async_session() as session:
                # Verify camera exists in DB (capture_manager IDs must match)
                cam = (await session.execute(
                    select(Camera).where(Camera.id == uuid.UUID(state.camera_id))
                )).scalar_one_or_none()
                if cam is None:
                    logger.debug("AutoRec: camera %s not in DB, skipping chunk save", state.camera_id[:8])
                    return

                rec = Recording(
                    camera_id=uuid.UUID(state.camera_id),
                    recording_type=RecordingType.CONTINUOUS,
                    file_path=os.path.abspath(state.output_path),
                    file_size=file_size,
                    duration_seconds=round(duration, 1),
                    start_time=state.start_time,
                    end_time=end_time,
                    metadata_={"codec": codec, "auto": True, "frames": state.frame_count},
                )
                session.add(rec)
                await session.commit()

            self._total_chunks_saved += 1
            logger.info(
                "AutoRec chunk saved: camera=%s frames=%d duration=%.0fs size=%s codec=%s",
                state.camera_id[:8], state.frame_count, duration,
                f"{file_size // 1024}KB" if file_size else "?", codec,
            )
        except Exception as e:
            logger.error("AutoRec: failed to save chunk for %s: %s", state.camera_id, e)

    async def _maybe_cleanup(self) -> None:
        """Delete recordings older than retention period."""
        if not hasattr(self, "_last_cleanup"):
            self._last_cleanup = 0.0

        now = time.time()
        if now - self._last_cleanup < 3600:  # check every hour
            return
        self._last_cleanup = now

        try:
            from backend.database import async_session
            from backend.models import Recording
            from sqlalchemy import select, delete as sa_delete

            cutoff = datetime.now(timezone.utc) - timedelta(hours=settings.AUTO_RECORD_RETENTION_HOURS)

            async with async_session() as session:
                # Find old auto-recordings
                q = select(Recording).where(
                    Recording.start_time < cutoff,
                    Recording.metadata_["auto"].as_boolean() == True,  # noqa: E712
                )
                old_recs = (await session.execute(q)).scalars().all()

                deleted_count = 0
                for rec in old_recs:
                    # Delete file from disk
                    if rec.file_path and os.path.exists(rec.file_path):
                        try:
                            os.remove(rec.file_path)
                        except OSError:
                            pass
                    await session.delete(rec)
                    deleted_count += 1

                if deleted_count:
                    await session.commit()
                    logger.info(
                        "AutoRec cleanup: removed %d recordings older than %dh",
                        deleted_count, settings.AUTO_RECORD_RETENTION_HOURS,
                    )
        except Exception as e:
            logger.error("AutoRec cleanup error: %s", e)

    def get_stats(self) -> Dict:
        """Return auto-recorder stats."""
        active = {
            cid: {
                "frames": s.frame_count,
                "started": s.start_time.isoformat(),
                "elapsed_s": round((datetime.now(timezone.utc) - s.start_time).total_seconds()),
            }
            for cid, s in self._chunks.items()
            if s.running
        }
        return {
            "running": self._running,
            "active_cameras": len(active),
            "total_chunks_saved": self._total_chunks_saved,
            "chunk_minutes": settings.AUTO_RECORD_CHUNK_MINUTES,
            "retention_hours": settings.AUTO_RECORD_RETENTION_HOURS,
            "active_recordings": active,
        }


# Singleton
auto_recorder = AutoRecorder()
