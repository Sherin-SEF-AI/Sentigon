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
