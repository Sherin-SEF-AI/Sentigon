"""Webhook dispatch engine — sends events to external integrations.

Supports generic webhooks, Slack, Microsoft Teams, Jira, and Splunk
with HMAC-SHA256 signing, retry logic, and delivery logging.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import select, update

from backend.config import settings
from backend.database import async_session
from backend.models.advanced_models import WebhookConfig, WebhookDeliveryLog

logger = logging.getLogger(__name__)

# Severity ordering for filter comparison
_SEVERITY_ORDER = {
    "info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4,
}


class WebhookDispatcher:
    """Dispatches events to configured webhook endpoints."""

    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0),
            )
        return self._client

    # ── Main dispatch ─────────────────────────────────────────────

    async def dispatch(
        self,
        event_type: str,
        event_data: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """Match event against all active webhook configs and send.

        Args:
            event_type: Type of event (e.g. "alert", "threat", "compliance").
            event_data: Event payload dict.

        Returns:
            List of delivery result dicts.
        """
        configs = await self._get_matching_configs(event_type, event_data)
        if not configs:
            return []

        results = []
        for config in configs:
            try:
                result = await self._send_webhook(config, event_type, event_data)
                results.append(result)
            except Exception as exc:
                logger.error(
                    "webhook.dispatch.error id=%s name=%s err=%s",
                    config["id"], config["name"], exc,
                )
                results.append({
                    "webhook_id": config["id"],
                    "success": False,
                    "error": str(exc),
                })

        return results

    async def test_webhook(self, webhook_id: str) -> Dict[str, Any]:
        """Send a test event to a specific webhook."""
        config = await self._get_config_by_id(webhook_id)
        if not config:
            return {"success": False, "error": "Webhook not found"}

        test_data = {
            "type": "test",
            "message": "SENTINEL AI webhook test",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "app": settings.APP_NAME,
        }

        return await self._send_webhook(config, "test", test_data)

    # ── Send logic with retries ───────────────────────────────────

    async def _send_webhook(
        self,
        config: Dict[str, Any],
        event_type: str,
        event_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Send a single webhook with retry logic."""
        client = self._get_client()
        integration_type = config.get("integration_type", "generic")

        # Format payload based on integration type
        payload = self._format_payload(integration_type, event_type, event_data)

        # Build headers
        headers = dict(config.get("headers", {}) or {})
        headers.setdefault("Content-Type", "application/json")

        # HMAC signing
        secret = config.get("secret")
        if secret:
            body_bytes = json.dumps(payload, default=str).encode("utf-8")
            signature = hmac.new(
                secret.encode("utf-8"),
                body_bytes,
                hashlib.sha256,
            ).hexdigest()
            headers["X-Webhook-Signature"] = f"sha256={signature}"

        url = config["url"]
        method = config.get("method", "POST").upper()
        retry_count = config.get("retry_count", 3)
        retry_delay = config.get("retry_delay_seconds", 5)

        last_error = None
        for attempt in range(1, retry_count + 1):
            try:
                if method == "POST":
                    resp = await client.post(url, json=payload, headers=headers)
                elif method == "PUT":
                    resp = await client.put(url, json=payload, headers=headers)
                else:
                    resp = await client.post(url, json=payload, headers=headers)

                success = 200 <= resp.status_code < 300
                response_text = resp.text[:500] if resp.text else ""

                # Log delivery
                await self._log_delivery(
                    webhook_id=config["id"],
                    event_type=event_type,
                    payload=payload,
                    status_code=resp.status_code,
                    response_body=response_text,
                    success=success,
                    attempt_number=attempt,
                )

                # Update webhook last_triggered
                if success:
                    await self._update_webhook_status(
                        config["id"], "success", datetime.now(timezone.utc),
                    )

                if success or resp.status_code < 500:
                    return {
                        "webhook_id": config["id"],
                        "success": success,
                        "status_code": resp.status_code,
                        "attempt": attempt,
                    }

                last_error = f"HTTP {resp.status_code}"

            except Exception as exc:
                last_error = str(exc)
                logger.warning(
                    "webhook.send attempt=%d/%d id=%s err=%s",
                    attempt, retry_count, config["id"], exc,
                )

                # Log failed delivery
                await self._log_delivery(
                    webhook_id=config["id"],
                    event_type=event_type,
                    payload=payload,
                    status_code=None,
                    response_body=None,
                    success=False,
                    attempt_number=attempt,
                    error_message=str(exc),
                )

            # Wait before retry (only if not last attempt)
            if attempt < retry_count:
                import asyncio
                await asyncio.sleep(retry_delay * attempt)

        await self._update_webhook_status(config["id"], f"failed: {last_error}")
        return {
            "webhook_id": config["id"],
            "success": False,
            "error": last_error,
            "attempts": retry_count,
        }

    # ── Payload formatters ────────────────────────────────────────

    def _format_payload(
        self,
        integration_type: str,
        event_type: str,
        event_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        formatters = {
            "slack": self._format_slack,
            "teams": self._format_teams,
            "jira": self._format_jira,
            "splunk": self._format_splunk,
        }
        formatter = formatters.get(integration_type, self._format_generic)
        return formatter(event_type, event_data)

    def _format_generic(
        self, event_type: str, data: Dict[str, Any],
    ) -> Dict[str, Any]:
        return {
            "source": settings.APP_NAME,
            "event_type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": data,
        }

    def _format_slack(
        self, event_type: str, data: Dict[str, Any],
    ) -> Dict[str, Any]:
        severity = data.get("severity", "info")
        title = data.get("title", f"SENTINEL AI {event_type}")
        description = data.get("description", "")
        color_map = {
            "critical": "#FF0000", "high": "#FF6600",
            "medium": "#FFCC00", "low": "#0099FF", "info": "#00CC00",
        }
        color = color_map.get(severity, "#808080")

        return {
            "blocks": [
                {
                    "type": "header",
                    "text": {
                        "type": "plain_text",
                        "text": f"SENTINEL AI — {title}",
                    },
                },
                {
                    "type": "section",
                    "fields": [
                        {"type": "mrkdwn", "text": f"*Type:* {event_type}"},
                        {"type": "mrkdwn", "text": f"*Severity:* {severity.upper()}"},
                    ],
                },
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": description[:2000] if description else "No details",
                    },
                },
            ],
            "attachments": [{"color": color, "text": ""}],
        }

    def _format_teams(
        self, event_type: str, data: Dict[str, Any],
    ) -> Dict[str, Any]:
        severity = data.get("severity", "info")
        title = data.get("title", f"SENTINEL AI {event_type}")
        description = data.get("description", "")
        color_map = {
            "critical": "FF0000", "high": "FF6600",
            "medium": "FFCC00", "low": "0099FF", "info": "00CC00",
        }

        return {
            "type": "message",
            "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": [
                        {
                            "type": "TextBlock",
                            "text": f"SENTINEL AI — {title}",
                            "weight": "Bolder",
                            "size": "Medium",
                            "color": "Attention" if severity in ("critical", "high") else "Default",
                        },
                        {
                            "type": "FactSet",
                            "facts": [
                                {"title": "Event", "value": event_type},
                                {"title": "Severity", "value": severity.upper()},
                                {"title": "Time", "value": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")},
                            ],
                        },
                        {
                            "type": "TextBlock",
                            "text": description[:2000] if description else "No details",
                            "wrap": True,
                        },
                    ],
                },
            }],
        }

    def _format_jira(
        self, event_type: str, data: Dict[str, Any],
    ) -> Dict[str, Any]:
        severity = data.get("severity", "medium")
        title = data.get("title", f"SENTINEL AI {event_type}")
        description = data.get("description", "")

        priority_map = {
            "critical": "Highest", "high": "High",
            "medium": "Medium", "low": "Low", "info": "Lowest",
        }

        return {
            "fields": {
                "project": {"key": "SEC"},
                "summary": f"[SENTINEL AI] {title}",
                "description": (
                    f"*Event Type:* {event_type}\n"
                    f"*Severity:* {severity}\n"
                    f"*Time:* {datetime.now(timezone.utc).isoformat()}\n\n"
                    f"{description}"
                ),
                "issuetype": {"name": "Task"},
                "priority": {"name": priority_map.get(severity, "Medium")},
            },
        }

    def _format_splunk(
        self, event_type: str, data: Dict[str, Any],
    ) -> Dict[str, Any]:
        return {
            "event": {
                "source": settings.APP_NAME,
                "sourcetype": "sentinel:security",
                "event_type": event_type,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                **data,
            },
            "time": int(datetime.now(timezone.utc).timestamp()),
            "source": "sentinel-ai",
            "sourcetype": "sentinel:security",
        }

    # ── Database helpers ──────────────────────────────────────────

    async def _get_matching_configs(
        self,
        event_type: str,
        event_data: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """Get all active webhook configs that match the event."""
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(WebhookConfig).where(WebhookConfig.is_active == True)  # noqa: E712
                )
                configs = result.scalars().all()

                matching = []
                event_severity = event_data.get("severity", "info")

                for cfg in configs:
                    # Check event type filter
                    allowed_types = cfg.event_types or []
                    if allowed_types and event_type not in allowed_types:
                        continue

                    # Check severity filter
                    if cfg.severity_filter:
                        min_level = _SEVERITY_ORDER.get(cfg.severity_filter, 0)
                        event_level = _SEVERITY_ORDER.get(event_severity, 0)
                        if event_level < min_level:
                            continue

                    matching.append({
                        "id": str(cfg.id),
                        "name": cfg.name,
                        "url": cfg.url,
                        "method": cfg.method,
                        "headers": cfg.headers or {},
                        "secret": cfg.secret,
                        "retry_count": cfg.retry_count,
                        "retry_delay_seconds": cfg.retry_delay_seconds,
                        "integration_type": cfg.integration_type,
                        "template": cfg.template,
                    })

                return matching

        except Exception as exc:
            logger.error("webhook._get_matching_configs error: %s", exc)
            return []

    async def _get_config_by_id(self, webhook_id: str) -> Optional[Dict[str, Any]]:
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(WebhookConfig).where(
                        WebhookConfig.id == uuid.UUID(webhook_id),
                    )
                )
                cfg = result.scalar_one_or_none()
                if not cfg:
                    return None
                return {
                    "id": str(cfg.id),
                    "name": cfg.name,
                    "url": cfg.url,
                    "method": cfg.method,
                    "headers": cfg.headers or {},
                    "secret": cfg.secret,
                    "retry_count": cfg.retry_count,
                    "retry_delay_seconds": cfg.retry_delay_seconds,
                    "integration_type": cfg.integration_type,
                    "template": cfg.template,
                }
        except Exception as exc:
            logger.error("webhook._get_config_by_id error: %s", exc)
            return None

    async def _log_delivery(
        self,
        webhook_id: str,
        event_type: str,
        payload: dict,
        status_code: Optional[int],
        response_body: Optional[str],
        success: bool,
        attempt_number: int,
        error_message: Optional[str] = None,
    ):
        try:
            async with async_session() as session:
                log = WebhookDeliveryLog(
                    webhook_id=uuid.UUID(webhook_id),
                    event_type=event_type,
                    payload=payload,
                    status_code=status_code,
                    response_body=response_body[:500] if response_body else None,
                    success=success,
                    attempt_number=attempt_number,
                    error_message=error_message,
                )
                session.add(log)
                await session.commit()
        except Exception as exc:
            logger.debug("webhook._log_delivery error: %s", exc)

    async def _update_webhook_status(
        self,
        webhook_id: str,
        status: str,
        triggered_at: Optional[datetime] = None,
    ):
        try:
            async with async_session() as session:
                values: dict = {"last_status": status}
                if triggered_at:
                    values["last_triggered_at"] = triggered_at
                await session.execute(
                    update(WebhookConfig)
                    .where(WebhookConfig.id == uuid.UUID(webhook_id))
                    .values(**values)
                )
                await session.commit()
        except Exception as exc:
            logger.debug("webhook._update_webhook_status error: %s", exc)


# Singleton
webhook_dispatcher = WebhookDispatcher()
