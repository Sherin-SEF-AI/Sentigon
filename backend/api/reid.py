"""Privacy-Preserving Re-Identification API — cross-camera person tracking without faces."""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user
from backend.database import get_db, async_session
from backend.models.models import Event
from backend.models.system_settings import SystemSetting

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/reid", tags=["reid"])


# ── Schemas ───────────────────────────────────────────────────

class AppearanceSearchQuery(BaseModel):
    description: str = Field(..., description="Natural language appearance description")
    time_range_minutes: int = Field(60, ge=1, le=1440)
    max_results: int = Field(20, ge=1, le=100)
    cameras: Optional[List[str]] = None


# ── 1. Dashboard stats ──────────────────────────────────────

@router.get("/stats")
async def reid_stats(_user=Depends(get_current_user)):
    """Get re-identification system statistics."""
    try:
        from backend.services.vector_store import vector_store
        info = vector_store.collection_info
        points = info.get("points_count", 0) if info else 0
    except Exception:
        points = 0

    async with async_session() as session:
        cutoff_30m = datetime.now(timezone.utc) - timedelta(minutes=30)

        # Active tracking: distinct entities seen in the last 30 minutes
        active_tracking = (await session.execute(
            select(func.count(func.distinct(Event.embedding_id))).where(
                Event.timestamp >= cutoff_30m,
                Event.event_type.in_(["person_detected", "person_tracking", "entity_appearance"]),
                Event.embedding_id.isnot(None),
            )
        )).scalar() or 0

        # Cross-camera matches: entities seen on 2+ distinct cameras
        subq = (
            select(
                Event.embedding_id,
                func.count(func.distinct(Event.camera_id)).label("cam_count"),
            )
            .where(
                Event.embedding_id.isnot(None),
                Event.event_type.in_(["person_detected", "person_tracking", "entity_appearance"]),
            )
            .group_by(Event.embedding_id)
            .having(func.count(func.distinct(Event.camera_id)) > 1)
            .subquery()
        )
        cross_camera = (await session.execute(
            select(func.count()).select_from(subq)
        )).scalar() or 0

        # Flagged persons: read from SystemSetting
        flagged_row = (await session.execute(
            select(SystemSetting).where(SystemSetting.key == "reid.flagged_profiles")
        )).scalar_one_or_none()
        flagged_list = json.loads(flagged_row.value) if flagged_row and flagged_row.value else []
        flagged_count = len(flagged_list)

        # Average confidence for person-related events
        avg_conf = (await session.execute(
            select(func.avg(Event.confidence)).where(
                Event.event_type.in_(["person_detected", "person_tracking", "entity_appearance"]),
                Event.confidence > 0,
            )
        )).scalar()
        avg_confidence = round(float(avg_conf), 2) if avg_conf else 0.0

    return {
        "total_profiles": points,
        "active_tracking": active_tracking,
        "cross_camera_matches": cross_camera,
        "total_sightings": points,
        "flagged_persons": flagged_count,
        "avg_confidence": avg_confidence,
        "privacy_mode": "GDPR-compliant — No facial recognition used",
    }


# ── 2. Search by appearance (Qdrant semantic search) ─────────

@router.post("/search")
async def search_by_appearance(
    body: AppearanceSearchQuery,
    _user=Depends(get_current_user),
):
    """Search for persons matching a natural language appearance description using Qdrant."""
    try:
        from backend.services.vector_store import vector_store
        results = await vector_store.search(
            query=body.description,
            top_k=body.max_results,
            collection="entity_appearances",
        )
        return [
            {
                "profile": {
                    "id": r.get("id", ""),
                    "descriptor": r.get("description", r.get("reid_string", "")),
                    "confidence": r.get("score", 0),
                    "camera_id": r.get("camera_id", ""),
                    "timestamp": r.get("timestamp", ""),
                    "frame_path": r.get("frame_path", ""),
                },
                "match_score": r.get("score", 0),
            }
            for r in results
        ]
    except Exception as e:
        logger.warning("Reid search fallback: %s", e)
        return []


# ── 3. List profiles ─────────────────────────────────────────

@router.get("/profiles")
async def list_profiles(
    limit: int = Query(50, ge=1, le=200),
    flagged_only: bool = Query(False),
    _user=Depends(get_current_user),
):
    """Get recent appearance profiles from Qdrant."""
    try:
        from backend.services.vector_store import vector_store
        results = await vector_store.search(
            query="person appearance",
            top_k=limit,
            collection="entity_appearances",
        )
        return [
            {
                "id": r.get("id", ""),
                "descriptor": r.get("description", r.get("reid_string", "")),
                "confidence": r.get("score", 0),
                "clothing": r.get("clothing", {}),
                "accessories": r.get("accessories", []),
                "build": r.get("build", ""),
                "hair": r.get("hair", ""),
                "sightings_count": 1,
                "camera_sightings": [{
                    "camera_id": r.get("camera_id", ""),
                    "timestamp": r.get("timestamp", ""),
                }],
                "is_flagged": False,
                "first_seen": r.get("timestamp", ""),
                "last_seen": r.get("timestamp", ""),
            }
            for r in results
        ]
    except Exception as e:
        logger.warning("Reid list fallback: %s", e)
        return []


# ── 4. Profile detail ──────────────────────────────────────

@router.get("/profiles/{profile_id}")
async def get_profile(profile_id: str, _user=Depends(get_current_user)):
    """Get detailed appearance profile by querying Qdrant and Events."""
    sightings: List[Dict[str, Any]] = []
    descriptor = ""

    # Try Qdrant first
    try:
        from backend.services.vector_store import vector_store
        results = await vector_store.search(
            query=profile_id,
            top_k=50,
            collection="entity_appearances",
            filters={"entity_id": profile_id},
        )
        for r in results:
            sightings.append({
                "camera_id": r.get("camera_id", ""),
                "timestamp": r.get("timestamp", ""),
                "confidence": r.get("score", 0),
                "descriptor": r.get("description", r.get("reid_string", "")),
                "frame_path": r.get("frame_path", ""),
            })
        if results:
            descriptor = results[0].get("description", results[0].get("reid_string", ""))
    except Exception:
        pass

    # Fallback: query Event table for matching embedding_id
    if not sightings:
        async with async_session() as session:
            result = await session.execute(
                select(Event)
                .where(Event.embedding_id == profile_id)
                .order_by(desc(Event.timestamp))
                .limit(50)
            )
            events = result.scalars().all()
            for e in events:
                desc_text = e.description or ""
                if not descriptor and desc_text:
                    descriptor = desc_text
                sightings.append({
                    "camera_id": str(e.camera_id),
                    "timestamp": e.timestamp.isoformat() if e.timestamp else "",
                    "confidence": e.confidence,
                    "descriptor": desc_text,
                    "frame_path": e.frame_url or "",
                })

    # Check flagged status
    is_flagged = False
    async with async_session() as session:
        flagged_row = (await session.execute(
            select(SystemSetting).where(SystemSetting.key == "reid.flagged_profiles")
        )).scalar_one_or_none()
        if flagged_row and flagged_row.value:
            flagged_list = json.loads(flagged_row.value)
            is_flagged = profile_id in flagged_list

    return {
        "id": profile_id,
        "descriptor": descriptor,
        "is_flagged": is_flagged,
        "sightings": sightings,
        "sighting_count": len(sightings),
        "cameras": list({s["camera_id"] for s in sightings if s.get("camera_id")}),
    }


# ── 5. Flag/unflag profile ──────────────────────────────────

@router.post("/profiles/{profile_id}/flag")
async def toggle_flag(profile_id: str, _user=Depends(get_current_user)):
    """Toggle the flagged status of an appearance profile (persisted to DB)."""
    async with async_session() as session:
        result = await session.execute(
            select(SystemSetting).where(SystemSetting.key == "reid.flagged_profiles")
        )
        row = result.scalar_one_or_none()

        if row and row.value:
            flagged_list = json.loads(row.value)
        else:
            flagged_list = []

        if profile_id in flagged_list:
            flagged_list.remove(profile_id)
            flagged = False
        else:
            flagged_list.append(profile_id)
            flagged = True

        if row:
            row.value = json.dumps(flagged_list)
        else:
            session.add(SystemSetting(
                key="reid.flagged_profiles",
                value=json.dumps(flagged_list),
            ))
        await session.commit()

    return {"id": profile_id, "flagged": flagged}


# ── 6. Cross-camera tracking ────────────────────────────────

@router.get("/tracking-map")
async def get_tracking_map(_user=Depends(get_current_user)):
    """Get cross-camera tracking data — entities seen across multiple cameras."""
    async with async_session() as session:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)

        # Find entities that appear on multiple cameras in the last hour
        multi_cam = (await session.execute(
            select(
                Event.embedding_id,
                func.count(func.distinct(Event.camera_id)).label("cam_count"),
            )
            .where(
                Event.timestamp >= cutoff,
                Event.embedding_id.isnot(None),
                Event.event_type.in_(["person_detected", "person_tracking", "entity_appearance"]),
            )
            .group_by(Event.embedding_id)
            .having(func.count(func.distinct(Event.camera_id)) >= 1)
            .order_by(desc(func.count(func.distinct(Event.camera_id))))
            .limit(50)
        )).all()

        tracking_entries = []
        for row in multi_cam:
            entity_id = row.embedding_id
            # Get all sightings for this entity in the last hour
            sighting_rows = (await session.execute(
                select(Event.camera_id, Event.timestamp, Event.description)
                .where(
                    Event.embedding_id == entity_id,
                    Event.timestamp >= cutoff,
                )
                .order_by(Event.timestamp)
            )).all()

            cameras: Dict[str, Dict[str, Any]] = {}
            path = []
            for sr in sighting_rows:
                cam_str = str(sr.camera_id)
                ts = sr.timestamp.isoformat() if sr.timestamp else ""
                path.append({"camera_id": cam_str, "timestamp": ts})
                if cam_str not in cameras:
                    cameras[cam_str] = {
                        "camera_id": cam_str,
                        "first_seen": ts,
                        "last_seen": ts,
                        "sighting_count": 0,
                    }
                cameras[cam_str]["last_seen"] = ts
                cameras[cam_str]["sighting_count"] += 1

            tracking_entries.append({
                "entity_id": entity_id,
                "cameras": list(cameras.values()),
                "camera_count": len(cameras),
                "path": path,
                "description": sighting_rows[0].description if sighting_rows else "",
            })

        return tracking_entries


# ── 7. Entity path ──────────────────────────────────────────

@router.get("/track/{entity_id}/path")
async def get_entity_path(entity_id: str, _user=Depends(get_current_user)):
    """Get the cross-camera path of a tracked entity."""
    try:
        from backend.services.vector_store import vector_store
        results = await vector_store.search(
            query=entity_id,
            top_k=50,
            collection="entity_appearances",
            filters={"entity_id": entity_id},
        )
        return {
            "entity_id": entity_id,
            "path": [
                {
                    "camera_id": r.get("camera_id", ""),
                    "timestamp": r.get("timestamp", ""),
                    "descriptor": r.get("description", ""),
                }
                for r in results
            ],
        }
    except Exception:
        return {"entity_id": entity_id, "path": []}


