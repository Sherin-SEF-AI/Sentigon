"""Crowd Management Protocols — evaluate crowd status and get recommendations."""
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

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/crowd-protocols", tags=["crowd-protocols"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class CrowdStatusRequest(BaseModel):
    zone_id: str = Field(..., description="Zone identifier")
    person_count: int = Field(..., ge=0, description="Current person count in zone")
    density: float = Field(..., ge=0.0, description="People per square meter")
    sentiment: str = Field("neutral", description="Overall crowd sentiment")
    stampede_risk: float = Field(0.0, ge=0.0, le=1.0, description="Stampede risk score 0-1")
    area_capacity: int = Field(..., ge=1, description="Maximum capacity of the area")


class ProtocolResponse(BaseModel):
    zone_id: str
    protocol_level: str
    recommendations: List[str]
    occupancy_percent: float
    stampede_risk: float
    generated_at: str


# ── Protocol Definitions ──────────────────────────────────────────────────────

PROTOCOL_LEVELS = {
    "NORMAL": {
        "level": "NORMAL",
        "description": "Normal operations, no crowd concerns.",
        "recommendations": [
            "Continue standard monitoring",
            "Maintain regular patrol schedule",
        ],
    },
    "ELEVATED": {
        "level": "ELEVATED",
        "description": "Elevated crowd density detected.",
        "recommendations": [
            "Increase monitoring frequency on affected zones",
            "Alert patrol units to standby",
            "Open additional entry/exit points if available",
            "Activate crowd count displays",
        ],
    },
    "HIGH": {
        "level": "HIGH",
        "description": "High crowd density, potential safety risk.",
        "recommendations": [
            "Deploy additional security personnel to zone",
            "Activate one-way flow restrictions",
            "Issue crowd advisory via PA system",
            "Prepare evacuation routes",
            "Notify incident commander",
        ],
    },
    "CRITICAL": {
        "level": "CRITICAL",
        "description": "Critical crowd emergency, immediate action required.",
        "recommendations": [
            "IMMEDIATE: Halt all entry to affected zone",
            "Activate emergency evacuation protocol",
            "Deploy all available security to control points",
            "Contact emergency services (police, EMS)",
            "Open all emergency exits",
            "Activate public address system with evacuation instructions",
            "Begin controlled crowd dispersal from perimeter",
        ],
    },
}


def _determine_protocol_level(
    density: float,
    occupancy_percent: float,
    stampede_risk: float,
) -> str:
    """Determine the protocol level based on crowd metrics."""
    if stampede_risk >= 0.7 or density >= 4.0 or occupancy_percent >= 95:
        return "CRITICAL"
    elif density >= 2.5 or occupancy_percent >= 80 or stampede_risk >= 0.4:
        return "HIGH"
    elif density >= 1.0 or occupancy_percent >= 60 or stampede_risk >= 0.2:
        return "ELEVATED"
    else:
        return "NORMAL"


# ── Tension mapping ───────────────────────────────────────────────────────────

_TENSION_MAP = {"NORMAL": 10, "ELEVATED": 45, "HIGH": 70, "CRITICAL": 90}
_SEVERITY_MAP = {"NORMAL": "low", "ELEVATED": "medium", "HIGH": "high", "CRITICAL": "critical"}


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=dict)
async def list_crowd_protocols(_user=Depends(get_current_user)):
    """Get all crowd protocols with current tension level."""
    current_level = "NORMAL"
    try:
        from backend.services.crowd_protocol_service import crowd_protocol_service
        status = await crowd_protocol_service.get_status()
        if isinstance(status, dict):
            current_level = status.get("level", "NORMAL").upper()
    except (ImportError, AttributeError):
        pass

    current_tension = _TENSION_MAP.get(current_level, 10)
    now = datetime.now(timezone.utc).isoformat()

    protocols = []
    for key, proto in PROTOCOL_LEVELS.items():
        is_current = key == current_level
        protocols.append({
            "id": key.lower(),
            "name": f"{key.title()} Protocol",
            "description": proto["description"],
            "severity": _SEVERITY_MAP.get(key, "low"),
            "status": "active" if is_current else "standby",
            "tension_level": _TENSION_MAP.get(key, 0),
            "recommended_actions": proto["recommendations"],
            "crowd_state": key.lower(),
            "updated_at": now,
        })

    return {"protocols": protocols, "current_tension": current_tension}


@router.get("/status", response_model=dict)
async def get_crowd_protocol_status(_user=Depends(get_current_user)):
    """Get current crowd protocol status.

    Tries crowd_protocol_service if available, otherwise returns NORMAL.
    """
    try:
        try:
            from backend.services.crowd_protocol_service import crowd_protocol_service

            status = await crowd_protocol_service.get_status()
            return status if isinstance(status, dict) else {"level": "NORMAL"}
        except (ImportError, AttributeError):
            logger.info("crowd_protocol_service not available, returning NORMAL")

        return {
            "level": "NORMAL",
            "description": "Normal operations, no crowd concerns.",
            "active_zones": [],
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to get crowd protocol status")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/evaluate", response_model=dict)
async def evaluate_crowd_status(
    body: CrowdStatusRequest,
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Evaluate crowd status and get recommendations (OPERATOR).

    Calls crowd_protocol_service if available, otherwise uses built-in rules.
    """
    try:
        occupancy_percent = (body.person_count / body.area_capacity * 100) if body.area_capacity > 0 else 0.0

        # Try crowd_protocol_service first
        try:
            from backend.services.crowd_protocol_service import crowd_protocol_service

            result = await crowd_protocol_service.evaluate(
                zone_id=body.zone_id,
                person_count=body.person_count,
                density=body.density,
                sentiment=body.sentiment,
                stampede_risk=body.stampede_risk,
                area_capacity=body.area_capacity,
            )
            if isinstance(result, dict):
                return result
        except (ImportError, AttributeError):
            logger.info("crowd_protocol_service not available, using built-in evaluation")

        # Built-in evaluation
        level = _determine_protocol_level(body.density, occupancy_percent, body.stampede_risk)
        protocol = PROTOCOL_LEVELS[level]

        return {
            "zone_id": body.zone_id,
            "protocol_level": level,
            "description": protocol["description"],
            "recommendations": protocol["recommendations"],
            "person_count": body.person_count,
            "density": body.density,
            "occupancy_percent": round(occupancy_percent, 1),
            "stampede_risk": body.stampede_risk,
            "sentiment": body.sentiment,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to evaluate crowd status")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{protocol_id}/activate", response_model=dict)
async def activate_protocol(
    protocol_id: str,
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Activate a crowd protocol by ID (OPERATOR).

    Valid IDs: normal, elevated, high, critical.
    """
    level = protocol_id.upper()
    protocol = PROTOCOL_LEVELS.get(level)
    if not protocol:
        raise HTTPException(
            status_code=404,
            detail=f"Protocol '{protocol_id}' not found. "
                   f"Valid IDs: {', '.join(k.lower() for k in PROTOCOL_LEVELS)}",
        )

    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": protocol_id.lower(),
        "name": f"{level.title()} Protocol",
        "description": protocol["description"],
        "severity": _SEVERITY_MAP.get(level, "low"),
        "status": "active",
        "tension_level": _TENSION_MAP.get(level, 0),
        "recommended_actions": protocol["recommendations"],
        "crowd_state": protocol_id.lower(),
        "updated_at": now,
        "message": f"Protocol '{level}' activated successfully.",
    }


@router.post("/{protocol_id}/deactivate", response_model=dict)
async def deactivate_protocol(
    protocol_id: str,
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Deactivate a crowd protocol, returning it to standby (OPERATOR)."""
    level = protocol_id.upper()
    protocol = PROTOCOL_LEVELS.get(level)
    if not protocol:
        raise HTTPException(
            status_code=404,
            detail=f"Protocol '{protocol_id}' not found. "
                   f"Valid IDs: {', '.join(k.lower() for k in PROTOCOL_LEVELS)}",
        )

    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": protocol_id.lower(),
        "name": f"{level.title()} Protocol",
        "description": protocol["description"],
        "severity": _SEVERITY_MAP.get(level, "low"),
        "status": "standby",
        "tension_level": _TENSION_MAP.get(level, 0),
        "recommended_actions": protocol["recommendations"],
        "crowd_state": protocol_id.lower(),
        "updated_at": now,
        "message": f"Protocol '{level}' deactivated.",
    }


@router.get("/recommendations/{level}", response_model=dict)
async def get_recommendations_for_level(
    level: str,
    _user=Depends(get_current_user),
):
    """Get recommendations for a given protocol level (NORMAL, ELEVATED, HIGH, CRITICAL)."""
    try:
        level_upper = level.upper()
        protocol = PROTOCOL_LEVELS.get(level_upper)
        if not protocol:
            raise HTTPException(
                status_code=404,
                detail=f"Protocol level '{level}' not found. "
                       f"Valid levels: {', '.join(PROTOCOL_LEVELS.keys())}",
            )

        return {
            "level": level_upper,
            "description": protocol["description"],
            "recommendations": protocol["recommendations"],
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to get recommendations for level %s", level)
        raise HTTPException(status_code=500, detail=str(exc))
