"""Red Team Agent — Adversarial self-testing and vulnerability probing.

Periodically simulates attack scenarios against the facility's security
posture, identifies coverage gaps, tests agent responsiveness, and
generates vulnerability reports.
"""
from __future__ import annotations

import json
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_ACTIONS

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Attack scenario library
# ---------------------------------------------------------------------------

_ATTACK_SCENARIOS: list[dict[str, Any]] = [
    {
        "id": "perimeter_breach",
        "name": "Perimeter Breach",
        "description": (
            "An adversary attempts to breach the facility perimeter by "
            "cutting a fence, climbing a wall, or entering through a gap "
            "in physical barriers."
        ),
        "checks": [
            "Review all perimeter cameras for blind spots or offline status.",
            "Check zone coverage for perimeter areas.",
            "Verify that motion-detection alerts are active on perimeter cameras.",
        ],
    },
    {
        "id": "insider_threat",
        "name": "Insider Threat",
        "description": (
            "A credentialed employee acts maliciously \u2014 accessing restricted "
            "zones outside normal hours, exfiltrating materials, or tampering "
            "with security systems."
        ),
        "checks": [
            "Check access logs for after-hours badge swipes in sensitive zones.",
            "Look for repeated failed access attempts on restricted doors.",
            "Verify that cameras covering server rooms and vaults are online.",
        ],
    },
    {
        "id": "tailgating",
        "name": "Tailgating / Piggybacking",
        "description": (
            "An unauthorised person follows a credentialed individual "
            "through a secure door without presenting their own badge."
        ),
        "checks": [
            "Identify access points with high foot traffic.",
            "Check if anti-tailgating sensors or mantrap zones exist.",
            "Review recent door-held-open alarms.",
        ],
    },
    {
        "id": "camera_blind_spot",
        "name": "Camera Blind Spot Exploitation",
        "description": (
            "An adversary identifies camera blind spots and uses them to "
            "move undetected through the facility."
        ),
        "checks": [
            "Enumerate all cameras and their assigned zones.",
            "Identify zones with fewer than 2 cameras (no overlapping coverage).",
            "Check for cameras that are offline, degraded, or have obstructed views.",
        ],
    },
    {
        "id": "social_engineering",
        "name": "Social Engineering",
        "description": (
            "An adversary uses pretexting (e.g. posing as a contractor or "
            "delivery person) to gain physical access to restricted areas."
        ),
        "checks": [
            "Check if visitor management logs are being correlated with camera feeds.",
            "Review recent alerts for unknown / unrecognised persons in restricted zones.",
            "Verify that intercom and lobby cameras are online.",
        ],
    },
    {
        "id": "vehicle_ram",
        "name": "Vehicle Ramming / Forced Entry",
        "description": (
            "An adversary uses a vehicle to breach physical barriers such "
            "as gates, bollards, or loading dock doors."
        ),
        "checks": [
            "Identify vehicle entry points (gates, loading docks, parking).",
            "Check LPR camera status and coverage of vehicle entry points.",
            "Verify bollard and barrier sensors are reporting.",
        ],
    },
    {
        "id": "drone_intrusion",
        "name": "Drone Intrusion",
        "description": (
            "An adversary deploys an unmanned aerial vehicle (drone) over "
            "the facility for reconnaissance or to deliver a payload."
        ),
        "checks": [
            "Check if any cameras or sensors cover the airspace / rooftop.",
            "Review recent alerts for unknown aerial objects.",
            "Verify that environmental sensors include sky-facing coverage.",
        ],
    },
]

# Maximum number of past reports to keep in memory
_MAX_HISTORY = 20


class RedTeamAgent(BaseAgent):
    """Simulates attack scenarios to identify security gaps.

    Probes the camera network, zone coverage, and alarm history for
    weaknesses.  Generates adversarial vulnerability reports and tracks
    improvements over time.
    """

    def __init__(self) -> None:
        super().__init__(
            name="red_team",
            role="Adversarial Security Tester",
            description=(
                "Simulates attack scenarios to identify security gaps, "
                "tests agent fleet responsiveness, probes for camera blind "
                "spots, and generates adversarial vulnerability reports."
            ),
            tier="action",
            model_name="gemma3:4b",
            tool_names=[
                "get_all_cameras_status",
                "get_all_zones_status",
                "get_site_context",
                "get_alert_history",
                "get_threat_statistics",
                "semantic_search",
                "store_observation",
                "create_event",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=300.0,  # every 5 minutes
            token_budget_per_cycle=30000,
        )

    # ================================================================
    # Core reasoning loop
    # ================================================================

    async def think(self, context: dict) -> dict:
        """Run an adversarial test cycle.

        Steps:
        1. Select a random attack scenario from the library.
        2. Analyse current security posture and find weaknesses.
        3. Simulate the attack: check camera coverage gaps, door
           vulnerabilities, alarm response times.
        4. Generate a vulnerability report with specific recommendations.
        5. Store findings in memory and track improvement over time.
        6. Publish to CH_ACTIONS with type ``red_team_report``.
        """
        inbox = context.get("inbox_messages", [])

        # Process any cortex directives aimed at us
        for msg in inbox:
            if (
                msg.get("type") == "directive"
                and msg.get("target_agent") == "red_team"
            ):
                logger.info(
                    "RedTeamAgent: received cortex directive: %s",
                    msg.get("directive", "")[:120],
                )

        # 1. Select a random attack scenario
        scenario = random.choice(_ATTACK_SCENARIOS)
        logger.info(
            "RedTeamAgent: running scenario '%s'", scenario["name"],
        )

        # 2-4. Ask the LLM to probe for weaknesses
        report = await self._run_scenario(scenario, context)

        # 5. Store findings in memory and track history
        await self._store_findings(scenario, report)

        # 6. Publish to CH_ACTIONS
        await self.send_message(CH_ACTIONS, {
            "type": "red_team_report",
            "scenario": scenario["id"],
            "scenario_name": scenario["name"],
            "vulnerabilities_found": report.get("vulnerabilities_found", 0),
            "risk_rating": report.get("risk_rating", "unknown"),
            "summary": report.get("summary", "")[:500],
        })

        await self.log_action("red_team_scenario", {
            "scenario": scenario["id"],
            "vulnerabilities_found": report.get("vulnerabilities_found", 0),
            "risk_rating": report.get("risk_rating", "unknown"),
            "response_summary": report.get("summary", "")[:300],
        })

        return {
            "scenario": scenario["id"],
            "vulnerabilities_found": report.get("vulnerabilities_found", 0),
            "risk_rating": report.get("risk_rating", "unknown"),
        }

    # ================================================================
    # Scenario execution
    # ================================================================

    async def _run_scenario(self, scenario: dict, context: dict) -> dict:
        """Execute a single attack scenario probe via the LLM + tools."""

        checks_text = "\n".join(
            f"  {i+1}. {c}" for i, c in enumerate(scenario["checks"])
        )

        # Pull historical findings for this scenario to track progress
        history = await self.recall("red_team_history") or {}
        prev_findings = history.get(scenario["id"], {})
        prev_summary = prev_findings.get("summary", "No prior test.")
        prev_vulns = prev_findings.get("vulnerabilities_found", "N/A")

        prompt = (
            "You are the RED TEAM agent of SENTINEL AI.  Your job is to "
            "think like an attacker and probe the facility's security for "
            "weaknesses.\n\n"
            f"ATTACK SCENARIO: {scenario['name']}\n"
            f"DESCRIPTION: {scenario['description']}\n\n"
            f"INVESTIGATION STEPS:\n{checks_text}\n\n"
            f"PREVIOUS TEST RESULTS (for improvement tracking):\n"
            f"  Vulnerabilities found last time: {prev_vulns}\n"
            f"  Previous summary: {str(prev_summary)[:300]}\n\n"
            "INSTRUCTIONS:\n"
            "1. Use get_all_cameras_status to review camera coverage.\n"
            "2. Use get_all_zones_status to review zone coverage.\n"
            "3. Use get_alert_history to check recent alarm patterns.\n"
            "4. Use get_threat_statistics to understand the threat landscape.\n"
            "5. Use get_site_context for facility layout context.\n"
            "6. Optionally use semantic_search for relevant historical "
            "observations.\n\n"
            "Based on your investigation, produce a VULNERABILITY REPORT:\n\n"
            "RISK_RATING: low / medium / high / critical\n"
            "VULNERABILITIES_FOUND: <number>\n\n"
            "For each vulnerability:\n"
            "  - VULNERABILITY: <short title>\n"
            "  - DETAILS: <what you found>\n"
            "  - RECOMMENDATION: <specific remediation step>\n\n"
            "Finally, compare with the previous test and note whether the "
            "facility's security posture has IMPROVED, DEGRADED, or stayed "
            "the SAME for this scenario.\n\n"
            "Be specific and actionable.  Reference exact camera names, "
            "zone names, and alert IDs where possible."
        )

        result = await self.execute_tool_loop(prompt, {
            "scenario_id": scenario["id"],
            "cycle": context.get("cycle", 0),
            "current_time": datetime.now(timezone.utc).isoformat(),
        })

        response_text = result.get("response", "")

        # Parse structured fields from the response
        risk_rating = self._extract_field(response_text, "RISK_RATING", "unknown")
        vuln_count = self._extract_vuln_count(response_text)

        # Store observation for long-term knowledge
        try:
            await self.learn(
                knowledge=(
                    f"Red team scenario '{scenario['name']}' completed. "
                    f"Risk: {risk_rating}. Vulnerabilities: {vuln_count}. "
                    f"Summary: {response_text[:200]}"
                ),
                category="red_team",
            )
        except Exception as exc:
            logger.debug("RedTeamAgent: failed to store learning: %s", exc)

        return {
            "summary": response_text,
            "risk_rating": risk_rating.lower().strip(),
            "vulnerabilities_found": vuln_count,
            "tool_calls": result.get("tool_calls", []),
        }

    # ================================================================
    # Findings storage and improvement tracking
    # ================================================================

    async def _store_findings(self, scenario: dict, report: dict) -> None:
        """Persist findings in short-term memory for improvement tracking."""
        history: dict[str, Any] = await self.recall("red_team_history") or {}

        history[scenario["id"]] = {
            "scenario_name": scenario["name"],
            "risk_rating": report.get("risk_rating", "unknown"),
            "vulnerabilities_found": report.get("vulnerabilities_found", 0),
            "summary": report.get("summary", "")[:500],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # Prune history to the most recent _MAX_HISTORY entries
        if len(history) > _MAX_HISTORY:
            sorted_keys = sorted(
                history.keys(),
                key=lambda k: history[k].get("timestamp", ""),
            )
            for old_key in sorted_keys[:-_MAX_HISTORY]:
                del history[old_key]

        await self.remember("red_team_history", history, ttl=86400)  # 24h TTL

    # ================================================================
    # Parsing helpers
    # ================================================================

    @staticmethod
    def _extract_field(text: str, field_name: str, default: str = "") -> str:
        """Extract a simple ``FIELD_NAME: value`` from free-form text."""
        for line in text.split("\n"):
            stripped = line.strip()
            prefix = f"{field_name}:"
            if stripped.upper().startswith(prefix.upper()):
                return stripped[len(prefix):].strip()
        return default

    @staticmethod
    def _extract_vuln_count(text: str) -> int:
        """Extract the VULNERABILITIES_FOUND count from the response."""
        for line in text.split("\n"):
            stripped = line.strip().upper()
            if stripped.startswith("VULNERABILITIES_FOUND:"):
                raw = stripped[len("VULNERABILITIES_FOUND:"):].strip()
                # Handle cases like "3 vulnerabilities" or just "3"
                digits = "".join(c for c in raw.split()[0] if c.isdigit()) if raw else ""
                if digits:
                    try:
                        return int(digits)
                    except ValueError:
                        pass
        # Fallback: count lines starting with "VULNERABILITY:"
        count = sum(
            1 for line in text.split("\n")
            if line.strip().upper().startswith("VULNERABILITY:")
        )
        return count
