"""Advanced structured scene intelligence (vision) — qwen2.5vl.

Goes beyond flat scene tagging: produces a scene GRAPH (objects + attributes +
spatial relations), activities/behaviours, environmental conditions, a natural-
language caption, and an EVIDENCE-CALIBRATED threat assessment. The calibration
guidance is deliberate — it keeps the richer analysis from re-introducing the
hallucinated-threat noise: the model must cite visual evidence and default to
benign, and low-evidence threats are demoted to human-review rather than alerts.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


SCENE_INTELLIGENCE_PROMPT = """You are SENTINEL AI's vision intelligence core — an expert physical-security scene analyst. Analyse this surveillance frame rigorously and OBJECTIVELY.

{detection_context}

Return ONLY a JSON object with EXACTLY this schema:
{{
  "caption": "one natural-language sentence describing the scene as a human operator would",
  "scene_graph": {{
    "objects": [
      {{"id": "o1", "label": "person|car|bag|door|...", "attributes": ["e.g. red jacket", "carrying backpack"], "position": "left|center|right|foreground|background", "confidence": 0.0-1.0}}
    ],
    "relations": [
      {{"subject": "o1", "predicate": "near|holding|entering|following|behind", "object": "o2"}}
    ]
  }},
  "people": [
    {{"appearance": "concise visual description", "posture": "standing|sitting|walking|running|crouching|lying_down", "behavior": "normal|loitering|tailgating|aggressive|fleeing|concealing|unknown", "confidence": 0.0-1.0}}
  ],
  "vehicles": [
    {{"type": "car|truck|van|motorcycle|bicycle", "appearance": "colour + features", "state": "parked|moving|stopped|reversing"}}
  ],
  "environment": {{"lighting": "bright|normal|dim|dark", "visibility": "clear|partial|obscured", "occlusions": ["list any"], "time_of_day_guess": "day|night|unknown"}},
  "activities": ["short verb phrases of what is happening, e.g. 'person walking toward door'"],
  "anomalies": [
    {{"description": "what is unusual", "evidence": "the SPECIFIC visual evidence you see for it", "confidence": 0.0-1.0}}
  ],
  "threat_assessment": {{
    "level": "none|low|medium|high|critical",
    "threats": [
      {{"type": "loitering|intrusion|weapon|abandoned_object|tailgating|aggression|fire_smoke|fall|crowd|other", "evidence": "the exact visual cue justifying this", "confidence": 0.0-1.0}}
    ],
    "reasoning": "1-2 sentences explaining the level, grounded in what is actually visible",
    "recommended_actions": ["operator action(s), or [] if none needed"],
    "requires_human_review": true|false
  }}
}}

CALIBRATION RULES — follow strictly:
- Report ONLY what is visually present. Never infer threats from imagination or from the camera/zone name.
- Every threat and anomaly MUST include concrete visual evidence; if you cannot point to evidence, do not list it.
- Default to "none"/"normal". An empty, quiet, or ordinary scene is "none" — that is the correct answer most of the time.
- Reserve "high"/"critical" for clear, unambiguous danger (visible weapon, fire, active assault, person down).
- If something is ambiguous, set a modest confidence and requires_human_review=true rather than raising the level."""


class SceneIntelligence:
    """Structured scene understanding via the local vision model."""

    async def analyze(
        self,
        image_bytes: bytes,
        detections: Optional[Dict[str, Any]] = None,
        camera_id: str = "unknown",
        max_tokens: int = 1536,
    ) -> Dict[str, Any]:
        """Return a structured scene-intelligence dict for one frame."""
        from backend.services.ollama_provider import ollama_analyze_image

        det_ctx = ""
        if detections:
            objs = detections.get("detections") if isinstance(detections, dict) else None
            counts = []
            if isinstance(detections, dict):
                if detections.get("person_count") is not None:
                    counts.append(f"{detections.get('person_count')} person(s)")
                if detections.get("vehicle_count") is not None:
                    counts.append(f"{detections.get('vehicle_count')} vehicle(s)")
            if counts:
                det_ctx = (
                    "An object detector reports: " + ", ".join(counts) + ". "
                    "Use this only as a hint; rely on what you actually see.\n"
                )

        prompt = SCENE_INTELLIGENCE_PROMPT.format(detection_context=det_ctx)
        try:
            result = await ollama_analyze_image(image_bytes, prompt, max_tokens=max_tokens)
        except Exception as exc:  # noqa: BLE001
            logger.warning("scene_intelligence.analyze failed for %s: %s", camera_id, exc)
            return self._empty("analysis_failed")

        if not isinstance(result, dict) or "raw_response" in result and len(result) == 1:
            return self._empty("unparseable")

        result = self._normalise(result)
        result["camera_id"] = camera_id
        result["source"] = "qwen2.5vl"
        return result

    @staticmethod
    def _normalise(r: Dict[str, Any]) -> Dict[str, Any]:
        """Fill missing keys with safe defaults so callers get a stable shape."""
        ta = r.get("threat_assessment") or {}
        if not isinstance(ta, dict):
            ta = {}
        ta.setdefault("level", "none")
        ta.setdefault("threats", [])
        ta.setdefault("reasoning", "")
        ta.setdefault("recommended_actions", [])
        ta.setdefault("requires_human_review", False)
        r["threat_assessment"] = ta
        r.setdefault("caption", "")
        r.setdefault("scene_graph", {"objects": [], "relations": []})
        r.setdefault("people", [])
        r.setdefault("vehicles", [])
        r.setdefault("environment", {})
        r.setdefault("activities", [])
        r.setdefault("anomalies", [])
        return r

    @staticmethod
    def _empty(reason: str) -> Dict[str, Any]:
        return {
            "caption": "",
            "scene_graph": {"objects": [], "relations": []},
            "people": [],
            "vehicles": [],
            "environment": {},
            "activities": [],
            "anomalies": [],
            "threat_assessment": {
                "level": "none", "threats": [], "reasoning": "",
                "recommended_actions": [], "requires_human_review": False,
            },
            "source": reason,
        }


scene_intelligence = SceneIntelligence()
