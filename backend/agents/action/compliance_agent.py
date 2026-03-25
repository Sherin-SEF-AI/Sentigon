"""Compliance Agent — System health and compliance monitoring.

Continuously monitors camera health, coverage gaps, SLA compliance for
unacknowledged alerts, and overall system integrity.  Creates alerts for
compliance issues and stores health observations in long-term memory for
trend analysis.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_ACTIONS

logger = logging.getLogger(__name__)


class ComplianceAgent(BaseAgent):
    """Monitors system health, coverage gaps, and SLA compliance."""

    def __init__(self) -> None:
        super().__init__(
            name="compliance_agent",
            role="System Health & Compliance Monitor",
            description=(
                "Monitors the overall health of the SENTINEL AI system "
                "including camera online/offline status, zone coverage gaps, "
                "SLA compliance for unacknowledged alerts, and operational "
                "integrity.  Creates alerts for compliance failures and stores "
                "health observations for long-term trend analysis."
            ),
            tier="action",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "get_all_cameras_status",
                "get_all_zones_status",
                "get_alert_history",
                "get_threat_statistics",
                "recall_observations",
                "store_observation",
                "create_alert",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=60.0,
            token_budget_per_cycle=10000,
        )

    # ── Core reasoning loop ────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Perform system health and compliance checks.

        1. Check camera health — alert if cameras are offline.
        2. Check coverage gaps — zones without recent analysis.
        3. Monitor SLA — unacknowledged critical/high alerts.
        4. Use Gemini to synthesize a health assessment.
        5. Store health observations for trend tracking.
        """
        inbox = context.get("inbox_messages", [])

        # Handle any Cortex directives first
        for msg in inbox:
            if msg.get("type") == "directive":
                directive = msg.get("directive", "")
                if any(
                    kw in directive.lower()
                    for kw in ["health", "compliance", "status", "camera", "system"]
                ):
                    await self._handle_cortex_directive(msg, context)

        # Perform the main compliance check
        health_result = await self._perform_health_check(context)

        return health_result

    # ── Main health check ──────────────────────────────────────

    async def _perform_health_check(self, context: dict) -> dict:
        """Run a comprehensive health and compliance assessment."""
        prompt = (
            "Perform a comprehensive system health and compliance check.\n\n"
            "INSTRUCTIONS — execute these checks in order:\n\n"
            "1. CAMERA HEALTH: Call get_all_cameras_status.\n"
            "   - Flag any cameras that are OFFLINE or in ERROR state.\n"
            "   - If any camera is offline, create an alert with:\n"
            "     severity='medium', threat_type='system_health',\n"
            "     description explaining which camera(s) are down.\n\n"
            "2. ZONE COVERAGE: Call get_all_zones_status.\n"
            "   - Identify zones that may lack active camera coverage.\n"
            "   - Flag any zones that are over capacity.\n\n"
            "3. ALERT SLA: Call get_alert_history with status='new' to find\n"
            "   unacknowledged alerts.\n"
            "   - CRITICAL alerts unacknowledged > 5 minutes = SLA violation.\n"
            "   - HIGH alerts unacknowledged > 15 minutes = SLA violation.\n"
            "   - If SLA violations found, create a compliance alert with\n"
            "     severity='high', threat_type='sla_violation'.\n\n"
            "4. THREAT POSTURE: Call get_threat_statistics to understand the\n"
            "   current threat landscape.\n\n"
            "5. HISTORICAL CONTEXT: Call recall_observations with\n"
            "   category='system_health' to see recent health trends.\n\n"
            "6. ASSESSMENT: Synthesize all findings into a health assessment:\n"
            "   - Overall system status (healthy / degraded / critical)\n"
            "   - Specific issues found\n"
            "   - Recommendations\n\n"
            "7. STORE: Call store_observation to record this health check\n"
            "   result with category='system_health'. Include the overall\n"
            "   status, camera count, offline cameras, SLA violations, and\n"
            "   threat summary in the observation text.\n\n"
            "Only create alerts for actual issues found (offline cameras, "
            "SLA violations, over-capacity zones). Do NOT create alerts if "
            "everything is healthy."
        )

        result = await self.execute_tool_loop(prompt, {
            "cycle": context.get("cycle", 0),
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        # Parse the health assessment from Gemini's response
        response_text = result.get("response", "")
        issues_found = self._count_issues(result)

        # Determine overall health status
        if issues_found == 0:
            health_status = "healthy"
        elif issues_found <= 2:
            health_status = "degraded"
        else:
            health_status = "critical"

        # Store health status in short-term memory for other agents
        health_snapshot = {
            "status": health_status,
            "issues_found": issues_found,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "summary": response_text[:500],
        }
        await self.remember("system_health", health_snapshot, ttl=300)

        # Publish health report to CH_ACTIONS
        await self.send_message(CH_ACTIONS, {
            "type": "compliance_report",
            "health_status": health_status,
            "issues_found": issues_found,
            "tool_calls": len(result.get("tool_calls", [])),
            "summary": response_text[:500],
        })

        await self.log_action("compliance_check", {
            "health_status": health_status,
            "issues_found": issues_found,
            "response_summary": response_text[:300],
        })

        return {
            "health_status": health_status,
            "issues_found": issues_found,
        }

    # ── Cortex directive handling ──────────────────────────────

    async def _handle_cortex_directive(self, msg: dict, context: dict) -> None:
        """Handle a health/compliance directive from the Cortex supervisor."""
        directive = msg.get("directive", "")
        details = msg.get("details", {})

        prompt = (
            f"The SENTINEL CORTEX supervisor has requested a compliance check:\n\n"
            f"DIRECTIVE: {directive}\n"
            f"DETAILS: {json.dumps(details, default=str)[:2000]}\n\n"
            f"Perform the requested checks using your tools and report findings."
        )

        result = await self.execute_tool_loop(prompt, details)

        await self.send_message(CH_ACTIONS, {
            "type": "directive_compliance_report",
            "directive": directive[:200],
            "tool_calls": len(result.get("tool_calls", [])),
            "summary": result.get("response", "")[:500],
        })

    # ── Helper methods ─────────────────────────────────────────

    @staticmethod
    def _count_issues(result: dict) -> int:
        """Count the number of issues detected from tool call results."""
        issues = 0
        for tc in result.get("tool_calls", []):
            if tc["tool"] == "create_alert":
                issues += 1
            elif tc["tool"] == "get_all_cameras_status":
                try:
                    data = json.loads(tc.get("result_summary", "{}"))
                    issues += data.get("offline", 0)
                except (json.JSONDecodeError, TypeError):
                    pass
        return issues
