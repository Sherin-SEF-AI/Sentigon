"""Access Guardian Agent — Physical access control monitoring, alarm panel integration, and visitor analytics.

Monitors PACS events (badge reads, door forced, door held open), alarm
panel events (zone alarms, arm/disarm), and visitor patterns (entry/exit
times, dwell per zone).  Detects tailgating, anti-passback violations,
and unusual access patterns, correlating access events with camera
detections for multi-modal verification.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_CORTEX,
    CH_PERCEPTIONS,
    CH_ANOMALIES,
)

logger = logging.getLogger(__name__)

# ── PACS event types ──────────────────────────────────────────────
PACS_EVENT_TYPES = [
    "badge_read_granted",
    "badge_read_denied",
    "door_forced",
    "door_held_open",
    "invalid_credential",
    "expired_credential",
    "anti_passback_violation",
    "tailgating_detected",
]

# ── Alarm panel event types ──────────────────────────────────────
ALARM_EVENT_TYPES = [
    "zone_alarm_triggered",
    "zone_alarm_cleared",
    "panel_armed",
    "panel_disarmed",
    "panel_trouble",
    "duress_code",
    "fire_alarm",
    "panic_alarm",
]

# Severity mapping for access/alarm events
_EVENT_SEVERITY: dict[str, str] = {
    "door_forced": "high",
    "duress_code": "critical",
    "fire_alarm": "critical",
    "panic_alarm": "critical",
    "anti_passback_violation": "medium",
    "tailgating_detected": "medium",
    "badge_read_denied": "low",
    "invalid_credential": "medium",
    "expired_credential": "low",
    "door_held_open": "medium",
    "panel_trouble": "medium",
    "zone_alarm_triggered": "high",
}

# Thresholds for anomaly detection
_DENIED_ACCESS_THRESHOLD = 3       # N denied reads in a window = anomaly
_DENIED_ACCESS_WINDOW = 300        # 5-minute window
_HELD_OPEN_THRESHOLD_SECONDS = 60  # Door held open too long
_UNUSUAL_HOUR_START = 22           # 10 PM
_UNUSUAL_HOUR_END = 5             # 5 AM

# Cooldown between alerts for the same event type on the same door
_ALERT_COOLDOWN_SECONDS = 120


class AccessGuardianAgent(BaseAgent):
    """Physical access control and alarm panel monitoring agent.

    Monitors PACS badge reads, door events, alarm panel events, and
    visitor access patterns.  Detects tailgating, anti-passback
    violations, unusual off-hours access, and correlates access events
    with camera detections for multi-modal verification.
    """

    def __init__(self) -> None:
        super().__init__(
            name="access_guardian",
            role="Physical Access Control Monitor",
            description=(
                "Monitors PACS events (badge reads, door forced/held open), "
                "alarm panel events (zone alarms, arm/disarm, duress), and "
                "visitor patterns (entry/exit times, dwell per zone). "
                "Detects tailgating, anti-passback violations, unusual "
                "access patterns, and correlates access events with camera "
                "detections for multi-modal verification."
            ),
            tier="perception",
            model_name="gemma3:4b",
            tool_names=[
                "get_all_cameras_status",
                "get_current_detections",
                "analyze_frame_with_gemini",
                "create_alert",
                "store_observation",
                "recall_observations",
                "get_site_context",
                "get_event_history",
                "get_all_zones_status",
            ],
            subscriptions=[CH_CORTEX, CH_PERCEPTIONS],
            cycle_interval=20.0,
            token_budget_per_cycle=12000,
        )
        # Per-door denied access tracker: door_id -> [timestamps]
        self._denied_access_log: dict[str, list[float]] = defaultdict(list)
        # Visitor tracking: badge_id -> {zone_id, entry_ts, last_seen_ts}
        self._visitor_sessions: dict[str, dict[str, Any]] = {}
        # Cooldown tracker: "door_id:event_type" -> ts
        self._last_alerts: dict[str, float] = {}
        # Camera index for visual correlation
        self._camera_index: int = 0

    # ── Core reasoning loop ───────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main access monitoring cycle.

        1. Process PACS and alarm panel events from inbox.
        2. Detect access anomalies (repeated denials, off-hours, etc.).
        3. Correlate with camera detections when relevant.
        4. Publish structured access/alarm perceptions.
        """
        from backend.agents.agent_tools import TOOL_REGISTRY
        from backend.agents.agent_comms import agent_comms

        inbox = context.get("inbox_messages", [])
        now = datetime.now(timezone.utc)
        now_ts = time.time()

        events_processed = 0
        anomalies_detected = 0

        # ── 1. Process PACS events from inbox ─────────────────────
        for msg in inbox:
            msg_type = msg.get("type", "")

            if msg_type in ("pacs_event", "access_event"):
                result = await self._process_pacs_event(msg, now_ts)
                events_processed += 1
                if result.get("anomaly"):
                    anomalies_detected += 1

            elif msg_type in ("alarm_event", "alarm_panel_event"):
                await self._process_alarm_event(msg, now_ts)
                events_processed += 1

        # ── 2. Detect access pattern anomalies ────────────────────
        pattern_anomalies = await self._detect_access_anomalies(now_ts)
        anomalies_detected += pattern_anomalies

        # ── 3. Visual correlation for high-severity events ────────
        if anomalies_detected > 0:
            await self._correlate_with_cameras(context)

        # ── 4. Clean up stale visitor sessions (> 12 hours) ───────
        self._prune_visitor_sessions(now_ts)

        return {
            "status": "active" if events_processed else "idle",
            "events_processed": events_processed,
            "anomalies_detected": anomalies_detected,
            "active_visitors": len(self._visitor_sessions),
        }

    # ── PACS event processing ────────────────────────────────────

    async def _process_pacs_event(
        self, msg: dict, now_ts: float,
    ) -> dict:
        """Process a single PACS event (badge read, door event, etc.)."""
        from backend.agents.agent_comms import agent_comms

        event_type = msg.get("event_type", "badge_read_granted")
        door_id = msg.get("door_id", msg.get("reader_id", "unknown"))
        badge_id = msg.get("badge_id", msg.get("credential_id"))
        zone_id = msg.get("zone_id", "unknown")
        severity = _EVENT_SEVERITY.get(event_type, "info")
        result: dict[str, Any] = {"anomaly": False}

        # Track denied accesses for anomaly detection
        if event_type in ("badge_read_denied", "invalid_credential"):
            self._denied_access_log[door_id].append(now_ts)
            # Prune old entries
            self._denied_access_log[door_id] = [
                ts for ts in self._denied_access_log[door_id]
                if now_ts - ts < _DENIED_ACCESS_WINDOW
            ]

        # Track visitor sessions
        if badge_id and event_type == "badge_read_granted":
            if badge_id in self._visitor_sessions:
                # Update existing session
                self._visitor_sessions[badge_id]["last_seen_ts"] = now_ts
                self._visitor_sessions[badge_id]["zone_id"] = zone_id
            else:
                # New visitor session
                self._visitor_sessions[badge_id] = {
                    "zone_id": zone_id,
                    "entry_ts": now_ts,
                    "last_seen_ts": now_ts,
                    "door_id": door_id,
                }

        # Check for immediate high-severity events
        if severity in ("high", "critical"):
            if not self._is_cooldown_active(door_id, event_type):
                self._record_alert(door_id, event_type)
                result["anomaly"] = True

                await agent_comms.publish(CH_PERCEPTIONS, {
                    "agent": self.name,
                    "type": "access_event",
                    "event_type": event_type,
                    "door_id": door_id,
                    "zone_id": zone_id,
                    "badge_id": badge_id,
                    "severity": severity,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

                await self.log_action("access_event", {
                    "event_type": event_type,
                    "door_id": door_id,
                    "severity": severity,
                })

        # Detect off-hours access
        current_hour = datetime.now(timezone.utc).hour
        is_unusual_hour = (
            current_hour >= _UNUSUAL_HOUR_START
            or current_hour < _UNUSUAL_HOUR_END
        )
        if (
            event_type == "badge_read_granted"
            and is_unusual_hour
            and not self._is_cooldown_active(door_id, "off_hours_access")
        ):
            self._record_alert(door_id, "off_hours_access")
            result["anomaly"] = True

            await agent_comms.publish(CH_PERCEPTIONS, {
                "agent": self.name,
                "type": "access_anomaly",
                "subtype": "off_hours_access",
                "door_id": door_id,
                "zone_id": zone_id,
                "badge_id": badge_id,
                "hour": current_hour,
                "severity": "medium",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        return result

    # ── Alarm panel event processing ─────────────────────────────

    async def _process_alarm_event(
        self, msg: dict, now_ts: float,
    ) -> None:
        """Process an alarm panel event."""
        from backend.agents.agent_comms import agent_comms

        event_type = msg.get("event_type", "zone_alarm_triggered")
        zone_id = msg.get("zone_id", "unknown")
        panel_id = msg.get("panel_id", "unknown")
        severity = _EVENT_SEVERITY.get(event_type, "medium")

        await agent_comms.publish(CH_PERCEPTIONS, {
            "agent": self.name,
            "type": "alarm_event",
            "event_type": event_type,
            "zone_id": zone_id,
            "panel_id": panel_id,
            "severity": severity,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

        # Critical alarm events get immediate alert
        if severity in ("critical", "high"):
            await self.log_action("alarm_event", {
                "event_type": event_type,
                "zone_id": zone_id,
                "panel_id": panel_id,
                "severity": severity,
            })

    # ── Anomaly detection ────────────────────────────────────────

    async def _detect_access_anomalies(self, now_ts: float) -> int:
        """Detect access pattern anomalies from accumulated data."""
        from backend.agents.agent_comms import agent_comms

        anomalies = 0

        # Check for repeated denied access attempts
        for door_id, timestamps in self._denied_access_log.items():
            recent = [
                ts for ts in timestamps
                if now_ts - ts < _DENIED_ACCESS_WINDOW
            ]
            if len(recent) >= _DENIED_ACCESS_THRESHOLD:
                if not self._is_cooldown_active(door_id, "repeated_denied"):
                    self._record_alert(door_id, "repeated_denied")
                    anomalies += 1

                    await agent_comms.publish(CH_PERCEPTIONS, {
                        "agent": self.name,
                        "type": "access_anomaly",
                        "subtype": "repeated_denied_access",
                        "door_id": door_id,
                        "denied_count": len(recent),
                        "window_seconds": _DENIED_ACCESS_WINDOW,
                        "severity": "high",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

                    await self.log_action("access_anomaly", {
                        "subtype": "repeated_denied_access",
                        "door_id": door_id,
                        "denied_count": len(recent),
                    })

        return anomalies

    # ── Camera correlation ───────────────────────────────────────

    async def _correlate_with_cameras(self, context: dict) -> None:
        """Use camera analysis to correlate access events with visual
        detections (e.g., verify tailgating, confirm identity)."""
        from backend.agents.agent_tools import TOOL_REGISTRY

        try:
            cameras_result = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        except Exception:
            return

        if not cameras_result.get("success"):
            return

        cameras = [
            c for c in cameras_result.get("cameras", [])
            if c.get("status") == "online"
        ]
        if not cameras:
            return

        if self._camera_index >= len(cameras):
            self._camera_index = 0
        camera = cameras[self._camera_index]
        self._camera_index += 1

        result = await self.execute_tool_loop(
            prompt=(
                f"An access anomaly was detected. Analyze camera "
                f"{camera['id']} ({camera.get('name', 'Unknown')}) for "
                f"visual correlation.\n"
                f"Use analyze_frame_with_gemini with this prompt:\n"
                f"'ACCESS CORRELATION — Analyze this frame for:\n"
                f"1. Multiple people entering through a single door swipe "
                f"(tailgating)\n"
                f"2. People attempting to force or prop open doors\n"
                f"3. Unauthorized individuals in restricted areas\n"
                f"4. People acting suspiciously near access points\n"
                f"5. Delivery personnel or visitors without escorts\n"
                f"Report any access control concerns found.'\n\n"
                f"If you detect tailgating or forced entry, create an alert."
            ),
            context_data={
                "camera_id": camera["id"],
                "task": "access_correlation",
            },
        )

    # ── Helpers ───────────────────────────────────────────────────

    def _is_cooldown_active(self, door_id: str, event_type: str) -> bool:
        key = f"{door_id}:{event_type}"
        last_ts = self._last_alerts.get(key)
        if last_ts is None:
            return False
        return (time.time() - last_ts) < _ALERT_COOLDOWN_SECONDS

    def _record_alert(self, door_id: str, event_type: str) -> None:
        self._last_alerts[f"{door_id}:{event_type}"] = time.time()

    def _prune_visitor_sessions(self, now_ts: float) -> None:
        """Remove visitor sessions older than 12 hours."""
        max_age = 12 * 60 * 60
        stale = [
            badge_id
            for badge_id, session in self._visitor_sessions.items()
            if now_ts - session.get("last_seen_ts", now_ts) > max_age
        ]
        for badge_id in stale:
            del self._visitor_sessions[badge_id]
