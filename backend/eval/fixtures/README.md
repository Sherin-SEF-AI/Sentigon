# Perception eval fixtures

Drop labelled frames here and describe them in `manifest.json` to turn the eval
harness into a real, regression-gated accuracy benchmark.

## Format

`manifest.json`:

```json
[
  {
    "image": "frame_001.jpg",
    "ground_truth": [
      { "label": "person", "bbox": [120, 80, 210, 340] },
      { "label": "knife",  "bbox": [305, 210, 332, 260] }
    ]
  }
]
```

- `image` — a frame file in this directory.
- `bbox` — `[x1, y1, x2, y2]` in pixels.
- `label` — must match the detector's class names (COCO names, e.g. `person`,
  `car`, `knife`).

## Run

```bash
make eval        # python -m backend.eval.perception_eval
```

The runner executes the real YOLO detector over each frame and reports
precision / recall / F1 at IoU ≥ 0.5, overall and per label.

## Why no fixtures are committed yet

Representative, properly-labelled CCTV frames are deployment-specific and can
carry privacy constraints, so none ship in the repo. The metric math is fully
unit-tested (`backend/tests/test_eval_metrics.py`); add real frames here to
produce trustworthy numbers. This is the seed of Workstream 5 (MLOps/eval).
