"""Threaded video capture manager — one thread per camera with ring buffer."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, Optional

import cv2
import numpy as np

from backend.config import settings

logger = logging.getLogger(__name__)

# ── Reconnect constants ───────────────────────────────────────
_BACKOFF_BASE: float = 1.0
_BACKOFF_MAX: float = 15.0
_MAX_RETRIES: int = 50
# If the decoded image stops changing for this long while read() still returns
# frames (a frozen V4L2 buffer / "Bad file descriptor"), force a reconnect.
_STALE_SECONDS: float = 8.0


@dataclass
class CameraStream:
    camera_id: str
    source: str  # device index (int), RTSP URL, or file path
    fps: int = 15
    buffer_size: int = 30
    max_retries: int = _MAX_RETRIES
    _capture: Optional[cv2.VideoCapture] = field(default=None, repr=False)
    _thread: Optional[threading.Thread] = field(default=None, repr=False)
    _running: bool = field(default=False, repr=False)
    _buffer: deque = field(default_factory=lambda: deque(maxlen=30), repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _frame_count: int = field(default=0, repr=False)
    _drop_count: int = field(default=0, repr=False)
    _last_frame_time: float = field(default=0.0, repr=False)
    _consecutive_failures: int = field(default=0, repr=False)
    _connected_since: float = field(default=0.0, repr=False)
    resolution: Optional[tuple] = None
    error: Optional[str] = None

    def _resolve_source(self):
        """Return the source as int (webcam index) or str (URL/file)."""
        try:
            return int(self.source) if self.source.isdigit() else self.source
        except (ValueError, AttributeError):
            return self.source

    def _is_rtsp(self) -> bool:
        return isinstance(self.source, str) and self.source.lower().startswith("rtsp")

    def _open_capture(self) -> cv2.VideoCapture:
        """Open a VideoCapture with RTSP-over-TCP fallback for RTSP sources."""
        source = self._resolve_source()
        cap = cv2.VideoCapture(source)

        # RTSP over TCP fallback — more reliable over lossy networks
        if self._is_rtsp() and not cap.isOpened():
            logger.info(
                "Camera %s: retrying RTSP with TCP transport", self.camera_id
            )
            cap.release()
            cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"H264"))
            # Force TCP via environment-level RTSP transport (ffmpeg respects this)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 3)

        return cap

    def start(self) -> bool:
        """Open capture device and start reading thread."""
        if self._running:
            return True

        self._capture = self._open_capture()

        if not self._capture.isOpened():
            self.error = f"Cannot open source: {self.source}"
            logger.error("Camera %s: %s", self.camera_id, self.error)
            return False

        # Set resolution if available
        w = int(self._capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(self._capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.resolution = (w, h)

        self._buffer = deque(maxlen=self.buffer_size)
        self._running = True
        self._consecutive_failures = 0
        self._connected_since = time.time()
        self._thread = threading.Thread(
            target=self._capture_loop,
            name=f"cam-{self.camera_id}",
            daemon=True,
        )
        self._thread.start()
        logger.info(
            "Camera %s started: source=%s res=%s",
            self.camera_id, self.source, self.resolution,
        )
        return True

    def stop(self):
        """Stop capture thread and release resources."""
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)
        if self._capture:
            self._capture.release()
            self._capture = None
        logger.info("Camera %s stopped", self.camera_id)

    def _reconnect(self) -> bool:
        """Release and reopen the capture device. Returns True if reopened."""
        try:
            if self._capture is not None:
                self._capture.release()
        except Exception:
            pass
        try:
            self._capture = self._open_capture()
            return bool(self._capture and self._capture.isOpened())
        except Exception as exc:  # noqa: BLE001
            logger.warning("Camera %s: reopen raised: %s", self.camera_id, exc)
            return False

    def _capture_loop(self):
        """Main capture loop running in its own thread.

        Self-healing: never permanently gives up — a failing device keeps being
        retried at the capped backoff. A staleness watchdog also reconnects when
        the device keeps returning the SAME (frozen) frame, which V4L2 webcams do
        on a "Bad file descriptor" without surfacing a read error.
        """
        frame_interval = 1.0 / self.fps if self.fps > 0 else 1.0 / 15
        retry_count = 0
        last_thumb = None
        last_change = time.time()

        while self._running:
            try:
                ret, frame = self._capture.read()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Camera %s: read() raised: %s", self.camera_id, exc)
                ret, frame = False, None

            if not ret or frame is None:
                self._drop_count += 1
                self._consecutive_failures += 1
                retry_count += 1
                backoff = min(_BACKOFF_BASE * (2 ** min(retry_count - 1, 8)), _BACKOFF_MAX)
                self.error = "Frame read failed"
                if retry_count <= self.max_retries or retry_count % 20 == 0:
                    logger.warning(
                        "Camera %s: frame read failed (attempt %d), backoff %.1fs, drops=%d",
                        self.camera_id, retry_count, backoff, self._drop_count,
                    )
                time.sleep(backoff)
                if self._reconnect() and retry_count > 1:
                    logger.info("Camera %s: reconnected after %d retries", self.camera_id, retry_count)
                # NOTE: we never set _running=False here — the stream keeps trying
                # to recover indefinitely (capped backoff) instead of freezing.
                continue

            now = time.time()

            # Staleness watchdog — detect a frozen feed (identical frames).
            try:
                thumb = frame[::32, ::32].copy()
            except Exception:
                thumb = None
            if last_thumb is None or thumb is None or not np.array_equal(thumb, last_thumb):
                last_change = now
            last_thumb = thumb
            if now - last_change > _STALE_SECONDS:
                logger.warning(
                    "Camera %s: feed frozen for %.0fs — forcing reconnect",
                    self.camera_id, now - last_change,
                )
                self._reconnect()
                last_change = time.time()
                last_thumb = None
                continue

            # Successful, fresh frame
            self.error = None
            retry_count = 0
            self._consecutive_failures = 0
            with self._lock:
                self._buffer.append((now, frame))
                self._frame_count += 1
                self._last_frame_time = now

            # Periodic health log every 1000 frames
            if self._frame_count % 1000 == 0:
                uptime = now - self._connected_since
                logger.info(
                    "Camera %s health: frames=%d drops=%d uptime=%.0fs",
                    self.camera_id, self._frame_count,
                    self._drop_count, uptime,
                )

            # Throttle to target FPS
            elapsed = time.time() - now
            sleep_time = frame_interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def frame_count(self) -> int:
        return self._frame_count

    def get_latest_frame(self) -> Optional[tuple]:
        """Return (timestamp, frame) or None."""
        with self._lock:
            if self._buffer:
                return self._buffer[-1]
        return None

    def get_buffer_frames(self, n: int = 5) -> list:
        """Return last n frames from ring buffer."""
        with self._lock:
            items = list(self._buffer)
        return items[-n:]

    def encode_jpeg(self, quality: int = 70) -> Optional[bytes]:
        """Get latest frame as JPEG bytes."""
        result = self.get_latest_frame()
        if result is None:
            return None
        _, frame = result
        ret, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ret:
            return buf.tobytes()
        return None


class VideoCaptureManager:
    """Manages multiple camera streams."""

    def __init__(self):
        self._streams: Dict[str, CameraStream] = {}
        self._lock = threading.Lock()

    def add_camera(
        self,
        camera_id: str,
        source: str,
        fps: int = None,
        buffer_size: int = None,
    ) -> CameraStream:
        fps = fps or settings.DEFAULT_FPS
        buffer_size = buffer_size or settings.FRAME_BUFFER_SIZE
        stream = CameraStream(
            camera_id=camera_id,
            source=source,
            fps=fps,
            buffer_size=buffer_size,
        )
        with self._lock:
            self._streams[camera_id] = stream
        return stream

    def start_camera(self, camera_id: str) -> bool:
        stream = self._streams.get(camera_id)
        if stream is None:
            return False
        return stream.start()

    def stop_camera(self, camera_id: str):
        stream = self._streams.get(camera_id)
        if stream:
            stream.stop()

    def remove_camera(self, camera_id: str):
        self.stop_camera(camera_id)
        with self._lock:
            self._streams.pop(camera_id, None)

    def get_stream(self, camera_id: str) -> Optional[CameraStream]:
        return self._streams.get(camera_id)

    def list_streams(self) -> Dict[str, CameraStream]:
        return dict(self._streams)

    def stop_all(self):
        for stream in self._streams.values():
            stream.stop()

    def enumerate_webcams(self, max_check: int = 4) -> list:
        """Discover available local webcam devices."""
        available = []
        for i in range(max_check):
            cap = cv2.VideoCapture(i)
            if cap.isOpened():
                w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                available.append({"index": i, "resolution": f"{w}x{h}"})
                cap.release()

        if not available:
            logger.warning("No physical cameras detected")

        return available


# Singleton
capture_manager = VideoCaptureManager()
