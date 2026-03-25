"""Emergency Codes API — activate, deactivate, and query emergency codes.

No authentication is required by design: emergencies must be actionable even
if the auth subsystem is degraded.

Prefix: /api/emergency
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/emergency", tags=["emergency"])


# ── Schemas ───────────────────────────────────────────────────────────────────


class ActivateRequest(BaseModel):
    code: str = Field(..., description="Emergency code name, e.g. 'Code Blue'")
    notes: Optional[str] = Field(None, description="Optional operator notes")
    site_id: Optional[str] = Field(None, description="Optional site/facility ID")


class DeactivateRequest(BaseModel):
    code: str = Field(..., description="Emergency code name to deactivate")
    notes: Optional[str] = Field(None, description="Optional resolution notes")


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("/codes")
async def list_codes():
    """List all known emergency codes from every industry template."""
    try:
        from backend.services.emergency_codes import get_all_codes

        codes = get_all_codes()
        return {"codes": codes, "total": len(codes)}
    except Exception as exc:
        logger.exception("emergency.list_codes.error")
        return {"codes": [], "total": 0, "error": str(exc)}


@router.get("/active")
async def list_active():
    """List all currently active emergencies."""
    try:
        from backend.services.emergency_codes import get_active_emergencies

        active = get_active_emergencies()
        return {"active": active, "count": len(active)}
    except Exception as exc:
        logger.exception("emergency.list_active.error")
        return {"active": [], "count": 0, "error": str(exc)}


@router.get("/history")
async def get_history(limit: int = 20):
    """Return recent emergency activations (default last 20)."""
    try:
        from backend.services.emergency_codes import get_emergency_history

        capped_limit = max(1, min(limit, 200))
        history = get_emergency_history(limit=capped_limit)
        return {"history": history, "count": len(history)}
    except Exception as exc:
        logger.exception("emergency.history.error")
        return {"history": [], "count": 0, "error": str(exc)}


@router.post("/activate")
async def activate_emergency(body: ActivateRequest):
    """Activate an emergency code.

    No auth required — emergencies must work even if auth is broken.
    """
    try:
        from backend.services.emergency_codes import activate_emergency as _activate

        record = _activate(
            code=body.code,
            activated_by="operator",
            site_id=body.site_id,
            notes=body.notes,
        )

        if record.get("status") == "active":
            logger.warning("emergency.api.activated", code=body.code)
            return {"success": True, "record": record, "message": f"Emergency '{body.code}' activated"}
        else:
            return {"success": False, "record": record, "message": f"Emergency '{body.code}' was already active"}
    except Exception as exc:
        logger.exception("emergency.activate.error", code=body.code)
        return {"success": False, "error": str(exc), "message": f"Failed to activate '{body.code}'"}


@router.post("/deactivate")
async def deactivate_emergency(body: DeactivateRequest):
    """Deactivate an active emergency code.

    No auth required — emergencies must work even if auth is broken.
    """
    try:
        from backend.services.emergency_codes import deactivate_emergency as _deactivate

        record = _deactivate(code=body.code, deactivated_by="operator")

        if "error" in record:
            return {"success": False, "record": record, "message": record["error"]}

        logger.warning("emergency.api.deactivated", code=body.code)
        return {"success": True, "record": record, "message": f"Emergency '{body.code}' resolved"}
    except Exception as exc:
        logger.exception("emergency.deactivate.error", code=body.code)
        return {"success": False, "error": str(exc), "message": f"Failed to deactivate '{body.code}'"}
