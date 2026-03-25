"""Environmental Safety module for SENTINEL AI.

Smoke, fire, flooding, and environmental hazard detection using Gemini 3 Flash.
Provides real-time frame analysis for environmental threats that require
immediate escalation regardless of zone sensitivity settings.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select

from backend.config import settings
from backend.database import async_session
from backend.models.models import Alert, AlertSeverity, AlertStatus, Event
from backend.modules.gemini_client import analyze_frame_flash

logger = logging.getLogger(__name__)


class EnvironmentalSafety:
    """Smoke, fire, flooding, and environmental hazard detection."""

    ENV_PROMPT = """In addition to security analysis, check for environmental hazards:
- Smoke: any haze, wisps, or dense smoke? Direction of spread?
- Fire: any flames, sparks, electrical arcing, glowing embers?
- Water: any flooding, leaks, wet surfaces that shouldn't be wet?
- Unusual atmospheric conditions: fog, gas, chemical mist?
- Lighting: power failure, flickering, unusual shadows?

If ANY environmental hazard is detected, set environmental_hazard to true and provide details."""

    ENV_SCHEMA = {
        "type": "object",
        "properties": {
            "environmental_hazard": {"type": "boolean"},
            "hazard_details": {
                "type": "object",
                "properties": {
                    "hazard_type": {
                        "type": "string",
                        "enum": [
                            "smoke",
                            "fire_flame",
                            "electrical_sparking",
                            "water_flooding",
                            "gas_fog",
                            "chemical_spill",
                            "structural_damage",
                            "unusual_lighting",
                            "none",
                        ],
                    },
                    "severity": {
                        "type": "string",
                        "enum": ["none", "low", "medium", "high", "critical"],
                    },
                    "description": {"type": "string"},
                    "spread_direction": {"type": "string"},
                    "affected_area_percentage": {"type": "number"},
                    "recommended_action": {"type": "string"},
                },
                "required": ["hazard_type", "severity", "description"],
            },
        },
        "required": ["environmental_hazard"],
    }

    # Hazard type metadata for UI
    HAZARD_TYPES = {
        "smoke": {
            "label": "Smoke Detection",
            "icon": "cloud",
            "color": "gray",
            "critical_threshold": 6,
        },
        "fire_flame": {
            "label": "Fire/Flame",
            "icon": "flame",
            "color": "red",
            "critical_threshold": 4,
        },
        "electrical_sparking": {
            "label": "Electrical Sparking",
            "icon": "zap",
            "color": "yellow",
            "critical_threshold": 5,
        },
        "water_flooding": {
            "label": "Water/Flooding",
            "icon": "droplets",
            "color": "blue",
            "critical_threshold": 5,
        },
        "gas_fog": {
            "label": "Gas/Fog",
            "icon": "wind",
            "color": "purple",
            "critical_threshold": 5,
        },
        "structural_damage": {
            "label": "Structural Damage",
            "icon": "building",
            "color": "orange",
            "critical_threshold": 4,
        },
        "chemical_spill": {
            "label": "Chemical Spill",
            "icon": "flask",
            "color": "green",
            "critical_threshold": 4,
        },
        "unusual_lighting": {
            "label": "Unusual Lighting",
            "icon": "lightbulb",
            "color": "amber",
            "critical_threshold": 7,
        },
    }

    # Hazard types that ALWAYS escalate to CRITICAL regardless of zone sensitivity
    ALWAYS_CRITICAL_HAZARDS = {"fire_flame", "gas_fog", "chemical_spill"}

    # Severity mapping
    SEVERITY_MAP = {
        "critical": AlertSeverity.CRITICAL,
        "high": AlertSeverity.HIGH,
        "medium": AlertSeverity.MEDIUM,
        "low": AlertSeverity.LOW,
        "none": AlertSeverity.INFO,
    }

    async def analyze_frame(self, frame_bytes: bytes, camera_id: str) -> dict:
        """Analyze frame for environmental hazards using Gemini 3 Flash.

        Args:
            frame_bytes: JPEG-encoded image bytes from the camera feed.
            camera_id: Identifier of the source camera.

        Returns:
            dict with ``environmental_hazard`` bool and optional ``hazard_details``.
        """
        try:
            result = await analyze_frame_flash(
                frame_bytes=frame_bytes,
                prompt=self.ENV_PROMPT,
                json_schema=self.ENV_SCHEMA,
                thinking_level="low",
            )
            logger.debug(
                "env_safety.analyze_frame.done",
                extra={"camera_id": camera_id, "hazard": result.get("environmental_hazard", False)},
            )
            return result
        except Exception:
            logger.exception(
                "env_safety.analyze_frame.error",
                extra={"camera_id": camera_id},
            )
            return {"environmental_hazard": False, "error": "analysis_failed"}

    async def process_hazard(
        self,
        analysis: dict,
        camera_id: str,
        frame_path: str | None = None,
    ) -> Event | None:
        """Process a detected hazard -- create Event and Alert if confirmed.

        Fire, gas, and chemical spill hazards are ALWAYS escalated to CRITICAL
        regardless of the reported severity or zone sensitivity.

        Args:
            analysis: Output from :meth:`analyze_frame`.
            camera_id: Identifier of the source camera.
            frame_path: Optional path/URL to the stored snapshot frame.

        Returns:
            The persisted :class:`Event` if a hazard was confirmed, else ``None``.
        """
        if not analysis.get("environmental_hazard"):
            return None

        details = analysis.get("hazard_details", {})
        hazard_type = details.get("hazard_type", "none")
        if hazard_type == "none":
            return None

        raw_severity = details.get("severity", "medium")
        description = details.get("description", "Environmental hazard detected")
        spread_direction = details.get("spread_direction")
        affected_area = details.get("affected_area_percentage", 0)
        recommended_action = details.get("recommended_action")

        # Fire/gas/chemical always CRITICAL regardless of zone sensitivity
        if hazard_type in self.ALWAYS_CRITICAL_HAZARDS:
            severity = AlertSeverity.CRITICAL
        else:
            severity = self.SEVERITY_MAP.get(raw_severity, AlertSeverity.MEDIUM)

        hazard_meta = self.HAZARD_TYPES.get(hazard_type, {})
        event_id = uuid.uuid4()
        alert_id = uuid.uuid4()
        now = datetime.now(timezone.utc)

        try:
            async with async_session() as session:
                async with session.begin():
                    # -- Create Event --
                    event = Event(
                        id=event_id,
                        camera_id=uuid.UUID(camera_id) if isinstance(camera_id, str) else camera_id,
                        event_type=f"environmental_{hazard_type}",
                        description=description,
                        severity=severity,
                        confidence=min(affected_area / 100.0, 1.0) if affected_area else 0.5,
                        frame_url=frame_path,
                        gemini_analysis=analysis,
                        metadata_={
                            "hazard_type": hazard_type,
                            "spread_direction": spread_direction,
                            "affected_area_percentage": affected_area,
                            "recommended_action": recommended_action,
                            "raw_severity": raw_severity,
                            "module": "environmental_safety",
                        },
                        timestamp=now,
                    )
                    session.add(event)

                    # -- Create Alert --
                    alert_title = (
                        f"{hazard_meta.get('label', hazard_type.replace('_', ' ').title())} "
                        f"Detected - {severity.value.upper()}"
                    )
                    alert = Alert(
                        id=alert_id,
                        event_id=event_id,
                        title=alert_title,
                        description=(
                            f"{description}. "
                            f"Spread direction: {spread_direction or 'N/A'}. "
                            f"Affected area: {affected_area}%. "
                            f"Recommended action: {recommended_action or 'Investigate immediately'}."
                        ),
                        severity=severity,
                        status=AlertStatus.NEW,
                        threat_type=f"environmental_{hazard_type}",
                        source_camera=camera_id,
                        confidence=min(affected_area / 100.0, 1.0) if affected_area else 0.5,
                        metadata_={
                            "hazard_type": hazard_type,
                            "hazard_label": hazard_meta.get("label", hazard_type),
                            "hazard_icon": hazard_meta.get("icon"),
                            "hazard_color": hazard_meta.get("color"),
                            "spread_direction": spread_direction,
                            "affected_area_percentage": affected_area,
                            "recommended_action": recommended_action,
                            "auto_escalated": hazard_type in self.ALWAYS_CRITICAL_HAZARDS,
                        },
                        created_at=now,
                    )
                    session.add(alert)

            logger.warning(
                "env_safety.hazard_confirmed",
                extra={
                    "camera_id": camera_id,
                    "hazard_type": hazard_type,
                    "severity": severity.value,
                    "event_id": str(event_id),
                    "alert_id": str(alert_id),
                    "affected_area_pct": affected_area,
                },
            )
            return event

        except Exception:
            logger.exception(
                "env_safety.process_hazard.error",
                extra={"camera_id": camera_id, "hazard_type": hazard_type},
            )
            return None

    async def get_stats(self) -> dict:
        """Get environmental monitoring statistics.

        Returns:
            dict with total counts, breakdowns by severity and hazard type,
            and the most recent hazard timestamp.
        """
        try:
            async with async_session() as session:
                # Total environmental events
                total_q = await session.execute(
                    select(func.count(Event.id)).where(
                        Event.event_type.like("environmental_%")
                    )
                )
                total_events = total_q.scalar() or 0

                # Events by severity
                severity_q = await session.execute(
                    select(Event.severity, func.count(Event.id))
                    .where(Event.event_type.like("environmental_%"))
                    .group_by(Event.severity)
                )
                by_severity = {
                    row[0].value if hasattr(row[0], "value") else str(row[0]): row[1]
                    for row in severity_q.all()
                }

                # Events by hazard type (extracted from event_type column)
                type_q = await session.execute(
                    select(Event.event_type, func.count(Event.id))
                    .where(Event.event_type.like("environmental_%"))
                    .group_by(Event.event_type)
                )
                by_hazard_type = {}
                for row in type_q.all():
                    # Strip "environmental_" prefix for the key
                    clean_type = row[0].replace("environmental_", "", 1)
                    by_hazard_type[clean_type] = row[1]

                # Active (unresolved) alerts
                active_q = await session.execute(
                    select(func.count(Alert.id)).where(
                        Alert.threat_type.like("environmental_%"),
                        Alert.status.in_([
                            AlertStatus.NEW,
                            AlertStatus.ACKNOWLEDGED,
                            AlertStatus.INVESTIGATING,
                            AlertStatus.ESCALATED,
                        ]),
                    )
                )
                active_alerts = active_q.scalar() or 0

                # Most recent hazard timestamp
                recent_q = await session.execute(
                    select(Event.timestamp)
                    .where(Event.event_type.like("environmental_%"))
                    .order_by(Event.timestamp.desc())
                    .limit(1)
                )
                last_hazard_row = recent_q.scalar()
                last_hazard = last_hazard_row.isoformat() if last_hazard_row else None

            return {
                "total_events": total_events,
                "active_alerts": active_alerts,
                "by_severity": by_severity,
                "by_hazard_type": by_hazard_type,
                "last_hazard_at": last_hazard,
            }

        except Exception:
            logger.exception("env_safety.get_stats.error")
            return {
                "total_events": 0,
                "active_alerts": 0,
                "by_severity": {},
                "by_hazard_type": {},
                "last_hazard_at": None,
                "error": "stats_query_failed",
            }

    async def get_events(
        self,
        hazard_type: str | None = None,
        status: str | None = None,
        min_severity: int = 0,
        limit: int = 50,
    ) -> list:
        """Get hazard events with optional filters.

        Args:
            hazard_type: Filter by specific hazard type (e.g. ``"smoke"``, ``"fire_flame"``).
            status: Filter related alerts by status (e.g. ``"new"``, ``"resolved"``).
            min_severity: Minimum severity ordinal (0=info .. 4=critical).
            limit: Maximum number of events to return.

        Returns:
            List of event dicts ordered by timestamp descending.
        """
        severity_order = ["info", "low", "medium", "high", "critical"]
        allowed_severities = [
            AlertSeverity(s) for s in severity_order[min_severity:]
        ] if min_severity > 0 else []

        try:
            async with async_session() as session:
                query = (
                    select(Event)
                    .where(Event.event_type.like("environmental_%"))
                    .order_by(Event.timestamp.desc())
                    .limit(limit)
                )

                if hazard_type:
                    query = query.where(
                        Event.event_type == f"environmental_{hazard_type}"
                    )

                if allowed_severities:
                    query = query.where(Event.severity.in_(allowed_severities))

                result = await session.execute(query)
                events = result.scalars().all()

                # If status filter requested, fetch matching alert event_ids first
                filtered_event_ids: set | None = None
                if status:
                    try:
                        alert_status = AlertStatus(status)
                    except ValueError:
                        alert_status = None

                    if alert_status:
                        alert_q = await session.execute(
                            select(Alert.event_id).where(
                                Alert.threat_type.like("environmental_%"),
                                Alert.status == alert_status,
                            )
                        )
                        filtered_event_ids = {row[0] for row in alert_q.all() if row[0]}

                output: List[Dict[str, Any]] = []
                for ev in events:
                    if filtered_event_ids is not None and ev.id not in filtered_event_ids:
                        continue

                    hazard_key = ev.event_type.replace("environmental_", "", 1)
                    hazard_meta = self.HAZARD_TYPES.get(hazard_key, {})

                    output.append({
                        "id": str(ev.id),
                        "camera_id": str(ev.camera_id),
                        "event_type": ev.event_type,
                        "hazard_type": hazard_key,
                        "hazard_label": hazard_meta.get("label", hazard_key),
                        "hazard_icon": hazard_meta.get("icon"),
                        "hazard_color": hazard_meta.get("color"),
                        "description": ev.description,
                        "severity": ev.severity.value if hasattr(ev.severity, "value") else str(ev.severity),
                        "confidence": ev.confidence,
                        "frame_url": ev.frame_url,
                        "metadata": ev.metadata_,
                        "gemini_analysis": ev.gemini_analysis,
                        "timestamp": ev.timestamp.isoformat() if ev.timestamp else None,
                    })

                return output

        except Exception:
            logger.exception("env_safety.get_events.error")
            return []

    async def get_hazard_types(self) -> list:
        """Get configured hazard types with live event counts.

        Returns:
            List of dicts, one per hazard type, with label, icon, color,
            threshold, and current event count from the database.
        """
        try:
            async with async_session() as session:
                count_q = await session.execute(
                    select(Event.event_type, func.count(Event.id))
                    .where(Event.event_type.like("environmental_%"))
                    .group_by(Event.event_type)
                )
                counts = {
                    row[0].replace("environmental_", "", 1): row[1]
                    for row in count_q.all()
                }
        except Exception:
            logger.exception("env_safety.get_hazard_types.count_error")
            counts = {}

        result: List[Dict[str, Any]] = []
        for key, meta in self.HAZARD_TYPES.items():
            result.append({
                "key": key,
                "label": meta["label"],
                "icon": meta["icon"],
                "color": meta["color"],
                "critical_threshold": meta["critical_threshold"],
                "event_count": counts.get(key, 0),
            })
        return result


# Singleton
environmental_safety = EnvironmentalSafety()
