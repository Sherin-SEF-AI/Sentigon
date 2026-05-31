"""Line-crossing / tripwire geometry for trajectory analysis.

Pure functions (no third-party deps) so they are fast and fully unit-tested.
Given an object's trajectory (ordered pixel points) and a tripwire line segment,
detect crossings and the direction of crossing relative to the directed line A→B
(left vs. right, by the sign of the 2D cross product).
"""
from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

Point = Tuple[float, float]

LEFT_TO_RIGHT = "left_to_right"
RIGHT_TO_LEFT = "right_to_left"


def _orientation(a: Point, b: Point, c: Point) -> float:
    """2D cross product (b-a) x (c-a). >0 = c left of a→b, <0 = right, 0 = collinear."""
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a: Point, b: Point, c: Point) -> bool:
    """Whether collinear point c lies within the bounding box of segment a-b."""
    return (
        min(a[0], b[0]) <= c[0] <= max(a[0], b[0])
        and min(a[1], b[1]) <= c[1] <= max(a[1], b[1])
    )


def segments_intersect(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    """Whether segment p1-p2 intersects segment p3-p4 (incl. collinear overlap)."""
    d1 = _orientation(p3, p4, p1)
    d2 = _orientation(p3, p4, p2)
    d3 = _orientation(p1, p2, p3)
    d4 = _orientation(p1, p2, p4)

    if ((d1 > 0) != (d2 > 0)) and (d1 != 0 and d2 != 0) and \
       ((d3 > 0) != (d4 > 0)) and (d3 != 0 and d4 != 0):
        return True

    # Collinear / touching edge cases.
    if d1 == 0 and _on_segment(p3, p4, p1):
        return True
    if d2 == 0 and _on_segment(p3, p4, p2):
        return True
    if d3 == 0 and _on_segment(p1, p2, p3):
        return True
    if d4 == 0 and _on_segment(p1, p2, p4):
        return True
    return False


def segment_crossing(
    move_from: Point, move_to: Point, line_a: Point, line_b: Point
) -> Optional[str]:
    """If movement ``move_from``→``move_to`` crosses tripwire ``line_a``→``line_b``,
    return the direction (LEFT_TO_RIGHT / RIGHT_TO_LEFT relative to A→B); else None.
    """
    if not segments_intersect(move_from, move_to, line_a, line_b):
        return None
    s_from = _orientation(line_a, line_b, move_from)
    s_to = _orientation(line_a, line_b, move_to)
    if s_from > 0 >= s_to:
        return LEFT_TO_RIGHT
    if s_from < 0 <= s_to:
        return RIGHT_TO_LEFT
    # Started on the line: classify by where it ended.
    if s_to < 0:
        return LEFT_TO_RIGHT
    if s_to > 0:
        return RIGHT_TO_LEFT
    return None


def track_crossings(
    trajectory: Sequence[Point], line_a: Point, line_b: Point
) -> List[dict]:
    """Find all crossings of a tripwire by an ordered trajectory.

    Returns a list of {"index": i, "direction": str} where segment
    trajectory[i]→trajectory[i+1] crossed the line.
    """
    crossings: List[dict] = []
    if not trajectory or len(trajectory) < 2:
        return crossings
    for i in range(len(trajectory) - 1):
        direction = segment_crossing(
            tuple(trajectory[i]), tuple(trajectory[i + 1]), line_a, line_b
        )
        if direction is not None:
            crossings.append({"index": i, "direction": direction})
    return crossings


def latest_crossing(
    trajectory: Sequence[Point], line_a: Point, line_b: Point
) -> Optional[str]:
    """Direction of the most recent crossing in the trajectory, or None.

    Useful for per-frame checks where only the newest segment matters.
    """
    if not trajectory or len(trajectory) < 2:
        return None
    return segment_crossing(
        tuple(trajectory[-2]), tuple(trajectory[-1]), line_a, line_b
    )
