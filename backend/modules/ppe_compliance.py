"""PPE Compliance -- detect safety equipment on persons in industrial zones.

Uses Gemini 3 Flash vision to analyse camera frames for personal protective
equipment (hard hats, hi-vis vests, safety glasses, gloves, steel-toe boots,
etc.) and records compliance status per person per zone.  Non-compliant
detections raise alerts with configurable severity.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func

from backend.config import settings
from backend.database import async_session
from backend.models.advanced_models import PPEComplianceEvent
from backend.models.models import Zone, Event, Alert, AlertSeverity, AlertStatus
from backend.modules.gemini_client import analyze_frame_flash

logger = logging.getLogger(__name__)


class PPECompliance:
    """PPE compliance checking via Gemini 3 Flash vision analysis."""

    PPE_PROMPT = (
        "This zone requires the following PPE: {required_ppe_list}.\n"
        "For each person detected, assess their PPE compliance:\n"
        "- Which required items are they wearing?\n"
        "- Which required items are they NOT wearing or cannot be determined?\n"
        "- Overall compliance: compliant / non_compliant / partially_compliant"
    )

    PPE_SCHEMA: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "persons": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "detected_ppe": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "missing_ppe": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "compliance_status": {
                            "type": "string",
                            "enum": [
                                "compliant",
                                "non_compliant",
                                "partially_compliant",
                            ],
                        },
                        "location_in_frame": {"type": "string"},
                    },
                    "required": [
                        "detected_ppe",
                        "missing_ppe",
                        "compliance_status",
                    ],
                },
            },
            "overall_zone_compliance": {"type": "string"},
            "violation_count": {"type": "integer"},
        },
        "required": ["persons", "overall_zone_compliance", "violation_count"],
    }

    # ── Compliance check ─────────────────────────────────────────

    async def check_compliance(
        self,
        frame_bytes: bytes,
        camera_id: str,
        zone_id: str,
        required_ppe: list,
    ) -> dict:
        """Check PPE compliance in a single camera frame.

        Args:
            frame_bytes: JPEG-encoded image bytes.
            camera_id: UUID-string of the source camera.
            zone_id: UUID-string of the industrial zone.
            required_ppe: List of required PPE item names
                          (e.g. ["hard_hat", "hi_vis_vest", "safety_glasses"]).

        Returns:
            Dict with persons list, overall_zone_compliance, violation_count,
            plus metadata (camera_id, zone_id, timestamp).
        """
        required_ppe_list = ", ".join(required_ppe) if required_ppe else "none specified"
        prompt = self.PPE_PROMPT.format(required_ppe_list=required_ppe_list)

        try:
            result = await analyze_frame_flash(
                frame_bytes=frame_bytes,
                prompt=prompt,
                json_schema=self.PPE_SCHEMA,
                media_resolution="media_resolution_high",
            )

            result["camera_id"] = camera_id
            result["zone_id"] = zone_id
            result["required_ppe"] = required_ppe
            result["checked_at"] = datetime.now(timezone.utc).isoformat()

            logger.info(
                "ppe.check_compliance camera=%s zone=%s persons=%d violations=%d status=%s",
                camera_id,
                zone_id,
                len(result.get("persons", [])),
                result.get("violation_count", 0),
                result.get("overall_zone_compliance", "unknown"),
            )
            return result

        except Exception as exc:
            logger.error(
                "ppe.check_compliance failed camera=%s zone=%s: %s",
                camera_id,
                zone_id,
                exc,
            )
            return {
                "persons": [],
                "overall_zone_compliance": "error",
                "violation_count": 0,
                "camera_id": camera_id,
                "zone_id": zone_id,
                "required_ppe": required_ppe,
                "error": str(exc),
            }

    # ── Event storage ────────────────────────────────────────────

    async def store_event(
        self,
        result: dict,
        camera_id: str,
        zone_id: str,
        required_ppe: list,
    ) -> list:
        """Store compliance check results as PPEComplianceEvent records.

        One record is created per person detected. If a person is non-compliant,
        an Alert is also raised.

        Args:
            result: Dict returned by :meth:`check_compliance`.
            camera_id: UUID-string of the source camera.
            zone_id: UUID-string of the zone.
            required_ppe: The PPE list that was required.

        Returns:
            List of created PPEComplianceEvent dicts.
        """
        persons = result.get("persons", [])
        if not persons:
            return []

        created_events: List[Dict[str, Any]] = []

        async with async_session() as session:
            try:
                camera_uuid = uuid.UUID(camera_id) if isinstance(camera_id, str) else camera_id
                zone_uuid = uuid.UUID(zone_id) if isinstance(zone_id, str) else zone_id

                for person in persons:
                    event_id = uuid.uuid4()
                    compliance_status = person.get("compliance_status", "unknown")
                    detected_ppe = person.get("detected_ppe", [])
                    missing_ppe = person.get("missing_ppe", [])

                    # Persist compliance event
                    ppe_event = PPEComplianceEvent(
                        id=event_id,
                        camera_id=camera_uuid,
                        zone_id=zone_uuid,
                        required_ppe=required_ppe,
                        detected_ppe=detected_ppe,
                        missing_ppe=missing_ppe,
                        compliance_status=compliance_status,
                    )
                    session.add(ppe_event)

                    # Raise alert for non-compliant persons
                    if compliance_status == "non_compliant":
                        missing_items = ", ".join(missing_ppe) if missing_ppe else "unknown items"
                        alert = Alert(
                            id=uuid.uuid4(),
                            title=f"PPE Violation: Missing {missing_items}",
                            description=(
                                f"Person detected without required PPE in zone {zone_id}. "
                                f"Missing: {missing_items}. "
                                f"Detected: {', '.join(detected_ppe) if detected_ppe else 'none'}."
                            ),
                            severity=AlertSeverity.MEDIUM,
                            status=AlertStatus.NEW,
                            threat_type="ppe_violation",
                            source_camera=camera_id,
                            zone_name=zone_id,
                            confidence=0.85,
                            metadata_={
                                "ppe_event_id": str(event_id),
                                "missing_ppe": missing_ppe,
                                "detected_ppe": detected_ppe,
                                "location_in_frame": person.get("location_in_frame"),
                            },
                        )
                        session.add(alert)

                        logger.warning(
                            "ppe.violation camera=%s zone=%s missing=%s",
                            camera_id,
                            zone_id,
                            missing_items,
                        )

                    created_events.append({
                        "id": str(event_id),
                        "camera_id": camera_id,
                        "zone_id": zone_id,
                        "compliance_status": compliance_status,
                        "detected_ppe": detected_ppe,
                        "missing_ppe": missing_ppe,
                    })

                await session.commit()
                logger.info(
                    "ppe.store_event camera=%s zone=%s events=%d",
                    camera_id,
                    zone_id,
                    len(created_events),
                )
                return created_events

            except Exception as exc:
                await session.rollback()
                logger.error("ppe.store_event failed: %s", exc)
                raise

    # ── Statistics ────────────────────────────────────────────────

    async def get_stats(self, zone_id: str = None) -> dict:
        """Get PPE compliance statistics, optionally filtered by zone.

        Args:
            zone_id: Optional UUID-string to filter stats to a single zone.

        Returns:
            Dict with total_checks, compliant_count, non_compliant_count,
            partially_compliant_count, compliance_rate, and breakdown by zone.
        """
        async with async_session() as session:
            try:
                # Base query for status counts
                base_filter = []
                if zone_id:
                    zone_uuid = uuid.UUID(zone_id) if isinstance(zone_id, str) else zone_id
                    base_filter.append(PPEComplianceEvent.zone_id == zone_uuid)

                # Total checks
                total_stmt = select(func.count(PPEComplianceEvent.id))
                if base_filter:
                    total_stmt = total_stmt.where(*base_filter)
                total_result = await session.execute(total_stmt)
                total_checks = total_result.scalar() or 0

                # Compliant count
                compliant_stmt = select(func.count(PPEComplianceEvent.id)).where(
                    PPEComplianceEvent.compliance_status == "compliant",
                    *base_filter,
                )
                compliant_result = await session.execute(compliant_stmt)
                compliant_count = compliant_result.scalar() or 0

                # Non-compliant count
                non_compliant_stmt = select(func.count(PPEComplianceEvent.id)).where(
                    PPEComplianceEvent.compliance_status == "non_compliant",
                    *base_filter,
                )
                non_compliant_result = await session.execute(non_compliant_stmt)
                non_compliant_count = non_compliant_result.scalar() or 0

                # Partially compliant count
                partial_stmt = select(func.count(PPEComplianceEvent.id)).where(
                    PPEComplianceEvent.compliance_status == "partially_compliant",
                    *base_filter,
                )
                partial_result = await session.execute(partial_stmt)
                partially_compliant_count = partial_result.scalar() or 0

                # Compliance rate
                compliance_rate = 0.0
                if total_checks > 0:
                    compliance_rate = round(compliant_count / total_checks * 100, 2)

                # Last 24h violation trend
                day_ago = datetime.now(timezone.utc) - timedelta(hours=24)
                recent_violations_stmt = select(
                    func.count(PPEComplianceEvent.id)
                ).where(
                    PPEComplianceEvent.compliance_status == "non_compliant",
                    PPEComplianceEvent.timestamp > day_ago,
                    *base_filter,
                )
                recent_result = await session.execute(recent_violations_stmt)
                recent_violations = recent_result.scalar() or 0

                stats = {
                    "total_checks": total_checks,
                    "compliant_count": compliant_count,
                    "non_compliant_count": non_compliant_count,
                    "partially_compliant_count": partially_compliant_count,
                    "compliance_rate": compliance_rate,
                    "recent_violations_24h": recent_violations,
                    "zone_id": zone_id,
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                }

                logger.info(
                    "ppe.get_stats zone=%s total=%d rate=%.1f%%",
                    zone_id or "all",
                    total_checks,
                    compliance_rate,
                )
                return stats

            except Exception as exc:
                logger.error("ppe.get_stats failed: %s", exc)
                return {
                    "total_checks": 0,
                    "compliant_count": 0,
                    "non_compliant_count": 0,
                    "partially_compliant_count": 0,
                    "compliance_rate": 0.0,
                    "error": str(exc),
                }

    # ── Event listing ────────────────────────────────────────────

    async def get_events(
        self,
        zone_id: str = None,
        status: str = None,
        limit: int = 50,
    ) -> list:
        """Get compliance events with optional filtering.

        Args:
            zone_id: Optional UUID-string to filter by zone.
            status: Optional compliance status filter
                    ("compliant", "non_compliant", "partially_compliant").
            limit: Maximum number of events to return (default 50).

        Returns:
            List of compliance event dicts, most recent first.
        """
        async with async_session() as session:
            try:
                stmt = select(PPEComplianceEvent).order_by(
                    PPEComplianceEvent.timestamp.desc()
                )

                if zone_id:
                    zone_uuid = uuid.UUID(zone_id) if isinstance(zone_id, str) else zone_id
                    stmt = stmt.where(PPEComplianceEvent.zone_id == zone_uuid)

                if status:
                    stmt = stmt.where(PPEComplianceEvent.compliance_status == status)

                stmt = stmt.limit(limit)

                result = await session.execute(stmt)
                events = result.scalars().all()

                event_list = []
                for evt in events:
                    event_list.append({
                        "id": str(evt.id),
                        "camera_id": str(evt.camera_id),
                        "zone_id": str(evt.zone_id) if evt.zone_id else None,
                        "timestamp": evt.timestamp.isoformat() if evt.timestamp else None,
                        "required_ppe": evt.required_ppe,
                        "detected_ppe": evt.detected_ppe,
                        "missing_ppe": evt.missing_ppe,
                        "compliance_status": evt.compliance_status,
                        "person_snapshot_path": evt.person_snapshot_path,
                        "created_at": evt.created_at.isoformat() if evt.created_at else None,
                    })

                logger.info(
                    "ppe.get_events zone=%s status=%s count=%d",
                    zone_id or "all",
                    status or "all",
                    len(event_list),
                )
                return event_list

            except Exception as exc:
                logger.error("ppe.get_events failed: %s", exc)
                return []


# ── Singleton ────────────────────────────────────────────────────

ppe_compliance = PPECompliance()
