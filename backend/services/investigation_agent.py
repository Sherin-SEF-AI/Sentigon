"""AI Investigation Agent -- autonomous multi-tool investigation from natural language queries."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional

from backend.config import settings

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────
# Prompt templates
# ──────────────────────────────────────────────────────────────────────

PLANNING_PROMPT = """You are SENTINEL AI Investigation Agent. You have access to a security surveillance system with multiple cameras, AI detection, and CLIP-based visual search.

Given this investigation query: '{query}'

Create an investigation plan as a JSON object. Choose the most relevant tools and order them logically.

Available tools:
- clip_search: Visual search using CLIP embeddings. Params: {{"text": "description of what to search for"}}
- subject_search: Find a specific subject across multiple cameras. Params: {{"description": "subject description", "time_range_hours": <int>}}
- movement_trail: Build a movement trail for a subject. Params: {{"subject_description": "description of subject to track"}}
- event_correlation: Find correlated events across cameras. Params: {{"time_window": <seconds>, "min_cameras": <int>}}
- timeline: Build an evidence timeline. Params: {{"hours_back": <int>}}

Respond ONLY with JSON:
{{
  "steps": [
    {{"tool": "<tool_name>", "params": {{}}, "reason": "why this step"}}
  ]
}}"""

SYNTHESIS_PROMPT = """You are SENTINEL AI Investigation Agent completing an investigation.

Original query: '{query}'

Investigation results from {step_count} steps:
{results_json}

Synthesize these results into a comprehensive investigation report as JSON:
{{
  "narrative": "Detailed narrative of findings",
  "key_findings": ["finding 1", "finding 2"],
  "entities_identified": [{{"description": "entity", "risk": "level", "details": "info"}}],
  "evidence_items": [{{"type": "type", "source": "tool", "description": "details", "confidence": 0.0}}],
  "risk_assessment": "Overall risk assessment paragraph",
  "recommendations": ["recommendation 1", "recommendation 2"]
}}

Be thorough and specific. Reference camera IDs and timestamps where available."""


class InvestigationAgent:
    """Autonomous investigation agent with ReAct-style tool orchestration.

    Given a natural-language query the agent:
      1. Asks an AI provider to create an investigation plan
      2. Executes each planned tool step
      3. Sends all results back to the AI for synthesis
      4. Returns a structured investigation report
    """

    def __init__(self) -> None:
        self._call_count = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def investigate(
        self,
        query: str,
        hours_back: int = 24,
    ) -> Dict[str, Any]:
        """Run a full investigation and return a structured report dict."""
        t0 = time.monotonic()
        ai_provider = "unknown"

        try:
            logger.info("investigation_agent.start query=%r hours_back=%d", query, hours_back)

            # 1. Ask AI to create a plan -----------------------------------
            planning_text = PLANNING_PROMPT.format(query=query)
            plan_response = await self._call_ai(planning_text)
            ai_provider = plan_response.get("_provider", "unknown")

            plan = self._parse_json(plan_response.get("text", ""))
            steps = plan.get("steps", [])
            if not steps:
                logger.warning("investigation_agent.empty_plan — using default steps")
                steps = self._default_plan(query, hours_back)

            logger.info("investigation_agent.plan steps=%d provider=%s", len(steps), ai_provider)

            # 2. Execute each step -----------------------------------------
            steps_completed: List[Dict[str, Any]] = []
            all_results: List[Dict[str, Any]] = []
            total_evidence = 0

            for idx, step in enumerate(steps):
                tool = step.get("tool", "unknown")
                params = step.get("params", {})
                reason = step.get("reason", "")

                step_result = await self._execute_tool(tool, params, hours_back)
                evidence_count = step_result.get("evidence_count", 0)
                total_evidence += evidence_count

                steps_completed.append({
                    "step_number": idx + 1,
                    "tool": tool,
                    "status": step_result.get("status", "completed"),
                    "result_summary": step_result.get("summary", ""),
                    "evidence_count": evidence_count,
                })
                all_results.append({
                    "step": idx + 1,
                    "tool": tool,
                    "reason": reason,
                    "result": step_result.get("data"),
                    "summary": step_result.get("summary", ""),
                })

            # 3. Synthesize results ----------------------------------------
            synthesis_text = SYNTHESIS_PROMPT.format(
                query=query,
                step_count=len(steps_completed),
                results_json=json.dumps(all_results, indent=2, default=str)[:12000],
            )
            synth_response = await self._call_ai(synthesis_text)
            ai_provider = synth_response.get("_provider", ai_provider)
            report = self._parse_json(synth_response.get("text", ""))

            # Ensure report has all expected keys
            report.setdefault("narrative", report.get("raw_response", ""))
            report.setdefault("key_findings", [])
            report.setdefault("entities_identified", [])
            report.setdefault("evidence_items", [])
            report.setdefault("risk_assessment", "Unable to assess")
            report.setdefault("recommendations", [])

            elapsed = time.monotonic() - t0
            logger.info(
                "investigation_agent.complete elapsed=%.1fs evidence=%d provider=%s",
                elapsed, total_evidence, ai_provider,
            )

            return {
                "query": query,
                "investigation_plan": steps,
                "steps_completed": steps_completed,
                "report": {
                    "narrative": report["narrative"],
                    "key_findings": report["key_findings"],
                    "entities_identified": report["entities_identified"],
                    "evidence_items": report["evidence_items"],
                    "risk_assessment": report["risk_assessment"],
                    "recommendations": report["recommendations"],
                },
                "total_evidence_items": total_evidence,
                "ai_provider": ai_provider,
            }

        except Exception as exc:
            logger.exception("investigation_agent.error: %s", exc)
            return {
                "query": query,
                "investigation_plan": [],
                "steps_completed": [],
                "report": {
                    "narrative": f"Investigation failed: {exc}",
                    "key_findings": [],
                    "entities_identified": [],
                    "evidence_items": [],
                    "risk_assessment": "Unable to assess — investigation error",
                    "recommendations": ["Retry the investigation", "Check system logs"],
                },
                "total_evidence_items": 0,
                "ai_provider": ai_provider,
            }

    # ------------------------------------------------------------------
    # Tool execution
    # ------------------------------------------------------------------

    async def _execute_tool(
        self,
        tool: str,
        params: Dict[str, Any],
        hours_back: int,
    ) -> Dict[str, Any]:
        """Execute a single investigation tool and return normalised result."""
        try:
            if tool == "clip_search":
                return await self._tool_clip_search(params)
            elif tool == "subject_search":
                return await self._tool_subject_search(params, hours_back)
            elif tool == "movement_trail":
                return await self._tool_movement_trail(params)
            elif tool == "event_correlation":
                return await self._tool_event_correlation(params)
            elif tool == "timeline":
                return await self._tool_timeline(params, hours_back)
            else:
                logger.warning("investigation_agent.unknown_tool tool=%s", tool)
                return {
                    "status": "skipped",
                    "summary": f"Unknown tool: {tool}",
                    "evidence_count": 0,
                    "data": None,
                }
        except Exception as exc:
            logger.warning("investigation_agent.tool_error tool=%s: %s", tool, exc)
            return {
                "status": "error",
                "summary": f"Tool {tool} failed: {exc}",
                "evidence_count": 0,
                "data": None,
            }

    async def _tool_clip_search(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from backend.services.vector_store import vector_store

        text = params.get("text", "")
        results = await vector_store.visual_search_by_text(text, top_k=10)
        items = results if isinstance(results, list) else []
        return {
            "status": "completed",
            "summary": f"CLIP search for '{text}' returned {len(items)} results",
            "evidence_count": len(items),
            "data": items[:10],
        }

    async def _tool_subject_search(
        self, params: Dict[str, Any], hours_back: int,
    ) -> Dict[str, Any]:
        from backend.services.event_correlator import event_correlator

        description = params.get("description", "")
        time_range = params.get("time_range_hours", hours_back)
        results = await event_correlator.find_subject_across_cameras(
            description, top_k=20, time_range_hours=time_range,
        )
        items = results if isinstance(results, list) else []
        cameras = set()
        for item in items:
            cam = item.get("camera_id") if isinstance(item, dict) else None
            if cam:
                cameras.add(cam)
        return {
            "status": "completed",
            "summary": (
                f"Subject search for '{description}' found {len(items)} matches "
                f"across {len(cameras)} cameras"
            ),
            "evidence_count": len(items),
            "data": items[:20],
        }

    async def _tool_movement_trail(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from backend.services.event_correlator import event_correlator

        description = params.get("subject_description", "")
        results = await event_correlator.build_movement_trail(description, top_k=20)
        trail = results if isinstance(results, (list, dict)) else []
        trail_items = trail if isinstance(trail, list) else trail.get("trail", [])
        return {
            "status": "completed",
            "summary": f"Movement trail for '{description}': {len(trail_items)} waypoints",
            "evidence_count": len(trail_items),
            "data": trail,
        }

    async def _tool_event_correlation(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from backend.services.event_correlator import event_correlator

        time_window = params.get("time_window", 300)
        min_cameras = params.get("min_cameras", 2)
        results = await event_correlator.correlate_events(time_window, min_cameras)
        items = results if isinstance(results, list) else []
        return {
            "status": "completed",
            "summary": f"Event correlation (window={time_window}s, min_cams={min_cameras}): {len(items)} correlated events",
            "evidence_count": len(items),
            "data": items[:20],
        }

    async def _tool_timeline(
        self, params: Dict[str, Any], hours_back: int,
    ) -> Dict[str, Any]:
        from backend.services.evidence_timeline import evidence_timeline_builder

        hb = params.get("hours_back", hours_back)
        results = await evidence_timeline_builder.build_timeline(
            query="", hours_back=hb,
        )
        items = results if isinstance(results, (list, dict)) else []
        if isinstance(items, dict):
            items = items.get("events", items.get("timeline", []))
        return {
            "status": "completed",
            "summary": f"Evidence timeline ({hb}h back): {len(items)} events",
            "evidence_count": len(items) if isinstance(items, list) else 0,
            "data": items,
        }

    # ------------------------------------------------------------------
    # Multi-provider AI caller
    # ------------------------------------------------------------------

    async def _call_ai(self, prompt: str) -> Dict[str, Any]:
        """Call Ollama reasoning tier for text generation.

        Returns {"text": str, "_provider": str}.
        """
        self._call_count += 1

        try:
            from backend.services.ollama_provider import ollama_generate_text
            text = await ollama_generate_text(
                prompt, temperature=0.1, max_tokens=4096, tier="reasoning",
            )
            return {"text": text, "_provider": "ollama"}
        except Exception as e:
            logger.error("investigation_agent.ollama_failed: %s", e)
            return {"text": "", "_provider": "none"}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _parse_json(self, text: str) -> Dict[str, Any]:
        """Parse JSON from AI response, stripping markdown fences."""
        cleaned = text.strip()
        if cleaned.startswith("```"):
            lines = cleaned.split("\n")
            lines = [ln for ln in lines if not ln.strip().startswith("```")]
            cleaned = "\n".join(lines)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            # Try to find JSON object in the text
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start != -1 and end != -1 and end > start:
                try:
                    return json.loads(cleaned[start : end + 1])
                except json.JSONDecodeError:
                    pass
            return {"raw_response": text}

    def _default_plan(self, query: str, hours_back: int) -> List[Dict[str, Any]]:
        """Fallback investigation plan when AI planning fails."""
        return [
            {
                "tool": "clip_search",
                "params": {"text": query},
                "reason": "Search for visual matches to the query",
            },
            {
                "tool": "event_correlation",
                "params": {"time_window": 300, "min_cameras": 2},
                "reason": "Find correlated events across cameras",
            },
            {
                "tool": "timeline",
                "params": {"hours_back": hours_back},
                "reason": "Build evidence timeline",
            },
        ]


# Singleton
investigation_agent = InvestigationAgent()
