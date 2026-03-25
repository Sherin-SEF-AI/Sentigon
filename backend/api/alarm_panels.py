"""Alarm panel management — arm/disarm, zone control, SIA receiver, and event queries."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.alarm_panel_service import (
    alarm_service,
    AlarmPanel,
    AlarmZone,
    AlarmZoneType,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/alarm", tags=["Alarm Panels"])


# ── Request Schemas ────────────────────────────────────────────────────────────

class RegisterPanelRequest(BaseModel):
    id: str = Field(..., description="Unique panel identifier")
    name: str = Field(..., description="Human-readable panel name")
    model: str = Field("", description="Panel model / manufacturer")
    ip_address: str = Field("", description="Panel IP address")
    port: int = Field(0, description="Panel communication port")


class ArmPanelRequest(BaseModel):
    mode: str = Field(..., description="Arm mode: away, stay, or night")


class AddZoneRequest(BaseModel):
    zone_number: int = Field(..., description="Numeric zone identifier")
    name: str = Field(..., description="Zone display name")
    zone_type: str = Field(..., description="Zone type (perimeter, interior, entry_exit, fire, panic, medical, environmental)")
    camera_id: Optional[int] = Field(None, description="Associated camera ID for alarm verification")
    partition: int = Field(1, description="Partition number")


class ContactIDRequest(BaseModel):
    raw_message: str = Field(..., description="Raw Contact ID protocol message")


class SIAReceiverRequest(BaseModel):
    host: str = Field("0.0.0.0", description="Bind address for the SIA receiver")
    port: int = Field(5000, description="Listening port for the SIA receiver")


class AcknowledgeEventRequest(BaseModel):
    acknowledged_by: Optional[str] = Field(None, description="Operator who acknowledged the event")
    notes: Optional[str] = Field(None, description="Acknowledgement notes")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_alarm_status():
    """Return overall alarm system status including all panels, zones, and stats."""
    try:
        return alarm_service.get_status()
    except Exception as exc:
        logger.exception("Failed to get alarm status")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/panels", status_code=201)
async def register_panel(body: RegisterPanelRequest):
    """Register a new alarm panel with the system."""
    try:
        if body.id in alarm_service.panels:
            raise HTTPException(status_code=409, detail=f"Panel '{body.id}' already registered")
        panel = AlarmPanel(
            panel_id=body.id,
            name=body.name,
            model=body.model,
            ip_address=body.ip_address,
            port=body.port,
        )
        alarm_service.register_panel(panel)
        return {"panel_id": body.id, "name": body.name, "status": "registered"}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to register alarm panel")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/panels/{panel_id}")
async def get_panel(panel_id: str):
    """Get details for a specific alarm panel."""
    try:
        status = alarm_service.get_status()
        panel_data = status["panels"].get(panel_id)
        if not panel_data:
            raise HTTPException(status_code=404, detail=f"Panel '{panel_id}' not found")
        return {"panel_id": panel_id, **panel_data}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to get panel details")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/panels/{panel_id}/arm")
async def arm_panel(panel_id: str, body: ArmPanelRequest):
    """Arm an alarm panel in the specified mode (away, stay, or night)."""
    try:
        valid_modes = {"away", "stay", "night"}
        if body.mode not in valid_modes:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid arm mode '{body.mode}'. Must be one of: {', '.join(sorted(valid_modes))}",
            )
        success = await alarm_service.arm_panel(panel_id, body.mode)
        if not success:
            raise HTTPException(status_code=404, detail=f"Panel '{panel_id}' not found")
        return {"panel_id": panel_id, "arm_state": f"armed_{body.mode}", "status": "armed"}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to arm panel")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/panels/{panel_id}/disarm")
async def disarm_panel(panel_id: str):
    """Disarm an alarm panel and clear active alarms."""
    try:
        success = await alarm_service.disarm_panel(panel_id)
        if not success:
            raise HTTPException(status_code=404, detail=f"Panel '{panel_id}' not found")
        return {"panel_id": panel_id, "arm_state": "disarmed", "status": "disarmed"}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to disarm panel")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/panels/{panel_id}/zones/{zone_number}/bypass")
async def bypass_zone(panel_id: str, zone_number: int):
    """Bypass a specific zone on a panel."""
    try:
        success = await alarm_service.bypass_zone(panel_id, zone_number)
        if not success:
            raise HTTPException(
                status_code=404,
                detail=f"Panel '{panel_id}' or zone {zone_number} not found",
            )
        return {"panel_id": panel_id, "zone_number": zone_number, "status": "bypassed"}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to bypass zone")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/panels/{panel_id}/zones", status_code=201)
async def add_zone(panel_id: str, body: AddZoneRequest):
    """Add a zone to an existing alarm panel."""
    try:
        panel = alarm_service.panels.get(panel_id)
        if not panel:
            raise HTTPException(status_code=404, detail=f"Panel '{panel_id}' not found")
        if body.zone_number in panel.zones:
            raise HTTPException(
                status_code=409,
                detail=f"Zone {body.zone_number} already exists on panel '{panel_id}'",
            )
        try:
            zone_type = AlarmZoneType(body.zone_type)
        except ValueError:
            valid = [t.value for t in AlarmZoneType]
            raise HTTPException(
                status_code=422,
                detail=f"Invalid zone_type '{body.zone_type}'. Must be one of: {', '.join(valid)}",
            )
        zone = AlarmZone(
            zone_number=body.zone_number,
            name=body.name,
            zone_type=zone_type,
            camera_id=body.camera_id,
            partition=body.partition,
        )
        panel.zones[body.zone_number] = zone
        return {
            "panel_id": panel_id,
            "zone_number": body.zone_number,
            "name": body.name,
            "status": "added",
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to add zone")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/panels/{panel_id}/contact-id")
async def process_contact_id(panel_id: str, body: ContactIDRequest):
    """Process a raw Contact ID protocol message for a panel."""
    try:
        if panel_id not in alarm_service.panels:
            raise HTTPException(status_code=404, detail=f"Panel '{panel_id}' not found")
        event = await alarm_service.process_contact_id(panel_id, body.raw_message)
        if event is None:
            raise HTTPException(status_code=422, detail="Failed to parse Contact ID message")
        return {
            "event_id": event.event_id,
            "event_code": event.event_code,
            "event_description": event.event_description,
            "zone_number": event.zone_number,
            "partition": event.partition,
            "qualifier": event.qualifier,
            "is_alarm": event.is_alarm,
            "timestamp": event.timestamp,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to process Contact ID message")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/events")
async def get_events(
    panel_id: Optional[str] = Query(None, description="Filter by panel ID"),
    is_alarm: Optional[bool] = Query(None, description="Filter for alarm events only"),
    limit: int = Query(100, ge=1, le=1000, description="Max events to return"),
):
    """Query alarm events with optional filters."""
    try:
        return alarm_service.get_events(
            panel_id=panel_id,
            is_alarm=is_alarm,
            limit=limit,
        )
    except Exception as exc:
        logger.exception("Failed to get alarm events")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/events/{event_id}/acknowledge")
async def acknowledge_event(event_id: str, body: AcknowledgeEventRequest):
    """Acknowledge an alarm event by its ID."""
    try:
        target = None
        for event in alarm_service.events:
            if event.event_id == event_id:
                target = event
                break
        if target is None:
            raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
        target.is_verified = True
        return {
            "event_id": event_id,
            "acknowledged": True,
            "acknowledged_by": body.acknowledged_by,
            "notes": body.notes,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to acknowledge event")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/sia/start")
async def start_sia_receiver(body: SIAReceiverRequest):
    """Start the SIA DC-07 protocol receiver."""
    try:
        if alarm_service._sia_receiver is not None:
            raise HTTPException(status_code=409, detail="SIA receiver is already running")
        await alarm_service.start_sia_receiver(host=body.host, port=body.port)
        return {"host": body.host, "port": body.port, "status": "started"}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to start SIA receiver")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/sia/stop")
async def stop_sia_receiver():
    """Stop the SIA DC-07 protocol receiver."""
    try:
        if alarm_service._sia_receiver is None:
            raise HTTPException(status_code=404, detail="SIA receiver is not running")
        await alarm_service._sia_receiver.stop()
        alarm_service._sia_receiver = None
        return {"status": "stopped"}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to stop SIA receiver")
        raise HTTPException(status_code=500, detail=str(exc))
