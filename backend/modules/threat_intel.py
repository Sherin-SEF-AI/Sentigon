"""Threat Intelligence Feed -- external threat data ingestion and auto-watchlist.

Provides webhook-based ingestion of threat intel from external sources (law
enforcement BOLOs, corporate security feeds, etc.), automatic watchlist
population for BOLO vehicles, and formatted context for agent injection.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from backend.config import settings
from backend.database import async_session
from backend.models.advanced_models import ThreatIntelEntry, VehicleWatchlist

logger = logging.getLogger(__name__)


class ThreatIntelligence:
    """Ingest, store, and query external threat intelligence feeds."""

    # ── Webhook ingestion ─────────────────────────────────────────

    async def ingest_webhook(self, payload: dict) -> ThreatIntelEntry:
        """Process an incoming threat intel webhook.

        If the payload describes a BOLO vehicle (alert_type == "bolo_vehicle")
        and the details contain a license plate, the plate is automatically
        added to the vehicle watchlist.

        Args:
            payload: Webhook body with keys source, alert_type, details,
                     severity, and optional valid_until.

        Returns:
            The persisted ThreatIntelEntry ORM instance.
        """
        entry_id = uuid.uuid4()
        now = datetime.now(timezone.utc)

        source = payload.get("source", "unknown")
        alert_type = payload.get("alert_type", "generic")
        details = payload.get("details") or {}
        severity = payload.get("severity", "medium")
        valid_until_raw = payload.get("valid_until")

        # Parse valid_until if provided as ISO string
        valid_until: Optional[datetime] = None
        if valid_until_raw:
            try:
                if isinstance(valid_until_raw, str):
                    valid_until = datetime.fromisoformat(valid_until_raw)
                elif isinstance(valid_until_raw, datetime):
                    valid_until = valid_until_raw
            except (ValueError, TypeError) as exc:
                logger.warning(
                    "threat_intel.ingest_webhook invalid valid_until=%r: %s",
                    valid_until_raw,
                    exc,
                )

        auto_actions: Dict[str, Any] = {}

        async with async_session() as session:
            try:
                # -- Auto-watchlist for BOLO vehicles -------------------------
                if alert_type == "bolo_vehicle" and details.get("plate"):
                    plate_text = details["plate"].upper().strip()
                    reason = details.get("reason", f"BOLO from {source}")
                    bolo_severity = details.get("severity", severity)

                    # Check if plate is already on the watchlist
                    existing_stmt = select(VehicleWatchlist).where(
                        VehicleWatchlist.plate_text == plate_text,
                        VehicleWatchlist.active.is_(True),
                    )
                    existing_result = await session.execute(existing_stmt)
                    existing_entry = existing_result.scalar_one_or_none()

                    if not existing_entry:
                        watchlist_entry = VehicleWatchlist(
                            id=uuid.uuid4(),
                            plate_text=plate_text,
                            reason=reason,
                            severity=bolo_severity,
                            active=True,
                            notes=f"Auto-added from threat intel source={source} at {now.isoformat()}",
                            expires_at=valid_until,
                        )
                        session.add(watchlist_entry)
                        auto_actions["watchlist_added"] = {
                            "plate_text": plate_text,
                            "watchlist_id": str(watchlist_entry.id),
                        }
                        logger.info(
                            "threat_intel.auto_watchlist plate=%s source=%s",
                            plate_text,
                            source,
                        )
                    else:
                        auto_actions["watchlist_already_exists"] = {
                            "plate_text": plate_text,
                            "existing_id": str(existing_entry.id),
                        }

                # -- Persist the threat intel entry ----------------------------
                entry = ThreatIntelEntry(
                    id=entry_id,
                    source=source,
                    alert_type=alert_type,
                    details=details,
                    severity=severity,
                    valid_until=valid_until,
                    auto_actions_taken=auto_actions if auto_actions else None,
                )
                session.add(entry)
                await session.commit()
                await session.refresh(entry)

                logger.info(
                    "threat_intel.ingest_webhook id=%s source=%s type=%s severity=%s",
                    entry_id,
                    source,
                    alert_type,
                    severity,
                )
                return entry

            except Exception as exc:
                await session.rollback()
                logger.error("threat_intel.ingest_webhook failed: %s", exc)
                raise

    # ── Active entries ────────────────────────────────────────────

    async def get_active(self) -> list:
        """Get all active (non-expired) threat intelligence entries.

        Returns:
            List of dicts representing currently valid threat intel entries.
        """
        now = datetime.now(timezone.utc)

        async with async_session() as session:
            try:
                stmt = select(ThreatIntelEntry).where(
                    # valid_until is NULL (never expires) or still in the future
                    (ThreatIntelEntry.valid_until.is_(None))
                    | (ThreatIntelEntry.valid_until > now)
                ).order_by(ThreatIntelEntry.created_at.desc())

                result = await session.execute(stmt)
                entries = result.scalars().all()

                active_entries = []
                for entry in entries:
                    active_entries.append({
                        "id": str(entry.id),
                        "source": entry.source,
                        "alert_type": entry.alert_type,
                        "details": entry.details,
                        "severity": entry.severity,
                        "valid_until": entry.valid_until.isoformat() if entry.valid_until else None,
                        "auto_actions_taken": entry.auto_actions_taken,
                        "created_at": entry.created_at.isoformat() if entry.created_at else None,
                    })

                logger.info("threat_intel.get_active count=%d", len(active_entries))
                return active_entries

            except Exception as exc:
                logger.error("threat_intel.get_active failed: %s", exc)
                return []

    # ── Context for agent injection ──────────────────────────────

    async def get_context_for_agents(self) -> str:
        """Get a formatted threat intel summary suitable for agent context injection.

        Produces a concise human-readable block that can be prepended to
        agent system prompts so they are aware of current threats.

        Returns:
            Multi-line string summary of active threat intelligence.
        """
        active = await self.get_active()

        if not active:
            return "THREAT INTELLIGENCE: No active threat advisories."

        lines = [
            f"THREAT INTELLIGENCE ({len(active)} active advisories):",
            "-" * 50,
        ]

        severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
        sorted_entries = sorted(
            active,
            key=lambda e: severity_order.get(e.get("severity", "medium"), 2),
        )

        for entry in sorted_entries:
            severity = entry.get("severity", "medium").upper()
            alert_type = entry.get("alert_type", "unknown")
            source = entry.get("source", "unknown")
            details = entry.get("details") or {}

            summary_parts = [f"[{severity}] {alert_type} (source: {source})"]

            # Extract key details for the summary
            if alert_type == "bolo_vehicle" and details.get("plate"):
                summary_parts.append(f"  Plate: {details['plate']}")
                if details.get("vehicle_description"):
                    summary_parts.append(f"  Vehicle: {details['vehicle_description']}")
                if details.get("reason"):
                    summary_parts.append(f"  Reason: {details['reason']}")
            elif details.get("description"):
                summary_parts.append(f"  {details['description']}")

            if entry.get("valid_until"):
                summary_parts.append(f"  Valid until: {entry['valid_until']}")

            lines.extend(summary_parts)
            lines.append("")

        context = "\n".join(lines)
        logger.debug(
            "threat_intel.get_context_for_agents entries=%d chars=%d",
            len(active),
            len(context),
        )
        return context


# ── Singleton ────────────────────────────────────────────────────

threat_intel = ThreatIntelligence()
