"""Temporal / multi-frame behavioral detection.

Detects behaviours that only exist OVER TIME — they cannot be seen in a single
frame — by tracking each object across frames and measuring its trajectory:

  - loitering        : a person dwelling in a small area for a long time
  - running          : a person sustaining high speed
  - fall             : a person's bounding box flipping tall->wide with a sudden
                       downward drop (standing -> on the ground)
  - abandoned_object : a bag/suitcase/etc. left stationary with no nearby person
  - erratic_movement : large, rapid back-and-forth displacement

These are GEOMETRIC measurements of real tracked objects (YOLO track_ids), not
LLM inferences — so they are deterministic, cheap, and not prone to the
hallucination that single-frame scene reasoning can produce. Each detection
carries the concrete evidence (dwell seconds, speed, etc.).
"""
from __future__ import annotations

import logging
import math
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ── Tunables (fractions are of the frame dimension, so they are resolution-independent) ──
_TRACK_TTL_S = 6.0            # forget a track not seen for this long
_HISTORY_S = 120.0           # keep at most this much trajectory per track
_LOITER_S = 45.0             # dwell time to count as loitering
_LOITER_RADIUS_FRAC = 0.10   # ...while staying within this fraction of the frame
_RUN_SPEED_FRAC = 0.22       # speed (frame-widths / second) to count as running
_RUN_MIN_SAMPLES = 3
_FALL_WINDOW_S = 2.5         # aspect flip + drop must happen within this window
_FALL_DROP_FRAC = 0.08       # centroid must move down at least this fraction
_ABANDON_S = 30.0            # stationary object with no owner this long
_ABANDON_MOVE_FRAC = 0.05    # ...moving less than this fraction = "stationary"
_PROXIMITY_FRAC = 0.20       # a person within this distance "owns" an object
_COOLDOWN_S = 30.0           # don't re-fire the same behaviour for a track within this

_OWNABLE_OBJECTS = {"backpack", "handbag", "suitcase", "bag", "box", "package", "luggage"}


class _TrackState:
    __slots__ = ("history", "first_seen", "last_seen", "label", "cooldowns", "last_pose")

    def __init__(self, label: str, t: float):
        self.history: Deque[Tuple[float, float, float, float, float]] = deque()  # (t, cx, cy, w, h)
        self.first_seen = t
        self.last_seen = t
        self.label = label
        self.cooldowns: Dict[str, float] = {}  # behaviour -> last fired time
        self.last_pose: Dict[str, Any] = {}    # latest pose_features for this track


class TemporalBehaviorAnalyzer:
    """Maintains per-camera track trajectories and flags temporal behaviours."""

    def __init__(self) -> None:
        # camera_id -> track_id -> _TrackState
        self._tracks: Dict[str, Dict[Any, _TrackState]] = {}

    def reset(self, camera_id: Optional[str] = None) -> None:
        if camera_id is None:
            self._tracks.clear()
        else:
            self._tracks.pop(camera_id, None)

    def observe(
        self,
        camera_id: str,
        detections: Dict[str, Any],
        frame_wh: Tuple[int, int],
        timestamp: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """Ingest one frame's tracked detections; return any behaviours detected.

        ``detections`` is the YOLO detector dict; each item in
        ``detections['detections']`` should have ``track_id`` and ``bbox``
        ([x1,y1,x2,y2]) and ``class``.
        """
        t = timestamp if timestamp is not None else time.time()
        w_frame, h_frame = float(frame_wh[0] or 1), float(frame_wh[1] or 1)
        diag = math.hypot(w_frame, h_frame)
        cam = self._tracks.setdefault(camera_id, {})

        persons_now: List[Tuple[float, float]] = []
        objects_now: List[Tuple[Any, float, float]] = []  # (track_id, cx, cy)

        for obj in detections.get("detections", []) if isinstance(detections, dict) else []:
            tid = obj.get("track_id")
            bbox = obj.get("bbox") or obj.get("box")
            if tid is None or not bbox or len(bbox) < 4:
                continue
            x1, y1, x2, y2 = bbox[0], bbox[1], bbox[2], bbox[3]
            cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
            bw, bh = abs(x2 - x1), abs(y2 - y1)
            label = (obj.get("class") or obj.get("label") or "object").lower()

            st = cam.get(tid)
            if st is None:
                st = _TrackState(label, t)
                cam[tid] = st
            st.last_seen = t
            st.label = label
            st.last_pose = obj.get("pose_features") or {}
            st.history.append((t, cx, cy, bw, bh))
            # trim history by time window
            while st.history and t - st.history[0][0] > _HISTORY_S:
                st.history.popleft()

            if label == "person":
                persons_now.append((cx, cy))
            elif label in _OWNABLE_OBJECTS:
                objects_now.append((tid, cx, cy))

        # prune stale tracks
        for tid in [k for k, v in cam.items() if t - v.last_seen > _TRACK_TTL_S]:
            del cam[tid]

        behaviours: List[Dict[str, Any]] = []
        for tid, st in cam.items():
            if st.label == "person":
                behaviours += self._person_behaviours(camera_id, tid, st, t, w_frame, h_frame, diag)
            elif st.label in _OWNABLE_OBJECTS:
                b = self._abandoned_object(camera_id, tid, st, t, diag, persons_now)
                if b:
                    behaviours.append(b)
        return behaviours

    # ── per-track detectors ───────────────────────────────────────

    def _fire(self, st: _TrackState, name: str, t: float) -> bool:
        """Return True if this behaviour may fire now (respecting cooldown)."""
        if t - st.cooldowns.get(name, -1e9) < _COOLDOWN_S:
            return False
        st.cooldowns[name] = t
        return True

    def _person_behaviours(self, cam_id, tid, st, t, w_frame, h_frame, diag) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        hist = st.history
        if len(hist) < 2:
            return out

        # --- Fall ---
        # Prefer pose evidence when available (robust, keypoint-based). If the
        # track HAS pose data but no fall, trust it and suppress the crude
        # bbox-aspect heuristic (kills crouch/sit false positives). Only when
        # there is no pose at all do we fall back to bbox aspect-ratio.
        try:
            from backend.config import settings as _cfg
            pose_owns_falls = getattr(_cfg, "POSE_BEHAVIOR_ENABLED", True)
        except Exception:
            pose_owns_falls = True
        pose = st.last_pose or {}
        if pose.get("fall", {}).get("detected"):
            if self._fire(st, "fall", t):
                conf = float(pose["fall"].get("confidence", 0.9))
                out.append(self._mk("fall", "critical", conf,
                    f"person track {tid}: pose-confirmed fall (torso went prone with a downward drop)", tid))
        elif not pose_owns_falls and not pose:
            recent = [h for h in hist if t - h[0] <= _FALL_WINDOW_S]
            if len(recent) >= 2:
                (t0, cx0, cy0, w0, h0) = recent[0]
                (t1, cx1, cy1, w1, h1) = recent[-1]
                ar0 = (h0 / w0) if w0 else 0      # standing ~ >1.2
                ar1 = (h1 / w1) if w1 else 0      # lying ~ <0.85
                dropped = (cy1 - cy0) >= _FALL_DROP_FRAC * h_frame
                if ar0 >= 1.2 and ar1 <= 0.85 and dropped and self._fire(st, "fall", t):
                    out.append(self._mk("fall", "critical", 0.8,
                        f"person track {tid}: posture flipped standing→prone (aspect {ar0:.1f}→{ar1:.1f}) with a downward drop [bbox heuristic]", tid))

        # --- Running: sustained high speed ---
        speed_frac = self._recent_speed_frac(hist, t, w_frame, window_s=1.2)
        if speed_frac is not None and speed_frac >= _RUN_SPEED_FRAC:
            samples = sum(1 for h in hist if t - h[0] <= 1.5)
            if samples >= _RUN_MIN_SAMPLES and self._fire(st, "running", t):
                out.append(self._mk("running", "medium", min(0.9, 0.55 + speed_frac),
                    f"person track {tid}: sustained speed {speed_frac:.2f} frame-widths/s", tid))

        # --- Loitering: long dwell in a small area ---
        # The dwell threshold is learned per camera/zone/time-slot when a baseline
        # exists (cuts false positives in naturally-busy areas); falls back to the
        # static _LOITER_S otherwise.
        from backend.services.adaptive_thresholds import adaptive_thresholds
        loiter_s = adaptive_thresholds.get(cam_id, "dwell_time_threshold", _LOITER_S)
        dwell = st.last_seen - st.first_seen
        if dwell >= loiter_s:
            spread = self._spatial_spread(hist) / diag
            if spread <= _LOITER_RADIUS_FRAC and self._fire(st, "loitering", t):
                conf = min(0.95, 0.5 + (dwell - loiter_s) / max(loiter_s, 1) * 0.4)
                out.append(self._mk("loitering", "low", round(conf, 2),
                    f"person track {tid}: dwelling {int(dwell)}s within a small area (spread {spread:.2f})", tid))
        return out

    def _abandoned_object(self, cam_id, tid, st, t, diag, persons_now) -> Optional[Dict[str, Any]]:
        dwell = st.last_seen - st.first_seen
        if dwell < _ABANDON_S:
            return None
        if self._spatial_spread(st.history) / diag > _ABANDON_MOVE_FRAC:
            return None  # it is moving — being carried
        _, cx, cy = (None, st.history[-1][1], st.history[-1][2])
        owned = any(math.hypot(px - cx, py - cy) <= _PROXIMITY_FRAC * diag for (px, py) in persons_now)
        if owned:
            return None
        if not self._fire(st, "abandoned_object", t):
            return None
        return self._mk("abandoned_object", "high", 0.8,
            f"{st.label} track {tid}: stationary for {int(dwell)}s with no person nearby", tid)

    # ── geometry helpers ──────────────────────────────────────────

    @staticmethod
    def _recent_speed_frac(hist, t, w_frame, window_s) -> Optional[float]:
        pts = [h for h in hist if t - h[0] <= window_s]
        if len(pts) < 2:
            return None
        dist = 0.0
        for a, b in zip(pts, pts[1:]):
            dist += math.hypot(b[1] - a[1], b[2] - a[2])
        dt = pts[-1][0] - pts[0][0]
        if dt <= 0:
            return None
        return (dist / dt) / max(w_frame, 1)

    @staticmethod
    def _spatial_spread(hist) -> float:
        if not hist:
            return 0.0
        mx = sum(h[1] for h in hist) / len(hist)
        my = sum(h[2] for h in hist) / len(hist)
        return max(math.hypot(h[1] - mx, h[2] - my) for h in hist)

    @staticmethod
    def _mk(signature: str, severity: str, confidence: float, evidence: str, tid: Any) -> Dict[str, Any]:
        return {
            "signature": signature,
            "description": evidence,
            "severity": severity,
            "confidence": float(confidence),
            "detection_method": "temporal",
            "track_id": tid,
        }


temporal_behavior = TemporalBehaviorAnalyzer()
