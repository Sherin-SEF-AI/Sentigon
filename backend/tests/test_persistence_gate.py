"""Unit tests for the persistence (corroboration) false-alarm gate."""
from __future__ import annotations

from backend.services.persistence_gate import PersistenceGate


def test_high_severity_bypasses_immediately():
    g = PersistenceGate(min_occurrences=2, window_seconds=10)
    assert g.should_emit("cam1", "weapon_detected", "high", 100.0) is True
    assert g.should_emit("cam1", "anything", "critical", 100.0) is True


def test_single_frame_medium_is_suppressed():
    g = PersistenceGate(min_occurrences=2, window_seconds=10)
    # First (and only) sighting of a medium threat → suppressed (flicker).
    assert g.should_emit("cam1", "loitering", "medium", 100.0) is False


def test_persistent_medium_emits_after_recurrence():
    g = PersistenceGate(min_occurrences=2, window_seconds=10)
    assert g.should_emit("cam1", "loitering", "medium", 100.0) is False
    assert g.should_emit("cam1", "loitering", "medium", 101.0) is True  # 2nd within window


def test_recurrence_outside_window_does_not_count():
    g = PersistenceGate(min_occurrences=2, window_seconds=10)
    assert g.should_emit("cam1", "loitering", "medium", 100.0) is False
    # 20s later — first observation has aged out, so this is again the "first".
    assert g.should_emit("cam1", "loitering", "medium", 120.0) is False


def test_per_camera_signature_isolation():
    g = PersistenceGate(min_occurrences=2, window_seconds=10)
    assert g.should_emit("cam1", "loitering", "medium", 100.0) is False
    # Different camera / different signature each count separately.
    assert g.should_emit("cam2", "loitering", "medium", 100.0) is False
    assert g.should_emit("cam1", "tailgating", "medium", 100.0) is False
    # cam1/loitering recurs → emits; others still at 1.
    assert g.should_emit("cam1", "loitering", "medium", 101.0) is True


def test_min_occurrences_one_emits_immediately():
    g = PersistenceGate(min_occurrences=1, window_seconds=10)
    assert g.should_emit("cam1", "loitering", "medium", 100.0) is True


def test_reset_clears_state():
    g = PersistenceGate(min_occurrences=2, window_seconds=10)
    g.should_emit("cam1", "loitering", "medium", 100.0)
    g.reset()
    # After reset the previous observation is gone → first again.
    assert g.should_emit("cam1", "loitering", "medium", 101.0) is False
