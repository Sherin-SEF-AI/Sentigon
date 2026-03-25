"""Groq AI provider — fallback when Gemini is unavailable.

Uses Groq's OpenAI-compatible API with Llama 4 Scout (vision + tools)
and Llama 4 Maverick (deep analysis).

Supports multiple API keys with round-robin rotation for higher throughput.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from backend.config import settings

logger = logging.getLogger(__name__)

# ── Multi-key round-robin pool ────────────────────────────────

_groq_clients: List[Any] = []
_client_index: int = 0
_pool_lock = threading.Lock()
_initialized = False


def _init_pool():
    """Parse comma-separated GROQ_API_KEY and create one client per key."""
    global _groq_clients, _initialized
    if _initialized:
        return

    raw = settings.GROQ_API_KEY or ""
    keys = [k.strip() for k in raw.split(",") if k.strip()]

    if not keys:
        logger.warning("GROQ_API_KEY not set — Groq provider unavailable")
        _initialized = True
        return

    from groq import Groq
    for i, key in enumerate(keys):
        _groq_clients.append(Groq(api_key=key))

    logger.info(
        "Groq pool initialized: %d keys, models: %s, %s",
        len(_groq_clients), settings.GROQ_TEXT_MODEL, settings.GROQ_PRO_MODEL,
    )
    _initialized = True


def get_groq_client():
    """Get the next Groq client via round-robin rotation."""
    global _client_index

    if not _initialized:
        _init_pool()

    if not _groq_clients:
        return None

    with _pool_lock:
        client = _groq_clients[_client_index % len(_groq_clients)]
        _client_index += 1
    return client


def get_pool_size() -> int:
    """Return number of API keys in the pool."""
    if not _initialized:
        _init_pool()
    return len(_groq_clients)


def is_available() -> bool:
    """Check if Groq provider is configured."""
    if not _initialized:
        _init_pool()
    return len(_groq_clients) > 0


# ── Rate limit handling ───────────────────────────────────────

_MAX_RETRIES = 3
_RETRY_DELAY = 1.0  # seconds


async def _call_with_retry(fn, *args, **kwargs):
    """Call a Groq API function with retry on rate limit (429).

    On 429, rotates to the next key and retries.
    """
    last_error = None
    for attempt in range(_MAX_RETRIES):
        client = get_groq_client()
        if client is None:
            raise RuntimeError("Groq client not available — GROQ_API_KEY not set")
        try:
            return await asyncio.to_thread(fn, client, *args, **kwargs)
        except Exception as e:
            err_str = str(e)
            # Rate limited — try next key
            if "429" in err_str or "rate_limit" in err_str.lower():
                logger.warning(
                    "Groq rate limited (key #%d), rotating to next key (attempt %d/%d)",
                    (_client_index - 1) % len(_groq_clients), attempt + 1, _MAX_RETRIES,
                )
                last_error = e
                await asyncio.sleep(_RETRY_DELAY * (attempt + 1))
                continue
            raise
    raise last_error


def _chat_create(client, *, model, messages, **kwargs):
    """Wrapper for client.chat.completions.create (used by _call_with_retry)."""
    return client.chat.completions.create(
        model=model, messages=messages, **kwargs,
    )


# ── Public API ────────────────────────────────────────────────

async def groq_generate_text(
    prompt: str,
    system_prompt: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    model: Optional[str] = None,
) -> str:
    """Text generation via Groq. Returns the response text."""
    messages: List[Dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    response = await _call_with_retry(
        _chat_create,
        model=model or settings.GROQ_TEXT_MODEL,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
    )

    return response.choices[0].message.content or ""


async def groq_analyze_image(
    image_bytes: bytes,
    prompt: str,
    max_tokens: int = 2048,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Vision analysis via Groq Llama 4 Scout.

    Sends image as base64 data URL in the OpenAI vision format.
    Returns parsed JSON dict or raw text dict.
    """
    img_b64 = base64.b64encode(image_bytes).decode("utf-8")

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{img_b64}",
                    },
                },
            ],
        }
    ]

    response = await _call_with_retry(
        _chat_create,
        model=model or settings.GROQ_VISION_MODEL,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.3,
    )

    text = response.choices[0].message.content or ""
    return _parse_json_response(text)


async def groq_analyze_multiple_images(
    images: List[bytes],
    prompt: str,
    max_tokens: int = 4096,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Vision analysis with multiple images (e.g. cross-camera correlation)."""
    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    for img_bytes in images:
        img_b64 = base64.b64encode(img_bytes).decode("utf-8")
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"},
        })

    messages = [{"role": "user", "content": content}]

    response = await _call_with_retry(
        _chat_create,
        model=model or settings.GROQ_VISION_MODEL,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.3,
    )

    text = response.choices[0].message.content or ""
    return _parse_json_response(text)


async def groq_generate_with_tools(
    prompt: str,
    tools_schema: List[Dict[str, Any]],
    tool_executor: Callable,
    system_prompt: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    max_iterations: int = 10,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Function-calling loop via Groq (OpenAI-compatible tool calling).

    Args:
        prompt: The user prompt
        tools_schema: List of OpenAI-format tool definitions
        tool_executor: Async callable(name, args) -> result dict
        system_prompt: Optional system instruction
        temperature: Sampling temperature
        max_tokens: Max output tokens
        max_iterations: Max tool-call rounds
        model: Override model name

    Returns:
        {"response": str, "tool_calls": list}
    """
    messages: List[Dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    tool_calls_made: List[Dict[str, Any]] = []

    for _ in range(max_iterations):
        response = await _call_with_retry(
            _chat_create,
            model=model or settings.GROQ_TEXT_MODEL,
            messages=messages,
            tools=tools_schema if tools_schema else None,
            tool_choice="auto" if tools_schema else None,
            temperature=temperature,
            max_tokens=max_tokens,
        )

        choice = response.choices[0]
        msg = choice.message

        # If no tool calls, this is the final response
        if not msg.tool_calls:
            return {
                "response": msg.content or "",
                "tool_calls": tool_calls_made,
            }

        # Process tool calls
        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ],
        })

        for tc in msg.tool_calls:
            fn_name = tc.function.name
            try:
                fn_args = json.loads(tc.function.arguments)
            except json.JSONDecodeError:
                fn_args = {}

            # Execute the tool
            result = await tool_executor(fn_name, fn_args)

            tool_calls_made.append({
                "tool": fn_name,
                "args": fn_args,
                "result_summary": str(result)[:300],
            })

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(result, default=str)[:4000],
            })

    return {
        "response": "Max tool call iterations reached",
        "tool_calls": tool_calls_made,
        "truncated": True,
    }


def _parse_json_response(text: str) -> Dict[str, Any]:
    """Parse JSON from Groq response, handling markdown code blocks."""
    cleaned = text.strip()

    # Extract JSON from markdown code blocks anywhere in the response
    if "```" in cleaned:
        import re
        match = re.search(r"```(?:json)?\s*\n([\s\S]*?)\n```", cleaned)
        if match:
            cleaned = match.group(1).strip()

    # Try to find JSON object directly
    if not cleaned.startswith("{"):
        start = cleaned.find("{")
        if start != -1:
            # Find matching closing brace
            depth = 0
            for i in range(start, len(cleaned)):
                if cleaned[i] == "{":
                    depth += 1
                elif cleaned[i] == "}":
                    depth -= 1
                    if depth == 0:
                        cleaned = cleaned[start:i+1]
                        break

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {"raw_response": text}
