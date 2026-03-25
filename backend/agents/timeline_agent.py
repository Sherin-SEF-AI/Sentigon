"""Timeline builder agent — constructs chronological event narratives."""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models import Event, Camera, Zone
from backend.services.gemini_forensics import gemini_forensics

logger = logging.getLogger(__name__)


class TimelineAgent:
    """Builds structured chronological timelines for a case.

    Gathers all events within a time window, groups them by camera
    and zone, then asks Gemini Pro to compose a coherent narrative.
    """

    async def build_timeline(
        self,
        case_id: str,
        start_time: datetime,
        end_time: datetime,
    ) -> Dict[str, Any]:
        """Build a timeline for a case between two timestamps.

        Parameters
        ----------
        case_id : str
            UUID of the parent case (used for context / labelling).
        start_time : datetime
            Inclusive lower bound of the time window.
        end_time : datetime
            Inclusive upper bound of the time window.

        Returns
        -------
        dict
            Structured timeline containing grouped events, raw entries,
            and an AI-generated narrative.
        """
        try:
            logger.info(
                "Building timeline for case=%s from %s to %s",
                case_id, start_time.isoformat(), end_time.isoformat(),
            )

            # ── 1. Fetch events in range ──────────────────────────
            events = await self._fetch_events(start_time, end_time)
            if not events:
                return {
                    "case_id": case_id,
                    "start_time": start_time.isoformat(),
                    "end_time": end_time.isoformat(),
                    "total_events": 0,
                    "groups": {},
                    "entries": [],
                    "narrative": "No events found in the specified time range.",
                }

            # ── 2. Resolve camera and zone names ──────────────────
            camera_map, zone_map = await self._resolve_names(events)

            # ── 3. Build entries and group by camera / zone ───────
            entries, groups = self._organise_events(
                events, camera_map, zone_map,
            )

            # ── 4. Generate narrative via Gemini ──────────────────
            narrative = await self._generate_narrative(
                entries, case_id, start_time, end_time,
            )

            return {
                "case_id": case_id,
                "start_time": start_time.isoformat(),
                "end_time": end_time.isoformat(),
                "total_events": len(entries),
                "groups": groups,
                "entries": entries,
                "narrative": narrative,
            }

        except Exception as exc:
            logger.exception("Timeline build failed for case %s", case_id)
            return {
                "case_id": case_id,
                "error": str(exc),
                "total_events": 0,
                "entries": [],
                "narrative": f"Timeline generation failed: {exc}",
            }

    # ------------------------------------------------------------------ #
    #  Internal helpers                                                   #
    # ------------------------------------------------------------------ #

    async def _fetch_events(
        self,
        start_time: datetime,
        end_time: datetime,
    ) -> List[Event]:
        """Query all events within the time window ordered chronologically."""
        async with async_session() as session:
            result = await session.execute(
                select(Event)
                .where(
                    and_(
                        Event.timestamp >= start_time,
                        Event.timestamp <= end_time,
                    )
                )
                .order_by(Event.timestamp.asc())
            )
            return list(result.scalars().all())

    async def _resolve_names(
        self,
        events: List[Event],
    ) -> tuple[Dict[str, str], Dict[str, str]]:
        """Bulk-resolve camera and zone UUIDs to human-readable names."""
        camera_ids = {e.camera_id for e in events if e.camera_id}
        zone_ids = {e.zone_id for e in events if e.zone_id}

        camera_map: Dict[str, str] = {}
        zone_map: Dict[str, str] = {}

        async with async_session() as session:
            if camera_ids:
                cam_result = await session.execute(
                    select(Camera).where(Camera.id.in_(camera_ids))
                )
                for cam in cam_result.scalars().all():
                    camera_map[str(cam.id)] = cam.name

            if zone_ids:
                z_result = await session.execute(
                    select(Zone).where(Zone.id.in_(zone_ids))
                )
                for z in z_result.scalars().all():
                    zone_map[str(z.id)] = z.name

        return camera_map, zone_map

    def _organise_events(
        self,
        events: List[Event],
        camera_map: Dict[str, str],
        zone_map: Dict[str, str],
    ) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """Convert ORM objects to dicts and group by camera + zone."""
        entries: List[Dict[str, Any]] = []
        by_camera: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        by_zone: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

        for ev in events:
            cam_name = camera_map.get(str(ev.camera_id), str(ev.camera_id))
            zone_name = (
                zone_map.get(str(ev.zone_id), str(ev.zone_id))
                if ev.zone_id
                else "unassigned"
            )

            entry = {
                "event_id": str(ev.id),
                "timestamp": (
                    ev.timestamp.isoformat() if ev.timestamp else ""
                ),
                "event_type": ev.event_type,
                "description": ev.description or "",
                "severity": ev.severity.value if ev.severity else "info",
                "confidence": ev.confidence,
                "camera_id": str(ev.camera_id),
                "camera_name": cam_name,
                "zone_name": zone_name,
                "detections": ev.detections,
            }
            entries.append(entry)
            by_camera[cam_name].append(entry)
            by_zone[zone_name].append(entry)

        groups = {
            "by_camera": {
                cam: {
                    "count": len(evts),
                    "event_types": list({e["event_type"] for e in evts}),
                    "severity_summary": self._severity_summary(evts),
                }
                for cam, evts in by_camera.items()
            },
            "by_zone": {
                zone: {
                    "count": len(evts),
                    "event_types": list({e["event_type"] for e in evts}),
                    "severity_summary": self._severity_summary(evts),
                }
                for zone, evts in by_zone.items()
            },
        }
        return entries, groups

    async def _generate_narrative(
        self,
        entries: List[Dict[str, Any]],
        case_id: str,
        start_time: datetime,
        end_time: datetime,
    ) -> str:
        """Ask Gemini Pro to build a human-readable narrative."""
        # Cap the payload to avoid token limits
        capped = entries[:30]
        event_summaries = [
            {
                "timestamp": e["timestamp"],
                "event_type": e["event_type"],
                "description": e["description"],
                "camera_name": e["camera_name"],
                "zone_name": e["zone_name"],
                "severity": e["severity"],
            }
            for e in capped
        ]

        try:
            result = await gemini_forensics.generate_incident_summary(
                event_summaries,
                query=(
                    f"Build a chronological narrative for case {case_id} "
                    f"covering {start_time.isoformat()} to "
                    f"{end_time.isoformat()}. "
                    "Focus on the sequence of events, movement between "
                    "cameras/zones, and any escalating patterns."
                ),
            )
            return result.get(
                "timeline_narrative",
                result.get("incident_summary", "Narrative unavailable."),
            )
        except Exception as exc:
            logger.warning("Gemini narrative generation failed: %s", exc)
            # Fall back to a simple textual list
            lines = []
            for e in capped:
                lines.append(
                    f"[{e['timestamp']}] {e['camera_name']} / "
                    f"{e['zone_name']}: {e['event_type']} — "
                    f"{e['description']}"
                )
            return "\n".join(lines) if lines else "No narrative available."

    # ------------------------------------------------------------------ #
    #  Utilities                                                          #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _severity_summary(
        entries: List[Dict[str, Any]],
    ) -> Dict[str, int]:
        counts: Dict[str, int] = defaultdict(int)
        for e in entries:
            counts[e.get("severity", "info")] += 1
        return dict(counts)


# Singleton
timeline_agent = TimelineAgent()
