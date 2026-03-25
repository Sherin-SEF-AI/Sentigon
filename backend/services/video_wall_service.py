"""Video Wall Service — layout management, camera streams, PTZ control, AI overlays."""

import uuid
import logging
from datetime import datetime
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.models import Camera
from backend.models.phase2b_models import VideoWallLayout

logger = logging.getLogger(__name__)


class VideoWallService:

    async def create_layout(self, db: AsyncSession, data: dict) -> dict:
        layout = VideoWallLayout(
            name=data.get("name", "Untitled"), grid_cols=data.get("grid_cols", 2),
            grid_rows=data.get("grid_rows", 2), cells=data.get("cells", []),
            cycle_enabled=data.get("cycle_enabled", False),
            cycle_interval_seconds=data.get("cycle_interval_seconds", 30),
            cycle_cameras=data.get("cycle_cameras", []),
            created_by=data.get("created_by"),
        )
        db.add(layout)
        await db.commit()
        await db.refresh(layout)
        return self._to_dict(layout)

    async def update_layout(self, db: AsyncSession, layout_id: str, data: dict) -> dict:
        result = await db.execute(select(VideoWallLayout).where(VideoWallLayout.id == layout_id))
        layout = result.scalar_one_or_none()
        if not layout:
            raise ValueError("Layout not found")
        for k in ["name", "grid_cols", "grid_rows", "cells", "cycle_enabled", "cycle_interval_seconds", "cycle_cameras"]:
            if k in data:
                setattr(layout, k, data[k])
        layout.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(layout)
        return self._to_dict(layout)

    async def delete_layout(self, db: AsyncSession, layout_id: str) -> bool:
        result = await db.execute(select(VideoWallLayout).where(VideoWallLayout.id == layout_id))
        layout = result.scalar_one_or_none()
        if not layout:
            return False
        await db.delete(layout)
        await db.commit()
        return True

    async def get_layouts(self, db: AsyncSession) -> list:
        result = await db.execute(select(VideoWallLayout).order_by(VideoWallLayout.name))
        return [self._to_dict(l) for l in result.scalars().all()]

    async def get_layout(self, db: AsyncSession, layout_id: str) -> dict | None:
        result = await db.execute(select(VideoWallLayout).where(VideoWallLayout.id == layout_id))
        l = result.scalar_one_or_none()
        return self._to_dict(l) if l else None

    async def set_default_layout(self, db: AsyncSession, layout_id: str) -> dict:
        await db.execute(update(VideoWallLayout).values(is_default=False))
        result = await db.execute(select(VideoWallLayout).where(VideoWallLayout.id == layout_id))
        layout = result.scalar_one_or_none()
        if not layout:
            raise ValueError("Layout not found")
        layout.is_default = True
        await db.commit()
        await db.refresh(layout)
        return self._to_dict(layout)

    async def get_default_layout(self, db: AsyncSession) -> dict | None:
        result = await db.execute(select(VideoWallLayout).where(VideoWallLayout.is_default == True))
        l = result.scalar_one_or_none()
        return self._to_dict(l) if l else None

    async def get_camera_streams(self, db: AsyncSession) -> list:
        result = await db.execute(select(Camera).where(Camera.is_active == True).order_by(Camera.name))
        cameras = []
        for c in result.scalars().all():
            cameras.append({
                "id": str(c.id), "name": c.name, "source": c.source,
                "location": c.location, "status": c.status.value if c.status else "unknown",
                "zone_id": str(c.zone_id) if c.zone_id else None,
                "fps": c.fps, "resolution": c.resolution,
            })
        return cameras

    async def ptz_control(self, camera_id: str, direction: str, speed: float = 0.5) -> dict:
        try:
            from backend.services.onvif_service import onvif_service
            result = await onvif_service.move_ptz(camera_id, direction, speed)
            return {"success": True, "camera_id": camera_id, "direction": direction}
        except Exception as e:
            logger.error("PTZ control failed: %s", e)
            return {"success": False, "error": str(e)}

    async def ptz_goto_preset(self, camera_id: str, preset: int) -> dict:
        try:
            from backend.services.onvif_service import onvif_service
            await onvif_service.goto_preset(camera_id, preset)
            return {"success": True, "camera_id": camera_id, "preset": preset}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_ai_overlays(self, camera_id: str) -> dict:
        try:
            from backend.services.yolo_detector import yolo_detector
            tracked = yolo_detector.get_tracked_objects(camera_id) if hasattr(yolo_detector, 'get_tracked_objects') else []
            boxes = []
            for obj in (tracked or []):
                if isinstance(obj, dict):
                    boxes.append(obj)
                elif hasattr(obj, '__dict__'):
                    boxes.append({
                        "track_id": getattr(obj, 'track_id', None),
                        "class_name": getattr(obj, 'class_name', None),
                        "confidence": getattr(obj, 'confidence', None),
                        "bbox": getattr(obj, 'bbox', None),
                    })
            return {"camera_id": camera_id, "detections": boxes, "count": len(boxes)}
        except Exception:
            return {"camera_id": camera_id, "detections": [], "count": 0}

    def _to_dict(self, l: VideoWallLayout) -> dict:
        return {
            "id": str(l.id), "name": l.name, "grid_cols": l.grid_cols,
            "grid_rows": l.grid_rows, "cells": l.cells or [],
            "is_default": l.is_default, "cycle_enabled": l.cycle_enabled,
            "cycle_interval_seconds": l.cycle_interval_seconds,
            "cycle_cameras": l.cycle_cameras or [],
            "created_at": l.created_at.isoformat() if l.created_at else None,
        }


video_wall_service = VideoWallService()
