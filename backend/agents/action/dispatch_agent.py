"""Dispatch Agent — Intelligent alert routing and operator assignment.

Routes alerts to the most appropriate operators with rich contextual
briefings instead of bare notifications.  Tracks acknowledgment SLAs and
auto-reassigns alerts that breach response deadlines (5 min for critical,
15 min for high).
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_ACTIONS, CH_CORTEX

logger = logging.getLogger(__name__)

# SLA thresholds in seconds
_SLA_CRITICAL_SECONDS = 300   # 5 minutes
_SLA_HIGH_SECONDS = 900       # 15 minutes
_SLA_MEDIUM_SECONDS = 1800    # 30 minutes


class DispatchAgent(BaseAgent):
    """Routes alerts to operators with context and tracks SLA compliance."""

    def __init__(self) -> None:
        super().__init__(
            name="dispatch_agent",
            role="Alert Dispatch & Routing Coordinator",
            description=(
                "Intelligently routes security alerts to the most appropriate "
                "operators based on severity, type, and current workload.  "
                "Provides rich contextual briefings rather than bare "
                "notifications.  Monitors acknowledgment SLAs and auto-reassigns "
                "unacknowledged alerts that breach response deadlines."
            ),
            tier="action",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "send_notification",
                "get_alert_history",
                "update_alert_status",
            ],
            subscriptions=[CH_ACTIONS, CH_CORTEX],
            cycle_interval=5.0,
            token_budget_per_cycle=10000,
        )

    # ── Core reasoning loop ────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Process dispatch requests and monitor SLA compliance.

        1. Handle incoming dispatch requests from CH_ACTIONS / CH_CORTEX.
        2. Check dispatched alerts for SLA breaches and auto-reassign.
        """
        inbox = context.get("inbox_messages", [])
        dispatched_count = 0

        # ----------------------------------------------------------
        # 1. Process incoming dispatch requests
        # ----------------------------------------------------------
        for msg in inbox:
            msg_type = msg.get("type", "")
            channel = msg.get("_channel", "")

            # Pick up new alerts and response actions that need dispatching
            if msg_type in (
                "response_executed",
                "alert_auto_escalated",
                "dispatch_request",
            ):
                await self._dispatch_alert(msg, context)
                dispatched_count += 1

            # Cortex directives for dispatch
            elif channel == CH_CORTEX and msg_type == "directive":
                directive = msg.get("directive", "")
                if any(
                    kw in directive.lower()
                    for kw in ["dispatch", "notify", "route", "assign"]
                ):
                    await self._handle_cortex_dispatch(msg, context)
                    dispatched_count += 1

            # Track acknowledgment events
            elif msg_type in ("alert_acknowledged", "alert_resolved"):
                await self._handle_acknowledgment(msg)

        # ----------------------------------------------------------
        # 2. SLA compliance check (every cycle)
        # ----------------------------------------------------------
        await self._check_sla_breaches()

        return {"dispatched": dispatched_count}

    # ── Alert dispatch ─────────────────────────────────────────

    async def _dispatch_alert(self, msg: dict, context: dict) -> None:
        """Route an alert to the appropriate operator(s) with full context."""
        severity = msg.get("severity", "medium")
        threat_type = msg.get("threat_type", msg.get("type", "security_alert"))
        camera_id = msg.get("camera_id", "unknown")
        description = msg.get("response_summary", msg.get("description", ""))
        alert_id = msg.get("alert_id", "")

        prompt = (
            f"An alert needs to be dispatched to security operators.\n\n"
            f"ALERT DETAILS:\n"
            f"- Alert ID: {alert_id}\n"
            f"- Severity: {severity}\n"
            f"- Type: {threat_type}\n"
            f"- Camera: {camera_id}\n"
            f"- Description: {description}\n\n"
            f"INSTRUCTIONS:\n"
            f"1. First, use get_alert_history to check recent alerts for context "
            f"(is this part of a pattern? are there related active alerts?).\n"
            f"2. Determine the best routing:\n"
            f"   - CRITICAL: All operators immediately ('all_operators')\n"
            f"   - HIGH: On-duty supervisor + nearest operator ('supervisor,on_duty')\n"
            f"   - MEDIUM: On-duty operator ('on_duty')\n"
            f"   - LOW: Shift log only ('shift_log')\n"
            f"3. Send a notification with a CONTEXTUAL BRIEFING. Do NOT just say "
            f"'Alert on camera 3'. Instead provide:\n"
            f"   - What was detected and where\n"
            f"   - Whether this is part of a pattern (based on alert history)\n"
            f"   - Recommended immediate actions\n"
            f"   - Priority level and response deadline\n\n"
            f"Use send_notification to dispatch. Set the severity appropriately."
        )

        result = await self.execute_tool_loop(prompt, {
            "alert": msg,
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        # Track the dispatched alert for SLA monitoring
        await self._track_dispatched_alert(
            alert_id or f"dispatch_{int(time.time())}",
            severity,
            camera_id,
        )

        # Publish dispatch confirmation
        await self.send_message(CH_ACTIONS, {
            "type": "alert_dispatched",
            "alert_id": alert_id,
            "severity": severity,
            "camera_id": camera_id,
            "tool_calls": len(result.get("tool_calls", [])),
            "dispatch_summary": result.get("response", "")[:300],
        })

        await self.log_action("alert_dispatched", {
            "alert_id": alert_id,
            "severity": severity,
            "camera_id": camera_id,
            "response_summary": result.get("response", "")[:300],
        })

    # ── Cortex dispatch directive ──────────────────────────────

    async def _handle_cortex_dispatch(self, msg: dict, context: dict) -> None:
        """Handle a dispatch directive from the Cortex supervisor."""
        directive = msg.get("directive", "")
        details = msg.get("details", {})

        prompt = (
            f"The SENTINEL CORTEX supervisor has issued a dispatch directive:\n\n"
            f"DIRECTIVE: {directive}\n"
            f"DETAILS: {json.dumps(details, default=str)[:2000]}\n\n"
            f"Route this according to the directive.  Use get_alert_history for "
            f"context, then send_notification with a rich contextual briefing."
        )

        result = await self.execute_tool_loop(prompt, details)

        await self.send_message(CH_ACTIONS, {
            "type": "cortex_dispatch_executed",
            "directive": directive[:200],
            "tool_calls": len(result.get("tool_calls", [])),
        })

    # ── Acknowledgment tracking ────────────────────────────────

    async def _handle_acknowledgment(self, msg: dict) -> None:
        """Mark a dispatched alert as acknowledged."""
        alert_id = msg.get("alert_id", "")
        if not alert_id:
            return

        dispatched = await self.recall("dispatched_alerts") or {}
        if alert_id in dispatched:
            dispatched[alert_id]["acknowledged"] = True
            dispatched[alert_id]["acknowledged_at"] = time.time()
            await self.remember("dispatched_alerts", dispatched, ttl=7200)

            await self.log_action("alert_acknowledged", {
                "alert_id": alert_id,
                "response_time_seconds": int(
                    time.time() - dispatched[alert_id].get("dispatched_at", time.time())
                ),
            })

    async def _track_dispatched_alert(
        self, alert_id: str, severity: str, camera_id: str
    ) -> None:
        """Track a dispatched alert for SLA monitoring."""
        dispatched = await self.recall("dispatched_alerts") or {}
        dispatched[alert_id] = {
            "dispatched_at": time.time(),
            "severity": severity,
            "camera_id": camera_id,
            "acknowledged": False,
            "reassigned": False,
            "reassign_count": 0,
        }
        # Prune old entries (keep last 100)
        if len(dispatched) > 100:
            sorted_keys = sorted(
                dispatched.keys(),
                key=lambda k: dispatched[k].get("dispatched_at", 0),
            )
            for old_key in sorted_keys[:-100]:
                del dispatched[old_key]
        await self.remember("dispatched_alerts", dispatched, ttl=7200)

    # ── SLA breach detection and auto-reassignment ─────────────

    async def _check_sla_breaches(self) -> None:
        """Check all dispatched alerts for SLA breaches and auto-reassign."""
        from backend.services.operation_mode import operation_mode_service
        if operation_mode_service.is_hitl():
            return  # SLA auto-reassignment suppressed in HITL mode

        dispatched = await self.recall("dispatched_alerts")
        if not dispatched:
            return

        now = time.time()
        updated = False

        for alert_id, info in dispatched.items():
            if info.get("acknowledged") or info.get("reassigned"):
                continue

            elapsed = now - info.get("dispatched_at", now)
            severity = info.get("severity", "medium")

            # Determine SLA threshold
            sla_map = {
                "critical": _SLA_CRITICAL_SECONDS,
                "high": _SLA_HIGH_SECONDS,
                "medium": _SLA_MEDIUM_SECONDS,
            }
            threshold = sla_map.get(severity)
            if threshold is None:
                continue  # low severity has no SLA

            if elapsed < threshold:
                continue

            # SLA breached — auto-reassign
            logger.warning(
                "DispatchAgent: SLA breach for alert %s (severity=%s, elapsed=%ds, threshold=%ds)",
                alert_id, severity, int(elapsed), threshold,
            )

            prompt = (
                f"URGENT: SLA BREACH for alert {alert_id}.\n"
                f"Severity: {severity}\n"
                f"Camera: {info.get('camera_id', 'unknown')}\n"
                f"Time since dispatch: {int(elapsed)} seconds\n"
                f"SLA threshold: {threshold} seconds\n\n"
                f"This alert has NOT been acknowledged within the SLA window.\n"
                f"1. Send an ESCALATION notification to ALL operators ('all_operators') "
                f"with URGENT priority explaining the SLA breach.\n"
                f"2. The message must state this is a REASSIGNMENT due to SLA breach "
                f"and requires immediate response.\n"
                f"3. Update the alert status to reflect the SLA breach if possible."
            )

            result = await self.execute_tool_loop(prompt)

            info["reassigned"] = True
            info["reassign_count"] = info.get("reassign_count", 0) + 1
            updated = True

            await self.send_message(CH_ACTIONS, {
                "type": "sla_breach_reassignment",
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
            await self.remember("dispatched_alerts", dispatched, ttl=7200)
