"""Semantic and entity search API."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, or_, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db, async_session
from backend.models import Event, Alert
from backend.schemas import SemanticSearchRequest, SemanticSearchResponse, SearchResult
from backend.api.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/search", tags=["search"])


# ── Request schemas specific to search ─────────────────────────

class EntitySearchRequest(BaseModel):
    """Search for events matching entity descriptions."""
    entity_type: str = Field(
        ...,
        description="Type of entity to search: person, vehicle, object, activity",
    )
    description: str = Field(
        ...,
        description="Natural language description, e.g. 'man wearing red jacket'",
    )
    top_k: int = Field(10, ge=1, le=100)
    camera_ids: Optional[List[str]] = None
    time_range_minutes: Optional[int] = Field(None, description="Look-back window in minutes")
    filters: Optional[Dict[str, Any]] = None


class EntitySearchResponse(BaseModel):
    entity_type: str
    description: str
    results: List[SearchResult]
    total: int


# ── Helpers ────────────────────────────────────────────────────

def _try_import_vector_store():
    """Attempt to import the vector store service. Returns None if unavailable."""
    try:
        from backend.services.vector_store import vector_store
        return vector_store
    except ImportError:
        return None


# ── Endpoints ──────────────────────────────────────────────────

@router.post("/semantic", response_model=SemanticSearchResponse)
async def semantic_search(
    body: SemanticSearchRequest,
    _user=Depends(get_current_user),
):
    """Perform semantic search via Qdrant vector store.

    Encodes the query text into an embedding and searches the
    Qdrant collection for the nearest neighbours.
    """
    vs = _try_import_vector_store()
    if vs is None:
        raise HTTPException(
            status_code=503,
            detail="Vector store service is not available. Ensure Qdrant and the embedding model are configured.",
        )

    try:
        raw_results = await vs.search(
            query=body.query,
            top_k=body.top_k,
            filters=body.filters,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Vector store query failed: {exc}")

    results: List[SearchResult] = []
    for hit in raw_results:
        payload = hit.get("payload", {}) if isinstance(hit, dict) else {}
        score = hit.get("score", 0.0) if isinstance(hit, dict) else getattr(hit, "score", 0.0)
        point_id = hit.get("id", "") if isinstance(hit, dict) else getattr(hit, "id", "")

        results.append(
            SearchResult(
                event_id=str(payload.get("event_id", point_id)),
                score=float(score),
                description=payload.get("description"),
                event_type=payload.get("event_type"),
                camera_id=payload.get("camera_id"),
                timestamp=payload.get("timestamp"),
                metadata=payload.get("metadata"),
            )
        )

    return SemanticSearchResponse(
        query=body.query,
        results=results,
        total=len(results),
    )


@router.post("/entity", response_model=EntitySearchResponse)
async def entity_search(
    body: EntitySearchRequest,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Search events by entity description (person, vehicle, object, activity).

    Strategy:
    1. If the vector store is available, perform semantic search using a
       constructed query string that combines entity_type + description.
    2. Fall back to a database text search against event descriptions,
       detection JSON, and Gemini analysis JSON.
    """
    valid_entity_types = {"person", "vehicle", "object", "activity"}
    if body.entity_type not in valid_entity_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid entity_type. Must be one of: {', '.join(sorted(valid_entity_types))}",
        )

    search_query = f"{body.entity_type}: {body.description}"

    # ── Try vector store first ────────────────────────────────
    vs = _try_import_vector_store()
    if vs is not None:
        try:
            filters = body.filters or {}
            if body.camera_ids:
                filters["camera_ids"] = body.camera_ids
            if body.time_range_minutes:
                filters["time_range_minutes"] = body.time_range_minutes

            raw_results = await vs.search(
                query=search_query,
                top_k=body.top_k,
                filters=filters if filters else None,
            )

            results: List[SearchResult] = []
            for hit in raw_results:
                payload = hit.get("payload", {}) if isinstance(hit, dict) else {}
                score = hit.get("score", 0.0) if isinstance(hit, dict) else getattr(hit, "score", 0.0)
                point_id = hit.get("id", "") if isinstance(hit, dict) else getattr(hit, "id", "")
                results.append(
                    SearchResult(
                        event_id=str(payload.get("event_id", point_id)),
                        score=float(score),
                        description=payload.get("description"),
                        event_type=payload.get("event_type"),
                        camera_id=payload.get("camera_id"),
                        timestamp=payload.get("timestamp"),
                        metadata=payload.get("metadata"),
                    )
                )

            return EntitySearchResponse(
                entity_type=body.entity_type,
                description=body.description,
                results=results,
                total=len(results),
            )
        except Exception:
            # Fall through to database search
            pass

    # ── Fallback: database text search ────────────────────────
    search_term = f"%{body.description}%"
    stmt = (
        select(Event)
        .where(
            or_(
                Event.description.ilike(search_term),
                Event.event_type.ilike(f"%{body.entity_type}%"),
            )
        )
        .order_by(Event.timestamp.desc())
        .limit(body.top_k)
    )

    result = await db.execute(stmt)
    events = result.scalars().all()

    results = [
        SearchResult(
            event_id=str(ev.id),
            score=0.5,  # Fixed score for text-match fallback
            description=ev.description,
            event_type=ev.event_type,
            camera_id=str(ev.camera_id),
            timestamp=ev.timestamp.isoformat() if ev.timestamp else None,
            metadata=ev.metadata_,
        )
        for ev in events
    ]

    return EntitySearchResponse(
        entity_type=body.entity_type,
        description=body.description,
        results=results,
        total=len(results),
    )


@router.post("/reindex")
async def reindex_vector_store(_user=Depends(get_current_user)):
    """Re-index all historical alerts and events into the Qdrant vector store."""
    vs = _try_import_vector_store()
    if vs is None:
        raise HTTPException(503, detail="Vector store not available")

    indexed = 0
    errors = 0

    async with async_session() as session:
        # Index alerts
        result = await session.execute(
            select(Alert).order_by(Alert.created_at.desc()).limit(500)
        )
        for alert in result.scalars().all():
            desc = f"[{alert.threat_type or 'unknown'}] {alert.description or ''}"
            meta = {
                "event_type": "alert",
                "severity": alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity),
                "threat_type": alert.threat_type or "",
                "camera_id": str(alert.source_camera) if alert.source_camera else "",
                "zone_name": alert.zone_name or "",
                "timestamp": alert.created_at.isoformat() if alert.created_at else "",
            }
            try:
                await vs.upsert_event(str(alert.id), desc, meta)
                indexed += 1
            except Exception:
                errors += 1

        # Index events
        result = await session.execute(
            select(Event).order_by(Event.timestamp.desc()).limit(1000)
        )
        for event in result.scalars().all():
            desc = event.description or f"{event.event_type or 'event'}"
            meta = {
                "event_type": event.event_type or "",
                "camera_id": str(event.camera_id) if event.camera_id else "",
                "timestamp": event.timestamp.isoformat() if event.timestamp else "",
            }
            try:
                await vs.upsert_event(str(event.id), desc, meta)
                indexed += 1
            except Exception:
                errors += 1

    logger.info("reindex.complete", indexed=indexed, errors=errors)
    return {"indexed": indexed, "errors": errors}
