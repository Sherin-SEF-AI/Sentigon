"""Floor Plan Engine Service — device placement, live status, incident overlay, pathfinding."""

import uuid
import math
import heapq
import logging
from datetime import datetime
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.models import Camera
from backend.models.phase2b_models import FloorPlanDevice, Incident, IncidentStatus

logger = logging.getLogger(__name__)


class FloorPlanEngineService:

    async def place_device(self, db: AsyncSession, data: dict) -> dict:
        device = FloorPlanDevice(
            floor_plan_id=data["floor_plan_id"],
            device_type=data["device_type"],
            device_id=data["device_id"],
            x_percent=data["x_percent"],
            y_percent=data["y_percent"],
            rotation=data.get("rotation", 0),
            icon_size=data.get("icon_size", 1.0),
            label=data.get("label"),
            fov_angle=data.get("fov_angle"),
            fov_range=data.get("fov_range"),
            config=data.get("config", {}),
        )
        db.add(device)
        await db.commit()
        await db.refresh(device)
        return self._to_dict(device)

    async def update_device_placement(self, db: AsyncSession, placement_id: str, data: dict) -> dict:
        result = await db.execute(select(FloorPlanDevice).where(FloorPlanDevice.id == placement_id))
        device = result.scalar_one_or_none()
        if not device:
            raise ValueError("Device placement not found")
        for k in ["x_percent", "y_percent", "rotation", "icon_size", "label", "fov_angle", "fov_range", "config"]:
            if k in data:
                setattr(device, k, data[k])
        await db.commit()
        await db.refresh(device)
        return self._to_dict(device)

    async def remove_device(self, db: AsyncSession, placement_id: str) -> bool:
        result = await db.execute(select(FloorPlanDevice).where(FloorPlanDevice.id == placement_id))
        device = result.scalar_one_or_none()
        if not device:
            return False
        await db.delete(device)
        await db.commit()
        return True

    async def get_floor_plan_devices(self, db: AsyncSession, floor_plan_id: str) -> list:
        result = await db.execute(
            select(FloorPlanDevice).where(FloorPlanDevice.floor_plan_id == floor_plan_id)
        )
        return [self._to_dict(d) for d in result.scalars().all()]

    async def get_device_status(self, db: AsyncSession, floor_plan_id: str) -> list:
        devices = await self.get_floor_plan_devices(db, floor_plan_id)
        statuses = []
        for d in devices:
            status = "unknown"
            status_color = "gray"
            if d["device_type"] == "camera":
                try:
                    cam_result = await db.execute(select(Camera).where(Camera.id == d["device_id"]))
                    cam = cam_result.scalar_one_or_none()
                    if cam:
                        status = cam.status.value if cam.status else "unknown"
                        status_color = "green" if status == "online" else "red" if status in ("offline", "error") else "amber"
                except Exception:
                    pass
            elif d["device_type"] == "sensor":
                status = "active"
                status_color = "green"
            elif d["device_type"] == "door":
                status = "secured"
                status_color = "green"
            elif d["device_type"] == "alarm_point":
                status = "armed"
                status_color = "green"
            statuses.append({**d, "status": status, "status_color": status_color})
        return statuses

    async def get_active_incidents_on_floor(self, db: AsyncSession, floor_plan_id: str) -> list:
        # Get devices on this floor plan to know which cameras/zones are here
        devices = await self.get_floor_plan_devices(db, floor_plan_id)
        camera_ids = [d["device_id"] for d in devices if d["device_type"] == "camera"]
        if not camera_ids:
            return []
        # Find active incidents involving these cameras
        result = await db.execute(
            select(Incident).where(
                Incident.status.in_([IncidentStatus.detected, IncidentStatus.triaged,
                                     IncidentStatus.assigned, IncidentStatus.in_progress])
            ).order_by(Incident.created_at.desc()).limit(50)
        )
        incidents = []
        device_map = {d["device_id"]: d for d in devices}
        for inc in result.scalars().all():
            inc_cameras = inc.camera_ids or []
            for cam_id in inc_cameras:
                if cam_id in device_map:
                    d = device_map[cam_id]
                    incidents.append({
                        "incident_id": str(inc.id),
                        "title": inc.title,
                        "severity": inc.severity,
                        "status": inc.status.value if inc.status else None,
                        "x_percent": d["x_percent"],
                        "y_percent": d["y_percent"],
                        "created_at": inc.created_at.isoformat() if inc.created_at else None,
                    })
                    break
        return incidents

    async def calculate_shortest_path(self, floor_plan_id: str,
                                       from_point: tuple, to_point: tuple,
                                       obstacles: list = None) -> dict:
        """A* pathfinding on a 100x100 grid."""
        grid_size = 100
        blocked = set()
        if obstacles:
            for obs in obstacles:
                for x in range(int(obs.get("x1", 0)), int(obs.get("x2", 0)) + 1):
                    for y in range(int(obs.get("y1", 0)), int(obs.get("y2", 0)) + 1):
                        blocked.add((x, y))

        start = (int(from_point[0]), int(from_point[1]))
        end = (int(to_point[0]), int(to_point[1]))

        def heuristic(a, b):
            return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)

        open_set = [(0, start)]
        came_from = {}
        g_score = {start: 0}

        while open_set:
            _, current = heapq.heappop(open_set)
            if current == end:
                path = []
                while current in came_from:
                    path.append(current)
                    current = came_from[current]
                path.append(start)
                path.reverse()
                # Simplify path (keep only direction changes)
                simplified = [path[0]]
                for i in range(1, len(path) - 1):
                    dx1 = path[i][0] - path[i-1][0]
                    dy1 = path[i][1] - path[i-1][1]
                    dx2 = path[i+1][0] - path[i][0]
                    dy2 = path[i+1][1] - path[i][1]
                    if dx1 != dx2 or dy1 != dy2:
                        simplified.append(path[i])
                simplified.append(path[-1])
                return {"path": simplified, "distance": g_score[end], "steps": len(path)}

            for dx, dy in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]:
                nx, ny = current[0] + dx, current[1] + dy
                if 0 <= nx < grid_size and 0 <= ny < grid_size and (nx, ny) not in blocked:
                    cost = math.sqrt(dx*dx + dy*dy)
                    tentative = g_score[current] + cost
                    if tentative < g_score.get((nx, ny), float('inf')):
                        came_from[(nx, ny)] = current
                        g_score[(nx, ny)] = tentative
                        heapq.heappush(open_set, (tentative + heuristic((nx, ny), end), (nx, ny)))

        return {"path": [], "distance": -1, "steps": 0, "error": "No path found"}

    def _to_dict(self, d: FloorPlanDevice) -> dict:
        return {
            "id": str(d.id), "floor_plan_id": d.floor_plan_id,
            "device_type": d.device_type, "device_id": d.device_id,
            "x_percent": d.x_percent, "y_percent": d.y_percent,
            "rotation": d.rotation, "icon_size": d.icon_size,
            "label": d.label, "fov_angle": d.fov_angle, "fov_range": d.fov_range,
            "config": d.config or {},
            "created_at": d.created_at.isoformat() if d.created_at else None,
        }


floor_plan_engine_service = FloorPlanEngineService()
