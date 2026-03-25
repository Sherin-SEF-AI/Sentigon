"""Video Management System API endpoints for SENTINEL AI."""

from __future__ import annotations

from typing import Dict, List, Optional, Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from backend.services.vms_service import (
    vms_service,
    ExportFormat,
    TranscodeProfile,
)

router = APIRouter(prefix="/api/vms", tags=["Video Management"])


# ── Request / Response schemas ────────────────────────────────


class StartStreamRequest(BaseModel):
    camera_id: int
    source_url: str
    profiles: List[str] = Field(
        default=["medium"],
        description="Transcode profiles: original, high, medium, low, mobile",
    )


class StartStreamResponse(BaseModel):
    session_id: str
    camera_id: int
    source_url: str
    is_active: bool
    profiles: List[str]
    hls_url: str | None = None


class ExportRequest(BaseModel):
    source_path: str
    format: str = Field(default="mp4", description="Export format: mp4, mkv, avi, webm")
    profile: str = Field(default="original", description="Transcode profile")
    camera_id: Optional[int] = None
    add_watermark: bool = False
    watermark_text: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ExportResponse(BaseModel):
    job_id: str
    camera_id: Optional[int]
    source_path: str
    output_path: str
    format: str
    profile: str
    status: str
    progress: float


class ExportJobDetail(BaseModel):
    job_id: str
    camera_id: Optional[int]
    source_path: str
    output_path: str
    format: str
    profile: str
    status: str
    progress: float
    started_at: Optional[float]
    completed_at: Optional[float]
    file_size: int
    error: Optional[str]
    metadata: Dict[str, Any]
    add_watermark: bool
    watermark_text: str


# ── Helpers ───────────────────────────────────────────────────


def _parse_profiles(names: List[str]) -> List[TranscodeProfile]:
    """Convert a list of profile name strings into TranscodeProfile enums."""
    profiles: List[TranscodeProfile] = []
    for name in names:
        try:
            profiles.append(TranscodeProfile(name.lower()))
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid transcode profile: {name}. "
                       f"Valid values: {[p.value for p in TranscodeProfile]}",
            )
    return profiles


def _parse_format(name: str) -> ExportFormat:
    """Convert a format name string into an ExportFormat enum."""
    try:
        return ExportFormat(name.lower())
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid export format: {name}. "
                   f"Valid values: {[f.value for f in ExportFormat]}",
        )


def _session_to_dict(session) -> dict:
    """Serialise a StreamSession dataclass into an API-friendly dict."""
    return {
        "session_id": session.session_id,
        "camera_id": session.camera_id,
        "source_url": session.source_url,
        "is_active": session.is_active,
        "viewers": session.viewers,
        "started_at": session.started_at,
        "profiles": [p.value for p in session.profiles],
        "hls_url": (
            f"/streams/{session.session_id}/stream.m3u8"
            if session.is_active
            else None
        ),
    }


def _job_to_detail(job) -> ExportJobDetail:
    """Serialise an ExportJob dataclass into an ExportJobDetail response."""
    return ExportJobDetail(
        job_id=job.job_id,
        camera_id=job.camera_id,
        source_path=job.source_path,
        output_path=job.output_path,
        format=job.format.value,
        profile=job.profile.value,
        status=job.status,
        progress=job.progress,
        started_at=job.started_at,
        completed_at=job.completed_at,
        file_size=job.file_size,
        error=job.error,
        metadata=job.metadata,
        add_watermark=job.add_watermark,
        watermark_text=job.watermark_text,
    )


# ── VMS Status ────────────────────────────────────────────────


@router.get("/status")
async def get_vms_status():
    """Return VMS status including active streams, pending exports, and GPU info."""
    return vms_service.get_status()


# ── Stream Endpoints ──────────────────────────────────────────


@router.post("/streams", response_model=StartStreamResponse, status_code=status.HTTP_201_CREATED)
async def start_stream(body: StartStreamRequest):
    """Start an HLS stream for a camera source."""
    profiles = _parse_profiles(body.profiles)
    session = await vms_service.start_hls_stream(
        camera_id=body.camera_id,
        source_url=body.source_url,
        profiles=profiles,
    )
    return StartStreamResponse(
        session_id=session.session_id,
        camera_id=session.camera_id,
        source_url=session.source_url,
        is_active=session.is_active,
        profiles=[p.value for p in session.profiles],
        hls_url=f"/streams/{session.session_id}/stream.m3u8" if session.is_active else None,
    )


@router.get("/streams")
async def list_streams():
    """List all active HLS streams."""
    return vms_service.list_streams()


@router.get("/streams/{session_id}")
async def get_stream(session_id: str):
    """Get details for a specific stream session."""
    session = vms_service.active_streams.get(session_id)
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Stream session '{session_id}' not found",
        )
    return _session_to_dict(session)


@router.delete("/streams/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def stop_stream(session_id: str):
    """Stop and clean up an active HLS stream."""
    session = vms_service.active_streams.get(session_id)
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Stream session '{session_id}' not found",
        )
    await vms_service.stop_stream(session_id)


# ── Export Endpoints ──────────────────────────────────────────


@router.post("/export", response_model=ExportResponse, status_code=status.HTTP_202_ACCEPTED)
async def start_export(body: ExportRequest):
    """Start a video export job with optional transcoding and watermark."""
    fmt = _parse_format(body.format)
    profile = _parse_profiles([body.profile])[0]

    kwargs: Dict[str, Any] = {}
    if body.watermark_text is not None:
        kwargs["watermark_text"] = body.watermark_text

    job = await vms_service.export_video(
        source_path=body.source_path,
        format=fmt,
        profile=profile,
        camera_id=body.camera_id,
        add_watermark=body.add_watermark,
        metadata=body.metadata,
        **kwargs,
    )
    return ExportResponse(
        job_id=job.job_id,
        camera_id=job.camera_id,
        source_path=job.source_path,
        output_path=job.output_path,
        format=job.format.value,
        profile=job.profile.value,
        status=job.status,
        progress=job.progress,
    )


@router.get("/export/{job_id}", response_model=ExportJobDetail)
async def get_export_job(job_id: str):
    """Get the status and details of a specific export job."""
    job = vms_service.export_jobs.get(job_id)
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Export job '{job_id}' not found",
        )
    return _job_to_detail(job)


@router.get("/exports", response_model=List[ExportJobDetail])
async def list_export_jobs():
    """List all export jobs and their current status."""
    return [_job_to_detail(job) for job in vms_service.export_jobs.values()]
