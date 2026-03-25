"""Webhook management API — CRUD for webhook configs + test + delivery logs."""
from __future__ import annotations

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, desc

from backend.api.auth import get_current_user
from backend.database import async_session
from backend.models.advanced_models import WebhookConfig, WebhookDeliveryLog

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


# ── Pydantic schemas ──────────────────────────────────────────


class WebhookCreate(BaseModel):
    name: str
    url: str
    method: str = "POST"
    headers: dict | None = None
    secret: str | None = None
    event_types: list[str] | None = None
    severity_filter: str | None = None
    retry_count: int = 3
    retry_delay_seconds: int = 5
    integration_type: str = "generic"
    template: dict | None = None


class WebhookUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    method: str | None = None
    headers: dict | None = None
    secret: str | None = None
    event_types: list[str] | None = None
    severity_filter: str | None = None
    is_active: bool | None = None
    retry_count: int | None = None
    retry_delay_seconds: int | None = None
    integration_type: str | None = None
    template: dict | None = None


# ── Helpers ───────────────────────────────────────────────────


def _fmt_config(cfg: WebhookConfig) -> dict:
    return {
        "id": str(cfg.id),
        "name": cfg.name,
        "url": cfg.url,
        "method": cfg.method,
        "headers": cfg.headers or {},
        "secret": "***" if cfg.secret else None,
        "event_types": cfg.event_types or [],
        "severity_filter": cfg.severity_filter,
        "is_active": cfg.is_active,
        "retry_count": cfg.retry_count,
        "retry_delay_seconds": cfg.retry_delay_seconds,
        "integration_type": cfg.integration_type,
        "template": cfg.template,
        "last_triggered_at": cfg.last_triggered_at.isoformat() if cfg.last_triggered_at else None,
        "last_status": cfg.last_status,
        "created_at": cfg.created_at.isoformat() if cfg.created_at else None,
        "updated_at": cfg.updated_at.isoformat() if cfg.updated_at else None,
    }


def _fmt_log(log: WebhookDeliveryLog) -> dict:
    return {
        "id": str(log.id),
        "webhook_id": str(log.webhook_id),
        "event_type": log.event_type,
        "status_code": log.status_code,
        "success": log.success,
        "attempt_number": log.attempt_number,
        "error_message": log.error_message,
        "delivered_at": log.delivered_at.isoformat() if log.delivered_at else None,
    }


# ── Endpoints ─────────────────────────────────────────────────


@router.get("")
async def list_webhooks(
    active_only: bool = Query(False),
    _user=Depends(get_current_user),
):
    """List all webhook configurations."""
    async with async_session() as session:
        query = select(WebhookConfig).order_by(desc(WebhookConfig.created_at))
        if active_only:
            query = query.where(WebhookConfig.is_active == True)  # noqa: E712
        result = await session.execute(query)
        configs = result.scalars().all()
        return {"webhooks": [_fmt_config(c) for c in configs]}


@router.post("")
async def create_webhook(
    body: WebhookCreate,
    _user=Depends(get_current_user),
):
    """Create a new webhook configuration."""
    async with async_session() as session:
        cfg = WebhookConfig(
            name=body.name,
            url=body.url,
            method=body.method,
            headers=body.headers or {},
            secret=body.secret,
            event_types=body.event_types or [],
            severity_filter=body.severity_filter,
            retry_count=body.retry_count,
            retry_delay_seconds=body.retry_delay_seconds,
            integration_type=body.integration_type,
            template=body.template,
        )
        session.add(cfg)
        await session.commit()
        await session.refresh(cfg)
        return _fmt_config(cfg)


@router.patch("/{webhook_id}")
async def update_webhook(
    webhook_id: str,
    body: WebhookUpdate,
    _user=Depends(get_current_user),
):
    """Update an existing webhook configuration."""
    async with async_session() as session:
        result = await session.execute(
            select(WebhookConfig).where(
                WebhookConfig.id == uuid.UUID(webhook_id),
            )
        )
        cfg = result.scalar_one_or_none()
        if not cfg:
            raise HTTPException(status_code=404, detail="Webhook not found")

        update_data = body.model_dump(exclude_unset=True)
        for key, value in update_data.items():
            setattr(cfg, key, value)

        await session.commit()
        await session.refresh(cfg)
        return _fmt_config(cfg)


@router.delete("/{webhook_id}")
async def delete_webhook(
    webhook_id: str,
    _user=Depends(get_current_user),
):
    """Delete a webhook configuration."""
    async with async_session() as session:
        result = await session.execute(
            select(WebhookConfig).where(
                WebhookConfig.id == uuid.UUID(webhook_id),
            )
        )
        cfg = result.scalar_one_or_none()
        if not cfg:
            raise HTTPException(status_code=404, detail="Webhook not found")

        await session.delete(cfg)
        await session.commit()
        return {"success": True, "deleted": webhook_id}


@router.post("/{webhook_id}/test")
async def test_webhook(
    webhook_id: str,
    _user=Depends(get_current_user),
):
    """Send a test event to a specific webhook."""
    from backend.modules.webhook_integration import webhook_dispatcher

    result = await webhook_dispatcher.test_webhook(webhook_id)
    return result


@router.get("/{webhook_id}/logs")
async def webhook_logs(
    webhook_id: str,
    limit: int = Query(50, ge=1, le=500),
    _user=Depends(get_current_user),
):
    """Get recent delivery logs for a webhook."""
    async with async_session() as session:
        result = await session.execute(
            select(WebhookDeliveryLog)
            .where(WebhookDeliveryLog.webhook_id == uuid.UUID(webhook_id))
            .order_by(desc(WebhookDeliveryLog.delivered_at))
            .limit(limit)
        )
        logs = result.scalars().all()
        return {"logs": [_fmt_log(log) for log in logs]}
