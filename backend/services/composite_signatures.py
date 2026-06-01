"""Composite temporal signatures — multi-step behavioral pattern detection.

This is the "signatures" layer: not "a person was seen", but ordered/temporal
patterns across an entity's history, e.g. "loitered, then entered a restricted
zone within 5 minutes" or "entered a restricted zone 3+ times in 15 minutes".

The matcher is pure (no DB / ML) and operates on a time-ordered list of
``BehaviorEvent`` for ONE entity, so it is fully unit-testable with synthetic
sequences. The service layer (entity_tracker_service) builds those events from
persisted EntityAppearance rows (+ zone types) and runs ``evaluate``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Sequence


@dataclass
class BehaviorEvent:
    """One observation of an entity at a point in time."""
    timestamp: float  # epoch seconds (sortable)
    behavior: Optional[str] = None
    zone_type: Optional[str] = None
    zone_id: Optional[str] = None
    camera_id: Optional[str] = None


@dataclass(frozen=True)
class Stage:
    """A predicate over a single event. All provided constraints must hold."""
    behaviors: Optional[frozenset] = None   # event.behavior must be in this set
    zone_types: Optional[frozenset] = None  # event.zone_type must be in this set

    def matches(self, e: BehaviorEvent) -> bool:
        if self.behaviors is not None and e.behavior not in self.behaviors:
            return False
        if self.zone_types is not None and e.zone_type not in self.zone_types:
            return False
        # An empty Stage (no constraints) matches nothing — avoids accidental
        # all-match signatures.
        if self.behaviors is None and self.zone_types is None:
            return False
        return True


@dataclass(frozen=True)
class CompositeSignature:
    name: str
    severity: str
    window_seconds: float
    description: str = ""
    kind: str = "sequence"              # "sequence" | "count"
    stages: tuple = ()                  # ordered stages (sequence kind)
    predicate: Optional[Stage] = None   # event predicate (count kind)
    min_count: int = 0                  # threshold (count kind)


def _match_sequence(events: Sequence[BehaviorEvent], sig: CompositeSignature) -> Optional[dict]:
    """All stages must occur IN ORDER within window_seconds of the first stage."""
    stages = sig.stages
    if not stages:
        return None
    n = len(events)
    for i in range(n):
        if not stages[0].matches(events[i]):
            continue
        start_t = events[i].timestamp
        stage_idx = 1
        evidence = [events[i]]
        for j in range(i + 1, n):
            if events[j].timestamp - start_t > sig.window_seconds:
                break
            if stages[stage_idx].matches(events[j]):
                evidence.append(events[j])
                stage_idx += 1
                if stage_idx == len(stages):
                    return {
                        "signature": sig.name,
                        "severity": sig.severity,
                        "description": sig.description,
                        "kind": "sequence",
                        "evidence_count": len(evidence),
                        "first_ts": evidence[0].timestamp,
                        "last_ts": evidence[-1].timestamp,
                    }
    return None


def _match_count(events: Sequence[BehaviorEvent], sig: CompositeSignature) -> Optional[dict]:
    """At least min_count matching events fall within a window_seconds span."""
    if sig.predicate is None or sig.min_count <= 0:
        return None
    matching = [e for e in events if sig.predicate.matches(e)]
    for i in range(len(matching)):
        count = 1
        for j in range(i + 1, len(matching)):
            if matching[j].timestamp - matching[i].timestamp <= sig.window_seconds:
                count += 1
            else:
                break
        if count >= sig.min_count:
            return {
                "signature": sig.name,
                "severity": sig.severity,
                "description": sig.description,
                "kind": "count",
                "evidence_count": count,
                "first_ts": matching[i].timestamp,
                "last_ts": matching[i + count - 1].timestamp,
            }
    return None


def evaluate(
    events: Sequence[BehaviorEvent],
    signatures: Optional[Sequence[CompositeSignature]] = None,
) -> List[dict]:
    """Return all composite signatures matched by an entity's event history."""
    sigs = signatures if signatures is not None else SIGNATURE_LIBRARY
    ordered = sorted(events, key=lambda e: e.timestamp)
    matches: List[dict] = []
    for sig in sigs:
        m = _match_sequence(ordered, sig) if sig.kind == "sequence" else _match_count(ordered, sig)
        if m:
            matches.append(m)
    return matches


# ── Built-in signature library ────────────────────────────────────────────────
# Grounded in the behaviors entity tracking actually emits (loitering, stopping,
# looking, staking, evasive, ...) and zone types (restricted, entry, perimeter…).

_RESTRICTED = frozenset({"restricted"})
_PERIMETER = frozenset({"perimeter", "entry", "exit", "gate", "lobby"})
_DWELL_BEHAVIORS = frozenset({"loitering", "stopping", "staking", "looking"})
_SUSPICIOUS = frozenset({"loitering", "staking", "looking", "evasive", "testing_door"})

SIGNATURE_LIBRARY: List[CompositeSignature] = [
    CompositeSignature(
        name="loiter_then_intrusion",
        severity="high",
        window_seconds=300,
        description="Loitered, then entered a restricted zone within 5 minutes",
        kind="sequence",
        stages=(Stage(behaviors=_DWELL_BEHAVIORS), Stage(zone_types=_RESTRICTED)),
    ),
    CompositeSignature(
        name="repeated_restricted_probing",
        severity="high",
        window_seconds=900,
        description="Entered a restricted zone 3+ times in 15 minutes",
        kind="count",
        predicate=Stage(zone_types=_RESTRICTED),
        min_count=3,
    ),
    CompositeSignature(
        name="perimeter_casing",
        severity="medium",
        window_seconds=600,
        description="Repeated suspicious dwelling at perimeter/entry points",
        kind="count",
        predicate=Stage(behaviors=_SUSPICIOUS, zone_types=_PERIMETER),
        min_count=3,
    ),
    CompositeSignature(
        name="surveil_then_approach_restricted",
        severity="high",
        window_seconds=600,
        description="Looked around at the perimeter, then moved to a restricted zone",
        kind="sequence",
        stages=(
            Stage(behaviors=frozenset({"looking", "staking"}), zone_types=_PERIMETER),
            Stage(zone_types=_RESTRICTED),
        ),
    ),
]
