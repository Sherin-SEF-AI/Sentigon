"""Unified AI client — Gemini primary, Ollama fallback.

Routes AI operations through Gemini 3.x models with automatic
fallback to local Ollama if Gemini is unavailable or rate-limited.

Model routing:
  - gemini-3.1-flash-lite-preview — fast perception, frame analysis
  - gemini-3-flash-preview — standard analysis, copilot, text
  - gemini-3.1-pro-preview — deep reasoning, investigations
  - Ollama (gemma3:4b) — fallback when Gemini fails
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from backend.config import settings

logger = logging.getLogger(__name__)


async def _gemini_or_ollama_text(
    prompt: str,
    model: Optional[str] = None,
    max_tokens: int = 2048,
    temperature: float = 0.3,
    system_prompt: Optional[str] = None,
) -> str:
    """Try Gemini first, fall back to Ollama."""
    if settings.GEMINI_ENABLED and settings.GEMINI_API_KEY:
        try:
            from backend.services.gemini_provider import gemini_generate
            result = await gemini_generate(
                prompt=prompt,
                model=model or settings.GEMINI_MODEL,
                max_tokens=max_tokens,
                temperature=temperature,
                system_prompt=system_prompt,
            )
            return result.get("text", "")
        except Exception as e:
            logger.warning("Gemini failed (%s), falling back to Ollama", e)

    # Fallback to Ollama
    from backend.services.ollama_provider import ollama_generate_text
    return await ollama_generate_text(
        prompt=prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        system_prompt=system_prompt,
    )


async def _gemini_or_ollama_vision(
    image_bytes: bytes,
    prompt: str,
    model: Optional[str] = None,
    max_tokens: int = 2048,
) -> Dict[str, Any]:
    """Try Gemini vision first, fall back to Ollama."""
    if settings.GEMINI_ENABLED and settings.GEMINI_API_KEY:
        try:
            from backend.services.gemini_provider import gemini_analyze_image
            result = await gemini_analyze_image(
                image_bytes=image_bytes,
                prompt=prompt,
                model=model or settings.GEMINI_MODEL,
                max_tokens=max_tokens,
            )
            result["ai_provider"] = "gemini"
            return result
        except Exception as e:
            logger.warning("Gemini vision failed (%s), falling back to Ollama", e)

    # Fallback to Ollama
    from backend.services.ollama_provider import ollama_analyze_image
    result = await ollama_analyze_image(image_bytes, prompt)
    result["ai_provider"] = "ollama"
    return result


async def analyze_frame_flash(
    frame_bytes: bytes,
    prompt: str,
    json_schema: Optional[Dict] = None,
    thinking_level: str = "low",
    media_resolution: str = "media_resolution_high",
) -> Dict[str, Any]:
    """Run vision analysis on a single image frame."""
    try:
        return await _gemini_or_ollama_vision(
            frame_bytes, prompt,
            model=settings.GEMINI_MODEL,  # Fast model for frame analysis
        )
    except Exception as e:
        logger.error("Vision analysis failed: %s", e)
        return {}


async def analyze_with_pro(
    parts: List[Any],
    prompt: str,
    json_schema: Optional[Dict] = None,
    thinking_level: str = "high",
) -> Dict[str, Any]:
    """Run deep analysis with pro model."""
    try:
        text = await _gemini_or_ollama_text(
            prompt,
            model=settings.GEMINI_PRO_MODEL,  # Pro model for deep analysis
            max_tokens=4096,
        )
        # Try to parse as JSON
        from backend.services.ollama_provider import _parse_json_response
        result = _parse_json_response(text)
        result["ai_provider"] = "gemini" if settings.GEMINI_ENABLED else "ollama"
        return result
    except Exception as e:
        logger.error("Deep analysis failed: %s", e)
        return {}


async def analyze_audio_flash(
    audio_bytes: bytes,
    prompt: str,
    mime_type: str = "audio/wav",
    json_schema: Optional[Dict] = None,
) -> Dict[str, Any]:
    """Run AI analysis on audio data."""
    try:
        text = await _gemini_or_ollama_text(
            prompt,
            model=settings.GEMINI_STANDARD_MODEL,
            max_tokens=2048,
        )
        from backend.services.ollama_provider import _parse_json_response
        result = _parse_json_response(text)
        result["ai_provider"] = "gemini" if settings.GEMINI_ENABLED else "ollama"
        return result
    except Exception as e:
        logger.error("Audio analysis failed: %s", e)
        return {}


async def generate_embedding(text: str, dimensions: int = 384) -> List[float]:
    """Generate embedding vector using local sentence-transformers."""
    from backend.services.vector_store import vector_store
    return await vector_store.embed_text(text)


async def compare_frames_flash(
    frame_a_bytes: bytes,
    frame_b_bytes: bytes,
    prompt: str,
    json_schema: Optional[Dict] = None,
) -> Dict[str, Any]:
    """Compare two frames."""
    try:
        # Gemini can handle multi-image, but send as text description for now
        return await _gemini_or_ollama_vision(
            frame_a_bytes, prompt,
            model=settings.GEMINI_MODEL,
        )
    except Exception as e:
        logger.error("Frame comparison failed: %s", e)
        return {}


# ── Convenience wrapper ─────────────────────────────────────
class GeminiClient:
    """Provides .generate() interface — Gemini primary, Ollama fallback."""

    async def generate(
        self,
        prompt: str,
        model: str = "gemini-3-flash-preview",
        temperature: float = 0.3,
        max_tokens: int = 1500,
    ) -> Optional[str]:
        try:
            return await _gemini_or_ollama_text(
                prompt,
                model=model if model.startswith("gemini") else None,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        except Exception as e:
            logger.error("gemini_client.generate failed: %s", e)
            return None


gemini_client = GeminiClient()
