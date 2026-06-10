"""Adversarial threat verification — the "skeptic" layer.

Before a medium+ threat raised by the vision/detection layer becomes an operator
alert, an INDEPENDENT verifier re-examines the same frame and actively tries to
REFUTE the claim. Only threats it cannot refute (with unambiguous visual
evidence) are confirmed. This is the single biggest lever against false-positive
alerts: a detector that is optimistic is checked by a verifier that is skeptical.

Usage:
    v = await threat_verifier.verify(threat, image_bytes, context)
    if v["verdict"] == "confirmed": ...raise alert...
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


_VERIFY_PROMPT = """You are SENTINEL AI's verification analyst. A detector has flagged a possible threat in this surveillance frame. Your job is to be a SKEPTIC and REFUTE it unless the visual evidence is unambiguous.

CLAIMED THREAT:
- type: {threat_type}
- detector's claimed evidence: {claimed_evidence}
- detector confidence: {detector_confidence}
{context_block}
Re-examine the image yourself. Decide whether the claimed threat is genuinely supported by what is actually visible.

Return ONLY this JSON:
{{
  "verdict": "confirmed|rejected|uncertain",
  "confidence": 0.0-1.0,
  "supporting_evidence": "the specific visual evidence you can SEE that supports the threat, or empty",
  "refuting_evidence": "the specific visual evidence against it, or empty",
  "reasoning": "1-2 sentences"
}}

RULES:
- Default to "rejected". Confirm ONLY if you can point to clear, specific visual evidence of the exact claimed threat.
- A normal/benign/ambiguous scene → "rejected" (or "uncertain" if genuinely unclear).
- Do not be swayed by the detector's confidence — judge the pixels, not the claim.
- Never invent evidence. If you cannot see it, it is not there."""


class ThreatVerifier:
    """Independent skeptic that confirms/refutes a candidate threat."""

    # Threats at/above this level are worth verifying before alerting.
    VERIFY_AT_LEVELS = {"medium", "high", "critical"}

    async def verify(
        self,
        threat: Dict[str, Any],
        image_bytes: bytes,
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Return {verdict, confidence, supporting_evidence, refuting_evidence, reasoning}."""
        from backend.services.ollama_provider import ollama_analyze_image

        ctx_block = ""
        if context:
            recent = context.get("recent_activity")
            baseline = context.get("baseline_note")
            bits = []
            if recent is not None:
                bits.append(f"- recent activity on this camera: {recent}")
            if baseline:
                bits.append(f"- learned-normal baseline: {baseline}")
            if bits:
                ctx_block = "CONTEXT (for judgement, not proof):\n" + "\n".join(bits) + "\n\n"

        prompt = _VERIFY_PROMPT.format(
            threat_type=threat.get("type") or threat.get("threat_type") or "unknown",
            claimed_evidence=threat.get("evidence") or threat.get("description") or "(none given)",
            detector_confidence=threat.get("confidence", "unknown"),
            context_block=ctx_block,
        )

        try:
            result = await ollama_analyze_image(image_bytes, prompt, max_tokens=512)
        except Exception as exc:  # noqa: BLE001
            logger.warning("threat_verifier.verify failed: %s", exc)
            return self._fallback("verifier_unavailable")

        if not isinstance(result, dict) or ("raw_response" in result and len(result) == 1):
            return self._fallback("unparseable")

        verdict = str(result.get("verdict", "rejected")).lower()
        if verdict not in ("confirmed", "rejected", "uncertain"):
            verdict = "rejected"
        try:
            confidence = max(0.0, min(1.0, float(result.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0

        return {
            "verdict": verdict,
            "confidence": confidence,
            "supporting_evidence": result.get("supporting_evidence", ""),
            "refuting_evidence": result.get("refuting_evidence", ""),
            "reasoning": result.get("reasoning", ""),
        }

    @staticmethod
    def _fallback(reason: str) -> Dict[str, Any]:
        # If the verifier can't run, be conservative: don't auto-confirm.
        return {
            "verdict": "uncertain",
            "confidence": 0.0,
            "supporting_evidence": "",
            "refuting_evidence": "",
            "reasoning": f"Verifier could not run ({reason}); not auto-confirmed.",
        }


threat_verifier = ThreatVerifier()
