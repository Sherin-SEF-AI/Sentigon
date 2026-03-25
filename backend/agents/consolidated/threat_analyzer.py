"""Threat Analyzer Agent — Unified threat assessment, micro-behavior analysis, and insider threat detection.

Consolidates: Threat Analyst, Micro-Behavior Detection, Insider Threat Analyzer.
Subscribes to perceptions, correlations, and anomalies. Assesses threat levels,
analyzes pose-based micro-behaviors (blading, target fixation, concealed carry),
and monitors for insider threat indicators from access patterns.
"""
from __future__ import annotations

import json, logging, time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_CORTEX, CH_PERCEPTIONS, CH_THREATS, CH_CORRELATION, CH_ANOMALIES,
)

logger = logging.getLogger(__name__)

_SEV = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
_BW: dict[str, float] = {
    "blading": 0.20, "target_fixation": 0.25, "pre_assault": 0.30,
    "staking": 0.15, "concealed_carry": 0.35, "evasive": 0.20,
}
_BL: dict[str, str] = {
    "blading": "Blading Stance", "target_fixation": "Target Fixation",
    "pre_assault": "Pre-Assault Posturing", "staking": "Staking Behavior",
    "concealed_carry": "Concealed Object Carry", "evasive": "Evasive Movement",
}
_INSIDER_THRESH = 0.65
_AH_START, _AH_END = 22, 5  # after-hours window

_PROMPT = """\
You are a senior threat analyst in an autonomous physical security system.
Assess the flagged activity using available tools (detections, event/alert
history, site context, threat intel). Provide structured JSON:
{{
  "threat_type": "<intrusion|violence|theft|surveillance|sabotage|insider>",
  "severity": "<info|low|medium|high|critical>",
  "confidence": <0.0-1.0>,
  "required_response": "<monitor|alert|investigate|respond|lockdown>",
  "threat_explanation": "<concise explanation>",
  "evidence": ["..."], "mitigating_factors": ["..."]
}}

**Flagged activity:** {event_details}
**Behavioral signals:** {behavior_signals}
**Recent context:** {recent_context}
"""


class ThreatAnalyzerAgent(BaseAgent):
    """Unified threat assessment, micro-behavior, and insider threat agent."""

    def __init__(self) -> None:
        super().__init__(
            name="threat_analyzer",
            role="Senior Threat Analyst & Behavioral Intelligence",
            description=(
                "Assesses all incoming perceptions and correlations for security "
                "threats. Analyzes micro-behaviors via pose data, detects insider "
                "threat indicators from access patterns, and provides unified "
                "threat assessments with severity ratings."
            ),
            tier="reasoning",
            model_name="gemma3:4b",
            tool_names=[
                "get_current_detections", "get_alert_history", "get_event_history",
                "get_threat_statistics", "get_all_cameras_status", "get_site_context",
                "create_alert", "create_event", "semantic_search", "store_observation",
                "get_threat_intel_context",
            ],
            subscriptions=[CH_PERCEPTIONS, CH_CORRELATION, CH_ANOMALIES, CH_CORTEX],
            cycle_interval=15.0,
            token_budget_per_cycle=25000,
        )
        self._behavior_history: dict[str, list[dict]] = defaultdict(list)
        self._insider_profiles: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"after_hours_count": 0, "restricted_zone_visits": [],
                     "failed_access_count": 0, "risk_score": 0.0, "last_seen": None}
        )
        self._sweep_interval = 12

    # ── Core reasoning ────────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        inbox: list[dict] = context.get("inbox_messages", [])
        cycle: int = context.get("cycle", 0)
        if not inbox:
            if cycle > 0 and cycle % self._sweep_interval == 0:
                await self._periodic_sweep()
            return {"status": "idle", "reason": "empty_inbox"}

        inbox = self._triage(inbox)
        perceptions, correlations, anomalies, cortex = [], [], [], []
        for msg in inbox:
            ch, mt = msg.get("_channel", ""), msg.get("type", "")
            if ch == CH_CORTEX or mt in ("analyze_threat", "investigate", "assess"):
                cortex.append(msg)
            elif ch == CH_ANOMALIES or mt in ("anomaly", "anomaly_detected", "baseline_deviation"):
                anomalies.append(msg)
            elif ch == CH_CORRELATION or mt in ("cross_camera_correlation", "pattern_detected", "fused_event"):
                correlations.append(msg)
            else:
                perceptions.append(msg)

        bscored = sum(1 for m in perceptions if self._score_micro_behaviors(m))
        iflags = sum(1 for m in perceptions + correlations if self._update_insider_profile(m))
        published = 0
        for ev in self._select_noteworthy(perceptions, correlations, anomalies, cortex):
            try:
                if await self._assess_threat(ev, context):
                    published += 1
            except Exception as exc:
                logger.error("Threat assessment failed: %s", exc)
                await self.log_action("error", {"error": str(exc)})
        if cycle > 0 and cycle % self._sweep_interval == 0:
            await self._periodic_sweep()
        return {"status": "processed", "inbox_size": len(inbox),
                "assessments_published": published, "behaviors_scored": bscored,
                "insider_flags": iflags}

    # ── Triage ────────────────────────────────────────────────────────

    @staticmethod
    def _triage(inbox: list[dict]) -> list[dict]:
        def _u(m: dict) -> int:
            s = -_SEV.get(m.get("severity", "info"), 0) * 10
            if m.get("threats"): s -= 20
            if m.get("person_count", 0) > 10: s -= 15
            if m.get("type", "") in ("forced_entry", "weapon_detected", "gunshot"): s -= 50
            if m.get("_channel") == CH_CORTEX: s -= 30
            return s
        return sorted(inbox, key=_u)

    # ── Micro-Behavior Scoring ────────────────────────────────────────

    def _score_micro_behaviors(self, msg: dict) -> dict | None:
        pf: dict = msg.get("pose_features", {})
        blist: list[str] = msg.get("behaviors", [])
        if not pf and not blist:
            for d in msg.get("detections", []):
                if d.get("pose_features"):
                    pf = d["pose_features"]; break
            if not pf:
                return None

        cam = msg.get("camera_id", "unknown")
        tid = msg.get("track_id", msg.get("entity_id", "0"))
        ek = f"{cam}_{tid}"
        det: dict[str, float] = {}
        for bk, w in _BW.items():
            f = pf.get(bk, {})
            if isinstance(f, dict) and f.get("detected"):
                det[bk] = round(min(float(f.get("confidence", 0.5)) * w * 2, 1.0), 3)
            elif bk in blist:
                det[bk] = round(w, 3)
        if not det:
            return None

        ts = round(min(sum(det.values()) / sum(_BW.values()), 1.0), 3)
        snap = {"ts": time.time(), "detected": det, "threat_score": ts,
                "camera_id": cam, "track_id": tid}
        self._behavior_history[ek].append(snap)
        self._behavior_history[ek] = self._behavior_history[ek][-20:]
        hist = self._behavior_history[ek]
        if len(hist) >= 3:
            win = hist[-5:]
            avg = sum(s["threat_score"] for s in win) / len(win)
            uniq = {b for s in win for b in s["detected"]}
            if len(uniq) >= 2 and avg > 0.3:
                snap["escalated"] = True
                snap["effective_score"] = round(min(avg * 1.4, 1.0), 3)
        return snap

    # ── Insider Threat Detection ──────────────────────────────────────

    def _update_insider_profile(self, msg: dict) -> bool:
        eid = msg.get("entity_id") or msg.get("badge_id") or msg.get("track_id")
        if not eid:
            return False
        eid = str(eid)
        p = self._insider_profiles[eid]
        p["last_seen"] = time.time()
        try:
            hour = datetime.fromisoformat(msg.get("timestamp", "").replace("Z", "+00:00")).hour
        except (ValueError, TypeError, AttributeError):
            hour = datetime.now(timezone.utc).hour
        if (hour >= _AH_START or hour < _AH_END) and \
                msg.get("type") in ("access_granted", "access_event", "detection", "perception"):
            p["after_hours_count"] += 1
        zone = msg.get("zone") or msg.get("area")
        if zone and msg.get("zone_type", "") in ("restricted", "secure", "sensitive"):
            if zone not in p["restricted_zone_visits"]:
                p["restricted_zone_visits"].append(zone)
        if msg.get("type") in ("access_denied", "failed_access"):
            p["failed_access_count"] += 1
        p["risk_score"] = round(min(
            min(p["after_hours_count"] * 0.1, 0.3)
            + min(len(p["restricted_zone_visits"]) * 0.15, 0.35)
            + min(p["failed_access_count"] * 0.12, 0.35), 1.0), 3)
        return p["risk_score"] >= _INSIDER_THRESH

    # ── Noteworthy Event Selection ────────────────────────────────────

    def _select_noteworthy(self, perceptions, correlations, anomalies, cortex) -> list[dict]:
        nw: list[dict] = []
        for d in cortex:
            d["_priority"] = "critical"; nw.append(d)
        for a in anomalies:
            a["_priority"] = "high"; nw.append(a)
        for c in correlations:
            rl = c.get("risk_level", c.get("correlation", {}).get("risk_level", "low"))
            if rl in ("medium", "high", "critical"):
                c["_priority"] = "high"; nw.append(c)
        for p in perceptions:
            ek = f"{p.get('camera_id', '')}_{p.get('track_id', p.get('entity_id', ''))}"
            esc = any(s.get("escalated") for s in self._behavior_history.get(ek, [])[-3:])
            if (_SEV.get(p.get("severity", "info"), 0) >= 2 or
                    float(p.get("confidence", 0)) >= 0.7 or p.get("threats") or esc):
                p["_priority"] = "medium"; nw.append(p)
        for eid, prof in self._insider_profiles.items():
            if prof["risk_score"] >= _INSIDER_THRESH:
                nw.append({"_priority": "high", "type": "insider_threat_flag",
                           "entity_id": eid, "risk_score": prof["risk_score"],
                           "after_hours_count": prof["after_hours_count"],
                           "restricted_zones": prof["restricted_zone_visits"],
                           "failed_access": prof["failed_access_count"]})
                prof["risk_score"] = max(prof["risk_score"] - 0.2, 0.0)
        prio = {"critical": 0, "high": 1, "medium": 2}
        nw.sort(key=lambda e: prio.get(e.get("_priority", "medium"), 2))
        return nw[:5]

    # ── Threat Assessment + Fusion + Publish ──────────────────────────

    async def _assess_threat(self, event: dict, context: dict) -> dict | None:
        cam = event.get("camera_id", "")
        tid = event.get("track_id", event.get("entity_id", ""))
        bh = self._behavior_history.get(f"{cam}_{tid}", [])

        btext = "None detected."
        if bh:
            btext = "\n".join(
                f"  score={s['threat_score']}{' [ESC]' if s.get('escalated') else ''}: "
                + ", ".join(f"{b}({_BL.get(b,b)}:{v:.2f})" for b, v in s["detected"].items())
                for s in bh[-3:])

        ec = {k: v for k, v in event.items() if not k.startswith("_")}
        mem = context.get("short_term_memory", {})
        result = await self.execute_tool_loop(
            _PROMPT.format(event_details=json.dumps(ec, default=str)[:3000],
                           behavior_signals=btext,
                           recent_context=json.dumps(mem, default=str)[:2000] if mem else "None."),
            context_data={"event": ec, "cycle": context.get("cycle", 0),
                          "timestamp": context.get("timestamp")})
        resp = result.get("response", "")
        a = self._parse_assessment(resp)
        a.update({"source_event_type": event.get("type", "unknown"), "camera_id": cam,
                  "tool_calls_made": len(result.get("tool_calls", []))})

        # Fusion: boost severity from behavior / insider signals
        fused = a.get("severity", "info")
        if bh and bh[-1].get("effective_score", bh[-1].get("threat_score", 0)) >= 0.6:
            if _SEV.get(fused, 0) < _SEV["high"]:
                fused = "high"; a["fusion_note"] = "Boosted by micro-behavior signals"
        eid = str(event.get("entity_id", event.get("badge_id", tid)))
        ins = self._insider_profiles.get(eid, {})
        ir = ins.get("risk_score", 0)
        if ir >= _INSIDER_THRESH:
            if _SEV.get(fused, 0) < _SEV["high"]: fused = "high"
            a["insider_risk_score"] = ir
            a["insider_indicators"] = {"after_hours": ins.get("after_hours_count", 0),
                                        "restricted_zones": ins.get("restricted_zone_visits", []),
                                        "failed_access": ins.get("failed_access_count", 0)}
        a["severity"] = fused

        # Publish medium+ to CH_THREATS
        if _SEV.get(fused, 0) >= _SEV["medium"]:
            await self.send_message(CH_THREATS, {
                "type": "threat_assessment", "camera_id": cam,
                "threat_type": a.get("threat_type", "unknown"), "severity": fused,
                "confidence": a.get("confidence", 0.5),
                "required_response": a.get("required_response", "alert"),
                "threat_explanation": a.get("threat_explanation", ""),
                "evidence": a.get("evidence", []),
                "mitigating_factors": a.get("mitigating_factors", []),
                "behavior_history_len": len(bh), "insider_risk": ir,
                "timestamp": datetime.now(timezone.utc).isoformat()})
            await self.learn(
                knowledge=f"Threat ({fused}): {a.get('threat_type','?')} camera {cam}. "
                          f"{a.get('threat_explanation','')[:200]}",
                category="confirmed_threat", camera_id=cam or None)
        await self.remember(f"assessment_{cam}_{tid}",
                            {"severity": fused, "threat_type": a.get("threat_type"),
                             "confidence": a.get("confidence", 0),
                             "timestamp": datetime.now(timezone.utc).isoformat()}, ttl=600)
        await self.log_action("decision", {
            "decision": f"type={a.get('threat_type')} sev={fused}",
            "confidence": a.get("confidence", 0),
            "prompt_summary": f"Assessment for {event.get('type','unknown')}",
            "response_summary": resp[:300]})
        return a

    # ── Helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _parse_assessment(text: str) -> dict:
        try:
            p = json.loads(text[text.index("{"):text.rindex("}") + 1])
            return {"threat_type": p.get("threat_type", "unknown"),
                    "severity": p.get("severity", "info"),
                    "confidence": float(p.get("confidence", 0.0)),
                    "required_response": p.get("required_response", "monitor"),
                    "threat_explanation": p.get("threat_explanation", ""),
                    "evidence": p.get("evidence", []),
                    "mitigating_factors": p.get("mitigating_factors", [])}
        except (ValueError, json.JSONDecodeError, TypeError):
            logger.debug("Could not parse assessment JSON")
            return {"threat_type": "unknown", "severity": "info", "confidence": 0.0,
                    "required_response": "monitor", "threat_explanation": "",
                    "evidence": [], "mitigating_factors": [], "raw_response": text[:800]}

    async def _periodic_sweep(self) -> None:
        logger.info("ThreatAnalyzer: periodic sweep")
        cutoff = time.time() - 600
        for k in list(self._behavior_history):
            self._behavior_history[k] = [s for s in self._behavior_history[k] if s["ts"] > cutoff]
            if not self._behavior_history[k]: del self._behavior_history[k]
        ic = time.time() - 1800
        for eid in list(self._insider_profiles):
            if (self._insider_profiles[eid].get("last_seen") or 0) < ic:
                del self._insider_profiles[eid]
        r = await self.execute_tool_loop(
            "Review current threat statistics and active alerts using "
            "get_threat_statistics and get_alert_history. Give a one-sentence posture assessment.")
        posture = r.get("response", "unknown")[:200]
        await self.remember("threat_posture", {
            "summary": posture, "behavior_entities": len(self._behavior_history),
            "insider_profiles": len(self._insider_profiles),
            "timestamp": datetime.now(timezone.utc).isoformat()}, ttl=300)
        await self.log_action("sweep_complete", {
            "behavior_entities": len(self._behavior_history),
            "insider_profiles": len(self._insider_profiles),
            "posture_summary": posture[:100]})
