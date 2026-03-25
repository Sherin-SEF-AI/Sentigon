"""Gemini AI provider with built-in rate limiting.

Uses Google's Generative Language API (gemini-2.0-flash / gemini-2.5-flash).
Rate limited to prevent GCP account suspension.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections import deque
from typing import Any, Dict, List, Optional

import httpx

from backend.config import settings

logger = logging.getLogger(__name__)

# ── Rate limiter ──────────────────────────────────────────────
# Tracks timestamps of recent requests to enforce per-minute limit

_request_timestamps: deque = deque(maxlen=200)
_rate_lock = asyncio.Lock()


async def _wait_for_rate_limit():
    """Wait if we've exceeded the rate limit."""
    async with _rate_lock:
        now = time.time()
        # Remove timestamps older than 60 seconds
        while _request_timestamps and _request_timestamps[0] < now - 60:
            _request_timestamps.popleft()

        if len(_request_timestamps) >= settings.GEMINI_RATE_LIMIT:
            # Wait until the oldest request expires
            wait_time = 60 - (now - _request_timestamps[0]) + 0.5
            if wait_time > 0:
                logger.info("Gemini rate limit reached (%d/%d), waiting %.1fs",
                            len(_request_timestamps), settings.GEMINI_RATE_LIMIT, wait_time)
                await asyncio.sleep(wait_time)

        _request_timestamps.append(time.time())


# ── HTTP Client ───────────────────────────────────────────────

_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0),
        )
    return _client


# ── Core API ──────────────────────────────────────────────────

async def gemini_generate(
    prompt: str,
    model: Optional[str] = None,
    max_tokens: int = 2048,
    temperature: float = 0.3,
    system_prompt: Optional[str] = None,
    json_mode: bool = False,
) -> Dict[str, Any]:
    """Generate text using Gemini API with rate limiting.

    Returns: {"text": "...", "model": "...", "tokens": N}
    """
    if not settings.GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not configured")

    await _wait_for_rate_limit()

    resolved_model = model or settings.GEMINI_MODEL
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{resolved_model}:generateContent"

    contents = []
    if system_prompt:
        contents.append({"role": "user", "parts": [{"text": system_prompt}]})
        contents.append({"role": "model", "parts": [{"text": "Understood. I will follow these instructions."}]})
    contents.append({"role": "user", "parts": [{"text": prompt}]})

    payload: Dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "temperature": temperature,
        },
    }

    if json_mode:
        payload["generationConfig"]["responseMimeType"] = "application/json"

    client = _get_client()
    try:
        resp = await client.post(
            url,
            json=payload,
            params={"key": settings.GEMINI_API_KEY},
        )
        resp.raise_for_status()
        data = resp.json()

        # Extract text from response
        candidates = data.get("candidates", [])
        if not candidates:
            return {"text": "", "model": resolved_model, "tokens": 0}

        parts = candidates[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)

        usage = data.get("usageMetadata", {})
        total_tokens = usage.get("totalTokenCount", 0)

        return {
            "text": text,
            "model": resolved_model,
            "tokens": total_tokens,
            "provider": "gemini",
        }

    except httpx.HTTPStatusError as e:
        if e.response.status_code == 429:
            logger.warning("Gemini 429 rate limited — falling back to Ollama")
            raise
        elif e.response.status_code == 403:
            logger.error("Gemini 403 forbidden — check API key permissions")
            raise
        else:
            logger.error("Gemini error %d: %s", e.response.status_code, e.response.text[:200])
            raise
    except Exception as e:
        logger.error("Gemini request failed: %s", e)
        raise


async def gemini_analyze_image(
    image_bytes: bytes,
    prompt: str,
    model: Optional[str] = None,
    max_tokens: int = 2048,
) -> Dict[str, Any]:
    """Analyze an image using Gemini Vision with rate limiting."""
    if not settings.GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not configured")

    await _wait_for_rate_limit()

    resolved_model = model or settings.GEMINI_MODEL
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{resolved_model}:generateContent"

    img_b64 = base64.b64encode(image_bytes).decode("utf-8")

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": "image/jpeg", "data": img_b64}},
            ],
        }],
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "temperature": 0.2,
        },
    }

    client = _get_client()
    try:
        resp = await client.post(
            url,
            json=payload,
            params={"key": settings.GEMINI_API_KEY},
        )
        resp.raise_for_status()
        data = resp.json()

        candidates = data.get("candidates", [])
        if not candidates:
            return {"text": "", "model": resolved_model, "tokens": 0}

        parts = candidates[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)

        return {
            "text": text,
            "model": resolved_model,
            "provider": "gemini",
        }

    except Exception as e:
        logger.error("Gemini vision failed: %s", e)
        raise


async def gemini_generate_with_fallback(
    prompt: str,
    model: Optional[str] = None,
    max_tokens: int = 2048,
    temperature: float = 0.3,
    system_prompt: Optional[str] = None,
) -> Dict[str, Any]:
    """Try Gemini first, fall back to Ollama if Gemini fails."""
    try:
        return await gemini_generate(
            prompt=prompt,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            system_prompt=system_prompt,
        )
    except Exception as gemini_err:
        logger.warning("Gemini failed (%s), falling back to Ollama", gemini_err)
        try:
            from backend.services.ollama_provider import ollama_generate_text
            text = await ollama_generate_text(
                prompt=prompt,
                max_tokens=max_tokens,
                temperature=temperature,
                system_prompt=system_prompt,
            )
            return {
                "text": text,
                "model": settings.OLLAMA_STANDARD_MODEL,
                "provider": "ollama_fallback",
            }
        except Exception as ollama_err:
            logger.error("Both Gemini and Ollama failed: gemini=%s, ollama=%s", gemini_err, ollama_err)
            return {"text": "", "model": "none", "provider": "failed", "error": str(gemini_err)}


# ── Status ────────────────────────────────────────────────────

def get_status() -> Dict[str, Any]:
    """Get Gemini provider status."""
    now = time.time()
    recent = sum(1 for t in _request_timestamps if t > now - 60)
    return {
        "enabled": settings.GEMINI_ENABLED,
        "api_key_set": bool(settings.GEMINI_API_KEY),
        "model": settings.GEMINI_MODEL,
        "pro_model": settings.GEMINI_PRO_MODEL,
        "rate_limit": settings.GEMINI_RATE_LIMIT,
        "requests_last_minute": recent,
        "remaining_quota": max(0, settings.GEMINI_RATE_LIMIT - recent),
    }
