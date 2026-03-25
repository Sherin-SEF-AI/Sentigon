"""Shared Gemini function-callable tools for all SENTINEL AI agents.

Every function here is a REAL implementation that calls real services.
Functions are converted to google.genai FunctionDeclaration schemas
and exposed to agents based on their role.
"""
from __future__ import annotations

import base64
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from cachetools import TTLCache

from sqlalchemy import select, func, and_

from backend.database import async_session
from backend.models.models import (
    Camera, Zone, Event, Alert, Case, CaseEvidence,
    Recording, AlertSeverity, AlertStatus, CameraStatus, CaseStatus,
    RecordingType,
)

logger = logging.getLogger(__name__)


# ── Bounded TTL cache to avoid redundant DB queries ─────────────
# Agents call get_site_context, get_all_cameras_status, get_all_zones_status
# many times per second across 17 agents. This caches results for a few seconds.
# Uses cachetools.TTLCache to bound memory and auto-evict stale entries.

_tool_cache_stores: dict[str, TTLCache] = {
    "get_site_context": TTLCache(maxsize=16, ttl=30),
    "get_all_cameras_status": TTLCache(maxsize=16, ttl=5),
    "get_all_zones_status": TTLCache(maxsize=16, ttl=5),
    "get_threat_intel_context": TTLCache(maxsize=16, ttl=15),
}
_DEFAULT_CACHE = TTLCache(maxsize=256, ttl=10)


def _cache_get(key: str) -> Any | None:
    store = _tool_cache_stores.get(key, _DEFAULT_CACHE)
    return store.get(key)


def _cache_set(key: str, value: Any):
    store = _tool_cache_stores.get(key, _DEFAULT_CACHE)
    store[key] = value


# ═══════════════════════════════════════════════════════════════
#  PERCEPTION TOOLS
# ═══════════════════════════════════════════════════════════════


async def capture_frame(camera_id: str) -> dict:
    """Capture a single frame from the specified camera. Returns base64 JPEG and metadata."""
    from backend.services.video_capture import capture_manager

    stream = capture_manager.get_stream(camera_id)
    if stream is None or not stream.is_running:
        return {"success": False, "error": f"Camera {camera_id} not available"}
    frame_bytes = stream.encode_jpeg()
    if frame_bytes is None:
        return {"success": False, "error": f"Camera {camera_id} no frame available"}
    b64 = base64.b64encode(frame_bytes).decode()
    return {
        "success": True,
        "camera_id": camera_id,
        "frame_base64": b64[:200] + "...[truncated]",
        "frame_size_bytes": len(frame_bytes),
        "fps": stream.fps,
        "timestamp": time.time(),
    }


async def get_camera_status(camera_id: str) -> dict:
    """Get current status of a camera."""
    async with async_session() as db:
        cam = await db.get(Camera, camera_id)
        if not cam:
            return {"success": False, "error": "Camera not found"}
        return {
            "success": True,
            "camera_id": str(cam.id),
            "name": cam.name,
            "status": cam.status.value if hasattr(cam.status, 'value') else str(cam.status),
            "location": cam.location,
            "fps": cam.fps,
            "is_active": cam.is_active,
        }


async def get_all_cameras_status() -> dict:
    """Get status summary of all connected cameras."""
    cached = _cache_get("get_all_cameras_status")
    if cached is not None:
        return cached
    async with async_session() as db:
        result = await db.execute(select(Camera).where(Camera.is_active.is_(True)))
        cameras = result.scalars().all()
        result_data = {
            "success": True,
            "total": len(cameras),
            "online": sum(1 for c in cameras if c.status == CameraStatus.ONLINE),
            "offline": sum(1 for c in cameras if c.status == CameraStatus.OFFLINE),
            "cameras": [
                {
                    "id": str(c.id), "name": c.name,
                    "status": c.status.value if hasattr(c.status, 'value') else str(c.status),
                    "location": c.location,
                }
                for c in cameras
            ],
        }
        _cache_set("get_all_cameras_status", result_data)
        return result_data


async def get_current_detections(camera_id: str) -> dict:
    """Get the latest YOLO detections for a camera."""
    from backend.services.yolo_detector import yolo_detector
    from backend.services.video_capture import capture_manager

    stream = capture_manager.get_stream(camera_id)
    if stream is None or not stream.is_running:
        return {"success": False, "error": "No frame available"}
    latest = stream.get_latest_frame()
    if latest is None:
        return {"success": False, "error": "No frame available"}
    _, frame = latest  # (timestamp, np.ndarray)

    detections = yolo_detector.detect(frame, camera_id)
    return {
        "success": True,
        "camera_id": camera_id,
        "person_count": detections.get("person_count", 0),
        "vehicle_count": detections.get("vehicle_count", 0),
        "total_objects": detections.get("total_objects", 0),
        "active_tracks": detections.get("active_tracks", 0),
        "detections": [
            {
                "class": d.get("class", "unknown"),
                "confidence": round(d.get("confidence", 0), 2),
                "track_id": d.get("track_id"),
                "dwell_time": round(d.get("dwell_time", 0), 1),
                "is_stationary": d.get("is_stationary", False),
                "bbox": d.get("bbox"),
            }
            for d in detections.get("detections", [])
        ],
        "timestamp": time.time(),
    }


async def get_zone_occupancy(zone_id: str) -> dict:
    """Get current occupancy for a specific zone."""
    async with async_session() as db:
        zone = await db.get(Zone, zone_id)
        if not zone:
            return {"success": False, "error": "Zone not found"}
        return {
            "success": True,
            "zone_id": str(zone.id),
            "name": zone.name,
            "zone_type": zone.zone_type,
            "current_occupancy": zone.current_occupancy,
            "max_occupancy": zone.max_occupancy,
            "is_over_capacity": (
                zone.max_occupancy is not None
                and zone.current_occupancy > zone.max_occupancy
            ),
            "alert_on_breach": zone.alert_on_breach,
        }


async def get_all_zones_status() -> dict:
    """Get occupancy and status for all configured zones."""
    cached = _cache_get("get_all_zones_status")
    if cached is not None:
        return cached
    async with async_session() as db:
        result = await db.execute(select(Zone).where(Zone.is_active.is_(True)))
        zones = result.scalars().all()
        result_data = {
            "success": True,
            "total": len(zones),
            "zones": [
                {
                    "id": str(z.id), "name": z.name, "type": z.zone_type,
                    "occupancy": z.current_occupancy,
                    "max": z.max_occupancy,
                    "over_capacity": (
                        z.max_occupancy is not None
                        and z.current_occupancy > z.max_occupancy
                    ),
                }
                for z in zones
            ],
        }
        _cache_set("get_all_zones_status", result_data)
        return result_data


async def analyze_frame_with_gemini(camera_id: str, analysis_prompt: str) -> dict:
    """Send the latest frame to Gemini Flash for custom analysis."""
    from backend.services.gemini_analyzer import gemini_analyzer
    from backend.services.video_capture import capture_manager

    stream = capture_manager.get_stream(camera_id)
    if stream is None or not stream.is_running:
        return {"success": False, "error": "No frame available"}
    latest = stream.get_latest_frame()
    if latest is None:
        return {"success": False, "error": "No frame available"}
    _, frame = latest  # (timestamp, np.ndarray)

    try:
        result = await gemini_analyzer.analyze_frame(
            frame, camera_id=camera_id,
        )
        # Push analysis to WebSocket so frontend overlays can display it
        if result:
            from backend.services.notification_service import notification_service
            await notification_service.push_analysis(camera_id, result)
        return {"success": True, "camera_id": camera_id, "analysis": result}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def analyze_frame_sequence_deep(
    camera_id: str, num_frames: int, analysis_prompt: str
) -> dict:
    """Send a sequence of frames to Gemini Pro for deep temporal analysis."""
    from backend.services.gemini_forensics import gemini_forensics
    from backend.services.video_capture import capture_manager

    frames = []
    stream = capture_manager.get_stream(camera_id)
    if stream and stream.is_running:
        buffer_frames = stream.get_buffer_frames(num_frames)
        for ts, frame_np in buffer_frames:
            import cv2
            ret, buf = cv2.imencode(".jpg", frame_np, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ret:
                frames.append(buf.tobytes())

    if not frames and stream:
        frame_bytes = stream.encode_jpeg()
        if frame_bytes:
            frames = [frame_bytes]

    if not frames:
        return {"success": False, "error": "No frames available"}

    try:
        result = await gemini_forensics.deep_analyze(
            frames, camera_id, prompt=analysis_prompt
        )
        return {
            "success": True,
            "camera_id": camera_id,
            "num_frames_analyzed": len(frames),
            "analysis": result,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════
#  SEARCH & RETRIEVAL TOOLS
# ═══════════════════════════════════════════════════════════════


async def semantic_search_video(
    query: str,
    time_range_minutes: int = 60,
    camera_id: str | None = None,
    max_results: int = 10,
) -> dict:
    """Search indexed video events using natural language via Qdrant."""
    from backend.services.vector_store import vector_store

    try:
        results = await vector_store.search(query, top_k=max_results)
        items = []
        for r in results:
            payload = r.payload if hasattr(r, "payload") else r.get("payload", {})
            items.append({
                "event_id": payload.get("event_id"),
                "score": round(r.score if hasattr(r, "score") else r.get("score", 0), 3),
                "description": payload.get("description"),
                "event_type": payload.get("event_type"),
                "camera_id": payload.get("camera_id"),
                "timestamp": payload.get("timestamp"),
            })
        return {"success": True, "query": query, "results": items}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def similarity_search(event_id: str, max_results: int = 10) -> dict:
    """Find similar events to a given event."""
    from backend.services.vector_store import vector_store

    try:
        results = await vector_store.search_similar_events(
            event_id, top_k=max_results
        )
        items = []
        for r in results:
            payload = r.payload if hasattr(r, "payload") else r.get("payload", {})
            items.append({
                "event_id": payload.get("event_id"),
                "score": round(r.score if hasattr(r, "score") else r.get("score", 0), 3),
                "description": payload.get("description"),
                "event_type": payload.get("event_type"),
            })
        return {"success": True, "results": items}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def search_entity_appearances(
    entity_description: str, time_range_minutes: int = 120
) -> dict:
    """Search for entity appearances matching a description across all cameras."""
    from backend.services.vector_store import vector_store

    try:
        results = await vector_store.search(
            entity_description, top_k=20
        )
        items = []
        for r in results:
            payload = r.payload if hasattr(r, "payload") else r.get("payload", {})
            items.append({
                "event_id": payload.get("event_id"),
                "score": round(r.score if hasattr(r, "score") else r.get("score", 0), 3),
                "description": payload.get("description"),
                "camera_id": payload.get("camera_id"),
                "timestamp": payload.get("timestamp"),
            })
        return {"success": True, "entity": entity_description, "appearances": items}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_event_history(
    camera_id: str | None = None,
    zone_id: str | None = None,
    severity: str | None = None,
    minutes: int = 60,
    limit: int = 50,
) -> dict:
    """Query event history from PostgreSQL with optional filters."""
    async with async_session() as db:
        q = select(Event).order_by(Event.timestamp.desc())
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)
        q = q.where(Event.timestamp >= cutoff)
        if camera_id:
            q = q.where(Event.camera_id == camera_id)
        if zone_id:
            q = q.where(Event.zone_id == zone_id)
        if severity:
            q = q.where(Event.severity == severity)
        q = q.limit(limit)
        result = await db.execute(q)
        events = result.scalars().all()
        return {
            "success": True,
            "count": len(events),
            "events": [
                {
                    "id": str(e.id),
                    "event_type": e.event_type,
                    "description": e.description,
                    "severity": e.severity.value if hasattr(e.severity, 'value') else str(e.severity),
                    "camera_id": str(e.camera_id) if e.camera_id else None,
                    "confidence": e.confidence,
                    "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                }
                for e in events
            ],
        }


async def get_alert_history(
    status: str | None = None,
    severity: str | None = None,
    minutes: int = 60,
    limit: int = 50,
) -> dict:
    """Query alert history from PostgreSQL with optional filters."""
    async with async_session() as db:
        q = select(Alert).order_by(Alert.created_at.desc())
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)
        q = q.where(Alert.created_at >= cutoff)
        if status:
            q = q.where(Alert.status == status)
        if severity:
            q = q.where(Alert.severity == severity)
        q = q.limit(limit)
        result = await db.execute(q)
        alerts = result.scalars().all()
        return {
            "success": True,
            "count": len(alerts),
            "alerts": [
                {
                    "id": str(a.id),
                    "title": a.title,
                    "severity": a.severity.value if hasattr(a.severity, 'value') else str(a.severity),
                    "status": a.status.value if hasattr(a.status, 'value') else str(a.status),
                    "threat_type": a.threat_type,
                    "source_camera": a.source_camera,
                    "confidence": a.confidence,
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                }
                for a in alerts
            ],
        }


async def get_tracking_trajectory(tracking_id: str, camera_id: str) -> dict:
    """Get the full movement trajectory of a tracked entity."""
    from backend.services.yolo_detector import yolo_detector

    tracked = yolo_detector.tracked_objects.get(camera_id, {})
    obj = tracked.get(int(tracking_id) if tracking_id.isdigit() else tracking_id)
    if not obj:
        return {"success": False, "error": "Track not found"}
    return {
        "success": True,
        "track_id": tracking_id,
        "camera_id": camera_id,
        "class": getattr(obj, "class_name", "unknown"),
        "dwell_time": getattr(obj, "dwell_time", 0),
        "is_stationary": getattr(obj, "is_stationary", False),
        "trajectory": getattr(obj, "trajectory", []),
    }


# ═══════════════════════════════════════════════════════════════
#  ALERT & RESPONSE TOOLS
# ═══════════════════════════════════════════════════════════════


async def create_alert(
    camera_id: str,
    severity: str,
    threat_type: str,
    description: str,
    confidence: float,
) -> dict:
    """Create a new security alert."""
    async with async_session() as db:
        sev = AlertSeverity(severity) if severity in [s.value for s in AlertSeverity] else AlertSeverity.MEDIUM
        alert = Alert(
            title=f"{threat_type} detected",
            description=description,
            severity=sev,
            status=AlertStatus.NEW,
            threat_type=threat_type,
            source_camera=camera_id,
            confidence=confidence,
        )
        db.add(alert)
        await db.commit()
        await db.refresh(alert)
        # Push via notification service
        try:
            from backend.services.notification_service import notification_service
            await notification_service.push_alert({
                "id": str(alert.id),
                "title": alert.title,
                "severity": severity,
                "status": "new",
                "source_camera": camera_id,
            })
        except Exception:
            pass
        return {
            "success": True,
            "alert_id": str(alert.id),
            "severity": severity,
            "title": alert.title,
        }


async def escalate_alert(alert_id: str, new_severity: str, reason: str) -> dict:
    """Escalate an existing alert to higher severity."""
    async with async_session() as db:
        alert = await db.get(Alert, alert_id)
        if not alert:
            return {"success": False, "error": "Alert not found"}
        sev = AlertSeverity(new_severity) if new_severity in [s.value for s in AlertSeverity] else alert.severity
        alert.severity = sev
        alert.status = AlertStatus.ESCALATED
        alert.description = (alert.description or "") + f"\n[ESCALATED] {reason}"
        await db.commit()
        return {"success": True, "alert_id": alert_id, "new_severity": new_severity}


async def update_alert_status(
    alert_id: str, status: str, notes: str | None = None
) -> dict:
    """Update alert status."""
    async with async_session() as db:
        alert = await db.get(Alert, alert_id)
        if not alert:
            return {"success": False, "error": "Alert not found"}
        alert.status = AlertStatus(status) if status in [s.value for s in AlertStatus] else alert.status
        if notes:
            alert.resolution_notes = notes
        if status in ("acknowledged",):
            alert.acknowledged_at = datetime.now(timezone.utc)
        if status in ("resolved",):
            alert.resolved_at = datetime.now(timezone.utc)
        await db.commit()
        return {"success": True, "alert_id": alert_id, "status": status}


async def send_notification(
    recipients: str, subject: str, message: str, severity: str
) -> dict:
    """Send notification via WebSocket push."""
    try:
        from backend.services.notification_service import notification_service
        await notification_service.push_notification({
            "subject": subject,
            "message": message,
            "severity": severity,
            "recipients": recipients,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        return {"success": True, "recipients": recipients, "subject": subject}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def trigger_recording(
    camera_id: str, duration_seconds: int = 120, reason: str = ""
) -> dict:
    """Trigger an event-based recording on a camera."""
    try:
        from backend.services.video_recorder import video_recorder
        await video_recorder.record_event_clip(
            camera_id, pre_seconds=10, post_seconds=duration_seconds
        )
        return {
            "success": True,
            "camera_id": camera_id,
            "duration": duration_seconds,
            "reason": reason,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════
#  INVESTIGATION TOOLS
# ═══════════════════════════════════════════════════════════════


async def create_investigation_case(
    title: str, description: str, severity: str
) -> dict:
    """Create a new investigation case."""
    async with async_session() as db:
        sev = AlertSeverity(severity) if severity in [s.value for s in AlertSeverity] else AlertSeverity.MEDIUM
        case = Case(
            title=title,
            description=description,
            status=CaseStatus.OPEN,
            priority=sev,
        )
        db.add(case)
        await db.commit()
        await db.refresh(case)
        return {"success": True, "case_id": str(case.id), "title": title}


async def attach_evidence_to_case(
    case_id: str, evidence_type: str, reference_id: str, description: str
) -> dict:
    """Attach evidence to an investigation case."""
    async with async_session() as db:
        evidence = CaseEvidence(
            case_id=case_id,
            evidence_type=evidence_type,
            reference_id=reference_id,
            title=description[:100],
            content=description,
        )
        db.add(evidence)
        await db.commit()
        return {"success": True, "case_id": case_id, "evidence_type": evidence_type}


async def generate_incident_timeline(
    event_ids: list[str], narrative_prompt: str
) -> dict:
    """Generate a chronological incident timeline from event IDs."""
    async with async_session() as db:
        if not event_ids:
            return {"success": False, "error": "No event IDs provided"}
        result = await db.execute(
            select(Event).where(Event.id.in_(event_ids)).order_by(Event.timestamp)
        )
        events = result.scalars().all()
        timeline = [
            {
                "id": str(e.id),
                "event_type": e.event_type,
                "description": e.description,
                "severity": e.severity.value if hasattr(e.severity, 'value') else str(e.severity),
                "camera_id": str(e.camera_id) if e.camera_id else None,
                "timestamp": e.timestamp.isoformat() if e.timestamp else None,
            }
            for e in events
        ]

        narrative = None
        try:
            from backend.services.gemini_forensics import gemini_forensics
            narrative = await gemini_forensics.generate_incident_summary(
                [e.description or e.event_type for e in events],
                prompt=narrative_prompt,
            )
        except Exception:
            pass

        return {
            "success": True,
            "timeline": timeline,
            "narrative": narrative,
            "event_count": len(timeline),
        }


async def generate_report(
    case_id: str | None = None,
    time_range_hours: int = 24,
    report_type: str = "daily_summary",
) -> dict:
    """Generate a security report."""
    try:
        from backend.services.report_generator import report_generator
        if report_type == "incident" and case_id:
            path = await report_generator.generate_incident_report(case_id)
        else:
            path = await report_generator.generate_daily_summary()
        return {"success": True, "report_path": str(path), "type": report_type}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════
#  ANALYTICS TOOLS
# ═══════════════════════════════════════════════════════════════


async def get_threat_statistics(time_range_hours: int = 24) -> dict:
    """Get aggregated threat statistics."""
    async with async_session() as db:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=time_range_hours)
        # Alerts by severity
        sev_q = await db.execute(
            select(Alert.severity, func.count())
            .where(Alert.created_at >= cutoff)
            .group_by(Alert.severity)
        )
        by_severity = {
            (r[0].value if hasattr(r[0], 'value') else str(r[0])): r[1]
            for r in sev_q.all()
        }
        # Total
        total_q = await db.execute(
            select(func.count()).select_from(Alert).where(Alert.created_at >= cutoff)
        )
        total = total_q.scalar() or 0
        return {
            "success": True,
            "time_range_hours": time_range_hours,
            "total_alerts": total,
            "by_severity": by_severity,
        }


async def get_occupancy_trends(
    zone_id: str | None = None, hours: int = 24
) -> dict:
    """Get occupancy trends over time."""
    async with async_session() as db:
        q = select(Zone).where(Zone.is_active.is_(True))
        if zone_id:
            q = q.where(Zone.id == zone_id)
        result = await db.execute(q)
        zones = result.scalars().all()
        return {
            "success": True,
            "zones": [
                {
                    "id": str(z.id), "name": z.name,
                    "current": z.current_occupancy,
                    "max": z.max_occupancy,
                }
                for z in zones
            ],
        }


async def get_activity_baseline(
    camera_id: str, day_of_week: int | None = None, hour: int | None = None
) -> dict:
    """Get learned activity baseline for a camera at a specific time."""
    from backend.agents.agent_memory import agent_memory

    memories = await agent_memory.recall_knowledge(
        agent_name="anomaly_detector",
        category="baseline",
        camera_id=camera_id,
        limit=5,
    )
    now = datetime.now()
    return {
        "success": True,
        "camera_id": camera_id,
        "day_of_week": day_of_week or now.weekday(),
        "hour": hour or now.hour,
        "baselines": memories,
    }


# ═══════════════════════════════════════════════════════════════
#  MEMORY & KNOWLEDGE TOOLS
# ═══════════════════════════════════════════════════════════════


async def store_observation(
    observation: str, category: str, camera_id: str | None = None
) -> dict:
    """Store a learned observation in long-term memory."""
    from backend.agents.agent_memory import agent_memory

    await agent_memory.learn(
        agent_name="shared",
        content=observation,
        category=category,
        camera_id=camera_id,
    )
    return {"success": True, "category": category, "stored": observation[:100]}


async def recall_observations(category: str, limit: int = 10) -> dict:
    """Recall stored observations from long-term memory."""
    from backend.agents.agent_memory import agent_memory

    memories = await agent_memory.recall_knowledge(
        agent_name="shared", category=category, limit=limit
    )
    return {"success": True, "category": category, "observations": memories}


async def get_site_context() -> dict:
    """Get the current site context: time, day, operating status."""
    cached = _cache_get("get_site_context")
    if cached is not None:
        return cached
    now = datetime.now()
    hour = now.hour
    if 6 <= hour < 18:
        period = "daytime"
    elif 18 <= hour < 22:
        period = "evening"
    else:
        period = "nighttime"

    business_hours = 8 <= hour < 18 and now.weekday() < 5
    result_data = {
        "success": True,
        "datetime": now.isoformat(),
        "day_of_week": now.strftime("%A"),
        "hour": hour,
        "period": period,
        "business_hours": business_hours,
        "is_weekend": now.weekday() >= 5,
    }
    _cache_set("get_site_context", result_data)
    return result_data


# ═══════════════════════════════════════════════════════════════
#  TIER 2 TOOLS — Threat Intel, Vehicle Analytics, Incident Replay
# ═══════════════════════════════════════════════════════════════


async def get_threat_intel_context() -> dict:
    """Get active threat intelligence context for agent reasoning."""
    cached = _cache_get("get_threat_intel_context")
    if cached is not None:
        return cached
    try:
        from backend.services.threat_intel_service import threat_intel_service
        context = await threat_intel_service.get_active_context()
        summary = await threat_intel_service.get_contextual_summary()
        result_data = {
            "success": True,
            "active_threats": context.get("threats", [])[:5],
            "weather_warnings": context.get("weather_warnings", []),
            "nearby_events": context.get("nearby_events", []),
            "threshold_adjustments": context.get("threshold_adjustments", {}),
            "total_active": context.get("total_active", 0),
            "summary": summary,
        }
        _cache_set("get_threat_intel_context", result_data)
        return result_data
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_vehicle_analytics(zone_id: str = "") -> dict:
    """Get vehicle analytics summary."""
    try:
        from backend.services.vehicle_analytics_service import vehicle_analytics_service
        return await vehicle_analytics_service.get_vehicle_flow_analytics(zone_id=zone_id or None)
    except Exception as e:
        return {"success": False, "error": str(e)}


async def check_vehicle_violations(plate_text: str) -> dict:
    """Check vehicle violations by plate."""
    try:
        from backend.services.vehicle_analytics_service import vehicle_analytics_service
        return await vehicle_analytics_service.get_vehicle_violations(plate_text)
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_loading_dock_status(zone_id: str) -> dict:
    """Get loading dock status for a zone."""
    try:
        from backend.services.vehicle_analytics_service import vehicle_analytics_service
        return await vehicle_analytics_service.get_loading_dock_status(zone_id)
    except Exception as e:
        return {"success": False, "error": str(e)}


async def start_incident_recording(title: str, camera_ids: list = None, alert_id: str = None) -> dict:
    """Start recording an incident."""
    try:
        from backend.services.incident_recorder import incident_recorder
        incident_id = await incident_recorder.start_recording(
            title=title, camera_ids=camera_ids or [], alert_id=alert_id,
        )
        return {"success": True, "incident_id": incident_id}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def stop_incident_recording(incident_id: str) -> dict:
    """Stop an active incident recording."""
    try:
        from backend.services.incident_recorder import incident_recorder
        result = await incident_recorder.stop_recording(incident_id)
        return {"success": True, **result}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════
#  PHASE 2 TOOLS — Crowd Flow, Sensory Fusion, Entity Path, Companions
# ═══════════════════════════════════════════════════════════════


async def get_crowd_flow_analysis(camera_id: str) -> dict:
    """Get real-time crowd flow analysis for a camera."""
    try:
        from backend.services.crowd_analytics import crowd_flow_analyzer
        from backend.services.yolo_detector import yolo_detector

        tracked = yolo_detector.get_tracked_objects(camera_id)
        if not tracked:
            return {"success": True, "camera_id": camera_id, "sentiment": "calm", "person_count": 0}

        result = crowd_flow_analyzer.analyze_from_tracked_objects(tracked)
        return {
            "success": True,
            "camera_id": camera_id,
            "sentiment": result.sentiment,
            "person_count": sum(fv.person_count for fv in result.flow_vectors),
            "avg_speed": result.avg_speed,
            "max_speed": result.max_speed,
            "density": result.density,
            "panic_detected": result.panic_detected,
            "panic_score": result.panic_score,
            "hostile_detected": result.hostile_detected,
            "hostile_score": result.hostile_score,
            "stampede_risk": result.stampede_risk,
            "directional_alignment": result.directional_alignment,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def verify_sensory_fusion(audio_type: str, camera_id: str) -> dict:
    """Cross-modal verification of audio + visual events."""
    try:
        from backend.services.sensory_fusion import sensory_fusion_engine, SensoryEvent

        audio_event = SensoryEvent(
            modality="audio",
            event_type=audio_type,
            camera_id=camera_id,
            confidence=0.8,
        )
        fused = sensory_fusion_engine.verify_cross_modal(audio_event)
        return {
            "success": True,
            "audio_type": audio_type,
            "camera_id": camera_id,
            "verification_status": fused.verification_status,
            "fused_confidence": fused.fused_confidence,
            "matched_visual": fused.matched_visual_type,
            "fusion_rule": fused.fusion_rule,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_entity_path(entity_description: str) -> dict:
    """Search for entity appearances across cameras via Qdrant."""
    try:
        from backend.services.vector_store import vector_store

        results = await vector_store.search(entity_description, top_k=15)
        path_points = []
        for r in results:
            payload = r.payload if hasattr(r, "payload") else r.get("payload", {})
            score = r.score if hasattr(r, "score") else r.get("score", 0)
            if score > 0.5:
                path_points.append({
                    "camera_id": payload.get("camera_id", ""),
                    "timestamp": payload.get("timestamp", ""),
                    "description": payload.get("description", ""),
                    "score": round(score, 3),
                })

        # Sort by timestamp
        path_points.sort(key=lambda p: p.get("timestamp", ""))

        return {
            "success": True,
            "entity": entity_description,
            "path_length": len(path_points),
            "path": path_points,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def get_companion_links(camera_id: str = "", min_sync_score: float = 0.0) -> dict:
    """Get recently discovered companion links from the database."""
    try:
        from backend.models.phase2_models import CompanionLink
        from sqlalchemy import select, desc

        async with async_session() as db:
            stmt = select(CompanionLink).order_by(desc(CompanionLink.created_at)).limit(50)
            if camera_id:
                stmt = stmt.where(CompanionLink.camera_id == camera_id)
            if min_sync_score > 0:
                stmt = stmt.where(CompanionLink.behavioral_sync_score >= min_sync_score)
            result = await db.execute(stmt)
            links = result.scalars().all()
            return {
                "success": True,
                "count": len(links),
                "links": [
                    {
                        "id": str(l.id),
                        "track_a": l.entity_a_track_id,
                        "track_b": l.entity_b_track_id,
                        "camera_id": l.camera_id,
                        "proximity_duration_s": l.proximity_duration_seconds,
                        "sync_score": l.behavioral_sync_score,
                        "link_type": l.link_type,
                        "created_at": l.created_at.isoformat() if l.created_at else None,
                    }
                    for l in links
                ],
            }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════
#  TOOL REGISTRY — Maps tool names to functions + Gemini schemas
# ═══════════════════════════════════════════════════════════════

# All tools with their metadata for Gemini function declarations
TOOL_REGISTRY: dict[str, dict] = {
    "capture_frame": {
        "fn": capture_frame,
        "description": "Capture a single frame from a camera. Returns metadata.",
        "parameters": {"camera_id": {"type": "string", "description": "Camera UUID"}},
        "required": ["camera_id"],
    },
    "get_camera_status": {
        "fn": get_camera_status,
        "description": "Get current status of a camera.",
        "parameters": {"camera_id": {"type": "string", "description": "Camera UUID"}},
        "required": ["camera_id"],
    },
    "get_all_cameras_status": {
        "fn": get_all_cameras_status,
        "description": "Get status summary of all connected cameras.",
        "parameters": {},
        "required": [],
    },
    "get_current_detections": {
        "fn": get_current_detections,
        "description": "Get latest YOLO detections for a camera.",
        "parameters": {"camera_id": {"type": "string", "description": "Camera UUID"}},
        "required": ["camera_id"],
    },
    "get_zone_occupancy": {
        "fn": get_zone_occupancy,
        "description": "Get current occupancy for a zone.",
        "parameters": {"zone_id": {"type": "string", "description": "Zone UUID"}},
        "required": ["zone_id"],
    },
    "get_all_zones_status": {
        "fn": get_all_zones_status,
        "description": "Get occupancy and status for all zones.",
        "parameters": {},
        "required": [],
    },
    "analyze_frame_with_gemini": {
        "fn": analyze_frame_with_gemini,
        "description": "Send latest frame from a camera to Gemini Flash for analysis.",
        "parameters": {
            "camera_id": {"type": "string", "description": "Camera UUID"},
            "analysis_prompt": {"type": "string", "description": "Analysis instructions"},
        },
        "required": ["camera_id", "analysis_prompt"],
    },
    "analyze_frame_sequence_deep": {
        "fn": analyze_frame_sequence_deep,
        "description": "Send frame sequence to Gemini Pro for deep analysis.",
        "parameters": {
            "camera_id": {"type": "string", "description": "Camera UUID"},
            "num_frames": {"type": "integer", "description": "Number of frames"},
            "analysis_prompt": {"type": "string", "description": "Analysis prompt"},
        },
        "required": ["camera_id", "num_frames", "analysis_prompt"],
    },
    "semantic_search_video": {
        "fn": semantic_search_video,
        "description": "Search indexed video events using natural language.",
        "parameters": {
            "query": {"type": "string", "description": "Search query"},
            "time_range_minutes": {"type": "integer", "description": "Time range in minutes"},
            "max_results": {"type": "integer", "description": "Max results to return"},
        },
        "required": ["query"],
    },
    "similarity_search": {
        "fn": similarity_search,
        "description": "Find similar events to a given event.",
        "parameters": {
            "event_id": {"type": "string", "description": "Event UUID"},
            "max_results": {"type": "integer", "description": "Max results"},
        },
        "required": ["event_id"],
    },
    "search_entity_appearances": {
        "fn": search_entity_appearances,
        "description": "Search for entity appearances across all cameras.",
        "parameters": {
            "entity_description": {"type": "string", "description": "Entity description"},
            "time_range_minutes": {"type": "integer", "description": "Time range"},
        },
        "required": ["entity_description"],
    },
    "get_event_history": {
        "fn": get_event_history,
        "description": "Query event history with optional filters.",
        "parameters": {
            "camera_id": {"type": "string", "description": "Filter by camera"},
            "severity": {"type": "string", "description": "Filter by severity"},
            "minutes": {"type": "integer", "description": "Time range in minutes"},
            "limit": {"type": "integer", "description": "Max results"},
        },
        "required": [],
    },
    "get_alert_history": {
        "fn": get_alert_history,
        "description": "Query alert history with optional filters.",
        "parameters": {
            "status": {"type": "string", "description": "Filter by status"},
            "severity": {"type": "string", "description": "Filter by severity"},
            "minutes": {"type": "integer", "description": "Time range in minutes"},
            "limit": {"type": "integer", "description": "Max results"},
        },
        "required": [],
    },
    "get_tracking_trajectory": {
        "fn": get_tracking_trajectory,
        "description": "Get movement trajectory of a tracked entity.",
        "parameters": {
            "tracking_id": {"type": "string", "description": "Track ID"},
            "camera_id": {"type": "string", "description": "Camera UUID"},
        },
        "required": ["tracking_id", "camera_id"],
    },
    "create_alert": {
        "fn": create_alert,
        "description": "Create a new security alert.",
        "parameters": {
            "camera_id": {"type": "string", "description": "Source camera"},
            "severity": {"type": "string", "description": "Alert severity"},
            "threat_type": {"type": "string", "description": "Type of threat"},
            "description": {"type": "string", "description": "Alert description"},
            "confidence": {"type": "number", "description": "Confidence 0-1"},
        },
        "required": ["camera_id", "severity", "threat_type", "description", "confidence"],
    },
    "escalate_alert": {
        "fn": escalate_alert,
        "description": "Escalate an alert to higher severity.",
        "parameters": {
            "alert_id": {"type": "string", "description": "Alert UUID"},
            "new_severity": {"type": "string", "description": "New severity level"},
            "reason": {"type": "string", "description": "Escalation reason"},
        },
        "required": ["alert_id", "new_severity", "reason"],
    },
    "update_alert_status": {
        "fn": update_alert_status,
        "description": "Update an alert's status.",
        "parameters": {
            "alert_id": {"type": "string", "description": "Alert UUID"},
            "status": {"type": "string", "description": "New status"},
            "notes": {"type": "string", "description": "Optional notes"},
        },
        "required": ["alert_id", "status"],
    },
    "send_notification": {
        "fn": send_notification,
        "description": "Send notification to operators.",
        "parameters": {
            "recipients": {"type": "string", "description": "Recipient list"},
            "subject": {"type": "string", "description": "Notification subject"},
            "message": {"type": "string", "description": "Message body"},
            "severity": {"type": "string", "description": "Severity level"},
        },
        "required": ["recipients", "subject", "message", "severity"],
    },
    "trigger_recording": {
        "fn": trigger_recording,
        "description": "Start event recording on a camera.",
        "parameters": {
            "camera_id": {"type": "string", "description": "Camera UUID"},
            "duration_seconds": {"type": "integer", "description": "Recording duration"},
            "reason": {"type": "string", "description": "Recording reason"},
        },
        "required": ["camera_id"],
    },
    "create_investigation_case": {
        "fn": create_investigation_case,
        "description": "Create a new investigation case.",
        "parameters": {
            "title": {"type": "string", "description": "Case title"},
            "description": {"type": "string", "description": "Case description"},
            "severity": {"type": "string", "description": "Case severity"},
        },
        "required": ["title", "description", "severity"],
    },
    "attach_evidence_to_case": {
        "fn": attach_evidence_to_case,
        "description": "Attach evidence to a case.",
        "parameters": {
            "case_id": {"type": "string", "description": "Case UUID"},
            "evidence_type": {"type": "string", "description": "Evidence type"},
            "reference_id": {"type": "string", "description": "Reference ID"},
            "description": {"type": "string", "description": "Evidence description"},
        },
        "required": ["case_id", "evidence_type", "reference_id", "description"],
    },
    "generate_incident_timeline": {
        "fn": generate_incident_timeline,
        "description": "Generate incident timeline from event IDs.",
        "parameters": {
            "event_ids": {"type": "array", "items": {"type": "string"}, "description": "Event UUIDs"},
            "narrative_prompt": {"type": "string", "description": "Narrative prompt"},
        },
        "required": ["event_ids", "narrative_prompt"],
    },
    "generate_report": {
        "fn": generate_report,
        "description": "Generate a security report.",
        "parameters": {
            "case_id": {"type": "string", "description": "Case UUID (for incident reports)"},
            "time_range_hours": {"type": "integer", "description": "Time range"},
            "report_type": {"type": "string", "description": "Report type"},
        },
        "required": [],
    },
    "get_threat_statistics": {
        "fn": get_threat_statistics,
        "description": "Get aggregated threat statistics.",
        "parameters": {
            "time_range_hours": {"type": "integer", "description": "Time range in hours"},
        },
        "required": [],
    },
    "get_occupancy_trends": {
        "fn": get_occupancy_trends,
        "description": "Get occupancy trends over time.",
        "parameters": {
            "zone_id": {"type": "string", "description": "Zone UUID"},
            "hours": {"type": "integer", "description": "Time range in hours"},
        },
        "required": [],
    },
    "get_activity_baseline": {
        "fn": get_activity_baseline,
        "description": "Get learned activity baseline for a camera.",
        "parameters": {
            "camera_id": {"type": "string", "description": "Camera UUID"},
            "day_of_week": {"type": "integer", "description": "Day (0=Mon)"},
            "hour": {"type": "integer", "description": "Hour (0-23)"},
        },
        "required": ["camera_id"],
    },
    "store_observation": {
        "fn": store_observation,
        "description": "Store a learned observation in long-term memory.",
        "parameters": {
            "observation": {"type": "string", "description": "Observation text"},
            "category": {"type": "string", "description": "Category (baseline/pattern/observation)"},
            "camera_id": {"type": "string", "description": "Associated camera UUID"},
        },
        "required": ["observation", "category"],
    },
    "recall_observations": {
        "fn": recall_observations,
        "description": "Recall stored observations by category.",
        "parameters": {
            "category": {"type": "string", "description": "Category to recall"},
            "limit": {"type": "integer", "description": "Max results"},
        },
        "required": ["category"],
    },
    "get_site_context": {
        "fn": get_site_context,
        "description": "Get current site context: time, day, operating status.",
        "parameters": {},
        "required": [],
    },
    "get_threat_intel_context": {
        "fn": get_threat_intel_context,
        "description": "Get active threat intelligence context including external threats, weather warnings, nearby events, and threshold adjustments for agent reasoning.",
        "parameters": {},
        "required": [],
    },
    "get_vehicle_analytics": {
        "fn": get_vehicle_analytics,
        "description": "Get vehicle analytics summary for a zone or all zones. Returns flow patterns, violation counts, and active vehicles.",
        "parameters": {
            "zone_id": {"type": "string", "description": "Zone UUID (optional, omit for all zones)"},
        },
        "required": [],
    },
    "check_vehicle_violations": {
        "fn": check_vehicle_violations,
        "description": "Check if a vehicle plate has any violations (parking, wrong-way, loitering).",
        "parameters": {
            "plate_text": {"type": "string", "description": "Vehicle plate number"},
        },
        "required": ["plate_text"],
    },
    "get_loading_dock_status": {
        "fn": get_loading_dock_status,
        "description": "Get current loading dock occupancy and dwell analytics for a zone.",
        "parameters": {
            "zone_id": {"type": "string", "description": "Zone UUID"},
        },
        "required": ["zone_id"],
    },
    "start_incident_recording": {
        "fn": start_incident_recording,
        "description": "Start recording an incident for later replay. Captures frames, detections, and agent decisions.",
        "parameters": {
            "title": {"type": "string", "description": "Incident title"},
            "camera_ids": {"type": "array", "description": "Camera UUIDs to record", "items": {"type": "string"}},
            "alert_id": {"type": "string", "description": "Trigger alert UUID (optional)"},
        },
        "required": ["title"],
    },
    "stop_incident_recording": {
        "fn": stop_incident_recording,
        "description": "Stop an active incident recording.",
        "parameters": {
            "incident_id": {"type": "string", "description": "Incident UUID"},
        },
        "required": ["incident_id"],
    },
    "get_crowd_flow_analysis": {
        "fn": get_crowd_flow_analysis,
        "description": "Get real-time crowd flow analysis for a camera including sentiment, density, panic/hostile scores, and stampede risk.",
        "parameters": {
            "camera_id": {"type": "string", "description": "Camera UUID"},
        },
        "required": ["camera_id"],
    },
    "verify_sensory_fusion": {
        "fn": verify_sensory_fusion,
        "description": "Cross-modal verification: check if audio events correlate with visual detections for fusion confirmation.",
        "parameters": {
            "audio_type": {"type": "string", "description": "Audio event type (gunshot, glass_breaking, scream, explosion)"},
            "camera_id": {"type": "string", "description": "Camera UUID where audio was detected"},
        },
        "required": ["audio_type", "camera_id"],
    },
    "get_entity_path": {
        "fn": get_entity_path,
        "description": "Get cross-camera movement path for a tracked entity from the Ghost Tracer agent.",
        "parameters": {
            "entity_description": {"type": "string", "description": "Description of the entity to trace"},
        },
        "required": ["entity_description"],
    },
    "get_companion_links": {
        "fn": get_companion_links,
        "description": "Get recently discovered companion (co-moving) entity pairs from the database.",
        "parameters": {
            "camera_id": {"type": "string", "description": "Optional camera UUID filter"},
            "min_sync_score": {"type": "number", "description": "Minimum behavioral sync score (0-1)"},
        },
        "required": [],
    },
}

# Tool subsets per agent tier/role
PERCEPTION_TOOLS = [
    "capture_frame", "get_camera_status", "get_all_cameras_status",
    "get_current_detections", "get_zone_occupancy", "get_all_zones_status",
    "analyze_frame_with_gemini", "get_site_context", "store_observation",
    "recall_observations", "get_threat_intel_context", "get_vehicle_analytics",
    "get_crowd_flow_analysis",
]

REASONING_TOOLS = [
    "analyze_frame_sequence_deep", "semantic_search_video", "similarity_search",
    "search_entity_appearances", "get_event_history", "get_alert_history",
    "get_tracking_trajectory", "get_current_detections", "get_site_context",
    "create_alert", "escalate_alert", "recall_observations", "store_observation",
    "get_threat_statistics", "get_occupancy_trends", "get_activity_baseline",
    "analyze_frame_with_gemini", "get_threat_intel_context",
    "get_vehicle_analytics", "check_vehicle_violations", "get_loading_dock_status",
    "get_crowd_flow_analysis", "verify_sensory_fusion", "get_entity_path",
    "get_companion_links",
]

ACTION_TOOLS = [
    "create_alert", "escalate_alert", "update_alert_status", "send_notification",
    "trigger_recording", "create_investigation_case", "attach_evidence_to_case",
    "generate_incident_timeline", "generate_report", "get_alert_history",
    "get_event_history", "get_threat_statistics",
    "start_incident_recording", "stop_incident_recording",
]

SUPERVISOR_TOOLS = list(TOOL_REGISTRY.keys())  # Full access


def get_tools_for_agent(tool_names: list[str]) -> dict[str, dict]:
    """Get tool definitions for a specific set of tool names."""
    return {name: TOOL_REGISTRY[name] for name in tool_names if name in TOOL_REGISTRY}
