"""Evaluation harness for the perception pipeline.

This package provides the measurement foundation: IoU-based precision/recall/F1
against labelled ground truth. The metric functions are pure (no ML imports) so
they are unit-tested in CI; the model-running evaluation is invoked explicitly
via `python -m backend.eval.perception_eval` (see Makefile `eval` target).
"""
