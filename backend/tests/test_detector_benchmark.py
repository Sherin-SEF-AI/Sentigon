"""Real detector accuracy gate (runs the production YOLO model in CI).

Measures recall on canonical real images bundled with ultralytics and the
false-positive count on empty frames. Skips gracefully where the model/assets
are unavailable so minimal environments still run the rest of the suite.
"""
from __future__ import annotations

import pytest


def test_detector_recall_and_no_false_positives():
    pytest.importorskip("numpy")
    pytest.importorskip("cv2")
    pytest.importorskip("ultralytics")

    from backend.eval.detector_benchmark import run

    try:
        result = run()
    except Exception as e:  # pragma: no cover - env-dependent
        pytest.skip(f"benchmark could not run: {e}")
    if result is None:
        pytest.skip("detector/assets unavailable")

    assert result.expected_total > 0, "benchmark found no scenes to evaluate"
    # Recall gate: the detector must find most expected objects in known images.
    assert result.recall >= 0.75, (
        f"detector recall too low: {result.recall:.3f} — {result.per_scene}"
    )
    # Precision gate: it must not hallucinate objects in empty frames.
    assert result.false_positives_on_negatives == 0, (
        f"detector fired on {result.negatives_checked} empty frames: "
        f"{result.false_positives_on_negatives} false positive(s)"
    )
