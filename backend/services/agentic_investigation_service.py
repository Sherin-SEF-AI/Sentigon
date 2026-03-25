"""Agentic Investigation Service — natural-language-driven cross-sensor
investigation, timeline assembly, subject following, and evidence packaging.

Phase 3C: Agentic Security Operations.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select, func, and_, or_, cast, String
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.models import Camera, Zone, Event, Alert, Recording, AuditLog
from backend.models.phase2_models import AccessEvent
from backend.models.phase2b_models import Visitor, VisitorStatus
from backend.models.phase3_models import (
    InvestigationSession,
    EvidencePackage,
    EntityTrack,
    EntityAppearance,
)

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Time-expression helpers
# ---------------------------------------------------------------------------

_RELATIVE_TIME_RE = re.compile(
    r"(?:last|past)\s+(\d+)\s*(minute|min|hour|hr|day|week)s?",
    re.IGNORECASE,
)

_ABSOLUTE_TIME_RE = re.compile(
    r"(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)?",
    re.IGNORECASE,
)

_UNIT_MAP = {
    "minute": "minutes", "min": "minutes",
    "hour": "hours", "hr": "hours",
    "day": "days", "week": "weeks",
}


def _parse_relative_time(text: str) -> Optional[tuple[datetime, datetime]]:
    """Return (start, end) from phrases like 'last 2 hours'."""
    m = _RELATIVE_TIME_RE.search(text)
    if not m:
        return None
    n = int(m.group(1))
    unit = _UNIT_MAP.get(m.group(2).lower(), "hours")
    now = datetime.now(timezone.utc)
    return now - timedelta(**{unit: n}), now


def _parse_absolute_times(text: str) -> Optional[tuple[datetime, datetime]]:
    """Best-effort extraction of clock times ('after 10pm', 'between 8am and 6pm')."""
    matches = _ABSOLUTE_TIME_RE.findall(text)
    if not matches:
        return None
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    parsed: list[datetime] = []
    for h, m, ampm in matches:
        hour = int(h)
        minute = int(m)
        if ampm.lower() == "pm" and hour != 12:
            hour += 12
        elif ampm.lower() == "am" and hour == 12:
            hour = 0
        parsed.append(today.replace(hour=hour, minute=minute))
    if len(parsed) == 1:
        return parsed[0], parsed[0] + timedelta(hours=12)
    return min(parsed), max(parsed)


# ---------------------------------------------------------------------------
# Keyword-based fallback parser
# ---------------------------------------------------------------------------

_ACTION_KEYWORDS = {
    "enter": "entering", "entering": "entering", "entered": "entering",
    "exit": "leaving", "leaving": "leaving", "left": "leaving",
    "loiter": "loitering", "loitering": "loitering",
    "running": "running", "run": "running",
    "tailgat": "tailgating",
    "forced": "forced_entry", "force": "forced_entry",
}

_OBJECT_KEYWORDS = [
    "person", "people", "vehicle", "car", "truck", "van", "backpack",
    "bag", "knife", "weapon", "firearm", "gun", "package", "box",
]


def _keyword_fallback(text: str) -> dict:
    """Extract structured params from query via keyword matching."""
    lower = text.lower()
    params: dict[str, Any] = {}

    # Time range
    tr = _parse_relative_time(lower)
    if tr:
        params["time_start"] = tr[0].isoformat()
        params["time_end"] = tr[1].isoformat()
    else:
        tr2 = _parse_absolute_times(lower)
        if tr2:
            params["time_start"] = tr2[0].isoformat()
            params["time_end"] = tr2[1].isoformat()

    # Actions
    actions = [v for k, v in _ACTION_KEYWORDS.items() if k in lower]
    if actions:
        params["actions"] = list(set(actions))

    # Object types
    objects = [o for o in _OBJECT_KEYWORDS if o in lower]
    if objects:
        params["object_types"] = objects

    # Zone names — anything after 'in', 'at', 'near'
    zone_match = re.search(r"(?:in|at|near|around)\s+([A-Z][A-Za-z0-9 ]+)", text)
    if zone_match:
        params["zone_names"] = [zone_match.group(1).strip()]

    # Subject description — anything after 'wearing', 'with'
    desc_match = re.search(r"(?:wearing|with|carrying)\s+(.+?)(?:\.|,|$)", lower)
    if desc_match:
        params["subject_description"] = desc_match.group(1).strip()

    return params


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class AgenticInvestigationService:
    """Operators ask natural-language questions — the system searches across
    cameras, PACS, visitors, and vector embeddings to assemble an
    evidence-backed timeline with an AI narrative."""

    # ── Query parsing ─────────────────────────────────────────

    async def parse_query(self, query_text: str) -> dict:
        """Parse a natural-language investigation query into structured
        parameters.  Uses the AI text service when available, falling back
        to keyword extraction."""
        try:
            from backend.services.ai_text_service import ai_generate_text

            prompt = (
                "You are a physical security investigation assistant. "
                "Parse the following investigation query into structured JSON. "
                "Return ONLY valid JSON with these fields (omit any that don't apply):\n"
                "  time_start: ISO datetime string\n"
                "  time_end: ISO datetime string\n"
                "  zone_names: list of location/zone names mentioned\n"
                "  subject_description: physical description of person of interest\n"
                "  actions: list of actions (entering, leaving, loitering, running, tailgating, forced_entry)\n"
                "  object_types: list of object types (person, vehicle, backpack, weapon, etc.)\n"
                f"\nQuery: \"{query_text}\"\n\nJSON:"
            )
            raw = await ai_generate_text(prompt, temperature=0.1, max_tokens=512)
            if raw:
                # Strip markdown fences if present
                cleaned = re.sub(r"```(?:json)?", "", raw).strip().rstrip("`")
                parsed = json.loads(cleaned)
                if isinstance(parsed, dict):
                    logger.info("ai_query_parse_success", fields=list(parsed.keys()))
                    return parsed
        except Exception as exc:
            logger.warning("ai_query_parse_failed", error=str(exc))

        # Keyword fallback
        params = _keyword_fallback(query_text)
        logger.info("keyword_fallback_parse", params=params)
        return params

    # ── Main investigation ────────────────────────────────────

    async def start_investigation(
        self,
        db: AsyncSession,
        query_text: str,
        initiated_by: Optional[str] = None,
        incident_id: Optional[str] = None,
    ) -> dict:
        """Parse the NL query, search cameras/PACS/visitors, assemble a
        chronological timeline, generate an AI narrative, and persist
        an InvestigationSession."""
        t0 = time.monotonic()
        steps: list[dict] = []

        # Step 1 — parse query
        parsed = await self.parse_query(query_text)
        steps.append({"step": "parse_query", "status": "complete", "detail": parsed,
                       "timestamp": datetime.now(timezone.utc).isoformat()})

        time_start = None
        time_end = None
        if parsed.get("time_start"):
            try:
                time_start = datetime.fromisoformat(parsed["time_start"])
            except (ValueError, TypeError):
                pass
        if parsed.get("time_end"):
            try:
                time_end = datetime.fromisoformat(parsed["time_end"])
            except (ValueError, TypeError):
                pass
        if time_start is None:
            time_start = datetime.now(timezone.utc) - timedelta(hours=24)
        if time_end is None:
            time_end = datetime.now(timezone.utc)

        timeline: list[dict] = []
        subjects_found: list[dict] = []
        cameras_searched: list[str] = []

        # Step 2 — resolve zone IDs
        zone_ids: list = []
        if parsed.get("zone_names"):
            for zn in parsed["zone_names"]:
                res = await db.execute(
                    select(Zone).where(Zone.name.ilike(f"%{zn}%"))
                )
                for z in res.scalars().all():
                    zone_ids.append(str(z.id))

        # Step 3 — search Events
        ev_q = select(Event).where(
            and_(Event.timestamp >= time_start, Event.timestamp <= time_end)
        )
        if zone_ids:
            ev_q = ev_q.where(Event.zone_id.in_(zone_ids))
        if parsed.get("object_types"):
            type_filters = [Event.event_type.ilike(f"%{ot}%") for ot in parsed["object_types"]]
            desc_filters = [Event.description.ilike(f"%{ot}%") for ot in parsed["object_types"]]
            ev_q = ev_q.where(or_(*type_filters, *desc_filters))
        ev_q = ev_q.order_by(Event.timestamp.asc()).limit(500)
        ev_res = await db.execute(ev_q)
        events = ev_res.scalars().all()

        for ev in events:
            cam_str = str(ev.camera_id) if ev.camera_id else None
            if cam_str and cam_str not in cameras_searched:
                cameras_searched.append(cam_str)
            timeline.append({
                "timestamp": ev.timestamp.isoformat() if ev.timestamp else None,
                "source": "camera_event",
                "camera_id": cam_str,
                "event_type": ev.event_type,
                "description": ev.description,
                "severity": ev.severity.value if hasattr(ev.severity, "value") else str(ev.severity),
                "confidence": ev.confidence,
                "frame_url": ev.frame_url,
                "event_id": str(ev.id),
            })
        steps.append({"step": "search_events", "status": "complete",
                       "detail": f"{len(events)} events found",
                       "timestamp": datetime.now(timezone.utc).isoformat()})

        # Step 4 — search AccessEvents
        access_q = select(AccessEvent).where(
            and_(AccessEvent.timestamp >= time_start, AccessEvent.timestamp <= time_end)
        )
        if parsed.get("actions"):
            access_type_filters = [
                AccessEvent.event_type.ilike(f"%{a}%") for a in parsed["actions"]
            ]
            access_q = access_q.where(or_(*access_type_filters))
        access_q = access_q.order_by(AccessEvent.timestamp.asc()).limit(200)
        access_res = await db.execute(access_q)
        access_events = access_res.scalars().all()

        for ae in access_events:
            timeline.append({
                "timestamp": ae.timestamp.isoformat() if ae.timestamp else None,
                "source": "pacs",
                "door_id": ae.door_id,
                "user_identifier": ae.user_identifier,
                "event_type": ae.event_type,
                "camera_id": ae.camera_id,
                "access_event_id": str(ae.id),
            })
        steps.append({"step": "search_access_events", "status": "complete",
                       "detail": f"{len(access_events)} access events found",
                       "timestamp": datetime.now(timezone.utc).isoformat()})

        # Step 5 — search Visitors checked in during range
        vis_q = select(Visitor).where(
            and_(
                Visitor.check_in_time.isnot(None),
                Visitor.check_in_time >= time_start,
                Visitor.check_in_time <= time_end,
            )
        )
        vis_res = await db.execute(vis_q)
        visitors = vis_res.scalars().all()
        for v in visitors:
            timeline.append({
                "timestamp": v.check_in_time.isoformat() if v.check_in_time else None,
                "source": "visitor",
                "visitor_name": f"{v.first_name} {v.last_name}",
                "status": v.status.value if hasattr(v.status, "value") else str(v.status),
                "check_out_time": v.check_out_time.isoformat() if v.check_out_time else None,
                "visitor_id": str(v.id),
            })
        steps.append({"step": "search_visitors", "status": "complete",
                       "detail": f"{len(visitors)} visitors found",
                       "timestamp": datetime.now(timezone.utc).isoformat()})

        # Step 6 — vector semantic search if subject description given
        if parsed.get("subject_description"):
            try:
                from backend.services.vector_store import vector_store
                vec_results = await vector_store.search(
                    query=parsed["subject_description"],
                    top_k=20,
                    collection="sentinel_events",
                )
                for vr in vec_results:
                    subjects_found.append({
                        "descriptor": parsed["subject_description"],
                        "vector_match_score": vr.get("score", 0),
                        "event_id": vr.get("event_id"),
                        "description": vr.get("description"),
                    })
                steps.append({"step": "vector_search", "status": "complete",
                               "detail": f"{len(vec_results)} semantic matches",
                               "timestamp": datetime.now(timezone.utc).isoformat()})
            except Exception as exc:
                logger.warning("vector_search_skipped", error=str(exc))
                steps.append({"step": "vector_search", "status": "skipped",
                               "detail": str(exc),
                               "timestamp": datetime.now(timezone.utc).isoformat()})

        # Step 7 — sort timeline chronologically
        timeline.sort(key=lambda x: x.get("timestamp") or "")

        # Step 8 — AI narrative summary
        ai_narrative = ""
        try:
            from backend.services.ai_text_service import ai_generate_text

            summary_prompt = (
                "You are a security analyst. Given the following investigation timeline "
                "data, write a concise narrative summary (3-5 paragraphs) describing "
                "what happened, key findings, and recommended follow-up actions.\n\n"
                f"Original query: {query_text}\n"
                f"Time range: {time_start.isoformat()} to {time_end.isoformat()}\n"
                f"Total events: {len(timeline)}\n"
                f"Access events: {len(access_events)}\n"
                f"Visitors found: {len(visitors)}\n"
                f"Subjects matched: {len(subjects_found)}\n\n"
                f"Timeline sample (first 15 entries):\n"
                f"{json.dumps(timeline[:15], default=str, indent=2)}\n\n"
                "Write a professional security investigation narrative:"
            )
            ai_narrative = await ai_generate_text(summary_prompt, temperature=0.3, max_tokens=1024)
        except Exception as exc:
            logger.warning("ai_narrative_generation_failed", error=str(exc))
            ai_narrative = (
                f"Investigation for query '{query_text}' returned {len(timeline)} "
                f"timeline entries across {len(cameras_searched)} cameras, "
                f"{len(access_events)} access events, and {len(visitors)} visitors."
            )
        steps.append({"step": "generate_narrative", "status": "complete",
                       "timestamp": datetime.now(timezone.utc).isoformat()})

        # Step 9 — persist InvestigationSession
        duration = time.monotonic() - t0
        session = InvestigationSession(
            query_text=query_text,
            query_type="natural_language",
            parsed_params=parsed,
            status="complete",
            timeline=timeline,
            subjects_found=subjects_found,
            cameras_searched=cameras_searched,
            events_matched=len(timeline),
            ai_narrative=ai_narrative,
            initiated_by=initiated_by,
            incident_id=incident_id,
            processing_steps=steps,
            duration_seconds=round(duration, 2),
            completed_at=datetime.now(timezone.utc),
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)

        logger.info("investigation_complete", session_id=str(session.id),
                     events_matched=len(timeline), duration_s=round(duration, 2))

        return {
            "session_id": str(session.id),
            "status": "complete",
            "events_matched": len(timeline),
            "timeline": timeline,
            "subjects_found": subjects_found,
            "cameras_searched": cameras_searched,
            "ai_narrative": ai_narrative,
            "duration_seconds": round(duration, 2),
        }

    # ── Follow subject ────────────────────────────────────────

    async def follow_subject(
        self,
        db: AsyncSession,
        entity_description: str,
        time_range_hours: int = 24,
    ) -> dict:
        """Find every appearance of a described person across all cameras
        using both vector semantic search and Event table scanning."""
        now = datetime.now(timezone.utc)
        since = now - timedelta(hours=time_range_hours)
        trail: list[dict] = []

        # Semantic search via vector store
        try:
            from backend.services.vector_store import vector_store
            vec_hits = await vector_store.search(
                query=entity_description,
                top_k=50,
                collection="entity_appearances",
            )
            for hit in vec_hits:
                trail.append({
                    "source": "vector_match",
                    "score": hit.get("score", 0),
                    "camera_id": hit.get("camera_id"),
                    "timestamp": hit.get("timestamp"),
                    "description": hit.get("description"),
                    "event_id": hit.get("event_id"),
                })
        except Exception as exc:
            logger.warning("follow_subject_vector_search_failed", error=str(exc))

        # Database scan — description matches
        desc_terms = entity_description.lower().split()
        if desc_terms:
            ev_q = select(Event).where(
                and_(
                    Event.timestamp >= since,
                    or_(
                        *[Event.description.ilike(f"%{t}%") for t in desc_terms[:5]],
                        *[cast(Event.detections, String).ilike(f"%{t}%") for t in desc_terms[:5]],
                    ),
                )
            ).order_by(Event.timestamp.asc()).limit(200)
            ev_res = await db.execute(ev_q)
            for ev in ev_res.scalars().all():
                trail.append({
                    "source": "event_scan",
                    "camera_id": str(ev.camera_id) if ev.camera_id else None,
                    "timestamp": ev.timestamp.isoformat() if ev.timestamp else None,
                    "event_type": ev.event_type,
                    "description": ev.description,
                    "frame_url": ev.frame_url,
                    "event_id": str(ev.id),
                })

        # Deduplicate and sort chronologically
        seen_ids: set[str] = set()
        unique_trail: list[dict] = []
        for entry in trail:
            eid = entry.get("event_id") or f"{entry.get('camera_id')}_{entry.get('timestamp')}"
            if eid not in seen_ids:
                seen_ids.add(eid)
                unique_trail.append(entry)
        unique_trail.sort(key=lambda x: x.get("timestamp") or "")

        # Build camera sequence
        camera_sequence = []
        for entry in unique_trail:
            cid = entry.get("camera_id")
            if cid and (not camera_sequence or camera_sequence[-1] != cid):
                camera_sequence.append(cid)

        logger.info("follow_subject_complete", entity=entity_description,
                     appearances=len(unique_trail), cameras=len(camera_sequence))

        return {
            "entity_description": entity_description,
            "time_range_hours": time_range_hours,
            "appearances": len(unique_trail),
            "trail": unique_trail,
            "camera_sequence": camera_sequence,
        }

    # ── Evidence package ──────────────────────────────────────

    async def generate_evidence_package(
        self,
        db: AsyncSession,
        investigation_id: str,
    ) -> dict:
        """Export a complete investigation as an evidence package with
        integrity hashing."""
        # Load investigation
        inv_res = await db.execute(
            select(InvestigationSession).where(InvestigationSession.id == investigation_id)
        )
        investigation = inv_res.scalar_one_or_none()
        if not investigation:
            logger.error("investigation_not_found", investigation_id=investigation_id)
            return {"error": "Investigation not found"}

        # Collect video clip references from timeline
        video_clips: list[dict] = []
        screenshots: list[dict] = []
        access_logs: list[dict] = []
        camera_ids_seen: set[str] = set()

        for entry in (investigation.timeline or []):
            cam_id = entry.get("camera_id")
            ts = entry.get("timestamp")
            source = entry.get("source", "")

            if source == "pacs":
                access_logs.append(entry)
            elif cam_id:
                camera_ids_seen.add(cam_id)
                if entry.get("frame_url"):
                    screenshots.append({
                        "camera_id": cam_id,
                        "timestamp": ts,
                        "file_path": entry["frame_url"],
                        "event_type": entry.get("event_type"),
                    })

        # Gather recording references for each camera in range
        if camera_ids_seen and investigation.parsed_params:
            t_start_str = investigation.parsed_params.get("time_start")
            t_end_str = investigation.parsed_params.get("time_end")
            if t_start_str and t_end_str:
                try:
                    t_start = datetime.fromisoformat(t_start_str)
                    t_end = datetime.fromisoformat(t_end_str)
                    rec_q = select(Recording).where(
                        and_(
                            Recording.camera_id.in_(list(camera_ids_seen)),
                            Recording.start_time <= t_end,
                            or_(Recording.end_time.is_(None), Recording.end_time >= t_start),
                        )
                    )
                    rec_res = await db.execute(rec_q)
                    for rec in rec_res.scalars().all():
                        video_clips.append({
                            "camera_id": str(rec.camera_id),
                            "start": rec.start_time.isoformat() if rec.start_time else None,
                            "end": rec.end_time.isoformat() if rec.end_time else None,
                            "file_path": rec.file_path,
                        })
                except (ValueError, TypeError):
                    pass

        # Compute integrity hash over collected contents
        hash_input = json.dumps({
            "investigation_id": str(investigation.id),
            "query": investigation.query_text,
            "timeline_count": len(investigation.timeline or []),
            "video_clips": len(video_clips),
            "screenshots": len(screenshots),
            "access_logs": len(access_logs),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }, sort_keys=True).encode()
        sha256_hash = hashlib.sha256(hash_input).hexdigest()

        export_path = f"/data/evidence_packages/{investigation.id}.json"
        contents_count = len(video_clips) + len(screenshots) + len(access_logs)

        # Persist EvidencePackage
        package = EvidencePackage(
            investigation_id=investigation.id,
            incident_id=investigation.incident_id,
            title=f"Evidence: {investigation.query_text[:200]}",
            description=investigation.ai_narrative,
            video_clips=video_clips,
            screenshots=screenshots,
            access_logs=access_logs,
            timeline_data=investigation.timeline or [],
            ai_analysis=investigation.ai_narrative,
            export_format="json",
            export_path=export_path,
            hash_sha256=sha256_hash,
            created_by=investigation.initiated_by,
        )
        db.add(package)

        # Link back to investigation
        investigation.evidence_package_id = package.id
        await db.commit()
        await db.refresh(package)

        logger.info("evidence_package_created", package_id=str(package.id),
                     contents=contents_count, hash=sha256_hash[:16])

        return {
            "package_id": str(package.id),
            "contents_count": contents_count,
            "export_path": export_path,
            "sha256": sha256_hash,
            "video_clips": len(video_clips),
            "screenshots": len(screenshots),
            "access_logs": len(access_logs),
        }

    # ── Retrieval helpers ─────────────────────────────────────

    async def get_investigation(self, db: AsyncSession, session_id: str) -> dict:
        """Retrieve a single investigation session with full results."""
        result = await db.execute(
            select(InvestigationSession).where(InvestigationSession.id == session_id)
        )
        inv = result.scalar_one_or_none()
        if not inv:
            return {"error": "Investigation not found"}

        return {
            "session_id": str(inv.id),
            "query_text": inv.query_text,
            "query_type": inv.query_type,
            "parsed_params": inv.parsed_params,
            "status": inv.status,
            "timeline": inv.timeline or [],
            "subjects_found": inv.subjects_found or [],
            "cameras_searched": inv.cameras_searched or [],
            "events_matched": inv.events_matched,
            "ai_narrative": inv.ai_narrative,
            "evidence_package_id": str(inv.evidence_package_id) if inv.evidence_package_id else None,
            "initiated_by": str(inv.initiated_by) if inv.initiated_by else None,
            "incident_id": str(inv.incident_id) if inv.incident_id else None,
            "processing_steps": inv.processing_steps or [],
            "duration_seconds": inv.duration_seconds,
            "created_at": inv.created_at.isoformat() if inv.created_at else None,
            "completed_at": inv.completed_at.isoformat() if inv.completed_at else None,
        }

    async def list_investigations(
        self,
        db: AsyncSession,
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict]:
        """List recent investigation sessions."""
        q = (
            select(InvestigationSession)
            .order_by(InvestigationSession.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        result = await db.execute(q)
        rows = result.scalars().all()
        return [
            {
                "session_id": str(r.id),
                "query_text": r.query_text,
                "status": r.status,
                "events_matched": r.events_matched,
                "duration_seconds": r.duration_seconds,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]


agentic_investigation_service = AgenticInvestigationService()
