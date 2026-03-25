"""Responder Agent — Unified threat response, alert dispatch, and autonomous action execution.

Consolidates the Response Action, Dispatch, and Autonomous Response agents
into a single action-tier agent.  Translates threat assessments into concrete
response actions, routes alerts to appropriate operators with contextual
briefings, executes autonomous responses for critical threats when allowed,
and tracks response SLAs with automatic escalation.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_THREATS,
    CH_CORTEX,
    CH_ACTIONS,
)

logger = logging.getLogger(__name__)

# ── SLA thresholds in seconds ─────────────────────────────────────
_SLA_CRITICAL_SECONDS = 300    # 5 minutes
_SLA_HIGH_SECONDS = 900        # 15 minutes
_SLA_MEDIUM_SECONDS = 1800     # 30 minutes

# Auto-escalation after no acknowledgment
_AUTO_ESCALATE_SECONDS = 300   # 5 minutes

# Severity escalation map
_ESCALATION_MAP: dict[str, str] = {
    "low": "medium",
    "medium": "high",
    "high": "critical",
    "critical": "critical",
}

# Dispatch routing by severity
_DISPATCH_ROUTING: dict[str, str] = {
    "critical": "all_operators",
    "high": "supervisor,on_duty",
    "medium": "on_duty",
    "low": "shift_log",
}


class ResponderAgent(BaseAgent):
    """Unified threat response, alert dispatch, and SLA management.

    Combines three legacy agents (ResponseAction, Dispatch, Autonomous
    Response) into a single cohesive responder that handles the full
    lifecycle: receive threat -> decide response -> dispatch to operators
    -> track SLA -> auto-escalate.
    """

    def __init__(self) -> None:
        super().__init__(
            name="responder",
            role="Unified Threat Responder & Dispatch Coordinator",
            description=(
                "Translates threat assessments into concrete response "
                "actions, routes alerts to operators with contextual "
                "briefings, executes autonomous responses for critical "
                "threats when operation mode allows, and tracks response "
                "SLAs with automatic escalation of overdue alerts."
            ),
            tier="action",
            model_name="gemma3:4b",
            tool_names=[
                "create_alert",
                "escalate_alert",
                "update_alert_status",
                "send_notification",
                "trigger_recording",
                "get_alert_history",
            ],
            subscriptions=[CH_THREATS, CH_CORTEX],
            cycle_interval=10.0,
            token_budget_per_cycle=12000,
        )

    # ── Core reasoning loop ───────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Process threat events, dispatch alerts, and enforce SLAs.

        1. Drain inbox for threat messages, cortex directives, and ack events.
        2. For each threat, determine and execute the response.
        3. Dispatch alerts to appropriate operators.
        4. Track SLAs and auto-escalate overdue responses.
        """
        inbox = context.get("inbox_messages", [])
        cycle = context.get("cycle", 0)

        # Skip if nothing to do and not an SLA-check cycle
        if not inbox and cycle % 5 != 0:
            return {"status": "idle"}

        threats_processed = 0
        alerts_dispatched = 0

        # ── 1. Process inbox messages ─────────────────────────────
        for msg in inbox:
            msg_type = msg.get("type", "")
            channel = msg.get("_channel", "")

            # Threat events
            if channel == CH_THREATS or msg_type in (
                "threat_detected",
                "threat_assessment",
                "threat_update",
                "anomaly_confirmed",
            ):
                await self._handle_threat(msg, context)
                threats_processed += 1

            # Cortex directives
            elif channel == CH_CORTEX and msg_type == "directive":
                directive = msg.get("directive", "")
                if any(
                    kw in directive.lower()
                    for kw in [
                        "respond", "alert", "escalate", "notify",
                        "record", "dispatch", "route", "assign",
                    ]
                ):
                    await self._handle_cortex_directive(msg, context)
                    threats_processed += 1

            # Acknowledgment events
            elif msg_type in ("alert_acknowledged", "alert_resolved"):
                await self._handle_acknowledgment(msg)

        # ── 2. SLA compliance check ──────────────────────────────
        await self._check_sla_breaches()
        await self._check_auto_escalation()

        return {
            "status": "active" if threats_processed else "idle",
            "threats_processed": threats_processed,
            "alerts_dispatched": alerts_dispatched,
        }

    # ── Threat handling ──────────────────────────────────────────

    async def _handle_threat(
        self, threat_msg: dict, context: dict,
    ) -> None:
        """Determine and execute the right response for a threat, then
        dispatch the alert to operators."""
        severity = threat_msg.get("severity", "medium")
        threat_type = threat_msg.get(
            "threat_type", threat_msg.get("type", "unknown"),
        )
        camera_id = threat_msg.get("camera_id", "unknown")
        description = threat_msg.get(
            "description", threat_msg.get("summary", ""),
        )
        confidence = threat_msg.get("confidence", 0.5)
        from_agent = threat_msg.get("from_agent", "unknown")
        routing = _DISPATCH_ROUTING.get(severity, "on_duty")

        prompt = (
            f"A threat has been reported by agent '{from_agent}'.\n\n"
            f"THREAT DETAILS:\n"
            f"- Type: {threat_type}\n"
            f"- Severity: {severity}\n"
            f"- Camera: {camera_id}\n"
            f"- Confidence: {confidence}\n"
            f"- Description: {description}\n\n"
            f"RESPONSE TIERS:\n"
            f"  1. LOW    -> Log only, no alert needed.\n"
            f"  2. MEDIUM -> Create alert + trigger recording on camera.\n"
            f"  3. HIGH   -> Create alert + trigger recording + notify "
            f"operators (routing: {routing}) with contextual briefing.\n"
            f"  4. CRITICAL -> Full escalation: create alert, trigger "
            f"recording, notify ALL operators immediately, escalate.\n\n"
            f"DISPATCH INSTRUCTIONS:\n"
            f"- Use send_notification to dispatch with a CONTEXTUAL BRIEFING.\n"
            f"- Do NOT just say 'alert on camera'. Provide:\n"
            f"  * What was detected and where\n"
            f"  * Recommended immediate actions\n"
            f"  * Priority level and response deadline\n\n"
            f"Execute the appropriate tools for this threat. "
            f"Use camera_id '{camera_id}' in all tool calls."
        )

        result = await self.execute_tool_loop(prompt, {
            "threat": {
                k: v for k, v in threat_msg.items() if not k.startswith("_")
            },
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        # Track alert for SLA monitoring
        for tc in result.get("tool_calls", []):
            if tc["tool"] == "create_alert":
                try:
                    result_data = json.loads(tc.get("result_summary", "{}"))
                    alert_id = result_data.get("alert_id")
                    if alert_id:
                        await self._track_alert(alert_id, severity, camera_id)
                except (json.JSONDecodeError, TypeError):
                    pass

        # Publish response_executed
        await self.send_message(CH_ACTIONS, {
            "type": "response_executed",
            "threat_type": threat_type,
            "severity": severity,
            "camera_id": camera_id,
            "tool_calls": len(result.get("tool_calls", [])),
            "response_summary": result.get("response", "")[:500],
        })

        # Publish alert_dispatched
        await self.send_message(CH_ACTIONS, {
            "type": "alert_dispatched",
            "severity": severity,
            "camera_id": camera_id,
            "routing": routing,
            "dispatch_summary": result.get("response", "")[:300],
        })

        await self.log_action("threat_response", {
            "threat_type": threat_type,
            "severity": severity,
            "camera_id": camera_id,
            "tool_calls_count": len(result.get("tool_calls", [])),
            "response_summary": result.get("response", "")[:300],
        })

    # ── Cortex directive handling ────────────────────────────────

    async def _handle_cortex_directive(
        self, msg: dict, context: dict,
    ) -> None:
        """Execute a response directive from the Cortex supervisor."""
        directive = msg.get("directive", "")
        details = msg.get("details", {})

        prompt = (
            f"The SENTINEL CORTEX supervisor has issued a directive:\n\n"
            f"DIRECTIVE: {directive}\n"
            f"DETAILS: {json.dumps(details, default=str)[:2000]}\n\n"
            f"Execute the appropriate response and dispatch tools."
        )

        result = await self.execute_tool_loop(prompt, details)

        await self.send_message(CH_ACTIONS, {
            "type": "directive_executed",
            "directive": directive[:200],
            "tool_calls": len(result.get("tool_calls", [])),
            "response_summary": result.get("response", "")[:500],
        })

    # ── Alert tracking and acknowledgment ────────────────────────

    async def _track_alert(
        self, alert_id: str, severity: str, camera_id: str,
    ) -> None:
        """Track a newly created alert for SLA and escalation monitoring."""
        pending = await self.recall("tracked_alerts") or {}
        pending[alert_id] = {
            "created_at": time.time(),
            "severity": severity,
            "camera_id": camera_id,
            "acknowledged": False,
            "escalated": False,
            "reassigned": False,
            "reassign_count": 0,
        }
        # Prune to last 100 entries
        if len(pending) > 100:
            sorted_keys = sorted(
                pending.keys(),
                key=lambda k: pending[k].get("created_at", 0),
            )
            for old_key in sorted_keys[:-100]:
                del pending[old_key]
        await self.remember("tracked_alerts", pending, ttl=7200)

    async def _handle_acknowledgment(self, msg: dict) -> None:
        """Mark a tracked alert as acknowledged."""
        alert_id = msg.get("alert_id", "")
        if not alert_id:
            return

        tracked = await self.recall("tracked_alerts") or {}
        if alert_id in tracked:
            tracked[alert_id]["acknowledged"] = True
            tracked[alert_id]["acknowledged_at"] = time.time()
            await self.remember("tracked_alerts", tracked, ttl=7200)

            response_time = int(
                time.time() - tracked[alert_id].get("created_at", time.time())
            )
            await self.log_action("alert_acknowledged", {
                "alert_id": alert_id,
                "response_time_seconds": response_time,
            })

    # ── SLA breach detection ─────────────────────────────────────

    async def _check_sla_breaches(self) -> None:
        """Check dispatched alerts for SLA breaches and auto-reassign."""
        from backend.services.operation_mode import operation_mode_service
        if operation_mode_service.is_hitl():
            return

        tracked = await self.recall("tracked_alerts")
        if not tracked:
            return

        now = time.time()
        updated = False

        for alert_id, info in tracked.items():
            if info.get("acknowledged") or info.get("reassigned"):
                continue

            elapsed = now - info.get("created_at", now)
            severity = info.get("severity", "medium")

            sla_map = {
                "critical": _SLA_CRITICAL_SECONDS,
                "high": _SLA_HIGH_SECONDS,
                "medium": _SLA_MEDIUM_SECONDS,
            }
            threshold = sla_map.get(severity)
            if threshold is None or elapsed < threshold:
                continue

            # SLA breached — auto-reassign
            logger.warning(
                "responder: SLA breach for alert %s (severity=%s, "
                "elapsed=%ds, threshold=%ds)",
                alert_id, severity, int(elapsed), threshold,
            )

            prompt = (
                f"URGENT: SLA BREACH for alert {alert_id}.\n"
                f"Severity: {severity}\n"
                f"Camera: {info.get('camera_id', 'unknown')}\n"
                f"Time since dispatch: {int(elapsed)} seconds\n"
                f"SLA threshold: {threshold} seconds\n\n"
                f"Send an ESCALATION notification to ALL operators "
                f"('all_operators') with URGENT priority explaining "
                f"the SLA breach and requiring immediate response."
            )

            await self.execute_tool_loop(prompt)

            info["reassigned"] = True
            info["reassign_count"] = info.get("reassign_count", 0) + 1
            updated = True

            await self.send_message(CH_ACTIONS, {
                "type": "escalation",
                "subtype": "sla_breach_reassignment",
                "alert_id": alert_id,
                "severity": severity,
                "elapsed_seconds": int(elapsed),
                "sla_threshold": threshold,
            })

            await self.log_action("sla_breach", {
                "alert_id": alert_id,
                "severity": severity,
                "elapsed_seconds": int(elapsed),
                "sla_threshold": threshold,
            })

        if updated:
            await self.remember("tracked_alerts", tracked, ttl=7200)

    # ── Auto-escalation ──────────────────────────────────────────

    async def _check_auto_escalation(self) -> None:
        """Escalate severity of alerts unacknowledged past threshold."""
        from backend.services.operation_mode import operation_mode_service
        if operation_mode_service.is_hitl():
            return

        tracked = await self.recall("tracked_alerts")
        if not tracked:
            return

        now = time.time()
        updated = False

        for alert_id, info in tracked.items():
            if info.get("escalated") or info.get("acknowledged"):
                continue

            elapsed = now - info.get("created_at", now)
            if elapsed < _AUTO_ESCALATE_SECONDS:
                continue

            current_severity = info.get("severity", "medium")
            new_severity = _ESCALATION_MAP.get(current_severity, "critical")

            prompt = (
                f"Alert {alert_id} has been unacknowledged for "
                f"{int(elapsed)} seconds (threshold: "
                f"{_AUTO_ESCALATE_SECONDS}s).\n"
                f"Current severity: {current_severity}. "
                f"Camera: {info.get('camera_id')}.\n"
                f"Auto-escalate to '{new_severity}' severity and send "
                f"an urgent notification to all operators."
            )

            await self.execute_tool_loop(prompt)

            info["escalated"] = True
            updated = True

            await self.send_message(CH_ACTIONS, {
                "type": "escalation",
                "subtype": "auto_severity_escalation",
                "alert_id": alert_id,
                "old_severity": current_severity,
                "new_severity": new_severity,
                "elapsed_seconds": int(elapsed),
            })

            await self.log_action("auto_escalation", {
                "alert_id": alert_id,
                "old_severity": current_severity,
                "new_severity": new_severity,
                "elapsed_seconds": int(elapsed),
            })

        if updated:
            await self.remember("tracked_alerts", tracked, ttl=7200)
