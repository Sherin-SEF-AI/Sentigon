"""Report Agent — Autonomous security report generation.

Generates on-demand reports in response to Cortex requests and scheduled
shift-handoff reports every 8 hours.  Uses Gemini to intelligently gather
statistics, analyze trends, produce narrative summaries, and call the
generate_report tool to persist the output.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_ACTIONS

logger = logging.getLogger(__name__)

# Shift handoff interval in seconds (8 hours)
_SHIFT_INTERVAL_SECONDS = 8 * 60 * 60


class ReportAgent(BaseAgent):
    """Generates scheduled and on-demand security reports."""

    def __init__(self) -> None:
        super().__init__(
            name="report_agent",
            role="Report Generation Specialist",
            description=(
                "Autonomously generates security reports including shift "
                "handoff summaries (every 8 hours), daily digests, incident "
                "reports, and on-demand analytical reports.  Uses Gemini to "
                "interpret statistics, identify trends, and produce clear "
                "narrative intelligence products."
            ),
            tier="action",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "get_threat_statistics",
                "get_event_history",
                "get_alert_history",
                "get_occupancy_trends",
                "generate_report",
                "semantic_search_video",
                "recall_observations",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=60.0,
            token_budget_per_cycle=10000,
        )

    # ── Core reasoning loop ────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Check for report requests and scheduled report timing.

        1. Process Cortex messages for on-demand report requests.
        2. Track shift timing and generate handoff reports every 8 hours.
        """
        inbox = context.get("inbox_messages", [])
        reports_generated = 0

        # ----------------------------------------------------------
        # 1. Process on-demand report requests from Cortex
        # ----------------------------------------------------------
        for msg in inbox:
            msg_type = msg.get("type", "")
            if msg_type in ("report_request", "directive"):
                directive = msg.get("directive", msg.get("report_type", ""))
                if "report" in directive.lower() or msg_type == "report_request":
                    await self._generate_on_demand_report(msg, context)
                    reports_generated += 1

        # ----------------------------------------------------------
        # 2. Scheduled shift handoff reports
        # ----------------------------------------------------------
        shift_generated = await self._check_shift_handoff(context)
        if shift_generated:
            reports_generated += 1

        return {"reports_generated": reports_generated}

    # ── On-demand report generation ────────────────────────────

    async def _generate_on_demand_report(
        self, request: dict, context: dict
    ) -> None:
        """Generate a report based on a Cortex or operator request."""
        report_type = request.get("report_type", "summary")
        time_range = request.get("time_range_hours", 24)
        focus_area = request.get("focus", request.get("directive", "general overview"))
        case_id = request.get("case_id")

        prompt = (
            f"Generate a comprehensive security report.\n\n"
            f"REPORT REQUEST:\n"
            f"- Type: {report_type}\n"
            f"- Time range: last {time_range} hours\n"
            f"- Focus area: {focus_area}\n"
            f"{'- Case ID: ' + case_id if case_id else ''}\n\n"
            f"INSTRUCTIONS:\n"
            f"1. First, gather current threat statistics using get_threat_statistics.\n"
            f"2. Pull recent alert history using get_alert_history.\n"
            f"3. Review event history for patterns using get_event_history.\n"
            f"4. Check occupancy trends using get_occupancy_trends.\n"
            f"5. Search for any notable observations using recall_observations "
            f"with category 'observation'.\n"
            f"6. Analyze the gathered data and identify:\n"
            f"   - Key security events and outcomes\n"
            f"   - Threat trends (increasing, stable, decreasing)\n"
            f"   - Areas of concern\n"
            f"   - Recommendations\n"
            f"7. Finally, call generate_report to persist the report.\n\n"
            f"Produce a professional intelligence-grade narrative, not just "
            f"raw numbers.  Highlight what matters for the incoming shift."
        )

        result = await self.execute_tool_loop(prompt, {
            "report_request": request,
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        # Publish completion to CH_ACTIONS
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

    # ── Scheduled shift handoff ────────────────────────────────

    async def _check_shift_handoff(self, context: dict) -> bool:
        """Check if it is time to generate a shift handoff report.

        Uses short-term memory to track the last shift report timestamp.
        Generates one every 8 hours.
        """
        last_shift_ts = await self.recall("last_shift_report_ts")
        now = time.time()

        if last_shift_ts is not None:
            try:
                elapsed = now - float(last_shift_ts)
            except (ValueError, TypeError):
                elapsed = _SHIFT_INTERVAL_SECONDS + 1
        else:
            # First run — record the current time and skip (avoid immediate
            # report on startup)
            await self.remember("last_shift_report_ts", now, ttl=_SHIFT_INTERVAL_SECONDS + 3600)
            logger.info(
                "ReportAgent: initialized shift timer, next handoff in %d hours",
                _SHIFT_INTERVAL_SECONDS // 3600,
            )
            return False

        if elapsed < _SHIFT_INTERVAL_SECONDS:
            return False

        # Time for a shift handoff report
        logger.info("ReportAgent: generating scheduled shift handoff report")

        prompt = (
            "Generate a SHIFT HANDOFF report for the incoming security team.\n\n"
            "INSTRUCTIONS:\n"
            "1. Use get_threat_statistics to get the last 8 hours of threat data.\n"
            "2. Use get_alert_history to review alerts from the outgoing shift.\n"
            "3. Use get_event_history to capture significant events.\n"
            "4. Use get_occupancy_trends to note any occupancy anomalies.\n"
            "5. Use recall_observations (category: 'observation') for any agent "
            "observations stored during the shift.\n"
            "6. Call generate_report with report_type 'shift_handoff' and "
            "time_range_hours 8.\n\n"
            "The report should cover:\n"
            "- EXECUTIVE SUMMARY: One-paragraph overview of the shift\n"
            "- ACTIVE THREATS: Any ongoing or unresolved threats\n"
            "- ALERTS SUMMARY: Total alerts, breakdown by severity, resolution rate\n"
            "- NOTABLE INCIDENTS: Key events the incoming team needs to know\n"
            "- SYSTEM STATUS: Camera health, coverage gaps, any issues\n"
            "- RECOMMENDATIONS: Actions for the incoming shift\n\n"
            "Write as a professional security intelligence brief."
        )

        result = await self.execute_tool_loop(prompt, {
            "report_type": "shift_handoff",
            "shift_duration_hours": 8,
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        # Update shift timer
        await self.remember("last_shift_report_ts", now, ttl=_SHIFT_INTERVAL_SECONDS + 3600)

        # Publish to CH_ACTIONS
        await self.send_message(CH_ACTIONS, {
            "type": "shift_handoff_report",
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
