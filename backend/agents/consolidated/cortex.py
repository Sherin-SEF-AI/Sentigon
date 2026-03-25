"""Sentinel Cortex — The unified supervisor brain of the SENTINEL AI system.

Central intelligence coordinator that subscribes to ALL agent channels,
builds unified situation reports, assesses security posture, issues
directives, handles conflict resolution, manages shift handoffs, and
provides the operator chat interface.

This is the consolidated 12-agent architecture version of the orchestrator.
It coordinates the following subordinate agents:
  Perception tier : watcher, detector, tracker
  Reasoning tier  : threat_analyzer, investigator, correlator (not yet)
  Action tier     : responder, reporter, audio_sentinel,
                    environmental, access_guardian, red_team
"""
from __future__ import annotations

import json
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_CORTEX,
    CH_PERCEPTIONS,
    CH_THREATS,
    CH_ACTIONS,
    CH_INVESTIGATION,
    CH_ANOMALIES,
    CH_CORRELATION,
    CH_PREDICTIONS,
)
from backend.agents.agent_tools import SUPERVISOR_TOOLS

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Shift handoff interval in seconds (8 hours)
_SHIFT_INTERVAL_SECONDS = 8 * 60 * 60

# Security posture levels in ascending severity
_POSTURE_LEVELS = ("normal", "elevated", "high", "critical")

# The 11 subordinate agents in the consolidated architecture
_SUBORDINATE_AGENTS = (
    "watcher",
    "detector",
    "tracker",
    "threat_analyzer",
    "investigator",
    "responder",
    "reporter",
    "audio_sentinel",
    "environmental",
    "access_guardian",
    "red_team",
)


class SentinelCortexAgent(BaseAgent):
    """Central intelligence coordinator for the consolidated 12-agent fleet.

    Subscribes to every communication channel, fuses intelligence from all
    tiers, assesses the overall security posture, issues directives to the
    eleven subordinate agents, resolves inter-tier conflicts, manages
    eight-hour shift handoffs, and exposes an operator chat interface.
    """

    def __init__(self) -> None:
        super().__init__(
            name="sentinel_cortex",
            role="Supervisor \u2014 Central Intelligence Coordinator",
            description=(
                "Central brain of SENTINEL AI.  Receives intelligence from "
                "all tiers, synthesizes unified operational picture, assesses "
                "security posture, issues directives to the 11 subordinate "
                "agents, resolves conflicts, and serves as primary operator "
                "interface."
            ),
            tier="supervisor",
            model_name="gemma3:4b",
            tool_names=SUPERVISOR_TOOLS,
            subscriptions=[
                CH_PERCEPTIONS,
                CH_THREATS,
                CH_ACTIONS,
                CH_INVESTIGATION,
                CH_ANOMALIES,
                CH_CORRELATION,
                CH_PREDICTIONS,
            ],
            cycle_interval=30.0,
            token_budget_per_cycle=30000,
        )

    # ================================================================
    # Core reasoning loop
    # ================================================================

    async def think(self, context: dict) -> dict:
        """Central intelligence cycle.

        Steps executed every cycle:
        1. Group inbox messages by tier / channel.
        2. Build a compact situation report.
        3. Use LLM to assess security posture (normal / elevated / high / critical).
        4. Issue directives to specific subordinate agents.
        5. Resolve conflicts between perception and reasoning tiers.
        6. Check shift handoff scheduling (8-hour intervals).
        7. Persist security_posture in short-term memory.
        """
        inbox = context.get("inbox_messages", [])

        # 1. Group messages by tier / channel
        grouped = self._group_messages(inbox)

        # 2-4. Situation assessment and directive generation
        assessment = await self._assess_situation(grouped, context)

        # 5. Conflict resolution
        await self._resolve_conflicts(grouped)

        # 6. Shift handoff scheduling
        await self._check_shift_timing()

        return assessment

    # ================================================================
    # Message grouping
    # ================================================================

    @staticmethod
    def _group_messages(inbox: list[dict]) -> dict[str, list[dict]]:
        """Group inbox messages by originating tier and channel."""
        groups: dict[str, list[dict]] = {
            "perception": [],
            "reasoning": [],
            "action": [],
            "anomaly": [],
            "correlation": [],
            "prediction": [],
            "investigation": [],
            "other": [],
        }
        channel_map: dict[str, str] = {
            CH_PERCEPTIONS: "perception",
            CH_THREATS: "reasoning",
            CH_ACTIONS: "action",
            CH_ANOMALIES: "anomaly",
            CH_CORRELATION: "correlation",
            CH_PREDICTIONS: "prediction",
            CH_INVESTIGATION: "investigation",
        }
        for msg in inbox:
            channel = msg.get("_channel", "")
            tier = msg.get("tier", "")
            group_key = channel_map.get(channel, tier if tier in groups else "other")
            groups[group_key].append(msg)
        return groups

    # ================================================================
    # Situation assessment
    # ================================================================

    async def _assess_situation(
        self, grouped: dict[str, list[dict]], context: dict
    ) -> dict:
        """Build a situation report and ask the LLM for posture + directives."""

        # ---- Build compact situation summary ----
        sitrep_parts: list[str] = []
        total_messages = 0

        for tier_name, messages in grouped.items():
            if not messages:
                continue
            total_messages += len(messages)
            summaries: list[str] = []
            for m in messages[-5:]:  # last 5 per tier to stay within context
                desc = (
                    m.get("description")
                    or m.get("summary")
                    or m.get("response_summary", "")
                )
                summaries.append(
                    f"  - [{m.get('from_agent', '?')}] "
                    f"{m.get('type', '?')}: {str(desc)[:150]}"
                )
            sitrep_parts.append(
                f"=== {tier_name.upper()} TIER ({len(messages)} messages) ===\n"
                + "\n".join(summaries)
            )

        sitrep = (
            "\n\n".join(sitrep_parts) if sitrep_parts
            else "(No new messages this cycle)"
        )

        # ---- Retrieve current posture from memory ----
        current_posture: dict[str, Any] = await self.recall("security_posture") or {
            "level": "normal",
            "reasoning": "Initial state",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # ---- Optional compliance enrichment ----
        intel_summary = ""
        try:
            from backend.services.compliance_auditor import compliance_auditor
            violations = compliance_auditor.get_violations(status="open")
            if violations:
                intel_summary += (
                    f"\n=== COMPLIANCE VIOLATIONS ({len(violations)} open) ===\n"
                )
                for v in violations[:3]:
                    intel_summary += (
                        f"  [{v.get('severity', '?').upper()}] "
                        f"{v.get('rule_name', '?')}: "
                        f"{v.get('description', '')[:100]}\n"
                    )
        except Exception:
            pass  # Compliance service may not be available

        intel_block = f"\n{intel_summary}\n" if intel_summary else ""

        # ---- Build the LLM prompt ----
        prompt = (
            "You are SENTINEL CORTEX, the central intelligence coordinator of "
            "the SENTINEL AI autonomous physical security system.\n\n"
            "CONSOLIDATED ARCHITECTURE (12 agents total):\n"
            "  Perception : watcher, detector, tracker\n"
            "  Reasoning  : threat_analyzer, investigator\n"
            "  Action     : responder, reporter, audio_sentinel, "
            "environmental, access_guardian, red_team\n"
            "  Supervisor : sentinel_cortex (you)\n\n"
            f"CURRENT SECURITY POSTURE: "
            f"{current_posture.get('level', 'normal').upper()}\n"
            f"Posture reasoning: {current_posture.get('reasoning', 'N/A')}\n\n"
            f"SITUATION REPORT FROM YOUR AGENT TEAM "
            f"({total_messages} messages):\n\n"
            f"{sitrep}\n\n"
            f"{intel_block}"
            "INSTRUCTIONS:\n"
            "1. First, call get_alert_history to get current active alerts.\n"
            "2. Call get_threat_statistics to understand the threat landscape.\n"
            "3. Based on ALL available information (including intelligence "
            "enrichments from posture scoring, predictive analytics, "
            "compliance monitoring, and threat graph), provide:\n\n"
            "   (a) OVERALL SECURITY POSTURE: Rate as "
            "normal / elevated / high / critical.\n"
            "       Provide clear reasoning for the rating.\n\n"
            "   (b) COORDINATED THREATS: Are any reported events connected?\n"
            "       Look for patterns across cameras, similar threat types, or "
            "temporal clustering that suggests coordinated activity.\n\n"
            "   (c) PREDICTIVE AWARENESS: Based on temporal patterns, what "
            "threats are most likely in the next 1-2 hours?\n\n"
            "   (d) ACTIONS NEEDED: What specific actions should be taken?\n"
            "       Be concrete \u2014 name the agent that should act and what it "
            "should do.\n\n"
            "   (e) AGENT DIRECTIVES: Issue directives to subordinate agents.\n"
            "       Format each as:\n"
            "       DIRECTIVE: [target_agent] \u2014 [specific instruction]\n"
            "       Valid targets: " + ", ".join(_SUBORDINATE_AGENTS) + "\n\n"
            "4. If the posture has changed from the current level, explain why.\n"
            "5. If there are NO threats and the system is quiet, simply confirm "
            "normal operations and keep the posture at its current level.\n\n"
            "Respond with a structured assessment.  Be decisive \u2014 you are the "
            "final authority on security decisions."
        )

        result = await self.execute_tool_loop(prompt, {
            "cycle": context.get("cycle", 0),
            "current_time": datetime.now(timezone.utc).isoformat(),
            "current_posture": current_posture,
            "message_counts": {k: len(v) for k, v in grouped.items()},
        })

        response_text = result.get("response", "")

        # ---- Parse and update security posture ----
        new_posture = self._parse_posture(response_text, current_posture)
        await self.remember("security_posture", new_posture, ttl=600)

        # ---- Parse and publish directives ----
        directives = self._parse_directives(response_text)
        for directive in directives:
            target = directive.get("target", "all")
            await self.send_message(CH_CORTEX, {
                "type": "directive",
                "target_agent": target,
                "directive": directive.get("instruction", ""),
                "posture": new_posture.get("level", "normal"),
                "details": {
                    "assessment_summary": response_text[:500],
                    "posture": new_posture,
                },
            })

        # Always publish a posture update so agents stay informed
        if not directives:
            await self.send_message(CH_CORTEX, {
                "type": "posture_update",
                "posture": new_posture.get("level", "normal"),
                "reasoning": new_posture.get("reasoning", ""),
                "assessment_summary": response_text[:500],
            })

        await self.log_action("situation_assessment", {
            "posture": new_posture.get("level", "normal"),
            "total_messages": total_messages,
            "directives_issued": len(directives),
            "response_summary": response_text[:300],
            "tool_calls_count": len(result.get("tool_calls", [])),
        })

        return {
            "posture": new_posture,
            "messages_processed": total_messages,
            "directives_issued": len(directives),
        }

    # ================================================================
    # Conflict resolution
    # ================================================================

    async def _resolve_conflicts(self, grouped: dict[str, list[dict]]) -> None:
        """Resolve disagreements between perception and reasoning tiers.

        If perception reports a threat that reasoning dismisses (or vice
        versa), the Cortex makes the authoritative final determination.
        """
        perception_threats = [
            m for m in grouped.get("perception", [])
            if m.get("type") in (
                "threat_detected", "anomaly_detected", "crowd_alert",
                "intrusion_detected", "tamper_detected",
            )
        ]
        reasoning_assessments = [
            m for m in grouped.get("reasoning", [])
            if m.get("type") in (
                "threat_assessment", "threat_dismissed", "false_positive",
            )
        ]

        if not perception_threats or not reasoning_assessments:
            return  # No potential conflicts

        # Find cameras where reasoning dismissed an active perception
        dismissed_cameras: set[str] = set()
        for ra in reasoning_assessments:
            if ra.get("type") in ("threat_dismissed", "false_positive"):
                cam = ra.get("camera_id", "")
                if cam:
                    dismissed_cameras.add(cam)

        conflicting_threats = [
            pt for pt in perception_threats
            if pt.get("camera_id", "") in dismissed_cameras
        ]

        if not conflicting_threats:
            return

        conflict_summary = json.dumps(
            {
                "perception_says": [
                    {
                        "camera": t.get("camera_id"),
                        "type": t.get("type"),
                        "from_agent": t.get("from_agent"),
                        "description": str(t.get("description", ""))[:200],
                    }
                    for t in conflicting_threats[:3]
                ],
                "reasoning_says": [
                    {
                        "camera": r.get("camera_id"),
                        "type": r.get("type"),
                        "from_agent": r.get("from_agent"),
                        "description": str(r.get("description", ""))[:200],
                    }
                    for r in reasoning_assessments[:3]
                    if r.get("camera_id") in dismissed_cameras
                ],
            },
            default=str,
        )

        prompt = (
            "CONFLICT RESOLUTION REQUIRED.\n\n"
            "The perception tier has detected threats that the reasoning tier "
            "has dismissed or classified as false positives.\n\n"
            f"CONFLICT DETAILS:\n{conflict_summary}\n\n"
            "As SENTINEL CORTEX, you must make the final determination:\n"
            "1. Review the conflicting assessments.\n"
            "2. Use get_alert_history and get_event_history to check for "
            "corroborating evidence.\n"
            "3. Decide: Is this a REAL threat or a FALSE POSITIVE?\n"
            "4. If real, issue a directive to the responder to take action.\n"
            "5. If false positive, confirm the dismissal and log reasoning.\n\n"
            "Err on the side of caution \u2014 if uncertain, treat as real."
        )

        result = await self.execute_tool_loop(prompt)

        await self.send_message(CH_CORTEX, {
            "type": "conflict_resolution",
            "resolution": result.get("response", "")[:500],
            "conflicts_resolved": len(conflicting_threats),
        })

        await self.log_action("conflict_resolution", {
            "conflicts": len(conflicting_threats),
            "response_summary": result.get("response", "")[:300],
        })

    # ================================================================
    # Shift handoff scheduling
    # ================================================================

    async def _check_shift_timing(self) -> None:
        """Track shift timing and request handoff report at 8-hour intervals."""
        last_shift_ts = await self.recall("cortex_last_shift_ts")
        now = time.time()

        if last_shift_ts is not None:
            try:
                elapsed = now - float(last_shift_ts)
            except (ValueError, TypeError):
                elapsed = _SHIFT_INTERVAL_SECONDS + 1
        else:
            # First run \u2014 initialise the timer
            await self.remember(
                "cortex_last_shift_ts", now,
                ttl=_SHIFT_INTERVAL_SECONDS + 3600,
            )
            return

        if elapsed < _SHIFT_INTERVAL_SECONDS:
            return

        logger.info("SentinelCortex: triggering shift handoff report")

        await self.send_message(CH_CORTEX, {
            "type": "report_request",
            "target_agent": "reporter",
            "report_type": "shift_handoff",
            "time_range_hours": 8,
            "directive": (
                "Generate a comprehensive shift handoff report covering the "
                "last 8 hours.  Include threat summary, alert statistics, "
                "notable incidents, system health, and recommendations for "
                "the incoming shift."
            ),
        })

        await self.remember(
            "cortex_last_shift_ts", now,
            ttl=_SHIFT_INTERVAL_SECONDS + 3600,
        )

        await self.log_action("shift_handoff_trigger", {
            "elapsed_hours": round(elapsed / 3600, 1),
        })

    # ================================================================
    # Operator chat interface
    # ================================================================

    async def handle_operator_chat(self, query: str) -> dict:
        """Handle a natural-language query from a human operator.

        Uses the full SENTINEL CORTEX tool set to answer the query,
        pulling from alerts, events, cameras, zones, and agent memory
        as needed.

        Args:
            query: The operator's natural language question.

        Returns:
            dict with keys ``response``, ``tool_calls``, and ``posture``.
        """
        current_posture: dict[str, Any] = await self.recall("security_posture") or {
            "level": "normal",
            "reasoning": "No assessment yet",
        }

        prompt = (
            f'An operator has asked the following question:\n\n"{query}"\n\n'
            f"CURRENT SECURITY POSTURE: "
            f"{current_posture.get('level', 'normal')}\n\n"
            f"You are SENTINEL CORTEX with access to all system tools.  "
            f"Use your tools to gather the information needed to answer the "
            f"operator's question accurately and completely.\n\n"
            f"Guidelines:\n"
            f"- Be direct and concise in your answer.\n"
            f"- Include specific data points (alert counts, camera names, etc.).\n"
            f"- If the question is about a specific camera or zone, look up "
            f"its current status.\n"
            f"- If the question is about recent events, search event/alert "
            f"history.\n"
            f"- If the question is about an entity, use semantic search.\n"
            f"- Provide actionable recommendations when appropriate.\n"
            f"- If you cannot answer definitively, say so and explain what "
            f"additional information would be needed."
        )

        result = await self.execute_tool_loop(prompt, {
            "operator_query": query,
            "current_time": datetime.now(timezone.utc).isoformat(),
            "security_posture": current_posture,
        })

        await self.log_action("operator_chat", {
            "query": query[:300],
            "response_summary": result.get("response", "")[:300],
            "tool_calls_count": len(result.get("tool_calls", [])),
        })

        return {
            "response": result.get("response", ""),
            "tool_calls": result.get("tool_calls", []),
            "posture": current_posture,
        }

    # ================================================================
    # Parsing helpers
    # ================================================================

    @staticmethod
    def _parse_posture(response: str, current: dict) -> dict:
        """Extract security posture from the LLM assessment response."""
        response_lower = response.lower()
        new_level = current.get("level", "normal")

        # Search for explicit posture declarations (highest severity wins)
        for level in reversed(_POSTURE_LEVELS):
            markers = [
                f"posture: {level}",
                f"posture is {level}",
                f"security posture: {level}",
                f"rate as {level}",
                f"rating: {level}",
                f"assess as {level}",
                f"posture to {level}",
                f"posture at {level}",
            ]
            for marker in markers:
                if marker in response_lower:
                    new_level = level
                    break
            else:
                continue
            break

        # Extract reasoning line
        reasoning = current.get("reasoning", "")
        for line in response.split("\n"):
            line_lower = line.lower().strip()
            if any(
                kw in line_lower
                for kw in ["posture", "reasoning", "because", "due to", "based on"]
            ):
                if len(line.strip()) > 20:
                    reasoning = line.strip()[:300]
                    break

        return {
            "level": new_level,
            "reasoning": reasoning,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "previous_level": current.get("level", "normal"),
        }

    @staticmethod
    def _parse_directives(response: str) -> list[dict]:
        """Extract agent directives from the LLM assessment response.

        Recognised formats::

            DIRECTIVE: target_agent -- specific instruction
            DIRECTIVE: target_agent - specific instruction
        """
        directives: list[dict] = []
        for line in response.split("\n"):
            line_stripped = line.strip()
            if not line_stripped.upper().startswith("DIRECTIVE:"):
                continue
            content = line_stripped[len("DIRECTIVE:"):].strip()
            # Try em-dash first, then regular dash
            if " \u2014 " in content:
                parts = content.split(" \u2014 ", 1)
                target = parts[0].strip().lower().replace(" ", "_")
                instruction = parts[1].strip()
            elif " - " in content:
                parts = content.split(" - ", 1)
                target = parts[0].strip().lower().replace(" ", "_")
                instruction = parts[1].strip()
            else:
                target = "all"
                instruction = content

            # Validate target against known agents
            if target not in _SUBORDINATE_AGENTS and target != "all":
                # Try fuzzy match: e.g. "response_agent" -> "responder"
                logger.debug(
                    "Directive target '%s' not in subordinate list; "
                    "broadcasting to all",
                    target,
                )
                target = "all"

            directives.append({
                "target": target,
                "instruction": instruction,
            })
        return directives
