"""Automated Shift Intelligence Briefing — AI-generated comprehensive handoff.

At every shift change, automatically generates:
  "SHIFT BRIEFING 18:00-02:00: During the previous shift, 14 alerts were
  generated (3 high, 11 medium). Key events: (1) Tailgating incident at
  north entrance — resolved. (2) BOLO match on blue Honda — departed 16:45."

Turns a 15-minute verbal briefing into an instant AI-generated handoff.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from backend.config import settings
from backend.database import async_session
from backend.models import Alert, Camera, Event

logger = logging.getLogger(__name__)

_BRIEFING_PROMPT = """\
You are a security shift supervisor preparing an intelligence briefing for
the incoming shift. Be thorough, professional, and action-oriented.

**Outgoing Shift:** {shift_start} to {shift_end}

**Alerts Summary:**
- Critical: {critical} | High: {high} | Medium: {medium} | Low: {low}
- Resolved: {resolved} | Unresolved: {unresolved}

**Key Alert Details:**
{alert_details}

**Camera Status:**
- Online: {cameras_online}/{cameras_total}
- Offline: {offline_cameras}

**Zone Activity:**
{zone_activity}

**Shift Log Entries (manual):**
{shift_log_entries}

**Posture Score:** {posture_score}

Generate a comprehensive shift briefing. Respond with JSON:
{{
  "briefing_title": "SHIFT BRIEFING HH:MM-HH:MM",
  "executive_summary": "2-3 sentence overview of the shift",
  "key_events": [
    {{
      "priority": 1,
      "event": "description of key event",
      "status": "resolved|ongoing|escalated",
      "action_taken": "what was done",
      "followup_needed": "what incoming shift needs to do"
    }}
  ],
  "open_items": [
    {{
      "item": "description",
      "priority": "high|medium|low",
      "assigned_to": "person or team",
      "deadline": "when"
    }}
  ],
  "system_status": {{
    "cameras": "summary of camera health",
    "alerts": "current alert posture",
    "notable": "any system issues"
  }},
  "expected_activity": [
    {{
      "time": "expected time",
      "activity": "what to expect",
      "contact": "who to call if issues"
    }}
  ],
  "recommendations": ["action items for incoming shift"],
  "threat_posture": "normal|elevated|high|critical"
}}
"""


class ShiftBriefing:
    """Represents a generated shift briefing."""

    def __init__(self, shift_start: datetime, shift_end: datetime) -> None:
        self.shift_start = shift_start
        self.shift_end = shift_end
        self.generated_at = datetime.now(timezone.utc)
        self.briefing: Dict[str, Any] = {}
        self.raw_data: Dict[str, Any] = {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "shift_start": self.shift_start.isoformat(),
            "shift_end": self.shift_end.isoformat(),
            "generated_at": self.generated_at.isoformat(),
            "briefing": self.briefing,
            "raw_data": self.raw_data,
        }


class ShiftBriefingService:
    """Generates AI-powered shift intelligence briefings."""

    def __init__(self) -> None:
        self._briefing_history: List[Dict] = []

    async def generate_briefing(
        self,
        shift_hours: int = 8,
        shift_end: Optional[datetime] = None,
    ) -> ShiftBriefing:
        """Generate a comprehensive shift briefing.

        Args:
            shift_hours: Duration of the outgoing shift
            shift_end: When the outgoing shift ended (default: now)
        """
        if shift_end is None:
            shift_end = datetime.now(timezone.utc)
        shift_start = shift_end - timedelta(hours=shift_hours)

        briefing = ShiftBriefing(shift_start, shift_end)

        # Gather data from the outgoing shift
        alert_summary = await self._get_alert_summary(shift_start, shift_end)
        alert_details = await self._get_key_alerts(shift_start, shift_end)
        camera_status = await self._get_camera_status()
        zone_activity = await self._get_zone_activity(shift_start, shift_end)
        shift_log = await self._get_shift_log_entries(shift_start, shift_end)
        posture = await self._get_posture_score()

        briefing.raw_data = {
            "alert_summary": alert_summary,
            "alert_details": alert_details,
            "camera_status": camera_status,
            "zone_activity": zone_activity,
            "shift_log": shift_log,
            "posture_score": posture,
        }

        # Generate AI briefing
        prompt = _BRIEFING_PROMPT.format(
            shift_start=shift_start.strftime("%H:%M"),
            shift_end=shift_end.strftime("%H:%M"),
            critical=alert_summary.get("critical", 0),
            high=alert_summary.get("high", 0),
            medium=alert_summary.get("medium", 0),
            low=alert_summary.get("low", 0),
            resolved=alert_summary.get("resolved", 0),
            unresolved=alert_summary.get("unresolved", 0),
            alert_details=json.dumps(alert_details[:10], indent=2, default=str),
            cameras_online=camera_status.get("online", 0),
            cameras_total=camera_status.get("total", 0),
            offline_cameras=", ".join(camera_status.get("offline_names", [])[:5]),
            zone_activity=json.dumps(zone_activity[:10], indent=2, default=str),
            shift_log_entries=json.dumps(shift_log[:10], indent=2, default=str),
            posture_score=posture,
        )

        try:
            from backend.modules.gemini_client import gemini_client
            response = await gemini_client.generate(
                prompt=prompt,
                
                temperature=0.3,
                max_tokens=1500,
            )

            if response:
                parsed = self._parse_json(response)
                if parsed:
                    briefing.briefing = parsed

        except Exception as e:
            logger.error("briefing.generation_failed: %s", e)
            briefing.briefing = {
                "briefing_title": f"SHIFT BRIEFING {shift_start.strftime('%H:%M')}-{shift_end.strftime('%H:%M')}",
                "executive_summary": (
                    f"Shift produced {alert_summary.get('total', 0)} alerts. "
                    f"{alert_summary.get('unresolved', 0)} remain unresolved."
                ),
                "key_events": alert_details[:5],
                "open_items": [],
                "threat_posture": "normal",
            }

        self._briefing_history.append(briefing.to_dict())
        if len(self._briefing_history) > 50:
            self._briefing_history = self._briefing_history[-25:]

        logger.info(
            "briefing.generated shift=%s-%s alerts=%d",
            shift_start.strftime("%H:%M"), shift_end.strftime("%H:%M"),
            alert_summary.get("total", 0),
        )
        return briefing

    async def _get_alert_summary(self, start: datetime, end: datetime) -> Dict:
        try:
            from sqlalchemy import select, func as sqlfunc
            from backend.models.models import AlertStatus, AlertSeverity
            async with async_session() as session:
                alerts = (await session.execute(
                    select(Alert).where(Alert.created_at >= start, Alert.created_at <= end)
                )).scalars().all()

                summary = {"total": len(alerts), "critical": 0, "high": 0, "medium": 0, "low": 0, "resolved": 0, "unresolved": 0}
                for a in alerts:
                    sev = a.severity.value if hasattr(a.severity, "value") else str(a.severity)
                    summary[sev] = summary.get(sev, 0) + 1
                    status = a.status.value if hasattr(a.status, "value") else str(a.status)
                    if status in ("resolved", "dismissed"):
                        summary["resolved"] += 1
                    else:
                        summary["unresolved"] += 1
                return summary
        except Exception:
            return {"total": 0}

    async def _get_key_alerts(self, start: datetime, end: datetime) -> List[Dict]:
        try:
            from sqlalchemy import select
            from backend.models.models import AlertSeverity
            async with async_session() as session:
                result = await session.execute(
                    select(Alert).where(
                        Alert.created_at >= start,
                        Alert.created_at <= end,
                        Alert.severity.in_([AlertSeverity.HIGH, AlertSeverity.CRITICAL]),
                    ).order_by(Alert.created_at.desc()).limit(10)
                )
                return [
                    {
                        "title": a.title,
                        "severity": a.severity.value if hasattr(a.severity, "value") else str(a.severity),
                        "status": a.status.value if hasattr(a.status, "value") else str(a.status),
                        "camera": a.source_camera,
                        "time": str(a.created_at),
                        "resolution": a.resolution_notes or "No resolution notes",
                    }
                    for a in result.scalars().all()
                ]
        except Exception:
            return []

    async def _get_camera_status(self) -> Dict:
        try:
            from sqlalchemy import select
            async with async_session() as session:
                cameras = (await session.execute(select(Camera))).scalars().all()
                online = sum(1 for c in cameras if c.status == "online")
                offline_names = [c.name for c in cameras if c.status != "online"]
                return {
                    "online": online,
                    "total": len(cameras),
                    "offline_names": offline_names,
                }
        except Exception:
            return {"online": 0, "total": 0, "offline_names": []}

    async def _get_zone_activity(self, start: datetime, end: datetime) -> List[Dict]:
        try:
            from sqlalchemy import select, func as sqlfunc
            async with async_session() as session:
                result = await session.execute(
                    select(
                        Alert.zone_name,
                        sqlfunc.count(Alert.id).label("alert_count"),
                    ).where(
                        Alert.created_at >= start,
                        Alert.created_at <= end,
                        Alert.zone_name.isnot(None),
                    ).group_by(Alert.zone_name).order_by(sqlfunc.count(Alert.id).desc()).limit(10)
                )
                return [{"zone": row[0], "alerts": row[1]} for row in result.all()]
        except Exception:
            return []

    async def _get_shift_log_entries(self, start: datetime, end: datetime) -> List[Dict]:
        try:
            from sqlalchemy import select
            from backend.models.models import ShiftLogEntry
            async with async_session() as session:
                result = await session.execute(
                    select(ShiftLogEntry).where(
                        ShiftLogEntry.created_at >= start,
                        ShiftLogEntry.created_at <= end,
                    ).order_by(ShiftLogEntry.created_at.desc()).limit(20)
                )
                return [
                    {
                        "time": str(e.created_at),
                        "author": getattr(e, "author", "Unknown"),
                        "content": getattr(e, "content", str(e)),
                    }
                    for e in result.scalars().all()
                ]
        except Exception:
            return []

    async def _get_posture_score(self) -> str:
        return "N/A"

    def _parse_json(self, text: str) -> Optional[Dict]:
        text = text.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            text = "\n".join(lines)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    return json.loads(text[start:end])
                except json.JSONDecodeError:
                    pass
        return None

    def get_history(self, limit: int = 10) -> List[Dict]:
        return self._briefing_history[-limit:]


# ── Singleton ─────────────────────────────────────────────────────
shift_briefing_service = ShiftBriefingService()
