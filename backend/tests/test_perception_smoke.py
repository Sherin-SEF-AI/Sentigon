"""Perception pipeline regression guards.

Background: the YOLO detector returns its object list under the key
"detections", but the monitoring loop (and several Phase 3 services) read
"objects" — a silent mismatch that disabled entity tracking / cross-camera
re-ID and per-object weapon analysis entirely. These tests lock the contract.
"""
from __future__ import annotations

from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parent.parent


def test_monitoring_loop_does_not_read_wrong_detection_key():
    """Fast, deterministic guard: the monitoring loop must not read the
    detector output under the legacy "objects" key (which is always empty)."""
    src = (_BACKEND / "agents" / "monitoring_agent.py").read_text()
    assert 'get("objects"' not in src, (
        "monitoring_agent reads detections.get('objects', ...) — the detector "
        "returns its list under 'detections'. This silently disables entity "
        "tracking and per-object analysis."
    )


def test_detector_output_contract_and_no_false_positives_on_black_frame():
    """The real detector must return its objects under the 'detections' key and
    report no people on an empty (black) frame (false-positive baseline).

    Skips gracefully if torch/ultralytics or the model weights are unavailable
    so the suite stays runnable in minimal environments.
    """
    np = pytest.importorskip("numpy")
    try:
        from backend.services.yolo_detector import yolo_detector
    except Exception as e:  # pragma: no cover - env-dependent
        pytest.skip(f"yolo detector import unavailable: {e}")

    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    try:
        result = yolo_detector.detect(frame, camera_id="test-smoke")
    except Exception as e:  # pragma: no cover - model download/load env-dependent
        pytest.skip(f"detector could not run (model load/download): {e}")

    assert isinstance(result, dict)
    assert "detections" in result, f"detector output keys: {sorted(result)}"
    assert isinstance(result["detections"], list)
    assert result.get("person_count", 0) == 0
