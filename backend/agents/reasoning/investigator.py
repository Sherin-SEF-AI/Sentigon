"""Investigator Agent — autonomous forensic investigation with Gemini reasoning.

Listens for investigation requests from the Cortex supervisor and auto-triggers
on critical threats. Creates investigation cases, gathers evidence autonomously
using Gemini function-calling, and publishes findings.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_CORTEX,
    CH_THREATS,
    CH_INVESTIGATION,
)

logger = logging.getLogger(__name__)

# ── Investigation planning prompt ────────────────────────────────────
_PLAN_PROMPT = """\
You are an autonomous forensic investigator in a physical security system. \
You have been tasked with investigating a potential security incident.

**Incident to investigate:**
{incident_details}

**Available tools:**
- semantic_search_video: Search indexed video events by natural language query
- similarity_search: Find events similar to a given event (by event_id)
- search_entity_appearances: Search for a described person/vehicle across all cameras
- get_event_history: Query event history with camera, severity, and time filters
- get_alert_history: Query alert history with status, severity, and time filters
- get_tracking_trajectory: Get movement path of a tracked entity
- create_investigation_case: Create a formal investigation case
- attach_evidence_to_case: Attach evidence items to a case
- generate_incident_timeline: Build a chronological timeline from event IDs
- generate_report: Generate a formal security report
- get_site_context: Get current time of day, business hours status
- store_observation: Record investigative observations to memory
- recall_observations: Recall previously stored observations
- analyze_frame_with_gemini: Analyse a camera frame with a custom prompt
- analyze_frame_sequence_deep: Deep temporal analysis of a frame sequence

**Instructions:**
1. First, create an investigation case using create_investigation_case.
2. Search for all related events using semantic_search_video and get_event_history.
3. For each relevant camera, search for entity appearances and check detections.
4. Track the movements of any suspicious entities using get_tracking_trajectory.
5. Build a timeline of events using generate_incident_timeline.
6. Attach all discovered evidence to the case using attach_evidence_to_case.
7. Synthesise your findings.

Provide a detailed investigation plan, then execute it step by step using \
the tools. After completing all steps, provide your final findings as JSON:
{{
  "case_id": "<the case ID you created>",
  "incident_summary": "<comprehensive summary of what happened>",
  "key_findings": ["<finding 1>", "<finding 2>", ...],
  "entities_involved": ["<entity description 1>", ...],
  "cameras_involved": ["<camera_id 1>", ...],
  "timeline_summary": "<chronological narrative>",
  "risk_assessment": "<low|medium|high|critical>",
  "recommended_actions": ["<action 1>", "<action 2>", ...],
  "evidence_count": <number>,
  "confidence": <0.0-1.0>
}}
"""

_FOLLOWUP_PROMPT = """\
You are continuing a forensic investigation. New information has been gathered.

**Investigation context:**
{investigation_context}

**New evidence to analyze:**
{new_evidence}

Use your tools to dig deeper into this new evidence. Search for related events, \
check entity appearances, and cross-reference with existing case data.

Provide additional findings as JSON:
{{
  "additional_findings": ["<finding>", ...],
  "new_entities_discovered": ["<entity>", ...],
  "risk_change": "increased|decreased|unchanged",
  "follow_up_needed": true/false,
  "summary": "<summary of new discoveries>"
}}
"""


class InvestigatorAgent(BaseAgent):
    """Autonomous forensic investigator agent.

    Handles complex, multi-step investigations triggered by critical threats
    or Cortex supervisor directives. Uses Gemini's function-calling to
    autonomously gather evidence, build timelines, and produce comprehensive
    investigation reports.
    """

    def __init__(self) -> None:
        super().__init__(
            name="investigator",
            role="Autonomous Forensic Investigator",
            description=(
                "Conducts multi-step forensic investigations on critical "
                "security incidents. Autonomously gathers evidence using "
                "semantic search, entity tracking, frame analysis, and "
                "cross-camera correlation. Creates formal investigation cases "
                "with evidence chains and timeline narratives."
            ),
            tier="reasoning",
            model_name="deepseek-v3.1:671b-cloud",
            tool_names=[
                # Search & retrieval
                "semantic_search_video",
                "similarity_search",
                "search_entity_appearances",
                "get_event_history",
                "get_alert_history",
                "get_tracking_trajectory",
                # Investigation management
                "create_investigation_case",
                "attach_evidence_to_case",
                "generate_incident_timeline",
                "generate_report",
                # Context & analysis
                "get_site_context",
                "store_observation",
                "recall_observations",
                "analyze_frame_with_gemini",
                "analyze_frame_sequence_deep",
            ],
            subscriptions=[CH_CORTEX, CH_THREATS],
            cycle_interval=10.0,
            token_budget_per_cycle=25000,
        )
        # Track active investigations to avoid duplicates
        self._active_investigations: dict[str, dict] = {}

    # ── Core reasoning ────────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main reasoning loop executed every cycle.

        1. Check inbox for investigation requests from Cortex.
        2. Auto-trigger investigations on critical threats.
        3. Execute pending investigations.
        4. Publish results to CH_INVESTIGATION.
        """
        inbox = context.get("inbox_messages", [])
        cycle = context.get("cycle", 0)
        investigations_started = 0
        investigations_completed = 0

        # ── 1. Process inbox messages ─────────────────────────────────
        investigation_requests = []
        critical_threats = []

        for msg in inbox:
            channel = msg.get("_channel", "")
            msg_type = msg.get("type", "")

            # Direct investigation requests from Cortex
            if channel == CH_CORTEX and msg_type in (
                "investigate", "start_investigation", "investigation_request",
            ):
                investigation_requests.append(msg)

            # Auto-trigger on critical threats
            elif channel == CH_THREATS and msg_type == "threat_assessment":
                severity = msg.get("severity", "info")
                threat_prob = msg.get("threat_probability", 0)
                if severity in ("critical", "high") or threat_prob >= 85:
                    critical_threats.append(msg)

        # ── 2. Queue new investigations ───────────────────────────────
        for request in investigation_requests:
            inv_key = self._investigation_key(request)
            if inv_key not in self._active_investigations:
                self._active_investigations[inv_key] = {
                    "status": "pending",
                    "request": request,
                    "started_at": None,
                    "source": "cortex_directive",
                }
                investigations_started += 1
                logger.info(
                    "Investigation queued from Cortex: %s",
                    request.get("subject", request.get("description", ""))[:80],
                )

        for threat in critical_threats:
            inv_key = self._investigation_key(threat)
            if inv_key not in self._active_investigations:
                self._active_investigations[inv_key] = {
                    "status": "pending",
                    "request": threat,
                    "started_at": None,
                    "source": "auto_critical_threat",
                }
                investigations_started += 1
                logger.info(
                    "Auto-investigation triggered for critical threat: %s",
                    threat.get("signature", "unknown"),
                )

        # ── 3. Execute pending investigations (one per cycle) ─────────
        pending = [
            (key, inv) for key, inv in self._active_investigations.items()
            if inv["status"] == "pending"
        ]

        if pending:
            inv_key, investigation = pending[0]
            investigation["status"] = "running"
            investigation["started_at"] = datetime.now(timezone.utc).isoformat()

            try:
                findings = await self._run_investigation(
                    investigation["request"], context,
                )
                investigation["status"] = "completed"
                investigation["findings"] = findings
                investigations_completed += 1

                # Publish results
                await self.send_message(CH_INVESTIGATION, {
                    "type": "investigation_complete",
                    "investigation_key": inv_key,
                    "source": investigation["source"],
                    "findings": findings,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

                logger.info("Investigation completed: %s", inv_key)

            except Exception as exc:
                investigation["status"] = "failed"
                investigation["error"] = str(exc)
                logger.error("Investigation failed for %s: %s", inv_key, exc)
                await self.log_action("error", {
                    "error": f"Investigation failed: {exc}",
                    "investigation_key": inv_key,
                })

        # ── 4. Clean up completed/failed investigations ───────────────
        stale_keys = [
            key for key, inv in self._active_investigations.items()
            if inv["status"] in ("completed", "failed")
        ]
        for key in stale_keys:
            del self._active_investigations[key]

        return {
            "investigations_started": investigations_started,
            "investigations_completed": investigations_completed,
            "active_investigations": len(self._active_investigations),
        }

    # ── Investigation execution ───────────────────────────────────────

    async def _run_investigation(self, request: dict, context: dict) -> dict:
        """Execute a full multi-step investigation via Gemini tool loop.

        Gemini autonomously plans and executes the investigation using
        available tools: semantic search, entity tracking, case creation,
        evidence attachment, and timeline generation.
        """
        # Build the incident details from the request
        incident_details = self._format_incident_details(request)

        await self.log_action("investigation_start", {
            "prompt_summary": f"Starting investigation: {incident_details[:200]}",
        })

        # ── Phase 1: Plan and execute investigation ───────────────────
        result = await self.execute_tool_loop(
            _PLAN_PROMPT.format(incident_details=incident_details),
            context_data={
                "request": {
                    k: v for k, v in request.items() if not k.startswith("_")
                },
                "timestamp": context.get("timestamp"),
                "cycle": context.get("cycle", 0),
            },
        )

        response_text = result.get("response", "")
        tool_calls = result.get("tool_calls", [])

        # Parse the investigation findings
        findings = self._parse_findings(response_text)
        findings["tool_calls_made"] = len(tool_calls)
        findings["investigation_source"] = request.get("type", "unknown")

        # ── Phase 2: Extract case_id and attach any remaining evidence ─
        case_id = findings.get("case_id")
        if case_id:
            # Store case reference for future lookups
            await self.remember(
                f"investigation_case_{case_id}",
                {
                    "case_id": case_id,
                    "summary": findings.get("incident_summary", ""),
                    "risk": findings.get("risk_assessment", "unknown"),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
                ttl=3600,  # 1 hour
            )

        # ── Phase 3: Store findings in long-term memory ───────────────
        summary = findings.get("incident_summary", "")
        if summary:
            camera_id = None
            cameras = findings.get("cameras_involved", [])
            if cameras:
                camera_id = cameras[0]

            await self.learn(
                knowledge=(
                    f"Investigation finding: {summary}. "
                    f"Risk: {findings.get('risk_assessment', 'unknown')}. "
                    f"Key findings: {', '.join(findings.get('key_findings', [])[:3])}"
                ),
                category="investigation",
                camera_id=camera_id,
            )

        await self.log_action("investigation_complete", {
            "case_id": case_id,
            "risk_assessment": findings.get("risk_assessment", "unknown"),
            "evidence_count": findings.get("evidence_count", 0),
            "tool_calls": len(tool_calls),
            "response_summary": response_text[:500],
        })

        return findings

    def _format_incident_details(self, request: dict) -> str:
        """Format the investigation request into a readable incident brief."""
        parts = []

        # From Cortex directive
        if request.get("subject"):
            parts.append(f"Subject: {request['subject']}")
        if request.get("description"):
            parts.append(f"Description: {request['description']}")

        # From threat assessment
        if request.get("signature"):
            parts.append(f"Threat signature: {request['signature']}")
        if request.get("threat_explanation"):
            parts.append(f"Threat scenario: {request['threat_explanation']}")
        if request.get("camera_id"):
            parts.append(f"Camera: {request['camera_id']}")
        if request.get("severity"):
            parts.append(f"Severity: {request['severity']}")
        if request.get("threat_probability"):
            parts.append(f"Threat probability: {request['threat_probability']}%")
        if request.get("evidence"):
            evidence_list = request["evidence"]
            if isinstance(evidence_list, list):
                parts.append(f"Initial evidence: {'; '.join(str(e) for e in evidence_list[:5])}")
        if request.get("recommended_response"):
            parts.append(f"Recommended response: {request['recommended_response']}")
        if request.get("timestamp"):
            parts.append(f"Timestamp: {request['timestamp']}")

        return "\n".join(parts) if parts else json.dumps(
            {k: v for k, v in request.items() if not k.startswith("_")},
            default=str,
        )[:2000]

    def _parse_findings(self, response_text: str) -> dict:
        """Extract structured findings from Gemini response."""
        try:
            start = response_text.index("{")
            end = response_text.rindex("}") + 1
            parsed = json.loads(response_text[start:end])
            return {
                "case_id": parsed.get("case_id"),
                "incident_summary": parsed.get("incident_summary", ""),
                "key_findings": parsed.get("key_findings", []),
                "entities_involved": parsed.get("entities_involved", []),
                "cameras_involved": parsed.get("cameras_involved", []),
                "timeline_summary": parsed.get("timeline_summary", ""),
                "risk_assessment": parsed.get("risk_assessment", "unknown"),
                "recommended_actions": parsed.get("recommended_actions", []),
                "evidence_count": int(parsed.get("evidence_count", 0)),
                "confidence": float(parsed.get("confidence", 0.0)),
            }
        except (ValueError, json.JSONDecodeError, TypeError):
            logger.debug("Could not parse JSON from investigation response")
            return {
                "case_id": None,
                "incident_summary": response_text[:500] if response_text else "",
                "key_findings": [],
                "entities_involved": [],
                "cameras_involved": [],
                "timeline_summary": "",
                "risk_assessment": "unknown",
                "recommended_actions": [],
                "evidence_count": 0,
                "confidence": 0.0,
                "raw_response": response_text[:1000],
            }

    # ── Helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _investigation_key(request: dict) -> str:
        """Generate a deduplication key for an investigation request."""
        camera = request.get("camera_id", "unknown")
        signature = request.get("signature", request.get("type", "general"))
        # Use timestamp truncated to minute for dedup window
        ts = request.get("timestamp", "")
        if ts and len(ts) > 16:
            ts = ts[:16]  # YYYY-MM-DDTHH:MM
        return f"{camera}:{signature}:{ts}"
