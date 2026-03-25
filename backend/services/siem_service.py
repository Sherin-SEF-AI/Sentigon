"""SIEM & Integration Hub Service — syslog, CEF, webhook delivery, connector management."""

import os
import uuid
import json
import hmac
import hashlib
import socket
import asyncio
import logging
from datetime import datetime
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.phase2b_models import IntegrationConnector, SIEMDeliveryLog

logger = logging.getLogger(__name__)


class SIEMService:

    async def create_connector(self, db: AsyncSession, data: dict) -> dict:
        conn = IntegrationConnector(
            name=data["name"], connector_type=data["connector_type"],
            direction=data.get("direction", "outbound"),
            config=data.get("config", {}),
            event_filter=data.get("event_filter", {}),
            transform_template=data.get("transform_template"),
        )
        db.add(conn)
        await db.commit()
        await db.refresh(conn)
        return self._conn_to_dict(conn)

    async def update_connector(self, db: AsyncSession, connector_id: str, data: dict) -> dict:
        result = await db.execute(select(IntegrationConnector).where(IntegrationConnector.id == connector_id))
        conn = result.scalar_one_or_none()
        if not conn:
            raise ValueError("Connector not found")
        for k in ["name", "connector_type", "direction", "config", "event_filter", "transform_template", "is_active"]:
            if k in data:
                setattr(conn, k, data[k])
        conn.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(conn)
        return self._conn_to_dict(conn)

    async def delete_connector(self, db: AsyncSession, connector_id: str) -> bool:
        result = await db.execute(select(IntegrationConnector).where(IntegrationConnector.id == connector_id))
        conn = result.scalar_one_or_none()
        if not conn:
            return False
        await db.delete(conn)
        await db.commit()
        return True

    async def get_connectors(self, db: AsyncSession) -> list:
        result = await db.execute(select(IntegrationConnector).order_by(IntegrationConnector.name))
        return [self._conn_to_dict(c) for c in result.scalars().all()]

    async def get_connector(self, db: AsyncSession, connector_id: str) -> dict | None:
        result = await db.execute(select(IntegrationConnector).where(IntegrationConnector.id == connector_id))
        c = result.scalar_one_or_none()
        return self._conn_to_dict(c) if c else None

    async def test_connector(self, db: AsyncSession, connector_id: str) -> dict:
        result = await db.execute(select(IntegrationConnector).where(IntegrationConnector.id == connector_id))
        conn = result.scalar_one_or_none()
        if not conn:
            raise ValueError("Connector not found")
        test_event = {"event_type": "test", "severity": "info", "title": "SENTINEL AI Test Event",
                       "description": "Connectivity test", "timestamp": datetime.utcnow().isoformat()}
        return await self._deliver_to_connector(db, conn, test_event)

    async def deliver_event(self, db: AsyncSession, event: dict) -> list:
        result = await db.execute(select(IntegrationConnector).where(IntegrationConnector.is_active == True))
        connectors = result.scalars().all()
        results = []
        for conn in connectors:
            ef = conn.event_filter or {}
            if ef.get("event_types") and event.get("event_type") not in ef["event_types"]:
                continue
            sev_order = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}
            min_sev = ef.get("severity_min", "info")
            if sev_order.get(event.get("severity", "info"), 0) < sev_order.get(min_sev, 0):
                continue
            r = await self._deliver_to_connector(db, conn, event)
            results.append(r)
        return results

    async def _deliver_to_connector(self, db: AsyncSession, conn, event: dict) -> dict:
        status = "failed"
        error = None
        try:
            cfg = conn.config or {}
            if conn.connector_type == "syslog":
                msg = self.format_syslog(event)
                ok = await self.send_syslog(msg, cfg.get("host", "localhost"), cfg.get("port", 514), cfg.get("protocol", "udp"))
                status = "sent" if ok else "failed"
            elif conn.connector_type == "cef":
                msg = self.format_cef(event)
                ok = await self.send_syslog(msg, cfg.get("host", "localhost"), cfg.get("port", 514), cfg.get("protocol", "udp"))
                status = "sent" if ok else "failed"
            elif conn.connector_type == "webhook":
                r = await self.send_webhook(cfg.get("url", ""), event, cfg.get("headers", {}), cfg.get("secret"))
                status = "sent" if r.get("success") else "failed"
                error = r.get("error")
            elif conn.connector_type == "rest_api":
                r = await self.send_webhook(cfg.get("url", ""), event, cfg.get("headers", {}))
                status = "sent" if r.get("success") else "failed"
            else:
                status = "unsupported"
        except Exception as e:
            error = str(e)
            status = "failed"
        # Log delivery
        log = SIEMDeliveryLog(
            connector_id=conn.id, event_type=event.get("event_type"),
            payload_summary=event.get("title", "")[:200], status=status, error_message=error,
        )
        db.add(log)
        if status == "sent":
            conn.events_sent = (conn.events_sent or 0) + 1
            conn.last_sync_at = datetime.utcnow()
            conn.last_sync_status = "success"
        else:
            conn.error_count = (conn.error_count or 0) + 1
            conn.last_sync_status = "failed"
        await db.commit()
        return {"connector_id": str(conn.id), "connector_name": conn.name, "status": status, "error": error}

    def format_syslog(self, event: dict, facility: int = 1, severity: int = 5) -> str:
        pri = facility * 8 + severity
        ts = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        msg = json.dumps(event, default=str)
        return f"<{pri}>1 {ts} sentinel-ai sentinel - - [sentinel event_type=\"{event.get('event_type', '-')}\" severity=\"{event.get('severity', '-')}\"] {msg}"

    def format_cef(self, event: dict) -> str:
        sev_map = {"critical": 10, "high": 7, "medium": 5, "low": 3, "info": 1}
        sev = sev_map.get(event.get("severity", "info"), 1)
        ext = f"src={event.get('camera_id', '')} msg={event.get('description', '')[:200]}"
        return f"CEF:0|Sentinel|SentinelAI|1.0|{event.get('event_type', '')}|{event.get('title', '')}|{sev}|{ext}"

    async def send_syslog(self, message: str, host: str, port: int, protocol: str = "udp") -> bool:
        try:
            if protocol == "udp":
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                await asyncio.to_thread(sock.sendto, message.encode(), (host, port))
                sock.close()
            else:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                await asyncio.to_thread(sock.connect, (host, port))
                await asyncio.to_thread(sock.send, message.encode())
                sock.close()
            return True
        except Exception as e:
            logger.error("Syslog send failed: %s", e)
            return False

    async def send_webhook(self, url: str, payload: dict, headers: dict = None, secret: str = None) -> dict:
        import httpx
        hdrs = dict(headers or {})
        hdrs["Content-Type"] = "application/json"
        if secret:
            body = json.dumps(payload, default=str)
            sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
            hdrs["X-Sentinel-Signature"] = f"sha256={sig}"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload, headers=hdrs)
                return {"status_code": resp.status_code, "success": resp.status_code < 400}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_delivery_logs(self, db: AsyncSession, connector_id: str = None, limit: int = 50) -> list:
        q = select(SIEMDeliveryLog)
        if connector_id:
            q = q.where(SIEMDeliveryLog.connector_id == connector_id)
        q = q.order_by(SIEMDeliveryLog.delivered_at.desc()).limit(limit)
        result = await db.execute(q)
        return [{"id": str(l.id), "connector_id": str(l.connector_id) if l.connector_id else None,
                 "event_type": l.event_type, "status": l.status, "error": l.error_message,
                 "delivered_at": l.delivered_at.isoformat() if l.delivered_at else None}
                for l in result.scalars().all()]

    async def get_stats(self, db: AsyncSession) -> dict:
        active = (await db.execute(
            select(func.count(IntegrationConnector.id)).where(IntegrationConnector.is_active == True)
        )).scalar() or 0
        total_sent = (await db.execute(select(func.sum(IntegrationConnector.events_sent)))).scalar() or 0
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        today_delivered = (await db.execute(
            select(func.count(SIEMDeliveryLog.id)).where(and_(
                SIEMDeliveryLog.delivered_at >= today, SIEMDeliveryLog.status == "sent"
            ))
        )).scalar() or 0
        today_failed = (await db.execute(
            select(func.count(SIEMDeliveryLog.id)).where(and_(
                SIEMDeliveryLog.delivered_at >= today, SIEMDeliveryLog.status == "failed"
            ))
        )).scalar() or 0
        return {"active_connectors": active, "total_events_sent": total_sent,
                "delivered_today": today_delivered, "failed_today": today_failed}

    def _conn_to_dict(self, c: IntegrationConnector) -> dict:
        return {"id": str(c.id), "name": c.name, "connector_type": c.connector_type,
                "direction": c.direction, "config": c.config, "event_filter": c.event_filter,
                "is_active": c.is_active, "events_sent": c.events_sent or 0,
                "error_count": c.error_count or 0,
                "last_sync_at": c.last_sync_at.isoformat() if c.last_sync_at else None,
                "last_sync_status": c.last_sync_status,
                "created_at": c.created_at.isoformat() if c.created_at else None}


siem_service = SIEMService()
