"""License management API — tier info, feature gating, activation, and admin tenant endpoints."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.services.license_service import license_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/license", tags=["license"])
admin_router = APIRouter(prefix="/api/admin", tags=["admin"])


# ── Pydantic Models ───────────────────────────────────────────────────────────

class ActivateRequest(BaseModel):
    license_key: str


class TenantCreate(BaseModel):
    name: str
    slug: str
    plan: str = "basic"
    max_sites: int = 1
    max_users: int = 3


class TenantBranding(BaseModel):
    logo_url: Optional[str] = None
    primary_color: str = "#06b6d4"
    accent_color: str = "#8b5cf6"
    login_background_url: Optional[str] = None
    footer_text: Optional[str] = None


# ── Tenant store ──────────────────────────────────────────────────────────────
# Seeded with the single primary tenant for THIS deployment. Its user/camera
# counts are filled from the real database at read time (see list_tenants).
# Admins can create/manage additional tenants via the CRUD endpoints below.

_tenants: list[dict] = [
    {
        "id": "tenant-primary",
        "name": "Primary Organization",
        "slug": "primary",
        "plan": "enterprise",
        "max_sites": -1,
        "max_users": -1,
        "user_count": 0,
        "site_count": 1,
        "camera_count": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "disabled": False,
        "branding": {
            "primary_color": "#06b6d4",
            "accent_color": "#8b5cf6",
            "logo_url": None,
            "login_background_url": None,
            "footer_text": "SENTINEL AI",
        },
    },
]


async def _hydrate_primary_counts() -> None:
    """Fill the primary tenant's user/camera counts from the live DB."""
    try:
        from sqlalchemy import select, func
        from backend.database import async_session
        from backend.models.models import User, Camera
        async with async_session() as session:
            users = await session.scalar(select(func.count(User.id)))
            cams = await session.scalar(select(func.count(Camera.id)))
        for t in _tenants:
            if t["id"] == "tenant-primary":
                t["user_count"] = int(users or 0)
                t["camera_count"] = int(cams or 0)
    except Exception as e:  # noqa: BLE001
        logger.warning("admin.tenants.count_failed", error=str(e))


def _find_tenant(tenant_id: str) -> Optional[dict]:
    return next((t for t in _tenants if t["id"] == tenant_id), None)


# ── License Routes ────────────────────────────────────────────────────────────

@router.get("/info")
async def get_license_info():
    """Return current license tier and limits."""
    return license_service.get_license_info()


@router.get("/tiers")
async def get_all_tiers():
    """Return metadata for all license tiers."""
    return license_service.get_all_tiers()


@router.get("/check/{feature}")
async def check_feature(feature: str):
    """Check whether a specific feature is enabled under the current license."""
    return {
        "feature": feature,
        "enabled": license_service.is_feature_enabled(feature),
    }


@router.get("/limits/{resource}")
async def check_limits(resource: str, current: int = 0):
    """
    Check whether the current count for a resource is within license limits.
    Pass ?current=N to supply the current usage count.
    """
    return license_service.check_limit(resource, current)


@router.post("/activate")
async def activate_license(req: ActivateRequest):
    """Activate a license key and update the current tier."""
    if not req.license_key or len(req.license_key) < 4:
        raise HTTPException(status_code=400, detail="Invalid license key format.")
    return license_service.activate_license(req.license_key)


# ── Admin / Tenant Routes ─────────────────────────────────────────────────────

@admin_router.get("/tenants")
async def list_tenants():
    """Return all tenants. The primary tenant's counts reflect the live DB."""
    await _hydrate_primary_counts()
    return {
        "tenants": _tenants,
        "total": len(_tenants),
        "total_users": sum(t["user_count"] for t in _tenants),
        "total_cameras": sum(t["camera_count"] for t in _tenants),
        "total_sites": sum(t["site_count"] for t in _tenants),
    }


@admin_router.post("/tenants")
async def create_tenant(body: TenantCreate):
    """Create a new tenant organisation."""
    if any(t["slug"] == body.slug for t in _tenants):
        raise HTTPException(status_code=409, detail="Slug already exists.")

    new_tenant = {
        "id": f"tenant-{uuid.uuid4().hex[:8]}",
        "name": body.name,
        "slug": body.slug,
        "plan": body.plan,
        "max_sites": body.max_sites,
        "max_users": body.max_users,
        "user_count": 0,
        "site_count": 0,
        "camera_count": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "disabled": False,
        "branding": {
            "primary_color": "#06b6d4",
            "accent_color": "#8b5cf6",
            "logo_url": None,
            "login_background_url": None,
            "footer_text": f"{body.name} © 2026",
        },
    }
    _tenants.append(new_tenant)
    logger.info("admin.tenant.created", tenant_id=new_tenant["id"], name=body.name)
    return new_tenant


@admin_router.patch("/tenants/{tenant_id}/disable")
async def toggle_tenant(tenant_id: str):
    """Toggle a tenant's disabled state."""
    tenant = _find_tenant(tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found.")
    tenant["disabled"] = not tenant["disabled"]
    return {"id": tenant_id, "disabled": tenant["disabled"]}


@admin_router.get("/tenants/{tenant_id}")
async def get_tenant(tenant_id: str):
    """Return a single tenant by ID."""
    tenant = _find_tenant(tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found.")
    return tenant


@admin_router.post("/tenants/{tenant_id}/branding")
async def save_branding(tenant_id: str, body: TenantBranding):
    """Save white-label branding for a tenant."""
    tenant = _find_tenant(tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found.")
    tenant["branding"] = {
        "primary_color": body.primary_color,
        "accent_color": body.accent_color,
        "logo_url": body.logo_url,
        "login_background_url": body.login_background_url,
        "footer_text": body.footer_text,
    }
    logger.info("admin.tenant.branding_saved", tenant_id=tenant_id)
    return tenant["branding"]


@admin_router.get("/tenants/{tenant_id}/branding")
async def get_branding(tenant_id: str):
    """Return current branding config for a tenant."""
    tenant = _find_tenant(tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found.")
    return tenant.get("branding", {})
