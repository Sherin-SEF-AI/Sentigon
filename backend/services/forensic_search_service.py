"""Forensic Video Search Service — attribute search, vehicle search, CLIP similarity, cross-camera journey."""

import uuid
import logging
from datetime import datetime, timedelta
from sqlalchemy import select, func, and_, or_, cast, String, text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.models import Event, Camera
from backend.models.phase2b_models import ForensicSearchResult

logger = logging.getLogger(__name__)


class ForensicSearchService:

    async def search_by_attributes(self, db: AsyncSession, query: dict) -> dict:
        object_type = query.get("object_type", "person")
        attributes = query.get("attributes", {})
        time_from = query.get("time_from")
        time_to = query.get("time_to")
        camera_ids = query.get("camera_ids", [])
        zone_ids = query.get("zone_ids", [])
        min_confidence = query.get("min_confidence", 0.3)

        q = select(Event)
        if time_from:
            q = q.where(Event.timestamp >= time_from)
        if time_to:
            q = q.where(Event.timestamp <= time_to)
        if camera_ids:
            q = q.where(Event.camera_id.in_(camera_ids))
        if zone_ids:
            q = q.where(Event.zone_id.in_(zone_ids))
        if min_confidence:
            q = q.where(Event.confidence >= min_confidence)

        # Search in JSONB detections and gemini_analysis for attribute matches
        attr_terms = []
        for key, val in attributes.items():
            attr_terms.append(val.lower())

        # Text search on description and gemini_analysis
        if attr_terms:
            search_pattern = "%".join(attr_terms)
            q = q.where(or_(
                Event.description.ilike(f"%{search_pattern}%"),
                cast(Event.gemini_analysis, String).ilike(f"%{search_pattern}%"),
                cast(Event.detections, String).ilike(f"%{object_type}%"),
            ))

        q = q.order_by(Event.timestamp.desc()).limit(100)
        result = await db.execute(q)
        events = result.scalars().all()
        items = []
        for e in events:
            items.append({
                "event_id": str(e.id), "camera_id": str(e.camera_id) if e.camera_id else None,
                "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                "description": e.description, "severity": e.severity,
                "confidence": e.confidence, "frame_url": e.frame_url,
                "detections": e.detections, "event_type": e.event_type,
            })
        return {"query": query, "result_count": len(items), "results": items}

    async def search_vehicles(self, db: AsyncSession, query: dict) -> dict:
        try:
            from backend.models.advanced_models import VehicleSighting
        except ImportError:
            return {"query": query, "result_count": 0, "results": []}

        q = select(VehicleSighting)
        if query.get("plate_text"):
            q = q.where(VehicleSighting.plate_text.ilike(f"%{query['plate_text']}%"))
        if query.get("vehicle_color"):
            q = q.where(VehicleSighting.vehicle_color.ilike(f"%{query['vehicle_color']}%"))
        if query.get("vehicle_type"):
            q = q.where(VehicleSighting.vehicle_type.ilike(f"%{query['vehicle_type']}%"))
        if query.get("time_from"):
            q = q.where(VehicleSighting.timestamp >= query["time_from"])
        if query.get("time_to"):
            q = q.where(VehicleSighting.timestamp <= query["time_to"])
        if query.get("camera_ids"):
            q = q.where(VehicleSighting.camera_id.in_(query["camera_ids"]))
        q = q.order_by(VehicleSighting.timestamp.desc()).limit(100)
        result = await db.execute(q)
        items = []
        for s in result.scalars().all():
            items.append({
                "id": str(s.id), "camera_id": str(s.camera_id) if s.camera_id else None,
                "timestamp": s.timestamp.isoformat() if s.timestamp else None,
                "plate_text": s.plate_text, "plate_confidence": s.plate_confidence,
                "vehicle_color": s.vehicle_color, "vehicle_type": s.vehicle_type,
                "vehicle_direction": s.vehicle_direction, "frame_path": s.frame_path,
            })
        return {"query": query, "result_count": len(items), "results": items}

    async def search_by_similarity(self, query_text: str, top_k: int = 20,
                                    time_from=None, time_to=None) -> dict:
        try:
            from backend.services.vector_store import vector_store
            results = await vector_store.search_similar("frame_embeddings", query_text, top_k=top_k)
            items = [{"score": r.get("score", 0), "payload": r.get("payload", {})} for r in (results or [])]
            return {"query": query_text, "result_count": len(items), "results": items}
        except Exception as e:
            logger.error("Similarity search failed: %s", e)
            return {"query": query_text, "result_count": 0, "results": [], "error": str(e)}

    async def cross_camera_journey(self, db: AsyncSession, track_id: str = None,
                                    appearance_desc: dict = None, time_from=None, time_to=None) -> dict:
        q = select(Event)
        if time_from:
            q = q.where(Event.timestamp >= time_from)
        if time_to:
            q = q.where(Event.timestamp <= time_to)
        if track_id:
            q = q.where(cast(Event.detections, String).ilike(f"%{track_id}%"))
        elif appearance_desc:
            terms = " ".join(str(v) for v in appearance_desc.values())
            q = q.where(or_(
                Event.description.ilike(f"%{terms}%"),
                cast(Event.detections, String).ilike(f"%{terms}%"),
            ))
        q = q.order_by(Event.timestamp.asc()).limit(200)
        result = await db.execute(q)
        events = result.scalars().all()

        # Group by camera transitions
        journey = []
        prev_camera = None
        for e in events:
            cam_id = str(e.camera_id) if e.camera_id else None
            if cam_id != prev_camera:
                journey.append({
                    "camera_id": cam_id,
                    "first_seen": e.timestamp.isoformat() if e.timestamp else None,
                    "last_seen": e.timestamp.isoformat() if e.timestamp else None,
                    "event_count": 1,
                    "frame_url": e.frame_url,
                })
                prev_camera = cam_id
            else:
                journey[-1]["last_seen"] = e.timestamp.isoformat() if e.timestamp else None
                journey[-1]["event_count"] += 1
        return {"track_id": track_id, "journey_steps": len(journey), "journey": journey}

    async def timeline_search(self, db: AsyncSession, camera_id: str,
                               time_from: datetime, time_to: datetime,
                               event_types: list = None) -> dict:
        q = select(Event).where(and_(
            Event.camera_id == camera_id,
            Event.timestamp >= time_from,
            Event.timestamp <= time_to,
        ))
        if event_types:
            q = q.where(Event.event_type.in_(event_types))
        q = q.order_by(Event.timestamp.asc()).limit(500)
        result = await db.execute(q)
        events = result.scalars().all()
        items = [{
            "event_id": str(e.id), "timestamp": e.timestamp.isoformat() if e.timestamp else None,
            "event_type": e.event_type, "severity": e.severity, "confidence": e.confidence,
            "description": e.description, "frame_url": e.frame_url,
        } for e in events]
        return {"camera_id": camera_id, "event_count": len(items), "events": items}

    async def save_search(self, db: AsyncSession, search_type: str, query: dict,
                           results: list, user_id: str) -> dict:
        sr = ForensicSearchResult(
            search_type=search_type, query=query, results=results,
            result_count=len(results), searched_by=user_id,
        )
        db.add(sr)
        await db.commit()
        await db.refresh(sr)
        return {"id": str(sr.id), "search_type": sr.search_type, "result_count": sr.result_count,
                "created_at": sr.created_at.isoformat() if sr.created_at else None}

    async def get_search_history(self, db: AsyncSession, user_id: str = None, limit: int = 20) -> list:
        q = select(ForensicSearchResult)
        if user_id:
            q = q.where(ForensicSearchResult.searched_by == user_id)
        q = q.order_by(ForensicSearchResult.created_at.desc()).limit(limit)
        result = await db.execute(q)
        return [{"id": str(s.id), "search_type": s.search_type, "result_count": s.result_count,
                 "query": s.query, "created_at": s.created_at.isoformat() if s.created_at else None}
                for s in result.scalars().all()]


forensic_search_service = ForensicSearchService()
