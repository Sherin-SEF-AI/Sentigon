"""Per-entity threat-escalation chains.

Individual behaviours (loitering, running, a fall, a BOLO hit) are scored in
isolation by the detection layer. But a *sequence* on the same entity —
loiter → test-a-door → approach — is far more telling than any single step.
This tracker ingests the track-bearing threats already produced each frame,
maintains a short per-(camera, track) history, and emits a CRITICAL
``escalation_chain`` threat when an entity shows several DISTINCT, escalating
behaviours inside a time window — turning a string of low/medium signals into one
high-confidence proactive warning.
"""
from __future__ import annotations

import logging
from collections import deque
from typing import Any, Deque, Dict, List, Tuple

logger = logging.getLogger(__name__)

# Behaviour → escalation rank (higher = closer to a hostile act).
_RANK: Dict[str, int] = {
    "loitering": 1, "tailgating": 2, "running": 2, "abandoned_object": 2,
    "tamper": 2, "evasive": 2, "intrusion": 3, "fall": 3, "bolo_person_match": 3,
    "concealed_carry": 4, "pre_assault": 4, "weapon": 4, "aggression": 4,
}

_WINDOW_S = 300.0     # escalation steps must fall within this window
_MIN_STEPS = 3        # distinct behaviours to count as a chain
_COOLDOWN_S = 120.0   # don't re-fire a chain for the same track this often


class EscalationTracker:
    def __init__(self) -> None:
        self._tracks: Dict[Tuple[str, Any], Deque[Tuple[float, str, int]]] = {}
        self._cooldowns: Dict[Tuple[str, Any], float] = {}

    def observe(self, camera_id: str, threats: List[Dict[str, Any]], t: float) -> List[Dict[str, Any]]:
        """Record this frame's threats and return any escalation_chain threats."""
        out: List[Dict[str, Any]] = []
        for thr in threats or []:
            tid = thr.get("track_id")
            sig = thr.get("signature")
            if tid is None or not sig or sig == "escalation_chain":
                continue
            rank = _RANK.get(sig)
            if rank is None:
                continue
            key = (str(camera_id), tid)
            dq = self._tracks.setdefault(key, deque())
            dq.append((t, sig, rank))
            while dq and t - dq[0][0] > _WINDOW_S:
                dq.popleft()

            # distinct behaviours seen in the window (keep highest rank per sig)
            distinct: Dict[str, int] = {}
            for (_tt, s, r) in dq:
                distinct[s] = max(distinct.get(s, 0), r)
            if len(distinct) < _MIN_STEPS:
                continue
            ranks = sorted(distinct.values())
            if max(ranks) <= min(ranks):
                continue  # no actual escalation, just repetition
            if t - self._cooldowns.get(key, -1e9) < _COOLDOWN_S:
                continue
            self._cooldowns[key] = t
            chain = " → ".join(s for s, _ in sorted(distinct.items(), key=lambda kv: kv[1]))
            out.append({
                "signature": "escalation_chain",
                "description": f"behavioural escalation on track {tid}: {chain}",
                "severity": "critical",
                "confidence": round(min(0.95, 0.7 + 0.05 * len(distinct)), 2),
                "detection_method": "escalation",
                "track_id": tid,
            })
            logger.info("escalation_chain on camera %s track %s: %s", camera_id, tid, chain)
        return out

    def prune(self, camera_id: str, active_track_ids: set) -> None:
        """Drop history for tracks no longer present (called opportunistically)."""
        for key in [k for k in self._tracks if k[0] == str(camera_id) and k[1] not in active_track_ids]:
            self._tracks.pop(key, None)
            self._cooldowns.pop(key, None)


escalation_tracker = EscalationTracker()
