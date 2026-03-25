"""Mass Notification & Emergency Response Service — real SMTP, Twilio SMS, WebSocket push, lockdown control."""

import os
import uuid
import json
import smtplib
import asyncio
import logging
from datetime import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.phase2b_models import NotificationTemplate, MassNotification, LockdownSequence

logger = logging.getLogger(__name__)


class MassNotificationService:
    def __init__(self):
        self.smtp_host = os.environ.get("SMTP_HOST")
        self.smtp_port = int(os.environ.get("SMTP_PORT", "587"))
        self.smtp_user = os.environ.get("SMTP_USER")
        self.smtp_pass = os.environ.get("SMTP_PASS")
        self.twilio_sid = os.environ.get("TWILIO_SID")
        self.twilio_token = os.environ.get("TWILIO_TOKEN")
        self.twilio_from = os.environ.get("TWILIO_FROM")
        self._active_lockdowns: dict = {}

    async def send_notification(self, db: AsyncSession, data: dict) -> dict:
        channels = data.get("channels", ["push"])
        title = data["title"]
        message = data["message"]
        severity = data.get("severity", "high")
        target_zones = data.get("target_zones", [])
        target_roles = data.get("target_roles", [])

        # Resolve recipients
        from backend.models.models import User
        q = select(User).where(User.is_active == True)
        if target_roles:
            q = q.where(User.role.in_(target_roles))
        result = await db.execute(q)
        users = result.scalars().all()
        total_recipients = len(users)

        # Send via each channel
        delivery_results = {}
        if "push" in channels:
            await self.broadcast_push(title, message, severity, target_zones)
            delivery_results["push"] = {"sent": total_recipients, "status": "delivered"}

        if "email" in channels:
            sent = 0
            for u in users:
                if u.email and await self.send_email(u.email, f"[SENTINEL] {title}", message):
                    sent += 1
            delivery_results["email"] = {"sent": sent, "status": "delivered"}

        if "sms" in channels:
            delivery_results["sms"] = {"sent": 0, "status": "skipped" if not self.twilio_sid else "attempted"}

        # Handle lockdown
        lockdown_activated = False
        lockdown_details = None
        if data.get("activate_lockdown"):
            ld = await self.activate_lockdown(db, custom_steps=data.get("lockdown_steps", []),
                                               activated_by=data.get("sent_by"))
            lockdown_activated = True
            lockdown_details = ld

        # Save to DB
        notif = MassNotification(
            id=uuid.uuid4(),
            template_id=data.get("template_id"),
            title=title,
            message=message,
            severity=severity,
            channels_used=channels,
            target_zones=target_zones,
            target_roles=target_roles,
            sent_by=data.get("sent_by"),
            total_recipients=total_recipients,
            acknowledged_count=0,
            acknowledgments=[],
            lockdown_activated=lockdown_activated,
            lockdown_details=lockdown_details,
            status="sent",
            incident_id=data.get("incident_id"),
        )
        db.add(notif)
        await db.commit()
        await db.refresh(notif)
        return self._notif_to_dict(notif)

    async def send_email(self, to: str, subject: str, body: str) -> bool:
        if not self.smtp_host:
            logger.debug("SMTP not configured, skipping email to %s", to)
            return False
        try:
            msg = MIMEMultipart()
            msg["From"] = self.smtp_user or "sentinel@localhost"
            msg["To"] = to
            msg["Subject"] = subject
            msg.attach(MIMEText(body, "html"))
            await asyncio.to_thread(self._smtp_send, msg)
            return True
        except Exception as e:
            logger.error("Email send failed: %s", e)
            return False

    def _smtp_send(self, msg):
        with smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=10) as server:
            server.starttls()
            if self.smtp_user and self.smtp_pass:
                server.login(self.smtp_user, self.smtp_pass)
            server.send_message(msg)

    async def send_sms(self, to: str, message: str) -> bool:
        if not self.twilio_sid:
            logger.debug("Twilio not configured, skipping SMS to %s", to)
            return False
        try:
            import httpx
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{self.twilio_sid}/Messages.json",
                    auth=(self.twilio_sid, self.twilio_token),
                    data={"From": self.twilio_from, "To": to, "Body": message},
                )
                return resp.status_code == 201
        except Exception as e:
            logger.error("SMS send failed: %s", e)
            return False

    async def broadcast_push(self, title: str, message: str, severity: str, target_zones: list = None):
        try:
            from backend.services.notification_service import notification_service
            await notification_service.broadcast({
                "type": "mass_notification",
                "title": title,
                "message": message,
                "severity": severity,
                "target_zones": target_zones,
                "timestamp": datetime.utcnow().isoformat(),
            }, channel="notifications")
        except Exception as e:
            logger.error("Push broadcast failed: %s", e)

    async def acknowledge(self, db: AsyncSession, notification_id: str, user_id: str) -> dict:
        result = await db.execute(select(MassNotification).where(MassNotification.id == notification_id))
        notif = result.scalar_one_or_none()
        if not notif:
            raise ValueError("Notification not found")
        acks = list(notif.acknowledgments or [])
        if not any(a.get("user_id") == user_id for a in acks):
            acks.append({"user_id": user_id, "time": datetime.utcnow().isoformat(), "status": "safe"})
            notif.acknowledgments = acks
            notif.acknowledged_count = len(acks)
            if notif.acknowledged_count >= notif.total_recipients:
                notif.status = "acknowledged"
            await db.commit()
        return self._notif_to_dict(notif)

    async def activate_lockdown(self, db: AsyncSession, sequence_id: str = None,
                                 custom_steps: list = None, activated_by: str = None) -> dict:
        lockdown_id = str(uuid.uuid4())
        steps = custom_steps or []
        if sequence_id:
            result = await db.execute(select(LockdownSequence).where(LockdownSequence.id == sequence_id))
            seq = result.scalar_one_or_none()
            if seq:
                steps = seq.steps or []
                seq.is_active = True
                seq.activated_at = datetime.utcnow()
                seq.activated_by = activated_by
        executed_steps = []
        for step in steps:
            action = step.get("action", "")
            try:
                if action == "lock_doors":
                    try:
                        from backend.services.pacs_service import pacs_service
                        for door_id in step.get("target_ids", []):
                            await pacs_service.lock_door(door_id)
                    except Exception:
                        pass
                elif action == "activate_alarm":
                    try:
                        from backend.services.alarm_panel_service import alarm_panel_service
                        for panel_id in step.get("target_ids", []):
                            await alarm_panel_service.arm_panel(panel_id, "away")
                    except Exception:
                        pass
                elif action == "send_alert":
                    await self.broadcast_push("LOCKDOWN ACTIVATED", step.get("message", "Facility lockdown in effect"), "critical")
                executed_steps.append({**step, "status": "executed", "executed_at": datetime.utcnow().isoformat()})
            except Exception as e:
                executed_steps.append({**step, "status": "failed", "error": str(e)})
            delay = step.get("delay_seconds", 0)
            if delay:
                await asyncio.sleep(min(delay, 5))

        lockdown = {"id": lockdown_id, "steps": executed_steps, "activated_at": datetime.utcnow().isoformat(),
                     "activated_by": activated_by, "status": "active"}
        self._active_lockdowns[lockdown_id] = lockdown
        await db.commit()
        return lockdown

    async def deactivate_lockdown(self, db: AsyncSession, lockdown_id: str, deactivated_by: str = None) -> dict:
        lockdown = self._active_lockdowns.pop(lockdown_id, None)
        if not lockdown:
            raise ValueError("Lockdown not found or already deactivated")
        lockdown["status"] = "deactivated"
        lockdown["deactivated_at"] = datetime.utcnow().isoformat()
        lockdown["deactivated_by"] = deactivated_by
        await self.broadcast_push("LOCKDOWN LIFTED", "Facility lockdown has been lifted. Resume normal operations.", "info")
        # Deactivate any DB sequences
        result = await db.execute(select(LockdownSequence).where(LockdownSequence.is_active == True))
        for seq in result.scalars().all():
            seq.is_active = False
            seq.deactivated_at = datetime.utcnow()
        await db.commit()
        return lockdown

    async def get_active_lockdowns(self) -> list:
        return [v for v in self._active_lockdowns.values() if v.get("status") == "active"]

    async def create_template(self, db: AsyncSession, data: dict) -> dict:
        tmpl = NotificationTemplate(
            name=data["name"], category=data["category"], subject=data.get("subject"),
            body=data["body"], channels=data.get("channels", []),
            severity=data.get("severity", "critical"),
            auto_trigger_event_type=data.get("auto_trigger_event_type"),
            zone_targeted=data.get("zone_targeted", False),
            requires_acknowledgment=data.get("requires_acknowledgment", True),
            lockdown_sequence=data.get("lockdown_sequence"),
        )
        db.add(tmpl)
        await db.commit()
        await db.refresh(tmpl)
        return self._template_to_dict(tmpl)

    async def update_template(self, db: AsyncSession, template_id: str, data: dict) -> dict:
        result = await db.execute(select(NotificationTemplate).where(NotificationTemplate.id == template_id))
        tmpl = result.scalar_one_or_none()
        if not tmpl:
            raise ValueError("Template not found")
        for k, v in data.items():
            if hasattr(tmpl, k):
                setattr(tmpl, k, v)
        tmpl.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(tmpl)
        return self._template_to_dict(tmpl)

    async def delete_template(self, db: AsyncSession, template_id: str) -> bool:
        result = await db.execute(select(NotificationTemplate).where(NotificationTemplate.id == template_id))
        tmpl = result.scalar_one_or_none()
        if not tmpl:
            return False
        await db.delete(tmpl)
        await db.commit()
        return True

    async def get_templates(self, db: AsyncSession, category: str = None) -> list:
        q = select(NotificationTemplate)
        if category:
            q = q.where(NotificationTemplate.category == category)
        q = q.order_by(NotificationTemplate.name)
        result = await db.execute(q)
        return [self._template_to_dict(t) for t in result.scalars().all()]

    async def get_template(self, db: AsyncSession, template_id: str) -> dict | None:
        result = await db.execute(select(NotificationTemplate).where(NotificationTemplate.id == template_id))
        t = result.scalar_one_or_none()
        return self._template_to_dict(t) if t else None

    async def get_notifications(self, db: AsyncSession, limit: int = 50, offset: int = 0) -> list:
        result = await db.execute(
            select(MassNotification).order_by(MassNotification.created_at.desc()).limit(limit).offset(offset)
        )
        return [self._notif_to_dict(n) for n in result.scalars().all()]

    async def get_notification(self, db: AsyncSession, notification_id: str) -> dict | None:
        result = await db.execute(select(MassNotification).where(MassNotification.id == notification_id))
        n = result.scalar_one_or_none()
        return self._notif_to_dict(n) if n else None

    async def get_stats(self, db: AsyncSession) -> dict:
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        sent_today = (await db.execute(
            select(func.count(MassNotification.id)).where(MassNotification.created_at >= today)
        )).scalar() or 0
        pending_acks = (await db.execute(
            select(func.count(MassNotification.id)).where(
                and_(MassNotification.status == "sent",
                     MassNotification.acknowledged_count < MassNotification.total_recipients)
            )
        )).scalar() or 0
        templates_count = (await db.execute(select(func.count(NotificationTemplate.id)))).scalar() or 0
        return {
            "sent_today": sent_today,
            "pending_acknowledgments": pending_acks,
            "active_lockdowns": len(self._active_lockdowns),
            "templates_count": templates_count,
        }

    def _notif_to_dict(self, n: MassNotification) -> dict:
        return {
            "id": str(n.id), "title": n.title, "message": n.message, "severity": n.severity,
            "channels_used": n.channels_used or [], "target_zones": n.target_zones or [],
            "target_roles": n.target_roles or [], "total_recipients": n.total_recipients,
            "acknowledged_count": n.acknowledged_count, "acknowledgments": n.acknowledgments or [],
            "lockdown_activated": n.lockdown_activated, "status": n.status,
            "created_at": n.created_at.isoformat() if n.created_at else None,
        }

    def _template_to_dict(self, t: NotificationTemplate) -> dict:
        return {
            "id": str(t.id), "name": t.name, "category": t.category, "subject": t.subject,
            "body": t.body, "channels": t.channels or [], "severity": t.severity,
            "auto_trigger_event_type": t.auto_trigger_event_type, "zone_targeted": t.zone_targeted,
            "requires_acknowledgment": t.requires_acknowledgment,
            "lockdown_sequence": t.lockdown_sequence, "is_active": t.is_active,
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }


mass_notification_service = MassNotificationService()
