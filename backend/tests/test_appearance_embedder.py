"""Tests for the appearance embedder (cross-camera re-ID feature)."""
from __future__ import annotations

import pytest

import backend.services.appearance_embedder as ae
from backend.services.appearance_embedder import (
    EMBEDDING_DIM,
    appearance_embedding,
    blend_embeddings,
    compute_appearance_embedding,
    compute_clip_crop_embedding,
    cosine_similarity,
)


# ── cosine_similarity (pure Python, always runs) ──────────────────────────────

def test_cosine_identical_is_one():
    v = [0.1, 0.2, 0.3, 0.4]
    assert cosine_similarity(v, v) == pytest.approx(1.0)


def test_cosine_orthogonal_is_zero():
    assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_cosine_handles_empty_and_mismatched():
    assert cosine_similarity([], [1.0]) == 0.0
    assert cosine_similarity([1.0, 2.0], [1.0]) == 0.0
    assert cosine_similarity([0.0, 0.0], [1.0, 1.0]) == 0.0  # zero norm


def test_cosine_similar_vectors_high():
    a = [0.5, 0.4, 0.1]
    b = [0.5, 0.39, 0.11]
    assert cosine_similarity(a, b) > 0.99


# ── blend_embeddings ──────────────────────────────────────────────────────────

def test_blend_is_ema():
    out = blend_embeddings([0.0, 1.0], [1.0, 0.0], weight_new=0.5)
    assert out == [0.5, 0.5]


def test_blend_falls_back_when_one_side_missing():
    assert blend_embeddings([], [1.0, 2.0]) == [1.0, 2.0]
    assert blend_embeddings([1.0, 2.0], []) == [1.0, 2.0]
    assert blend_embeddings([1.0], [1.0, 2.0]) == [1.0]  # length mismatch -> keep existing


# ── compute_appearance_embedding (needs cv2 + numpy) ──────────────────────────

def test_embedding_dim_and_discrimination():
    np = pytest.importorskip("numpy")
    pytest.importorskip("cv2")

    # Frame: red upper half, blue lower half (BGR).
    frame = np.zeros((100, 40, 3), dtype=np.uint8)
    frame[:50, :] = (0, 0, 255)   # red upper (BGR)
    frame[50:, :] = (255, 0, 0)   # blue lower (BGR)
    emb = compute_appearance_embedding(frame, [0, 0, 40, 100])
    assert len(emb) == EMBEDDING_DIM

    # A solid-red crop should be clearly less similar to the red/blue frame
    # than the red/blue frame is to itself.
    red = np.zeros((100, 40, 3), dtype=np.uint8)
    red[:, :] = (0, 0, 255)
    emb_red = compute_appearance_embedding(red, [0, 0, 40, 100])
    assert cosine_similarity(emb, emb) == pytest.approx(1.0)
    assert cosine_similarity(emb, emb_red) < cosine_similarity(emb, emb)


def test_embedding_empty_on_bad_input():
    np = pytest.importorskip("numpy")
    pytest.importorskip("cv2")
    frame = np.zeros((10, 10, 3), dtype=np.uint8)
    # None frame and a too-short bbox yield an empty vector.
    assert compute_appearance_embedding(None, [0, 0, 1, 1]) == []
    assert compute_appearance_embedding(frame, [0, 1, 2]) == []  # bbox shorter than 4
    # A zero-area bbox is clamped to a valid 1px crop, so it returns a vector.
    assert len(compute_appearance_embedding(frame, [5, 5, 5, 5])) == EMBEDDING_DIM


# ── re-ID embedding dispatcher (CLIP crop vs HSV histogram) ───────────────────

def test_clip_crop_embedding_empty_on_bad_input():
    # Short-circuits before any CLIP import — no model needed.
    assert compute_clip_crop_embedding(None, [0, 0, 1, 1]) == []
    assert compute_clip_crop_embedding(object(), [0, 1, 2]) == []  # bbox too short


def test_dispatcher_uses_histogram_when_clip_disabled(monkeypatch):
    from backend.config import settings
    monkeypatch.setattr(settings, "REID_USE_CLIP", False, raising=False)
    monkeypatch.setattr(ae, "compute_clip_crop_embedding", lambda f, b: ["CLIP"])
    monkeypatch.setattr(ae, "compute_appearance_embedding", lambda f, b: ["HSV"])
    assert appearance_embedding(None, [0, 0, 1, 1]) == ["HSV"]


def test_dispatcher_prefers_clip_when_enabled(monkeypatch):
    from backend.config import settings
    monkeypatch.setattr(settings, "REID_USE_CLIP", True, raising=False)
    monkeypatch.setattr(ae, "compute_clip_crop_embedding", lambda f, b: [0.1] * 512)
    monkeypatch.setattr(ae, "compute_appearance_embedding", lambda f, b: ["HSV"])
    assert appearance_embedding(None, [0, 0, 1, 1]) == [0.1] * 512


def test_dispatcher_falls_back_when_clip_unavailable(monkeypatch):
    from backend.config import settings
    monkeypatch.setattr(settings, "REID_USE_CLIP", True, raising=False)
    monkeypatch.setattr(ae, "compute_clip_crop_embedding", lambda f, b: [])  # CLIP failed
    monkeypatch.setattr(ae, "compute_appearance_embedding", lambda f, b: ["HSV"])
    assert appearance_embedding(None, [0, 0, 1, 1]) == ["HSV"]


def test_cross_kind_embeddings_never_falsely_match():
    # A CLIP-dim (512) and an HSV-dim (64) vector must not match (cosine 0),
    # so switching embedders can't produce false re-IDs — it just ages out old.
    assert cosine_similarity([0.1] * 512, [0.1] * 64) == 0.0
