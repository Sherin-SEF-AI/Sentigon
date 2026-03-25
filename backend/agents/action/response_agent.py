"""Response Action Agent — Translates threat assessments into concrete response actions.

Listens on CH_THREATS and CH_CORTEX for incoming threat events and supervisor
directives.  For each threat it consults Gemini to determine the appropriate
response (log only, create alert + record, notify operators, or full critical
escalation) and then executes that response via tools.  Unacknowledged alerts
are tracked and auto-escalated after 5 minutes.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_THREATS, CH_CORTEX, CH_ACTIONS

logger = logging.getLogger(__name__)

# Auto-escalation threshold in seconds
_AUTO_ESCALATE_SECONDS = 300  # 5 minutes


class ResponseActionAgent(BaseAgent):
    """Converts threat intelligence into actionable security responses."""

    def __init__(self) -> None:
        super().__init__(
            name="response_agent",
            role="Response Action Coordinator",
            description=(
                "Translates threat assessments from reasoning-tier agents into "
                "concrete security responses.  Determines response severity, "
                "creates alerts, triggers recordings, notifies operators, and "
                "auto-escalates unacknowledged critical alerts."
            ),
            tier="action",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "create_alert",
                "escalate_alert",
                "update_alert_status",
                "send_notification",
                "trigger_recording",
            ],
            subscriptions=[CH_THREATS, CH_CORTEX],
            cycle_interval=2.0,
            token_budget_per_cycle=10000,
        )

    # ── Core reasoning loop ────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Process threat events and generate appropriate responses.

        1. Drain inbox for threat messages and cortex directives.
        2. For each threat, ask Gemini what response to take.
        3. Execute the response via tools.
        4. Track unacknowledged alerts and auto-escalate after 5 min.
        """
        inbox = context.get("inbox_messages", [])
        if not inbox and context.get("cycle", 0) % 5 != 0:
            # Nothing in inbox and not an escalation-check cycle — skip
            return {"action": "idle"}

        # ----------------------------------------------------------
        # 1. Process incoming threat events
        # ----------------------------------------------------------
        threats_processed = 0

        for msg in inbox:
            msg_type = msg.get("type", "")
            channel = msg.get("_channel", "")

            # Only process threat-related messages
            if channel == CH_THREATS or msg_type in (
                "threat_detected",
                "threat_assessment",
                "threat_update",
                "anomaly_confirmed",
            ):
                await self._handle_threat(msg, context)
                threats_processed += 1

            # Cortex directives (e.g. "create alert for …")
            elif channel == CH_CORTEX and msg_type == "directive":
                directive = msg.get("directive", "")
                if any(
                    kw in directive.lower()
                    for kw in ["respond", "alert", "escalate", "notify", "record"]
                ):
                    await self._handle_cortex_directive(msg, context)

        # ----------------------------------------------------------
        # 2. Auto-escalation check for unacknowledged alerts
        # ----------------------------------------------------------
        await self._check_auto_escalation()

        return {"threats_processed": threats_processed}

    # ── Threat handling ────────────────────────────────────────

    async def _handle_threat(self, threat_msg: dict, context: dict) -> None:
        """Determine and execute the right response for a single threat."""
        severity = threat_msg.get("severity", "medium")
        threat_type = threat_msg.get("threat_type", threat_msg.get("type", "unknown"))
        camera_id = threat_msg.get("camera_id", "unknown")
        description = threat_msg.get("description", threat_msg.get("summary", ""))
        confidence = threat_msg.get("confidence", 0.5)
        from_agent = threat_msg.get("from_agent", "unknown")

        prompt = (
            f"A threat has been reported by agent '{from_agent}'.\n\n"
            f"THREAT DETAILS:\n"
            f"- Type: {threat_type}\n"
            f"- Severity: {severity}\n"
            f"- Camera: {camera_id}\n"
            f"- Confidence: {confidence}\n"
            f"- Description: {description}\n\n"
            f"Based on the severity and type, determine the appropriate response.\n"
            f"Response tiers:\n"
            f"  1. LOW severity  -> Log only, no alert needed.\n"
            f"  2. MEDIUM severity -> Create alert + trigger recording on camera.\n"
            f"  3. HIGH severity -> Create alert + trigger recording + notify "
            f"operators with contextual briefing.\n"
            f"  4. CRITICAL severity -> Full escalation: create alert, trigger "
            f"recording, notify ALL operators immediately, escalate to highest "
            f"priority.\n\n"
            f"Execute the appropriate tools for this threat. Use the exact "
            f"camera_id '{camera_id}' in all tool calls. For notifications, "
            f"provide a contextual briefing — not just 'alert on camera' but a "
            f"full description of the threat, its location, and recommended "
            f"immediate actions."
        )

        result = await self.execute_tool_loop(prompt, {
            "threat": threat_msg,
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        # Track alert if one was created (extract from tool calls)
        for tc in result.get("tool_calls", []):
            if tc["tool"] == "create_alert":
                try:
                    result_data = json.loads(tc.get("result_summary", "{}"))
                    alert_id = result_data.get("alert_id")
                    if alert_id:
                        await self._track_pending_alert(alert_id, severity, camera_id)
                except (json.JSONDecodeError, TypeError):
                    pass

        # Publish action summary to CH_ACTIONS
        await self.send_message(CH_ACTIONS, {
            "type": "response_executed",
            "threat_type": threat_type,
            "severity": severity,
            "camera_id": camera_id,
            "tool_calls": len(result.get("tool_calls", [])),
            "response_summary": result.get("response", "")[:500],
        })

        await self.log_action("threat_response", {
            "threat_type": threat_type,
            "severity": severity,
            "camera_id": camera_id,
            "tool_calls_count": len(result.get("tool_calls", [])),
            "response_summary": result.get("response", "")[:300],
        })

    # ── Cortex directive handling ──────────────────────────────

    async def _handle_cortex_directive(self, msg: dict, context: dict) -> None:
        """Execute a response directive from the Sentinel Cortex supervisor."""
        directive = msg.get("directive", "")
        details = msg.get("details", {})

        prompt = (
            f"The SENTINEL CORTEX supervisor has issued a directive:\n\n"
            f"DIRECTIVE: {directive}\n"
            f"DETAILS: {json.dumps(details, default=str)[:2000]}\n\n"
            f"Execute the appropriate response tools to fulfill this directive."
        )

        result = await self.execute_tool_loop(prompt, details)

        await self.send_message(CH_ACTIONS, {
            "type": "directive_executed",
            "directive": directive[:200],
            "tool_calls": len(result.get("tool_calls", [])),
            "response_summary": result.get("response", "")[:500],
        })

    # ── Auto-escalation tracking ──────────────────────────────

    async def _track_pending_alert(
        self, alert_id: str, severity: str, camera_id: str
    ) -> None:
        """Track a newly created alert for auto-escalation monitoring."""
        pending = await self.recall("pending_alerts") or {}
        pending[alert_id] = {
            "created_at": time.time(),
            "severity": severity,
            "camera_id": camera_id,
            "escalated": False,
        }
        # Keep only the most recent 50 to avoid unbounded growth
        if len(pending) > 50:
            sorted_keys = sorted(
                pending.keys(),
                key=lambda k: pending[k].get("created_at", 0),
            )
            for old_key in sorted_keys[:-50]:
                del pending[old_key]
        await self.remember("pending_alerts", pending, ttl=3600)

    async def _check_auto_escalation(self) -> None:
        """Auto-escalate alerts that remain unacknowledged past the threshold."""
        from backend.services.operation_mode import operation_mode_service
        if operation_mode_service.is_hitl():
            return  # Auto-escalation suppressed in HITL mode

        pending = await self.recall("pending_alerts")
        if not pending:
            return

        now = time.time()
        escalated_ids = []

        for alert_id, info in pending.items():
            if info.get("escalated"):
                continue
            elapsed = now - info.get("created_at", now)
            if elapsed < _AUTO_ESCALATE_SECONDS:
                continue

            # This alert has been unacknowledged for too long — escalate
            current_severity = info.get("severity", "medium")
            escalation_map = {
                "low": "medium",
                "medium": "high",
                "high": "critical",
                "critical": "critical",
            }
            new_severity = escalation_map.get(current_severity, "critical")

            prompt = (
                f"Alert {alert_id} has been unacknowledged for "
                f"{int(elapsed)} seconds (threshold: {_AUTO_ESCALATE_SECONDS}s).\n"
                f"Current severity: {current_severity}. Camera: {info.get('camera_id')}.\n"
                f"Auto-escalate this alert to '{new_severity}' severity and "
                f"send an urgent notification to all operators explaining the "
                f"unacknowledged alert requires immediate attention."
            )

            result = await self.execute_tool_loop(prompt)

            info["escalated"] = True
            escalated_ids.append(alert_id)

            await self.log_action("auto_escalation", {
                "alert_id": alert_id,
                "old_severity": current_severity,
                "new_severity": new_severity,
                "elapsed_seconds": int(elapsed),
            })

            await self.send_message(CH_ACTIONS, {
                "type": "alert_auto_escalated",
                "alert_id": alert_id,
                "old_severity": current_severity,
                "new_severity": new_severity,
                "elapsed_seconds": int(elapsed),
            })

        # Update memory with escalation flags
        if escalated_ids:
            await self.remember("pending_alerts", pending, ttl=3600)
