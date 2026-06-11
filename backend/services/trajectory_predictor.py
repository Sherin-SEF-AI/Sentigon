"""Trajectory prediction — turn past motion into a near-future forecast.

The tracker records where entities have BEEN; this predicts where they are
GOING. A constant-velocity estimate (least-squares over recent positions, robust
to per-frame jitter) yields the predicted position at a horizon, current speed
and heading, and the ETA at which the path passes closest to a point of interest
(e.g. a secure door) — enabling proactive alerts ("if this person continues they
reach the server-room door in ~8s") instead of purely reactive ones.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple


def _velocity(points: Sequence[Tuple[float, float, float]]) -> Tuple[float, float, float, float]:
    """Least-squares constant velocity over (t, x, y). Returns (x0,y0,vx,vy) at the latest t."""
    n = len(points)
    t0 = points[-1][0]
    ts = [p[0] - t0 for p in points]  # center on latest sample
    mean_t = sum(ts) / n
    denom = sum((t - mean_t) ** 2 for t in ts) or 1e-6

    def slope_intercept(vals):
        mean_v = sum(vals) / n
        slope = sum((ts[i] - mean_t) * (vals[i] - mean_v) for i in range(n)) / denom
        intercept = mean_v - slope * mean_t  # value at t==0 (i.e. latest time)
        return slope, intercept

    vx, x0 = slope_intercept([p[1] for p in points])
    vy, y0 = slope_intercept([p[2] for p in points])
    return x0, y0, vx, vy


def predict(history: Sequence[Tuple[float, float, float]], horizon_s: float = 5.0) -> Optional[Dict[str, Any]]:
    """Predict motion from (t, x, y) history.

    Returns {position:[x,y], velocity:[vx,vy], speed, heading_deg} for `horizon_s`
    into the future, or None if there isn't enough history.
    """
    pts = [(float(t), float(x), float(y)) for (t, x, y) in history if t is not None]
    if len(pts) < 3:
        return None
    pts = pts[-12:]  # recent window only
    x0, y0, vx, vy = _velocity(pts)
    px, py = x0 + vx * horizon_s, y0 + vy * horizon_s
    speed = math.hypot(vx, vy)
    heading = (math.degrees(math.atan2(vy, vx)) + 360.0) % 360.0
    return {
        "position": [round(px, 1), round(py, 1)],
        "velocity": [round(vx, 3), round(vy, 3)],
        "speed": round(speed, 3),
        "heading_deg": round(heading, 1),
        "current": [round(x0, 1), round(y0, 1)],
    }


def eta_to_point(history: Sequence[Tuple[float, float, float]], target: Tuple[float, float],
                 max_horizon_s: float = 30.0, hit_radius: float = 40.0) -> Optional[float]:
    """Seconds until the predicted path comes within `hit_radius` of `target`,
    or None if it never does within `max_horizon_s` (or motion is too slow)."""
    pred = predict(history, horizon_s=0.0)
    if pred is None:
        return None
    x0, y0 = pred["current"]
    vx, vy = pred["velocity"]
    if math.hypot(vx, vy) < 1e-3:
        return None
    # sample the predicted ray; cheap and robust
    step = 0.25
    t = 0.0
    while t <= max_horizon_s:
        x, y = x0 + vx * t, y0 + vy * t
        if math.hypot(x - target[0], y - target[1]) <= hit_radius:
            return round(t, 2)
        t += step
    return None
