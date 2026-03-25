"""Anomaly Fingerprinting — Learning Pattern Library.

Every resolved true-positive becomes a named pattern: "Tailgating at
revolving door", "Package drop-and-leave", "Vehicle circling parking lot."
Future detections are compared against the library for instant classification.

The system gets smarter with every resolved incident, building an
organization-specific threat signature library unique to YOUR facility.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import numpy as np

from backend.config import settings

logger = logging.getLogger(__name__)

_PATTERN_EXTRACTION_PROMPT = """\
A security alert has been resolved as a confirmed true positive. Extract a
reusable pattern from this incident for future automated detection.

**Alert Details:**
- Title: {title}
- Threat Type: {threat_type}
- Severity: {severity}
- Camera: {camera}
- Zone: {zone}
- Description: {description}
- Resolution Notes: {resolution_notes}

Generate a named pattern. Respond with JSON:
{{
  "pattern_name": "short descriptive name (e.g., 'tailgating_at_revolving_door')",
  "display_name": "Human-readable name (e.g., 'Tailgating at Revolving Door')",
  "description": "detailed description of the behavioral pattern",
  "category": "intrusion|suspicious|violence|theft|compliance|behavioral|operational",
  "severity": "low|medium|high|critical",
  "indicators": ["list of specific visual or behavioral indicators"],
  "typical_location": "where this pattern typically occurs",
  "typical_time": "when this pattern typically occurs (or 'any')",
  "detection_tips": "what to look for when scanning for this pattern",
  "response_guidance": "recommended response when this pattern is detected"
}}
"""


class LearnedPattern:
    """Represents a pattern learned from resolved incidents."""

    def __init__(self, pattern_name: str, display_name: str = "") -> None:
        self.pattern_id = f"lp_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{pattern_name[:20]}"
        self.pattern_name = pattern_name
        self.display_name = display_name or pattern_name.replace("_", " ").title()
        self.description: str = ""
        self.category: str = "unknown"
        self.severity: str = "medium"
        self.indicators: List[str] = []
        self.typical_location: str = ""
        self.typical_time: str = "any"
        self.detection_tips: str = ""
        self.response_guidance: str = ""
        self.clip_embeddings: List[np.ndarray] = []
        self.source_alert_ids: List[str] = []
        self.match_count: int = 0
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.last_matched: Optional[str] = None

    def add_embedding(self, embedding: np.ndarray) -> None:
        """Add a CLIP embedding from a confirmed incident."""
        self.clip_embeddings.append(embedding)

    @property
    def mean_embedding(self) -> Optional[np.ndarray]:
        """Get average CLIP embedding for this pattern."""
        if not self.clip_embeddings:
            return None
        return np.mean(self.clip_embeddings, axis=0)

    def match_similarity(self, embedding: np.ndarray) -> float:
        """Check similarity against this pattern's embedding library."""
        mean = self.mean_embedding
        if mean is None:
            return 0.0
        norm_a = np.linalg.norm(embedding)
        norm_b = np.linalg.norm(mean)
        if norm_a < 1e-6 or norm_b < 1e-6:
            return 0.0
        return float(np.dot(embedding, mean) / (norm_a * norm_b))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pattern_id": self.pattern_id,
            "pattern_name": self.pattern_name,
            "display_name": self.display_name,
            "description": self.description,
            "category": self.category,
            "severity": self.severity,
            "indicators": self.indicators,
            "typical_location": self.typical_location,
            "typical_time": self.typical_time,
            "detection_tips": self.detection_tips,
            "response_guidance": self.response_guidance,
            "embedding_count": len(self.clip_embeddings),
            "source_alerts": len(self.source_alert_ids),
            "match_count": self.match_count,
            "created_at": self.created_at,
            "last_matched": self.last_matched,
        }


class PatternLibrary:
    """Manages the learned pattern library.

    Stores patterns learned from resolved true-positive alerts, and
    matches new detections against the library for instant classification.
    """

    def __init__(self) -> None:
        self._patterns: Dict[str, LearnedPattern] = {}
        self._qdrant_collection = "learned_patterns"

    async def learn_from_resolution(
        self,
        alert_id: str,
        alert_data: Dict[str, Any],
        clip_embedding: Optional[np.ndarray] = None,
    ) -> Optional[LearnedPattern]:
        """Learn a new pattern from a resolved true-positive alert.

        Called when an operator resolves an alert as a true positive.
        Extracts the behavioral pattern and stores it for future matching.
        """
        # Use Gemini to extract pattern
        prompt = _PATTERN_EXTRACTION_PROMPT.format(
            title=alert_data.get("title", ""),
            threat_type=alert_data.get("threat_type", ""),
            severity=alert_data.get("severity", "medium"),
            camera=alert_data.get("source_camera", ""),
            zone=alert_data.get("zone_name", ""),
            description=alert_data.get("description", ""),
            resolution_notes=alert_data.get("resolution_notes", ""),
        )

        try:
            from backend.modules.gemini_client import gemini_client
            response = await gemini_client.generate(
                prompt=prompt,
                
                temperature=0.3,
                max_tokens=800,
            )

            if not response:
                return None

            parsed = self._parse_json(response)
            if not parsed:
                return None

            pattern_name = parsed.get("pattern_name", "unknown_pattern")

            # Check if pattern already exists (merge if so)
            existing = self._find_similar_pattern(pattern_name)
            if existing:
                existing.source_alert_ids.append(alert_id)
                if clip_embedding is not None:
                    existing.add_embedding(clip_embedding)
                logger.info("pattern.merged name=%s alerts=%d", pattern_name, len(existing.source_alert_ids))
                return existing

            # Create new pattern
            pattern = LearnedPattern(
                pattern_name=pattern_name,
                display_name=parsed.get("display_name", ""),
            )
            pattern.description = parsed.get("description", "")
            pattern.category = parsed.get("category", "unknown")
            pattern.severity = parsed.get("severity", "medium")
            pattern.indicators = parsed.get("indicators", [])
            pattern.typical_location = parsed.get("typical_location", "")
            pattern.typical_time = parsed.get("typical_time", "any")
            pattern.detection_tips = parsed.get("detection_tips", "")
            pattern.response_guidance = parsed.get("response_guidance", "")
            pattern.source_alert_ids.append(alert_id)

            if clip_embedding is not None:
                pattern.add_embedding(clip_embedding)

            self._patterns[pattern_name] = pattern

            # Store in Qdrant for vector similarity search
            await self._store_in_qdrant(pattern, clip_embedding)

            logger.info(
                "pattern.learned name=%s category=%s severity=%s",
                pattern_name, pattern.category, pattern.severity,
            )
            return pattern

        except Exception as e:
            logger.error("pattern.learn_failed alert=%s: %s", alert_id, e)
            return None

    async def match_against_library(
        self,
        clip_embedding: Optional[np.ndarray] = None,
        description: str = "",
        threshold: float = 0.80,
    ) -> List[Dict[str, Any]]:
        """Match a new detection against the learned pattern library.

        Returns matching patterns sorted by similarity.
        """
        matches = []

        # CLIP embedding matching
        if clip_embedding is not None:
            for name, pattern in self._patterns.items():
                sim = pattern.match_similarity(clip_embedding)
                if sim >= threshold:
                    pattern.match_count += 1
                    pattern.last_matched = datetime.now(timezone.utc).isoformat()
                    matches.append({
                        "pattern": pattern.to_dict(),
                        "similarity": round(sim, 3),
                        "match_type": "clip_embedding",
                    })

            # Also search Qdrant for stored patterns
            try:
                from backend.services.vector_store import vector_store
                results = await vector_store.search(
                    collection_name=self._qdrant_collection,
                    query_vector=clip_embedding.tolist(),
                    limit=5,
                )
                for r in (results or []):
                    if r.get("score", 0) >= threshold:
                        p_name = r.get("payload", {}).get("pattern_name", "")
                        if p_name and not any(m["pattern"]["pattern_name"] == p_name for m in matches):
                            matches.append({
                                "pattern": r.get("payload", {}),
                                "similarity": r["score"],
                                "match_type": "qdrant_vector",
                            })
            except Exception:
                pass  # Qdrant not available

        # Text-based matching
        if description:
            desc_lower = description.lower()
            for name, pattern in self._patterns.items():
                indicator_matches = sum(
                    1 for ind in pattern.indicators if ind.lower() in desc_lower
                )
                if indicator_matches >= 2:
                    matches.append({
                        "pattern": pattern.to_dict(),
                        "similarity": min(0.5 + indicator_matches * 0.1, 0.95),
                        "match_type": "indicator_text",
                    })

        matches.sort(key=lambda m: m["similarity"], reverse=True)
        return matches

    def _find_similar_pattern(self, pattern_name: str) -> Optional[LearnedPattern]:
        """Find an existing pattern with a similar name."""
        if pattern_name in self._patterns:
            return self._patterns[pattern_name]

        # Fuzzy match by checking word overlap
        name_words = set(pattern_name.lower().split("_"))
        for existing_name, pattern in self._patterns.items():
            existing_words = set(existing_name.lower().split("_"))
            overlap = len(name_words & existing_words) / max(len(name_words | existing_words), 1)
            if overlap > 0.6:
                return pattern

        return None

    async def _store_in_qdrant(self, pattern: LearnedPattern,
                                embedding: Optional[np.ndarray]) -> None:
        """Store pattern embedding in Qdrant for vector search."""
        if embedding is None:
            return
        try:
            from backend.services.vector_store import vector_store
            await vector_store.upsert(
                collection_name=self._qdrant_collection,
                points=[{
                    "id": pattern.pattern_id,
                    "vector": embedding.tolist(),
                    "payload": {
                        "pattern_name": pattern.pattern_name,
                        "display_name": pattern.display_name,
                        "category": pattern.category,
                        "severity": pattern.severity,
                        "description": pattern.description,
                        "indicators": pattern.indicators,
                    },
                }],
            )
        except Exception as e:
            logger.debug("pattern.qdrant_store_failed: %s", e)

    def get_all_patterns(self) -> List[Dict]:
        """Get all learned patterns."""
        return [p.to_dict() for p in sorted(
            self._patterns.values(),
            key=lambda p: p.match_count,
            reverse=True,
        )]

    def get_pattern(self, pattern_name: str) -> Optional[Dict]:
        p = self._patterns.get(pattern_name)
        return p.to_dict() if p else None

    def get_stats(self) -> Dict[str, Any]:
        total_matches = sum(p.match_count for p in self._patterns.values())
        categories = {}
        for p in self._patterns.values():
            categories[p.category] = categories.get(p.category, 0) + 1

        return {
            "total_patterns": len(self._patterns),
            "total_matches": total_matches,
            "categories": categories,
            "most_matched": max(
                self._patterns.values(), key=lambda p: p.match_count
            ).to_dict() if self._patterns else None,
        }

    def _parse_json(self, text: str) -> Optional[Dict]:
        text = text.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            text = "\n".join(lines)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    return json.loads(text[start:end])
                except json.JSONDecodeError:
                    pass
        return None


# ── Singleton ─────────────────────────────────────────────────────
pattern_library = PatternLibrary()
