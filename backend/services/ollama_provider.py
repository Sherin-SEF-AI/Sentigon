"""Ollama AI provider — unified provider for all AI operations.

Uses Ollama's native /api/chat endpoint with intelligent model routing:
- Tier 1 (reasoning): deepseek-v3.1:671b-cloud — investigations, forensics, copilot
- Tier 2 (standard): gemma3:27b-cloud — perception agents, text analysis
- Tier 3 (vision): qwen3-vl:235b-cloud — frame analysis, image understanding
- Tier 4 (fast): qwen3.5:0.8b — quick classifications, simple responses

Fallback chain: gpt-oss:120b-cloud -> glm-5:cloud -> kimi-k2.5:cloud
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
from typing import Any, Callable, Dict, List, Optional

import httpx

from backend.config import settings

logger = logging.getLogger(__name__)

# ── Client management ─────────────────────────────────────

_http_client: Optional[httpx.AsyncClient] = None
_available: Optional[bool] = None


def _get_base_url() -> str:
    return (settings.OLLAMA_HOST or "http://localhost:11434").rstrip("/")


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            base_url=_get_base_url(),
            timeout=httpx.Timeout(connect=5.0, read=180.0, write=10.0, pool=5.0),
        )
    return _http_client


async def is_available() -> bool:
    """Check if Ollama is running."""
    global _available
    try:
        client = _get_client()
        resp = await client.get("/api/tags")
        if resp.status_code == 200:
            _available = True
            return True
        _available = False
        return False
    except Exception as e:
        logger.debug("Ollama not reachable: %s", e)
        _available = False
        return False


def is_available_sync() -> bool:
    """Non-async availability check using cached result."""
    if _available is None:
        return True  # Optimistic — will fail on first call and update
    return _available


# ── Model tier helpers ────────────────────────────────────

def get_model_for_tier(tier: str) -> str:
    """Get the configured model name for a given tier.

    Tiers:
        reasoning — deep analysis, investigations, forensics, copilot
        standard  — perception agents, general text analysis
        vision    — frame/image analysis
        fast      — quick classifications, simple responses
    """
    tier_map = {
        "reasoning": settings.OLLAMA_REASONING_MODEL,
        "standard": settings.OLLAMA_STANDARD_MODEL,
        "vision": settings.OLLAMA_VISION_MODEL,
        "fast": settings.OLLAMA_FAST_MODEL,
    }
    return tier_map.get(tier, settings.OLLAMA_STANDARD_MODEL)


def get_fallback_models() -> List[str]:
    """Get the ordered list of fallback models."""
    raw = settings.OLLAMA_FALLBACK_MODELS or ""
    return [m.strip() for m in raw.split(",") if m.strip()]


# ── Core API call (native Ollama /api/chat) ───────────────

_MAX_RETRIES = 2
_RETRY_DELAY = 1.0
# Limit concurrent Ollama calls to prevent overload (Ollama processes sequentially)
_ollama_semaphore = asyncio.Semaphore(1)  # Single concurrent request to prevent OOM


async def _native_chat(
    messages: List[Dict[str, Any]],
    model: Optional[str] = None,
    num_predict: int = 2048,
    temperature: float = 0.3,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Call Ollama's native /api/chat endpoint (concurrency-limited)."""
    global _available
    async with _ollama_semaphore:
        return await _native_chat_inner(messages, model, num_predict, temperature, tools)


async def _native_chat_inner(
    messages: List[Dict[str, Any]],
    model: Optional[str] = None,
    num_predict: int = 2048,
    temperature: float = 0.3,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Inner chat implementation."""
    global _available
    client = _get_client()

    payload: Dict[str, Any] = {
        "model": model or settings.OLLAMA_STANDARD_MODEL,
        "messages": messages,
        "stream": False,
        "options": {
            "num_predict": num_predict,
            "temperature": temperature,
        },
    }
    if tools:
        payload["tools"] = tools

    last_error = None
    for attempt in range(_MAX_RETRIES):
        try:
            resp = await client.post("/api/chat", json=payload)
            resp.raise_for_status()
            _available = True
            return resp.json()
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            _available = False
            last_error = e
            logger.warning(
                "Ollama connection failed (attempt %d/%d): %s",
                attempt + 1, _MAX_RETRIES, e,
            )
            if attempt < _MAX_RETRIES - 1:
                await asyncio.sleep(_RETRY_DELAY)
        except httpx.HTTPStatusError as e:
            last_error = e
            if e.response.status_code == 429:
                logger.warning("Ollama rate limited (429), retrying in 2s...")
                await asyncio.sleep(2.0)
                continue
            logger.warning("Ollama HTTP error: %s", e)
            raise
        except Exception as e:
            last_error = e
            logger.warning("Ollama unexpected error: %s", e)
            raise

    raise RuntimeError(f"Ollama unreachable after {_MAX_RETRIES} attempts: {last_error}")


async def _chat_with_fallback(
    messages: List[Dict[str, Any]],
    primary_model: str,
    num_predict: int = 2048,
    temperature: float = 0.3,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Try primary model, then fallback models in order."""
    try:
        return await _native_chat(messages, model=primary_model,
                                   num_predict=num_predict, temperature=temperature,
                                   tools=tools)
    except Exception as primary_err:
        logger.warning("Primary model %s failed: %s — trying fallbacks", primary_model, primary_err)

    for fallback in get_fallback_models():
        try:
            logger.info("Trying fallback model: %s", fallback)
            return await _native_chat(messages, model=fallback,
                                       num_predict=num_predict, temperature=temperature,
                                       tools=tools)
        except Exception as fb_err:
            logger.warning("Fallback model %s failed: %s", fallback, fb_err)
            continue

    raise RuntimeError(f"All models failed. Primary: {primary_model}, fallbacks: {get_fallback_models()}")


def _extract_content(response: Dict[str, Any]) -> str:
    """Extract text content from native Ollama response, stripping <think> tags."""
    text = response.get("message", {}).get("content", "") or ""
    text = re.sub(r"<think>[\s\S]*?</think>\s*", "", text).strip()
    return text


# ── Public API ────────────────────────────────────────────

async def ollama_generate_text(
    prompt: str,
    system_prompt: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    model: Optional[str] = None,
    tier: str = "standard",
) -> str:
    """Text generation via Ollama. Returns the response text."""
    messages: List[Dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    resolved_model = model or get_model_for_tier(tier)
    result = await _chat_with_fallback(
        messages=messages,
        primary_model=resolved_model,
        num_predict=max_tokens,
        temperature=temperature,
    )

    return _extract_content(result)


async def ollama_analyze_image(
    image_bytes: bytes,
    prompt: str,
    max_tokens: int = 2048,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Vision analysis via Ollama (qwen3-vl or similar).

    Sends image via native 'images' field (base64-encoded).
    Returns parsed JSON dict or raw text dict.
    """
    img_b64 = base64.b64encode(image_bytes).decode("utf-8")

    messages = [
        {
            "role": "user",
            "content": prompt,
            "images": [img_b64],
        }
    ]

    result = await _chat_with_fallback(
        messages=messages,
        primary_model=model or settings.OLLAMA_VISION_MODEL,
        num_predict=max_tokens,
        temperature=0.3,
    )

    text = _extract_content(result)
    return _parse_json_response(text)


async def ollama_analyze_multiple_images(
    images: List[bytes],
    prompt: str,
    max_tokens: int = 4096,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Vision analysis with multiple images."""
    images_b64 = [base64.b64encode(img).decode("utf-8") for img in images]

    messages = [
        {
            "role": "user",
            "content": prompt,
            "images": images_b64,
        }
    ]

    result = await _chat_with_fallback(
        messages=messages,
        primary_model=model or settings.OLLAMA_VISION_MODEL,
        num_predict=max_tokens,
        temperature=0.3,
    )

    text = _extract_content(result)
    return _parse_json_response(text)


async def ollama_generate_with_tools(
    prompt: str,
    tools_schema: List[Dict[str, Any]],
    tool_executor: Callable,
    system_prompt: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    max_iterations: int = 10,
    model: Optional[str] = None,
    tier: str = "standard",
) -> Dict[str, Any]:
    """Function-calling loop via Ollama native API.

    Args:
        prompt: The user prompt
        tools_schema: List of OpenAI-format tool definitions
        tool_executor: Async callable(name, args) -> result dict
        system_prompt: Optional system instruction
        temperature: Sampling temperature
        max_tokens: Max output tokens
        max_iterations: Max tool-call rounds
        model: Override model name
        tier: Model tier for routing

    Returns:
        {"response": str, "tool_calls": list}
    """
    messages: List[Dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    tool_calls_made: List[Dict[str, Any]] = []
    resolved_model = model or get_model_for_tier(tier)

    for _ in range(max_iterations):
        result = await _chat_with_fallback(
            messages=messages,
            primary_model=resolved_model,
            num_predict=max_tokens,
            temperature=temperature,
            tools=tools_schema if tools_schema else None,
        )

        msg = result.get("message", {})

        # If no tool calls, this is the final response
        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            return {
                "response": _extract_content(result),
                "tool_calls": tool_calls_made,
            }

        # Process tool calls
        messages.append({
            "role": "assistant",
            "content": msg.get("content", ""),
            "tool_calls": tool_calls,
        })

        for tc in tool_calls:
            fn = tc.get("function", {})
            fn_name = fn.get("name", "")
            fn_args = fn.get("arguments", {})
            if isinstance(fn_args, str):
                try:
                    fn_args = json.loads(fn_args)
                except (json.JSONDecodeError, TypeError):
                    fn_args = {}

            call_result = await tool_executor(fn_name, fn_args)

            tool_calls_made.append({
                "tool": fn_name,
                "args": fn_args,
                "result_summary": str(call_result)[:300],
            })

            messages.append({
                "role": "tool",
                "content": json.dumps(call_result, default=str)[:4000],
            })

    return {
        "response": "Max tool call iterations reached",
        "tool_calls": tool_calls_made,
        "truncated": True,
    }


def _parse_json_response(text: str) -> Dict[str, Any]:
    """Parse JSON from Ollama response, handling markdown code blocks."""
    cleaned = text.strip()

    # Extract JSON from markdown code blocks anywhere in the response
    if "```" in cleaned:
        match = re.search(r"```(?:json)?\s*\n([\s\S]*?)\n```", cleaned)
        if match:
            cleaned = match.group(1).strip()

    # Try to find JSON object directly
    if not cleaned.startswith("{"):
        start = cleaned.find("{")
        if start != -1:
            depth = 0
            for i in range(start, len(cleaned)):
                if cleaned[i] == "{":
                    depth += 1
                elif cleaned[i] == "}":
                    depth -= 1
                    if depth == 0:
                        cleaned = cleaned[start:i + 1]
                        break

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {"raw_response": text}
