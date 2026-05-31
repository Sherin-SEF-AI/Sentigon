"""Unit tests for the perception eval metric math (pure, no ML deps).

These guard the correctness of the precision/recall/F1 machinery so that, once
real labelled fixtures are added, the reported accuracy numbers are trustworthy.
"""
from __future__ import annotations

import math

from backend.eval.perception_eval import Detection, evaluate, iou, match_detections


def test_iou_identical_boxes_is_one():
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0


def test_iou_disjoint_boxes_is_zero():
    assert iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0


def test_iou_half_overlap():
    # Two 10x10 boxes overlapping in a 10x5 region: inter=50, union=150.
    assert math.isclose(iou((0, 0, 10, 10), (0, 5, 10, 15)), 50 / 150, rel_tol=1e-6)


def test_perfect_match_precision_recall_one():
    preds = [Detection("person", (0, 0, 10, 10), 0.9)]
    gts = [Detection("person", (0, 0, 10, 10))]
    r = match_detections(preds, gts)
    assert (r.true_positives, r.false_positives, r.false_negatives) == (1, 0, 0)
    assert r.precision == 1.0 and r.recall == 1.0 and r.f1 == 1.0


def test_false_positive_when_no_gt():
    r = match_detections([Detection("person", (0, 0, 10, 10), 0.9)], [])
    assert (r.true_positives, r.false_positives, r.false_negatives) == (0, 1, 0)
    assert r.precision == 0.0


def test_false_negative_when_missed():
    r = match_detections([], [Detection("person", (0, 0, 10, 10))])
    assert (r.true_positives, r.false_positives, r.false_negatives) == (0, 0, 1)
    assert r.recall == 0.0


def test_label_mismatch_is_not_a_match():
    preds = [Detection("car", (0, 0, 10, 10), 0.9)]
    gts = [Detection("person", (0, 0, 10, 10))]
    r = match_detections(preds, gts)
    assert (r.true_positives, r.false_positives, r.false_negatives) == (0, 1, 1)


def test_low_iou_is_not_a_match():
    preds = [Detection("person", (0, 0, 10, 10), 0.9)]
    gts = [Detection("person", (9, 9, 19, 19))]  # tiny overlap, IoU << 0.5
    r = match_detections(preds, gts, iou_threshold=0.5)
    assert r.true_positives == 0 and r.false_positives == 1 and r.false_negatives == 1


def test_one_gt_matched_only_once():
    # Two overlapping predictions, one GT → 1 TP + 1 FP.
    preds = [
        Detection("person", (0, 0, 10, 10), 0.95),
        Detection("person", (0, 0, 10, 10), 0.80),
    ]
    gts = [Detection("person", (0, 0, 10, 10))]
    r = match_detections(preds, gts)
    assert r.true_positives == 1 and r.false_positives == 1 and r.false_negatives == 0


def test_evaluate_aggregates_across_frames():
    frame1 = ([Detection("person", (0, 0, 10, 10), 0.9)], [Detection("person", (0, 0, 10, 10))])
    frame2 = ([Detection("car", (0, 0, 5, 5), 0.9)], [])  # false positive
    total = evaluate([frame1, frame2])
    assert total.true_positives == 1 and total.false_positives == 1 and total.false_negatives == 0
    assert math.isclose(total.precision, 0.5)
    assert total.recall == 1.0
