"""Building systems integration API router.

Exposes elevator control, BMS (HVAC + lighting), body camera management,
and SOC 2 compliance audit endpoints under /api/building-systems.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List

from backend.services.elevator_service import elevator_service
from backend.services.bms_service import bms_service
from backend.services.bodycam_service import bodycam_service
from backend.services.compliance_audit import compliance_audit_service

router = APIRouter(prefix="/api/building-systems", tags=["building-systems"])


# ── Elevator endpoints ────────────────────────────────────────

class RegisterElevatorRequest(BaseModel):
    elevator_id: str
    name: str
    floor: int = 1


@router.get("/elevators")
async def get_elevators():
    """List all registered elevators and their current status."""
    return {"elevators": elevator_service.get_all_status()}


@router.post("/elevators/register")
async def register_elevator(req: RegisterElevatorRequest):
    """Register a new elevator controller."""
    status = elevator_service.register_elevator(req.elevator_id, req.name, req.floor)
    return vars(status)


@router.get("/elevators/{elevator_id}")
async def get_elevator(elevator_id: str):
    """Get status of a specific elevator."""
    result = elevator_service.get_status(elevator_id)
    if not result:
        raise HTTPException(status_code=404, detail="Elevator not found")
    return result


@router.post("/elevators/emergency-recall")
async def emergency_recall(target_floor: int = 1):
    """Trigger emergency recall — sends all elevators to the target floor."""
    return await elevator_service.emergency_recall(target_floor)


@router.post("/elevators/emergency-recall/cancel")
async def cancel_emergency_recall():
    """Cancel active emergency recall and restore normal elevator operation."""
    return await elevator_service.cancel_emergency_recall()


@router.post("/elevators/{elevator_id}/lock")
async def lock_elevator(elevator_id: str):
    """Lock an elevator — prevents normal passenger use."""
    return await elevator_service.lock_elevator(elevator_id)


@router.post("/elevators/{elevator_id}/unlock")
async def unlock_elevator(elevator_id: str):
    """Unlock a previously locked elevator."""
    return await elevator_service.unlock_elevator(elevator_id)


# ── BMS endpoints ─────────────────────────────────────────────

class RegisterHVACZoneRequest(BaseModel):
    zone_id: str
    name: str


class RegisterLightingZoneRequest(BaseModel):
    zone_id: str
    name: str


@router.get("/bms/status")
async def bms_status():
    """Get overall BMS system status including HVAC and lighting zones."""
    return bms_service.get_system_status()


@router.post("/bms/hvac/register")
async def register_hvac_zone(req: RegisterHVACZoneRequest):
    """Register an HVAC zone with the BMS service."""
    zone = bms_service.register_hvac_zone(req.zone_id, req.name)
    return vars(zone)


@router.post("/bms/lighting/register")
async def register_lighting_zone(req: RegisterLightingZoneRequest):
    """Register a lighting zone with the BMS service."""
    zone = bms_service.register_lighting_zone(req.zone_id, req.name)
    return vars(zone)


@router.post("/bms/emergency-hvac-shutdown")
async def emergency_hvac(zone_id: Optional[str] = None):
    """Shut down HVAC in all zones (or a specific zone) for fire/emergency response."""
    return await bms_service.emergency_hvac_shutdown(zone_id)


@router.post("/bms/emergency-lighting")
async def emergency_lighting(zone_id: Optional[str] = None):
    """Activate emergency lighting in all zones (or a specific zone)."""
    return await bms_service.activate_emergency_lighting(zone_id)


@router.post("/bms/restore")
async def bms_restore():
    """Restore all BMS systems to normal auto operation after an emergency."""
    return await bms_service.restore_normal_operations()


# ── Body camera endpoints ─────────────────────────────────────

class RegisterBodyCamRequest(BaseModel):
    officer_name: str
    officer_id: str


class TagClipRequest(BaseModel):
    tags: List[str]


class UpdateLocationRequest(BaseModel):
    lat: float
    lon: float


@router.get("/bodycams")
async def get_bodycams():
    """List all registered body cameras and their current status."""
    return {"cameras": bodycam_service.get_all_cameras()}


@router.get("/bodycams/active")
async def get_active_bodycams():
    """List body cameras currently in recording state."""
    return {"cameras": bodycam_service.get_active_cameras()}


@router.post("/bodycams/register")
async def register_bodycam(req: RegisterBodyCamRequest):
    """Register a new body camera assigned to an officer."""
    cam = bodycam_service.register_camera(req.officer_name, req.officer_id)
    return vars(cam)


@router.get("/bodycams/{camera_id}")
async def get_bodycam(camera_id: str):
    """Get status and metadata for a specific body camera."""
    result = bodycam_service.get_camera(camera_id)
    if not result:
        raise HTTPException(status_code=404, detail="Camera not found")
    return result


@router.post("/bodycams/{camera_id}/start-recording")
async def start_bodycam_recording(camera_id: str, incident_id: Optional[str] = None):
    """Start recording on a body camera, optionally linked to an incident."""
    return await bodycam_service.start_recording(camera_id, incident_id)


@router.post("/bodycams/{camera_id}/stop-recording")
async def stop_bodycam_recording(camera_id: str):
    """Stop an active body camera recording and close the clip."""
    return await bodycam_service.stop_recording(camera_id)


@router.post("/bodycams/{camera_id}/location")
async def update_bodycam_location(camera_id: str, req: UpdateLocationRequest):
    """Update the GPS coordinates for a body camera."""
    return await bodycam_service.update_camera_location(camera_id, req.lat, req.lon)


@router.get("/bodycams/clips")
async def get_bodycam_clips(incident_id: Optional[str] = None, limit: int = 50):
    """Retrieve body camera clips, optionally filtered by incident ID."""
    return {"clips": bodycam_service.get_clips(incident_id, limit)}


@router.post("/bodycams/clips/{clip_id}/tag")
async def tag_bodycam_clip(clip_id: str, req: TagClipRequest):
    """Add evidence tags to a body camera clip."""
    return await bodycam_service.tag_clip(clip_id, req.tags)


# ── Compliance audit endpoints ────────────────────────────────

class AssessControlRequest(BaseModel):
    status: str  # compliant, non_compliant, partially_compliant
    notes: str
    assessor: str


class AddEvidenceRequest(BaseModel):
    evidence_type: str
    description: str
    file_path: str = ""


@router.get("/compliance/controls")
async def get_compliance_controls():
    """List all SOC 2 controls and their current assessment status."""
    return {"controls": compliance_audit_service.get_all_controls()}


@router.get("/compliance/summary")
async def get_compliance_summary():
    """Get high-level compliance posture summary with counts and percentage."""
    return compliance_audit_service.get_compliance_summary()


@router.get("/compliance/report")
async def get_audit_report():
    """Export a full structured audit report for external auditors."""
    return compliance_audit_service.export_audit_report()


@router.post("/compliance/controls/{control_id}/assess")
async def assess_control(control_id: str, req: AssessControlRequest):
    """Record an assessment result for a specific SOC 2 control."""
    result = compliance_audit_service.assess_control(
        control_id, req.status, req.notes, req.assessor
    )
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.post("/compliance/controls/{control_id}/evidence")
async def add_control_evidence(control_id: str, req: AddEvidenceRequest):
    """Attach an evidence item to a specific SOC 2 control."""
    result = compliance_audit_service.add_evidence(
        control_id, req.evidence_type, req.description, req.file_path
    )
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.get("/compliance/controls/{control_id}/evidence")
async def get_control_evidence(control_id: str):
    """Retrieve all evidence items linked to a specific SOC 2 control."""
    return {"evidence": compliance_audit_service.get_evidence(control_id)}
