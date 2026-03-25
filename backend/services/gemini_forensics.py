"""Deep forensic analysis for investigations — uses Ollama reasoning/vision tiers."""

from __future__ import annotations

import base64
import json
import logging
import time
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)


FORENSIC_ANALYSIS_PROMPT = """You are SENTINEL AI Forensic Analyst. Perform deep forensic analysis on this security footage frame.

Context:
- Camera: {camera_id}
- Timestamp: {timestamp}
- Previous detections: {detections}
- Investigation query: {query}

Provide an extremely detailed forensic report in JSON:
{{
  "forensic_summary": "Detailed forensic summary",
  "persons_detailed": [
    {{
      "id": "person identifier",
      "physical_description": "Height estimate, build, clothing color/type, distinguishing features",
      "estimated_age_range": "range",
      "gender_presentation": "description",
      "clothing": "detailed clothing description",
      "carried_items": ["items being carried"],
      "behavior_analysis": "detailed behavior description",
      "body_language": "posture, gait analysis",
      "suspicious_indicators": ["any suspicious behaviors"]
    }}
  ],
  "vehicles_detailed": [
    {{
      "type": "vehicle type",
      "color": "color",
      "make_model_estimate": "if identifiable",
      "license_plate": "if readable or partial",
      "condition": "description",
      "occupants": "visible occupant count"
    }}
  ],
  "environment_analysis": {{
    "lighting": "lighting conditions",
    "weather_indicators": "if outdoor",
    "time_of_day_estimate": "based on lighting",
    "location_type": "indoor/outdoor/parking/etc"
  }},
  "evidence_markers": [
    {{
      "type": "physical evidence type",
      "location": "where in frame",
      "significance": "forensic significance"
    }}
  ],
  "behavioral_timeline": "Narrative of what appears to be happening",
  "risk_assessment": {{
    "immediate_threats": ["list"],
    "potential_threats": ["list"],
    "risk_score": 0-100
  }},
  "recommended_investigation_steps": ["list of next steps"]
}}

Be extremely thorough. This analysis may be used in legal proceedings."""


CORRELATION_PROMPT = """You are SENTINEL AI Cross-Camera Correlation Analyst.

Analyze these frames from multiple cameras taken at similar times and identify:
1. Same individuals appearing across cameras
2. Movement patterns and trajectories
3. Coordinated activities
4. Timeline of movements

Camera frames and detections:
{camera_data}

Provide analysis in JSON:
{{
  "correlated_subjects": [
    {{
      "subject_description": "identifying description",
      "appearances": [
        {{
          "camera_id": "camera",
          "timestamp": "time",
          "location_in_frame": "description"
        }}
      ],
      "movement_pattern": "described trajectory",
      "risk_level": "none|low|medium|high"
    }}
  ],
  "coordinated_activities": ["description of any coordinated behavior"],
  "timeline": [
    {{
      "time": "timestamp",
      "event": "what happened",
      "camera": "which camera"
    }}
  ],
  "overall_assessment": "summary"
}}"""


class GeminiForensics:
    """Deep forensic analysis using Ollama reasoning/vision tiers."""

    def __init__(self):
        self._call_count = 0

    async def analyze_frame_deep(
        self,
        frame: np.ndarray,
        camera_id: str = "unknown",
        timestamp: str = "",
        detections: Optional[Dict] = None,
        query: str = "Perform comprehensive forensic analysis",
    ) -> Dict[str, Any]:
        """Deep forensic analysis of a single frame."""
        ret, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        image_bytes = buf.tobytes()

        prompt = FORENSIC_ANALYSIS_PROMPT.format(
            camera_id=camera_id,
            timestamp=timestamp,
            detections=json.dumps(detections or {}, indent=2),
            query=query,
        )

        self._call_count += 1

        try:
            from backend.services.ollama_provider import ollama_analyze_image
            result = await ollama_analyze_image(image_bytes, prompt, max_tokens=4096)
            result["ai_provider"] = "ollama"
            return result
        except Exception as e:
            logger.error("Forensic analysis failed: %s", e)
            return {"error": str(e), "forensic_summary": "Analysis unavailable"}

    async def correlate_cameras(
        self,
        frames_data: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Cross-camera correlation analysis."""
        image_bytes_list: List[bytes] = []
        camera_info = []
        for item in frames_data:
            frame = item.get("frame")
            if frame is not None:
                ret, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                image_bytes_list.append(buf.tobytes())
            camera_info.append({
                "camera_id": item.get("camera_id", "unknown"),
                "timestamp": item.get("timestamp", ""),
                "detections": item.get("detections", {}),
            })

        prompt = CORRELATION_PROMPT.format(camera_data=json.dumps(camera_info, indent=2))
        self._call_count += 1

        try:
            from backend.services.ollama_provider import ollama_analyze_multiple_images
            result = await ollama_analyze_multiple_images(
                image_bytes_list, prompt, max_tokens=4096,
            )
            result["ai_provider"] = "ollama"
            return result
        except Exception as e:
            logger.error("Camera correlation failed: %s", e)
            return {"error": str(e)}

    async def generate_incident_summary(
        self,
        events: List[Dict[str, Any]],
        query: str = "",
    ) -> Dict[str, Any]:
        """Generate a narrative summary from a list of events."""
        prompt = f"""Analyze these security events and create a comprehensive incident summary.

Events: {json.dumps(events, indent=2, default=str)}
Query: {query}

Provide JSON:
{{
  "incident_summary": "narrative description",
  "key_findings": ["list of key findings"],
  "timeline_narrative": "chronological description",
  "subjects_involved": ["description of each subject"],
  "risk_assessment": "overall risk assessment",
  "recommended_actions": ["actionable recommendations"]
}}"""

        self._call_count += 1

        try:
            from backend.services.ollama_provider import ollama_generate_text, _parse_json_response
            text = await ollama_generate_text(prompt, temperature=0.1, max_tokens=2048, tier="reasoning")
            result = _parse_json_response(text)
            result["ai_provider"] = "ollama"
            return result
        except Exception as e:
            logger.error("Incident summary failed: %s", e)
            return {"summary": "Analysis unavailable", "error": str(e)}


# Singleton
gemini_forensics = GeminiForensics()
