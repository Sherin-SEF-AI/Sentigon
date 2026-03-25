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


# ── In-memory demo store (replaces DB in dev) ─────────────────────────────────

_demo_tenants: list[dict] = [
    {
        "id": "tenant-demo-1",
        "name": "Acme Security Corp",
        "slug": "acme-security",
        "plan": "enterprise",
        "max_sites": -1,
        "max_users": -1,
        "user_count": 18,
        "site_count": 4,
        "camera_count": 127,
        "created_at": "2025-01-10T08:00:00Z",
        "disabled": False,
        "branding": {
            "primary_color": "#06b6d4",
            "accent_color": "#8b5cf6",
            "logo_url": None,
            "login_background_url": None,
            "footer_text": "Acme Security Corp © 2026",
        },
    },
    {
        "id": "tenant-demo-2",
        "name": "Metro Transit Authority",
        "slug": "metro-transit",
        "plan": "professional",
        "max_sites": 5,
        "max_users": 20,
        "user_count": 11,
        "site_count": 3,
        "camera_count": 58,
        "created_at": "2025-03-22T14:30:00Z",
        "disabled": False,
        "branding": {
            "primary_color": "#f59e0b",
            "accent_color": "#10b981",
            "logo_url": None,
            "login_background_url": None,
            "footer_text": "Metro Transit Authority — Safety Division",
        },
    },
    {
        "id": "tenant-demo-3",
        "name": "Riverside Mall",
        "slug": "riverside-mall",
        "plan": "basic",
        "max_sites": 1,
        "max_users": 3,
        "user_count": 2,
        "site_count": 1,
        "camera_count": 12,
        "created_at": "2025-06-05T09:15:00Z",
        "disabled": False,
        "branding": {
            "primary_color": "#ec4899",
            "accent_color": "#f97316",
            "logo_url": None,
            "login_background_url": None,
            "footer_text": "Riverside Mall Security",
        },
    },
]


def _find_tenant(tenant_id: str) -> Optional[dict]:
    return next((t for t in _demo_tenants if t["id"] == tenant_id), None)


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
    """Return all tenants (demo store)."""
    return {
        "tenants": _demo_tenants,
        "total": len(_demo_tenants),
        "total_users": sum(t["user_count"] for t in _demo_tenants),
        "total_cameras": sum(t["camera_count"] for t in _demo_tenants),
        "total_sites": sum(t["site_count"] for t in _demo_tenants),
    }


@admin_router.post("/tenants")
async def create_tenant(body: TenantCreate):
    """Create a new tenant organisation."""
    if any(t["slug"] == body.slug for t in _demo_tenants):
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
    _demo_tenants.append(new_tenant)
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
