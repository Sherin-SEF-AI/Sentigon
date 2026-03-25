"""Intercom / VoIP management — calls, door release, broadcast, and device control."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.intercom_service import (
    intercom_service,
    IntercomDevice,
    IntercomState,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/intercom", tags=["Intercom"])


# ── Request Schemas ────────────────────────────────────────────────────────────

class RegisterDeviceRequest(BaseModel):
    id: str = Field(..., description="Unique device identifier")
    name: str = Field(..., description="Human-readable device name")
    zone: str = Field(..., description="Zone the device belongs to")
    ip_address: str = Field(..., description="Device IP address")
    sip_uri: str = Field(..., description="SIP URI (e.g. sip:lobby@pbx.local)")
    has_door_release: bool = Field(False, description="Whether the device has a door release relay")
    has_camera: bool = Field(False, description="Whether the device has a built-in camera")
    camera_id: Optional[str] = Field(None, description="Associated camera ID")
    volume: int = Field(75, ge=0, le=100, description="Initial speaker volume (0-100)")


class CallActionRequest(BaseModel):
    action: str = Field(..., description="Call action: call, end, or answer")
    caller: Optional[str] = Field(None, description="Caller identifier (required for 'call' action)")


class VolumeRequest(BaseModel):
    level: int = Field(..., ge=0, le=100, description="Volume level 0-100")


class BroadcastRequest(BaseModel):
    message: str = Field(..., description="Announcement message text")
    zone: Optional[str] = Field(None, description="Target zone (broadcast to all devices in zone)")
    device_ids: Optional[List[str]] = Field(None, description="Explicit list of device IDs to target")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_intercom_status():
    """Return overall intercom system status including device counts, active calls, and stats."""
    try:
        return intercom_service.get_status()
    except Exception as exc:
        logger.exception("Failed to get intercom status")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/devices")
async def list_devices():
    """List all registered intercom devices."""
    try:
        return intercom_service.list_devices()
    except Exception as exc:
        logger.exception("Failed to list intercom devices")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/devices", status_code=201)
async def register_device(body: RegisterDeviceRequest):
    """Register a new intercom device with the system."""
    try:
        if body.id in intercom_service.devices:
            raise HTTPException(status_code=409, detail=f"Device '{body.id}' already registered")
        device = IntercomDevice(
            id=body.id,
            name=body.name,
            zone=body.zone,
            ip_address=body.ip_address,
            sip_uri=body.sip_uri,
            has_door_release=body.has_door_release,
            has_camera=body.has_camera,
            camera_id=body.camera_id,
            volume=body.volume,
        )
        intercom_service.register_device(device)
        return {"device_id": body.id, "name": body.name, "status": "registered"}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to register intercom device")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/devices/{device_id}")
async def get_device(device_id: str):
    """Get details for a specific intercom device."""
    try:
        device = intercom_service.get_device(device_id)
        if not device:
            raise HTTPException(status_code=404, detail=f"Device '{device_id}' not found")
        return {
            "id": device.id,
            "name": device.name,
            "zone": device.zone,
            "ip_address": device.ip_address,
            "sip_uri": device.sip_uri,
            "state": device.state.value,
            "has_door_release": device.has_door_release,
            "has_camera": device.has_camera,
            "camera_id": device.camera_id,
            "volume": device.volume,
            "last_call_time": device.last_call_time,
            "call_count": device.call_count,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to get intercom device details")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/devices/{device_id}/call")
async def device_call(device_id: str, body: CallActionRequest):
    """Initiate, answer, or end a call on a device."""
    try:
        valid_actions = {"call", "end", "answer"}
        if body.action not in valid_actions:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid action '{body.action}'. Must be one of: {', '.join(sorted(valid_actions))}",
            )

        if body.action == "call":
            if not body.caller:
                raise HTTPException(status_code=422, detail="'caller' is required for the 'call' action")
            call = await intercom_service.initiate_call(device_id, body.caller)
            if not call:
                device = intercom_service.get_device(device_id)
                if not device:
                    raise HTTPException(status_code=404, detail=f"Device '{device_id}' not found")
                raise HTTPException(
                    status_code=409,
                    detail=f"Cannot call device '{device_id}' — current state: {device.state.value}",
                )
            return {
                "call_id": call.call_id,
                "device_id": device_id,
                "caller": call.caller,
                "callee": call.callee,
                "state": call.state.value,
                "direction": call.direction.value,
                "status": "ringing",
            }

        elif body.action == "answer":
            call = await intercom_service.answer_call(device_id)
            if not call:
                raise HTTPException(status_code=404, detail=f"No active call on device '{device_id}' to answer")
            return {
                "call_id": call.call_id,
                "device_id": device_id,
                "state": call.state.value,
                "status": "in_call",
            }

        else:  # end
            call = await intercom_service.end_call(device_id)
            if not call:
                raise HTTPException(status_code=404, detail=f"No active call on device '{device_id}' to end")
            return {
                "call_id": call.call_id,
                "device_id": device_id,
                "duration": round(call.duration, 2),
                "state": call.state.value,
                "status": "ended",
            }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to handle call action on device %s", device_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/devices/{device_id}/door-release")
async def door_release(device_id: str):
    """Trigger the door release relay on a device."""
    try:
        device = intercom_service.get_device(device_id)
        if not device:
            raise HTTPException(status_code=404, detail=f"Device '{device_id}' not found")
        success = await intercom_service.door_release(device_id)
        if not success:
            raise HTTPException(
                status_code=409,
                detail=f"Door release not available on device '{device_id}'",
            )
        return {"device_id": device_id, "device_name": device.name, "status": "released"}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to trigger door release on device %s", device_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/devices/{device_id}/volume")
async def set_volume(device_id: str, body: VolumeRequest):
    """Set the speaker volume on a device (0-100)."""
    try:
        device = intercom_service.get_device(device_id)
        if not device:
            raise HTTPException(status_code=404, detail=f"Device '{device_id}' not found")
        await intercom_service.set_volume(device_id, body.level)
        return {"device_id": device_id, "volume": body.level, "status": "updated"}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to set volume on device %s", device_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/broadcast")
async def broadcast(body: BroadcastRequest):
    """Broadcast an announcement to one or more devices."""
    try:
        result = await intercom_service.broadcast(
            message=body.message,
            zone=body.zone,
            device_ids=body.device_ids,
        )
        if not result["sent"]:
            raise HTTPException(status_code=404, detail=result.get("reason", "No target devices"))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to broadcast announcement")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/calls")
async def get_call_history(
    device_id: Optional[str] = Query(None, description="Filter by device ID"),
    limit: int = Query(50, ge=1, le=1000, description="Max call records to return"),
):
    """Query call history with optional device filter."""
    try:
        return intercom_service.get_call_history(device_id=device_id, limit=limit)
    except Exception as exc:
        logger.exception("Failed to get call history")
        raise HTTPException(status_code=500, detail=str(exc))
