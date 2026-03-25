"""Multi-Site Management — global overwatch for all physical security sites."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc, func

from backend.api.auth import get_current_user, require_role
from backend.database import async_session
from backend.models.models import UserRole
from backend.models.phase2_models import Site

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sites", tags=["sites"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class SiteCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    address: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    timezone_str: str = Field("UTC", max_length=50)
    total_cameras: int = Field(0, ge=0)


class SiteUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    alert_summary: Optional[dict] = None


class SiteResponse(BaseModel):
    id: str
    name: str
    address: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    timezone_str: str
    total_cameras: int
    status: str
    alert_summary: dict
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

VALID_STATUSES = {"active", "offline", "maintenance"}


def _fmt_site(s: Site) -> dict:
    return {
        "id": str(s.id),
        "name": s.name,
        "address": s.address,
        "lat": s.lat,
        "lng": s.lng,
        "timezone_str": getattr(s, "timezone_str", "UTC") or "UTC",
        "total_cameras": s.total_cameras or 0,
        "status": s.status or "active",
        "alert_summary": s.alert_summary or {},
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[dict])
async def list_sites(_user=Depends(get_current_user)):
    """List all sites."""
    try:
        async with async_session() as session:
            stmt = select(Site).order_by(Site.name)
            result = await session.execute(stmt)
            return [_fmt_site(s) for s in result.scalars().all()]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list sites")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/", response_model=dict, status_code=201)
async def add_site(
    body: SiteCreate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Add a new site (admin only)."""
    try:
        async with async_session() as session:
            site = Site(
                name=body.name,
                address=body.address,
                lat=body.lat,
                lng=body.lng,
                timezone_str=body.timezone_str,
                total_cameras=body.total_cameras,
                status="active",
                alert_summary={},
            )
            session.add(site)
            await session.commit()
            await session.refresh(site)
            return _fmt_site(site)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to add site")
        raise HTTPException(status_code=500, detail=str(exc))


@router.put("/{site_id}", response_model=dict)
async def update_site(
    site_id: uuid.UUID,
    body: SiteUpdate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Update a site (admin only)."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(Site).where(Site.id == site_id)
            )
            site = result.scalar_one_or_none()
            if not site:
                raise HTTPException(status_code=404, detail="Site not found")

            if body.name is not None:
                site.name = body.name
            if body.status is not None:
                if body.status not in VALID_STATUSES:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid status. Must be one of: {', '.join(sorted(VALID_STATUSES))}",
                    )
                site.status = body.status
            if body.alert_summary is not None:
                site.alert_summary = body.alert_summary

            site.updated_at = datetime.now(timezone.utc)
            await session.commit()
            await session.refresh(site)
            return _fmt_site(site)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to update site %s", site_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/{site_id}/status", response_model=dict)
async def get_site_status(
    site_id: uuid.UUID,
    _user=Depends(get_current_user),
):
    """Get a site with alert_summary."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(Site).where(Site.id == site_id)
            )
            site = result.scalar_one_or_none()
            if not site:
                raise HTTPException(status_code=404, detail="Site not found")

            data = _fmt_site(site)
            data["health"] = {
                "cameras_online": site.total_cameras,
                "cameras_total": site.total_cameras,
                "uptime_percent": 100.0 if site.status == "active" else 0.0,
                "last_checked": datetime.now(timezone.utc).isoformat(),
            }
            return data
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to fetch site status for %s", site_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/overview", response_model=dict)
async def get_sites_overview(_user=Depends(get_current_user)):
    """Aggregate: total sites, total cameras, sites by status, recent alerts per site."""
    try:
        async with async_session() as session:
            result = await session.execute(select(Site).order_by(Site.name))
            sites = result.scalars().all()

            sites_by_status: dict = {}
            total_cameras = 0
            recent_alerts_per_site: list = []

            for s in sites:
                status = s.status or "active"
                sites_by_status[status] = sites_by_status.get(status, 0) + 1
                total_cameras += s.total_cameras or 0
                recent_alerts_per_site.append({
                    "site_id": str(s.id),
                    "site_name": s.name,
                    "alert_summary": s.alert_summary or {},
                })

            return {
                "total_sites": len(sites),
                "total_cameras": total_cameras,
                "sites_by_status": sites_by_status,
                "recent_alerts_per_site": recent_alerts_per_site,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to generate sites overview")
        raise HTTPException(status_code=500, detail=str(exc))
