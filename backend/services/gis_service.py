"""
GIS and geospatial service for facility mapping, geofencing,
GPS tracking, and spatial analytics.
"""
import asyncio
import logging
import math
import time
from typing import Optional, Dict, List, Any, Tuple
from dataclasses import dataclass, field
from enum import Enum
import os

logger = logging.getLogger(__name__)


@dataclass
class GeoPoint:
    lat: float
    lng: float
    altitude: float = 0.0


@dataclass
class GeoFence:
    fence_id: str
    name: str
    fence_type: str = "polygon"  # polygon, circle
    polygon: List[GeoPoint] = field(default_factory=list)  # For polygon type
    center: Optional[GeoPoint] = None  # For circle type
    radius: float = 0.0  # meters, for circle type
    zone_id: Optional[str] = None
    alert_on_enter: bool = True
    alert_on_exit: bool = True
    active: bool = True
    color: str = "#ef4444"
    opacity: float = 0.3


@dataclass
class TrackedAsset:
    asset_id: str
    name: str
    asset_type: str  # patrol_officer, vehicle, drone, equipment
    current_position: Optional[GeoPoint] = None
    last_update: float = 0
    speed: float = 0.0  # m/s
    heading: float = 0.0  # degrees
    status: str = "active"  # active, idle, offline, emergency
    battery: Optional[float] = None  # percentage
    assigned_zone: str = ""
    trail: List[Tuple[float, float, float]] = field(default_factory=list)
    max_trail_length: int = 500
    geofence_violations: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class FloorPlan:
    plan_id: str
    name: str
    floor_number: int = 0
    building: str = ""
    image_path: str = ""
    bounds: List[List[float]] = field(default_factory=list)
    camera_positions: List[Dict[str, Any]] = field(default_factory=list)
    sensor_positions: List[Dict[str, Any]] = field(default_factory=list)
    door_positions: List[Dict[str, Any]] = field(default_factory=list)
    width: int = 0
    height: int = 0
    scale: float = 1.0  # pixels per meter


@dataclass
class HeatmapData:
    points: List[Dict[str, float]] = field(default_factory=list)
    generated_at: float = field(default_factory=time.time)
    data_type: str = ""  # alerts, events, occupancy, detections


class GISService:
    """GIS and geospatial management service."""

    def __init__(self):
        self.facility_center = GeoPoint(
            lat=float(os.getenv("FACILITY_LATITUDE", "24.7136")),
            lng=float(os.getenv("FACILITY_LONGITUDE", "46.6753")),
        )
        self.geofences: Dict[str, GeoFence] = {}
        self.tracked_assets: Dict[str, TrackedAsset] = {}
        self.floor_plans: Dict[str, FloorPlan] = {}
        self._heatmap_cache: Dict[str, HeatmapData] = {}
        self._geofence_callbacks: List[Any] = []
        self._monitor_task: Optional[asyncio.Task] = None

    def register_geofence(self, fence: GeoFence):
        self.geofences[fence.fence_id] = fence
        logger.info(f"Registered geofence: {fence.name} ({fence.fence_id})")

    def register_floor_plan(self, plan: FloorPlan):
        self.floor_plans[plan.plan_id] = plan
        logger.info(f"Registered floor plan: {plan.name}")

    def on_geofence_event(self, callback):
        self._geofence_callbacks.append(callback)

    async def start_monitoring(self):
        self._monitor_task = asyncio.create_task(self._monitor_geofences())

    async def update_asset_position(
        self,
        asset_id: str,
        lat: float,
        lng: float,
        speed: float = 0,
        heading: float = 0,
        battery: float = None,
    ) -> Dict[str, Any]:
        """Update tracked asset position and check geofences."""
        asset = self.tracked_assets.get(asset_id)
        if not asset:
            return {"error": "Asset not found"}

        old_position = asset.current_position
        asset.current_position = GeoPoint(lat=lat, lng=lng)
        asset.speed = speed
        asset.heading = heading
        asset.last_update = time.time()
        if battery is not None:
            asset.battery = battery

        # Update trail
        asset.trail.append((lat, lng, time.time()))
        if len(asset.trail) > asset.max_trail_length:
            asset.trail = asset.trail[-asset.max_trail_length:]

        # Check geofences
        violations = []
        for fence_id, fence in self.geofences.items():
            if not fence.active:
                continue

            is_inside = self._point_in_geofence(GeoPoint(lat=lat, lng=lng), fence)
            was_inside = (
                old_position and self._point_in_geofence(old_position, fence)
                if old_position
                else False
            )

            if is_inside and not was_inside and fence.alert_on_enter:
                violation = {
                    "type": "enter",
                    "asset_id": asset_id,
                    "asset_name": asset.name,
                    "fence_id": fence_id,
                    "fence_name": fence.name,
                    "position": {"lat": lat, "lng": lng},
                    "timestamp": time.time(),
                }
                violations.append(violation)
                asset.geofence_violations += 1
                await self._notify_geofence_event(violation)

            elif not is_inside and was_inside and fence.alert_on_exit:
                violation = {
                    "type": "exit",
                    "asset_id": asset_id,
                    "asset_name": asset.name,
                    "fence_id": fence_id,
                    "fence_name": fence.name,
                    "position": {"lat": lat, "lng": lng},
                    "timestamp": time.time(),
                }
                violations.append(violation)
                await self._notify_geofence_event(violation)

        return {
            "asset_id": asset_id,
            "position": {"lat": lat, "lng": lng},
            "violations": violations,
        }

    def _point_in_geofence(self, point: GeoPoint, fence: GeoFence) -> bool:
        """Check if a point is inside a geofence."""
        if fence.fence_type == "circle" and fence.center:
            distance = self._haversine_distance(point, fence.center)
            return distance <= fence.radius

        elif fence.fence_type == "polygon" and fence.polygon:
            return self._point_in_polygon(point, fence.polygon)

        return False

    def _haversine_distance(self, p1: GeoPoint, p2: GeoPoint) -> float:
        """Calculate distance between two points in meters."""
        R = 6371000  # Earth radius in meters
        phi1 = math.radians(p1.lat)
        phi2 = math.radians(p2.lat)
        dphi = math.radians(p2.lat - p1.lat)
        dlambda = math.radians(p2.lng - p1.lng)

        a = (
            math.sin(dphi / 2) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
        )
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c

    def _point_in_polygon(self, point: GeoPoint, polygon: List[GeoPoint]) -> bool:
        """Ray casting algorithm for point-in-polygon test."""
        n = len(polygon)
        inside = False

        j = n - 1
        for i in range(n):
            xi, yi = polygon[i].lat, polygon[i].lng
            xj, yj = polygon[j].lat, polygon[j].lng

            if ((yi > point.lng) != (yj > point.lng)) and (
                point.lat < (xj - xi) * (point.lng - yi) / (yj - yi) + xi
            ):
                inside = not inside
            j = i

        return inside

    async def _monitor_geofences(self):
        """Periodic geofence monitoring for all tracked assets."""
        while True:
            try:
                now = time.time()
                for asset in self.tracked_assets.values():
                    # Mark offline if no update for 5 minutes
                    if asset.current_position and now - asset.last_update > 300:
                        if asset.status != "offline":
                            asset.status = "offline"
                            logger.info(f"Asset {asset.name} went offline")
            except Exception as e:
                logger.error(f"Geofence monitor error: {e}")
            await asyncio.sleep(10)

    async def _notify_geofence_event(self, event: Dict):
        for cb in self._geofence_callbacks:
            try:
                if asyncio.iscoroutinefunction(cb):
                    await cb(event)
                else:
                    cb(event)
            except Exception as e:
                logger.error(f"Geofence callback error: {e}")

    def generate_heatmap(
        self, data_points: List[Dict[str, float]], data_type: str = "events"
    ) -> HeatmapData:
        """Generate heatmap data from event locations."""
        heatmap = HeatmapData(
            points=data_points,
            data_type=data_type,
        )
        self._heatmap_cache[data_type] = heatmap
        return heatmap

    def get_map_config(self) -> Dict:
        """Get complete map configuration for frontend."""
        return {
            "center": {
                "lat": self.facility_center.lat,
                "lng": self.facility_center.lng,
            },
            "zoom": 18,
            "tile_url": os.getenv(
                "MAP_TILE_URL",
                "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            ),
            "tile_attribution": os.getenv(
                "MAP_ATTRIBUTION", "OpenStreetMap contributors"
            ),
            "max_zoom": 22,
            "geofences": [
                {
                    "id": f.fence_id,
                    "name": f.name,
                    "type": f.fence_type,
                    "polygon": (
                        [{"lat": p.lat, "lng": p.lng} for p in f.polygon]
                        if f.polygon
                        else []
                    ),
                    "center": (
                        {"lat": f.center.lat, "lng": f.center.lng}
                        if f.center
                        else None
                    ),
                    "radius": f.radius,
                    "color": f.color,
                    "opacity": f.opacity,
                    "active": f.active,
                }
                for f in self.geofences.values()
            ],
            "floor_plans": [
                {
                    "id": fp.plan_id,
                    "name": fp.name,
                    "floor": fp.floor_number,
                    "building": fp.building,
                    "image_url": f"/api/gis/floor-plans/{fp.plan_id}/image",
                    "bounds": fp.bounds,
                    "cameras": fp.camera_positions,
                    "sensors": fp.sensor_positions,
                    "doors": fp.door_positions,
                }
                for fp in self.floor_plans.values()
            ],
            "tracked_assets": [
                {
                    "id": a.asset_id,
                    "name": a.name,
                    "type": a.asset_type,
                    "position": (
                        {
                            "lat": a.current_position.lat,
                            "lng": a.current_position.lng,
                        }
                        if a.current_position
                        else None
                    ),
                    "speed": a.speed,
                    "heading": a.heading,
                    "status": a.status,
                    "battery": a.battery,
                    "zone": a.assigned_zone,
                }
                for a in self.tracked_assets.values()
            ],
        }

    def get_status(self) -> Dict:
        return {
            "facility_center": {
                "lat": self.facility_center.lat,
                "lng": self.facility_center.lng,
            },
            "geofences": len(self.geofences),
            "tracked_assets": len(self.tracked_assets),
            "online_assets": len(
                [
                    a
                    for a in self.tracked_assets.values()
                    if a.status in ("active", "idle")
                ]
            ),
            "floor_plans": len(self.floor_plans),
            "active_violations": sum(
                a.geofence_violations for a in self.tracked_assets.values()
            ),
        }


# Singleton
gis_service = GISService()
