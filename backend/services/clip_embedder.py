"""CLIP ViT-bigG-14 embedding service — thread-safe singleton.

Model: ViT-bigG-14 pretrained on laion2b_s39b_b160k (LAION-2B dataset)
Library: open_clip
Embedding dim: 1280
Parameters: ~2.5B
Input: 224×224 (auto-resized)
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import threading
import time
from typing import Dict, List, Optional

import numpy as np

from backend.config import settings

logger = logging.getLogger(__name__)

_model = None
_tokenizer = None
_preprocess = None
_device = None
_model_lock = threading.Lock()
_loaded = False


def _load_model():
    """Lazy-load CLIP model on first use (thread-safe)."""
    global _model, _tokenizer, _preprocess, _device, _loaded

    if _loaded:
        return

    with _model_lock:
        if _loaded:
            return

        try:
            import torch
            import open_clip

            # Set HF token for model download
            if settings.HF_TOKEN:
                os.environ["HF_TOKEN"] = settings.HF_TOKEN

            # Device selection
            if settings.CLIP_DEVICE == "auto":
                _device = "cuda" if torch.cuda.is_available() else "cpu"
            else:
                _device = settings.CLIP_DEVICE

            logger.info(
                "Loading CLIP model %s/%s on %s ...",
                settings.CLIP_MODEL_NAME,
                settings.CLIP_PRETRAINED,
                _device,
            )

            _model, _, _preprocess = open_clip.create_model_and_transforms(
                settings.CLIP_MODEL_NAME,
                pretrained=settings.CLIP_PRETRAINED,
                device=_device,
            )
            _tokenizer = open_clip.get_tokenizer(settings.CLIP_MODEL_NAME)
            _model.eval()
            _loaded = True

            param_count = sum(p.numel() for p in _model.parameters())
            logger.info(
                "CLIP model loaded: %s/%s | device=%s | params=%.1fM | dim=%d",
                settings.CLIP_MODEL_NAME,
                settings.CLIP_PRETRAINED,
                _device,
                param_count / 1e6,
                settings.CLIP_EMBEDDING_DIM,
            )
        except Exception as e:
            logger.error("Failed to load CLIP model: %s", e)
            raise


class CLIPEmbedder:
    """Thread-safe CLIP embedding service."""

    def __init__(self):
        self._inference_count: int = 0
        self._total_latency_ms: float = 0.0
        self._lock = threading.Lock()

    @property
    def is_loaded(self) -> bool:
        return _loaded

    @property
    def device(self) -> str:
        return _device or "not_loaded"

    def _ensure_loaded(self):
        if not _loaded:
            _load_model()

    def _record_latency(self, ms: float):
        with self._lock:
            self._inference_count += 1
            self._total_latency_ms += ms

    # ── Image embedding (sync, run via to_thread) ─────────

    def embed_frame_sync(self, frame: np.ndarray) -> List[float]:
        """Embed a single BGR numpy frame → 1280d vector (sync)."""
        import torch
        from PIL import Image

        self._ensure_loaded()
        t0 = time.perf_counter()

        # Convert BGR (OpenCV) → RGB PIL Image
        rgb = frame[:, :, ::-1] if frame.ndim == 3 else frame
        pil_img = Image.fromarray(rgb)

        # Preprocess and encode
        img_tensor = _preprocess(pil_img).unsqueeze(0).to(_device)
        with torch.no_grad(), torch.amp.autocast(device_type=_device if _device != "cpu" else "cpu", enabled=_device == "cuda"):
            features = _model.encode_image(img_tensor)
            features = features / features.norm(dim=-1, keepdim=True)

        vec = features[0].cpu().numpy().tolist()
        self._record_latency((time.perf_counter() - t0) * 1000)
        return vec

    def embed_frames_sync(self, frames: List[np.ndarray]) -> List[List[float]]:
        """Batch embed multiple BGR numpy frames → list of 1280d vectors (sync)."""
        import torch
        from PIL import Image

        self._ensure_loaded()
        if not frames:
            return []

        t0 = time.perf_counter()

        tensors = []
        for frame in frames:
            rgb = frame[:, :, ::-1] if frame.ndim == 3 else frame
            pil_img = Image.fromarray(rgb)
            tensors.append(_preprocess(pil_img))

        batch = torch.stack(tensors).to(_device)
        with torch.no_grad(), torch.amp.autocast(device_type=_device if _device != "cpu" else "cpu", enabled=_device == "cuda"):
            features = _model.encode_image(batch)
            features = features / features.norm(dim=-1, keepdim=True)

        vecs = features.cpu().numpy().tolist()
        self._record_latency((time.perf_counter() - t0) * 1000)
        return vecs

    def embed_image_bytes_sync(self, image_bytes: bytes) -> List[float]:
        """Embed JPEG/PNG bytes → 1280d vector (sync)."""
        import torch
        from PIL import Image

        self._ensure_loaded()
        t0 = time.perf_counter()

        pil_img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img_tensor = _preprocess(pil_img).unsqueeze(0).to(_device)

        with torch.no_grad(), torch.amp.autocast(device_type=_device if _device != "cpu" else "cpu", enabled=_device == "cuda"):
            features = _model.encode_image(img_tensor)
            features = features / features.norm(dim=-1, keepdim=True)

        vec = features[0].cpu().numpy().tolist()
        self._record_latency((time.perf_counter() - t0) * 1000)
        return vec

    # ── Text embedding (sync, run via to_thread) ──────────

    def embed_text_sync(self, text: str) -> List[float]:
        """Embed text query → 1280d vector (sync, same space as images)."""
        import torch

        self._ensure_loaded()
        t0 = time.perf_counter()

        tokens = _tokenizer([text]).to(_device)
        with torch.no_grad(), torch.amp.autocast(device_type=_device if _device != "cpu" else "cpu", enabled=_device == "cuda"):
            features = _model.encode_text(tokens)
            features = features / features.norm(dim=-1, keepdim=True)

        vec = features[0].cpu().numpy().tolist()
        self._record_latency((time.perf_counter() - t0) * 1000)
        return vec

    # ── Async wrappers (non-blocking) ─────────────────────

    async def embed_frame(self, frame: np.ndarray) -> List[float]:
        """Async: embed single frame via thread pool."""
        return await asyncio.to_thread(self.embed_frame_sync, frame)

    async def embed_frames(self, frames: List[np.ndarray]) -> List[List[float]]:
        """Async: batch embed frames via thread pool."""
        return await asyncio.to_thread(self.embed_frames_sync, frames)

    async def embed_text(self, text: str) -> List[float]:
        """Async: embed text query via thread pool."""
        return await asyncio.to_thread(self.embed_text_sync, text)

    async def embed_image_bytes(self, image_bytes: bytes) -> List[float]:
        """Async: embed image bytes via thread pool."""
        return await asyncio.to_thread(self.embed_image_bytes_sync, image_bytes)

    # ── Utilities ─────────────────────────────────────────

    @staticmethod
    def compute_similarity(vec_a: List[float], vec_b: List[float]) -> float:
        """Cosine similarity between two vectors (already L2-normalized)."""
        a = np.array(vec_a, dtype=np.float32)
        b = np.array(vec_b, dtype=np.float32)
        return float(np.dot(a, b))

    @staticmethod
    def compute_distance(vec_a: List[float], vec_b: List[float]) -> float:
        """Cosine distance (1 - similarity). 0=identical, 1=orthogonal, 2=opposite."""
        return 1.0 - CLIPEmbedder.compute_similarity(vec_a, vec_b)

    def get_stats(self) -> Dict:
        """Return model stats."""
        with self._lock:
            avg_ms = (
                self._total_latency_ms / self._inference_count
                if self._inference_count > 0
                else 0.0
            )
        return {
            "model_loaded": _loaded,
            "model_name": f"{settings.CLIP_MODEL_NAME}/{settings.CLIP_PRETRAINED}",
            "device": _device or "not_loaded",
            "embedding_dim": settings.CLIP_EMBEDDING_DIM,
            "total_inferences": self._inference_count,
            "avg_inference_ms": round(avg_ms, 1),
            "clip_enabled": settings.CLIP_ENABLED,
        }


# Singleton
clip_embedder = CLIPEmbedder()
