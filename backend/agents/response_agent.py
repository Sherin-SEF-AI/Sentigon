"""Automated response agent — takes actions based on alert severity."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.services.notification_service import notification_service

logger = logging.getLogger(__name__)


# Maps severity levels to the automated actions that should be taken.
_RESPONSE_PLAYBOOKS: Dict[str, Dict[str, Any]] = {
    "critical": {
        "auto_escalate": True,
        "notify_channels": ["alerts", "notifications"],
        "webhook": True,
        "log_priority": "CRITICAL",
        "recommended_actions": [
            "Dispatch security team immediately",
            "Notify facility manager",
            "Begin recording preservation",
        ],
    },
    "high": {
        "auto_escalate": True,
        "notify_channels": ["alerts", "notifications"],
        "webhook": True,
        "log_priority": "HIGH",
        "recommended_actions": [
            "Dispatch security patrol",
            "Flag for analyst review",
        ],
    },
    "medium": {
        "auto_escalate": False,
        "notify_channels": ["alerts"],
        "webhook": False,
        "log_priority": "MEDIUM",
        "recommended_actions": [
            "Queue for analyst review",
        ],
    },
    "low": {
        "auto_escalate": False,
        "notify_channels": ["notifications"],
        "webhook": False,
        "log_priority": "LOW",
        "recommended_actions": [
            "Log for daily digest",
        ],
    },
    "info": {
        "auto_escalate": False,
        "notify_channels": [],
        "webhook": False,
        "log_priority": "INFO",
        "recommended_actions": [],
    },
}


class ResponseAgent:
    """Takes automated actions in response to alerts.

    The agent consults a severity-based playbook to decide which
    channels to notify, whether to auto-escalate, and whether to
    dispatch webhooks.
    """

    def __init__(self) -> None:
        self._response_log: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------ #
    #  Primary entry point                                                #
    # ------------------------------------------------------------------ #

    async def auto_respond(
        self,
        alert_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Execute automated responses for an alert.

        Parameters
        ----------
        alert_data : dict
            Alert payload as returned by ``AlertManager.create_alert``.
            Expected keys: id, title, severity, description,
            source_camera, zone_name, confidence.

        Returns
        -------
        dict
            Summary of actions taken.
        """
        severity = alert_data.get("severity", "info")
        playbook = _RESPONSE_PLAYBOOKS.get(severity, _RESPONSE_PLAYBOOKS["info"])

        actions_taken: List[str] = []
        now = datetime.now(timezone.utc)

        logger.info(
            "Auto-responding to alert [%s] %s (severity=%s)",
            alert_data.get("id", "?"),
            alert_data.get("title", ""),
            severity,
        )

        # ── 1. Push to designated notification channels ───────────
        for channel in playbook.get("notify_channels", []):
            try:
                await self._push_to_channel(channel, alert_data)
                actions_taken.append(f"notified:{channel}")
            except Exception as exc:
                logger.error(
                    "Channel notification failed (%s): %s", channel, exc,
                )

        # ── 2. Auto-escalate if required by playbook ─────────────
        if playbook.get("auto_escalate"):
            try:
                await self._escalate(alert_data)
                actions_taken.append("auto_escalated")
            except Exception as exc:
                logger.error("Auto-escalation failed: %s", exc)

        # ── 3. Dispatch webhooks ──────────────────────────────────
        if playbook.get("webhook"):
            try:
                await notification_service.dispatch_webhook(alert_data)
                actions_taken.append("webhook_dispatched")
            except Exception as exc:
                logger.error("Webhook dispatch failed: %s", exc)

        # ── 4. Build response record ─────────────────────────────
        response_record = {
            "alert_id": alert_data.get("id"),
            "severity": severity,
            "actions_taken": actions_taken,
            "recommended_actions": playbook.get("recommended_actions", []),
            "timestamp": now.isoformat(),
        }

        self._response_log.append(response_record)
        # Keep the in-memory log bounded
        if len(self._response_log) > 500:
            self._response_log = self._response_log[-500:]

        logger.info(
            "Response completed for alert %s: %s",
            alert_data.get("id", "?"),
            actions_taken,
        )
        return response_record

    # ------------------------------------------------------------------ #
    #  Batch / bulk helpers                                               #
    # ------------------------------------------------------------------ #

    async def respond_to_many(
        self,
        alerts: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Run auto_respond for a list of alerts sequentially."""
        results = []
        for alert_data in alerts:
            result = await self.auto_respond(alert_data)
            results.append(result)
        return results

    # ------------------------------------------------------------------ #
    #  Channel dispatch                                                   #
    # ------------------------------------------------------------------ #

    async def _push_to_channel(
        self,
        channel: str,
        alert_data: Dict[str, Any],
    ) -> None:
        """Route a notification to the correct WebSocket channel."""
        if channel == "alerts":
            await notification_service.push_alert(alert_data)
        elif channel == "notifications":
            await notification_service.push_notification({
                "type": "auto_response",
                "alert_id": alert_data.get("id"),
                "title": alert_data.get("title", ""),
                "severity": alert_data.get("severity", "info"),
                "message": (
                    f"Automated response triggered for "
                    f"{alert_data.get('severity', 'unknown')} alert: "
                    f"{alert_data.get('title', '')}"
                ),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
        else:
            logger.warning("Unknown notification channel: %s", channel)

    async def _escalate(
        self,
        alert_data: Dict[str, Any],
    ) -> None:
        """Push an escalation notification."""
        await notification_service.push_notification({
            "type": "escalation",
            "alert_id": alert_data.get("id"),
            "title": f"ESCALATED: {alert_data.get('title', '')}",
            "severity": alert_data.get("severity", "critical"),
            "source_camera": alert_data.get("source_camera", ""),
            "zone_name": alert_data.get("zone_name", ""),
            "message": (
                f"Alert auto-escalated due to {alert_data.get('severity', '')} "
                f"severity. Immediate attention required."
            ),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        logger.warning(
            "Alert %s auto-escalated (severity=%s)",
            alert_data.get("id", "?"),
            alert_data.get("severity", "?"),
        )

    # ------------------------------------------------------------------ #
    #  Introspection                                                      #
    # ------------------------------------------------------------------ #

    @property
    def recent_responses(self) -> List[Dict[str, Any]]:
        """Return the last 50 response records."""
        return self._response_log[-50:]

    @property
    def stats(self) -> Dict[str, Any]:
        total = len(self._response_log)
        by_severity: Dict[str, int] = {}
        for rec in self._response_log:
            sev = rec.get("severity", "unknown")
            by_severity[sev] = by_severity.get(sev, 0) + 1
        return {
            "total_responses": total,
            "by_severity": by_severity,
        }


# Singleton
response_agent = ResponseAgent()
