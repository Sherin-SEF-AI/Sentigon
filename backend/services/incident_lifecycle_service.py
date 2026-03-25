"""Incident Lifecycle Management Service — full workflow state machine."""

import uuid
import logging
from datetime import datetime, timedelta
from sqlalchemy import select, func, and_, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.phase2b_models import Incident, IncidentStatus, IncidentStatusLog

logger = logging.getLogger(__name__)

VALID_TRANSITIONS = {
    IncidentStatus.detected: [IncidentStatus.triaged],
    IncidentStatus.triaged: [IncidentStatus.assigned],
    IncidentStatus.assigned: [IncidentStatus.in_progress],
    IncidentStatus.in_progress: [IncidentStatus.resolved],
    IncidentStatus.resolved: [IncidentStatus.closed],
    IncidentStatus.closed: [IncidentStatus.reviewed, IncidentStatus.detected],
    IncidentStatus.reviewed: [IncidentStatus.detected],
}


class IncidentLifecycleService:

    async def create_incident(self, db: AsyncSession, data: dict) -> dict:
        inc = Incident(
            id=uuid.uuid4(),
            title=data["title"],
            description=data.get("description"),
            severity=data.get("severity", "medium"),
            incident_type=data.get("incident_type"),
            source=data.get("source", "manual"),
            confidence=data.get("confidence"),
            zone_id=data.get("zone_id"),
            camera_ids=data.get("camera_ids", []),
            assigned_to=data.get("assigned_to"),
            trigger_alert_ids=data.get("trigger_alert_ids", []),
            sla_acknowledge_minutes=data.get("sla_acknowledge_minutes", 5),
            sla_respond_minutes=data.get("sla_respond_minutes", 15),
            sla_resolve_minutes=data.get("sla_resolve_minutes", 60),
        )
        db.add(inc)
        log = IncidentStatusLog(
            incident_id=inc.id,
            to_status=IncidentStatus.detected.value,
            notes="Incident created",
        )
        db.add(log)
        await db.commit()
        await db.refresh(inc)
        return self._to_dict(inc)

    async def auto_create_from_alert(self, db: AsyncSession, alert_id: str, confidence: float, alert_data: dict) -> dict | None:
        if confidence < 0.7:
            return None
        data = {
            "title": alert_data.get("title", "Auto-detected incident"),
            "description": alert_data.get("description"),
            "severity": alert_data.get("severity", "medium"),
            "incident_type": alert_data.get("threat_type", "detection"),
            "source": "ai",
            "confidence": confidence,
            "zone_id": alert_data.get("zone_id"),
            "camera_ids": [alert_data["source_camera"]] if alert_data.get("source_camera") else [],
            "trigger_alert_ids": [alert_id],
        }
        return await self.create_incident(db, data)

    async def update_status(self, db: AsyncSession, incident_id: str, new_status: str, user_id: str = None, notes: str = None) -> dict:
        result = await db.execute(select(Incident).where(Incident.id == incident_id))
        inc = result.scalar_one_or_none()
        if not inc:
            raise ValueError("Incident not found")

        new_s = IncidentStatus(new_status)
        current_s = inc.status

        if new_s == IncidentStatus.detected:
            pass  # reopen always allowed
        elif new_s not in VALID_TRANSITIONS.get(current_s, []):
            raise ValueError(f"Invalid transition: {current_s.value} → {new_s.value}")

        old_status = current_s.value
        inc.status = new_s
        now = datetime.utcnow()

        if new_s == IncidentStatus.triaged:
            inc.acknowledged_at = now
        elif new_s == IncidentStatus.in_progress:
            inc.responded_at = now
        elif new_s == IncidentStatus.resolved:
            inc.resolved_at = now
        elif new_s == IncidentStatus.closed:
            inc.closed_at = now
        elif new_s == IncidentStatus.reviewed:
            inc.reviewed_at = now
            if notes:
                inc.review_notes = notes

        inc.updated_at = now
        log = IncidentStatusLog(
            incident_id=inc.id,
            from_status=old_status,
            to_status=new_s.value,
            changed_by=user_id,
            notes=notes,
        )
        db.add(log)
        await db.commit()
        await db.refresh(inc)
        return self._to_dict(inc)

    async def assign_incident(self, db: AsyncSession, incident_id: str, user_id: str) -> dict:
        result = await db.execute(select(Incident).where(Incident.id == incident_id))
        inc = result.scalar_one_or_none()
        if not inc:
            raise ValueError("Incident not found")
        inc.assigned_to = user_id
        inc.updated_at = datetime.utcnow()
        if inc.status == IncidentStatus.triaged:
            return await self.update_status(db, str(inc.id), "assigned", user_id, "Auto-transitioned on assignment")
        await db.commit()
        await db.refresh(inc)
        return self._to_dict(inc)

    async def merge_incidents(self, db: AsyncSession, primary_id: str, merge_ids: list[str]) -> dict:
        result = await db.execute(select(Incident).where(Incident.id == primary_id))
        primary = result.scalar_one_or_none()
        if not primary:
            raise ValueError("Primary incident not found")
        for mid in merge_ids:
            r = await db.execute(select(Incident).where(Incident.id == mid))
            other = r.scalar_one_or_none()
            if other:
                other.merged_into = primary.id
                other.status = IncidentStatus.closed
                other.closed_at = datetime.utcnow()
                primary.trigger_alert_ids = list(set((primary.trigger_alert_ids or []) + (other.trigger_alert_ids or [])))
                primary.camera_ids = list(set((primary.camera_ids or []) + (other.camera_ids or [])))
        primary.merged_from = list(set((primary.merged_from or []) + merge_ids))
        primary.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(primary)
        return self._to_dict(primary)

    def get_sla_status(self, inc_dict: dict) -> dict:
        now = datetime.utcnow()
        created = inc_dict.get("created_at")
        if isinstance(created, str):
            created = datetime.fromisoformat(created.replace("Z", "+00:00")).replace(tzinfo=None)
        sla = {}
        for key, minutes_key, done_key in [
            ("acknowledge", "sla_acknowledge_minutes", "acknowledged_at"),
            ("respond", "sla_respond_minutes", "responded_at"),
            ("resolve", "sla_resolve_minutes", "resolved_at"),
        ]:
            deadline = created + timedelta(minutes=inc_dict.get(minutes_key, 60))
            done_at = inc_dict.get(done_key)
            if done_at:
                if isinstance(done_at, str):
                    done_at = datetime.fromisoformat(done_at.replace("Z", "+00:00")).replace(tzinfo=None)
                sla[key] = {"status": "met" if done_at <= deadline else "breached", "completed_at": done_at.isoformat()}
            else:
                remaining = (deadline - now).total_seconds()
                sla[key] = {"status": "on_track" if remaining > 0 else "breached", "remaining_seconds": max(remaining, 0)}
        return sla

    async def generate_ai_summary(self, db: AsyncSession, incident_id: str) -> str:
        result = await db.execute(select(Incident).where(Incident.id == incident_id))
        inc = result.scalar_one_or_none()
        if not inc:
            raise ValueError("Incident not found")
        logs_r = await db.execute(
            select(IncidentStatusLog).where(IncidentStatusLog.incident_id == incident_id)
            .order_by(IncidentStatusLog.created_at)
        )
        logs = logs_r.scalars().all()
        timeline_text = "\n".join(
            f"- {l.created_at.isoformat() if l.created_at else '?'}: {l.from_status or 'created'} → {l.to_status}" + (f" ({l.notes})" if l.notes else "")
            for l in logs
        )
        prompt = f"Summarize this security incident timeline concisely:\nTitle: {inc.title}\nType: {inc.incident_type}\nSeverity: {inc.severity}\nTimeline:\n{timeline_text}"
        try:
            from backend.services.ai_text_service import ai_generate_text
            summary = await ai_generate_text(prompt)
        except Exception:
            summary = f"Incident '{inc.title}' ({inc.severity}) — {len(logs)} status transitions recorded."
        inc.ai_summary = summary
        inc.updated_at = datetime.utcnow()
        await db.commit()
        return summary

    async def attach_evidence(self, db: AsyncSession, incident_id: str, evidence_type: str, reference_id: str) -> dict:
        result = await db.execute(select(Incident).where(Incident.id == incident_id))
        inc = result.scalar_one_or_none()
        if not inc:
            raise ValueError("Incident not found")
        ids = list(inc.evidence_ids or [])
        ids.append({"type": evidence_type, "id": reference_id, "added_at": datetime.utcnow().isoformat()})
        inc.evidence_ids = ids
        inc.updated_at = datetime.utcnow()
        await db.commit()
        return {"attached": True, "evidence_count": len(ids)}

    async def get_incident_timeline(self, db: AsyncSession, incident_id: str) -> list:
        result = await db.execute(
            select(IncidentStatusLog).where(IncidentStatusLog.incident_id == incident_id)
            .order_by(IncidentStatusLog.created_at)
        )
        logs = result.scalars().all()
        return [{"id": str(l.id), "from_status": l.from_status, "to_status": l.to_status,
                 "changed_by": str(l.changed_by) if l.changed_by else None,
                 "notes": l.notes, "created_at": l.created_at.isoformat() if l.created_at else None} for l in logs]

    async def list_incidents(self, db: AsyncSession, status: str = None, severity: str = None,
                             date_from: str = None, date_to: str = None, assigned_to: str = None,
                             limit: int = 50, offset: int = 0) -> dict:
        q = select(Incident).where(Incident.merged_into.is_(None))
        if status:
            q = q.where(Incident.status == status)
        if severity:
            q = q.where(Incident.severity == severity)
        if date_from:
            q = q.where(Incident.created_at >= date_from)
        if date_to:
            q = q.where(Incident.created_at <= date_to)
        if assigned_to:
            q = q.where(Incident.assigned_to == assigned_to)

        count_q = select(func.count()).select_from(q.subquery())
        total = (await db.execute(count_q)).scalar() or 0

        q = q.order_by(Incident.created_at.desc()).limit(limit).offset(offset)
        result = await db.execute(q)
        incidents = result.scalars().all()
        return {"total": total, "items": [self._to_dict(i) for i in incidents]}

    async def get_incident(self, db: AsyncSession, incident_id: str) -> dict | None:
        result = await db.execute(select(Incident).where(Incident.id == incident_id))
        inc = result.scalar_one_or_none()
        if not inc:
            return None
        d = self._to_dict(inc)
        d["sla"] = self.get_sla_status(d)
        d["timeline"] = await self.get_incident_timeline(db, incident_id)
        return d

    async def get_incident_stats(self, db: AsyncSession) -> dict:
        total = (await db.execute(select(func.count(Incident.id)))).scalar() or 0
        open_q = select(func.count(Incident.id)).where(Incident.status.in_([
            IncidentStatus.detected, IncidentStatus.triaged, IncidentStatus.assigned, IncidentStatus.in_progress
        ]))
        open_count = (await db.execute(open_q)).scalar() or 0
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        resolved_today = (await db.execute(
            select(func.count(Incident.id)).where(and_(Incident.resolved_at >= today, Incident.resolved_at.isnot(None)))
        )).scalar() or 0
        # SLA breach count
        breached = 0
        open_r = await db.execute(select(Incident).where(Incident.status.in_([
            IncidentStatus.detected, IncidentStatus.triaged, IncidentStatus.assigned, IncidentStatus.in_progress
        ])))
        for inc in open_r.scalars().all():
            d = self._to_dict(inc)
            sla = self.get_sla_status(d)
            if any(v.get("status") == "breached" for v in sla.values()):
                breached += 1
        return {"total": total, "open": open_count, "resolved_today": resolved_today, "sla_breaches": breached}

    def _to_dict(self, inc: Incident) -> dict:
        return {
            "id": str(inc.id),
            "title": inc.title,
            "description": inc.description,
            "status": inc.status.value if inc.status else None,
            "severity": inc.severity,
            "incident_type": inc.incident_type,
            "source": inc.source,
            "confidence": inc.confidence,
            "zone_id": str(inc.zone_id) if inc.zone_id else None,
            "camera_ids": inc.camera_ids or [],
            "assigned_to": str(inc.assigned_to) if inc.assigned_to else None,
            "merged_into": str(inc.merged_into) if inc.merged_into else None,
            "merged_from": inc.merged_from or [],
            "trigger_alert_ids": inc.trigger_alert_ids or [],
            "sla_acknowledge_minutes": inc.sla_acknowledge_minutes,
            "sla_respond_minutes": inc.sla_respond_minutes,
            "sla_resolve_minutes": inc.sla_resolve_minutes,
            "acknowledged_at": inc.acknowledged_at.isoformat() if inc.acknowledged_at else None,
            "responded_at": inc.responded_at.isoformat() if inc.responded_at else None,
            "resolved_at": inc.resolved_at.isoformat() if inc.resolved_at else None,
            "closed_at": inc.closed_at.isoformat() if inc.closed_at else None,
            "reviewed_at": inc.reviewed_at.isoformat() if inc.reviewed_at else None,
            "review_notes": inc.review_notes,
            "ai_summary": inc.ai_summary,
            "evidence_ids": inc.evidence_ids or [],
            "created_at": inc.created_at.isoformat() if inc.created_at else None,
            "updated_at": inc.updated_at.isoformat() if inc.updated_at else None,
        }


incident_lifecycle_service = IncidentLifecycleService()
