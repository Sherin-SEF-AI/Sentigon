"""SOC Operator Workspace Service — customizable dashboards, widgets, shift briefings, operator metrics."""

import uuid
import logging
from datetime import datetime, timedelta
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.phase2b_models import OperatorWorkspace, Incident
from backend.models.models import Alert, AuditLog, Zone

logger = logging.getLogger(__name__)

AVAILABLE_WIDGETS = [
    {"type": "alert_feed", "name": "Alert Feed", "default_size": {"w": 4, "h": 3}},
    {"type": "camera_preview", "name": "Camera Preview", "default_size": {"w": 4, "h": 3}},
    {"type": "threat_level", "name": "Threat Level", "default_size": {"w": 2, "h": 1}},
    {"type": "incident_count", "name": "Active Incidents", "default_size": {"w": 2, "h": 1}},
    {"type": "zone_occupancy", "name": "Zone Occupancy", "default_size": {"w": 3, "h": 2}},
    {"type": "event_timeline", "name": "Event Timeline", "default_size": {"w": 6, "h": 2}},
    {"type": "agent_status", "name": "Agent Status", "default_size": {"w": 3, "h": 2}},
    {"type": "sla_tracker", "name": "SLA Tracker", "default_size": {"w": 3, "h": 2}},
    {"type": "map_view", "name": "Site Map", "default_size": {"w": 4, "h": 3}},
    {"type": "shift_info", "name": "Shift Info", "default_size": {"w": 2, "h": 1}},
    {"type": "quick_actions", "name": "Quick Actions", "default_size": {"w": 2, "h": 2}},
    {"type": "metrics_chart", "name": "Metrics Chart", "default_size": {"w": 4, "h": 2}},
    {"type": "notifications", "name": "Notifications", "default_size": {"w": 3, "h": 2}},
]

DEFAULT_LAYOUT = [
    {"widget_type": "threat_level", "x": 0, "y": 0, "w": 2, "h": 1, "config": {}},
    {"widget_type": "incident_count", "x": 2, "y": 0, "w": 2, "h": 1, "config": {}},
    {"widget_type": "alert_feed", "x": 0, "y": 1, "w": 4, "h": 3, "config": {}},
    {"widget_type": "zone_occupancy", "x": 4, "y": 0, "w": 4, "h": 2, "config": {}},
    {"widget_type": "event_timeline", "x": 4, "y": 2, "w": 8, "h": 2, "config": {}},
    {"widget_type": "agent_status", "x": 8, "y": 0, "w": 4, "h": 2, "config": {}},
]


class SOCWorkspaceService:

    async def get_workspace(self, db: AsyncSession, user_id: str) -> dict:
        result = await db.execute(select(OperatorWorkspace).where(OperatorWorkspace.user_id == user_id))
        ws = result.scalar_one_or_none()
        if not ws:
            ws = OperatorWorkspace(user_id=user_id, layout=DEFAULT_LAYOUT)
            db.add(ws)
            await db.commit()
            await db.refresh(ws)
        return self._to_dict(ws)

    async def save_workspace(self, db: AsyncSession, user_id: str, data: dict) -> dict:
        result = await db.execute(select(OperatorWorkspace).where(OperatorWorkspace.user_id == user_id))
        ws = result.scalar_one_or_none()
        if not ws:
            ws = OperatorWorkspace(user_id=user_id)
            db.add(ws)
        for k in ["layout", "theme", "alert_sound_enabled", "alert_tiers", "keyboard_shortcuts"]:
            if k in data:
                setattr(ws, k, data[k])
        ws.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(ws)
        return self._to_dict(ws)

    async def reset_workspace(self, db: AsyncSession, user_id: str) -> dict:
        return await self.save_workspace(db, user_id, {"layout": DEFAULT_LAYOUT})

    def get_available_widgets(self) -> list:
        return AVAILABLE_WIDGETS

    async def get_widget_data(self, db: AsyncSession, widget_type: str, config: dict = None) -> dict:
        if widget_type == "alert_feed":
            result = await db.execute(
                select(Alert).where(Alert.status.in_(["new", "acknowledged", "investigating"]))
                .order_by(Alert.created_at.desc()).limit(20)
            )
            return {"alerts": [{"id": str(a.id), "title": a.title, "severity": a.severity,
                               "status": a.status, "created_at": a.created_at.isoformat() if a.created_at else None}
                              for a in result.scalars().all()]}
        elif widget_type == "incident_count":
            active = (await db.execute(
                select(func.count(Incident.id)).where(
                    Incident.status.in_(["detected", "triaged", "assigned", "in_progress"])
                )
            )).scalar() or 0
            return {"active_incidents": active}
        elif widget_type == "zone_occupancy":
            result = await db.execute(select(Zone).where(Zone.is_active == True))
            return {"zones": [{"name": z.name, "current": z.current_occupancy or 0,
                              "max": z.max_occupancy or 100} for z in result.scalars().all()]}
        elif widget_type == "agent_status":
            try:
                from backend.agents.agent_registry import agent_registry
                agents = [{"name": n, "status": a._status, "tier": a.tier, "cycles": a._cycle_count}
                          for n, a in agent_registry._agents.items()]
                return {"agents": agents}
            except Exception:
                return {"agents": []}
        elif widget_type == "threat_level":
            critical = (await db.execute(
                select(func.count(Alert.id)).where(and_(Alert.severity == "critical", Alert.status == "new"))
            )).scalar() or 0
            level = 5 if critical >= 3 else 4 if critical >= 1 else 3
            return {"level": level, "label": ["Low", "Guarded", "Elevated", "High", "Severe"][level - 1]}
        elif widget_type == "metrics_chart":
            from backend.models.models import Event
            today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
            hours = []
            for h in range(24):
                t = today + timedelta(hours=h)
                c = (await db.execute(
                    select(func.count(Event.id)).where(and_(Event.timestamp >= t, Event.timestamp < t + timedelta(hours=1)))
                )).scalar() or 0
                hours.append({"hour": h, "events": c})
            return {"hourly_events": hours}
        return {}

    async def generate_shift_briefing(self, db: AsyncSession) -> dict:
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        active_incidents = (await db.execute(
            select(func.count(Incident.id)).where(
                Incident.status.in_(["detected", "triaged", "assigned", "in_progress"])
            )
        )).scalar() or 0
        alerts_today = (await db.execute(select(func.count(Alert.id)).where(Alert.created_at >= today))).scalar() or 0
        critical_alerts = (await db.execute(
            select(func.count(Alert.id)).where(and_(Alert.severity == "critical", Alert.created_at >= today))
        )).scalar() or 0
        briefing = {
            "generated_at": datetime.utcnow().isoformat(),
            "active_incidents": active_incidents,
            "alerts_today": alerts_today,
            "critical_alerts": critical_alerts,
            "summary": f"Current shift: {active_incidents} active incidents, {alerts_today} alerts today ({critical_alerts} critical).",
        }
        try:
            from backend.services.ai_text_service import ai_generate_text
            prompt = f"Generate a brief security shift handoff briefing. Active incidents: {active_incidents}. Alerts today: {alerts_today}. Critical: {critical_alerts}."
            briefing["ai_summary"] = await ai_generate_text(prompt)
        except Exception:
            briefing["ai_summary"] = briefing["summary"]
        return briefing

    async def get_operator_metrics(self, db: AsyncSession, user_id: str = None, days: int = 7) -> dict:
        cutoff = datetime.utcnow() - timedelta(days=days)
        q = select(Alert).where(Alert.created_at >= cutoff)
        if user_id:
            q = q.where(Alert.assigned_to == user_id)
        result = await db.execute(q)
        alerts = result.scalars().all()
        total = len(alerts)
        dismissed = sum(1 for a in alerts if a.status == "dismissed")
        resolved = sum(1 for a in alerts if a.status == "resolved")
        response_times = []
        for a in alerts:
            if a.acknowledged_at and a.created_at:
                dt = (a.acknowledged_at - a.created_at).total_seconds()
                response_times.append(dt)
        avg_response = sum(response_times) / len(response_times) if response_times else 0
        return {
            "alerts_handled": total, "dismissed": dismissed, "resolved": resolved,
            "false_positive_rate": round(dismissed / total * 100, 1) if total else 0,
            "avg_response_seconds": round(avg_response, 1),
            "period_days": days,
        }

    def _to_dict(self, ws: OperatorWorkspace) -> dict:
        return {
            "id": str(ws.id), "user_id": str(ws.user_id) if ws.user_id else None,
            "layout": ws.layout or [], "theme": ws.theme,
            "alert_sound_enabled": ws.alert_sound_enabled,
            "alert_tiers": ws.alert_tiers or {}, "keyboard_shortcuts": ws.keyboard_shortcuts or {},
        }


soc_workspace_service = SOCWorkspaceService()
