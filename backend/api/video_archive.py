"""Video Records Archive API — browse, stream, bookmark, and analyze recordings."""

from __future__ import annotations

import hashlib
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse, FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func as sa_func, select, and_, desc, asc
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.api.auth import get_current_user, require_role
from backend.database import get_db
from backend.models import Camera, Recording, VideoBookmark, CaseEvidence, EvidenceHash
from backend.models.models import RecordingType, UserRole

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/video-archive", tags=["video-archive"])


# ── Pydantic schemas ──────────────────────────────────────────

class RecordingOut(BaseModel):
    id: str
    camera_id: str
    camera_name: Optional[str] = None
    recording_type: str
    file_path: str
    file_size: Optional[int] = None
    duration_seconds: Optional[float] = None
    start_time: str
    end_time: Optional[str] = None
    event_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    bookmark_count: int = 0


class RecordingListOut(BaseModel):
    recordings: List[RecordingOut]
    total: int
    page: int
    page_size: int
    total_pages: int


class BookmarkCreate(BaseModel):
    recording_id: uuid.UUID
    timestamp_offset: float = Field(..., ge=0, description="Seconds from recording start")
    label: str = Field(..., min_length=1, max_length=255)
    notes: Optional[str] = None
    bookmark_type: str = Field("marker", pattern=r"^(marker|annotation|evidence_flag)$")
    severity: Optional[str] = None


class BookmarkOut(BaseModel):
    id: str
    recording_id: str
    user_id: str
    timestamp_offset: float
    label: str
    notes: Optional[str] = None
    bookmark_type: str
    severity: Optional[str] = None
    frame_snapshot_path: Optional[str] = None
    ai_analysis: Optional[Dict[str, Any]] = None
    created_at: str


class ForensicAnalyzeRequest(BaseModel):
    recording_id: uuid.UUID
    timestamp_offset: float = Field(..., ge=0)
    query: str = "Perform comprehensive forensic analysis of this frame"


class EvidenceExportRequest(BaseModel):
    recording_id: uuid.UUID
    case_id: Optional[uuid.UUID] = None
    include_bookmarks: bool = True
    include_ai_analysis: bool = True


# ── Helpers ───────────────────────────────────────────────────

def _extract_frame_at_offset(file_path: str, offset_seconds: float) -> Optional[np.ndarray]:
    """Extract a single BGR frame from an MP4 at the given offset."""
    cap = cv2.VideoCapture(file_path)
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 15
    frame_number = int(offset_seconds * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number)
    ret, frame = cap.read()
    cap.release()
    return frame if ret else None


def _recording_to_dict(rec: Recording, camera_name: Optional[str] = None, bm_count: int = 0) -> Dict[str, Any]:
    return {
        "id": str(rec.id),
        "camera_id": str(rec.camera_id),
        "camera_name": camera_name or "",
        "recording_type": rec.recording_type.value if rec.recording_type else "unknown",
        "file_path": rec.file_path,
        "file_size": rec.file_size,
        "duration_seconds": rec.duration_seconds,
        "start_time": rec.start_time.isoformat() if rec.start_time else "",
        "end_time": rec.end_time.isoformat() if rec.end_time else None,
        "event_id": str(rec.event_id) if rec.event_id else None,
        "metadata": rec.metadata_ or {},
        "bookmark_count": bm_count,
    }


def _bookmark_to_dict(bm: VideoBookmark) -> Dict[str, Any]:
    return {
        "id": str(bm.id),
        "recording_id": str(bm.recording_id),
        "user_id": str(bm.user_id),
        "timestamp_offset": bm.timestamp_offset,
        "label": bm.label,
        "notes": bm.notes,
        "bookmark_type": bm.bookmark_type,
        "severity": bm.severity,
        "frame_snapshot_path": bm.frame_snapshot_path,
        "ai_analysis": bm.ai_analysis,
        "created_at": bm.created_at.isoformat() if bm.created_at else "",
    }


# ── 1. List recordings ───────────────────────────────────────

@router.get("/recordings", response_model=RecordingListOut)
async def list_recordings(
    camera_id: Optional[str] = Query(None),
    recording_type: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    min_duration: Optional[float] = Query(None, ge=0),
    sort_by: str = Query("start_time"),
    sort_order: str = Query("desc"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List and filter archived video recordings."""
    filters = []

    if camera_id:
        try:
            filters.append(Recording.camera_id == uuid.UUID(camera_id))
        except ValueError:
            pass

    if recording_type:
        try:
            rt = RecordingType(recording_type)
            filters.append(Recording.recording_type == rt)
        except ValueError:
            pass

    if start_date:
        try:
            sd = datetime.fromisoformat(start_date)
            filters.append(Recording.start_time >= sd)
        except ValueError:
            pass

    if end_date:
        try:
            ed = datetime.fromisoformat(end_date)
            filters.append(Recording.start_time <= ed)
        except ValueError:
            pass

    if min_duration is not None:
        filters.append(Recording.duration_seconds >= min_duration)

    # Count total
    count_q = select(sa_func.count(Recording.id))
    if filters:
        count_q = count_q.where(and_(*filters))
    total = (await db.execute(count_q)).scalar() or 0

    # Sort
    sort_col = getattr(Recording, sort_by, Recording.start_time)
    order_fn = desc if sort_order == "desc" else asc

    # Query with camera join
    q = (
        select(Recording, Camera.name.label("camera_name"))
        .outerjoin(Camera, Recording.camera_id == Camera.id)
    )
    if filters:
        q = q.where(and_(*filters))
    q = q.order_by(order_fn(sort_col)).offset((page - 1) * page_size).limit(page_size)

    rows = (await db.execute(q)).all()

    # Get bookmark counts
    rec_ids = [r[0].id for r in rows]
    bm_counts: Dict[uuid.UUID, int] = {}
    if rec_ids:
        bm_q = (
            select(VideoBookmark.recording_id, sa_func.count(VideoBookmark.id))
            .where(VideoBookmark.recording_id.in_(rec_ids))
            .group_by(VideoBookmark.recording_id)
        )
        for rid, cnt in await db.execute(bm_q):
            bm_counts[rid] = cnt

    recordings = [
        _recording_to_dict(rec, camera_name=cam_name, bm_count=bm_counts.get(rec.id, 0))
        for rec, cam_name in rows
    ]

    total_pages = max(1, (total + page_size - 1) // page_size)

    return RecordingListOut(
        recordings=recordings,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


# ── 2. Get single recording ──────────────────────────────────

@router.get("/recordings/{recording_id}")
async def get_recording(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get a single recording with details."""
    q = (
        select(Recording, Camera.name.label("camera_name"))
        .outerjoin(Camera, Recording.camera_id == Camera.id)
        .where(Recording.id == recording_id)
    )
    row = (await db.execute(q)).first()
    if not row:
        raise HTTPException(404, "Recording not found")

    rec, cam_name = row

    # Bookmark count
    bm_count = (await db.execute(
        select(sa_func.count(VideoBookmark.id)).where(VideoBookmark.recording_id == recording_id)
    )).scalar() or 0

    return _recording_to_dict(rec, camera_name=cam_name, bm_count=bm_count)


# ── 3. Stream video (HTTP range requests) ────────────────────

@router.get("/stream/{recording_id}")
async def stream_recording(
    recording_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Stream a recording MP4 with HTTP range-request support for seeking."""
    rec = (await db.execute(
        select(Recording).where(Recording.id == recording_id)
    )).scalar_one_or_none()

    if not rec:
        raise HTTPException(404, "Recording not found")

    file_path = rec.file_path
    if not os.path.exists(file_path):
        raise HTTPException(404, "Recording file not found on disk")

    file_size = os.path.getsize(file_path)
    range_header = request.headers.get("range")

    if range_header:
        m = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if not m:
            raise HTTPException(416, "Invalid range header")

        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else file_size - 1
        end = min(end, file_size - 1)

        if start >= file_size:
            raise HTTPException(416, "Range not satisfiable")

        chunk_size = end - start + 1

        def _iter_range():
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = chunk_size
                while remaining > 0:
                    read_size = min(8192, remaining)
                    data = f.read(read_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            _iter_range(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(chunk_size),
            },
        )
    else:
        return FileResponse(file_path, media_type="video/mp4")


# ── 4. Thumbnail extraction ──────────────────────────────────

@router.get("/thumbnail/{recording_id}")
async def get_thumbnail(
    recording_id: uuid.UUID,
    offset: float = Query(1.0, ge=0, description="Seconds into video"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Extract a JPEG frame thumbnail from a recording at the given offset."""
    rec = (await db.execute(
        select(Recording).where(Recording.id == recording_id)
    )).scalar_one_or_none()

    if not rec:
        raise HTTPException(404, "Recording not found")
    if not os.path.exists(rec.file_path):
        raise HTTPException(404, "Recording file not found on disk")

    frame = _extract_frame_at_offset(rec.file_path, offset)
    if frame is None:
        raise HTTPException(500, "Failed to extract frame")

    # Resize for thumbnail (max 480px wide)
    h, w = frame.shape[:2]
    if w > 480:
        scale = 480 / w
        frame = cv2.resize(frame, (480, int(h * scale)))

    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return Response(content=buf.tobytes(), media_type="image/jpeg")


# ── 5. Create bookmark ───────────────────────────────────────

@router.post("/bookmarks", response_model=BookmarkOut)
async def create_bookmark(
    body: BookmarkCreate,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """Create a timestamped bookmark/annotation on a recording."""
    rec = (await db.execute(
        select(Recording).where(Recording.id == body.recording_id)
    )).scalar_one_or_none()

    if not rec:
        raise HTTPException(404, "Recording not found")

    # Validate offset within duration
    if rec.duration_seconds and body.timestamp_offset > rec.duration_seconds:
        raise HTTPException(400, f"Offset {body.timestamp_offset}s exceeds recording duration {rec.duration_seconds}s")

    bm = VideoBookmark(
        recording_id=body.recording_id,
        user_id=user.id,
        timestamp_offset=body.timestamp_offset,
        label=body.label,
        notes=body.notes,
        bookmark_type=body.bookmark_type,
        severity=body.severity,
    )
    db.add(bm)
    await db.commit()
    await db.refresh(bm)

    return _bookmark_to_dict(bm)


# ── 6. List bookmarks for a recording ────────────────────────

@router.get("/recordings/{recording_id}/bookmarks", response_model=List[BookmarkOut])
async def list_bookmarks(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all bookmarks for a recording, sorted by timestamp offset."""
    q = (
        select(VideoBookmark)
        .where(VideoBookmark.recording_id == recording_id)
        .order_by(asc(VideoBookmark.timestamp_offset))
    )
    rows = (await db.execute(q)).scalars().all()
    return [_bookmark_to_dict(bm) for bm in rows]


# ── 7. Forensic frame analysis ───────────────────────────────

@router.post("/forensics/analyze")
async def analyze_recording_frame(
    body: ForensicAnalyzeRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Extract frame at offset and run deep AI forensic analysis + visual search."""
    rec = (await db.execute(
        select(Recording).where(Recording.id == body.recording_id)
    )).scalar_one_or_none()

    if not rec:
        raise HTTPException(404, "Recording not found")
    if not os.path.exists(rec.file_path):
        raise HTTPException(404, "Recording file not found on disk")

    frame = _extract_frame_at_offset(rec.file_path, body.timestamp_offset)
    if frame is None:
        raise HTTPException(500, "Failed to extract frame at the requested offset")

    camera_id = str(rec.camera_id)
    ts = ""
    if rec.start_time:
        from datetime import timedelta
        ts = (rec.start_time + timedelta(seconds=body.timestamp_offset)).isoformat()

    # Deep forensic analysis
    forensic_result: Dict[str, Any] = {}
    try:
        from backend.services.gemini_forensics import gemini_forensics
        forensic_result = await gemini_forensics.analyze_frame_deep(
            frame=frame,
            camera_id=camera_id,
            timestamp=ts,
            query=body.query,
        )
    except Exception as e:
        logger.warning("Forensic analysis failed: %s", e)
        forensic_result = {"error": str(e)}

    # Visual similarity search via CLIP
    similar_frames: List[Dict] = []
    try:
        from backend.services.clip_embedder import clip_embedder
        from backend.services.vector_store import vector_store
        embedding = await clip_embedder.embed_frame(frame)
        similar_frames = await vector_store.visual_search_by_image(
            image_vector=embedding, top_k=6, min_score=0.3,
        )
    except Exception as e:
        logger.warning("CLIP visual search failed: %s", e)

    return {
        "recording_id": str(rec.id),
        "timestamp_offset": body.timestamp_offset,
        "camera_id": camera_id,
        "timestamp": ts,
        "forensic_analysis": forensic_result,
        "similar_frames": similar_frames,
        "ai_provider": forensic_result.get("ai_provider", "unknown"),
    }


# ── 8. Export recording as evidence ───────────────────────────

@router.post("/export")
async def export_recording_evidence(
    body: EvidenceExportRequest,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """Export a recording as evidence, optionally linking to a case."""
    rec = (await db.execute(
        select(Recording, Camera.name.label("camera_name"))
        .outerjoin(Camera, Recording.camera_id == Camera.id)
        .where(Recording.id == body.recording_id)
    )).first()

    if not rec:
        raise HTTPException(404, "Recording not found")

    recording, cam_name = rec

    if not os.path.exists(recording.file_path):
        raise HTTPException(404, "Recording file not found on disk")

    # Compute SHA-256 hash
    sha256 = hashlib.sha256()
    with open(recording.file_path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            sha256.update(chunk)
    file_hash = sha256.hexdigest()

    # Gather bookmarks
    bookmarks_data = []
    if body.include_bookmarks:
        bm_q = (
            select(VideoBookmark)
            .where(VideoBookmark.recording_id == body.recording_id)
            .order_by(asc(VideoBookmark.timestamp_offset))
        )
        bms = (await db.execute(bm_q)).scalars().all()
        bookmarks_data = [_bookmark_to_dict(bm) for bm in bms]

    # Build manifest
    manifest = {
        "recording_id": str(recording.id),
        "camera_id": str(recording.camera_id),
        "camera_name": cam_name or "",
        "recording_type": recording.recording_type.value if recording.recording_type else "unknown",
        "file_path": recording.file_path,
        "file_size": recording.file_size,
        "duration_seconds": recording.duration_seconds,
        "start_time": recording.start_time.isoformat() if recording.start_time else "",
        "end_time": recording.end_time.isoformat() if recording.end_time else None,
        "sha256_hash": file_hash,
        "exported_by": str(user.id),
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "bookmarks": bookmarks_data,
    }

    # Store evidence hash
    evidence_hash = EvidenceHash(
        evidence_type="recording",
        evidence_id=recording.id,
        file_path=recording.file_path,
        sha256_hash=file_hash,
        verification_status="verified",
        verified_at=datetime.now(timezone.utc),
    )
    db.add(evidence_hash)

    # Link to case if provided
    case_evidence_id = None
    if body.case_id:
        from backend.models import Case
        case = (await db.execute(
            select(Case).where(Case.id == body.case_id)
        )).scalar_one_or_none()

        if not case:
            raise HTTPException(404, "Case not found")

        ce = CaseEvidence(
            case_id=body.case_id,
            evidence_type="recording",
            reference_id=recording.id,
            title=f"Video Recording — {cam_name or 'Unknown Camera'}",
            content=f"Duration: {recording.duration_seconds or 0:.1f}s | Hash: {file_hash[:16]}...",
            file_url=recording.file_path,
            metadata_={
                "sha256_hash": file_hash,
                "recording_type": recording.recording_type.value if recording.recording_type else "unknown",
                "bookmarks_count": len(bookmarks_data),
            },
        )
        db.add(ce)
        case_evidence_id = str(ce.id)

    await db.commit()

    return {
        "status": "exported",
        "recording_id": str(recording.id),
        "case_id": str(body.case_id) if body.case_id else None,
        "case_evidence_id": case_evidence_id,
        "manifest": manifest,
        "evidence_hash": file_hash,
    }


# ── 9. Delete bookmark ───────────────────────────────────────

@router.delete("/bookmarks/{bookmark_id}")
async def delete_bookmark(
    bookmark_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Delete a bookmark."""
    bm = (await db.execute(
        select(VideoBookmark).where(VideoBookmark.id == bookmark_id)
    )).scalar_one_or_none()

    if not bm:
        raise HTTPException(404, "Bookmark not found")

    await db.delete(bm)
    await db.commit()
    return {"status": "deleted", "id": str(bookmark_id)}


# ── 10. Archive stats ────────────────────────────────────────

@router.get("/stats")
async def get_archive_stats(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get archive statistics."""
    total_recordings = (await db.execute(
        select(sa_func.count(Recording.id))
    )).scalar() or 0

    total_duration = (await db.execute(
        select(sa_func.sum(Recording.duration_seconds))
    )).scalar() or 0.0

    total_size = (await db.execute(
        select(sa_func.sum(Recording.file_size))
    )).scalar() or 0

    total_bookmarks = (await db.execute(
        select(sa_func.count(VideoBookmark.id))
    )).scalar() or 0

    # Count by type
    type_counts = {}
    for rt in RecordingType:
        cnt = (await db.execute(
            select(sa_func.count(Recording.id)).where(Recording.recording_type == rt)
        )).scalar() or 0
        type_counts[rt.value] = cnt

    # Count cameras with recordings
    cameras_with_recordings = (await db.execute(
        select(sa_func.count(sa_func.distinct(Recording.camera_id)))
    )).scalar() or 0

    return {
        "total_recordings": total_recordings,
        "total_duration_seconds": round(total_duration, 1),
        "total_size_bytes": total_size,
        "total_bookmarks": total_bookmarks,
        "recordings_by_type": type_counts,
        "cameras_with_recordings": cameras_with_recordings,
    }
