"""Incident Replay API — browse, replay, and simulate recorded incidents."""
from __future__ import annotations

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from backend.api.auth import get_current_user, require_role
from backend.models.models import UserRole
from backend.services.incident_recorder import incident_recorder

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/incident-replay", tags=["incident-replay"])


# ── Schemas ──────────────────────────────────────────────────

class RecordingStart(BaseModel):
    title: str
    camera_ids: Optional[list] = None
    zone_ids: Optional[list] = None
    alert_id: Optional[str] = None
    case_id: Optional[str] = None
    pre_buffer_seconds: int = 60


class SimulationRequest(BaseModel):
    anomaly_threshold: float = 0.5
    crowd_threshold: int = 10
    dwell_threshold: int = 300


# ── Incident List ────────────────────────────────────────────

@router.get("/incidents")
async def list_incidents(
    status: Optional[str] = Query(None, description="Filter by status"),
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """List recorded incidents."""
    return await incident_recorder.list_incidents(status=status, limit=limit)


@router.get("/incidents/{incident_id}")
async def get_incident(incident_id: uuid.UUID, _user=Depends(get_current_user)):
    """Get incident metadata."""
    result = await incident_recorder.get_incident(str(incident_id))
    if not result:
        raise HTTPException(status_code=404, detail="Incident not found")
    return result


# ── Frames & Actions ─────────────────────────────────────────

@router.get("/incidents/{incident_id}/frames")
async def get_incident_frames(
    incident_id: uuid.UUID,
    start_offset: float = Query(0.0, description="Seconds from incident start"),
    duration: float = Query(60.0, ge=1, le=600),
    camera_id: Optional[str] = Query(None),
    _user=Depends(get_current_user),
):
    """Get frames for a time slice of an incident."""
    return await incident_recorder.get_frames(
        str(incident_id),
        start_offset=start_offset,
        duration=duration,
        camera_id=camera_id,
    )


@router.get("/incidents/{incident_id}/agent-actions")
async def get_agent_actions(
    incident_id: uuid.UUID,
    start_offset: float = Query(0.0),
    duration: Optional[float] = Query(None),
    _user=Depends(get_current_user),
):
    """Get agent decision timeline for an incident."""
    return await incident_recorder.get_agent_actions(
        str(incident_id),
        start_offset=start_offset,
        duration=duration,
    )


# ── Recording Control ────────────────────────────────────────

@router.post("/incidents/record")
async def start_recording(
    body: RecordingStart,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Manually start recording an incident."""
    return await incident_recorder.start_recording(
        title=body.title,
        camera_ids=body.camera_ids,
        zone_ids=body.zone_ids,
        alert_id=body.alert_id,
        case_id=body.case_id,
        pre_buffer_seconds=body.pre_buffer_seconds,
    )


@router.post("/incidents/{incident_id}/stop")
async def stop_recording(
    incident_id: uuid.UUID,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Stop an active recording."""
    result = await incident_recorder.stop_recording(str(incident_id))
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.get("/active")
async def get_active_recordings(_user=Depends(get_current_user)):
    """Get currently active recordings."""
    active_ids = incident_recorder.get_active_recordings()
    return {"active_recordings": active_ids, "count": len(active_ids)}


# ── Replay & Simulation ─────────────────────────────────────

@router.post("/incidents/{incident_id}/multicam-slice")
async def get_multicam_slice(
    incident_id: uuid.UUID,
    start_offset: float = Query(0.0),
    duration: float = Query(30.0, ge=1, le=300),
    _user=Depends(get_current_user),
):
    """Get replay frames grouped by camera for multi-camera synchronized view."""
    frames = await incident_recorder.get_frames(
        str(incident_id), start_offset=start_offset, duration=duration,
    )
    # Group frames by camera_id
    cameras: dict[str, list] = {}
    for f in frames:
        cam_id = f.get("camera_id", "unknown")
        if cam_id not in cameras:
            cameras[cam_id] = []
        cameras[cam_id].append(f)
    return {
        "incident_id": str(incident_id),
        "start_offset": start_offset,
        "duration": duration,
        "cameras": cameras,
        "camera_count": len(cameras),
    }


@router.post("/incidents/{incident_id}/reconstruct")
async def reconstruct_incident(
    incident_id: uuid.UUID,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """AI-powered incident reconstruction — generates narrative, key moments, entity tracking."""
    try:
        from backend.services.incident_reconstruction import incident_reconstructor
        result = await incident_reconstructor.reconstruct(str(incident_id))
        if "error" in result:
            raise HTTPException(status_code=404, detail=result["error"])
        return result
    except ImportError:
        raise HTTPException(status_code=501, detail="Incident reconstruction service not available")
    except Exception as e:
        logger.error("Incident reconstruction failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/incidents/{incident_id}/replay-slice")
async def get_replay_slice(
    incident_id: uuid.UUID,
    start_offset: float = Query(0.0),
    duration: float = Query(30.0, ge=1, le=300),
    _user=Depends(get_current_user),
):
    """Get a combined replay slice with frames and agent actions."""
    frames = await incident_recorder.get_frames(
        str(incident_id), start_offset=start_offset, duration=duration,
    )
    actions = await incident_recorder.get_agent_actions(
        str(incident_id), start_offset=start_offset, duration=duration,
    )
    return {
        "incident_id": str(incident_id),
        "start_offset": start_offset,
        "duration": duration,
        "frames": frames,
        "agent_actions": actions,
    }


@router.post("/incidents/{incident_id}/simulate")
async def run_simulation(
    incident_id: uuid.UUID,
    body: SimulationRequest,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Run what-if simulation with modified thresholds."""
    result = await incident_recorder.simulate_with_thresholds(
        str(incident_id),
        threshold_overrides={
            "anomaly_threshold": body.anomaly_threshold,
            "crowd_threshold": body.crowd_threshold,
            "dwell_threshold": body.dwell_threshold,
        },
    )
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result
