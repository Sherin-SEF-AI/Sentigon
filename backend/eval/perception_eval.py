"""Perception evaluation harness — detection precision/recall/F1.

Two layers:
1. Pure metric functions (iou, match_detections, evaluate) — no ML imports, so
   they're fast and unit-tested in CI (backend/tests/test_eval_metrics.py).
2. A fixture runner that executes the REAL YOLO detector over labelled frames in
   backend/eval/fixtures/ and reports aggregate metrics. Run it with:
       make eval        # or: python -m backend.eval.perception_eval

Fixture format (backend/eval/fixtures/manifest.json):
    [
      {"image": "frame_001.jpg",
       "ground_truth": [{"label": "person", "bbox": [x1, y1, x2, y2]}, ...]},
      ...
    ]
Add real labelled frames over time; the metrics below then become a meaningful,
regression-gated accuracy benchmark (Workstream 5).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Sequence, Tuple

# ── Pure metric layer (no ML/torch/cv2 imports) ───────────────────────────────

BBox = Tuple[float, float, float, float]  # (x1, y1, x2, y2)


@dataclass
class Detection:
    label: str
    bbox: BBox
    confidence: float = 1.0


@dataclass
class EvalResult:
    true_positives: int = 0
    false_positives: int = 0
    false_negatives: int = 0
    per_label: dict = field(default_factory=dict)

    @property
    def precision(self) -> float:
        denom = self.true_positives + self.false_positives
        return self.true_positives / denom if denom else 0.0

    @property
    def recall(self) -> float:
        denom = self.true_positives + self.false_negatives
        return self.true_positives / denom if denom else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) else 0.0


def iou(a: BBox, b: BBox) -> float:
    """Intersection-over-union of two axis-aligned boxes."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def match_detections(
    predictions: Sequence[Detection],
    ground_truth: Sequence[Detection],
    iou_threshold: float = 0.5,
) -> EvalResult:
    """Greedy IoU matching of predictions to ground truth for one frame.

    A prediction matches a GT box of the same label with IoU >= threshold.
    Each GT box matches at most one prediction (highest IoU first).
    """
    result = EvalResult()
    # Sort predictions by confidence so higher-confidence boxes claim GT first.
    preds = sorted(predictions, key=lambda d: d.confidence, reverse=True)
    unmatched_gt = list(ground_truth)

    for pred in preds:
        best_idx, best_iou = -1, iou_threshold
        for idx, gt in enumerate(unmatched_gt):
            if gt.label != pred.label:
                continue
            score = iou(pred.bbox, gt.bbox)
            if score >= best_iou:
                best_idx, best_iou = idx, score
        if best_idx >= 0:
            result.true_positives += 1
            _bump(result.per_label, pred.label, "tp")
            unmatched_gt.pop(best_idx)
        else:
            result.false_positives += 1
            _bump(result.per_label, pred.label, "fp")

    for gt in unmatched_gt:
        result.false_negatives += 1
        _bump(result.per_label, gt.label, "fn")

    return result


def _bump(per_label: dict, label: str, key: str) -> None:
    per_label.setdefault(label, {"tp": 0, "fp": 0, "fn": 0})[key] += 1


def evaluate(
    frames: Sequence[Tuple[Sequence[Detection], Sequence[Detection]]],
    iou_threshold: float = 0.5,
) -> EvalResult:
    """Aggregate metrics over many (predictions, ground_truth) frame pairs."""
    total = EvalResult()
    for preds, gts in frames:
        r = match_detections(preds, gts, iou_threshold)
        total.true_positives += r.true_positives
        total.false_positives += r.false_positives
        total.false_negatives += r.false_negatives
        for label, counts in r.per_label.items():
            agg = total.per_label.setdefault(label, {"tp": 0, "fp": 0, "fn": 0})
            for k, v in counts.items():
                agg[k] += v
    return total


# ── Fixture runner (imports the real detector lazily) ─────────────────────────

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load_manifest() -> list:
    manifest = FIXTURES_DIR / "manifest.json"
    if not manifest.exists():
        return []
    return json.loads(manifest.read_text())


def run_fixture_eval(iou_threshold: float = 0.5) -> EvalResult | None:
    """Run the real YOLO detector over labelled fixtures and report metrics.

    Returns None if there are no fixtures yet (so CI/`make eval` is informative
    rather than failing on an empty fixture set).
    """
    import cv2  # noqa: imported lazily — only when actually running the model

    from backend.services.yolo_detector import yolo_detector

    entries = _load_manifest()
    if not entries:
        print(
            "No fixtures found in backend/eval/fixtures/.\n"
            "Add labelled frames + a manifest.json to produce a real accuracy "
            "benchmark (see this module's docstring)."
        )
        return None

    frames: List[Tuple[List[Detection], List[Detection]]] = []
    for entry in entries:
        img_path = FIXTURES_DIR / entry["image"]
        frame = cv2.imread(str(img_path))
        if frame is None:
            print(f"WARN: could not read {img_path}; skipping")
            continue
        raw = yolo_detector.detect(frame, camera_id="eval")
        preds = [
            Detection(label=d.get("class_name", d.get("label", "")),
                      bbox=tuple(d["bbox"]),
                      confidence=float(d.get("confidence", 1.0)))
            for d in (raw.get("detections", []) if isinstance(raw, dict) else [])
        ]
        gts = [Detection(label=g["label"], bbox=tuple(g["bbox"])) for g in entry["ground_truth"]]
        frames.append((preds, gts))

    result = evaluate(frames, iou_threshold)
    print("── Perception eval ──────────────────────────────")
    print(f"frames={len(frames)}  IoU>={iou_threshold}")
    print(f"TP={result.true_positives}  FP={result.false_positives}  FN={result.false_negatives}")
    print(f"precision={result.precision:.3f}  recall={result.recall:.3f}  F1={result.f1:.3f}")
    for label, c in sorted(result.per_label.items()):
        print(f"  {label:<16} tp={c['tp']} fp={c['fp']} fn={c['fn']}")
    return result


if __name__ == "__main__":
    run_fixture_eval()
