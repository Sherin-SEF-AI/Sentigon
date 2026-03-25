"""Real-time scene analysis using Ollama vision models with rate limiting."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Any, Dict, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)


SCENE_ANALYSIS_PROMPT = """You are SENTINEL AI, an expert physical security analyst. Analyze this security camera frame.

YOLO Detection Context:
{detections}

Provide a structured JSON response with these fields:
{{
  "scene_description": "Brief description of the scene",
  "activity_level": "idle|low|moderate|high|critical",
  "persons": [
    {{
      "description": "Physical description (clothing, posture, behavior)",
      "behavior": "normal|suspicious|threatening|loitering|running",
      "location_in_frame": "description of where in the frame"
    }}
  ],
  "vehicles": [
    {{
      "type": "car|truck|van|motorcycle|bicycle",
      "description": "Color, distinguishing features",
      "behavior": "parked|moving|speeding|stopped_illegally"
    }}
  ],
  "objects_of_interest": ["list of notable objects"],
  "anomalies": ["list of anything unusual or concerning"],
  "threat_indicators": [
    {{
      "type": "threat type",
      "confidence": 0.0-1.0,
      "description": "what was detected"
    }}
  ],
  "recommended_actions": ["list of suggested operator actions"],
  "overall_risk": "none|low|medium|high|critical"
}}

Be precise and security-focused. Flag loitering, unauthorized access, abandoned objects, aggressive behavior, perimeter breaches, tailgating, and unusual patterns."""


class GeminiAnalyzer:
    """Real-time scene analysis using Ollama vision models with concurrency
    control and exponential backoff on rate-limit (429) responses."""

    # Concurrency / backoff configuration
    MAX_CONCURRENT_REQUESTS: int = 4
    BACKOFF_BASE: float = 1.0
    BACKOFF_MAX: float = 32.0
    MAX_BACKOFF_RETRIES: int = 4

    def __init__(self):
        self._last_call_time: float = 0.0
        self._min_interval: float = 1.0
        self._call_count: int = 0
        self._rate_limit_window: float = 60.0
        self._max_calls_per_window: int = 30
        self._window_start: float = 0.0
        self._window_calls: int = 0
        # Semaphore to cap concurrent requests to the vision model
        self._semaphore: asyncio.Semaphore = asyncio.Semaphore(self.MAX_CONCURRENT_REQUESTS)
        # Simple last-good-result cache keyed by camera_id
        self._result_cache: Dict[str, Dict[str, Any]] = {}

    def _check_rate_limit(self) -> bool:
        now = time.time()
        if now - self._window_start > self._rate_limit_window:
            self._window_start = now
            self._window_calls = 0
        if self._window_calls >= self._max_calls_per_window:
            return False
        if now - self._last_call_time < self._min_interval:
            return False
        return True

    def _frame_to_bytes(self, frame: np.ndarray, quality: int = 60) -> bytes:
        ret, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ret:
            raise ValueError("Failed to encode frame")
        return buf.tobytes()

    async def analyze_frame(
        self,
        frame: np.ndarray,
        detections: Optional[Dict[str, Any]] = None,
        camera_id: str = "unknown",
    ) -> Optional[Dict[str, Any]]:
        """Analyze a single frame with Ollama vision model.

        Uses an asyncio.Semaphore to limit concurrent requests and retries
        with exponential backoff when a 429 (rate-limited) response is received.
        """
        from backend.services.operation_mode import operation_mode_service
        perf = operation_mode_service.get_performance_config()
        if not perf.get("gemini_enabled", True):
            return self._fallback_analysis(detections)

        if not self._check_rate_limit():
            return None

        image_bytes = self._frame_to_bytes(frame)
        det_context = json.dumps(detections or {}, indent=2)
        prompt = SCENE_ANALYSIS_PROMPT.format(detections=det_context)

        self._last_call_time = time.time()
        self._window_calls += 1
        self._call_count += 1

        # Acquire semaphore to limit concurrent requests
        async with self._semaphore:
            result = await self._call_with_backoff(image_bytes, prompt, camera_id, detections)
            return result

    async def _call_with_backoff(
        self,
        image_bytes: bytes,
        prompt: str,
        camera_id: str,
        detections: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        """Call the vision model with exponential backoff on 429 responses."""
        import asyncio as _asyncio

        for attempt in range(self.MAX_BACKOFF_RETRIES + 1):
            try:
                from backend.services.ollama_provider import ollama_analyze_image
                result = await ollama_analyze_image(image_bytes, prompt)
                if result:
                    result["camera_id"] = camera_id
                    result["analysis_source"] = "ollama_vision"
                    result["ai_provider"] = "ollama"
                    # Cache successful result
                    self._result_cache[camera_id] = result
                    return result
            except Exception as e:
                err_str = str(e).lower()
                is_rate_limited = "429" in err_str or "rate" in err_str or "too many" in err_str
                if is_rate_limited and attempt < self.MAX_BACKOFF_RETRIES:
                    backoff = min(
                        self.BACKOFF_BASE * (2 ** attempt),
                        self.BACKOFF_MAX,
                    )
                    logger.warning(
                        "Ollama 429 rate-limited for camera %s (attempt %d/%d), "
                        "retrying in %.1fs",
                        camera_id, attempt + 1, self.MAX_BACKOFF_RETRIES, backoff,
                    )
                    await _asyncio.sleep(backoff)
                    continue
                else:
                    logger.warning(
                        "Ollama vision analysis failed for camera %s: %s",
                        camera_id, e,
                    )
                    break

        # All retries exhausted or non-retryable error — return cached or fallback
        cached = self._result_cache.get(camera_id)
        if cached:
            logger.info("Returning cached analysis for camera %s", camera_id)
            cached_copy = dict(cached)
            cached_copy["analysis_source"] = "cached_fallback"
            return cached_copy

        return self._fallback_analysis(detections)

    def _fallback_analysis(self, detections: Optional[Dict]) -> Dict[str, Any]:
        """Basic analysis from YOLO detections alone when AI is unavailable."""
        if not detections:
            return {
                "scene_description": "No analysis available",
                "activity_level": "unknown",
                "overall_risk": "none",
                "analysis_source": "fallback",
            }

        person_count = detections.get("person_count", 0)
        vehicle_count = detections.get("vehicle_count", 0)
        total = detections.get("total_objects", 0)

        if total == 0:
            level = "idle"
            risk = "none"
        elif person_count <= 2 and vehicle_count <= 1:
            level = "low"
            risk = "low"
        elif person_count <= 5:
            level = "moderate"
            risk = "low"
        else:
            level = "high"
            risk = "medium"

        return {
            "scene_description": f"{person_count} persons, {vehicle_count} vehicles detected",
            "activity_level": level,
            "persons": [{"description": "detected via YOLO", "behavior": "unknown"}] * person_count,
            "vehicles": [{"type": "unknown", "behavior": "unknown"}] * vehicle_count,
            "overall_risk": risk,
            "analysis_source": "fallback_yolo",
        }

    @property
    def stats(self) -> Dict[str, Any]:
        return {
            "total_calls": self._call_count,
            "window_calls": self._window_calls,
        }


# Singleton
gemini_analyzer = GeminiAnalyzer()
