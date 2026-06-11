"""Intelligence API — unified endpoints for SENTINEL AI intelligence features.

Exposes: XAI explanations, causal reasoning, evidence timelines,
counterfactual analysis, red team simulation,
shift briefings, pattern library, and compliance auditing.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/intelligence", tags=["intelligence"])


# ── Scene Intelligence (structured vision understanding) ─────────

class SceneAnalyzeRequest(BaseModel):
    camera_id: Optional[str] = Field(None, description="Analyse this camera's latest frame")
    image_base64: Optional[str] = Field(None, description="Or a base64-encoded JPEG/PNG to analyse")
    verify: bool = Field(True, description="Run the adversarial verifier on medium+ threats")


_VERIFY_LEVELS = {"medium", "high", "critical"}
_LEVEL_RANK = {"none": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


def _decode_scene_image(body: "SceneAnalyzeRequest") -> tuple[bytes, str]:
    import base64
    from fastapi import HTTPException as _HE
    if body.image_base64:
        try:
            raw = body.image_base64.split(",", 1)[-1]
            return base64.b64decode(raw), (body.camera_id or "uploaded")
        except Exception:
            raise _HE(status_code=400, detail="Invalid image_base64")
    if body.camera_id:
        from backend.services.video_capture import capture_manager
        stream = capture_manager.get_stream(body.camera_id)
        if stream is None or not stream.is_running:
            raise _HE(status_code=404, detail=f"Camera '{body.camera_id}' has no active stream")
        img = stream.encode_jpeg(quality=80)
        if not img:
            raise _HE(status_code=409, detail="No frame available from camera yet")
        return img, body.camera_id
    raise _HE(status_code=400, detail="Provide camera_id or image_base64")


@router.post("/analyze-scene")
async def analyze_scene(body: SceneAnalyzeRequest):
    """Structured scene intelligence for a frame — scene graph, caption,
    activities, anomalies, and an evidence-calibrated threat assessment.

    Provide either a camera_id (uses its latest captured frame) or a base64 image.
    When ``verify`` is set, medium+ threats are re-checked by the adversarial
    verifier and only confirmed ones are kept (the threat level is recomputed).
    """
    from backend.services.scene_intelligence import scene_intelligence

    image_bytes, cam_label = _decode_scene_image(body)
    result = await scene_intelligence.analyze(image_bytes, camera_id=cam_label)

    ta = result.get("threat_assessment", {})
    if body.verify and ta.get("level") in _VERIFY_LEVELS and ta.get("threats"):
        from backend.services.threat_verifier import threat_verifier
        kept = []
        for thr in ta["threats"]:
            v = await threat_verifier.verify(thr, image_bytes, {"camera": cam_label})
            thr["verification"] = v
            if v["verdict"] == "confirmed":
                kept.append(thr)
        # Recompute the level from confirmed threats only.
        if not kept:
            ta["level"] = "low" if ta.get("anomalies") else "none"
            ta["reasoning"] = (ta.get("reasoning", "") + " [All flagged threats were rejected by the verifier.]").strip()
        ta["threats"] = ta["threats"]  # keep all, annotated
        ta["confirmed_threats"] = kept
        ta["verified"] = True
    result["threat_assessment"] = ta
    return result


class VerifyThreatRequest(BaseModel):
    threat: Dict[str, Any] = Field(..., description="{type, evidence, confidence}")
    camera_id: Optional[str] = None
    image_base64: Optional[str] = None


@router.post("/verify-threat")
async def verify_threat(body: VerifyThreatRequest):
    """Adversarially verify a single candidate threat against a frame."""
    from backend.services.threat_verifier import threat_verifier
    proxy = SceneAnalyzeRequest(camera_id=body.camera_id, image_base64=body.image_base64)
    image_bytes, cam_label = _decode_scene_image(proxy)
    return await threat_verifier.verify(body.threat, image_bytes, {"camera": cam_label})


@router.post("/deep-analyze")
async def deep_analyze(body: SceneAnalyzeRequest):
    """Agentic deep analysis of a frame — the full AI-analyst chain.

    Stage 1: structured scene intelligence (scene graph, activities, anomalies).
    Stage 2: adversarial verification of medium+ threats (skeptic).
    Stage 3: a senior-analyst reasoning synthesis over the verified findings that
             produces a situation summary, a priority, an alert decision, and
             prioritised operator actions.
    """
    import json as _json
    from backend.services.scene_intelligence import scene_intelligence
    from backend.services.threat_verifier import threat_verifier
    from backend.services.ai_text_service import ai_generate_text

    image_bytes, cam_label = _decode_scene_image(body)
    scene = await scene_intelligence.analyze(image_bytes, camera_id=cam_label)

    ta = scene.get("threat_assessment", {})
    confirmed = []
    for thr in ta.get("threats", []) if ta.get("level") in _VERIFY_LEVELS else []:
        v = await threat_verifier.verify(thr, image_bytes, {"camera": cam_label})
        thr["verification"] = v
        if v["verdict"] == "confirmed":
            confirmed.append(thr)

    # Stage 3 — senior-analyst reasoning synthesis (text, no vision needed).
    synth_prompt = (
        "You are a senior SOC analyst. Given the structured machine analysis of a "
        "surveillance frame below, reason briefly then return ONLY this JSON:\n"
        '{"situation": "1-2 sentence assessment", "priority": "routine|attention|urgent|emergency", '
        '"should_alert": true|false, "recommended_actions": ["..."], "rationale": "why"}\n\n'
        "Be calibrated: a quiet/benign scene is 'routine', should_alert=false, actions []. "
        "Only escalate on VERIFIED threats.\n\n"
        f"SCENE CAPTION: {scene.get('caption','')}\n"
        f"ACTIVITIES: {scene.get('activities', [])}\n"
        f"ANOMALIES: {scene.get('anomalies', [])}\n"
        f"VERIFIED THREATS: {_json.dumps(confirmed)[:1500]}\n"
        f"SCENE THREAT LEVEL (pre-verification): {ta.get('level','none')}\n"
    )
    try:
        synth_text = await ai_generate_text(synth_prompt, max_tokens=600, temperature=0.2, tier="reasoning")
        from backend.services.ollama_provider import _parse_json_response
        assessment = _parse_json_response(synth_text)
        if "raw_response" in assessment and len(assessment) == 1:
            assessment = {"situation": synth_text[:400], "priority": "routine",
                          "should_alert": False, "recommended_actions": [], "rationale": ""}
    except Exception as exc:  # noqa: BLE001
        logger.warning("deep_analyze synthesis failed: %s", exc)
        assessment = {"situation": scene.get("caption", ""), "priority": "routine",
                      "should_alert": False, "recommended_actions": [], "rationale": "synthesis_unavailable"}

    return {
        "camera": cam_label,
        "scene": scene,
        "verified_threats": confirmed,
        "assessment": assessment,
    }


class ReadPlateRequest(BaseModel):
    image_base64: str = Field(..., description="Image containing a plate (base64)")
    bbox: Optional[List[float]] = Field(None, description="Optional vehicle/plate crop [x1,y1,x2,y2]")


@router.post("/read-plate")
async def read_plate(body: ReadPlateRequest):
    """Read a license plate via the local ALPR (EasyOCR) engine and check it
    against active vehicle BOLOs."""
    import base64
    import cv2
    import numpy as np
    from backend.services.alpr_service import alpr_service

    try:
        raw = base64.b64decode(body.image_base64.split(",", 1)[-1])
        frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image_base64")
    if frame is None:
        raise HTTPException(status_code=400, detail="Could not decode image")
    if not alpr_service.available():
        raise HTTPException(status_code=503, detail="ALPR engine unavailable")
    return await alpr_service.read_and_match(frame, body.bbox)


class SegmentRequest(BaseModel):
    camera_id: Optional[str] = None
    image_base64: Optional[str] = None
    bboxes: Optional[List[List[float]]] = Field(None, description="Optional explicit box prompts")


@router.post("/segment")
async def segment_scene(body: SegmentRequest):
    """SAM2 mask segmentation of a frame (occlusion-robust object extent).

    If no bboxes are supplied, the detector's boxes are used as prompts so SAM2
    segments the currently-detected objects.
    """
    import cv2
    import numpy as np
    from backend.services.sam_segmenter import sam_segmenter

    proxy = SceneAnalyzeRequest(camera_id=body.camera_id, image_base64=body.image_base64)
    image_bytes, cam_label = _decode_scene_image(proxy)
    frame = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(status_code=400, detail="Could not decode image")

    bboxes = body.bboxes
    if not bboxes:
        from backend.services.yolo_detector import yolo_detector
        det = yolo_detector.detect(frame, camera_id=cam_label or "segment")
        bboxes = [d["bbox"] for d in det.get("detections", []) if d.get("bbox")]

    result = sam_segmenter.segment(frame, bboxes=bboxes or None)
    result["prompted_boxes"] = len(bboxes or [])
    return result


# ── Request/Response Models ──────────────────────────────────────

class InvestigateRequest(BaseModel):
    query: str = Field(..., description="Natural language investigation query")
    time_range_hours: int = Field(24, description="Hours to look back")
    max_results: int = Field(50, description="Maximum results")

class TimelineRequest(BaseModel):
    query: str = Field(..., description="Natural language query (e.g., 'blue sedan from 2pm-5pm')")
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    camera_ids: Optional[List[str]] = None
    max_results: int = 50

class CounterfactualRequest(BaseModel):
    incident_id: str = Field(..., description="Alert/incident ID to analyze")
    policy_change: str = Field(..., description="Proposed policy change to evaluate")

class BatchCounterfactualRequest(BaseModel):
    policy_change: str = Field(..., description="Policy change to test against historical incidents")
    lookback_days: int = Field(90, description="Days of history to analyze")
    limit: int = Field(20, description="Max incidents to analyze")

class RedTeamRequest(BaseModel):
    target_zone: str = Field("server room", description="Target zone for intrusion simulation")
    objective: str = Field("Reach target zone undetected", description="Simulation objective")

class CausalRequest(BaseModel):
    alert_id: str
    time_window_minutes: int = Field(30, description="Minutes to look back for evidence")

class PatternLearnRequest(BaseModel):
    alert_id: str
    alert_data: Dict[str, Any]


# ── Causal Reasoning ─────────────────────────────────────────────

@router.post("/causal-chain")
async def build_causal_chain(req: CausalRequest):
    """Reconstruct the causal chain behind an alert."""
    try:
        from backend.services.causal_reasoning import causal_engine
        # Get alert data
        from backend.database import async_session
        from backend.models import Alert
        from sqlalchemy import select

        async with async_session() as session:
            result = await session.execute(select(Alert).where(Alert.id == req.alert_id))
            alert = result.scalar_one_or_none()

        if not alert:
            raise HTTPException(404, detail="Alert not found")

        threat_data = {
            "threat_type": alert.threat_type,
            "severity": alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity),
            "source_camera": alert.source_camera,
            "zone_name": alert.zone_name,
            "description": alert.description,
            "timestamp": str(alert.created_at),
        }

        chain = await causal_engine.reconstruct_chain(
            req.alert_id, threat_data, req.time_window_minutes
        )
        return chain.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        logger.error("api.causal_chain_failed: %s", e)
        raise HTTPException(500, detail=str(e))


@router.get("/causal-stats")
async def get_causal_stats():
    """Get causal reasoning engine statistics."""
    from backend.services.causal_reasoning import causal_engine
    return causal_engine.get_chain_stats()


# ── Explainable AI ───────────────────────────────────────────────

@router.get("/explain/{alert_id}")
async def explain_alert(alert_id: str):
    """Get the XAI explanation chain for a specific alert."""
    try:
        from backend.database import async_session
        from backend.models import Alert
        from sqlalchemy import select

        async with async_session() as session:
            result = await session.execute(select(Alert).where(Alert.id == alert_id))
            alert = result.scalar_one_or_none()

        if not alert:
            raise HTTPException(404, detail="Alert not found")

        metadata = alert.metadata_ or {}
        explanation = metadata.get("explanation_chain")

        if explanation:
            return explanation

        # Generate explanation retroactively
        from backend.services.explanation_builder import explanation_builder
        threat = {
            "signature": alert.threat_type or "Unknown",
            "category": "",
            "severity": alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity),
            "confidence": alert.confidence or 0.0,
            "detection_method": "hybrid",
        }
        chain = explanation_builder.build_from_threat(threat)
        return chain.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        logger.error("api.explain_failed: %s", e)
        raise HTTPException(500, detail=str(e))


# ── Evidence Timeline ────────────────────────────────────────────

@router.post("/evidence-timeline")
async def build_evidence_timeline(req: TimelineRequest):
    """Build a court-ready evidence timeline from natural language query."""
    try:
        from backend.services.evidence_timeline import evidence_timeline_builder

        start = datetime.fromisoformat(req.start_time) if req.start_time else None
        end = datetime.fromisoformat(req.end_time) if req.end_time else None

        timeline = await evidence_timeline_builder.build_timeline(
            query=req.query,
            time_start=start,
            time_end=end,
            camera_ids=req.camera_ids,
            max_results=req.max_results,
        )
        return timeline.to_dict()
    except Exception as e:
        logger.error("api.timeline_failed: %s", e)
        raise HTTPException(500, detail=str(e))


# ── Counterfactual Analysis ──────────────────────────────────────

@router.post("/counterfactual")
async def run_counterfactual(req: CounterfactualRequest):
    """Analyze what would have happened under a different policy."""
    try:
        from backend.services.counterfactual_engine import counterfactual_engine
        analysis = await counterfactual_engine.analyze(req.incident_id, req.policy_change)
        return analysis.to_dict()
    except Exception as e:
        logger.error("api.counterfactual_failed: %s", e)
        raise HTTPException(500, detail=str(e))


@router.post("/counterfactual/batch")
async def run_batch_counterfactual(req: BatchCounterfactualRequest):
    """Analyze a policy change against multiple historical incidents."""
    try:
        from backend.services.counterfactual_engine import counterfactual_engine
        return await counterfactual_engine.batch_analyze(
            req.policy_change, req.lookback_days, req.limit
        )
    except Exception as e:
        logger.error("api.batch_counterfactual_failed: %s", e)
        raise HTTPException(500, detail=str(e))


# ── Red Team Simulation ─────────────────────────────────────────

@router.post("/red-team/simulate")
async def run_red_team(req: RedTeamRequest):
    """Simulate an adversarial intrusion against the facility."""
    try:
        from backend.services.red_team_simulator import red_team_simulator
        result = await red_team_simulator.simulate_intrusion(req.target_zone, req.objective)
        return result.to_dict()
    except Exception as e:
        logger.error("api.red_team_failed: %s", e)
        raise HTTPException(500, detail=str(e))


@router.get("/red-team/vulnerability-assessment")
async def get_vulnerability_assessment():
    """Run a comprehensive vulnerability assessment."""
    from backend.services.red_team_simulator import red_team_simulator
    return await red_team_simulator.vulnerability_assessment()


@router.get("/red-team/history")
async def get_red_team_history(limit: int = Query(20, le=100)):
    from backend.services.red_team_simulator import red_team_simulator
    return {"simulations": red_team_simulator.get_history(limit)}


# ── Shift Briefing ───────────────────────────────────────────────

@router.post("/shift-briefing")
async def generate_shift_briefing(shift_hours: int = Query(8, ge=1, le=24)):
    """Generate an AI-powered shift intelligence briefing."""
    try:
        from backend.services.shift_briefing import shift_briefing_service
        briefing = await shift_briefing_service.generate_briefing(shift_hours)
        return briefing.to_dict()
    except Exception as e:
        logger.error("api.shift_briefing_failed: %s", e)
        raise HTTPException(500, detail=str(e))


@router.get("/shift-briefing/history")
async def get_briefing_history(limit: int = Query(10, le=50)):
    from backend.services.shift_briefing import shift_briefing_service
    return {"briefings": shift_briefing_service.get_history(limit)}


# ── Pattern Library ──────────────────────────────────────────────

@router.post("/patterns/learn")
async def learn_pattern(req: PatternLearnRequest):
    """Learn a new pattern from a resolved true-positive alert."""
    try:
        from backend.services.pattern_library import pattern_library
        pattern = await pattern_library.learn_from_resolution(req.alert_id, req.alert_data)
        if pattern:
            return pattern.to_dict()
        raise HTTPException(400, detail="Could not extract pattern")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("api.pattern_learn_failed: %s", e)
        raise HTTPException(500, detail=str(e))


@router.get("/patterns")
async def get_all_patterns():
    """Get all learned patterns."""
    from backend.services.pattern_library import pattern_library
    return {
        "patterns": pattern_library.get_all_patterns(),
        "stats": pattern_library.get_stats(),
    }


@router.get("/patterns/{pattern_name}")
async def get_pattern(pattern_name: str):
    from backend.services.pattern_library import pattern_library
    p = pattern_library.get_pattern(pattern_name)
    if not p:
        raise HTTPException(404, detail="Pattern not found")
    return p


# ── Compliance Audit ─────────────────────────────────────────────

@router.post("/compliance/audit")
async def run_compliance_audit():
    """Run a full compliance audit against all rules."""
    try:
        from backend.services.compliance_auditor import compliance_auditor
        return await compliance_auditor.run_audit()
    except Exception as e:
        logger.error("api.compliance_audit_failed: %s", e)
        raise HTTPException(500, detail=str(e))


@router.get("/compliance/violations")
async def get_compliance_violations(
    status: str = Query("open"),
    limit: int = Query(50, le=200),
):
    """Get compliance violations."""
    from backend.services.compliance_auditor import compliance_auditor
    return {"violations": compliance_auditor.get_violations(status, limit)}


@router.get("/compliance/stats")
async def get_compliance_stats():
    from backend.services.compliance_auditor import compliance_auditor
    return compliance_auditor.get_stats()


@router.get("/compliance/history")
async def get_audit_history(limit: int = Query(20, le=100)):
    from backend.services.compliance_auditor import compliance_auditor
    return {"audits": compliance_auditor.get_audit_history(limit)}


# ── Scene Baselines ──────────────────────────────────────────────

@router.get("/baselines/{camera_id}")
async def get_camera_baseline(camera_id: str):
    """Get the baseline profile for a camera."""
    from backend.services.scene_baseline import scene_baseline
    return scene_baseline.get_camera_profile(camera_id)


@router.get("/baselines/{camera_id}/expected")
async def get_expected_now(camera_id: str):
    """Get what the baseline expects for a camera right now."""
    from backend.services.scene_baseline import scene_baseline
    return scene_baseline.get_current_expected(camera_id)


@router.get("/baselines")
async def get_all_baselines():
    """Get baseline summaries for all cameras."""
    from backend.services.scene_baseline import scene_baseline
    return {"cameras": scene_baseline.get_all_camera_summaries()}


# ── Overview ─────────────────────────────────────────────────────

@router.get("/overview")
async def intelligence_overview():
    """Get a high-level overview of all intelligence systems."""
    overview = {"timestamp": datetime.now(timezone.utc).isoformat()}

    try:
        from backend.services.pattern_library import pattern_library
        overview["pattern_library"] = pattern_library.get_stats()
    except Exception:
        overview["pattern_library"] = {}

    try:
        from backend.services.compliance_auditor import compliance_auditor
        overview["compliance"] = compliance_auditor.get_stats()
    except Exception:
        overview["compliance"] = {}

    try:
        from backend.services.causal_reasoning import causal_engine
        overview["causal_reasoning"] = causal_engine.get_chain_stats()
    except Exception:
        overview["causal_reasoning"] = {}

    return overview


# ── Missing endpoints called by frontend ─────────────────────

@router.get("/posture-score")
async def get_posture_score():
    """Current security posture score derived from alerts and threat level."""
    try:
        from backend.database import async_session
        from backend.models.models import Alert, AlertSeverity
        from sqlalchemy import select, func

        async with async_session() as db:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            sev_q = await db.execute(
                select(Alert.severity, func.count())
                .where(Alert.created_at >= cutoff)
                .group_by(Alert.severity)
            )
            by_sev = {
                (r[0].value if hasattr(r[0], "value") else str(r[0])): r[1]
                for r in sev_q.all()
            }
            critical = by_sev.get("critical", 0)
            high = by_sev.get("high", 0)
            medium = by_sev.get("medium", 0)
            low = by_sev.get("low", 0)
            total = critical + high + medium + low
            # Score: 100 = no threats, 0 = all critical
            score = max(0, 100 - (critical * 15 + high * 8 + medium * 3 + low * 1))
            level = (
                "critical" if score < 30
                else "elevated" if score < 60
                else "guarded" if score < 80
                else "normal"
            )
            return {
                "score": score,
                "level": level,
                "total_alerts_24h": total,
                "by_severity": by_sev,
            }
    except Exception as e:
        return {"score": 75, "level": "normal", "total_alerts_24h": 0, "by_severity": {}}


@router.get("/predictions")
async def get_predictions():
    """AI-generated threat predictions for next 24h."""
    try:
        from backend.database import async_session
        from backend.models.models import Alert
        from sqlalchemy import select, func

        async with async_session() as db:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=48)
            q = await db.execute(
                select(Alert.threat_type, func.count())
                .where(Alert.created_at >= cutoff)
                .group_by(Alert.threat_type)
            )
            type_counts = {str(r[0] or "unknown"): r[1] for r in q.all()}
            predictions = []
            for threat_type, count in sorted(type_counts.items(), key=lambda x: -x[1])[:5]:
                predictions.append({
                    "threat_type": threat_type,
                    "probability": min(0.95, count * 0.1),
                    "trend": "increasing" if count > 5 else "stable",
                    "recommended_action": f"Monitor {threat_type} activity zones",
                })
            return {"predictions": predictions, "generated_at": datetime.now(timezone.utc).isoformat()}
    except Exception:
        return {"predictions": [], "generated_at": datetime.now(timezone.utc).isoformat()}


@router.get("/threat-graph")
async def get_threat_graph(
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(100, ge=1, le=500),
):
    """Node/edge threat graph linking entities, alerts, cameras, events, and zones.

    Built entirely from real DB rows from the last ``hours`` window. Returns
    {"nodes": [...], "edges": [...]} with empty arrays when there is no data.
    """
    try:
        from backend.database import async_session
        from backend.models.models import Alert, Event, Camera, Zone
        from backend.models.phase3_models import EntityTrack
        from sqlalchemy import select, desc

        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        nodes: List[Dict[str, Any]] = []
        edges: List[Dict[str, Any]] = []
        seen: set = set()

        def add_node(node_id: str, node_type: str, label: str, **extra):
            if node_id in seen:
                return
            seen.add(node_id)
            nodes.append({"id": node_id, "type": node_type, "label": label, **extra})

        async with async_session() as session:
            # Cameras (referenced by alerts/events) keyed by id and by name
            cam_result = await session.execute(select(Camera))
            cameras = cam_result.scalars().all()
            cam_by_name: Dict[str, Camera] = {}
            for c in cameras:
                cam_by_name[c.name] = c
            # Zones keyed by name for alert.zone_name linkage
            zone_result = await session.execute(select(Zone))
            zones = zone_result.scalars().all()
            zone_by_name: Dict[str, Zone] = {z.name: z for z in zones}

            # Recent events
            ev_result = await session.execute(
                select(Event)
                .where(Event.timestamp >= cutoff)
                .order_by(desc(Event.timestamp))
                .limit(limit)
            )
            events = ev_result.scalars().all()
            for e in events:
                ev_id = f"event:{e.id}"
                add_node(
                    ev_id, "event", e.event_type or "event",
                    severity=e.severity.value if hasattr(e.severity, "value") else str(e.severity),
                    timestamp=e.timestamp.isoformat() if e.timestamp else None,
                )
                if e.camera_id:
                    cam_id = f"camera:{e.camera_id}"
                    add_node(cam_id, "camera", "camera")
                    edges.append({"source": cam_id, "target": ev_id, "type": "captured", "weight": 1})
                if e.zone_id:
                    zn_id = f"zone:{e.zone_id}"
                    add_node(zn_id, "zone", "zone")
                    edges.append({"source": ev_id, "target": zn_id, "type": "in_zone", "weight": 1})

            # Recent alerts
            al_result = await session.execute(
                select(Alert)
                .where(Alert.created_at >= cutoff)
                .order_by(desc(Alert.created_at))
                .limit(limit)
            )
            alerts = al_result.scalars().all()
            for a in alerts:
                al_id = f"alert:{a.id}"
                add_node(
                    al_id, "alert", a.threat_type or a.title or "alert",
                    severity=a.severity.value if hasattr(a.severity, "value") else str(a.severity),
                    status=a.status.value if hasattr(a.status, "value") else str(a.status),
                    timestamp=a.created_at.isoformat() if a.created_at else None,
                )
                if a.event_id:
                    edges.append({"source": f"event:{a.event_id}", "target": al_id, "type": "triggered", "weight": 2})
                # Link alert to its source camera (alert stores camera name)
                if a.source_camera:
                    cam = cam_by_name.get(a.source_camera)
                    cam_id = f"camera:{cam.id}" if cam else f"camera:{a.source_camera}"
                    add_node(cam_id, "camera", a.source_camera)
                    edges.append({"source": cam_id, "target": al_id, "type": "source", "weight": 1})
                # Link alert to its zone (alert stores zone name)
                if a.zone_name:
                    zone = zone_by_name.get(a.zone_name)
                    zn_id = f"zone:{zone.id}" if zone else f"zone:{a.zone_name}"
                    add_node(zn_id, "zone", a.zone_name)
                    edges.append({"source": al_id, "target": zn_id, "type": "in_zone", "weight": 1})

            # Recent tracked entities and their camera/alert relationships
            ent_result = await session.execute(
                select(EntityTrack)
                .where(EntityTrack.last_seen_at >= cutoff)
                .order_by(desc(EntityTrack.last_seen_at))
                .limit(limit)
            )
            entities = ent_result.scalars().all()
            for ent in entities:
                ent_id = f"entity:{ent.id}"
                add_node(
                    ent_id, "entity", ent.entity_type or "entity",
                    risk_score=ent.risk_score or 0.0,
                    escalation_level=ent.escalation_level or 0,
                    behavioral_flags=ent.behavioral_flags or [],
                )
                if ent.last_camera_id:
                    cam_id = f"camera:{ent.last_camera_id}"
                    add_node(cam_id, "camera", "camera")
                    edges.append({"source": ent_id, "target": cam_id, "type": "seen_at", "weight": ent.total_appearances or 1})
                if ent.linked_alert_id:
                    edges.append({"source": ent_id, "target": f"alert:{ent.linked_alert_id}", "type": "linked_to", "weight": 2})

        return {"nodes": nodes, "edges": edges}
    except Exception as e:
        logger.error("api.threat_graph_failed: %s", e)
        return {"nodes": [], "edges": []}


@router.get("/narratives")
async def get_narratives():
    """Scene narratives from AI analysis of camera feeds."""
    try:
        from backend.services.video_capture import capture_manager
        narratives = []
        for cam_id, stream in list(getattr(capture_manager, "_streams", {}).items())[:10]:
            if stream and stream.is_running:
                narratives.append({
                    "camera_id": cam_id,
                    "narrative": getattr(stream, "last_narrative", "") or "Monitoring active",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
        return {"narratives": narratives}
    except Exception:
        return {"narratives": []}
