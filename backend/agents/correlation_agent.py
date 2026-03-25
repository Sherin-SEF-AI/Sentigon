"""Cross-camera correlation agent — links events across cameras."""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models import Event, Camera
from backend.services.vector_store import vector_store

logger = logging.getLogger(__name__)


class CorrelationAgent:
    """Finds relationships between events captured by different cameras.

    Uses a combination of temporal proximity and vector-space similarity
    to discover subjects or activities that appear across multiple feeds.
    """

    async def correlate(
        self,
        event_ids: List[str],
        time_window_minutes: int = 10,
    ) -> Dict[str, Any]:
        """Correlate a set of events across cameras.

        Parameters
        ----------
        event_ids : list[str]
            UUIDs of seed events to correlate from.
        time_window_minutes : int
            How far before / after each seed event to search for
            temporally-adjacent events on other cameras.

        Returns
        -------
        dict
            A correlation map containing per-event matches, camera
            groupings, and an overall summary.
        """
        try:
            logger.info(
                "Correlating %d events (window=%d min)",
                len(event_ids), time_window_minutes,
            )

            # ── 1. Load seed events from DB ───────────────────────
            seed_events = await self._load_events(event_ids)
            if not seed_events:
                return self._empty_result(event_ids)

            # ── 2. Temporal neighbours on other cameras ───────────
            temporal_matches = await self._find_temporal_neighbours(
                seed_events, time_window_minutes,
            )

            # ── 3. Vector-similarity matches ──────────────────────
            vector_matches = self._find_vector_matches(seed_events)

            # ── 4. Merge and score ────────────────────────────────
            correlation_map = self._merge_matches(
                seed_events, temporal_matches, vector_matches,
            )

            # ── 5. Build summary ──────────────────────────────────
            summary = self._build_summary(correlation_map, seed_events)

            return {
                "seed_event_ids": event_ids,
                "time_window_minutes": time_window_minutes,
                "correlation_map": correlation_map,
                **summary,
            }

        except Exception as exc:
            logger.exception("Correlation failed")
            return {
                "seed_event_ids": event_ids,
                "error": str(exc),
                "correlation_map": {},
            }

    # ------------------------------------------------------------------ #
    #  Data loading                                                       #
    # ------------------------------------------------------------------ #

    async def _load_events(
        self,
        event_ids: List[str],
    ) -> List[Event]:
        """Fetch event rows by UUID list."""
        async with async_session() as session:
            uuids = []
            for eid in event_ids:
                try:
                    uuids.append(uuid.UUID(eid))
                except ValueError:
                    logger.warning("Skipping invalid UUID: %s", eid)

            if not uuids:
                return []

            result = await session.execute(
                select(Event).where(Event.id.in_(uuids))
            )
            return list(result.scalars().all())

    # ------------------------------------------------------------------ #
    #  Temporal search                                                    #
    # ------------------------------------------------------------------ #

    async def _find_temporal_neighbours(
        self,
        seed_events: List[Event],
        window_minutes: int,
    ) -> Dict[str, List[Dict[str, Any]]]:
        """For each seed, find events on *other* cameras within the window."""
        delta = timedelta(minutes=window_minutes)
        neighbours: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

        async with async_session() as session:
            for seed in seed_events:
                seed_ts = seed.timestamp
                if seed_ts is None:
                    continue
                if seed_ts.tzinfo is None:
                    seed_ts = seed_ts.replace(tzinfo=timezone.utc)

                result = await session.execute(
                    select(Event).where(
                        and_(
                            Event.camera_id != seed.camera_id,
                            Event.timestamp >= seed_ts - delta,
                            Event.timestamp <= seed_ts + delta,
                        )
                    ).order_by(Event.timestamp.asc())
                )
                for ev in result.scalars().all():
                    ev_ts = ev.timestamp
                    if ev_ts and ev_ts.tzinfo is None:
                        ev_ts = ev_ts.replace(tzinfo=timezone.utc)
                    neighbours[str(seed.id)].append({
                        "event_id": str(ev.id),
                        "camera_id": str(ev.camera_id),
                        "event_type": ev.event_type,
                        "description": ev.description or "",
                        "timestamp": ev_ts.isoformat() if ev_ts else "",
                        "severity": ev.severity.value if ev.severity else "info",
                        "confidence": ev.confidence,
                        "match_type": "temporal",
                    })

        return dict(neighbours)

    # ------------------------------------------------------------------ #
    #  Vector similarity search                                           #
    # ------------------------------------------------------------------ #

    def _find_vector_matches(
        self,
        seed_events: List[Event],
    ) -> Dict[str, List[Dict[str, Any]]]:
        """For each seed, find semantically similar events from Qdrant."""
        matches: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

        for seed in seed_events:
            eid = str(seed.id)
            try:
                similar = vector_store.search_similar_events(eid, top_k=8)
                for sim in similar:
                    sim_cam = sim.get("metadata", {}).get("camera_id", "")
                    # Only keep cross-camera matches
                    if sim_cam and sim_cam != str(seed.camera_id):
                        matches[eid].append({
                            "event_id": sim.get("event_id", ""),
                            "camera_id": sim_cam,
                            "description": sim.get("description", ""),
                            "similarity_score": sim.get("score", 0.0),
                            "match_type": "vector",
                        })
            except Exception as exc:
                logger.debug(
                    "Vector similarity lookup skipped for %s: %s", eid, exc,
                )

        return dict(matches)

    # ------------------------------------------------------------------ #
    #  Merge & score                                                      #
    # ------------------------------------------------------------------ #

    def _merge_matches(
        self,
        seed_events: List[Event],
        temporal: Dict[str, List[Dict[str, Any]]],
        vector: Dict[str, List[Dict[str, Any]]],
    ) -> Dict[str, Dict[str, Any]]:
        """Combine temporal and vector matches, boosting dual-match items."""
        correlation_map: Dict[str, Dict[str, Any]] = {}

        for seed in seed_events:
            sid = str(seed.id)
            all_matches: Dict[str, Dict[str, Any]] = {}

            for m in temporal.get(sid, []):
                mid = m["event_id"]
                all_matches[mid] = {
                    **m,
                    "combined_score": 0.5,  # base for temporal
                }

            for m in vector.get(sid, []):
                mid = m["event_id"]
                if mid in all_matches:
                    # Dual match — boost
                    existing = all_matches[mid]
                    existing["match_type"] = "temporal+vector"
                    existing["similarity_score"] = m.get(
                        "similarity_score", 0,
                    )
                    existing["combined_score"] = min(
                        existing["combined_score"]
                        + m.get("similarity_score", 0) * 0.5,
                        1.0,
                    )
                else:
                    all_matches[mid] = {
                        **m,
                        "combined_score": m.get("similarity_score", 0) * 0.7,
                    }

            # Sort by combined score descending
            sorted_matches = sorted(
                all_matches.values(),
                key=lambda x: x.get("combined_score", 0),
                reverse=True,
            )

            seed_ts = seed.timestamp
            if seed_ts and seed_ts.tzinfo is None:
                seed_ts = seed_ts.replace(tzinfo=timezone.utc)

            correlation_map[sid] = {
                "seed_camera_id": str(seed.camera_id),
                "seed_event_type": seed.event_type,
                "seed_timestamp": seed_ts.isoformat() if seed_ts else "",
                "matches": sorted_matches,
                "match_count": len(sorted_matches),
            }

        return correlation_map

    # ------------------------------------------------------------------ #
    #  Summary                                                            #
    # ------------------------------------------------------------------ #

    def _build_summary(
        self,
        correlation_map: Dict[str, Dict[str, Any]],
        seed_events: List[Event],
    ) -> Dict[str, Any]:
        """Produce high-level statistics from the correlation map."""
        all_cameras: set = set()
        total_matches = 0
        dual_matches = 0

        for sid, data in correlation_map.items():
            all_cameras.add(data.get("seed_camera_id", ""))
            for m in data.get("matches", []):
                total_matches += 1
                all_cameras.add(m.get("camera_id", ""))
                if m.get("match_type") == "temporal+vector":
                    dual_matches += 1

        all_cameras.discard("")

        return {
            "cameras_involved": sorted(all_cameras),
            "total_correlated_events": total_matches,
            "dual_method_matches": dual_matches,
            "summary": (
                f"Correlated {len(seed_events)} seed events across "
                f"{len(all_cameras)} cameras with {total_matches} matches "
                f"({dual_matches} confirmed by both temporal and vector "
                f"similarity)."
            ),
        }

    # ------------------------------------------------------------------ #

    @staticmethod
    def _empty_result(event_ids: List[str]) -> Dict[str, Any]:
        return {
            "seed_event_ids": event_ids,
            "correlation_map": {},
            "cameras_involved": [],
            "total_correlated_events": 0,
            "dual_method_matches": 0,
            "summary": "No seed events found in database.",
        }


# Singleton
correlation_agent = CorrelationAgent()
