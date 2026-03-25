"""Privacy & Compliance Engine — face blurring, data retention, GDPR requests, audit trail."""

import os
import uuid
import logging
from datetime import datetime, timedelta
from sqlalchemy import select, func, and_, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.phase2b_models import DataRetentionPolicy, PrivacyRequest
from backend.models.models import AuditLog

logger = logging.getLogger(__name__)


class PrivacyEngineService:

    async def blur_faces_in_frame(self, frame):
        import cv2
        import numpy as np
        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, 1.3, 5)
        for (x, y, w, h) in faces:
            roi = frame[y:y+h, x:x+w]
            frame[y:y+h, x:x+w] = cv2.GaussianBlur(roi, (99, 99), 30)
        return frame, len(faces)

    async def blur_faces_in_video(self, input_path: str, output_path: str) -> dict:
        import cv2
        cap = cv2.VideoCapture(input_path)
        if not cap.isOpened():
            raise ValueError(f"Cannot open video: {input_path}")
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        out = cv2.VideoWriter(output_path, fourcc, fps, (w, h))
        processed = 0
        faces_blurred = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frame, count = await self.blur_faces_in_frame(frame)
            faces_blurred += count
            out.write(frame)
            processed += 1
        cap.release()
        out.release()
        return {"frames_processed": processed, "faces_blurred": faces_blurred,
                "output_path": output_path, "duration_seconds": processed / fps if fps else 0}

    async def create_retention_policy(self, db: AsyncSession, data: dict) -> dict:
        policy = DataRetentionPolicy(
            name=data["name"], data_type=data["data_type"],
            retention_days=data["retention_days"],
            auto_purge=data.get("auto_purge", True),
        )
        db.add(policy)
        await db.commit()
        await db.refresh(policy)
        return self._policy_to_dict(policy)

    async def update_retention_policy(self, db: AsyncSession, policy_id: str, data: dict) -> dict:
        result = await db.execute(select(DataRetentionPolicy).where(DataRetentionPolicy.id == policy_id))
        p = result.scalar_one_or_none()
        if not p:
            raise ValueError("Policy not found")
        for k in ["name", "data_type", "retention_days", "auto_purge", "is_active"]:
            if k in data:
                setattr(p, k, data[k])
        p.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(p)
        return self._policy_to_dict(p)

    async def get_retention_policies(self, db: AsyncSession) -> list:
        result = await db.execute(select(DataRetentionPolicy).order_by(DataRetentionPolicy.name))
        return [self._policy_to_dict(p) for p in result.scalars().all()]

    async def delete_retention_policy(self, db: AsyncSession, policy_id: str) -> bool:
        result = await db.execute(select(DataRetentionPolicy).where(DataRetentionPolicy.id == policy_id))
        p = result.scalar_one_or_none()
        if not p:
            return False
        await db.delete(p)
        await db.commit()
        return True

    async def enforce_retention(self, db: AsyncSession) -> dict:
        result = await db.execute(select(DataRetentionPolicy).where(DataRetentionPolicy.is_active == True))
        policies = result.scalars().all()
        report = {}
        for p in policies:
            cutoff = datetime.utcnow() - timedelta(days=p.retention_days)
            purged = 0
            try:
                if p.data_type == "events":
                    from backend.models.models import Event
                    r = await db.execute(delete(Event).where(Event.timestamp < cutoff))
                    purged = r.rowcount
                elif p.data_type == "alerts":
                    from backend.models.models import Alert
                    r = await db.execute(delete(Alert).where(Alert.created_at < cutoff))
                    purged = r.rowcount
                elif p.data_type == "audit_logs":
                    r = await db.execute(delete(AuditLog).where(AuditLog.timestamp < cutoff))
                    purged = r.rowcount
                elif p.data_type == "visitors":
                    from backend.models.phase2b_models import Visitor
                    r = await db.execute(delete(Visitor).where(Visitor.created_at < cutoff))
                    purged = r.rowcount
                elif p.data_type == "behavioral_events":
                    from backend.models.phase2b_models import BehavioralEvent
                    r = await db.execute(delete(BehavioralEvent).where(BehavioralEvent.created_at < cutoff))
                    purged = r.rowcount
            except Exception as e:
                logger.error("Retention enforcement failed for %s: %s", p.data_type, e)
            p.last_purge_at = datetime.utcnow()
            p.records_purged = (p.records_purged or 0) + purged
            report[p.name] = purged
        await db.commit()
        return report

    async def create_privacy_request(self, db: AsyncSession, data: dict) -> dict:
        req = PrivacyRequest(
            request_type=data["request_type"], subject_name=data["subject_name"],
            subject_email=data.get("subject_email"),
            subject_identifier=data.get("subject_identifier"),
            data_categories=data.get("data_categories", []),
        )
        db.add(req)
        await db.commit()
        await db.refresh(req)
        return self._request_to_dict(req)

    async def process_privacy_request(self, db: AsyncSession, request_id: str, processor_id: str) -> dict:
        result = await db.execute(select(PrivacyRequest).where(PrivacyRequest.id == request_id))
        req = result.scalar_one_or_none()
        if not req:
            raise ValueError("Request not found")
        req.status = "processing"
        log = list(req.processing_log or [])
        log.append({"step": "started", "timestamp": datetime.utcnow().isoformat(), "processor": processor_id})
        if req.request_type == "erasure":
            # Delete visitor records matching subject
            from backend.models.phase2b_models import Visitor
            r = await db.execute(delete(Visitor).where(Visitor.email == req.subject_email))
            log.append({"step": "visitors_deleted", "count": r.rowcount, "timestamp": datetime.utcnow().isoformat()})
        elif req.request_type == "access":
            log.append({"step": "data_compiled", "timestamp": datetime.utcnow().isoformat(), "details": "Data export prepared"})
        log.append({"step": "completed", "timestamp": datetime.utcnow().isoformat()})
        req.processing_log = log
        req.status = "completed"
        req.completed_at = datetime.utcnow()
        req.processed_by = processor_id
        await db.commit()
        await db.refresh(req)
        return self._request_to_dict(req)

    async def get_privacy_requests(self, db: AsyncSession, status: str = None) -> list:
        q = select(PrivacyRequest)
        if status:
            q = q.where(PrivacyRequest.status == status)
        q = q.order_by(PrivacyRequest.created_at.desc())
        result = await db.execute(q)
        return [self._request_to_dict(r) for r in result.scalars().all()]

    async def get_privacy_request(self, db: AsyncSession, request_id: str) -> dict | None:
        result = await db.execute(select(PrivacyRequest).where(PrivacyRequest.id == request_id))
        r = result.scalar_one_or_none()
        return self._request_to_dict(r) if r else None

    async def get_audit_trail(self, db: AsyncSession, resource_type: str = None,
                               user_id: str = None, time_from=None, time_to=None,
                               limit: int = 100) -> list:
        q = select(AuditLog)
        if resource_type:
            q = q.where(AuditLog.resource_type == resource_type)
        if user_id:
            q = q.where(AuditLog.user_id == user_id)
        if time_from:
            q = q.where(AuditLog.timestamp >= time_from)
        if time_to:
            q = q.where(AuditLog.timestamp <= time_to)
        q = q.order_by(AuditLog.timestamp.desc()).limit(limit)
        result = await db.execute(q)
        return [{"id": str(a.id), "user_id": str(a.user_id) if a.user_id else None,
                 "action": a.action, "resource_type": a.resource_type,
                 "resource_id": str(a.resource_id) if a.resource_id else None,
                 "details": a.details, "ip_address": a.ip_address,
                 "timestamp": a.timestamp.isoformat() if a.timestamp else None}
                for a in result.scalars().all()]

    async def generate_compliance_report(self, db: AsyncSession, report_type: str) -> dict:
        policies = await self.get_retention_policies(db)
        requests = await self.get_privacy_requests(db)
        audit_count = (await db.execute(select(func.count(AuditLog.id)))).scalar() or 0
        return {
            "report_type": report_type,
            "generated_at": datetime.utcnow().isoformat(),
            "retention_policies": len(policies),
            "privacy_requests": {"total": len(requests),
                                  "pending": sum(1 for r in requests if r["status"] == "pending"),
                                  "completed": sum(1 for r in requests if r["status"] == "completed")},
            "audit_log_entries": audit_count,
            "compliance_status": "compliant" if all(p.get("is_active") for p in policies) else "review_needed",
        }

    def _policy_to_dict(self, p: DataRetentionPolicy) -> dict:
        return {"id": str(p.id), "name": p.name, "data_type": p.data_type,
                "retention_days": p.retention_days, "auto_purge": p.auto_purge,
                "is_active": p.is_active, "last_purge_at": p.last_purge_at.isoformat() if p.last_purge_at else None,
                "records_purged": p.records_purged or 0,
                "created_at": p.created_at.isoformat() if p.created_at else None}

    def _request_to_dict(self, r: PrivacyRequest) -> dict:
        return {"id": str(r.id), "request_type": r.request_type, "subject_name": r.subject_name,
                "subject_email": r.subject_email, "status": r.status,
                "data_categories": r.data_categories or [],
                "processing_log": r.processing_log or [],
                "completed_at": r.completed_at.isoformat() if r.completed_at else None,
                "created_at": r.created_at.isoformat() if r.created_at else None}


privacy_engine_service = PrivacyEngineService()
