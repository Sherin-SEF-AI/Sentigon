"""Real local ALPR (Automatic License-Plate Recognition) via EasyOCR.

Replaces the slow, inconsistent vision-model plate path with a fast, local OCR
engine. Given a vehicle crop it reads candidate text, keeps the most plate-like
token (alphanumeric, plate-length), normalises it, and returns it for BOLO /
watchlist matching (`bolo_service.check_plate_match`) and VehicleSighting
logging. Lazy-loaded and gated by ALPR_ENABLED so it never affects startup; runs
on CPU by default to avoid GPU contention with Ollama.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

_reader = None
_reader_lock = None
_PLATE_RE = re.compile(r"^[A-Z0-9]{4,9}$")
_ALNUM = re.compile(r"[^A-Z0-9]")


def _normalise(text: str) -> str:
    return _ALNUM.sub("", (text or "").upper())


class ALPRService:
    def _get_reader(self):
        global _reader, _reader_lock
        from backend.config import settings
        if not getattr(settings, "ALPR_ENABLED", True):
            return None
        import threading
        if _reader_lock is None:
            _reader_lock = threading.Lock()
        with _reader_lock:
            if _reader is None:
                try:
                    import easyocr
                    use_gpu = bool(getattr(settings, "ALPR_GPU", False))
                    _reader = easyocr.Reader(["en"], gpu=use_gpu, verbose=False)
                    logger.info("ALPR (EasyOCR) reader loaded (gpu=%s)", use_gpu)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("ALPR reader load failed: %s", exc)
                    _reader = None
        return _reader

    def available(self) -> bool:
        return self._get_reader() is not None

    def read_plate(self, frame_bgr, bbox: Optional[Sequence[float]] = None) -> Optional[Dict[str, Any]]:
        """Read the most plate-like text from a (vehicle) crop.

        Returns {plate, confidence, raw} for the best candidate, or None.
        """
        reader = self._get_reader()
        if reader is None or frame_bgr is None:
            return None
        from backend.config import settings
        min_conf = float(getattr(settings, "ALPR_MIN_CONFIDENCE", 0.4))

        crop = frame_bgr
        try:
            if bbox is not None:
                x1, y1, x2, y2 = [int(v) for v in bbox]
                crop = frame_bgr[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
            if crop is None or crop.size == 0:
                return None
            detections = reader.readtext(crop)  # [(box, text, conf), ...]
        except Exception as exc:  # noqa: BLE001
            logger.debug("ALPR readtext failed: %s", exc)
            return None

        best: Optional[Dict[str, Any]] = None
        for det in detections or []:
            try:
                _box, text, conf = det
            except Exception:
                continue
            norm = _normalise(text)
            if not _PLATE_RE.match(norm) or conf < min_conf:
                continue
            if best is None or conf > best["confidence"]:
                best = {"plate": norm, "confidence": round(float(conf), 3), "raw": text}
        return best

    async def read_and_match(self, frame_bgr, bbox=None) -> Dict[str, Any]:
        """Read a plate and check it against active vehicle BOLOs."""
        result = self.read_plate(frame_bgr, bbox)
        if not result:
            return {"plate": None, "matches": []}
        try:
            from backend.services.bolo_service import bolo_service
            matches = await bolo_service.check_plate_match(result["plate"])
        except Exception as exc:  # noqa: BLE001
            logger.debug("ALPR BOLO match failed: %s", exc)
            matches = []
        return {**result, "matches": matches}


alpr_service = ALPRService()
