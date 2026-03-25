"""Companion Discovery — entity companion links and behavioral analysis."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc

from backend.api.auth import get_current_user, require_role
from backend.database import async_session
from backend.models.models import UserRole
from backend.models.phase2_models import CompanionLink

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/companion", tags=["companion"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class CompanionLinkResponse(BaseModel):
    id: str
    entity_a_track_id: int
    entity_b_track_id: int
    camera_id: Optional[str] = None
    proximity_duration_seconds: float
    behavioral_sync_score: float
    link_type: str
    created_at: Optional[str] = None


class CompanionAnalyzeRequest(BaseModel):
    camera_id: str = Field(..., description="Camera ID to analyze for companion patterns")


class CompanionAnalyzeResponse(BaseModel):
    camera_id: str
    links_found: int
    links: List[dict]
    analysis_timestamp: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fmt_link(c: CompanionLink) -> dict:
    return {
        "id": str(c.id),
        "entity_a_track_id": c.entity_a_track_id,
        "entity_b_track_id": c.entity_b_track_id,
        "camera_id": c.camera_id,
        "proximity_duration_seconds": c.proximity_duration_seconds or 0.0,
        "behavioral_sync_score": c.behavioral_sync_score or 0.0,
        "link_type": c.link_type or "proximity",
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/links", response_model=List[dict])
async def list_companion_links(
    camera_id: Optional[str] = Query(None, description="Filter by camera ID"),
    min_sync_score: Optional[float] = Query(None, ge=0.0, le=1.0),
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """List companion links with optional filters."""
    try:
        async with async_session() as session:
            stmt = (
                select(CompanionLink)
                .order_by(desc(CompanionLink.behavioral_sync_score))
                .limit(limit)
            )

            if camera_id:
                stmt = stmt.where(CompanionLink.camera_id == camera_id)
            if min_sync_score is not None:
                stmt = stmt.where(CompanionLink.behavioral_sync_score >= min_sync_score)

            result = await session.execute(stmt)
            return [_fmt_link(c) for c in result.scalars().all()]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list companion links")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/links/{link_id}", response_model=dict)
async def get_companion_link_detail(
    link_id: uuid.UUID,
    _user=Depends(get_current_user),
):
    """Get detailed information for a specific companion link."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(CompanionLink).where(CompanionLink.id == link_id)
            )
            link = result.scalar_one_or_none()
            if not link:
                raise HTTPException(status_code=404, detail="Companion link not found")

            data = _fmt_link(link)

            # Find other links involving the same entities
            related_result = await session.execute(
                select(CompanionLink)
                .where(
                    CompanionLink.id != link_id,
                    (
                        (CompanionLink.entity_a_track_id == link.entity_a_track_id)
                        | (CompanionLink.entity_b_track_id == link.entity_b_track_id)
                        | (CompanionLink.entity_a_track_id == link.entity_b_track_id)
                        | (CompanionLink.entity_b_track_id == link.entity_a_track_id)
                    ),
                )
                .order_by(desc(CompanionLink.created_at))
                .limit(10)
            )
            related = related_result.scalars().all()
            data["related_links"] = [_fmt_link(r) for r in related]
            data["related_count"] = len(related)

            return data
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to fetch companion link %s", link_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/analyze", response_model=dict)
async def trigger_companion_analysis(
    body: CompanionAnalyzeRequest,
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Trigger companion analysis for a specific camera feed.

    Calls companion_analyzer service if available, fallback returns empty.
    """
    try:
        # Try to use companion_analyzer service
        try:
            from backend.services.companion_analyzer import companion_analyzer

            result = await companion_analyzer.analyze(body.camera_id)
            return {
                "camera_id": body.camera_id,
                "links_found": len(result) if isinstance(result, list) else 0,
                "links": result if isinstance(result, list) else [],
                "analysis_timestamp": datetime.now(timezone.utc).isoformat(),
            }
        except (ImportError, AttributeError):
            logger.info("companion_analyzer service not available, returning existing links")

        # Fallback: return recent existing links for the camera
        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
            existing_result = await session.execute(
                select(CompanionLink)
                .where(
                    CompanionLink.camera_id == body.camera_id,
                    CompanionLink.created_at >= cutoff,
                )
                .order_by(desc(CompanionLink.behavioral_sync_score))
            )
            links = existing_result.scalars().all()

            return {
                "camera_id": body.camera_id,
                "links_found": len(links),
                "links": [_fmt_link(c) for c in links],
                "analysis_timestamp": datetime.now(timezone.utc).isoformat(),
            }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to run companion analysis for camera %s", body.camera_id)
        raise HTTPException(status_code=500, detail=str(exc))
