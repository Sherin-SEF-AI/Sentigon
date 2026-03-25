"""
Production notification channels: Email, SMS, Slack, Teams, PagerDuty, Webhooks.
Each channel implements the NotificationChannel interface.
"""
import asyncio
import logging
import json
import time
from abc import ABC, abstractmethod
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field
from enum import Enum
import os

logger = logging.getLogger(__name__)


class NotificationPriority(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class NotificationPayload:
    """Standard notification payload across all channels."""
    title: str
    message: str
    priority: NotificationPriority = NotificationPriority.MEDIUM
    alert_id: Optional[int] = None
    camera_name: Optional[str] = None
    zone_name: Optional[str] = None
    threat_type: Optional[str] = None
    severity: Optional[str] = None
    timestamp: float = field(default_factory=time.time)
    image_data: Optional[bytes] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    link: Optional[str] = None


class NotificationChannel(ABC):
    """Base class for all notification channels."""

    def __init__(self, name: str, enabled: bool = True):
        self.name = name
        self.enabled = enabled
        self.send_count = 0
        self.error_count = 0
        self.last_sent: Optional[float] = None
        self.last_error: Optional[str] = None

    @abstractmethod
    async def send(self, payload: NotificationPayload) -> bool:
        pass

    @abstractmethod
    async def test_connection(self) -> bool:
        pass

    @property
    def status(self) -> Dict:
        return {
            "name": self.name,
            "enabled": self.enabled,
            "send_count": self.send_count,
            "error_count": self.error_count,
            "last_sent": self.last_sent,
            "last_error": self.last_error,
        }


class EmailChannel(NotificationChannel):
    """Send notifications via SMTP email."""

    def __init__(self, smtp_host: str, smtp_port: int, username: str, password: str,
                 from_addr: str, to_addrs: List[str], use_tls: bool = True):
        super().__init__("email")
        self.smtp_host = smtp_host
        self.smtp_port = smtp_port
        self.username = username
        self.password = password
        self.from_addr = from_addr
        self.to_addrs = to_addrs
        self.use_tls = use_tls

    async def send(self, payload: NotificationPayload) -> bool:
        if not self.enabled:
            return False
        try:
            import aiosmtplib
            from email.mime.multipart import MIMEMultipart
            from email.mime.text import MIMEText
            from email.mime.image import MIMEImage

            msg = MIMEMultipart("mixed")
            msg["From"] = self.from_addr
            msg["To"] = ", ".join(self.to_addrs)
            msg["Subject"] = f"[SENTINEL AI] [{payload.priority.value.upper()}] {payload.title}"

            severity_colors = {"critical": "#dc2626", "high": "#ea580c", "medium": "#ca8a04", "low": "#16a34a"}
            color = severity_colors.get(payload.severity or payload.priority.value, "#6b7280")

            html = f"""<html><body style="font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:#1e293b;border-radius:8px;overflow:hidden;">
<div style="background:{color};padding:16px 24px;"><h2 style="margin:0;color:white;">SENTINEL AI Alert</h2></div>
<div style="padding:24px;">
<h3 style="color:#f1f5f9;margin-top:0;">{payload.title}</h3>
<p style="color:#cbd5e1;">{payload.message}</p>
<table style="width:100%;border-collapse:collapse;margin-top:16px;">
<tr><td style="padding:8px;color:#94a3b8;">Severity</td><td style="padding:8px;color:#f1f5f9;"><strong>{payload.severity or payload.priority.value}</strong></td></tr>
{"<tr><td style='padding:8px;color:#94a3b8;'>Camera</td><td style='padding:8px;color:#f1f5f9;'>" + payload.camera_name + "</td></tr>" if payload.camera_name else ""}
{"<tr><td style='padding:8px;color:#94a3b8;'>Zone</td><td style='padding:8px;color:#f1f5f9;'>" + payload.zone_name + "</td></tr>" if payload.zone_name else ""}
{"<tr><td style='padding:8px;color:#94a3b8;'>Threat</td><td style='padding:8px;color:#f1f5f9;'>" + payload.threat_type + "</td></tr>" if payload.threat_type else ""}
</table>
{"<p style='margin-top:16px;'><a href='" + payload.link + "' style='color:#22d3ee;'>View in Sentinel AI &rarr;</a></p>" if payload.link else ""}
</div>
<div style="padding:12px 24px;background:#0f172a;color:#64748b;font-size:12px;">
Sentinel AI &bull; {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(payload.timestamp))}
</div></div></body></html>"""

            msg.attach(MIMEText(html, "html"))
            if payload.image_data:
                img = MIMEImage(payload.image_data, _subtype="jpeg")
                img.add_header("Content-Disposition", "attachment", filename="snapshot.jpg")
                msg.attach(img)

            await aiosmtplib.send(
                msg, hostname=self.smtp_host, port=self.smtp_port,
                username=self.username, password=self.password, use_tls=self.use_tls,
            )
            self.send_count += 1
            self.last_sent = time.time()
            logger.info("Email notification sent: %s", payload.title)
            return True
        except Exception as e:
            self.error_count += 1
            self.last_error = str(e)
            logger.error("Email send failed: %s", e)
            return False

    async def test_connection(self) -> bool:
        try:
            import aiosmtplib
            smtp = aiosmtplib.SMTP(hostname=self.smtp_host, port=self.smtp_port, use_tls=self.use_tls)
            await smtp.connect()
            await smtp.login(self.username, self.password)
            await smtp.quit()
            return True
        except Exception as e:
            logger.error("Email connection test failed: %s", e)
            return False


class SMSChannel(NotificationChannel):
    """Send SMS via Twilio."""

    def __init__(self, account_sid: str, auth_token: str, from_number: str, to_numbers: List[str]):
        super().__init__("sms")
        self.account_sid = account_sid
        self.auth_token = auth_token
        self.from_number = from_number
        self.to_numbers = to_numbers

    async def send(self, payload: NotificationPayload) -> bool:
        if not self.enabled:
            return False
        try:
            from twilio.rest import Client
            client = Client(self.account_sid, self.auth_token)
            body = f"SENTINEL AI [{payload.priority.value.upper()}]\n{payload.title}\n{payload.message}"
            if payload.camera_name:
                body += f"\nCamera: {payload.camera_name}"
            if len(body) > 1600:
                body = body[:1597] + "..."
            for number in self.to_numbers:
                await asyncio.get_event_loop().run_in_executor(
                    None, lambda n=number: client.messages.create(body=body, from_=self.from_number, to=n)
                )
            self.send_count += 1
            self.last_sent = time.time()
            logger.info("SMS sent to %d recipients", len(self.to_numbers))
            return True
        except Exception as e:
            self.error_count += 1
            self.last_error = str(e)
            logger.error("SMS send failed: %s", e)
            return False

    async def test_connection(self) -> bool:
        try:
            from twilio.rest import Client
            client = Client(self.account_sid, self.auth_token)
            await asyncio.get_event_loop().run_in_executor(
                None, lambda: client.api.accounts(self.account_sid).fetch()
            )
            return True
        except Exception:
            return False


class SlackChannel(NotificationChannel):
    """Send notifications via Slack webhook or Bot API."""

    def __init__(self, webhook_url: str = None, bot_token: str = None, channel: str = None):
        super().__init__("slack")
        self.webhook_url = webhook_url
        self.bot_token = bot_token
        self.channel = channel

    async def send(self, payload: NotificationPayload) -> bool:
        if not self.enabled:
            return False
        try:
            import httpx
            severity_colors = {"critical": "#dc2626", "high": "#ea580c", "medium": "#ca8a04", "low": "#16a34a"}
            color = severity_colors.get(payload.severity or payload.priority.value, "#6b7280")

            blocks = [
                {"type": "header", "text": {"type": "plain_text", "text": f"Alert: {payload.title}"}},
                {"type": "section", "fields": [
                    {"type": "mrkdwn", "text": f"*Severity:* {payload.severity or payload.priority.value}"},
                    {"type": "mrkdwn", "text": f"*Camera:* {payload.camera_name or 'N/A'}"},
                    {"type": "mrkdwn", "text": f"*Zone:* {payload.zone_name or 'N/A'}"},
                    {"type": "mrkdwn", "text": f"*Threat:* {payload.threat_type or 'N/A'}"},
                ]},
                {"type": "section", "text": {"type": "mrkdwn", "text": payload.message}},
            ]
            if payload.link:
                blocks.append({"type": "actions", "elements": [
                    {"type": "button", "text": {"type": "plain_text", "text": "View in Sentinel AI"}, "url": payload.link}
                ]})

            slack_payload = {"attachments": [{"color": color, "blocks": blocks}]}

            if self.webhook_url:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(self.webhook_url, json=slack_payload, timeout=10)
                    resp.raise_for_status()
            elif self.bot_token and self.channel:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(
                        "https://slack.com/api/chat.postMessage",
                        json={**slack_payload, "channel": self.channel},
                        headers={"Authorization": f"Bearer {self.bot_token}"},
                        timeout=10,
                    )
                    resp.raise_for_status()

            self.send_count += 1
            self.last_sent = time.time()
            return True
        except Exception as e:
            self.error_count += 1
            self.last_error = str(e)
            logger.error("Slack send failed: %s", e)
            return False

    async def test_connection(self) -> bool:
        try:
            import httpx
            if self.webhook_url:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(self.webhook_url, json={"text": "Sentinel AI test"}, timeout=10)
                    return resp.status_code == 200
            return False
        except Exception:
            return False


class TeamsChannel(NotificationChannel):
    """Send notifications via Microsoft Teams webhook."""

    def __init__(self, webhook_url: str):
        super().__init__("teams")
        self.webhook_url = webhook_url

    async def send(self, payload: NotificationPayload) -> bool:
        if not self.enabled:
            return False
        try:
            import httpx
            severity_styles = {"critical": "attention", "high": "warning", "medium": "accent", "low": "good"}
            style = severity_styles.get(payload.severity or payload.priority.value, "default")

            card = {
                "type": "message",
                "attachments": [{
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": {
                        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                        "type": "AdaptiveCard", "version": "1.4",
                        "body": [
                            {"type": "TextBlock", "text": payload.title, "weight": "bolder", "size": "large", "color": style},
                            {"type": "TextBlock", "text": payload.message, "wrap": True},
                            {"type": "FactSet", "facts": [
                                {"title": "Severity", "value": payload.severity or payload.priority.value},
                                {"title": "Camera", "value": payload.camera_name or "N/A"},
                                {"title": "Zone", "value": payload.zone_name or "N/A"},
                            ]},
                        ],
                    },
                }],
            }

            async with httpx.AsyncClient() as client:
                resp = await client.post(self.webhook_url, json=card, timeout=10)
                resp.raise_for_status()
            self.send_count += 1
            self.last_sent = time.time()
            return True
        except Exception as e:
            self.error_count += 1
            self.last_error = str(e)
            logger.error("Teams send failed: %s", e)
            return False

    async def test_connection(self) -> bool:
        return bool(self.webhook_url)


class PagerDutyChannel(NotificationChannel):
    """Send incidents to PagerDuty via Events API v2."""

    def __init__(self, routing_key: str, service_name: str = "Sentinel AI"):
        super().__init__("pagerduty")
        self.routing_key = routing_key
        self.service_name = service_name

    async def send(self, payload: NotificationPayload) -> bool:
        if not self.enabled:
            return False
        try:
            import httpx
            severity_map = {"critical": "critical", "high": "error", "medium": "warning", "low": "info"}
            pd_severity = severity_map.get(payload.severity or payload.priority.value, "info")

            pd_payload = {
                "routing_key": self.routing_key,
                "event_action": "trigger",
                "payload": {
                    "summary": f"{payload.title}: {payload.message[:200]}",
                    "source": self.service_name,
                    "severity": pd_severity,
                    "component": payload.camera_name or "system",
                    "group": payload.zone_name or "general",
                    "class": payload.threat_type or "security",
                    "custom_details": {
                        "alert_id": payload.alert_id,
                        "camera": payload.camera_name,
                        "zone": payload.zone_name,
                        "threat_type": payload.threat_type,
                        "full_message": payload.message,
                    },
                },
            }
            if payload.link:
                pd_payload["links"] = [{"href": payload.link, "text": "View in Sentinel AI"}]

            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://events.pagerduty.com/v2/enqueue",
                    json=pd_payload, timeout=10,
                )
                resp.raise_for_status()
            self.send_count += 1
            self.last_sent = time.time()
            return True
        except Exception as e:
            self.error_count += 1
            self.last_error = str(e)
            logger.error("PagerDuty send failed: %s", e)
            return False

    async def test_connection(self) -> bool:
        return bool(self.routing_key)


class WebhookChannel(NotificationChannel):
    """Send notifications to a generic webhook URL."""

    def __init__(self, url: str, headers: Dict[str, str] = None, method: str = "POST", name: str = "webhook"):
        super().__init__(name)
        self.url = url
        self.headers = headers or {"Content-Type": "application/json"}
        self.method = method

    async def send(self, payload: NotificationPayload) -> bool:
        if not self.enabled:
            return False
        try:
            import httpx
            data = {
                "event": "sentinel_alert",
                "title": payload.title,
                "message": payload.message,
                "priority": payload.priority.value,
                "severity": payload.severity,
                "alert_id": payload.alert_id,
                "camera": payload.camera_name,
                "zone": payload.zone_name,
                "threat_type": payload.threat_type,
                "timestamp": payload.timestamp,
                "link": payload.link,
                "metadata": payload.metadata,
            }
            async with httpx.AsyncClient() as client:
                resp = await client.request(self.method, self.url, json=data, headers=self.headers, timeout=10)
                resp.raise_for_status()
            self.send_count += 1
            self.last_sent = time.time()
            return True
        except Exception as e:
            self.error_count += 1
            self.last_error = str(e)
            logger.error("Webhook send failed: %s", e)
            return False

    async def test_connection(self) -> bool:
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.head(self.url, timeout=5)
                return resp.status_code < 500
        except Exception:
            return False


# ---------------------------------------------------------------------------
# Notification Router – severity-based routing with rate limiting
# ---------------------------------------------------------------------------

class NotificationRouter:
    """Routes notifications to channels based on severity rules."""

    def __init__(self):
        self.channels: Dict[str, NotificationChannel] = {}
        self.routing_rules: List[Dict[str, Any]] = []
        self._rate_limits: Dict[str, float] = {}
        self.rate_limit_seconds = 60

    def register_channel(self, channel: NotificationChannel):
        self.channels[channel.name] = channel
        logger.info("Registered notification channel: %s", channel.name)

    def add_routing_rule(self, rule: Dict[str, Any]):
        self.routing_rules.append(rule)

    def _get_channels_for_payload(self, payload: NotificationPayload) -> List[NotificationChannel]:
        matched = set()
        for rule in self.routing_rules:
            sev_match = not rule.get("severity") or (payload.severity or payload.priority.value) in rule["severity"]
            threat_match = not rule.get("threat_types") or payload.threat_type in rule.get("threat_types", [])
            zone_match = not rule.get("zones") or payload.zone_name in rule.get("zones", [])
            if sev_match and threat_match and zone_match:
                for ch_name in rule.get("channels", []):
                    if ch_name in self.channels and self.channels[ch_name].enabled:
                        matched.add(ch_name)
        if not matched and (payload.severity == "critical" or payload.priority == NotificationPriority.CRITICAL):
            matched = {n for n, ch in self.channels.items() if ch.enabled}
        return [self.channels[n] for n in matched]

    def _is_rate_limited(self, channel_name: str, payload: NotificationPayload) -> bool:
        key = f"{channel_name}:{payload.threat_type}:{payload.camera_name}:{payload.severity}"
        last_sent = self._rate_limits.get(key, 0)
        return time.time() - last_sent < self.rate_limit_seconds

    async def notify(self, payload: NotificationPayload) -> Dict[str, bool]:
        channels = self._get_channels_for_payload(payload)
        results: Dict[str, bool] = {}
        tasks = []
        for channel in channels:
            if self._is_rate_limited(channel.name, payload):
                results[channel.name] = False
                continue
            key = f"{channel.name}:{payload.threat_type}:{payload.camera_name}:{payload.severity}"
            self._rate_limits[key] = time.time()
            tasks.append((channel.name, channel.send(payload)))
        for name, task in tasks:
            try:
                results[name] = await task
            except Exception as e:
                results[name] = False
                logger.error("Notification to %s failed: %s", name, e)
        return results

    def get_status(self) -> Dict[str, Any]:
        return {
            "channels": {n: ch.status for n, ch in self.channels.items()},
            "routing_rules": self.routing_rules,
            "total_channels": len(self.channels),
            "enabled_channels": sum(1 for ch in self.channels.values() if ch.enabled),
        }


# Singleton
notification_router = NotificationRouter()


def init_notification_channels():
    """Initialize notification channels from environment variables."""
    smtp_host = os.getenv("SMTP_HOST")
    if smtp_host:
        notification_router.register_channel(EmailChannel(
            smtp_host=smtp_host,
            smtp_port=int(os.getenv("SMTP_PORT", "587")),
            username=os.getenv("SMTP_USERNAME", ""),
            password=os.getenv("SMTP_PASSWORD", ""),
            from_addr=os.getenv("SMTP_FROM", "sentinel@example.com"),
            to_addrs=[a.strip() for a in os.getenv("NOTIFICATION_EMAILS", "").split(",") if a.strip()],
            use_tls=os.getenv("SMTP_TLS", "true").lower() == "true",
        ))

    twilio_sid = os.getenv("TWILIO_ACCOUNT_SID")
    if twilio_sid:
        notification_router.register_channel(SMSChannel(
            account_sid=twilio_sid,
            auth_token=os.getenv("TWILIO_AUTH_TOKEN", ""),
            from_number=os.getenv("TWILIO_FROM_NUMBER", ""),
            to_numbers=[n.strip() for n in os.getenv("NOTIFICATION_PHONES", "").split(",") if n.strip()],
        ))

    slack_webhook = os.getenv("SLACK_WEBHOOK_URL")
    slack_token = os.getenv("SLACK_BOT_TOKEN")
    if slack_webhook or slack_token:
        notification_router.register_channel(SlackChannel(
            webhook_url=slack_webhook,
            bot_token=slack_token,
            channel=os.getenv("SLACK_CHANNEL", "#security-alerts"),
        ))

    teams_webhook = os.getenv("TEAMS_WEBHOOK_URL")
    if teams_webhook:
        notification_router.register_channel(TeamsChannel(webhook_url=teams_webhook))

    pd_key = os.getenv("PAGERDUTY_ROUTING_KEY")
    if pd_key:
        notification_router.register_channel(PagerDutyChannel(routing_key=pd_key))

    # Default routing rules
    notification_router.add_routing_rule({"severity": ["critical"], "channels": ["email", "sms", "slack", "teams", "pagerduty"]})
    notification_router.add_routing_rule({"severity": ["high"], "channels": ["email", "slack", "teams"]})
    notification_router.add_routing_rule({"severity": ["medium"], "channels": ["slack", "teams"]})
    notification_router.add_routing_rule({"severity": ["low"], "channels": ["slack"]})

    logger.info("Notification channels initialized: %s", list(notification_router.channels.keys()))
