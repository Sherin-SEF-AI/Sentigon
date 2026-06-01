"""Persistence (temporal corroboration) gate for false-alarm reduction.

The single biggest source of false alarms is transient single-frame detections
(flicker from lighting, compression artifacts, a momentary mis-classification).
This gate requires a non-critical threat to RECUR for the same (camera,
signature) within a short window before it is allowed to raise an alert.

- critical / high severities BYPASS the gate (alert immediately).
- medium (and below) must reach ``min_occurrences`` within ``window_seconds``.

Pure of I/O and side-effect-free except its in-memory occurrence buffer, so it
is fully unit-testable with synthetic timestamps. It complements (does not
duplicate) alert_manager's dedup: the gate decides whether the FIRST alert may
fire; dedup suppresses repeats afterwards.
"""
from __future__ import annotations

from collections import defaultdict, deque
from typing import Deque, Dict, Tuple

_BYPASS_SEVERITIES = frozenset({"critical", "high"})


class PersistenceGate:
    def __init__(self, min_occurrences: int = 2, window_seconds: float = 10.0) -> None:
        self.min_occurrences = max(1, int(min_occurrences))
        self.window_seconds = float(window_seconds)
        self._seen: Dict[Tuple[str, str], Deque[float]] = defaultdict(deque)

    def should_emit(self, camera_id: str, signature: str, severity: str, now_epoch: float) -> bool:
        """Whether a threat may raise an alert now.

        Severe threats bypass; others must have been observed at least
        ``min_occurrences`` times within the trailing window.
        """
        if severity in _BYPASS_SEVERITIES:
            return True
        if self.min_occurrences <= 1:
            return True

        key = (str(camera_id), str(signature))
        buf = self._seen[key]
        buf.append(now_epoch)
        # Drop observations older than the window.
        cutoff = now_epoch - self.window_seconds
        while buf and buf[0] < cutoff:
            buf.popleft()
        return len(buf) >= self.min_occurrences

    def reset(self) -> None:
        self._seen.clear()


# Singleton configured from settings (falls back to safe defaults).
def _build() -> PersistenceGate:
    try:
        from backend.config import settings
        return PersistenceGate(
            min_occurrences=getattr(settings, "PERSISTENCE_MIN_OCCURRENCES", 2),
            window_seconds=getattr(settings, "PERSISTENCE_WINDOW_SECONDS", 10.0),
        )
    except Exception:
        return PersistenceGate()


persistence_gate = _build()
