"""Cross-camera event correlation — subject tracking, movement trails, temporal grouping."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select, and_, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import async_session
from backend.models import Alert, Camera, Event
from backend.models.models import AlertSeverity

logger = logging.getLogger(__name__)


class EventCorrelator:
    """Cross-camera event correlation engine.

    Combines temporal proximity queries, vector-store semantic similarity
    searches, and Gemini Pro forensic analysis to correlate events across
    multiple cameras and build subject movement trails.
    """

    def __init__(self) -> None:
        self._correlation_cache: Dict[str, Dict[str, Any]] = {}

    # ── Temporal event correlation ───────────────────────────

    async def correlate_events(
        self,
        time_window: int = 300,
        min_cameras: int = 2,
        severity_filter: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Find clusters of events that occurred within *time_window*
        seconds of each other across multiple cameras.

        Parameters
        ----------
        time_window : int
            Maximum gap (seconds) between events in a cluster.
        min_cameras : int
            Minimum number of distinct cameras required for a cluster.
        severity_filter : str, optional
            If given, only consider events at or above this severity.

        Returns
        -------
        A list of correlation groups, each containing the events and
        an optional AI-generated correlation analysis.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=time_window * 3)

        try:
            async with async_session() as session:
                stmt = (
                    select(Event)
                    .where(Event.timestamp >= cutoff)
                    .order_by(Event.timestamp)
                )

                if severity_filter:
                    try:
                        sev = AlertSeverity(severity_filter)
                        severity_rank = _severity_rank(sev.value)
                        # Include events at or above the given severity
                        matching_sevs = [
                            s for s in AlertSeverity
                            if _severity_rank(s.value) >= severity_rank
                        ]
                        stmt = stmt.where(Event.severity.in_(matching_sevs))
                    except ValueError:
                        pass

                result = await session.execute(stmt)
                events = result.scalars().all()

            if not events:
                return []

            # Group events into temporal clusters
            clusters = self._build_temporal_clusters(events, time_window)

            # Filter clusters by distinct camera count
            correlation_groups: List[Dict[str, Any]] = []
            for cluster in clusters:
                camera_ids = {str(e.camera_id) for e in cluster}
                if len(camera_ids) >= min_cameras:
                    group = self._cluster_to_dict(cluster)
                    correlation_groups.append(group)

            # Optionally enrich with AI correlation
            if correlation_groups:
                correlation_groups = await self._enrich_with_ai(correlation_groups)

            logger.info(
                "Event correlation found %d group(s) in %d events",
                len(correlation_groups),
                len(events),
            )
            return correlation_groups

        except Exception as exc:
            logger.error("correlate_events failed: %s", exc)
            return []

    # ── Subject search across cameras ────────────────────────

    async def find_subject_across_cameras(
        self,
        description: str,
        top_k: int = 20,
        time_range_hours: int = 24,
    ) -> List[Dict[str, Any]]:
        """Use the vector store to find events matching a subject description
        and group them by camera.

        Parameters
        ----------
        description : str
            Natural-language description of the subject (e.g. "man in red
            jacket carrying backpack").
        top_k : int
            Maximum number of vector-search results.
        time_range_hours : int
            How far back to search.

        Returns
        -------
        A list of appearance records, grouped by camera, with similarity
        scores.
        """
        from backend.services.vector_store import vector_store

        try:
            search_results = vector_store.search(
                query=description,
                top_k=top_k,
            )

            if not search_results:
                logger.info("No vector matches for subject: %s", description[:80])
                return []

            # Filter by time range
            cutoff = datetime.now(timezone.utc) - timedelta(hours=time_range_hours)
            filtered: List[Dict[str, Any]] = []

            for hit in search_results:
                ts_str = hit.get("timestamp", "")
                if ts_str:
                    try:
                        ts = datetime.fromisoformat(ts_str)
                        if ts.tzinfo is None:
                            ts = ts.replace(tzinfo=timezone.utc)
                        if ts < cutoff:
                            continue
                    except (ValueError, TypeError):
                        pass

                filtered.append(hit)

            # Group by camera
            by_camera: Dict[str, List[Dict[str, Any]]] = {}
            for hit in filtered:
                cam_id = hit.get("camera_id", "unknown")
                by_camera.setdefault(cam_id, []).append(hit)

            appearances = []
            for cam_id, hits in by_camera.items():
                appearances.append({
                    "camera_id": cam_id,
                    "match_count": len(hits),
                    "best_score": max(h.get("score", 0.0) for h in hits),
                    "events": sorted(hits, key=lambda h: h.get("score", 0.0), reverse=True),
                })

            appearances.sort(key=lambda a: a["best_score"], reverse=True)

            # Optional: Gemini forensic cross-reference
            if len(appearances) >= 2:
                appearances = await self._forensic_cross_reference(
                    description, appearances
                )

            logger.info(
                "Subject search '%s' found %d appearance(s) across %d camera(s)",
                description[:60],
                sum(a["match_count"] for a in appearances),
                len(appearances),
            )
            return appearances

        except Exception as exc:
            logger.error("find_subject_across_cameras failed: %s", exc)
            return []

    # ── Movement trail ───────────────────────────────────────

    async def build_movement_trail(
        self,
        subject_description: str,
        time_range: Optional[Tuple[datetime, datetime]] = None,
        top_k: int = 30,
    ) -> Dict[str, Any]:
        """Reconstruct the movement trail of a subject across cameras.

        Combines vector search with temporal ordering to produce a
        chronological path of appearances.

        Parameters
        ----------
        subject_description : str
            Natural-language description of the subject.
        time_range : tuple of datetime, optional
            ``(start, end)`` window.  Defaults to last 24 hours.
        top_k : int
            Maximum vector-search results.

        Returns
        -------
        A dict containing the ordered trail, a Gemini-generated narrative,
        and summary statistics.
        """
        from backend.services.vector_store import vector_store

        if time_range is None:
            end_time = datetime.now(timezone.utc)
            start_time = end_time - timedelta(hours=24)
        else:
            start_time, end_time = time_range

        try:
            search_results = vector_store.search(
                query=subject_description,
                top_k=top_k,
            )

            if not search_results:
                return {
                    "subject": subject_description,
                    "trail": [],
                    "summary": {"total_appearances": 0, "cameras_visited": 0},
                }

            # Filter by time range and sort chronologically
            trail_points: List[Dict[str, Any]] = []
            for hit in search_results:
                ts_str = hit.get("timestamp", "")
                ts: Optional[datetime] = None
                if ts_str:
                    try:
                        ts = datetime.fromisoformat(ts_str)
                        if ts.tzinfo is None:
                            ts = ts.replace(tzinfo=timezone.utc)
                        if ts < start_time or ts > end_time:
                            continue
                    except (ValueError, TypeError):
                        pass

                trail_points.append({
                    "event_id": hit.get("event_id", ""),
                    "camera_id": hit.get("camera_id", "unknown"),
                    "timestamp": ts_str,
                    "parsed_time": ts,
                    "description": hit.get("description", ""),
                    "score": hit.get("score", 0.0),
                    "event_type": hit.get("event_type", ""),
                    "metadata": hit.get("metadata", {}),
                })

            # Sort by timestamp
            trail_points.sort(
                key=lambda p: p["parsed_time"] or datetime.min.replace(tzinfo=timezone.utc)
            )

            # Identify cameras visited in order
            camera_sequence: List[str] = []
            for point in trail_points:
                cam = point["camera_id"]
                if not camera_sequence or camera_sequence[-1] != cam:
                    camera_sequence.append(cam)

            # Remove parsed_time (not serialisable) from output
            for point in trail_points:
                point.pop("parsed_time", None)

            # Generate narrative via Gemini
            narrative = await self._generate_trail_narrative(
                subject_description, trail_points
            )

            cameras_visited = list(dict.fromkeys(camera_sequence))

            result = {
                "subject": subject_description,
                "trail": trail_points,
                "camera_sequence": cameras_visited,
                "narrative": narrative,
                "summary": {
                    "total_appearances": len(trail_points),
                    "cameras_visited": len(set(cameras_visited)),
                    "time_span": {
                        "start": trail_points[0]["timestamp"] if trail_points else None,
                        "end": trail_points[-1]["timestamp"] if trail_points else None,
                    },
                },
            }

            logger.info(
                "Movement trail built for '%s': %d points, %d cameras",
                subject_description[:60],
                len(trail_points),
                len(cameras_visited),
            )
            return result

        except Exception as exc:
            logger.error("build_movement_trail failed: %s", exc)
            return {
                "subject": subject_description,
                "trail": [],
                "error": str(exc),
                "summary": {"total_appearances": 0, "cameras_visited": 0},
            }

    # ── Private helpers ──────────────────────────────────────

    @staticmethod
    def _build_temporal_clusters(
        events: list,
        window_seconds: int,
    ) -> List[list]:
        """Group a chronologically-sorted list of events into clusters
        where consecutive events are at most *window_seconds* apart."""
        if not events:
            return []

        clusters: List[list] = [[events[0]]]

        for event in events[1:]:
            prev = clusters[-1][-1]
            prev_ts = prev.timestamp
            curr_ts = event.timestamp

            # Normalise tz
            if prev_ts.tzinfo is None:
                prev_ts = prev_ts.replace(tzinfo=timezone.utc)
            if curr_ts.tzinfo is None:
                curr_ts = curr_ts.replace(tzinfo=timezone.utc)

            if (curr_ts - prev_ts).total_seconds() <= window_seconds:
                clusters[-1].append(event)
            else:
                clusters.append([event])

        return clusters

    @staticmethod
    def _cluster_to_dict(cluster: list) -> Dict[str, Any]:
        """Serialise an event cluster into a JSON-friendly dict."""
        camera_ids = list({str(e.camera_id) for e in cluster})
        timestamps = [
            e.timestamp.isoformat() if e.timestamp else None for e in cluster
        ]

        return {
            "event_count": len(cluster),
            "camera_count": len(camera_ids),
            "camera_ids": camera_ids,
            "time_range": {
                "start": timestamps[0] if timestamps else None,
                "end": timestamps[-1] if timestamps else None,
            },
            "events": [
                {
                    "id": str(e.id),
                    "camera_id": str(e.camera_id),
                    "event_type": e.event_type,
                    "severity": e.severity.value if e.severity else "info",
                    "description": e.description,
                    "confidence": e.confidence,
                    "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                }
                for e in cluster
            ],
        }

    async def _enrich_with_ai(
        self,
        groups: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Optionally run AI forensic correlation on multi-camera groups."""
        from backend.services.gemini_forensics import gemini_forensics

        for group in groups:
            if group.get("camera_count", 0) < 2:
                continue

            try:
                events_for_ai = group.get("events", [])
                summary = await gemini_forensics.generate_incident_summary(
                    events=events_for_ai,
                    query="Correlate these events across cameras. Identify shared subjects and movement patterns.",
                )
                group["ai_correlation"] = summary
            except Exception as exc:
                logger.warning("AI enrichment failed for group: %s", exc)
                group["ai_correlation"] = {"error": str(exc)}

        return groups

    async def _forensic_cross_reference(
        self,
        description: str,
        appearances: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Use AI to cross-reference appearances across cameras."""
        from backend.services.gemini_forensics import gemini_forensics

        try:
            # Build a summary of appearances for AI analysis
            events_flat: List[Dict[str, Any]] = []
            for app in appearances:
                for ev in app.get("events", [])[:3]:  # Top 3 per camera
                    events_flat.append({
                        "camera_id": app["camera_id"],
                        "description": ev.get("description", ""),
                        "timestamp": ev.get("timestamp", ""),
                        "score": ev.get("score", 0.0),
                    })

            analysis = await gemini_forensics.generate_incident_summary(
                events=events_flat,
                query=f"Cross-reference appearances of subject: {description}",
            )

            # Attach the analysis to the first entry as an overall summary
            if appearances:
                appearances[0]["cross_camera_analysis"] = analysis

        except Exception as exc:
            logger.warning("Forensic cross-reference failed: %s", exc)

        return appearances

    async def _generate_trail_narrative(
        self,
        subject_description: str,
        trail_points: List[Dict[str, Any]],
    ) -> Optional[str]:
        """Ask Gemini to produce a natural-language narrative of the
        subject's movement trail."""
        from backend.services.gemini_forensics import gemini_forensics

        if not trail_points:
            return None

        try:
            summary = await gemini_forensics.generate_incident_summary(
                events=[
                    {
                        "camera_id": p.get("camera_id"),
                        "timestamp": p.get("timestamp"),
                        "description": p.get("description"),
                        "event_type": p.get("event_type"),
                    }
                    for p in trail_points
                ],
                query=(
                    f"Build a chronological movement narrative for subject: "
                    f"{subject_description}"
                ),
            )
            return summary.get("incident_summary") or summary.get("timeline_narrative")
        except Exception as exc:
            logger.warning("Trail narrative generation failed: %s", exc)
            return None


# ── Utility ─────────────────────────────────────────────────

def _severity_rank(severity: str) -> int:
    """Map a severity string to a numeric rank for comparison."""
    ranks = {"critical": 5, "high": 4, "medium": 3, "low": 2, "info": 1}
    return ranks.get(severity, 0)


# Singleton
event_correlator = EventCorrelator()
