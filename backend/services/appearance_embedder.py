"""Privacy-preserving appearance embeddings for cross-camera re-identification.

Produces a compact, deterministic appearance feature vector from a person/object
crop using upper/lower-body HSV colour histograms. This is a classic, fast,
GPU-free re-ID feature that captures clothing colour — far more discriminative
than the bbox-aspect-ratio heuristic it replaces — and crucially carries NO
facial/biometric information (matches the deployment's privacy-preserving stance).

The vector slots into EntityTrack.appearance_embedding and is compared with
cosine similarity. A heavier CLIP/OSNet crop embedding can later be concatenated
or swapped in behind the same interface.
"""
from __future__ import annotations

from typing import List, Sequence

# 2D Hue-Saturation histogram per body region. Value (brightness) is dropped on
# purpose: it is lighting-dependent and hurts cross-camera matching, whereas
# hue/saturation capture clothing colour robustly.
H_BINS = 8
S_BINS = 4
EMBEDDING_DIM = H_BINS * S_BINS * 2  # upper + lower body = 64


def _crop_bbox(frame_bgr, bbox: Sequence[float]):
    """Return the clamped bbox crop of a BGR frame, or None if invalid/empty."""
    if frame_bgr is None or bbox is None or len(bbox) < 4:
        return None
    h, w = frame_bgr.shape[:2]
    x1, y1, x2, y2 = (int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3]))
    x1 = max(0, min(x1, w - 1))
    y1 = max(0, min(y1, h - 1))
    x2 = max(x1 + 1, min(x2, w))
    y2 = max(y1 + 1, min(y2, h))
    crop = frame_bgr[y1:y2, x1:x2]
    if crop.size == 0:
        return None
    return crop


def compute_clip_crop_embedding(frame_bgr, bbox: Sequence[float]) -> List[float]:
    """CLIP embedding of the person/object crop — a richer, semantic appearance
    descriptor than the HSV histogram (more robust to lighting/pose), reusing the
    existing clip_embedder. Returns [] if the crop is invalid or CLIP is
    unavailable (caller falls back to the histogram)."""
    crop = _crop_bbox(frame_bgr, bbox)
    if crop is None:
        return []
    try:
        from backend.services.clip_embedder import clip_embedder
        vec = clip_embedder.embed_frame_sync(crop)
        return list(vec) if vec else []
    except Exception:
        return []


def appearance_embedding(frame_bgr, bbox: Sequence[float]) -> List[float]:
    """Produce an appearance embedding for re-ID.

    Uses a CLIP crop embedding when REID_USE_CLIP is enabled and available
    (richer/more robust), otherwise the fast HSV colour histogram. Vectors of
    different kinds never falsely match: cosine_similarity returns 0 on a
    dimension mismatch, so switching embedders simply ages out old entities.
    """
    try:
        from backend.config import settings
        use_clip = bool(getattr(settings, "REID_USE_CLIP", False))
    except Exception:
        use_clip = False
    if use_clip:
        emb = compute_clip_crop_embedding(frame_bgr, bbox)
        if emb:
            return emb
    return compute_appearance_embedding(frame_bgr, bbox)


def compute_appearance_embedding(
    frame_bgr, bbox: Sequence[float], h_bins: int = H_BINS, s_bins: int = S_BINS
) -> List[float]:
    """Compute an L1-normalised upper/lower-body Hue-Saturation histogram.

    Args:
        frame_bgr: full frame as an HxWx3 BGR numpy array (OpenCV convention).
        bbox: [x1, y1, x2, y2] in pixels.
        h_bins, s_bins: hue / saturation histogram resolution.

    Returns:
        A feature vector of length ``h_bins*s_bins*2`` (upper then lower body),
        or an empty list if the crop is empty/invalid.
    """
    import cv2  # lazy: only needed when actually embedding a frame

    crop = _crop_bbox(frame_bgr, bbox)
    if crop is None:
        return []

    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    mid = max(1, hsv.shape[0] // 2)
    regions = [hsv[:mid], hsv[mid:]]  # upper body, lower body

    vec: List[float] = []
    for region in regions:
        if region.size == 0:
            vec.extend([0.0] * (h_bins * s_bins))
            continue
        # 2D H-S histogram. OpenCV ranges: H in [0,180), S in [0,256).
        hist = cv2.calcHist(
            [region], [0, 1], None, [h_bins, s_bins], [0, 180, 0, 256]
        ).flatten()
        total = float(hist.sum())
        if total > 0:
            hist = hist / total
        vec.extend(float(v) for v in hist)
    return vec


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity of two equal-length vectors (pure Python; no deps).

    Returns 0.0 for empty, mismatched-length, or zero-norm inputs.
    """
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def blend_embeddings(
    existing: Sequence[float], new: Sequence[float], weight_new: float = 0.3
) -> List[float]:
    """Exponential moving average of two embeddings (stabilises an entity's
    appearance over many frames). Falls back to whichever side is present."""
    if not existing:
        return list(new)
    if not new or len(existing) != len(new):
        return list(existing)
    w = max(0.0, min(1.0, weight_new))
    return [e * (1.0 - w) + n * w for e, n in zip(existing, new)]
