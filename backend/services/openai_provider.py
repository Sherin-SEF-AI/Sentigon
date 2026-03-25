"""OpenAI AI provider — GPT-4o for deep analysis, GPT-4o-mini for fast operations.

Uses the OpenAI Python SDK with the standard chat completions API.
Supports vision (base64 images), function calling, text generation,
and embeddings.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import threading
from typing import Any, Callable, Dict, List, Optional

from backend.config import settings

logger = logging.getLogger(__name__)

# ── Client management ────────────────────────────────────────

_openai_client: Any = None
_initialized = False
_lock = threading.Lock()


def _init_client():
    """Create the OpenAI client singleton."""
    global _openai_client, _initialized
    if _initialized:
        return

    key = (settings.OPENAI_API_KEY or "").strip()
    if not key:
        logger.warning("OPENAI_API_KEY not set — OpenAI provider unavailable")
        _initialized = True
        return

    from openai import OpenAI

    _openai_client = OpenAI(api_key=key)
    logger.info(
        "OpenAI client initialized: flash=%s, pro=%s",
        settings.OPENAI_FLASH_MODEL,
        settings.OPENAI_PRO_MODEL,
    )
    _initialized = True


def get_openai_client():
    """Get the OpenAI client singleton."""
    if not _initialized:
        with _lock:
            _init_client()
    return _openai_client


def is_available() -> bool:
    """Check if OpenAI provider is configured."""
    if not _initialized:
        with _lock:
            _init_client()
    return _openai_client is not None


# ── Rate limit handling ──────────────────────────────────────

_MAX_RETRIES = 3
_RETRY_DELAY = 1.0  # seconds


async def _call_with_retry(fn, *args, **kwargs):
    """Call an OpenAI API function with retry on rate limit (429)."""
    last_error = None
    for attempt in range(_MAX_RETRIES):
        client = get_openai_client()
        if client is None:
            raise RuntimeError("OpenAI client not available — OPENAI_API_KEY not set")
        try:
            return await asyncio.to_thread(fn, client, *args, **kwargs)
        except Exception as e:
            err_str = str(e)
            if "429" in err_str or "rate_limit" in err_str.lower():
                logger.warning(
                    "OpenAI rate limited (attempt %d/%d)",
                    attempt + 1,
                    _MAX_RETRIES,
                )
                last_error = e
                await asyncio.sleep(_RETRY_DELAY * (attempt + 1))
                continue
            raise
    raise last_error  # type: ignore[misc]


def _chat_create(client, *, model, messages, **kwargs):
    """Wrapper for client.chat.completions.create (used by _call_with_retry)."""
    return client.chat.completions.create(
        model=model,
        messages=messages,
        **kwargs,
    )


# ── Public API ───────────────────────────────────────────────


async def openai_generate_text(
    prompt: str,
    system_prompt: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    model: Optional[str] = None,
) -> str:
    """Text generation via OpenAI. Returns the response text."""
    messages: List[Dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    response = await _call_with_retry(
        _chat_create,
        model=model or settings.OPENAI_FLASH_MODEL,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
    )

    return response.choices[0].message.content or ""


async def openai_analyze_image(
    image_bytes: bytes,
    prompt: str,
    max_tokens: int = 2048,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Vision analysis via OpenAI GPT-4o-mini.

    Sends image as base64 data URL (same format as Groq).
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
        model=model or settings.OPENAI_FLASH_MODEL,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.3,
    )

    text = response.choices[0].message.content or ""
    return _parse_json_response(text)


async def openai_analyze_multiple_images(
    images: List[bytes],
    prompt: str,
    max_tokens: int = 4096,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Vision analysis with multiple images (e.g. cross-camera comparison)."""
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
        model=model or settings.OPENAI_FLASH_MODEL,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.3,
    )

    text = response.choices[0].message.content or ""
    return _parse_json_response(text)


async def openai_generate_with_tools(
    prompt: str,
    tools_schema: List[Dict[str, Any]],
    tool_executor: Callable,
    system_prompt: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    max_iterations: int = 10,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Function-calling loop via OpenAI (native tool calling).

    Identical interface to groq_generate_with_tools.

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
            model=model or settings.OPENAI_FLASH_MODEL,
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


async def openai_generate_embedding(
    text: str,
    dimensions: int = 768,
) -> List[float]:
    """Generate embedding vector using OpenAI text-embedding-3-small.

    Supports dimension control via the dimensions parameter.
    """
    client = get_openai_client()
    if client is None:
        raise RuntimeError("OpenAI client not available — OPENAI_API_KEY not set")

    response = await asyncio.to_thread(
        client.embeddings.create,
        model=settings.OPENAI_EMBEDDING_MODEL,
        input=text,
        dimensions=dimensions,
    )
    return response.data[0].embedding


def _parse_json_response(text: str) -> Dict[str, Any]:
    """Parse JSON from OpenAI response, handling markdown code blocks."""
    cleaned = text.strip()

    # Extract JSON from markdown code blocks
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
                        cleaned = cleaned[start : i + 1]
                        break

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {"raw_response": text}
