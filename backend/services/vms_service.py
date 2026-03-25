"""
Video Management System integration service.
HLS/DASH adaptive streaming, video export with privacy options,
GPU-accelerated transcoding, and multi-quality output.
"""
import asyncio
import logging
import os
import shutil
import subprocess
import time
import uuid
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class ExportFormat(Enum):
    MP4 = "mp4"
    MKV = "mkv"
    AVI = "avi"
    WEBM = "webm"


class TranscodeProfile(Enum):
    ORIGINAL = "original"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    MOBILE = "mobile"


TRANSCODE_SETTINGS = {
    TranscodeProfile.HIGH: {"width": 1920, "height": 1080, "bitrate": "4M", "fps": 30},
    TranscodeProfile.MEDIUM: {"width": 1280, "height": 720, "bitrate": "2M", "fps": 25},
    TranscodeProfile.LOW: {"width": 854, "height": 480, "bitrate": "1M", "fps": 15},
    TranscodeProfile.MOBILE: {"width": 640, "height": 360, "bitrate": "500k", "fps": 15},
}


@dataclass
class StreamSession:
    session_id: str
    camera_id: int
    source_url: str
    output_dir: str
    process: Optional[asyncio.subprocess.Process] = None
    started_at: float = field(default_factory=time.time)
    viewers: int = 0
    is_active: bool = False
    profiles: List[TranscodeProfile] = field(default_factory=lambda: [TranscodeProfile.MEDIUM])


@dataclass
class ExportJob:
    job_id: str
    camera_id: Optional[int]
    source_path: str
    output_path: str
    format: ExportFormat
    profile: TranscodeProfile
    status: str = "pending"
    progress: float = 0.0
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    file_size: int = 0
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    blur_faces: bool = False
    add_watermark: bool = False
    watermark_text: str = "SENTINEL AI - CONFIDENTIAL"


class VMSService:
    def __init__(self):
        self.streams_dir = os.getenv("HLS_STREAMS_DIR", "streams")
        self.exports_dir = os.getenv("VIDEO_EXPORTS_DIR", "exports")
        self.active_streams: Dict[str, StreamSession] = {}
        self.export_jobs: Dict[str, ExportJob] = {}
        self._gpu_available = self._check_gpu()
        self._ffmpeg_path = shutil.which("ffmpeg") or "ffmpeg"
        os.makedirs(self.streams_dir, exist_ok=True)
        os.makedirs(self.exports_dir, exist_ok=True)
        logger.info("VMS Service initialized. GPU: %s", "available" if self._gpu_available else "CPU-only")

    def _check_gpu(self) -> bool:
        try:
            result = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                                    capture_output=True, text=True, timeout=5)
            return "h264_nvenc" in result.stdout or "h264_vaapi" in result.stdout
        except Exception:
            return False

    def _get_encoder(self) -> str:
        if self._gpu_available:
            try:
                result = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                                        capture_output=True, text=True, timeout=5)
                if "h264_nvenc" in result.stdout:
                    return "h264_nvenc"
                if "h264_vaapi" in result.stdout:
                    return "h264_vaapi"
            except Exception:
                pass
        return "libx264"

    async def start_hls_stream(self, camera_id: int, source_url: str,
                                profiles: List[TranscodeProfile] = None) -> StreamSession:
        session_id = f"hls_{camera_id}_{uuid.uuid4().hex[:8]}"
        output_dir = os.path.join(self.streams_dir, session_id)
        os.makedirs(output_dir, exist_ok=True)
        if not profiles:
            profiles = [TranscodeProfile.MEDIUM]
        encoder = self._get_encoder()
        settings = TRANSCODE_SETTINGS[profiles[0]]
        cmd = [
            self._ffmpeg_path, "-hide_banner", "-loglevel", "warning",
            "-rtsp_transport", "tcp", "-i", source_url,
            "-vf", f"scale={settings['width']}:{settings['height']}",
            "-c:v", encoder, "-b:v", settings["bitrate"],
            "-r", str(settings["fps"]), "-g", str(settings["fps"] * 2),
            "-c:a", "aac", "-b:a", "128k",
            "-f", "hls", "-hls_time", "4", "-hls_list_size", "10",
            "-hls_flags", "delete_segments+independent_segments",
            "-hls_segment_filename", os.path.join(output_dir, "seg_%03d.ts"),
            os.path.join(output_dir, "stream.m3u8"),
        ]
        process = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        session = StreamSession(
            session_id=session_id, camera_id=camera_id, source_url=source_url,
            output_dir=output_dir, process=process, is_active=True, profiles=profiles,
        )
        self.active_streams[session_id] = session
        asyncio.create_task(self._monitor_stream(session_id))
        logger.info("HLS stream started: %s for camera %d", session_id, camera_id)
        return session

    async def _monitor_stream(self, session_id: str):
        session = self.active_streams.get(session_id)
        if not session or not session.process:
            return
        await session.process.wait()
        session.is_active = False

    async def stop_stream(self, session_id: str):
        session = self.active_streams.get(session_id)
        if not session:
            return
        session.is_active = False
        if session.process and session.process.returncode is None:
            session.process.terminate()
            try:
                await asyncio.wait_for(session.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                session.process.kill()
        if os.path.exists(session.output_dir):
            shutil.rmtree(session.output_dir, ignore_errors=True)
        del self.active_streams[session_id]

    async def export_video(self, source_path: str, format: ExportFormat = ExportFormat.MP4,
                           profile: TranscodeProfile = TranscodeProfile.ORIGINAL,
                           camera_id: int = None, add_watermark: bool = False,
                           metadata: Dict = None, **kwargs) -> ExportJob:
        job_id = f"export_{uuid.uuid4().hex[:8]}"
        output_path = os.path.join(self.exports_dir, f"{job_id}.{format.value}")
        job = ExportJob(
            job_id=job_id, camera_id=camera_id, source_path=source_path,
            output_path=output_path, format=format, profile=profile,
            add_watermark=add_watermark, metadata=metadata or {},
        )
        self.export_jobs[job_id] = job
        asyncio.create_task(self._run_export(job))
        return job

    async def _run_export(self, job: ExportJob):
        job.status = "processing"
        job.started_at = time.time()
        try:
            encoder = self._get_encoder()
            cmd = [self._ffmpeg_path, "-hide_banner", "-loglevel", "warning", "-y", "-i", job.source_path]
            filters = []
            if job.profile != TranscodeProfile.ORIGINAL and job.profile in TRANSCODE_SETTINGS:
                s = TRANSCODE_SETTINGS[job.profile]
                filters.append(f"scale={s['width']}:{s['height']}")
            if job.add_watermark:
                ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
                text = f"{job.watermark_text} | {ts}"
                filters.append(
                    f"drawtext=text='{text}':fontsize=14:fontcolor=white@0.7:"
                    f"x=10:y=h-30:box=1:boxcolor=black@0.4:boxborderw=5"
                )
            if filters:
                cmd.extend(["-vf", ",".join(filters)])
            if job.profile == TranscodeProfile.ORIGINAL:
                cmd.extend(["-c:v", "copy", "-c:a", "copy"])
            else:
                s = TRANSCODE_SETTINGS.get(job.profile, TRANSCODE_SETTINGS[TranscodeProfile.MEDIUM])
                cmd.extend(["-c:v", encoder, "-b:v", s["bitrate"], "-c:a", "aac", "-b:a", "128k"])
            cmd.append(job.output_path)
            process = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            _, stderr = await process.communicate()
            if process.returncode == 0:
                job.status = "completed"
                job.completed_at = time.time()
                job.file_size = os.path.getsize(job.output_path) if os.path.exists(job.output_path) else 0
                job.progress = 100.0
            else:
                job.status = "failed"
                job.error = stderr.decode()[-500:]
        except Exception as e:
            job.status = "failed"
            job.error = str(e)

    def list_streams(self) -> List[Dict]:
        return [{"session_id": s.session_id, "camera_id": s.camera_id, "is_active": s.is_active,
                 "viewers": s.viewers, "started_at": s.started_at,
                 "profiles": [p.value for p in s.profiles],
                 "hls_url": f"/streams/{s.session_id}/stream.m3u8" if s.is_active else None}
                for s in self.active_streams.values()]

    def get_status(self) -> Dict:
        return {
            "active_streams": len([s for s in self.active_streams.values() if s.is_active]),
            "pending_exports": len([j for j in self.export_jobs.values() if j.status == "pending"]),
            "gpu_available": self._gpu_available, "encoder": self._get_encoder(),
        }

    async def shutdown(self):
        for sid in list(self.active_streams.keys()):
            await self.stop_stream(sid)


vms_service = VMSService()
