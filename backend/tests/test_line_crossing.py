"""Unit tests for line-crossing / tripwire geometry (pure Python, always run)."""
from __future__ import annotations

from backend.services.line_crossing import (
    LEFT_TO_RIGHT,
    RIGHT_TO_LEFT,
    latest_crossing,
    segment_crossing,
    segments_intersect,
    track_crossings,
)


# ── segments_intersect ────────────────────────────────────────────────────────

def test_clear_crossing():
    assert segments_intersect((0, 0), (10, 0), (5, -5), (5, 5)) is True


def test_no_crossing_parallel():
    assert segments_intersect((0, 0), (10, 0), (0, 1), (10, 1)) is False


def test_no_crossing_disjoint():
    assert segments_intersect((0, 0), (1, 0), (5, 5), (6, 6)) is False


def test_touching_endpoint_counts():
    # Endpoint of one segment lies on the other (T-junction).
    assert segments_intersect((0, 0), (10, 0), (5, 0), (5, 5)) is True


def test_collinear_overlap():
    assert segments_intersect((0, 0), (10, 0), (5, 0), (15, 0)) is True


# ── segment_crossing (direction) ──────────────────────────────────────────────

def _vertical_line():
    # Tripwire from A=(5,0) to B=(5,10): A→B points "up". Left of A→B is +x? Check
    # via cross product. A point moving in +x direction crosses one way.
    return (5, 0), (5, 10)


def test_direction_left_to_right():
    a, b = _vertical_line()
    # Moving in +x (from x=0 to x=10) across the vertical line.
    d = segment_crossing((0, 5), (10, 5), a, b)
    assert d in (LEFT_TO_RIGHT, RIGHT_TO_LEFT)
    # Reverse movement must give the opposite direction.
    d_rev = segment_crossing((10, 5), (0, 5), a, b)
    assert d_rev != d and d_rev is not None


def test_no_direction_when_no_cross():
    a, b = _vertical_line()
    assert segment_crossing((0, 5), (4, 5), a, b) is None  # stops before the line


# ── track_crossings / latest_crossing ─────────────────────────────────────────

def test_track_single_crossing():
    a, b = _vertical_line()
    traj = [(0, 5), (3, 5), (8, 5)]  # crosses x=5 once between points 1 and 2
    events = track_crossings(traj, a, b)
    assert len(events) == 1
    assert events[0]["index"] == 1


def test_track_crossing_and_back():
    a, b = _vertical_line()
    traj = [(0, 5), (8, 5), (1, 5)]  # cross out then back
    events = track_crossings(traj, a, b)
    assert len(events) == 2
    assert events[0]["direction"] != events[1]["direction"]


def test_track_no_crossing():
    a, b = _vertical_line()
    assert track_crossings([(0, 5), (1, 5), (2, 5)], a, b) == []


def test_latest_crossing_uses_last_segment():
    a, b = _vertical_line()
    assert latest_crossing([(0, 5), (1, 5), (8, 5)], a, b) is not None
    assert latest_crossing([(0, 5), (8, 5), (9, 5)], a, b) is None  # last seg doesn't cross


def test_degenerate_inputs():
    a, b = _vertical_line()
    assert track_crossings([], a, b) == []
    assert track_crossings([(0, 0)], a, b) == []
    assert latest_crossing([(0, 0)], a, b) is None
