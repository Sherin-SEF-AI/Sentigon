"""Forensics and investigation API."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models import Event, Alert, Camera
from backend.api.auth import get_current_user, require_role
from backend.models.models import UserRole

router = APIRouter(prefix="/api/forensics", tags=["forensics"])


# ── Request / Response schemas ─────────────────────────────────

class AnalyzeFrameRequest(BaseModel):
    """Request deep analysis of a specific frame or event."""
    event_id: uuid.UUID = Field(..., description="Event ID whose frame should be analysed")
    analysis_types: Optional[List[str]] = Field(
        default=["objects", "faces", "text", "anomalies"],
        description="Types of analysis to perform",
    )
    include_context: bool = Field(
        default=True,
        description="Include surrounding events for context",
    )
    context_window_seconds: int = Field(
        default=60,
        description="Seconds before/after the event to include as context",
    )


class FrameAnalysisResponse(BaseModel):
    event_id: str
    frame_url: Optional[str]
    detections: Optional[Dict[str, Any]]
    gemini_analysis: Optional[Dict[str, Any]]
    analysis: Dict[str, Any]
    context_events: List[Dict[str, Any]]


class TimelineRequest(BaseModel):
    """Build an incident timeline for a time range."""
    start_time: datetime
    end_time: datetime
    camera_ids: Optional[List[uuid.UUID]] = None
    zone_ids: Optional[List[uuid.UUID]] = None
    event_types: Optional[List[str]] = None
    min_severity: Optional[str] = Field(None, description="Minimum severity to include")
    include_alerts: bool = True


class TimelineEntry(BaseModel):
    timestamp: str
    type: str  # "event" or "alert"
    id: str
    event_type: Optional[str]
    description: Optional[str]
    severity: str
    confidence: Optional[float]
    camera_id: Optional[str]
    zone_id: Optional[str]
    metadata: Optional[Dict[str, Any]]


class TimelineResponse(BaseModel):
    start_time: str
    end_time: str
    total_entries: int
    entries: List[TimelineEntry]
    summary: Dict[str, Any]


class CorrelateRequest(BaseModel):
    """Cross-camera correlation request."""
    anchor_event_id: uuid.UUID = Field(
        ..., description="Primary event to correlate around"
    )
    time_window_seconds: int = Field(
        default=300,
        description="Window (seconds) to search for correlated events",
    )
    max_results: int = Field(default=50, ge=1, le=200)
    min_confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class CorrelationResult(BaseModel):
    anchor_event: Dict[str, Any]
    correlated_events: List[Dict[str, Any]]
    correlation_score: float
    cameras_involved: List[str]
    summary: str


# ── Helpers ────────────────────────────────────────────────────

SEVERITY_ORDER = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


def _event_to_dict(ev: Event) -> Dict[str, Any]:
    return {
        "id": str(ev.id),
        "camera_id": str(ev.camera_id),
        "zone_id": str(ev.zone_id) if ev.zone_id else None,
        "event_type": ev.event_type,
        "description": ev.description,
        "severity": ev.severity.value if ev.severity else "info",
        "confidence": ev.confidence,
        "detections": ev.detections,
        "frame_url": ev.frame_url,
        "gemini_analysis": ev.gemini_analysis,
        "timestamp": ev.timestamp.isoformat() if ev.timestamp else None,
        "metadata": ev.metadata_,
    }


# ── Endpoints ──────────────────────────────────────────────────

@router.post("/analyze-frame", response_model=FrameAnalysisResponse)
async def analyze_frame(
    body: AnalyzeFrameRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Deep analysis of a specific frame / event.

    Returns the event's existing detections and Gemini analysis,
    plus gathers contextual events within the requested time window.
    """
    result = await db.execute(select(Event).where(Event.id == body.event_id))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")

    # Build analysis summary from stored data
    analysis: Dict[str, Any] = {
        "requested_types": body.analysis_types,
        "objects_detected": [],
        "anomalies": [],
    }

    if event.detections:
        detections = event.detections
        analysis["objects_detected"] = detections.get("labels", detections.get("classes", []))
        analysis["bounding_boxes"] = detections.get("boxes", [])
        analysis["detection_scores"] = detections.get("scores", [])

    if event.gemini_analysis:
        analysis["gemini_summary"] = event.gemini_analysis.get("summary", "")
        analysis["gemini_threats"] = event.gemini_analysis.get("threats", [])
        analysis["anomalies"] = event.gemini_analysis.get("anomalies", [])

    # Gather context events
    context_events: List[Dict[str, Any]] = []
    if body.include_context and event.timestamp:
        from datetime import timedelta
        window = timedelta(seconds=body.context_window_seconds)
        ctx_start = event.timestamp - window
        ctx_end = event.timestamp + window

        ctx_stmt = (
            select(Event)
            .where(
                and_(
                    Event.camera_id == event.camera_id,
                    Event.timestamp >= ctx_start,
                    Event.timestamp <= ctx_end,
                    Event.id != event.id,
                )
            )
            .order_by(Event.timestamp)
            .limit(20)
        )
        ctx_result = await db.execute(ctx_stmt)
        for ctx_ev in ctx_result.scalars().all():
            context_events.append(_event_to_dict(ctx_ev))

    return FrameAnalysisResponse(
        event_id=str(event.id),
        frame_url=event.frame_url,
        detections=event.detections,
        gemini_analysis=event.gemini_analysis,
        analysis=analysis,
        context_events=context_events,
    )


@router.post("/timeline", response_model=TimelineResponse)
async def build_timeline(
    body: TimelineRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Build an incident timeline for a given time range.

    Combines events and optionally alerts into a unified,
    chronologically sorted timeline.
    """
    if body.end_time <= body.start_time:
        raise HTTPException(status_code=400, detail="end_time must be after start_time")

    # ── Collect events ────────────────────────────────────────
    event_filters = [
        Event.timestamp >= body.start_time,
        Event.timestamp <= body.end_time,
    ]
    if body.camera_ids:
        event_filters.append(Event.camera_id.in_(body.camera_ids))
    if body.zone_ids:
        event_filters.append(Event.zone_id.in_(body.zone_ids))
    if body.event_types:
        event_filters.append(Event.event_type.in_(body.event_types))
    if body.min_severity:
        from backend.models.models import AlertSeverity
        min_level = SEVERITY_ORDER.get(body.min_severity, 0)
        allowed = [s for s, lvl in SEVERITY_ORDER.items() if lvl >= min_level]
        try:
            allowed_enums = [AlertSeverity(s) for s in allowed]
        except ValueError:
            allowed_enums = []
        if allowed_enums:
            event_filters.append(Event.severity.in_(allowed_enums))

    event_stmt = (
        select(Event)
        .where(and_(*event_filters))
        .order_by(Event.timestamp)
        .limit(500)
    )
    event_result = await db.execute(event_stmt)
    events = event_result.scalars().all()

    entries: List[TimelineEntry] = []
    severity_counts: Dict[str, int] = {}
    event_type_counts: Dict[str, int] = {}

    for ev in events:
        sev = ev.severity.value if ev.severity else "info"
        severity_counts[sev] = severity_counts.get(sev, 0) + 1
        event_type_counts[ev.event_type] = event_type_counts.get(ev.event_type, 0) + 1

        entries.append(
            TimelineEntry(
                timestamp=ev.timestamp.isoformat() if ev.timestamp else "",
                type="event",
                id=str(ev.id),
                event_type=ev.event_type,
                description=ev.description,
                severity=sev,
                confidence=ev.confidence,
                camera_id=str(ev.camera_id),
                zone_id=str(ev.zone_id) if ev.zone_id else None,
                metadata=ev.metadata_,
            )
        )

    # ── Collect alerts ────────────────────────────────────────
    alert_count = 0
    if body.include_alerts:
        alert_filters = [
            Alert.created_at >= body.start_time,
            Alert.created_at <= body.end_time,
        ]
        alert_stmt = (
            select(Alert)
            .where(and_(*alert_filters))
            .order_by(Alert.created_at)
            .limit(200)
        )
        alert_result = await db.execute(alert_stmt)
        alerts = alert_result.scalars().all()
        alert_count = len(alerts)

        for al in alerts:
            sev = al.severity.value if al.severity else "medium"
            entries.append(
                TimelineEntry(
                    timestamp=al.created_at.isoformat() if al.created_at else "",
                    type="alert",
                    id=str(al.id),
                    event_type=al.threat_type,
                    description=al.title,
                    severity=sev,
                    confidence=al.confidence,
                    camera_id=al.source_camera,
                    zone_id=None,
                    metadata=al.metadata_,
                )
            )

    # Sort all entries chronologically
    entries.sort(key=lambda e: e.timestamp)

    summary: Dict[str, Any] = {
        "total_events": len(events),
        "total_alerts": alert_count,
        "severity_distribution": severity_counts,
        "event_type_distribution": event_type_counts,
    }

    return TimelineResponse(
        start_time=body.start_time.isoformat(),
        end_time=body.end_time.isoformat(),
        total_entries=len(entries),
        entries=entries,
        summary=summary,
    )


@router.post("/correlate", response_model=CorrelationResult)
async def correlate_events(
    body: CorrelateRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Cross-camera correlation around an anchor event.

    Finds events from *other* cameras within the specified time window
    that share similar characteristics (event_type, severity) and
    computes a basic correlation score.
    """
    # Fetch anchor event
    anchor_result = await db.execute(select(Event).where(Event.id == body.anchor_event_id))
    anchor = anchor_result.scalar_one_or_none()
    if anchor is None:
        raise HTTPException(status_code=404, detail="Anchor event not found")

    if anchor.timestamp is None:
        raise HTTPException(status_code=400, detail="Anchor event has no timestamp")

    from datetime import timedelta

    window = timedelta(seconds=body.time_window_seconds)
    window_start = anchor.timestamp - window
    window_end = anchor.timestamp + window

    # Find events from OTHER cameras in the window
    corr_filters = [
        Event.timestamp >= window_start,
        Event.timestamp <= window_end,
        Event.camera_id != anchor.camera_id,
        Event.id != anchor.id,
    ]
    if body.min_confidence > 0:
        corr_filters.append(Event.confidence >= body.min_confidence)

    corr_stmt = (
        select(Event)
        .where(and_(*corr_filters))
        .order_by(Event.timestamp)
        .limit(body.max_results)
    )
    corr_result = await db.execute(corr_stmt)
    corr_events = corr_result.scalars().all()

    # Compute per-event correlation score
    cameras_seen: set[str] = {str(anchor.camera_id)}
    correlated: List[Dict[str, Any]] = []

    for ev in corr_events:
        score = 0.0
        # Same event type adds weight
        if ev.event_type == anchor.event_type:
            score += 0.4
        # Same severity adds weight
        if ev.severity == anchor.severity:
            score += 0.2
        # Temporal proximity adds weight (closer = higher)
        if ev.timestamp and anchor.timestamp:
            delta = abs((ev.timestamp - anchor.timestamp).total_seconds())
            max_delta = body.time_window_seconds or 1
            proximity = 1.0 - (delta / max_delta)
            score += 0.3 * max(proximity, 0.0)
        # High confidence adds weight
        if ev.confidence and ev.confidence > 0.7:
            score += 0.1

        ev_dict = _event_to_dict(ev)
        ev_dict["correlation_score"] = round(score, 3)
        correlated.append(ev_dict)
        cameras_seen.add(str(ev.camera_id))

    # Sort by correlation score descending
    correlated.sort(key=lambda x: x.get("correlation_score", 0), reverse=True)

    # Overall correlation score
    overall_score = round(
        sum(c.get("correlation_score", 0) for c in correlated) / max(len(correlated), 1),
        3,
    )

    # Build summary
    summary_parts = [
        f"Found {len(correlated)} correlated events across {len(cameras_seen)} cameras",
        f"within {body.time_window_seconds}s of anchor event '{anchor.event_type}'.",
    ]
    if correlated:
        top = correlated[0]
        summary_parts.append(
            f"Strongest correlation: {top.get('event_type')} on camera {top.get('camera_id')} "
            f"(score {top.get('correlation_score')})."
        )

    return CorrelationResult(
        anchor_event=_event_to_dict(anchor),
        correlated_events=correlated,
        correlation_score=overall_score,
        cameras_involved=sorted(cameras_seen),
        summary=" ".join(summary_parts),
    )


# ── Advanced Forensics — Subject Search, Movement Trail, Event Clusters ──


class SubjectSearchRequest(BaseModel):
    description: str = Field(..., min_length=3, max_length=500, description="Natural language subject description")
    time_range_hours: int = Field(24, ge=1, le=168)
    max_results: int = Field(20, ge=1, le=100)


class MovementTrailRequest(BaseModel):
    subject_description: str = Field(..., min_length=3, max_length=500)
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    max_results: int = Field(30, ge=1, le=100)


class EventClusterRequest(BaseModel):
    time_window_seconds: int = Field(300, ge=30, le=3600)
    min_cameras: int = Field(2, ge=1, le=20)
    severity_filter: Optional[str] = Field(None, description="Minimum severity: info, low, medium, high, critical")


@router.post("/subject-search")
async def subject_search(
    body: SubjectSearchRequest,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Search for a subject across all cameras using vector similarity.

    Uses Qdrant semantic search to find events matching a natural-language
    appearance description, groups results by camera, and optionally
    enriches with Gemini AI cross-reference analysis.
    """
    from backend.services.event_correlator import event_correlator

    results = await event_correlator.find_subject_across_cameras(
        description=body.description,
        top_k=body.max_results,
        time_range_hours=body.time_range_hours,
    )
    return {
        "query": body.description,
        "time_range_hours": body.time_range_hours,
        "total_appearances": sum(a.get("match_count", 0) for a in results),
        "cameras_found": len(results),
        "appearances": results,
    }


@router.post("/movement-trail")
async def movement_trail(
    body: MovementTrailRequest,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Reconstruct a subject's movement trail across cameras.

    Combines Qdrant vector search with temporal ordering to produce a
    chronological path of appearances, plus a Gemini-generated narrative.
    """
    from backend.services.event_correlator import event_correlator

    time_range = None
    if body.start_time and body.end_time:
        time_range = (body.start_time, body.end_time)

    result = await event_correlator.build_movement_trail(
        subject_description=body.subject_description,
        time_range=time_range,
        top_k=body.max_results,
    )
    return result


@router.post("/event-clusters")
async def event_clusters(
    body: EventClusterRequest,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Find clusters of correlated events across multiple cameras.

    Groups events that occurred within the time window and appeared
    on multiple cameras. Optionally enriched with Gemini AI analysis
    to identify shared subjects and movement patterns.
    """
    from backend.services.event_correlator import event_correlator

    clusters = await event_correlator.correlate_events(
        time_window=body.time_window_seconds,
        min_cameras=body.min_cameras,
        severity_filter=body.severity_filter,
    )
    return {
        "time_window_seconds": body.time_window_seconds,
        "min_cameras": body.min_cameras,
        "total_clusters": len(clusters),
        "clusters": clusters,
    }


# ── Visual Frame Search — Find Similar ───────────────────────────


class FindSimilarRequest(BaseModel):
    event_id: uuid.UUID = Field(..., description="Source event ID to find similar frames for")
    max_results: int = Field(12, ge=1, le=100)
    min_score: float = Field(0.5, ge=0.0, le=1.0)


@router.post("/find-similar")
async def find_similar_frames(
    body: FindSimilarRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Find visually similar frames using CLIP vector embeddings."""
    # Get the source event
    result = await db.execute(select(Event).where(Event.id == body.event_id))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")

    try:
        from backend.services.vector_store import vector_store

        # Try to search using the event description or frame embedding
        search_text = event.description or event.event_type or "security event"
        if event.gemini_analysis and isinstance(event.gemini_analysis, dict):
            scene = event.gemini_analysis.get("scene_description", "")
            if scene:
                search_text = scene

        results = await vector_store.visual_search_by_text(
            text=search_text,
            top_k=body.max_results,
            score_threshold=body.min_score,
        )

        similar_frames = []
        for r in results:
            payload = r.get("payload", {}) if isinstance(r, dict) else {}
            score = r.get("score", 0) if isinstance(r, dict) else 0
            similar_frames.append({
                "event_id": payload.get("event_id", ""),
                "frame_url": payload.get("frame_url", None),
                "camera_id": str(payload.get("camera_id", "")),
                "camera_name": payload.get("camera_name", ""),
                "timestamp": payload.get("timestamp", ""),
                "similarity_score": round(score, 3),
                "event_type": payload.get("event_type", ""),
                "description": payload.get("description", ""),
            })

        return {
            "query_event_id": str(body.event_id),
            "results": similar_frames,
            "total_results": len(similar_frames),
            "search_method": "clip_visual",
        }
    except Exception as e:
        logger.warning("Visual search failed, falling back to text search: %s", e)
        # Fallback: search by text embedding in sentinel_events
        try:
            from backend.services.vector_store import vector_store
            search_text = event.description or event.event_type or "security event"
            results = await vector_store.search(
                text=search_text,
                collection="sentinel_events",
                top_k=body.max_results,
            )
            similar_frames = []
            for r in results:
                payload = r.get("payload", {}) if isinstance(r, dict) else {}
                score = r.get("score", 0) if isinstance(r, dict) else 0
                if score >= body.min_score:
                    similar_frames.append({
                        "event_id": payload.get("event_id", str(payload.get("id", ""))),
                        "frame_url": payload.get("frame_url", None),
                        "camera_id": str(payload.get("camera_id", "")),
                        "camera_name": payload.get("camera_name", ""),
                        "timestamp": payload.get("timestamp", ""),
                        "similarity_score": round(score, 3),
                        "event_type": payload.get("event_type", ""),
                        "description": payload.get("description", ""),
                    })
            return {
                "query_event_id": str(body.event_id),
                "results": similar_frames,
                "total_results": len(similar_frames),
                "search_method": "text_semantic",
            }
        except Exception as e2:
            logger.error("All search methods failed: %s", e2)
            return {
                "query_event_id": str(body.event_id),
                "results": [],
                "total_results": 0,
                "search_method": "none",
                "error": str(e2),
            }


# ── AI Investigation Agent ─────────────────────────────────────


class InvestigateRequest(BaseModel):
    query: str = Field(..., min_length=5, max_length=1000, description="Natural language investigation query")
    hours_back: int = Field(24, ge=1, le=168)


@router.post("/investigate")
async def run_investigation(
    body: InvestigateRequest,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Run an AI-powered investigation from a natural language query.

    The AI agent autonomously selects and executes investigation tools,
    then synthesizes results into a comprehensive report.
    """
    try:
        from backend.services.investigation_agent import investigation_agent
        result = await investigation_agent.investigate(
            query=body.query,
            hours_back=body.hours_back,
        )
        return result
    except ImportError:
        raise HTTPException(status_code=501, detail="Investigation agent not available")
    except Exception as e:
        logger.error("Investigation failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ── PDF Evidence Report Export ─────────────────────────────────


class ExportPdfRequest(BaseModel):
    report_type: str = Field(..., description="'evidence' or 'investigation'")
    data: Dict[str, Any] = Field(..., description="Report data payload")


@router.post("/export-pdf")
async def export_pdf_report(
    body: ExportPdfRequest,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Generate and download a PDF evidence or investigation report."""
    from fastapi.responses import Response

    try:
        from backend.services.pdf_report_generator import (
            generate_evidence_report,
            generate_investigation_report,
        )

        if body.report_type == "investigation":
            pdf_bytes = await generate_investigation_report(body.data)
        else:
            pdf_bytes = await generate_evidence_report(body.data)

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename=sentinel-{body.report_type}-report.pdf",
            },
        )
    except ImportError:
        raise HTTPException(status_code=501, detail="PDF generator not available")
    except Exception as e:
        logger.error("PDF generation failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
