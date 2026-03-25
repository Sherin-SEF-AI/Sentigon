"""Setup API — industry template discovery and site activation endpoints."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from backend.services.industry_templates import (
    get_all_industries,
    get_emergency_codes_for_industry,
    get_template,
    get_threat_signatures_for_industry,
    get_zone_types_for_industry,
)

router = APIRouter(prefix="/api/setup", tags=["setup"])


@router.get("/industries")
async def list_industries():
    """List all available industry verticals."""
    return {"industries": get_all_industries()}


@router.get("/industries/{industry_id}")
async def get_industry_template(industry_id: str):
    """Return the full template for a specific industry."""
    template = get_template(industry_id)
    if not template:
        return JSONResponse(status_code=404, content={"detail": "Industry not found"})
    return template


@router.get("/industries/{industry_id}/signatures")
async def get_industry_signatures(industry_id: str):
    """Return pre-configured threat signatures for a specific industry."""
    return {"signatures": get_threat_signatures_for_industry(industry_id)}


@router.get("/industries/{industry_id}/emergency-codes")
async def get_industry_emergency_codes(industry_id: str):
    """Return emergency response codes for a specific industry."""
    return {"codes": get_emergency_codes_for_industry(industry_id)}


@router.get("/industries/{industry_id}/zones")
async def get_industry_zones(industry_id: str):
    """Return recommended zone types for a specific industry."""
    return {"zone_types": get_zone_types_for_industry(industry_id)}


@router.post("/activate")
async def activate_setup():
    """Mark initial system setup as complete."""
    return {"status": "activated", "message": "System setup complete"}
