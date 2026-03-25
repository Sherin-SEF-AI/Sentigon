"""Emergency Services geolocation API — nearby police, hospitals, fire stations."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from backend.api.auth import get_current_user
from backend.config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/emergency", tags=["emergency"])


# ── Schemas ───────────────────────────────────────────────────────────

class NearbyRequest(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    radius_km: float = Field(5.0, ge=0.5, le=50.0)


class EmergencyServiceResponse(BaseModel):
    name: str
    type: str
    latitude: float
    longitude: float
    distance_km: float
    address: str = ""
    phone: str = ""


class NearbyResponse(BaseModel):
    facility_location: dict
    search_radius_km: float
    total_found: int
    services: List[EmergencyServiceResponse]
    by_type: dict


class FacilityLocationResponse(BaseModel):
    latitude: float
    longitude: float
    configured: bool


# ── Endpoints ─────────────────────────────────────────────────────────

@router.post("/nearby", response_model=NearbyResponse)
async def get_nearby_services(
    body: NearbyRequest,
    _user=Depends(get_current_user),
):
    """Find nearby emergency services (police, hospitals, fire stations) via OpenStreetMap."""
    from backend.services.autonomous_response import fetch_nearby_emergency_services

    services = await fetch_nearby_emergency_services(
        lat=body.latitude,
        lng=body.longitude,
        radius_km=body.radius_km,
    )

    by_type: dict = {}
    for svc in services:
        by_type.setdefault(svc["type"], []).append(svc)

    return NearbyResponse(
        facility_location={"latitude": body.latitude, "longitude": body.longitude},
        search_radius_km=body.radius_km,
        total_found=len(services),
        services=[EmergencyServiceResponse(**s) for s in services],
        by_type={k: len(v) for k, v in by_type.items()},
    )


@router.get("/facility-location", response_model=FacilityLocationResponse)
async def get_facility_location(
    _user=Depends(get_current_user),
):
    """Get configured facility location coordinates."""
    return FacilityLocationResponse(
        latitude=settings.FACILITY_LATITUDE,
        longitude=settings.FACILITY_LONGITUDE,
        configured=True,
    )
