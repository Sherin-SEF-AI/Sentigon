"""Body camera integration service.

Manages body-worn camera streams, auto-tags footage with
incidents and patrols, and links evidence.
"""
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional
from dataclasses import dataclass, field
import uuid

logger = logging.getLogger(__name__)

@dataclass
class BodyCamera:
    id: str
    officer_name: str
    officer_id: str
    status: str = "offline"  # offline, standby, recording, buffering
    battery_percent: int = 100
    storage_percent: int = 0
    stream_url: Optional[str] = None
    current_incident_id: Optional[str] = None
    current_patrol_id: Optional[str] = None
    gps_lat: Optional[float] = None
    gps_lon: Optional[float] = None
    last_updated: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

@dataclass
class BodyCamClip:
    id: str
    camera_id: str
    officer_name: str
    start_time: str
    end_time: Optional[str] = None
    incident_id: Optional[str] = None
    patrol_id: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    file_path: Optional[str] = None
    duration_seconds: int = 0

class BodyCamService:
    def __init__(self):
        self._cameras: Dict[str, BodyCamera] = {}
        self._clips: List[BodyCamClip] = []

    def register_camera(self, officer_name: str, officer_id: str) -> BodyCamera:
        cam_id = str(uuid.uuid4())[:8]
        cam = BodyCamera(id=cam_id, officer_name=officer_name, officer_id=officer_id)
        self._cameras[cam_id] = cam
        return cam

    def get_all_cameras(self) -> List[dict]:
        return [vars(c) for c in self._cameras.values()]

    def get_camera(self, camera_id: str) -> Optional[dict]:
        c = self._cameras.get(camera_id)
        return vars(c) if c else None

    async def start_recording(self, camera_id: str, incident_id: Optional[str] = None) -> dict:
        cam = self._cameras.get(camera_id)
        if not cam:
            return {"error": "Camera not found"}
        cam.status = "recording"
        cam.current_incident_id = incident_id
        cam.last_updated = datetime.now(timezone.utc).isoformat()
        clip = BodyCamClip(
            id=str(uuid.uuid4())[:8],
            camera_id=camera_id,
            officer_name=cam.officer_name,
            start_time=cam.last_updated,
            incident_id=incident_id,
        )
        self._clips.append(clip)
        return {"status": "recording", "clip_id": clip.id}

    async def stop_recording(self, camera_id: str) -> dict:
        cam = self._cameras.get(camera_id)
        if not cam:
            return {"error": "Camera not found"}
        cam.status = "standby"
        cam.last_updated = datetime.now(timezone.utc).isoformat()
        # Close open clip
        for clip in reversed(self._clips):
            if clip.camera_id == camera_id and clip.end_time is None:
                clip.end_time = cam.last_updated
                break
        return {"status": "stopped"}

    def get_clips(self, incident_id: Optional[str] = None, limit: int = 50) -> List[dict]:
        clips = self._clips
        if incident_id:
            clips = [c for c in clips if c.incident_id == incident_id]
        return [vars(c) for c in clips[-limit:]]

    async def tag_clip(self, clip_id: str, tags: List[str]) -> dict:
        for clip in self._clips:
            if clip.id == clip_id:
                clip.tags.extend(tags)
                return {"tagged": True, "tags": clip.tags}
        return {"error": "Clip not found"}

    def get_active_cameras(self) -> List[dict]:
        return [vars(c) for c in self._cameras.values() if c.status == "recording"]

    async def update_camera_location(self, camera_id: str, lat: float, lon: float) -> dict:
        cam = self._cameras.get(camera_id)
        if not cam:
            return {"error": "Camera not found"}
        cam.gps_lat = lat
        cam.gps_lon = lon
        cam.last_updated = datetime.now(timezone.utc).isoformat()
        return {"updated": True, "camera_id": camera_id, "lat": lat, "lon": lon}


bodycam_service = BodyCamService()
