"""Crowd Protocol Service — dynamic crowd management protocol recommendations."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ── Protocol definitions ─────────────────────────────────────────
# Each protocol has activation thresholds and a set of actions.

_CROWD_PROTOCOLS: List[Dict[str, Any]] = [
    {
        "id": "CP-001",
        "name": "Elevated Tension Monitoring",
        "level": "advisory",
        "description": (
            "Enhanced monitoring posture when crowd sentiment shows early "
            "signs of tension. Increase camera review frequency and pre-stage "
            "response resources."
        ),
        "thresholds": {
            "sentiment_min": "tense",
            "density_min": 0.0,
            "stampede_risk_min": 0.0,
        },
        "actions": [
            "Increase camera monitoring frequency to continuous review",
            "Alert on-site security team to stand by",
            "Open additional exit routes as precaution",
            "Begin recording all camera feeds at highest quality",
            "Monitor social media for event-related chatter",
        ],
    },
    {
        "id": "CP-002",
        "name": "Crowd Density Control",
        "level": "warning",
        "description": (
            "Activated when crowd density exceeds safe thresholds. Focus on "
            "flow management, entry restrictions, and space distribution."
        ),
        "thresholds": {
            "sentiment_min": "calm",
            "density_min": 4.0,
            "stampede_risk_min": 0.0,
        },
        "actions": [
            "Implement one-in-one-out entry policy at capacity zones",
            "Deploy crowd stewards to redirect flow to less dense areas",
            "Open overflow areas and secondary venue spaces",
            "Activate digital signage with crowd distribution guidance",
            "Notify emergency medical team to pre-stage near high-density zones",
            "Begin periodic PA announcements about available space",
        ],
    },
    {
        "id": "CP-003",
        "name": "Agitated Crowd De-escalation",
        "level": "alert",
        "description": (
            "Engaged when crowd sentiment is agitated or hostile. Focus on "
            "de-escalation, area isolation, and response team deployment."
        ),
        "thresholds": {
            "sentiment_min": "agitated",
            "density_min": 0.0,
            "stampede_risk_min": 0.0,
        },
        "actions": [
            "Deploy trained de-escalation officers to affected area",
            "Isolate agitation epicentre with portable barriers",
            "Increase security presence visibly but non-aggressively",
            "Activate negotiation team on standby",
            "Prepare evacuation routes for surrounding areas",
            "Notify law enforcement liaison of developing situation",
            "Begin video evidence preservation for legal review",
        ],
    },
    {
        "id": "CP-004",
        "name": "Stampede Risk Mitigation",
        "level": "critical",
        "description": (
            "Activated when stampede risk exceeds safe threshold. Immediate "
            "crowd flow intervention, barrier management, and emergency "
            "service pre-staging."
        ),
        "thresholds": {
            "sentiment_min": "calm",
            "density_min": 0.0,
            "stampede_risk_min": 0.4,
        },
        "actions": [
            "IMMEDIATE: Open all emergency exits and remove flow obstructions",
            "Deploy crowd-management barriers to create safe flow channels",
            "Activate PA system with calm, directional movement instructions",
            "Pre-stage emergency medical resources at all exits",
            "Halt all incoming pedestrian and vehicle traffic",
            "Deploy floor wardens to guide orderly movement",
            "Activate emergency lighting and directional signage",
            "Notify emergency services of stampede risk condition",
        ],
    },
    {
        "id": "CP-005",
        "name": "Hostile Crowd Emergency",
        "level": "emergency",
        "description": (
            "Maximum response for hostile crowd behaviour with high stampede "
            "risk. Full emergency protocol activation including evacuation "
            "and law enforcement coordination."
        ),
        "thresholds": {
            "sentiment_min": "hostile",
            "density_min": 0.0,
            "stampede_risk_min": 0.3,
        },
        "actions": [
            "EMERGENCY: Initiate controlled evacuation of affected zones",
            "Activate all emergency exits and override locked doors",
            "Request immediate law enforcement response",
            "Deploy all available security personnel to exit points",
            "Activate emergency PA with pre-recorded evacuation instructions",
            "Shut down all non-essential building systems",
            "Activate emergency medical triage stations",
            "Begin real-time video feed to law enforcement command",
            "Secure all sensitive areas (server rooms, executive offices)",
            "Activate mutual aid agreements with neighbouring facilities",
        ],
    },
    {
        "id": "CP-006",
        "name": "Panic Dispersal Protocol",
        "level": "emergency",
        "description": (
            "Activated during active panic with high stampede risk. Focus "
            "on preventing crush injuries through controlled dispersal and "
            "immediate medical response."
        ),
        "thresholds": {
            "sentiment_min": "panic",
            "density_min": 0.0,
            "stampede_risk_min": 0.5,
        },
        "actions": [
            "CRITICAL: All emergency exits to maximum open position",
            "Deploy counter-flow barriers to prevent crowd reversal",
            "PA system: calm, repeated directional instructions",
            "Emergency medical teams to crush-risk zones immediately",
            "Request fire department for extraction support",
            "Activate helicopter / aerial medical standby if available",
            "Begin systematic sweep of area for fallen individuals",
            "Establish casualty collection points at each exit",
            "Coordinate with hospitals for mass casualty intake",
            "Document all actions for post-incident review",
        ],
    },
]

# Sentiment ordering for threshold comparison
_SENTIMENT_LEVELS = {
    "calm": 0,
    "tense": 1,
    "agitated": 2,
    "hostile": 3,
    "panic": 4,
}


class CrowdProtocolService:
    """Provide crowd management protocol recommendations based on real-time analytics.

    Consumes crowd sentiment, density, and stampede risk data (typically
    from ``CrowdFlowAnalyzer``) and returns matching protocol
    recommendations when thresholds are exceeded.
    """

    def __init__(self) -> None:
        self._active_protocols: Dict[str, Dict[str, Any]] = {}

    # ── Recommendations ──────────────────────────────────────────

    def get_protocol_recommendations(
        self,
        sentiment: str,
        density: float,
        stampede_risk: float,
    ) -> Dict[str, Any]:
        """Return all protocol recommendations whose thresholds are met.

        A protocol matches when ALL of the following hold:
        * The current sentiment is >= the protocol's ``sentiment_min``.
        * The current density is >= the protocol's ``density_min``.
        * The current stampede_risk is >= the protocol's ``stampede_risk_min``.

        Matching protocols are also tracked as active protocols internally.

        Args:
            sentiment: Current crowd sentiment (``"calm"`` through ``"panic"``).
            density: Current crowd density (persons per grid cell).
            stampede_risk: Current stampede risk (0.0 to 1.0).

        Returns:
            Dict with ``matching_protocols``, ``highest_level``, and
            ``recommended_actions`` (de-duplicated union of all matching
            protocol actions).
        """
        current_sentiment_level = _SENTIMENT_LEVELS.get(sentiment.lower(), 0)

        matching: List[Dict[str, Any]] = []
        all_actions: List[str] = []

        for proto in _CROWD_PROTOCOLS:
            thresholds = proto["thresholds"]
            required_sentiment = _SENTIMENT_LEVELS.get(
                thresholds.get("sentiment_min", "calm"), 0
            )

            if (
                current_sentiment_level >= required_sentiment
                and density >= thresholds.get("density_min", 0.0)
                and stampede_risk >= thresholds.get("stampede_risk_min", 0.0)
            ):
                matching.append({
                    "id": proto["id"],
                    "name": proto["name"],
                    "level": proto["level"],
                    "description": proto["description"],
                    "actions": proto["actions"],
                })
                all_actions.extend(proto["actions"])

        # De-duplicate actions while preserving order
        seen: set = set()
        unique_actions: List[str] = []
        for action in all_actions:
            if action not in seen:
                seen.add(action)
                unique_actions.append(action)

        # Determine highest level
        level_order = ["advisory", "warning", "alert", "critical", "emergency"]
        highest_level = "none"
        for proto in matching:
            plevel = proto["level"]
            if plevel in level_order:
                if highest_level == "none" or level_order.index(plevel) > level_order.index(highest_level):
                    highest_level = plevel

        # Update active protocols tracking
        now_iso = datetime.now(timezone.utc).isoformat()
        new_active: Dict[str, Dict[str, Any]] = {}
        for proto in matching:
            pid = proto["id"]
            if pid in self._active_protocols:
                # Preserve original activation time
                new_active[pid] = self._active_protocols[pid]
                new_active[pid]["last_evaluated"] = now_iso
            else:
                new_active[pid] = {
                    "id": pid,
                    "name": proto["name"],
                    "level": proto["level"],
                    "activated_at": now_iso,
                    "last_evaluated": now_iso,
                }
        self._active_protocols = new_active

        if matching:
            logger.info(
                "Crowd protocols triggered: %d protocols, highest=%s "
                "(sentiment=%s density=%.2f stampede=%.3f)",
                len(matching), highest_level, sentiment, density, stampede_risk,
            )

        return {
            "sentiment": sentiment,
            "density": round(density, 2),
            "stampede_risk": round(stampede_risk, 3),
            "matching_protocols": matching,
            "highest_level": highest_level,
            "recommended_actions": unique_actions,
            "evaluated_at": now_iso,
        }

    # ── Active protocols ─────────────────────────────────────────

    def get_active_protocols(self) -> List[Dict[str, Any]]:
        """Return all currently active crowd management protocols.

        A protocol remains active until the next evaluation cycle
        determines it no longer meets its thresholds.

        Returns:
            List of active protocol dicts with activation timestamps.
        """
        return list(self._active_protocols.values())

    # ── Reset ────────────────────────────────────────────────────

    def clear_active_protocols(self) -> None:
        """Clear all active protocols (e.g. after an all-clear is issued)."""
        count = len(self._active_protocols)
        self._active_protocols.clear()
        if count:
            logger.info("Cleared %d active crowd protocols", count)


# ── Singleton ────────────────────────────────────────────────────
crowd_protocol_service = CrowdProtocolService()
