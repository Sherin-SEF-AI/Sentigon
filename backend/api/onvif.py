"""ONVIF Camera Management API — discovery, connection, PTZ control, snapshots.

Prefix: /api/onvif
Tag:    ONVIF

Exposes the ONVIFService singleton as REST endpoints consumed by the
Camera Management frontend (cameras/page.tsx ONVIF tab).
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.services.onvif_service import onvif_service, PTZDirection

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/onvif", tags=["ONVIF"])


# ── Request schemas ──────────────────────────────────────────


class ConnectRequest(BaseModel):
    ip: str
    port: int = 80
    username: str = "admin"
    password: str = "admin"


class PTZRequest(BaseModel):
    ip: str
    port: int = 80
    profile_token: Optional[str] = None
    action: str  # move | stop | zoom | goto_preset | set_preset
    direction: Optional[str] = None  # up/down/left/right/up_left/up_right/down_left/down_right/in/out
    speed: float = 0.5
    preset_token: Optional[str] = None
    preset_name: Optional[str] = None


class DisconnectRequest(BaseModel):
    ip: str
    port: int = 80


class SnapshotRequest(BaseModel):
    ip: str
    port: int = 80
    profile_token: Optional[str] = None


# ── Endpoints ────────────────────────────────────────────────


@router.post("/discover")
async def discover_devices(timeout: int = 5):
    """Discover ONVIF cameras on the local network via WS-Discovery."""
    try:
        discovered = await onvif_service.discover_devices(timeout=timeout)
        return [
            {
                "ip": d.ip,
                "port": d.port,
                "name": d.name,
                "manufacturer": d.manufacturer,
                "model": d.model,
            }
            for d in discovered
        ]
    except Exception as e:
        logger.error("Discovery error: %s", e)
        raise HTTPException(500, f"Discovery failed: {e}")


@router.get("/devices")
async def list_devices():
    """List all known ONVIF devices (discovered + connected)."""
    return onvif_service.list_devices()


@router.post("/connect")
async def connect_device(body: ConnectRequest):
    """Connect to an ONVIF device and retrieve its capabilities."""
    try:
        device = await onvif_service.connect_device(
            ip=body.ip,
            port=body.port,
            username=body.username,
            password=body.password,
        )
        return {
            "ip": device.ip,
            "port": device.port,
            "device_info": {
                "manufacturer": device.manufacturer,
                "model": device.model,
                "firmware_version": device.firmware,
                "serial_number": device.serial,
                "hardware_id": device.hardware_id,
            },
            "profiles": device.profiles,
            "stream_uris": device.stream_uris,
            "ptz_supported": device.ptz_supported,
            "analytics_supported": device.analytics_supported,
            "events_supported": device.events_supported,
            "presets": device.ptz_presets,
        }
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        logger.error("Connect error: %s", e)
        raise HTTPException(500, f"Connection failed: {e}")


@router.post("/disconnect")
async def disconnect_device(body: DisconnectRequest):
    """Disconnect from an ONVIF device."""
    await onvif_service.disconnect_device(body.ip, body.port)
    return {"ip": body.ip, "port": body.port, "message": "Disconnected"}


@router.post("/ptz")
async def ptz_control(body: PTZRequest):
    """Control PTZ: move, stop, zoom, goto_preset, set_preset."""
    if body.action == "move":
        if not body.direction:
            raise HTTPException(400, "direction is required for move action")
        direction_map = {
            "up": PTZDirection.UP,
            "down": PTZDirection.DOWN,
            "left": PTZDirection.LEFT,
            "right": PTZDirection.RIGHT,
            "up_left": PTZDirection.UP_LEFT,
            "up_right": PTZDirection.UP_RIGHT,
            "down_left": PTZDirection.DOWN_LEFT,
            "down_right": PTZDirection.DOWN_RIGHT,
        }
        direction = direction_map.get(body.direction)
        if not direction:
            raise HTTPException(400, f"Invalid direction: {body.direction}")
        ok = await onvif_service.ptz_move(
            body.ip, body.port, direction, body.speed, body.profile_token,
        )
        return {"success": ok, "action": "move", "direction": body.direction}

    elif body.action == "stop":
        ok = await onvif_service.ptz_stop(body.ip, body.port, body.profile_token)
        return {"success": ok, "action": "stop"}

    elif body.action == "zoom":
        if not body.direction:
            raise HTTPException(400, "direction (in/out) is required for zoom")
        direction = PTZDirection.ZOOM_IN if body.direction == "in" else PTZDirection.ZOOM_OUT
        ok = await onvif_service.ptz_move(
            body.ip, body.port, direction, body.speed, body.profile_token,
        )
        return {"success": ok, "action": "zoom", "direction": body.direction}

    elif body.action == "goto_preset":
        if not body.preset_token:
            raise HTTPException(400, "preset_token is required")
        ok = await onvif_service.ptz_goto_preset(
            body.ip, body.port, body.preset_token, body.speed, body.profile_token,
        )
        return {"success": ok, "action": "goto_preset", "preset": body.preset_token}

    elif body.action == "set_preset":
        if not body.preset_name:
            raise HTTPException(400, "preset_name is required")
        token = await onvif_service.ptz_set_preset(
            body.ip, body.port, body.preset_name, body.profile_token,
        )
        return {"success": token is not None, "action": "set_preset", "preset_token": token}

    else:
        raise HTTPException(400, f"Unknown action: {body.action}")


@router.get("/ptz/status")
async def ptz_status(ip: str, port: int = 80, profile_token: Optional[str] = None):
    """Get current PTZ position (pan, tilt, zoom)."""
    key = f"{ip}:{port}"
    cam = onvif_service._onvif_cameras.get(key)
    if not cam:
        raise HTTPException(404, f"Device {key} not connected")
    device = onvif_service.devices.get(key)
    if not device or not device.ptz_supported:
        raise HTTPException(400, "PTZ not supported on this device")
    if not profile_token and device.profiles:
        profile_token = device.profiles[0]["token"]
    try:
        import asyncio
        ptz_service = cam.create_ptz_service()
        status = await asyncio.get_event_loop().run_in_executor(
            None, ptz_service.GetStatus, {"ProfileToken": profile_token}
        )
        pos = status.Position if hasattr(status, "Position") else None
        return {
            "pan": float(pos.PanTilt.x) if pos and hasattr(pos, "PanTilt") else 0.0,
            "tilt": float(pos.PanTilt.y) if pos and hasattr(pos, "PanTilt") else 0.0,
            "zoom": float(pos.Zoom.x) if pos and hasattr(pos, "Zoom") else 0.0,
        }
    except Exception as e:
        logger.error("PTZ status error: %s", e)
        return {"pan": 0.0, "tilt": 0.0, "zoom": 0.0}


@router.post("/snapshot")
async def get_snapshot(body: SnapshotRequest):
    """Capture a JPEG snapshot from an ONVIF camera."""
    image_bytes = await onvif_service.get_snapshot(
        body.ip, body.port, body.profile_token,
    )
    if not image_bytes:
        raise HTTPException(500, "Failed to capture snapshot")
    return Response(content=image_bytes, media_type="image/jpeg")


@router.get("/stream-uri")
async def get_stream_uri(ip: str, port: int = 80, profile_token: Optional[str] = None):
    """Get the RTSP stream URI for a connected ONVIF device."""
    uri = onvif_service.get_stream_uri(ip, port, profile_token)
    if not uri:
        raise HTTPException(404, "No stream URI available")
    return {"ip": ip, "port": port, "profile_token": profile_token, "stream_uri": uri}
