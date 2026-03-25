"""Sensory Fusion Engine — cross-modal verification of audio + visual events.

Correlates audio events (gunshot, glass breaking, scream, explosion) with
visual detections to produce CONFIRMED, LIKELY, or UNVERIFIED verdicts.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


@dataclass
class SensoryEvent:
    """A single sensory event from either audio or visual modality."""
    event_type: str           # e.g. "gunshot", "weapon_detected", "glass_breaking"
    modality: str             # "audio" or "visual"
    camera_id: str
    confidence: float
    timestamp: float
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class FusedEvent:
    """Result of cross-modal verification."""
    verdict: str              # "confirmed", "likely", "unverified", "contradicted"
    confidence: float
    audio_event: Optional[SensoryEvent]
    visual_events: List[SensoryEvent]
    description: str
    fusion_rule: str          # which rule matched
    timestamp: float = field(default_factory=time.time)


# ── Cross-modal fusion rules ────────────────────────────────────

# Each rule: (audio_type, visual_types, verdict, confidence_boost, description)
_FUSION_RULES: List[Tuple[str, List[str], str, float, str]] = [
    # Gunshot + weapon visible = CONFIRMED active threat
    ("gunshot", ["weapon_detected", "firearm", "active_shooter"], "confirmed", 0.95,
     "Gunshot audio corroborated by weapon detection — active shooter confirmed"),

    # Glass breaking + intrusion = CONFIRMED break-in
    ("glass_breaking", ["window_breach", "forced_entry", "intrusion", "perimeter_breach"], "confirmed", 0.90,
     "Glass breaking audio with visual intrusion — break-in confirmed"),

    # Scream + person down = CONFIRMED distress
    ("scream", ["person_down", "medical_emergency", "physical_altercation", "assault"], "confirmed", 0.85,
     "Scream audio with person in distress — emergency confirmed"),

    # Explosion + fire/smoke = CONFIRMED explosion
    ("explosion", ["fire_smoke", "fire", "smoke", "blast"], "confirmed", 0.95,
     "Explosion audio with visual fire/smoke — explosion confirmed"),

    # Scream + crowd disturbance = LIKELY panic
    ("scream", ["crowd_disturbance", "mass_panic", "stampede", "running"], "likely", 0.75,
     "Scream audio with crowd disturbance — likely panic event"),

    # Vehicle crash + fleeing = LIKELY hit-and-run
    ("vehicle_crash", ["hit_and_run", "vehicle_collision", "fleeing_vehicle", "suspect_vehicle_fleeing"], "likely", 0.80,
     "Vehicle crash audio with fleeing vehicle — likely hit-and-run"),

    # Alarm + intrusion = CONFIRMED
    ("alarm", ["intrusion", "unauthorized_entry", "forced_entry", "perimeter_breach"], "confirmed", 0.85,
     "Alarm audio with visual intrusion — confirmed unauthorized access"),

    # Gunshot alone (no visual) = UNVERIFIED
    ("gunshot", [], "unverified", 0.50,
     "Gunshot audio without visual corroboration — unverified, could be false positive"),

    # Explosion alone = UNVERIFIED but elevated
    ("explosion", [], "unverified", 0.60,
     "Explosion audio without visual corroboration — unverified, investigate immediately"),
]


class SensoryFusionEngine:
    """Cross-modal sensory verification engine.

    Maintains a sliding window of recent events and correlates audio events
    with visual detections occurring within a configurable time window.
    """

    def __init__(self, time_window: float = 10.0, max_events: int = 200):
        self.time_window = time_window  # seconds
        self.max_events = max_events
        self._events: List[SensoryEvent] = []

    def ingest_event(self, event: SensoryEvent) -> None:
        """Add a new sensory event to the buffer."""
        self._events.append(event)
        self._prune_old()

    def ingest_audio(
        self,
        event_type: str,
        camera_id: str,
        confidence: float,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SensoryEvent:
        """Convenience: ingest an audio event and return it."""
        event = SensoryEvent(
            event_type=event_type,
            modality="audio",
            camera_id=camera_id,
            confidence=confidence,
            timestamp=time.time(),
            metadata=metadata or {},
        )
        self.ingest_event(event)
        return event

    def ingest_visual(
        self,
        event_type: str,
        camera_id: str,
        confidence: float,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SensoryEvent:
        """Convenience: ingest a visual detection event and return it."""
        event = SensoryEvent(
            event_type=event_type,
            modality="visual",
            camera_id=camera_id,
            confidence=confidence,
            timestamp=time.time(),
            metadata=metadata or {},
        )
        self.ingest_event(event)
        return event

    def verify_cross_modal(
        self,
        audio_event: SensoryEvent,
        time_window: Optional[float] = None,
    ) -> FusedEvent:
        """Verify an audio event against recent visual events.

        Searches for visual events within the time window on the same or
        nearby cameras, and applies fusion rules to determine verdict.

        Args:
            audio_event: The audio event to verify.
            time_window: Override the default time window (seconds).

        Returns:
            FusedEvent with verdict, confidence, and matched visual events.
        """
        window = time_window or self.time_window
        now = audio_event.timestamp

        # Gather visual events within window
        visual_events = [
            e for e in self._events
            if e.modality == "visual"
            and abs(e.timestamp - now) <= window
            and e is not audio_event
        ]

        # Prefer same-camera matches but include all
        same_camera = [e for e in visual_events if e.camera_id == audio_event.camera_id]
        visual_types = set(
            e.event_type.lower().replace(" ", "_") for e in visual_events
        )
        same_camera_types = set(
            e.event_type.lower().replace(" ", "_") for e in same_camera
        )

        audio_type = audio_event.event_type.lower().replace(" ", "_")

        # Try fusion rules in order (most specific first)
        best_match: Optional[FusedEvent] = None

        for rule_audio, rule_visuals, verdict, conf_boost, desc in _FUSION_RULES:
            if audio_type != rule_audio:
                continue

            if rule_visuals:
                # Check if any required visual type is present
                matched_visuals = []
                for rv in rule_visuals:
                    for ve in visual_events:
                        ve_type = ve.event_type.lower().replace(" ", "_")
                        if rv in ve_type or ve_type in rv:
                            matched_visuals.append(ve)

                if not matched_visuals:
                    continue

                # Compute fused confidence
                max_visual_conf = max(ve.confidence for ve in matched_visuals)
                fused_conf = min(
                    (audio_event.confidence + max_visual_conf) / 2 + conf_boost * 0.3,
                    conf_boost,
                )

                candidate = FusedEvent(
                    verdict=verdict,
                    confidence=round(fused_conf, 3),
                    audio_event=audio_event,
                    visual_events=matched_visuals,
                    description=desc,
                    fusion_rule=f"{rule_audio}+{rule_visuals}",
                )

                if best_match is None or candidate.confidence > best_match.confidence:
                    best_match = candidate
            else:
                # Audio-only rule (no visual match required)
                if not visual_types:  # Only apply if truly no visuals
                    candidate = FusedEvent(
                        verdict=verdict,
                        confidence=round(audio_event.confidence * conf_boost, 3),
                        audio_event=audio_event,
                        visual_events=[],
                        description=desc,
                        fusion_rule=f"{rule_audio}_only",
                    )
                    if best_match is None:
                        best_match = candidate

        if best_match:
            return best_match

        # Default: audio with no matching rule
        return FusedEvent(
            verdict="unverified",
            confidence=round(audio_event.confidence * 0.5, 3),
            audio_event=audio_event,
            visual_events=list(same_camera),
            description=f"Audio event '{audio_event.event_type}' has no matching fusion rule",
            fusion_rule="default",
        )

    def get_recent_events(
        self,
        modality: Optional[str] = None,
        camera_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[SensoryEvent]:
        """Get recent events, optionally filtered."""
        events = self._events
        if modality:
            events = [e for e in events if e.modality == modality]
        if camera_id:
            events = [e for e in events if e.camera_id == camera_id]
        return events[-limit:]

    def _prune_old(self) -> None:
        """Remove events older than 2x the time window or exceeding max."""
        cutoff = time.time() - self.time_window * 2
        self._events = [e for e in self._events if e.timestamp > cutoff]
        if len(self._events) > self.max_events:
            self._events = self._events[-self.max_events:]


# Singleton
sensory_fusion_engine = SensoryFusionEngine()
