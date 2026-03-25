"""Crowd Monitor Agent — crowd dynamics and density monitoring.

Tracks occupancy across all active zones, maintains rolling person-count
trends in short-term memory, detects crowd patterns (gathering, dispersing,
stable), and fires capacity alerts when thresholds are breached.  Uses
Gemini reasoning for contextual crowd-safety assessment.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_PERCEPTIONS
from backend.services.crowd_analytics import crowd_flow_analyzer

logger = logging.getLogger(__name__)

# Maximum number of readings kept in the rolling window per zone
_TREND_WINDOW_SIZE = 10

# ── Gemini crowd-analysis prompt ─────────────────────────────────────
_CROWD_PROMPT = """\
You are a crowd dynamics monitoring agent for a physical security system. \
Analyse the crowd situation for the given zone.

**Zone:** {zone_name} (type: {zone_type})
**Current occupancy:** {current_occupancy} people
**Zone capacity:** {max_occupancy}
**Utilisation:** {utilisation_pct}%
**Is over capacity:** {is_over_capacity}

**Occupancy trend (last {trend_count} readings):**
{trend_data}

**Detected crowd pattern:** {crowd_pattern}
**Trend direction:** {trend_direction}

**Cameras in zone with detections:**
{camera_detections}

**Crowd flow analysis:**
{flow_analysis}

**Site context:**
- Time: {current_time} ({period})
- Business hours: {business_hours}
- Day: {day_of_week}

Assess the crowd situation. Consider:
1. Is this occupancy level normal for the time of day?
2. Is the crowd pattern (gathering/dispersing/stable) concerning?
3. Are there any crowd safety risks (crushing, blocking exits, panic)?
4. Should security personnel be alerted?
5. Are there any predictive concerns (trending towards capacity)?
6. Does the crowd flow analysis indicate panic, hostile convergence, or stampede risk?
7. What is the overall crowd sentiment based on movement patterns?

Respond with structured JSON:
{{
  "crowd_assessment": "<normal|elevated|concerning|critical>",
  "safety_risk_level": "<none|low|moderate|high|critical>",
  "observations": ["<observation 1>", ...],
  "concerns": ["<concern 1>", ...],
  "predictions": ["<prediction 1>", ...],
  "recommended_actions": ["<action 1>", ...],
  "is_normal_for_time": <true|false>,
  "severity": "<info|low|medium|high|critical>",
  "confidence": <0.0-1.0>
}}

Example output:
{{"crowd_assessment": "elevated", "safety_risk_level": "low", "observations": ["Occupancy at 75% during lunch hour", "Steady gathering pattern near entrance"], "concerns": ["Approaching capacity if trend continues"], "predictions": ["May reach capacity within 15 minutes at current rate"], "recommended_actions": ["Monitor entrance flow", "Prepare to redirect foot traffic"], "is_normal_for_time": true, "severity": "low", "confidence": 0.82}}

Example output:
{{"crowd_assessment": "normal", "safety_risk_level": "none", "observations": ["12 people in zone, well below capacity", "Normal flow movement pattern"], "concerns": [], "predictions": [], "recommended_actions": [], "is_normal_for_time": true, "severity": "info", "confidence": 0.95}}
"""


class CrowdMonitorAgent(BaseAgent):
    """Crowd dynamics and density monitoring agent.

    Monitors zone occupancy across the site, detects crowd patterns
    via rolling trend analysis, fires capacity alerts, and publishes
    crowd events to the perceptions channel for downstream reasoning.
    """

    def __init__(self) -> None:
        super().__init__(
            name="crowd_monitor",
            role="Crowd Dynamics Monitor",
            description=(
                "Monitors occupancy across all zones, tracks person-count "
                "trends via rolling windows, detects crowd patterns "
                "(gathering, dispersing, stable), creates alerts when "
                "zones exceed capacity, and uses Gemini for contextual "
                "crowd-safety assessment."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "get_current_detections",
                "get_zone_occupancy",
                "get_all_zones_status",
                "analyze_frame_with_gemini",
                "get_occupancy_trends",
                "create_alert",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=3.0,
            token_budget_per_cycle=15000,  # Perception: lightweight analysis only
        )

    # ── Core reasoning ────────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main crowd monitoring loop.

        1. Get all zones status.  For each zone with occupancy > 0:
           a. Get current detections for cameras in that zone.
           b. Track person_count trend in short-term memory (rolling
              window of last 10 readings).
           c. Detect crowd pattern: gathering (increasing), dispersing
              (decreasing), stable.
        2. If a zone is over capacity, create an alert via ``create_alert``.
        3. Use ``execute_tool_loop`` for Gemini crowd-safety analysis.
        4. Publish crowd events to ``CH_PERCEPTIONS`` with occupancy data.
        """
        cycle = context.get("cycle", 0)

        # ── 1. Gather zone occupancy ─────────────────────────────────
        from backend.agents.agent_tools import TOOL_REGISTRY

        zones_result = await TOOL_REGISTRY["get_all_zones_status"]["fn"]()
        if not zones_result.get("success"):
            logger.debug("Crowd Monitor: unable to fetch zone statuses")
            return {"status": "idle", "reason": "zones_unavailable"}

        zones = zones_result.get("zones", [])
        occupied_zones = [z for z in zones if z.get("occupancy", 0) > 0]

        if not occupied_zones:
            logger.debug("Crowd Monitor: all zones are empty (cycle %d)", cycle)
            return {"status": "idle", "zones_checked": len(zones), "occupied": 0}

        results: list[dict] = []

        for zone in occupied_zones:
            try:
                zone_result = await self._process_zone(zone, context)
                results.append(zone_result)
            except Exception as exc:
                logger.error(
                    "Crowd Monitor: error processing zone %s: %s",
                    zone.get("name", "unknown"), exc,
                )
                await self.log_action("error", {
                    "error": f"Zone processing failed: {exc}",
                    "zone_name": zone.get("name", "unknown"),
                })

        return {
            "status": "processed",
            "zones_checked": len(zones),
            "zones_occupied": len(occupied_zones),
            "zones_processed": len(results),
            "over_capacity_count": sum(
                1 for r in results if r.get("is_over_capacity")
            ),
        }

    # ── Per-zone processing ──────────────────────────────────────────

    async def _process_zone(self, zone: dict, context: dict) -> dict:
        """Process a single zone: detect trends, analyse, publish."""
        zone_id = zone["id"]
        zone_name = zone.get("name", zone_id)
        zone_type = zone.get("type", "default")
        current_occupancy = zone.get("occupancy", 0)
        max_occupancy = zone.get("max", 0)
        is_over_capacity = zone.get("over_capacity", False)

        # ── 1a. Get detections for cameras in this zone ──────────────
        camera_detections = await self._get_zone_camera_detections(zone)

        # ── 1b. Update rolling trend window ──────────────────────────
        trend_key = f"crowd_trend_{zone_id}"
        trend = await self.recall(trend_key)
        if not trend or not isinstance(trend, list):
            trend = []

        trend.append({
            "count": current_occupancy,
            "ts": time.time(),
        })

        # Keep only the last N readings
        if len(trend) > _TREND_WINDOW_SIZE:
            trend = trend[-_TREND_WINDOW_SIZE:]

        await self.remember(trend_key, trend, ttl=300)

        # ── 1c. Detect crowd pattern ─────────────────────────────────
        crowd_pattern, trend_direction = self._detect_crowd_pattern(trend)

        # ── 1d. Crowd flow analysis & sentiment ──────────────────────
        flow_result = None
        try:
            from backend.services.yolo_detector import yolo_detector
            # Gather tracked persons from cameras in this zone
            all_tracked = []
            for cam_det in camera_detections:
                cam_id = cam_det.get("camera_id", "")
                tracked = yolo_detector.get_tracked_objects(cam_id)
                all_tracked.extend(tracked)

            if len(all_tracked) >= 3:
                flow_result = crowd_flow_analyzer.analyze_from_tracked_objects(
                    all_tracked,
                    area_capacity=max_occupancy or 0,
                )

                # Create alert for panic or hostile movement
                if flow_result.panic_detected:
                    recent_panic = await self.recall(f"panic_alert_{zone_id}")
                    if not recent_panic:
                        from backend.agents.agent_tools import TOOL_REGISTRY
                        await TOOL_REGISTRY["create_alert"]["fn"](
                            camera_id=zone_id,
                            severity="critical",
                            threat_type="panic_movement",
                            description=(
                                f"Panic movement detected in '{zone_name}': "
                                f"radial dispersion at high speed. "
                                f"Panic score: {flow_result.panic_score}, "
                                f"stampede risk: {flow_result.stampede_risk}"
                            ),
                            confidence=flow_result.panic_score,
                        )
                        await self.remember(f"panic_alert_{zone_id}", True, ttl=60)

                if flow_result.hostile_detected:
                    recent_hostile = await self.recall(f"hostile_alert_{zone_id}")
                    if not recent_hostile:
                        from backend.agents.agent_tools import TOOL_REGISTRY
                        await TOOL_REGISTRY["create_alert"]["fn"](
                            camera_id=zone_id,
                            severity="high",
                            threat_type="hostile_convergence",
                            description=(
                                f"Hostile convergence detected in '{zone_name}': "
                                f"multiple people converging on single point. "
                                f"Hostile score: {flow_result.hostile_score}"
                            ),
                            confidence=flow_result.hostile_score,
                        )
                        await self.remember(f"hostile_alert_{zone_id}", True, ttl=60)
        except Exception as exc:
            logger.debug("Crowd flow analysis skipped: %s", exc)

        # ── 2. Create alert if over capacity ─────────────────────────
        if is_over_capacity and max_occupancy and max_occupancy > 0:
            # Check if we already alerted recently to avoid spam
            recent_alert = await self.recall(f"capacity_alert_{zone_id}")
            if not recent_alert:
                from backend.agents.agent_tools import TOOL_REGISTRY
                await TOOL_REGISTRY["create_alert"]["fn"](
                    camera_id=zone_id,  # use zone_id as source
                    severity="high",
                    threat_type="capacity_exceeded",
                    description=(
                        f"Zone '{zone_name}' is over capacity: "
                        f"{current_occupancy}/{max_occupancy} people. "
                        f"Crowd pattern: {crowd_pattern}."
                    ),
                    confidence=0.9,
                )
                await self.remember(
                    f"capacity_alert_{zone_id}", True, ttl=120
                )
                logger.warning(
                    "Crowd Monitor: capacity alert for zone %s (%d/%d)",
                    zone_name, current_occupancy, max_occupancy,
                )

        # ── 3. Gemini crowd-safety analysis ──────────────────────────
        utilisation_pct = (
            round((current_occupancy / max_occupancy) * 100, 1)
            if max_occupancy and max_occupancy > 0
            else 0
        )

        # Check if zone occupancy changed since last check (skip AI if same)
        last_occ_key = f"last_occ_{zone_id}"
        last_occ = await self.recall(last_occ_key)
        occupancy_changed = last_occ is None or last_occ != current_occupancy
        await self.remember(last_occ_key, current_occupancy, ttl=120)

        # Only invoke Gemini for zones that warrant deeper analysis AND changed
        needs_deep_analysis = occupancy_changed and (
            is_over_capacity
            or utilisation_pct > 70
            or crowd_pattern == "gathering"
            or current_occupancy > 10
            or (flow_result and flow_result.sentiment in ("agitated", "hostile", "panic"))
        )

        assessment: dict = {}
        if needs_deep_analysis:
            assessment = await self._run_crowd_analysis(
                zone_id=zone_id,
                zone_name=zone_name,
                zone_type=zone_type,
                current_occupancy=current_occupancy,
                max_occupancy=max_occupancy,
                utilisation_pct=utilisation_pct,
                is_over_capacity=is_over_capacity,
                trend=trend,
                crowd_pattern=crowd_pattern,
                trend_direction=trend_direction,
                camera_detections=camera_detections,
                flow_result=flow_result,
                context=context,
            )

        # ── 4. Publish crowd event ───────────────────────────────────
        severity = assessment.get("severity", "info")
        crowd_assessment = assessment.get("crowd_assessment", "normal")

        # Publish for non-trivial occupancy or when assessment is notable
        crowd_sentiment = flow_result.sentiment if flow_result else "calm"
        should_publish = (
            crowd_assessment in ("elevated", "concerning", "critical")
            or is_over_capacity
            or crowd_pattern in ("gathering", "dispersing")
            or severity in ("medium", "high", "critical")
            or crowd_sentiment in ("agitated", "hostile", "panic")
        )

        if should_publish:
            event_data = {
                "type": "crowd_event",
                "zone_id": zone_id,
                "zone_name": zone_name,
                "zone_type": zone_type,
                "current_occupancy": current_occupancy,
                "max_occupancy": max_occupancy,
                "utilisation_pct": utilisation_pct,
                "is_over_capacity": is_over_capacity,
                "crowd_pattern": crowd_pattern,
                "trend_direction": trend_direction,
                "crowd_assessment": crowd_assessment,
                "safety_risk_level": assessment.get("safety_risk_level", "none"),
                "observations": assessment.get("observations", []),
                "concerns": assessment.get("concerns", []),
                "predictions": assessment.get("predictions", []),
                "recommended_actions": assessment.get("recommended_actions", []),
                "severity": severity,
                "confidence": assessment.get("confidence", 0.0),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

            # Attach flow analysis results
            if flow_result:
                event_data["crowd_sentiment"] = flow_result.sentiment
                event_data["avg_speed"] = flow_result.avg_speed
                event_data["max_speed"] = flow_result.max_speed
                event_data["density"] = flow_result.density
                event_data["directional_alignment"] = flow_result.directional_alignment
                event_data["panic_detected"] = flow_result.panic_detected
                event_data["panic_score"] = flow_result.panic_score
                event_data["hostile_detected"] = flow_result.hostile_detected
                event_data["hostile_score"] = flow_result.hostile_score
                event_data["stampede_risk"] = flow_result.stampede_risk
                if flow_result.convergence_point:
                    event_data["convergence_point"] = flow_result.convergence_point

            await self.send_message(CH_PERCEPTIONS, event_data)

        await self.log_action("crowd_check", {
            "zone_name": zone_name,
            "occupancy": current_occupancy,
            "max_occupancy": max_occupancy,
            "pattern": crowd_pattern,
            "over_capacity": is_over_capacity,
            "published": should_publish,
            "decision": (
                f"zone={zone_name} occ={current_occupancy}/{max_occupancy} "
                f"pattern={crowd_pattern} severity={severity}"
            ),
        })

        return {
            "zone_id": zone_id,
            "zone_name": zone_name,
            "occupancy": current_occupancy,
            "max_occupancy": max_occupancy,
            "crowd_pattern": crowd_pattern,
            "is_over_capacity": is_over_capacity,
            "severity": severity,
        }

    # ── Camera detections for a zone ─────────────────────────────────

    async def _get_zone_camera_detections(self, zone: dict) -> list[dict]:
        """Get detections from all cameras associated with a zone.

        Because the zone model may not directly reference cameras, we
        use a best-effort approach: fetch all cameras and match by
        location/name.
        """
        from backend.agents.agent_tools import TOOL_REGISTRY

        cameras_result = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        if not cameras_result.get("success"):
            return []

        zone_name = zone.get("name", "").lower()
        matched_cameras = [
            c for c in cameras_result.get("cameras", [])
            if c.get("status") == "online" and (
                zone_name in (c.get("location", "") or "").lower()
                or zone_name in (c.get("name", "") or "").lower()
            )
        ]

        detections: list[dict] = []
        for cam in matched_cameras[:3]:  # cap to avoid overload
            try:
                det = await TOOL_REGISTRY["get_current_detections"]["fn"](
                    camera_id=cam["id"],
                )
                if det.get("success"):
                    detections.append({
                        "camera_id": cam["id"],
                        "camera_name": cam.get("name", cam["id"]),
                        "person_count": det.get("person_count", 0),
                        "vehicle_count": det.get("vehicle_count", 0),
                        "total_objects": det.get("total_objects", 0),
                    })
            except Exception:
                pass

        return detections

    # ── Crowd pattern detection ──────────────────────────────────────

    @staticmethod
    def _detect_crowd_pattern(trend: list[dict]) -> tuple[str, str]:
        """Detect crowd pattern from rolling trend data.

        Returns (pattern, direction) where:
        - pattern: "gathering" | "dispersing" | "stable" | "fluctuating"
        - direction: "increasing" | "decreasing" | "stable"
        """
        if len(trend) < 3:
            return "stable", "stable"

        counts = [r.get("count", 0) for r in trend]
        recent = counts[-3:]

        # Calculate simple trend direction
        diffs = [recent[i] - recent[i - 1] for i in range(1, len(recent))]

        increasing = sum(1 for d in diffs if d > 0)
        decreasing = sum(1 for d in diffs if d < 0)
        total_change = counts[-1] - counts[0]

        if increasing > decreasing and total_change > 2:
            return "gathering", "increasing"
        elif decreasing > increasing and total_change < -2:
            return "dispersing", "decreasing"
        elif all(abs(d) <= 1 for d in diffs):
            return "stable", "stable"
        else:
            return "fluctuating", "stable"

    # ── Gemini crowd analysis ────────────────────────────────────────

    async def _run_crowd_analysis(
        self,
        zone_id: str,
        zone_name: str,
        zone_type: str,
        current_occupancy: int,
        max_occupancy: int,
        utilisation_pct: float,
        is_over_capacity: bool,
        trend: list[dict],
        crowd_pattern: str,
        trend_direction: str,
        camera_detections: list[dict],
        flow_result: "Any | None",
        context: dict,
    ) -> dict:
        """Invoke Gemini for contextual crowd-safety assessment."""
        from backend.agents.agent_tools import TOOL_REGISTRY

        # Get site context
        site_ctx = await TOOL_REGISTRY["get_site_context"]["fn"]()

        # Format trend data
        trend_data = json.dumps(
            [
                {"count": r.get("count", 0), "relative_time": f"{i * 3}s ago"}
                for i, r in enumerate(reversed(trend))
            ],
            default=str,
        )[:1000]

        # Format camera detections
        cam_det_str = (
            json.dumps(camera_detections, default=str)[:1500]
            if camera_detections
            else "No camera detections available."
        )

        # Format flow analysis
        if flow_result:
            flow_str = (
                f"Sentiment: {flow_result.sentiment}\n"
                f"Avg speed: {flow_result.avg_speed} px/s, Max speed: {flow_result.max_speed} px/s\n"
                f"Density: {flow_result.density} persons/cell\n"
                f"Directional alignment: {flow_result.directional_alignment}\n"
                f"Panic detected: {flow_result.panic_detected} (score: {flow_result.panic_score})\n"
                f"Hostile convergence: {flow_result.hostile_detected} (score: {flow_result.hostile_score})\n"
                f"Stampede risk: {flow_result.stampede_risk}"
            )
        else:
            flow_str = "Insufficient tracked persons for flow analysis."

        prompt = _CROWD_PROMPT.format(
            zone_name=zone_name,
            zone_type=zone_type,
            current_occupancy=current_occupancy,
            max_occupancy=max_occupancy or "unlimited",
            utilisation_pct=utilisation_pct,
            is_over_capacity=is_over_capacity,
            trend_count=len(trend),
            trend_data=trend_data,
            crowd_pattern=crowd_pattern,
            trend_direction=trend_direction,
            camera_detections=cam_det_str,
            flow_analysis=flow_str,
            current_time=site_ctx.get("datetime", datetime.now().isoformat()),
            period=site_ctx.get("period", "unknown"),
            business_hours=site_ctx.get("business_hours", "unknown"),
            day_of_week=site_ctx.get("day_of_week", "unknown"),
        )

        result = await self.execute_tool_loop(prompt, context_data={
            "zone_id": zone_id,
            "zone_name": zone_name,
            "occupancy": current_occupancy,
            "max_occupancy": max_occupancy,
            "cycle": context.get("cycle", 0),
        })

        response_text = result.get("response", "")
        return self._parse_crowd_assessment(response_text)

    # ── Response parsing ─────────────────────────────────────────────

    @staticmethod
    def _parse_crowd_assessment(response_text: str) -> dict:
        """Extract structured crowd assessment from Gemini response."""
        try:
            start = response_text.index("{")
            end = response_text.rindex("}") + 1
            parsed = json.loads(response_text[start:end])
            return {
                "crowd_assessment": parsed.get("crowd_assessment", "normal"),
                "safety_risk_level": parsed.get("safety_risk_level", "none"),
                "observations": parsed.get("observations", []),
                "concerns": parsed.get("concerns", []),
                "predictions": parsed.get("predictions", []),
                "recommended_actions": parsed.get("recommended_actions", []),
                "is_normal_for_time": bool(
                    parsed.get("is_normal_for_time", True)
                ),
                "severity": parsed.get("severity", "info"),
                "confidence": float(parsed.get("confidence", 0.0)),
            }
        except (ValueError, json.JSONDecodeError, TypeError):
            logger.debug("Could not parse JSON from crowd analysis response")
            return {
                "crowd_assessment": "normal",
                "safety_risk_level": "none",
                "observations": [],
                "concerns": [],
                "predictions": [],
                "recommended_actions": [],
                "is_normal_for_time": True,
                "severity": "info",
                "confidence": 0.0,
                "raw_response": response_text[:500] if response_text else "",
            }
