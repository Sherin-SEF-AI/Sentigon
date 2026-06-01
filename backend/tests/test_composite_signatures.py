"""Unit tests for the composite temporal signature matcher (pure, always run)."""
from __future__ import annotations

from backend.services.composite_signatures import (
    SIGNATURE_LIBRARY,
    BehaviorEvent,
    CompositeSignature,
    Stage,
    evaluate,
)


def _ev(ts, behavior=None, zone_type=None):
    return BehaviorEvent(timestamp=float(ts), behavior=behavior, zone_type=zone_type)


# ── Stage predicate ───────────────────────────────────────────────────────────

def test_empty_stage_matches_nothing():
    assert Stage().matches(_ev(0, behavior="loitering")) is False


def test_stage_requires_all_constraints():
    s = Stage(behaviors=frozenset({"loitering"}), zone_types=frozenset({"perimeter"}))
    assert s.matches(_ev(0, behavior="loitering", zone_type="perimeter")) is True
    assert s.matches(_ev(0, behavior="loitering", zone_type="restricted")) is False
    assert s.matches(_ev(0, behavior="walking_past", zone_type="perimeter")) is False


# ── Sequence matching ─────────────────────────────────────────────────────────

def test_loiter_then_intrusion_fires_in_order_and_window():
    events = [_ev(0, behavior="loitering"), _ev(120, zone_type="restricted")]
    names = [m["signature"] for m in evaluate(events)]
    assert "loiter_then_intrusion" in names


def test_sequence_requires_correct_order():
    # restricted BEFORE loitering — must NOT fire loiter_then_intrusion.
    events = [_ev(0, zone_type="restricted"), _ev(120, behavior="loitering")]
    names = [m["signature"] for m in evaluate(events)]
    assert "loiter_then_intrusion" not in names


def test_sequence_respects_window():
    # loiter then restricted but 10 min apart (> 300s window) — no match.
    events = [_ev(0, behavior="loitering"), _ev(600, zone_type="restricted")]
    names = [m["signature"] for m in evaluate(events)]
    assert "loiter_then_intrusion" not in names


def test_sequence_finds_later_valid_start():
    # first loiter has no following restricted in window; a later pair does.
    events = [
        _ev(0, behavior="loitering"),
        _ev(1000, behavior="stopping"),
        _ev(1100, zone_type="restricted"),
    ]
    names = [m["signature"] for m in evaluate(events)]
    assert "loiter_then_intrusion" in names


# ── Count matching ────────────────────────────────────────────────────────────

def test_repeated_restricted_probing_count():
    events = [_ev(0, zone_type="restricted"), _ev(100, zone_type="restricted"), _ev(200, zone_type="restricted")]
    m = next(x for x in evaluate(events) if x["signature"] == "repeated_restricted_probing")
    assert m["evidence_count"] >= 3


def test_count_below_threshold_does_not_fire():
    events = [_ev(0, zone_type="restricted"), _ev(100, zone_type="restricted")]  # only 2
    names = [m["signature"] for m in evaluate(events)]
    assert "repeated_restricted_probing" not in names


def test_count_respects_window():
    # 3 restricted entries but spread over 30 min (> 900s window) — no match.
    events = [_ev(0, zone_type="restricted"), _ev(1000, zone_type="restricted"), _ev(2000, zone_type="restricted")]
    names = [m["signature"] for m in evaluate(events)]
    assert "repeated_restricted_probing" not in names


def test_perimeter_casing_needs_behavior_and_zone():
    events = [
        _ev(0, behavior="looking", zone_type="entry"),
        _ev(60, behavior="staking", zone_type="perimeter"),
        _ev(120, behavior="loitering", zone_type="gate"),
    ]
    names = [m["signature"] for m in evaluate(events)]
    assert "perimeter_casing" in names


# ── No false positives on benign history ──────────────────────────────────────

def test_benign_walkthrough_fires_nothing():
    events = [
        _ev(0, behavior="walking_past", zone_type="lobby"),
        _ev(60, behavior="walking_past", zone_type="general"),
    ]
    assert evaluate(events) == []


def test_library_is_nonempty_and_well_formed():
    assert len(SIGNATURE_LIBRARY) >= 3
    for sig in SIGNATURE_LIBRARY:
        assert sig.kind in ("sequence", "count")
        if sig.kind == "sequence":
            assert sig.stages
        else:
            assert sig.predicate is not None and sig.min_count > 0
