"""Real-time BOLO appearance matching.

`bolo_service` already does vehicle-plate matching (Levenshtein). This adds the
missing half: matching detected PEOPLE against active person BOLOs by CLIP
appearance embedding. Active person BOLOs (with an enrolled appearance embedding
stored in their JSONB ``description``) are cached in memory and refreshed on a
throttle; every new person track is embedded once (reusing
`appearance_embedder.appearance_embedding`) and matched by cosine similarity.

A hit becomes a high-severity threat that flows through the normal (verified)
alert path — turning the BOLO list from a static database into an active watch.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_TTL_SECONDS = 300.0


class BoloMatcher:
    def __init__(self) -> None:
        self._cache: List[Dict[str, Any]] = []   # {bolo_id, embedding, severity, reason}
        self._cache_t: float = 0.0
        self._checked: Dict[str, set] = {}        # camera_id -> track_ids already scanned

    def has_active(self) -> bool:
        return bool(self._cache) and (time.time() - self._cache_t) <= _TTL_SECONDS

    async def refresh(self, db) -> None:
        """Load active person BOLOs (with an enrolled appearance embedding)."""
        try:
            from backend.services.bolo_service import bolo_service
            bolos = await bolo_service.get_active_bolos(bolo_type="person")
        except Exception as exc:  # noqa: BLE001
            logger.debug("bolo_matcher.refresh failed: %s", exc)
            return
        cache: List[Dict[str, Any]] = []
        for b in bolos or []:
            desc = b.get("description") or {}
            emb = desc.get("appearance_embedding") if isinstance(desc, dict) else None
            if emb:
                cache.append({
                    "bolo_id": b.get("id"),
                    "embedding": emb,
                    "severity": b.get("severity", "high"),
                    "reason": b.get("reason") or "BOLO appearance match",
                })
        self._cache = cache
        self._cache_t = time.time()

    def match(self, embedding: List[float], threshold: float = 0.82) -> List[Dict[str, Any]]:
        from backend.services.appearance_embedder import cosine_similarity
        out: List[Dict[str, Any]] = []
        for entry in self._cache:
            sim = cosine_similarity(embedding, entry["embedding"])
            if sim >= threshold:
                out.append({**entry, "similarity": sim})
        out.sort(key=lambda m: m["similarity"], reverse=True)
        return out

    def scan_frame(self, frame_bgr, detections: Dict[str, Any], camera_id: str,
                   threshold: Optional[float] = None) -> List[Dict[str, Any]]:
        """Embed new person tracks and return BOLO-match threats."""
        if not self.has_active():
            return []
        try:
            from backend.config import settings
            thr = threshold if threshold is not None else float(getattr(settings, "BOLO_MATCH_THRESHOLD", 0.82))
        except Exception:
            thr = threshold if threshold is not None else 0.82
        from backend.services.appearance_embedder import appearance_embedding

        checked = self._checked.setdefault(str(camera_id), set())
        present = {d.get("track_id") for d in detections.get("detections", [])}
        # prune track_ids no longer present so a returning subject re-scans
        checked &= present

        out: List[Dict[str, Any]] = []
        for d in detections.get("detections", []) if isinstance(detections, dict) else []:
            if (d.get("class") or "").lower() != "person":
                continue
            tid = d.get("track_id")
            if tid is None or tid in checked or not d.get("bbox"):
                continue
            checked.add(tid)
            emb = appearance_embedding(frame_bgr, d["bbox"])
            if not emb:
                continue
            matches = self.match(emb, thr)
            if matches:
                best = matches[0]
                out.append({
                    "signature": "bolo_person_match",
                    "description": f"appearance matches active BOLO ({best['reason']})",
                    "severity": best.get("severity", "high"),
                    "confidence": round(float(best["similarity"]), 2),
                    "detection_method": "bolo",
                    "track_id": tid,
                    "bolo_id": str(best.get("bolo_id")),
                })
        return out


bolo_matcher = BoloMatcher()
