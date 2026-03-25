"""Continuous and event-triggered video recording with OpenCV VideoWriter."""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from backend.config import settings
from backend.database import async_session
from backend.models import Recording
from backend.models.models import RecordingType

logger = logging.getLogger(__name__)


@dataclass
class _RecordingState:
    """Internal bookkeeping for an active recording session."""

    camera_id: str
    output_path: str
    recording_type: RecordingType
    writer: Optional[cv2.VideoWriter] = field(default=None, repr=False)
    thread: Optional[threading.Thread] = field(default=None, repr=False)
    running: bool = False
    start_time: Optional[datetime] = None
    frame_count: int = 0
    fps: int = 15
    resolution: Optional[tuple] = None
    event_id: Optional[str] = None
    error: Optional[str] = None


class VideoRecorder:
    """Manages recording state per camera — continuous and event-triggered.

    * **Continuous** recording writes frames pulled from the capture
      manager's ring buffer in a background thread until stopped.
    * **Event clips** record a fixed window around a detected event
      (pre-seconds buffered, post-seconds recorded live).

    Every completed recording is persisted as a ``Recording`` row in the
    database.
    """

    CODEC = "mp4v"  # OpenCV FourCC codec

    def __init__(self) -> None:
        self._recordings: Dict[str, _RecordingState] = {}
        self._lock = threading.Lock()

    # ── Continuous recording ─────────────────────────────────

    def start_continuous(
        self,
        camera_id: str,
        output_dir: str,
        fps: int = 15,
        resolution: Optional[tuple] = None,
    ) -> Dict[str, Any]:
        """Begin continuous recording for *camera_id*.

        Frames are pulled from the capture manager's ring buffer in a
        background thread and written via ``cv2.VideoWriter``.

        Returns a status dict.
        """
        with self._lock:
            if camera_id in self._recordings and self._recordings[camera_id].running:
                return {
                    "camera_id": camera_id,
                    "status": "already_recording",
                    "output_path": self._recordings[camera_id].output_path,
                }

        # Ensure output directory exists
        os.makedirs(output_dir, exist_ok=True)

        timestamp_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        filename = f"{camera_id}_{timestamp_str}_continuous.mp4"
        output_path = os.path.join(output_dir, filename)

        state = _RecordingState(
            camera_id=camera_id,
            output_path=output_path,
            recording_type=RecordingType.CONTINUOUS,
            fps=fps,
            resolution=resolution,
            start_time=datetime.now(timezone.utc),
        )

        thread = threading.Thread(
            target=self._continuous_loop,
            args=(state,),
            name=f"rec-cont-{camera_id}",
            daemon=True,
        )
        state.thread = thread
        state.running = True

        with self._lock:
            self._recordings[camera_id] = state

        thread.start()
        logger.info("Continuous recording started: camera=%s path=%s", camera_id, output_path)

        return {
            "camera_id": camera_id,
            "status": "recording",
            "output_path": output_path,
            "recording_type": "continuous",
        }

    def _continuous_loop(self, state: _RecordingState) -> None:
        """Background thread that pulls frames and writes to disk."""
        from backend.services.video_capture import capture_manager

        stream = capture_manager.get_stream(state.camera_id)
        if stream is None:
            state.error = "Camera stream not found"
            state.running = False
            logger.error("Recording thread: stream not found for %s", state.camera_id)
            return

        # Resolve resolution
        res = state.resolution or stream.resolution or (640, 480)
        state.resolution = res

        fourcc = cv2.VideoWriter_fourcc(*self.CODEC)
        writer = cv2.VideoWriter(state.output_path, fourcc, state.fps, res)

        if not writer.isOpened():
            state.error = "Failed to open VideoWriter"
            state.running = False
            logger.error("VideoWriter open failed: %s", state.output_path)
            return

        state.writer = writer
        frame_interval = 1.0 / state.fps

        try:
            while state.running:
                result = stream.get_latest_frame()
                if result is not None:
                    _, frame = result
                    # Resize if necessary
                    h, w = frame.shape[:2]
                    if (w, h) != res:
                        frame = cv2.resize(frame, res)
                    writer.write(frame)
                    state.frame_count += 1

                time.sleep(frame_interval)
        except Exception as exc:
            state.error = str(exc)
            logger.error("Continuous recording error for %s: %s", state.camera_id, exc)
        finally:
            writer.release()
            state.running = False
            logger.info(
                "Continuous recording stopped: camera=%s frames=%d",
                state.camera_id,
                state.frame_count,
            )

    # ── Stop recording ───────────────────────────────────────

    async def stop_recording(self, camera_id: str) -> Dict[str, Any]:
        """Stop an active recording and persist the Recording row."""
        with self._lock:
            state = self._recordings.pop(camera_id, None)

        if state is None:
            return {"camera_id": camera_id, "status": "not_recording"}

        state.running = False
        if state.thread and state.thread.is_alive():
            state.thread.join(timeout=5.0)

        end_time = datetime.now(timezone.utc)
        duration = (
            (end_time - state.start_time).total_seconds()
            if state.start_time
            else 0.0
        )

        # File size
        file_size: Optional[int] = None
        if os.path.exists(state.output_path):
            file_size = os.path.getsize(state.output_path)

        # Persist to database
        recording_data = await self._save_recording(
            camera_id=camera_id,
            recording_type=state.recording_type,
            file_path=state.output_path,
            file_size=file_size,
            duration=duration,
            start_time=state.start_time or end_time,
            end_time=end_time,
            event_id=state.event_id,
        )

        logger.info(
            "Recording saved: camera=%s duration=%.1fs frames=%d size=%s",
            camera_id,
            duration,
            state.frame_count,
            file_size,
        )

        return {
            "camera_id": camera_id,
            "status": "stopped",
            "output_path": state.output_path,
            "duration_seconds": round(duration, 1),
            "frame_count": state.frame_count,
            "file_size": file_size,
            "recording_id": recording_data.get("id") if recording_data else None,
        }

    # ── Event-triggered clip ─────────────────────────────────

    async def record_event_clip(
        self,
        camera_id: str,
        pre_seconds: float = 5.0,
        post_seconds: float = 10.0,
        event_id: Optional[str] = None,
        output_dir: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Record an event clip: *pre_seconds* from the ring buffer plus
        *post_seconds* of live capture.

        The clip is written synchronously in a background thread.
        Returns immediately with clip metadata.
        """
        from backend.services.video_capture import capture_manager

        stream = capture_manager.get_stream(camera_id)
        if stream is None:
            return {"camera_id": camera_id, "error": "stream_not_found"}

        out_dir = output_dir or os.path.join("recordings", "events")
        os.makedirs(out_dir, exist_ok=True)

        timestamp_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        eid = event_id or str(uuid.uuid4())[:8]
        filename = f"{camera_id}_{timestamp_str}_event_{eid}.mp4"
        output_path = os.path.join(out_dir, filename)

        # Collect pre-event frames from the ring buffer
        buffer_frames = stream.get_buffer_frames(
            n=int(pre_seconds * (stream.fps or settings.DEFAULT_FPS))
        )

        state = _RecordingState(
            camera_id=camera_id,
            output_path=output_path,
            recording_type=RecordingType.EVENT_TRIGGERED,
            fps=stream.fps or settings.DEFAULT_FPS,
            resolution=stream.resolution or (640, 480),
            start_time=datetime.now(timezone.utc),
            event_id=event_id,
        )

        thread = threading.Thread(
            target=self._event_clip_worker,
            args=(state, stream, buffer_frames, post_seconds),
            name=f"rec-event-{camera_id}-{eid}",
            daemon=True,
        )
        thread.start()

        logger.info(
            "Event clip recording started: camera=%s event=%s pre=%.1fs post=%.1fs",
            camera_id,
            event_id,
            pre_seconds,
            post_seconds,
        )

        return {
            "camera_id": camera_id,
            "status": "recording_clip",
            "output_path": output_path,
            "event_id": event_id,
            "pre_seconds": pre_seconds,
            "post_seconds": post_seconds,
            "pre_frames_buffered": len(buffer_frames),
        }

    def _event_clip_worker(
        self,
        state: _RecordingState,
        stream: Any,
        pre_frames: list,
        post_seconds: float,
    ) -> None:
        """Write pre-buffered frames and then capture live for *post_seconds*."""
        res = state.resolution or (640, 480)
        fourcc = cv2.VideoWriter_fourcc(*self.CODEC)
        writer = cv2.VideoWriter(state.output_path, fourcc, state.fps, res)

        if not writer.isOpened():
            state.error = "Failed to open VideoWriter for event clip"
            logger.error("Event clip writer failed: %s", state.output_path)
            return

        try:
            # Write pre-event frames
            for _, frame in pre_frames:
                h, w = frame.shape[:2]
                if (w, h) != res:
                    frame = cv2.resize(frame, res)
                writer.write(frame)
                state.frame_count += 1

            # Record live post-event frames
            frame_interval = 1.0 / state.fps
            end_time = time.time() + post_seconds

            while time.time() < end_time:
                result = stream.get_latest_frame()
                if result is not None:
                    _, frame = result
                    h, w = frame.shape[:2]
                    if (w, h) != res:
                        frame = cv2.resize(frame, res)
                    writer.write(frame)
                    state.frame_count += 1
                time.sleep(frame_interval)

        except Exception as exc:
            state.error = str(exc)
            logger.error("Event clip recording error: %s", exc)
        finally:
            writer.release()
            state.running = False

            # Persist asynchronously
            import asyncio

            duration = (
                (datetime.now(timezone.utc) - state.start_time).total_seconds()
                if state.start_time
                else post_seconds
            )
            file_size = (
                os.path.getsize(state.output_path)
                if os.path.exists(state.output_path)
                else None
            )

            try:
                loop = asyncio.new_event_loop()
                loop.run_until_complete(
                    self._save_recording(
                        camera_id=state.camera_id,
                        recording_type=state.recording_type,
                        file_path=state.output_path,
                        file_size=file_size,
                        duration=duration,
                        start_time=state.start_time or datetime.now(timezone.utc),
                        end_time=datetime.now(timezone.utc),
                        event_id=state.event_id,
                    )
                )
                loop.close()
            except Exception as exc:
                logger.error("Failed to persist event clip recording: %s", exc)

            logger.info(
                "Event clip complete: camera=%s frames=%d path=%s",
                state.camera_id,
                state.frame_count,
                state.output_path,
            )

    # ── Database persistence ─────────────────────────────────

    async def _save_recording(
        self,
        camera_id: str,
        recording_type: RecordingType,
        file_path: str,
        file_size: Optional[int],
        duration: float,
        start_time: datetime,
        end_time: datetime,
        event_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Persist a ``Recording`` row."""
        try:
            async with async_session() as session:
                recording = Recording(
                    camera_id=uuid.UUID(camera_id),
                    recording_type=recording_type,
                    file_path=file_path,
                    file_size=file_size,
                    duration_seconds=round(duration, 1),
                    start_time=start_time,
                    end_time=end_time,
                    event_id=uuid.UUID(event_id) if event_id else None,
                    metadata_={
                        "codec": self.CODEC,
                    },
                )
                session.add(recording)
                await session.commit()
                await session.refresh(recording)

                return {
                    "id": str(recording.id),
                    "camera_id": camera_id,
                    "file_path": file_path,
                    "duration_seconds": round(duration, 1),
                }
        except Exception as exc:
            logger.error("Failed to save recording to DB: %s", exc)
            return None

    # ── Query helpers ────────────────────────────────────────

    def is_recording(self, camera_id: str) -> bool:
        """Check whether a camera is currently being recorded."""
        state = self._recordings.get(camera_id)
        return state is not None and state.running

    def active_recordings(self) -> List[Dict[str, Any]]:
        """Return metadata for all active recordings."""
        return [
            {
                "camera_id": s.camera_id,
                "output_path": s.output_path,
                "recording_type": s.recording_type.value,
                "start_time": s.start_time.isoformat() if s.start_time else None,
                "frame_count": s.frame_count,
                "error": s.error,
            }
            for s in self._recordings.values()
            if s.running
        ]

    async def stop_all(self) -> List[Dict[str, Any]]:
        """Stop every active recording and return results."""
        camera_ids = list(self._recordings.keys())
        results = []
        for cid in camera_ids:
            result = await self.stop_recording(cid)
            results.append(result)
        return results


# Singleton
video_recorder = VideoRecorder()
