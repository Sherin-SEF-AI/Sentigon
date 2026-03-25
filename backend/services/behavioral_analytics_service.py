"""Behavioral Analytics Service — loitering, crowd flow, tailgating, unusual access, occupancy."""

import logging
from datetime import datetime, timedelta
from sqlalchemy import select, func, and_, or_, extract
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.models import Event, Zone
from backend.models.phase2b_models import BehavioralEvent

logger = logging.getLogger(__name__)


class BehavioralAnalyticsService:

    async def detect_loitering(self, db: AsyncSession, zone_id: str = None,
                                dwell_threshold_seconds: float = 300) -> list:
        q = select(Event).where(Event.event_type.in_(["person_detected", "detection", "object_detected"]))
        if zone_id:
            q = q.where(Event.zone_id == zone_id)
        q = q.where(Event.timestamp >= datetime.utcnow() - timedelta(hours=1))
        q = q.order_by(Event.timestamp.desc()).limit(500)
        result = await db.execute(q)
        loitering = []
        for e in result.scalars().all():
            dets = e.detections or []
            for det in (dets if isinstance(dets, list) else [dets]):
                dwell = det.get("dwell_time", 0) if isinstance(det, dict) else 0
                if dwell >= dwell_threshold_seconds:
                    loitering.append({
                        "event_id": str(e.id),
                        "camera_id": str(e.camera_id) if e.camera_id else None,
                        "zone_id": str(e.zone_id) if e.zone_id else None,
                        "track_id": det.get("track_id") if isinstance(det, dict) else None,
                        "dwell_seconds": dwell,
                        "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                        "frame_url": e.frame_url,
                    })
        return loitering

    async def analyze_crowd_flow(self, db: AsyncSession, zone_id: str,
                                  time_from: datetime, time_to: datetime) -> dict:
        q = select(Event).where(and_(
            Event.zone_id == zone_id,
            Event.timestamp >= time_from,
            Event.timestamp <= time_to,
        )).order_by(Event.timestamp.asc())
        result = await db.execute(q)
        events = result.scalars().all()

        # Aggregate occupancy over time buckets (5-minute intervals)
        buckets = {}
        for e in events:
            if e.timestamp:
                bucket = e.timestamp.replace(second=0, microsecond=0)
                bucket = bucket.replace(minute=(bucket.minute // 5) * 5)
                key = bucket.isoformat()
                if key not in buckets:
                    buckets[key] = {"time": key, "count": 0, "entries": 0, "exits": 0}
                dets = e.detections or []
                person_count = sum(1 for d in (dets if isinstance(dets, list) else []) if isinstance(d, dict) and d.get("class_name") == "person")
                buckets[key]["count"] = max(buckets[key]["count"], person_count)
                buckets[key]["entries"] += 1

        density_over_time = sorted(buckets.values(), key=lambda x: x["time"])
        peak = max((b["count"] for b in density_over_time), default=0)
        avg = sum(b["count"] for b in density_over_time) / max(len(density_over_time), 1)
        return {
            "zone_id": zone_id,
            "peak_occupancy": peak,
            "avg_occupancy": round(avg, 1),
            "total_events": len(events),
            "density_over_time": density_over_time,
        }

    async def detect_tailgating(self, db: AsyncSession, time_from=None, time_to=None) -> list:
        try:
            from backend.models.phase2_models import AccessEvent
        except ImportError:
            return []
        t_from = time_from or (datetime.utcnow() - timedelta(hours=24))
        t_to = time_to or datetime.utcnow()
        q = select(AccessEvent).where(and_(
            AccessEvent.event_type == "granted",
            AccessEvent.timestamp >= t_from,
            AccessEvent.timestamp <= t_to,
        )).order_by(AccessEvent.timestamp.asc())
        result = await db.execute(q)
        access_events = result.scalars().all()

        tailgating = []
        for i, ae in enumerate(access_events):
            if ae.camera_id:
                cam_events = await db.execute(
                    select(Event).where(and_(
                        Event.camera_id == ae.camera_id,
                        Event.timestamp >= ae.timestamp - timedelta(seconds=5),
                        Event.timestamp <= ae.timestamp + timedelta(seconds=10),
                    )).limit(5)
                )
                for ce in cam_events.scalars().all():
                    dets = ce.detections or []
                    person_count = sum(1 for d in (dets if isinstance(dets, list) else []) if isinstance(d, dict) and d.get("class_name") == "person")
                    if person_count >= 2:
                        tailgating.append({
                            "access_event_id": str(ae.id) if hasattr(ae, 'id') else None,
                            "door_id": ae.door_id,
                            "user": ae.user_identifier,
                            "camera_id": str(ae.camera_id) if ae.camera_id else None,
                            "person_count": person_count,
                            "timestamp": ae.timestamp.isoformat() if ae.timestamp else None,
                        })
                        break
        return tailgating

    async def detect_unusual_access(self, db: AsyncSession, time_window_hours: int = 24) -> list:
        try:
            from backend.models.phase2_models import AccessEvent
        except ImportError:
            return []
        cutoff = datetime.utcnow() - timedelta(hours=time_window_hours)
        q = select(AccessEvent).where(and_(
            AccessEvent.timestamp >= cutoff,
            or_(
                extract("hour", AccessEvent.timestamp) < 6,
                extract("hour", AccessEvent.timestamp) > 22,
            )
        )).order_by(AccessEvent.timestamp.desc()).limit(100)
        result = await db.execute(q)
        return [{"user": ae.user_identifier, "door_id": ae.door_id,
                 "event_type": ae.event_type,
                 "timestamp": ae.timestamp.isoformat() if ae.timestamp else None,
                 "hour": ae.timestamp.hour if ae.timestamp else None}
                for ae in result.scalars().all()]

    async def get_occupancy_compliance(self, db: AsyncSession) -> list:
        result = await db.execute(select(Zone).where(Zone.is_active == True))
        zones = result.scalars().all()
        compliance = []
        for z in zones:
            current = z.current_occupancy or 0
            maximum = z.max_occupancy or 999
            status = "compliant" if current <= maximum else "violation"
            utilization = round((current / maximum) * 100, 1) if maximum > 0 else 0
            compliance.append({
                "zone_id": str(z.id), "zone_name": z.name,
                "current_occupancy": current, "max_occupancy": maximum,
                "utilization_percent": utilization, "status": status,
            })
        return compliance

    async def get_behavioral_events(self, db: AsyncSession, event_type: str = None,
                                     zone_id: str = None, resolved: bool = None,
                                     limit: int = 50) -> list:
        q = select(BehavioralEvent)
        if event_type:
            q = q.where(BehavioralEvent.event_type == event_type)
        if zone_id:
            q = q.where(BehavioralEvent.zone_id == zone_id)
        if resolved is not None:
            q = q.where(BehavioralEvent.resolved == resolved)
        q = q.order_by(BehavioralEvent.created_at.desc()).limit(limit)
        result = await db.execute(q)
        return [self._event_to_dict(e) for e in result.scalars().all()]

    async def resolve_event(self, db: AsyncSession, event_id: str, user_id: str) -> dict:
        result = await db.execute(select(BehavioralEvent).where(BehavioralEvent.id == event_id))
        event = result.scalar_one_or_none()
        if not event:
            raise ValueError("Behavioral event not found")
        event.resolved = True
        event.resolved_by = user_id
        await db.commit()
        await db.refresh(event)
        return self._event_to_dict(event)

    async def get_stats(self, db: AsyncSession) -> dict:
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        total = (await db.execute(select(func.count(BehavioralEvent.id)))).scalar() or 0
        today_count = (await db.execute(
            select(func.count(BehavioralEvent.id)).where(BehavioralEvent.created_at >= today)
        )).scalar() or 0
        unresolved = (await db.execute(
            select(func.count(BehavioralEvent.id)).where(BehavioralEvent.resolved == False)
        )).scalar() or 0
        # Count by type
        type_counts = {}
        for evt_type in ["loitering", "tailgating", "crowd_surge", "unusual_access", "occupancy_violation"]:
            c = (await db.execute(
                select(func.count(BehavioralEvent.id)).where(and_(
                    BehavioralEvent.event_type == evt_type, BehavioralEvent.created_at >= today
                ))
            )).scalar() or 0
            type_counts[evt_type] = c
        return {"total": total, "today": today_count, "unresolved": unresolved, "by_type": type_counts}

    def _event_to_dict(self, e: BehavioralEvent) -> dict:
        return {
            "id": str(e.id), "event_type": e.event_type,
            "camera_id": str(e.camera_id) if e.camera_id else None,
            "zone_id": str(e.zone_id) if e.zone_id else None,
            "severity": e.severity, "confidence": e.confidence,
            "subject_track_id": e.subject_track_id,
            "details": e.details, "duration_seconds": e.duration_seconds,
            "frame_path": e.frame_path, "resolved": e.resolved,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }


behavioral_analytics_service = BehavioralAnalyticsService()
