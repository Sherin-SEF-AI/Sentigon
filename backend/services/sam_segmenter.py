"""SAM2 segmentation — mask-precise object boundaries for occlusion handling.

YOLO/RT-DETR give axis-aligned boxes; under occlusion a box is a poor proxy for
the real object extent. SAM2 produces a pixel-precise mask for each detected
object, which gives (a) a true object area/contour even when partially occluded,
and (b) a stable mask to re-acquire an object that the box tracker briefly loses.

Implemented as an on-demand, gated, lazily-loaded service (ultralytics `SAM`,
SAM2 weights). It is intentionally NOT run on every frame of the hot loop — the
full SAM2 video-memory tracker is far heavier; this is the segmentation building
block, used selectively (an endpoint, or for flagged high-value tracks).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)

_sam_model = None
_sam_lock = None


class SamSegmenter:
    """Mask segmentation via SAM2 (ultralytics), prompted by detector boxes."""

    def _get_model(self):
        global _sam_model, _sam_lock
        from backend.config import settings
        if not getattr(settings, "SAM2_ENABLED", False):
            return None
        import threading
        if _sam_lock is None:
            _sam_lock = threading.Lock()
        with _sam_lock:
            if _sam_model is None:
                try:
                    from ultralytics import SAM
                    from backend.services.yolo_detector import _resolve_device
                    model_path = getattr(settings, "SAM2_MODEL", "sam2_t.pt") or "sam2_t.pt"
                    _sam_model = SAM(model_path)
                    try:
                        _sam_model.to(_resolve_device())
                    except Exception:
                        pass
                    logger.info("SAM2 segmenter loaded: %s", model_path)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("SAM2 load failed: %s", exc)
                    _sam_model = None
        return _sam_model

    def available(self) -> bool:
        return self._get_model() is not None

    def segment(
        self,
        frame: np.ndarray,
        bboxes: Optional[List[List[float]]] = None,
    ) -> Dict[str, Any]:
        """Segment objects in the frame. If ``bboxes`` (x1,y1,x2,y2) are given they
        prompt SAM2; otherwise SAM2 segments salient objects. Returns per-object
        mask metadata (bbox, pixel area, simplified polygon) — never raw masks,
        which are too large for an API response.
        """
        model = self._get_model()
        if model is None:
            return {"enabled": False, "objects": []}

        try:
            kwargs: Dict[str, Any] = {"verbose": False}
            if bboxes:
                kwargs["bboxes"] = bboxes
            results = model(frame, **kwargs)
        except Exception as exc:  # noqa: BLE001
            logger.warning("SAM2 segment failed: %s", exc)
            return {"enabled": True, "error": str(exc), "objects": []}

        objects: List[Dict[str, Any]] = []
        try:
            import cv2
            for r in results:
                masks = getattr(r, "masks", None)
                if masks is None:
                    continue
                for m in masks:
                    polys = getattr(m, "xy", None)
                    if not polys or len(polys) == 0:
                        continue
                    poly = np.asarray(polys[0], dtype=np.float32)
                    if poly.shape[0] < 3:
                        continue
                    area = float(cv2.contourArea(poly))
                    x, y, w, h = cv2.boundingRect(poly.astype(np.int32))
                    # Simplify the contour so the response stays small.
                    eps = 0.01 * cv2.arcLength(poly.astype(np.int32), True)
                    simp = cv2.approxPolyDP(poly.astype(np.int32), eps, True).reshape(-1, 2)
                    objects.append({
                        "bbox": [int(x), int(y), int(x + w), int(y + h)],
                        "area_px": int(area),
                        "polygon": simp.tolist()[:60],
                    })
        except Exception as exc:  # noqa: BLE001
            logger.debug("SAM2 mask post-processing failed: %s", exc)

        return {"enabled": True, "count": len(objects), "objects": objects}


sam_segmenter = SamSegmenter()
