"""Ollama-routed AI text generation service.

Single entry point for text generation — routes through Ollama
with intelligent model tier selection.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


async def ai_generate_text(
    prompt: str,
    system_prompt: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    tier: str = "standard",
) -> str:
    """Generate text using Ollama with the specified model tier.

    Tiers: reasoning, standard, fast
    """
    from backend.services.ollama_provider import ollama_generate_text

    try:
        return await ollama_generate_text(
            prompt,
            system_prompt=system_prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            tier=tier,
        )
    except Exception as e:
        logger.error("AI text generation failed: %s", e)
        return ""
