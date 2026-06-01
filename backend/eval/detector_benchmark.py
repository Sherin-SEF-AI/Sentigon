"""Real detector benchmark — runs the production YOLO detector on real images
with known contents and measures recall + false-positive rate.

Why this is real (not synthetic): it uses the canonical sample images shipped
with `ultralytics` (bus.jpg, zidane.jpg) whose contents are well known, plus
structured empty frames as negatives. It exercises the SAME yolo_detector.detect
path the live pipeline uses, so a model or pipeline regression shows up as a
recall/FP-rate change.

To benchmark YOUR footage, add entries to SCENES pointing at your images with
expected per-class minimum counts (or wire a COCO-format dataset).

Run: make benchmark   (or: python -m backend.eval.detector_benchmark)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class Scene:
    name: str
    # Minimum number of each class we expect the detector to find.
    expected_min: Dict[str, int]


# Known-content real images bundled with ultralytics. Counts are conservative
# minimums YOLOv8n reliably meets at the detector's 0.35 confidence threshold.
SCENES: List[Scene] = [
    Scene("bus.jpg", {"person": 3, "bus": 1}),
    Scene("zidane.jpg", {"person": 2}),
]

# Object classes that must NOT appear in an empty/structured negative frame.
_NEGATIVE_WATCH = ("person", "car", "truck", "bus", "motorcycle")


@dataclass
class BenchmarkResult:
    per_scene: List[dict] = field(default_factory=list)
    recall: float = 0.0
    expected_total: int = 0
    found_total: int = 0
    false_positives_on_negatives: int = 0
    negatives_checked: int = 0


def _assets_dir():
    from ultralytics.utils import ASSETS  # path to bundled sample images
    return ASSETS


def _count_classes(detections: List[dict]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for d in detections:
        cls = d.get("class", d.get("class_name", ""))
        if cls:
            counts[cls] = counts.get(cls, 0) + 1
    return counts


def run() -> Optional[BenchmarkResult]:
    """Run the benchmark. Returns None if the detector/assets are unavailable."""
    import cv2
    import numpy as np

    try:
        from backend.services.yolo_detector import yolo_detector
        assets = _assets_dir()
    except Exception as e:  # pragma: no cover - env-dependent
        print(f"detector/assets unavailable: {e}")
        return None

    result = BenchmarkResult()

    # ── Recall on known-content real images ──────────────────────
    for scene in SCENES:
        img_path = assets / scene.name
        frame = cv2.imread(str(img_path))
        if frame is None:
            print(f"WARN: could not read {img_path}; skipping")
            continue
        out = yolo_detector.detect(frame, camera_id="benchmark")
        found = _count_classes(out.get("detections", []) if isinstance(out, dict) else [])
        scene_expected = sum(scene.expected_min.values())
        scene_found = sum(min(found.get(c, 0), n) for c, n in scene.expected_min.items())
        result.expected_total += scene_expected
        result.found_total += scene_found
        result.per_scene.append({
            "scene": scene.name,
            "expected_min": scene.expected_min,
            "found": {c: found.get(c, 0) for c in scene.expected_min},
            "all_found": found,
        })

    result.recall = (result.found_total / result.expected_total) if result.expected_total else 0.0

    # ── False positives on structured empty negatives ────────────
    negatives = {
        "black": np.zeros((480, 640, 3), dtype=np.uint8),
        "white": np.full((480, 640, 3), 255, dtype=np.uint8),
        "gray": np.full((480, 640, 3), 127, dtype=np.uint8),
    }
    for _name, frame in negatives.items():
        out = yolo_detector.detect(frame, camera_id="benchmark-neg")
        found = _count_classes(out.get("detections", []) if isinstance(out, dict) else [])
        result.negatives_checked += 1
        result.false_positives_on_negatives += sum(found.get(c, 0) for c in _NEGATIVE_WATCH)

    return result


def print_report(result: BenchmarkResult) -> None:
    print("── Detector benchmark ───────────────────────────")
    for s in result.per_scene:
        print(f"  {s['scene']:<14} expected>={s['expected_min']}  found={s['found']}")
    print(f"recall={result.recall:.3f}  ({result.found_total}/{result.expected_total} expected objects)")
    print(
        f"false positives on {result.negatives_checked} empty negatives: "
        f"{result.false_positives_on_negatives}"
    )


if __name__ == "__main__":
    r = run()
    if r is None:
        print("benchmark skipped (detector/assets unavailable)")
    else:
        print_report(r)
