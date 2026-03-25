"""Natural Language Evidence Timeline Builder.

"Build me a timeline of everything involving the blue sedan from 2pm-5pm
yesterday" → produces a court-ready evidence package with frames,
timestamps, narrative, and chain-of-custody metadata.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from backend.config import settings
from backend.database import async_session
from backend.models import Alert, Event

logger = logging.getLogger(__name__)

_TIMELINE_PROMPT = """\
You are a forensic evidence analyst. Build a chronological evidence timeline
from the following search results.

**Natural Language Query:** "{query}"

**CLIP Visual Search Results (vector similarity):**
{clip_results}

**Database Events (matching cameras/timeframe):**
{db_events}

**Alert Records:**
{alert_records}

Build a structured evidence timeline. Respond with JSON:
{{
  "timeline": [
    {{
      "timestamp": "ISO timestamp",
      "camera_id": "camera identifier",
      "camera_name": "human-readable name",
      "description": "what happened at this point",
      "evidence_type": "clip_match|event|alert|access_log",
      "confidence": 0.0-1.0,
      "frame_url": "URL if available",
      "metadata": {{}}
    }}
  ],
  "narrative": "2-4 paragraph narrative summary of the complete timeline",
  "subjects": [
    {{
      "description": "subject description",
      "first_seen": "ISO timestamp",
      "last_seen": "ISO timestamp",
      "cameras_appeared": ["camera IDs"]
    }}
  ],
  "key_findings": ["most important findings"],
  "gaps": ["time periods or areas with no evidence"],
  "evidence_quality": "strong|moderate|weak",
  "total_evidence_items": 0
}}
"""

_CHAIN_OF_CUSTODY_FIELDS = [
    "evidence_id", "collected_by", "collection_timestamp",
    "hash_sha256", "source_system", "access_log",
]


class EvidenceItem:
    """Represents a single piece of evidence with chain-of-custody."""

    def __init__(self, evidence_type: str, data: Dict[str, Any],
                 source: str = "sentinel_ai") -> None:
        self.evidence_id = str(uuid.uuid4())
        self.evidence_type = evidence_type
        self.data = data
        self.source = source
        self.collected_at = datetime.now(timezone.utc).isoformat()
        self.hash = self._compute_hash()
        self.access_log: List[Dict] = [{
            "action": "collected",
            "timestamp": self.collected_at,
            "actor": "sentinel_ai_system",
        }]

    def _compute_hash(self) -> str:
        """Compute SHA-256 hash of the evidence data."""
        content = json.dumps(self.data, sort_keys=True, default=str)
        return hashlib.sha256(content.encode()).hexdigest()

    def record_access(self, actor: str, action: str = "viewed") -> None:
        self.access_log.append({
            "action": action,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "actor": actor,
        })

    def to_dict(self) -> Dict[str, Any]:
        return {
            "evidence_id": self.evidence_id,
            "evidence_type": self.evidence_type,
            "data": self.data,
            "source": self.source,
            "collected_at": self.collected_at,
            "hash_sha256": self.hash,
            "integrity_verified": self.hash == self._compute_hash(),
            "access_log": self.access_log,
        }


class EvidenceTimeline:
    """Represents a complete evidence timeline package."""

    def __init__(self, query: str) -> None:
        self.timeline_id = str(uuid.uuid4())
        self.query = query
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.items: List[EvidenceItem] = []
        self.timeline: List[Dict] = []
        self.narrative: str = ""
        self.subjects: List[Dict] = []
        self.key_findings: List[str] = []
        self.gaps: List[str] = []
        self.evidence_quality: str = "unknown"

    def add_item(self, evidence_type: str, data: Dict) -> EvidenceItem:
        item = EvidenceItem(evidence_type, data)
        self.items.append(item)
        return item

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timeline_id": self.timeline_id,
            "query": self.query,
            "created_at": self.created_at,
            "timeline": self.timeline,
            "narrative": self.narrative,
            "subjects": self.subjects,
            "key_findings": self.key_findings,
            "gaps": self.gaps,
            "evidence_quality": self.evidence_quality,
            "evidence_items": [item.to_dict() for item in self.items],
            "total_items": len(self.items),
            "chain_of_custody": {
                "timeline_id": self.timeline_id,
                "created_at": self.created_at,
                "created_by": "sentinel_ai_system",
                "item_count": len(self.items),
                "hashes": [item.hash for item in self.items],
            },
        }


class EvidenceTimelineBuilder:
    """Builds evidence timelines from natural language queries.

    Combines CLIP visual search, database event queries, and Gemini
    narrative synthesis to produce court-ready evidence packages.
    """

    def __init__(self) -> None:
        self._timeline_history: List[Dict] = []

    async def build_timeline(
        self,
        query: str,
        time_start: Optional[datetime] = None,
        time_end: Optional[datetime] = None,
        camera_ids: Optional[List[str]] = None,
        max_results: int = 50,
    ) -> EvidenceTimeline:
        """Build a complete evidence timeline from a natural language query.

        Steps:
        1. Search Qdrant with CLIP for visual matches
        2. Query database events in the time window
        3. Find related alerts
        4. Use Gemini to assemble narrative timeline
        5. Package with chain-of-custody metadata
        """
        timeline = EvidenceTimeline(query=query)

        if time_start is None:
            time_start = datetime.now(timezone.utc) - timedelta(hours=24)
        if time_end is None:
            time_end = datetime.now(timezone.utc)

        # Step 1: CLIP visual search
        clip_results = await self._search_clip(query, time_start, time_end, max_results)
        for result in clip_results:
            timeline.add_item("clip_match", result)

        # Step 2: Database events
        db_events = await self._search_events(time_start, time_end, camera_ids)
        for event in db_events:
            timeline.add_item("event", event)

        # Step 3: Related alerts
        alert_records = await self._search_alerts(query, time_start, time_end)
        for alert in alert_records:
            timeline.add_item("alert", alert)

        # Step 4: Gemini narrative synthesis
        prompt = _TIMELINE_PROMPT.format(
            query=query,
            clip_results=json.dumps(clip_results[:20], indent=2, default=str),
            db_events=json.dumps(db_events[:20], indent=2, default=str),
            alert_records=json.dumps(alert_records[:20], indent=2, default=str),
        )

        try:
            from backend.modules.gemini_client import gemini_client
            response = await gemini_client.generate(
                prompt=prompt,
                
                temperature=0.3,
                max_tokens=2000,
            )

            if response:
                parsed = self._parse_json(response)
                if parsed:
                    timeline.timeline = parsed.get("timeline", [])
                    timeline.narrative = parsed.get("narrative", "")
                    timeline.subjects = parsed.get("subjects", [])
                    timeline.key_findings = parsed.get("key_findings", [])
                    timeline.gaps = parsed.get("gaps", [])
                    timeline.evidence_quality = parsed.get("evidence_quality", "moderate")

        except Exception as e:
            logger.error("timeline.synthesis_failed: %s", e)
            timeline.narrative = (
                f"Evidence collection completed for query: '{query}'. "
                f"Found {len(clip_results)} visual matches, {len(db_events)} events, "
                f"{len(alert_records)} related alerts."
            )

        # Store in history
        self._timeline_history.append({
            "timeline_id": timeline.timeline_id,
            "query": query,
            "created_at": timeline.created_at,
            "item_count": len(timeline.items),
        })

        logger.info(
            "timeline.built query='%s' items=%d clips=%d events=%d alerts=%d",
            query, len(timeline.items), len(clip_results),
            len(db_events), len(alert_records),
        )
        return timeline

    async def _search_clip(
        self, query: str, start: datetime, end: datetime, limit: int
    ) -> List[Dict]:
        """Search Qdrant CLIP collection for visual matches."""
        try:
            from backend.services.clip_embedder import clip_embedder
            from backend.services.vector_store import vector_store

            # Get text embedding
            embedding = clip_embedder.encode_text(query)
            if embedding is None:
                return []

            # Search Qdrant
            results = await vector_store.search(
                collection_name="detections",
                query_vector=embedding.tolist(),
                limit=limit,
            )

            return [
                {
                    "score": r.get("score", 0),
                    "camera_id": r.get("payload", {}).get("camera_id", ""),
                    "timestamp": r.get("payload", {}).get("timestamp", ""),
                    "description": r.get("payload", {}).get("description", ""),
                    "frame_url": r.get("payload", {}).get("frame_url", ""),
                }
                for r in (results or [])
            ]
        except Exception as e:
            logger.debug("timeline.clip_search_failed: %s", e)
            return []

    async def _search_events(
        self, start: datetime, end: datetime,
        camera_ids: Optional[List[str]] = None,
    ) -> List[Dict]:
        """Search database events in the time window."""
        try:
            from sqlalchemy import select, and_
            async with async_session() as session:
                conditions = [
                    Event.timestamp >= start,
                    Event.timestamp <= end,
                ]
                if camera_ids:
                    conditions.append(Event.camera_id.in_(camera_ids))

                stmt = select(Event).where(and_(*conditions)).order_by(
                    Event.timestamp
                ).limit(50)

                result = await session.execute(stmt)
                events = result.scalars().all()

                return [
                    {
                        "event_id": str(e.id),
                        "camera_id": str(e.camera_id),
                        "timestamp": str(e.timestamp),
                        "detections": e.detections or {},
                        "gemini_summary": (e.gemini_analysis or {}).get("scene_description", ""),
                    }
                    for e in events
                ]
        except Exception as e:
            logger.debug("timeline.event_search_failed: %s", e)
            return []

    async def _search_alerts(
        self, query: str, start: datetime, end: datetime
    ) -> List[Dict]:
        """Search alerts related to the query."""
        try:
            from sqlalchemy import select, and_, or_
            async with async_session() as session:
                stmt = select(Alert).where(
                    and_(
                        Alert.created_at >= start,
                        Alert.created_at <= end,
                    )
                ).order_by(Alert.created_at).limit(30)

                result = await session.execute(stmt)
                alerts = result.scalars().all()

                return [
                    {
                        "alert_id": str(a.id),
                        "title": a.title,
                        "severity": a.severity.value if hasattr(a.severity, "value") else str(a.severity),
                        "threat_type": a.threat_type,
                        "camera": a.source_camera,
                        "timestamp": str(a.created_at),
                        "status": a.status.value if hasattr(a.status, "value") else str(a.status),
                    }
                    for a in alerts
                ]
        except Exception as e:
            logger.debug("timeline.alert_search_failed: %s", e)
            return []

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

    def get_history(self, limit: int = 20) -> List[Dict]:
        return self._timeline_history[-limit:]


# ── Singleton ─────────────────────────────────────────────────────
evidence_timeline_builder = EvidenceTimelineBuilder()
