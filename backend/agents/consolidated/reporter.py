"""Reporter Agent — Automated report generation, compliance monitoring, and shift briefings.

Consolidates the Report and Compliance agents into a single action-tier agent.
Generates shift handoff reports on schedule, monitors system health and camera
coverage gaps, tracks SLA compliance for alert response times, and generates
daily/weekly security summaries.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_ACTIONS

logger = logging.getLogger(__name__)

# ── Shift handoff interval (8 hours) ─────────────────────────────
_SHIFT_INTERVAL_SECONDS = 8 * 60 * 60

# SLA thresholds for compliance checking
_COMPLIANCE_SLA: dict[str, int] = {
    "critical": 300,   # 5 minutes
    "high": 900,       # 15 minutes
    "medium": 1800,    # 30 minutes
}


class ReporterAgent(BaseAgent):
    """Report generation and compliance monitoring agent.

    Handles on-demand reports (triggered by Cortex), scheduled shift
    handoff reports every 8 hours, system health monitoring, SLA
    compliance checks, and daily/weekly security summaries.
    """

    def __init__(self) -> None:
        super().__init__(
            name="reporter",
            role="Report Generation & Compliance Monitor",
            description=(
                "Generates shift handoff reports on schedule, monitors "
                "system health and coverage gaps, tracks SLA compliance "
                "for alert response times, and produces daily/weekly "
                "security summaries.  Consolidates reporting and "
                "compliance monitoring into a single agent."
            ),
            tier="action",
            model_name="gemma3:4b",
            tool_names=[
                "get_threat_statistics",
                "get_event_history",
                "get_alert_history",
                "get_occupancy_trends",
                "generate_report",
                "semantic_search_video",
                "recall_observations",
                "store_observation",
                "get_all_cameras_status",
                "get_all_zones_status",
                "create_alert",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=300.0,
            token_budget_per_cycle=12000,
        )

    # ── Core reasoning loop ───────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main reasoning loop.

        1. Process Cortex messages for on-demand report requests.
        2. Check shift timing and generate handoff reports every 8 hours.
        3. Perform system health and compliance monitoring (every cycle).
        """
        inbox = context.get("inbox_messages", [])
        reports_generated = 0
        compliance_issues = 0

        # ── 1. On-demand report requests from Cortex ──────────────
        for msg in inbox:
            msg_type = msg.get("type", "")
            if msg_type in ("report_request", "directive"):
                directive = msg.get("directive", msg.get("report_type", ""))
                if "report" in directive.lower() or msg_type == "report_request":
                    await self._generate_on_demand_report(msg, context)
                    reports_generated += 1

                # Handle health/compliance directives
                if any(
                    kw in directive.lower()
                    for kw in ["health", "compliance", "status", "camera", "system"]
                ):
                    issues = await self._handle_compliance_directive(msg, context)
                    compliance_issues += issues

        # ── 2. Scheduled shift handoff report ─────────────────────
        shift_generated = await self._check_shift_handoff(context)
        if shift_generated:
            reports_generated += 1

        # ── 3. Periodic compliance check (every cycle) ────────────
        health_result = await self._perform_health_check(context)
        compliance_issues += health_result.get("issues_found", 0)

        return {
            "status": "active" if reports_generated or compliance_issues else "idle",
            "reports_generated": reports_generated,
            "compliance_issues": compliance_issues,
        }

    # ── On-demand report generation ──────────────────────────────

    async def _generate_on_demand_report(
        self, request: dict, context: dict,
    ) -> None:
        """Generate a report based on a Cortex or operator request."""
        report_type = request.get("report_type", "summary")
        time_range = request.get("time_range_hours", 24)
        focus_area = request.get(
            "focus", request.get("directive", "general overview"),
        )
        case_id = request.get("case_id")

        prompt = (
            f"Generate a comprehensive security report.\n\n"
            f"REPORT REQUEST:\n"
            f"- Type: {report_type}\n"
            f"- Time range: last {time_range} hours\n"
            f"- Focus area: {focus_area}\n"
            f"{'- Case ID: ' + case_id if case_id else ''}\n\n"
            f"INSTRUCTIONS:\n"
            f"1. Gather threat statistics using get_threat_statistics.\n"
            f"2. Pull recent alert history using get_alert_history.\n"
            f"3. Review event history for patterns using get_event_history.\n"
            f"4. Check occupancy trends using get_occupancy_trends.\n"
            f"5. Search for notable observations using recall_observations "
            f"with category 'observation'.\n"
            f"6. Analyze the gathered data — identify:\n"
            f"   - Key security events and outcomes\n"
            f"   - Threat trends (increasing, stable, decreasing)\n"
            f"   - Areas of concern\n"
            f"   - Recommendations\n"
            f"7. Call generate_report to persist the report.\n\n"
            f"Produce a professional intelligence-grade narrative, not just "
            f"raw numbers. Highlight what matters for decision-makers."
        )

        result = await self.execute_tool_loop(prompt, {
            "report_request": {
                k: v for k, v in request.items() if not k.startswith("_")
            },
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        await self.send_message(CH_ACTIONS, {
            "type": "report_generated",
            "report_type": report_type,
            "time_range_hours": time_range,
            "tool_calls": len(result.get("tool_calls", [])),
            "summary": result.get("response", "")[:500],
        })

        await self.log_action("report_generated", {
            "report_type": report_type,
            "focus": focus_area[:200],
            "tool_calls_count": len(result.get("tool_calls", [])),
            "response_summary": result.get("response", "")[:300],
        })

    # ── Scheduled shift handoff ──────────────────────────────────

    async def _check_shift_handoff(self, context: dict) -> bool:
        """Generate a shift handoff report every 8 hours."""
        last_shift_ts = await self.recall("last_shift_report_ts")
        now = time.time()

        if last_shift_ts is not None:
            try:
                elapsed = now - float(last_shift_ts)
            except (ValueError, TypeError):
                elapsed = _SHIFT_INTERVAL_SECONDS + 1
        else:
            # First run — initialize timer, skip immediate report
            await self.remember(
                "last_shift_report_ts", now,
                ttl=_SHIFT_INTERVAL_SECONDS + 3600,
            )
            logger.info(
                "reporter: shift timer initialized, next handoff in %d hours",
                _SHIFT_INTERVAL_SECONDS // 3600,
            )
            return False

        if elapsed < _SHIFT_INTERVAL_SECONDS:
            return False

        logger.info("reporter: generating scheduled shift handoff report")

        prompt = (
            "Generate a SHIFT HANDOFF report for the incoming security team.\n\n"
            "INSTRUCTIONS:\n"
            "1. Use get_threat_statistics for the last 8 hours of threat data.\n"
            "2. Use get_alert_history to review alerts from the outgoing shift.\n"
            "3. Use get_event_history to capture significant events.\n"
            "4. Use get_occupancy_trends to note occupancy anomalies.\n"
            "5. Use recall_observations (category: 'observation') for agent "
            "observations stored during the shift.\n"
            "6. Call generate_report with report_type 'shift_handoff' and "
            "time_range_hours 8.\n\n"
            "The report should cover:\n"
            "- EXECUTIVE SUMMARY: One-paragraph overview\n"
            "- ACTIVE THREATS: Ongoing or unresolved threats\n"
            "- ALERTS SUMMARY: Total alerts, breakdown by severity, resolution rate\n"
            "- NOTABLE INCIDENTS: Key events the incoming team needs to know\n"
            "- SYSTEM STATUS: Camera health, coverage gaps, issues\n"
            "- RECOMMENDATIONS: Actions for the incoming shift\n\n"
            "Write as a professional security intelligence brief."
        )

        result = await self.execute_tool_loop(prompt, {
            "report_type": "shift_handoff",
            "shift_duration_hours": 8,
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        # Update shift timer
        await self.remember(
            "last_shift_report_ts", now,
            ttl=_SHIFT_INTERVAL_SECONDS + 3600,
        )

        await self.send_message(CH_ACTIONS, {
            "type": "report_generated",
            "report_type": "shift_handoff",
            "tool_calls": len(result.get("tool_calls", [])),
            "summary": result.get("response", "")[:500],
        })

        await self.log_action("shift_handoff", {
            "report_type": "shift_handoff",
            "tool_calls_count": len(result.get("tool_calls", [])),
            "response_summary": result.get("response", "")[:300],
        })

        return True

    # ── System health & compliance ───────────────────────────────

    async def _perform_health_check(self, context: dict) -> dict:
        """Run a comprehensive system health and compliance assessment."""
        prompt = (
            "Perform a system health and compliance check.\n\n"
            "CHECKS:\n"
            "1. CAMERA HEALTH: Call get_all_cameras_status.\n"
            "   - Flag cameras that are OFFLINE or in ERROR state.\n"
            "   - If any camera is offline, create an alert:\n"
            "     severity='medium', threat_type='system_health'.\n\n"
            "2. ZONE COVERAGE: Call get_all_zones_status.\n"
            "   - Identify zones lacking active camera coverage.\n"
            "   - Flag zones that are over capacity.\n\n"
            "3. ALERT SLA: Call get_alert_history with status='new'.\n"
            "   - CRITICAL unacknowledged > 5 min = SLA violation.\n"
            "   - HIGH unacknowledged > 15 min = SLA violation.\n"
            "   - If SLA violations found, create a compliance alert:\n"
            "     severity='high', threat_type='sla_violation'.\n\n"
            "4. THREAT POSTURE: Call get_threat_statistics.\n\n"
            "5. HISTORICAL: Call recall_observations category='system_health'.\n\n"
            "6. STORE: Call store_observation with category='system_health' "
            "recording the overall status, camera count, offline cameras, "
            "SLA violations, and threat summary.\n\n"
            "Only create alerts for actual issues. Do NOT alert if healthy."
        )

        result = await self.execute_tool_loop(prompt, {
            "cycle": context.get("cycle", 0),
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        response_text = result.get("response", "")
        issues_found = self._count_issues(result)

        if issues_found == 0:
            health_status = "healthy"
        elif issues_found <= 2:
            health_status = "degraded"
        else:
            health_status = "critical"

        # Cache health snapshot for other agents
        await self.remember("system_health", {
            "status": health_status,
            "issues_found": issues_found,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "summary": response_text[:500],
        }, ttl=300)

        # Publish compliance report if issues were found
        if issues_found > 0:
            await self.send_message(CH_ACTIONS, {
                "type": "compliance_alert",
                "health_status": health_status,
                "issues_found": issues_found,
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

    async def _handle_compliance_directive(
        self, msg: dict, context: dict,
    ) -> int:
        """Handle a health/compliance directive from Cortex."""
        directive = msg.get("directive", "")
        details = msg.get("details", {})

        prompt = (
            f"The SENTINEL CORTEX supervisor has requested a compliance check:\n\n"
            f"DIRECTIVE: {directive}\n"
            f"DETAILS: {json.dumps(details, default=str)[:2000]}\n\n"
            f"Perform the requested checks using your tools and report findings."
        )

        result = await self.execute_tool_loop(prompt, details)
        issues = self._count_issues(result)

        await self.send_message(CH_ACTIONS, {
            "type": "compliance_alert",
            "directive": directive[:200],
            "issues_found": issues,
            "tool_calls": len(result.get("tool_calls", [])),
            "summary": result.get("response", "")[:500],
        })

        return issues

    # ── Helpers ───────────────────────────────────────────────────

    @staticmethod
    def _count_issues(result: dict) -> int:
        """Count issues detected from tool call results."""
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
