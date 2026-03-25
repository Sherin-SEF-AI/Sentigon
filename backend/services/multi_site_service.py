"""Multi-Site Command Center Service — hierarchy management, global overview, cross-site correlation."""

import uuid
import logging
from datetime import datetime, timedelta
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.phase2b_models import SiteHierarchy, Incident
from backend.models.models import Camera, Alert

logger = logging.getLogger(__name__)


class MultiSiteService:

    async def create_node(self, db: AsyncSession, data: dict) -> dict:
        node = SiteHierarchy(
            parent_id=data.get("parent_id"), level=data["level"], name=data["name"],
            description=data.get("description"), address=data.get("address"),
            lat=data.get("lat"), lng=data.get("lng"),
            timezone_str=data.get("timezone_str", "UTC"),
            config=data.get("config", {}),
        )
        db.add(node)
        await db.commit()
        await db.refresh(node)
        return self._to_dict(node)

    async def update_node(self, db: AsyncSession, node_id: str, data: dict) -> dict:
        result = await db.execute(select(SiteHierarchy).where(SiteHierarchy.id == node_id))
        node = result.scalar_one_or_none()
        if not node:
            raise ValueError("Node not found")
        for k in ["name", "description", "address", "lat", "lng", "timezone_str", "config", "status"]:
            if k in data:
                setattr(node, k, data[k])
        node.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(node)
        return self._to_dict(node)

    async def delete_node(self, db: AsyncSession, node_id: str) -> bool:
        result = await db.execute(select(SiteHierarchy).where(SiteHierarchy.id == node_id))
        node = result.scalar_one_or_none()
        if not node:
            return False
        await db.delete(node)
        await db.commit()
        return True

    async def get_node(self, db: AsyncSession, node_id: str) -> dict | None:
        result = await db.execute(select(SiteHierarchy).where(SiteHierarchy.id == node_id))
        n = result.scalar_one_or_none()
        return self._to_dict(n) if n else None

    async def get_hierarchy(self, db: AsyncSession, root_id: str = None) -> list:
        result = await db.execute(select(SiteHierarchy).order_by(SiteHierarchy.level, SiteHierarchy.name))
        nodes = result.scalars().all()
        node_map = {str(n.id): self._to_dict(n) for n in nodes}
        for n in node_map.values():
            n["children"] = []
        roots = []
        for n in node_map.values():
            pid = n.get("parent_id")
            if pid and pid in node_map:
                node_map[pid]["children"].append(n)
            else:
                roots.append(n)
        if root_id and root_id in node_map:
            return [node_map[root_id]]
        return roots

    async def get_global_overview(self, db: AsyncSession) -> dict:
        sites = (await db.execute(select(SiteHierarchy).where(SiteHierarchy.level == "site"))).scalars().all()
        total_cameras = (await db.execute(select(func.count(Camera.id)))).scalar() or 0
        online_cameras = (await db.execute(select(func.count(Camera.id)).where(Camera.status == "online"))).scalar() or 0
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        active_incidents = (await db.execute(
            select(func.count(Incident.id)).where(Incident.status.in_(["detected", "triaged", "assigned", "in_progress"]))
        )).scalar() or 0
        alerts_today = (await db.execute(
            select(func.count(Alert.id)).where(Alert.created_at >= today)
        )).scalar() or 0
        return {
            "total_sites": len(sites),
            "sites": [{"id": str(s.id), "name": s.name, "status": s.status} for s in sites],
            "total_cameras": total_cameras, "online_cameras": online_cameras,
            "active_incidents": active_incidents, "alerts_today": alerts_today,
        }

    async def get_site_dashboard(self, db: AsyncSession, site_id: str) -> dict:
        node = await self.get_node(db, site_id)
        if not node:
            raise ValueError("Site not found")
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        alerts = (await db.execute(select(func.count(Alert.id)).where(Alert.created_at >= today))).scalar() or 0
        incidents = (await db.execute(
            select(func.count(Incident.id)).where(Incident.status.in_(["detected", "triaged", "assigned", "in_progress"]))
        )).scalar() or 0
        return {**node, "alerts_today": alerts, "active_incidents": incidents}

    async def cross_site_correlation(self, db: AsyncSession, hours: int = 1) -> list:
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        result = await db.execute(
            select(Alert).where(Alert.created_at >= cutoff).order_by(Alert.created_at.desc()).limit(100)
        )
        alerts = result.scalars().all()
        type_groups = {}
        for a in alerts:
            tt = a.threat_type or "unknown"
            type_groups.setdefault(tt, []).append({
                "id": str(a.id), "title": a.title, "severity": a.severity,
                "source_camera": a.source_camera, "zone_name": a.zone_name,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            })
        correlated = [{"threat_type": k, "count": len(v), "alerts": v}
                       for k, v in type_groups.items() if len(v) >= 2]
        return correlated

    async def get_site_comparison(self, db: AsyncSession, site_ids: list) -> dict:
        comparison = {}
        for sid in site_ids:
            node = await self.get_node(db, sid)
            if node:
                today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
                alerts = (await db.execute(select(func.count(Alert.id)).where(Alert.created_at >= today))).scalar() or 0
                comparison[sid] = {"name": node["name"], "alerts_today": alerts, "status": node.get("status")}
        return comparison

    def _to_dict(self, n: SiteHierarchy) -> dict:
        return {
            "id": str(n.id), "parent_id": str(n.parent_id) if n.parent_id else None,
            "level": n.level, "name": n.name, "description": n.description,
            "address": n.address, "lat": n.lat, "lng": n.lng,
            "timezone_str": n.timezone_str, "config": n.config or {},
            "status": n.status,
            "created_at": n.created_at.isoformat() if n.created_at else None,
        }


multi_site_service = MultiSiteService()
