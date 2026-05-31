"""Unit tests for tripwire crossing logic (pure; no DB)."""
from __future__ import annotations

from backend.services.line_crossing import LEFT_TO_RIGHT, RIGHT_TO_LEFT
from backend.services.tripwire_service import TripwireService


def _wire(direction="both", classes=None, wid="w1"):
    return {
        "id": wid,
        "name": "T",
        "a": (5, 0),
        "b": (5, 10),
        "direction": direction,
        "classes": classes if classes is not None else {"person"},
        "severity": "medium",
    }


_CROSS = [(0, 5), (10, 5)]  # crosses the x=5 line going +x


def test_class_filter_blocks_non_watched():
    svc = TripwireService()
    assert svc.check_object(_wire(classes={"car"}), 1, "person", _CROSS, now_monotonic=100.0) is None


def test_crossing_fires_event():
    svc = TripwireService()
    evt = svc.check_object(_wire(), 1, "person", _CROSS, now_monotonic=100.0)
    assert evt is not None
    assert evt["signature"] == "tripwire_crossing"
    assert evt["direction"] in (LEFT_TO_RIGHT, RIGHT_TO_LEFT)
    assert evt["severity"] == "medium"


def test_direction_filter_blocks_wrong_way():
    svc = TripwireService()
    fired = svc.check_object(_wire(), 1, "person", _CROSS, now_monotonic=100.0)
    opposite = RIGHT_TO_LEFT if fired["direction"] == LEFT_TO_RIGHT else LEFT_TO_RIGHT
    svc2 = TripwireService()
    assert svc2.check_object(_wire(direction=opposite), 1, "person", _CROSS, now_monotonic=100.0) is None


def test_no_event_without_crossing():
    svc = TripwireService()
    assert svc.check_object(_wire(), 1, "person", [(0, 5), (4, 5)], now_monotonic=100.0) is None


def test_dedup_within_window_then_refires():
    svc = TripwireService()
    assert svc.check_object(_wire(), 1, "person", _CROSS, now_monotonic=100.0) is not None
    assert svc.check_object(_wire(), 1, "person", _CROSS, now_monotonic=101.0) is None  # within 5s
    assert svc.check_object(_wire(), 1, "person", _CROSS, now_monotonic=110.0) is not None  # after window


def test_dedup_is_per_track():
    svc = TripwireService()
    assert svc.check_object(_wire(), 1, "person", _CROSS, now_monotonic=100.0) is not None
    # Different track at the same instant should still fire.
    assert svc.check_object(_wire(), 2, "person", _CROSS, now_monotonic=100.0) is not None
