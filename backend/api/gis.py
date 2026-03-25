"""GIS / Mapping REST API for SENTINEL AI.

Endpoints for geofences, tracked assets, floor plans, heatmaps,
and full map configuration consumed by the Leaflet frontend.
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.services.gis_service import (
    gis_service,
    GeoFence,
    GeoPoint,
    TrackedAsset,
    FloorPlan,
)

router = APIRouter(prefix="/api/gis", tags=["gis"])

# ── Pydantic request/response schemas ────────────────────────

class PointSchema(BaseModel):
    lat: float
    lng: float


class GeofenceCreate(BaseModel):
    name: str
    fence_type: str = "polygon"  # polygon | circle
    polygon: List[PointSchema] = Field(default_factory=list)
    center: Optional[PointSchema] = None
    radius: float = 0.0
    zone_id: Optional[str] = None
    alert_on_enter: bool = True
    alert_on_exit: bool = True
    color: str = "#ef4444"
    opacity: float = 0.3


class GeofenceUpdate(BaseModel):
    name: Optional[str] = None
    polygon: Optional[List[PointSchema]] = None
    center: Optional[PointSchema] = None
    radius: Optional[float] = None
    alert_on_enter: Optional[bool] = None
    alert_on_exit: Optional[bool] = None
    active: Optional[bool] = None
    color: Optional[str] = None
    opacity: Optional[float] = None


class AssetCreate(BaseModel):
    name: str
    asset_type: str  # patrol_officer, vehicle, drone, equipment
    position: Optional[PointSchema] = None
    assigned_zone: str = ""
    battery: Optional[float] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class PositionUpdate(BaseModel):
    lat: float
    lng: float
    speed: float = 0.0
    heading: float = 0.0
    battery: Optional[float] = None


class FloorPlanCreate(BaseModel):
    name: str
    floor_number: int = 0
    building: str = ""
    bounds: List[List[float]] = Field(default_factory=list)
    cameras: List[Dict[str, Any]] = Field(default_factory=list)
    sensors: List[Dict[str, Any]] = Field(default_factory=list)
    doors: List[Dict[str, Any]] = Field(default_factory=list)


class HeatmapPointSchema(BaseModel):
    lat: float
    lng: float
    intensity: float = 1.0


class HeatmapGenerate(BaseModel):
    points: List[HeatmapPointSchema]
    data_type: str = "events"


# ── Map Configuration ─────────────────────────────────────────

@router.get("/config")
async def get_map_config():
    """Return the full map configuration for the Leaflet frontend."""
    return gis_service.get_map_config()


@router.get("/status")
async def get_gis_status():
    """Return GIS subsystem status summary."""
    return gis_service.get_status()


# ── Geofences ─────────────────────────────────────────────────

@router.post("/geofences", status_code=status.HTTP_201_CREATED)
async def create_geofence(body: GeofenceCreate):
    """Create a new geofence (polygon or circle)."""
    fence_id = str(uuid.uuid4())
    fence = GeoFence(
        fence_id=fence_id,
        name=body.name,
        fence_type=body.fence_type,
        polygon=[GeoPoint(lat=p.lat, lng=p.lng) for p in body.polygon],
        center=GeoPoint(lat=body.center.lat, lng=body.center.lng) if body.center else None,
        radius=body.radius,
        zone_id=body.zone_id,
        alert_on_enter=body.alert_on_enter,
        alert_on_exit=body.alert_on_exit,
        color=body.color,
        opacity=body.opacity,
    )
    gis_service.register_geofence(fence)
    return {
        "id": fence_id,
        "name": body.name,
        "type": body.fence_type,
        "message": "Geofence created",
    }


@router.get("/geofences")
async def list_geofences():
    """List all registered geofences."""
    results = []
    for f in gis_service.geofences.values():
        results.append({
            "id": f.fence_id,
            "name": f.name,
            "type": f.fence_type,
            "polygon": [{"lat": p.lat, "lng": p.lng} for p in f.polygon] if f.polygon else [],
            "center": {"lat": f.center.lat, "lng": f.center.lng} if f.center else None,
            "radius": f.radius,
            "zone_id": f.zone_id,
            "alert_on_enter": f.alert_on_enter,
            "alert_on_exit": f.alert_on_exit,
            "active": f.active,
            "color": f.color,
            "opacity": f.opacity,
        })
    return results


@router.put("/geofences/{fence_id}")
async def update_geofence(fence_id: str, body: GeofenceUpdate):
    """Update an existing geofence."""
    fence = gis_service.geofences.get(fence_id)
    if not fence:
        raise HTTPException(status_code=404, detail="Geofence not found")

    if body.name is not None:
        fence.name = body.name
    if body.polygon is not None:
        fence.polygon = [GeoPoint(lat=p.lat, lng=p.lng) for p in body.polygon]
    if body.center is not None:
        fence.center = GeoPoint(lat=body.center.lat, lng=body.center.lng)
    if body.radius is not None:
        fence.radius = body.radius
    if body.alert_on_enter is not None:
        fence.alert_on_enter = body.alert_on_enter
    if body.alert_on_exit is not None:
        fence.alert_on_exit = body.alert_on_exit
    if body.active is not None:
        fence.active = body.active
    if body.color is not None:
        fence.color = body.color
    if body.opacity is not None:
        fence.opacity = body.opacity

    return {"id": fence_id, "message": "Geofence updated"}


@router.delete("/geofences/{fence_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_geofence(fence_id: str):
    """Delete a geofence."""
    if fence_id not in gis_service.geofences:
        raise HTTPException(status_code=404, detail="Geofence not found")
    del gis_service.geofences[fence_id]
    return None


# ── Tracked Assets ────────────────────────────────────────────

@router.post("/assets", status_code=status.HTTP_201_CREATED)
async def register_asset(body: AssetCreate):
    """Register a new tracked asset (officer, vehicle, drone, etc.)."""
    asset_id = str(uuid.uuid4())
    asset = TrackedAsset(
        asset_id=asset_id,
        name=body.name,
        asset_type=body.asset_type,
        current_position=GeoPoint(lat=body.position.lat, lng=body.position.lng) if body.position else None,
        last_update=time.time() if body.position else 0,
        battery=body.battery,
        assigned_zone=body.assigned_zone,
        metadata=body.metadata,
    )
    gis_service.tracked_assets[asset_id] = asset
    return {
        "id": asset_id,
        "name": body.name,
        "type": body.asset_type,
        "message": "Asset registered",
    }


@router.get("/assets")
async def list_assets():
    """List all tracked assets with current positions."""
    results = []
    for a in gis_service.tracked_assets.values():
        results.append({
            "id": a.asset_id,
            "name": a.name,
            "type": a.asset_type,
            "position": {"lat": a.current_position.lat, "lng": a.current_position.lng} if a.current_position else None,
            "speed": a.speed,
            "heading": a.heading,
            "status": a.status,
            "battery": a.battery,
            "zone": a.assigned_zone,
            "last_update": a.last_update,
            "geofence_violations": a.geofence_violations,
        })
    return results


@router.post("/assets/{asset_id}/position")
async def update_asset_position(asset_id: str, body: PositionUpdate):
    """Update the GPS position of a tracked asset and check geofences."""
    if asset_id not in gis_service.tracked_assets:
        raise HTTPException(status_code=404, detail="Asset not found")

    result = await gis_service.update_asset_position(
        asset_id=asset_id,
        lat=body.lat,
        lng=body.lng,
        speed=body.speed,
        heading=body.heading,
        battery=body.battery,
    )
    return result


@router.get("/assets/{asset_id}/trail")
async def get_asset_trail(asset_id: str, limit: int = 100):
    """Return the movement trail (breadcrumb) for a tracked asset."""
    asset = gis_service.tracked_assets.get(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    trail_points = asset.trail[-limit:] if limit else asset.trail
    return {
        "asset_id": asset_id,
        "asset_name": asset.name,
        "trail": [
            {"lat": lat, "lng": lng, "timestamp": ts}
            for lat, lng, ts in trail_points
        ],
        "total_points": len(asset.trail),
    }


# ── Floor Plans ───────────────────────────────────────────────

@router.post("/floor-plans", status_code=status.HTTP_201_CREATED)
async def create_floor_plan(body: FloorPlanCreate):
    """Register a floor plan with camera/sensor/door positions."""
    plan_id = str(uuid.uuid4())
    plan = FloorPlan(
        plan_id=plan_id,
        name=body.name,
        floor_number=body.floor_number,
        building=body.building,
        bounds=body.bounds,
        camera_positions=body.cameras,
        sensor_positions=body.sensors,
        door_positions=body.doors,
    )
    gis_service.register_floor_plan(plan)
    return {
        "id": plan_id,
        "name": body.name,
        "message": "Floor plan created",
    }


@router.get("/floor-plans")
async def list_floor_plans():
    """List all registered floor plans."""
    results = []
    for fp in gis_service.floor_plans.values():
        results.append({
            "id": fp.plan_id,
            "name": fp.name,
            "floor": fp.floor_number,
            "building": fp.building,
            "bounds": fp.bounds,
            "cameras": len(fp.camera_positions),
            "sensors": len(fp.sensor_positions),
            "doors": len(fp.door_positions),
        })
    return results


@router.get("/floor-plans/{plan_id}/image")
async def get_floor_plan_image(plan_id: str):
    """Serve the floor plan image file."""
    plan = gis_service.floor_plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Floor plan not found")
    if not plan.image_path or not os.path.exists(plan.image_path):
        raise HTTPException(status_code=404, detail="Floor plan image not found")
    return FileResponse(plan.image_path)


@router.post("/floor-plans/{plan_id}/upload-image")
async def upload_floor_plan_image(plan_id: str, file: UploadFile = File(...)):
    """Upload an image file for a floor plan."""
    plan = gis_service.floor_plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Floor plan not found")

    # Save to data directory
    data_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "floor_plans")
    os.makedirs(data_dir, exist_ok=True)

    ext = os.path.splitext(file.filename or "image.png")[1]
    save_path = os.path.join(data_dir, f"{plan_id}{ext}")

    content = await file.read()
    with open(save_path, "wb") as f:
        f.write(content)

    plan.image_path = save_path
    return {"plan_id": plan_id, "image_path": save_path, "message": "Image uploaded"}


# ── Heatmaps ─────────────────────────────────────────────────

@router.get("/heatmap/{data_type}")
async def get_heatmap(data_type: str):
    """Return cached heatmap data by type (alerts, events, occupancy, detections)."""
    heatmap = gis_service._heatmap_cache.get(data_type)
    if not heatmap:
        return {"data_type": data_type, "points": [], "generated_at": None}
    return {
        "data_type": heatmap.data_type,
        "points": heatmap.points,
        "generated_at": heatmap.generated_at,
    }


@router.post("/heatmap")
async def generate_heatmap(body: HeatmapGenerate):
    """Generate and cache heatmap data from provided points."""
    data_points = [{"lat": p.lat, "lng": p.lng, "intensity": p.intensity} for p in body.points]
    heatmap = gis_service.generate_heatmap(data_points, body.data_type)
    return {
        "data_type": heatmap.data_type,
        "points_count": len(heatmap.points),
        "generated_at": heatmap.generated_at,
        "message": "Heatmap generated",
    }


# ── Distance Calculation ─────────────────────────────────────

@router.post("/distance")
async def calculate_distance(point_a: PointSchema, point_b: PointSchema):
    """Calculate haversine distance between two GPS coordinates."""
    p1 = GeoPoint(lat=point_a.lat, lng=point_a.lng)
    p2 = GeoPoint(lat=point_b.lat, lng=point_b.lng)
    distance = gis_service._haversine_distance(p1, p2)
    return {
        "from": {"lat": point_a.lat, "lng": point_a.lng},
        "to": {"lat": point_b.lat, "lng": point_b.lng},
        "distance_meters": round(distance, 2),
        "distance_km": round(distance / 1000, 4),
    }
