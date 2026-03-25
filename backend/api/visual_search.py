"""Visual Search API — CLIP-powered text-to-image & image-to-image search."""

from __future__ import annotations

import base64
import logging
import uuid
from typing import Any, Dict, List, Optional

import cv2
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.api.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/visual-search", tags=["visual-search"])


# ── Request / Response schemas ────────────────────────────

class TextSearchRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=500, description="Natural language visual query")
    top_k: int = Field(20, ge=1, le=100)
    camera_ids: Optional[List[str]] = None
    time_range_minutes: Optional[int] = Field(None, ge=1, le=10080)
    min_score: float = Field(0.15, ge=0.0, le=1.0)


class FrameSearchRequest(BaseModel):
    top_k: int = Field(20, ge=1, le=100)
    camera_ids: Optional[List[str]] = None
    min_score: float = Field(0.5, ge=0.0, le=1.0)


class VisualSearchResult(BaseModel):
    score: float
    camera_id: str
    timestamp: str
    anomaly_score: float = 0.0
    is_anomaly: bool = False
    point_id: str = ""
    metadata: Dict[str, Any] = {}


class VisualSearchResponse(BaseModel):
    query: str
    search_type: str  # "text" | "image" | "frame"
    results: List[VisualSearchResult]
    total: int
    model_info: Dict[str, Any] = {}


class CLIPStatsResponse(BaseModel):
    model_loaded: bool = False
    model_name: str = ""
    device: str = "not_loaded"
    embedding_dim: int = 1280
    total_inferences: int = 0
    avg_inference_ms: float = 0.0
    clip_enabled: bool = False
    pipeline_running: bool = False
    frames_embedded: int = 0
    anomalies_detected: int = 0
    cameras_tracking: int = 0
    collection_size: int = 0
    embed_interval_s: int = 3
    anomaly_threshold: float = 0.35
    retention_hours: int = 48


class AnomalyEntry(BaseModel):
    camera_id: str
    timestamp: str
    anomaly_score: float


# ── Helpers ───────────────────────────────────────────────

def _get_clip_embedder():
    try:
        from backend.services.clip_embedder import clip_embedder
        return clip_embedder
    except ImportError:
        return None


def _get_clip_pipeline():
    try:
        from backend.services.clip_pipeline import clip_pipeline
        return clip_pipeline
    except ImportError:
        return None


def _get_vector_store():
    try:
        from backend.services.vector_store import vector_store
        return vector_store
    except ImportError:
        return None


def _format_results(raw: List[Dict], search_type: str, query: str, model_info: Dict) -> VisualSearchResponse:
    """Format raw Qdrant results into response."""
    results = []
    for hit in raw:
        results.append(VisualSearchResult(
            score=round(hit.get("score", 0.0), 4),
            camera_id=hit.get("camera_id", ""),
            timestamp=hit.get("timestamp", ""),
            anomaly_score=float(hit.get("anomaly_score", 0.0)),
            is_anomaly=bool(hit.get("is_anomaly", False)),
            point_id=str(hit.get("id", "")),
            metadata={
                k: v for k, v in hit.items()
                if k not in ("score", "camera_id", "timestamp", "anomaly_score", "is_anomaly", "id")
            },
        ))

    return VisualSearchResponse(
        query=query,
        search_type=search_type,
        results=results,
        total=len(results),
        model_info=model_info,
    )


# ── Endpoints ─────────────────────────────────────────────

@router.post("/text", response_model=VisualSearchResponse)
async def search_by_text(
    body: TextSearchRequest,
    _user=Depends(get_current_user),
):
    """Search frames using natural language via CLIP cross-modal embedding."""
    embedder = _get_clip_embedder()
    vs = _get_vector_store()
    if embedder is None or vs is None:
        raise HTTPException(status_code=503, detail="CLIP service not available")

    try:
        text_vector = await embedder.embed_text(body.query)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"CLIP text encoding failed: {e}")

    raw = await vs.visual_search_by_text(
        text_vector=text_vector,
        top_k=body.top_k,
        camera_ids=body.camera_ids,
        min_score=body.min_score,
    )

    return _format_results(raw, "text", body.query, embedder.get_stats())


@router.post("/image", response_model=VisualSearchResponse)
async def search_by_image(
    file: UploadFile = File(...),
    top_k: int = Query(20, ge=1, le=100),
    min_score: float = Query(0.5, ge=0.0, le=1.0),
    _user=Depends(get_current_user),
):
    """Reverse image search — upload an image to find visually similar frames."""
    embedder = _get_clip_embedder()
    vs = _get_vector_store()
    if embedder is None or vs is None:
        raise HTTPException(status_code=503, detail="CLIP service not available")

    image_bytes = await file.read()
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 10MB)")

    try:
        image_vector = await embedder.embed_image_bytes(image_bytes)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"CLIP image encoding failed: {e}")

    raw = await vs.visual_search_by_image(
        image_vector=image_vector,
        top_k=top_k,
        min_score=min_score,
    )

    return _format_results(raw, "image", f"uploaded:{file.filename}", embedder.get_stats())


@router.post("/frame/{camera_id}", response_model=VisualSearchResponse)
async def search_by_camera_frame(
    camera_id: str,
    body: FrameSearchRequest,
    _user=Depends(get_current_user),
):
    """Use a camera's current frame as the search query."""
    embedder = _get_clip_embedder()
    vs = _get_vector_store()
    if embedder is None or vs is None:
        raise HTTPException(status_code=503, detail="CLIP service not available")

    # Get current frame from camera
    try:
        from backend.services.video_capture import capture_manager
        stream = capture_manager.get_stream(camera_id)
    except (ImportError, AttributeError):
        raise HTTPException(status_code=503, detail="Video capture not available")

    if stream is None or not stream.is_running:
        raise HTTPException(status_code=404, detail=f"Camera {camera_id} not found or offline")

    result = stream.get_latest_frame()
    if result is None:
        raise HTTPException(status_code=404, detail="No frame available")

    _, frame = result

    try:
        frame_vector = await embedder.embed_frame(frame)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"CLIP frame encoding failed: {e}")

    raw = await vs.visual_search_by_image(
        image_vector=frame_vector,
        top_k=body.top_k,
        camera_ids=body.camera_ids,
        min_score=body.min_score,
    )

    return _format_results(raw, "frame", f"camera:{camera_id}", embedder.get_stats())


@router.get("/anomalies", response_model=List[AnomalyEntry])
async def get_anomalies(
    limit: int = Query(20, ge=1, le=100),
    _user=Depends(get_current_user),
):
    """Get recent visual anomalies detected by the embedding pipeline."""
    pipeline = _get_clip_pipeline()
    if pipeline is None:
        return []
    return pipeline.get_recent_anomalies(limit=limit)


@router.get("/timeline/{camera_id}")
async def get_camera_timeline(
    camera_id: str,
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """Get visual embedding timeline for a camera (for scene change graph)."""
    vs = _get_vector_store()
    if vs is None:
        return {"camera_id": camera_id, "embeddings": [], "total": 0}

    embeddings = await vs.get_recent_embeddings(camera_id=camera_id, limit=limit)
    return {
        "camera_id": camera_id,
        "embeddings": embeddings,
        "total": len(embeddings),
    }


@router.get("/stats", response_model=CLIPStatsResponse)
async def get_clip_stats(_user=Depends(get_current_user)):
    """Get CLIP model and pipeline statistics."""
    embedder = _get_clip_embedder()
    pipeline = _get_clip_pipeline()
    vs = _get_vector_store()

    model_stats = embedder.get_stats() if embedder else {}
    pipeline_stats = pipeline.get_stats() if pipeline else {}
    collection_stats = await vs.get_frame_embedding_stats() if vs else {}

    return CLIPStatsResponse(
        model_loaded=model_stats.get("model_loaded", False),
        model_name=model_stats.get("model_name", ""),
        device=model_stats.get("device", "not_loaded"),
        embedding_dim=model_stats.get("embedding_dim", 1280),
        total_inferences=model_stats.get("total_inferences", 0),
        avg_inference_ms=model_stats.get("avg_inference_ms", 0.0),
        clip_enabled=model_stats.get("clip_enabled", False),
        pipeline_running=pipeline_stats.get("running", False),
        frames_embedded=pipeline_stats.get("frames_embedded", 0),
        anomalies_detected=pipeline_stats.get("anomalies_detected", 0),
        cameras_tracking=pipeline_stats.get("cameras_tracking", 0),
        collection_size=collection_stats.get("points_count", 0),
        embed_interval_s=pipeline_stats.get("embed_interval_s", 3),
        anomaly_threshold=pipeline_stats.get("anomaly_threshold", 0.35),
        retention_hours=pipeline_stats.get("retention_hours", 48),
    )


@router.get("/cameras")
async def get_cameras_with_embedding_status(_user=Depends(get_current_user)):
    """Get cameras with their embedding status."""
    pipeline = _get_clip_pipeline()

    # Get camera list from DB
    try:
        from sqlalchemy import select
        from backend.database import get_db, async_session
        from backend.models import Camera

        async with async_session() as db:
            result = await db.execute(select(Camera))
            cameras = result.scalars().all()
    except Exception:
        cameras = []

    camera_list = []
    for cam in cameras:
        cam_id = str(cam.id)
        last_embed = pipeline._last_embed_time.get(cam_id, 0) if pipeline else 0
        camera_list.append({
            "camera_id": cam_id,
            "name": cam.name,
            "location": cam.location,
            "status": cam.status,
            "is_embedding": last_embed > 0,
            "last_embed_time": last_embed if last_embed > 0 else None,
        })

    return camera_list


@router.get("/snapshot/{camera_id}")
async def get_camera_snapshot(
    camera_id: str,
    _user=Depends(get_current_user),
):
    """Get current JPEG snapshot from a camera."""
    try:
        from backend.services.video_capture import capture_manager
        stream = capture_manager.get_stream(camera_id)
    except (ImportError, AttributeError):
        raise HTTPException(status_code=503, detail="Video capture not available")

    if stream is None or not stream.is_running:
        raise HTTPException(status_code=404, detail="Camera offline")

    jpeg = stream.encode_jpeg(quality=75)
    if jpeg is None:
        raise HTTPException(status_code=404, detail="No frame available")

    return Response(content=jpeg, media_type="image/jpeg")
