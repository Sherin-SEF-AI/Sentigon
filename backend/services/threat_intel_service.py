"""Threat Intelligence Feed Service — ingestion, context, and threshold adjustments."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, desc, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import async_session

logger = logging.getLogger(__name__)


class ThreatIntelService:
    """Manages external threat intel feeds, ingestion, and agent context."""

    def __init__(self):
        self._polling = False

    async def ingest_entry(
        self,
        entry_data: Dict[str, Any],
        source: str = "manual",
    ) -> Dict[str, Any]:
        """Process and store a new threat intel entry. Auto-execute actions."""
        from backend.models.advanced_models import ThreatIntelEntry, VehicleWatchlist

        async with async_session() as session:
            valid_until = None
            if entry_data.get("valid_until"):
                try:
                    valid_until = datetime.fromisoformat(entry_data["valid_until"])
                except (ValueError, TypeError):
                    pass

            # Default valid_until based on intel_type
            if not valid_until:
                intel_type = entry_data.get("intel_type", "threat")
                ttl_hours = {
                    "weather_warning": 24,
                    "event_calendar": 48,
                    "community_bulletin": 72,
                    "police_alert": 168,  # 7 days
                    "threat": 720,  # 30 days
                }.get(intel_type, 168)
                valid_until = datetime.now(timezone.utc) + timedelta(hours=ttl_hours)

            auto_actions = []

            # Auto-add vehicle plates to watchlist
            plate = (entry_data.get("details") or {}).get("plate")
            if plate and entry_data.get("alert_type") in ("bolo_vehicle", "police_alert"):
                plate = plate.upper().strip()
                existing = (await session.execute(
                    select(VehicleWatchlist).where(VehicleWatchlist.plate_text == plate)
                )).scalar_one_or_none()
                if not existing:
                    wl_entry = VehicleWatchlist(
                        plate_text=plate,
                        reason=f"Threat intel: {source} - {entry_data.get('alert_type', '')}",
                        severity=entry_data.get("severity", "high"),
                        notes=f"Auto-added from threat intel source: {source}",
                        active=True,
                    )
                    session.add(wl_entry)
                    auto_actions.append({"action": "watchlist_add", "plate": plate})

            entry = ThreatIntelEntry(
                source=source,
                alert_type=entry_data.get("alert_type", "general"),
                details=entry_data.get("details"),
                severity=entry_data.get("severity", "medium"),
                valid_until=valid_until,
                auto_actions_taken=auto_actions if auto_actions else None,
                intel_type=entry_data.get("intel_type", "threat"),
                location_context=entry_data.get("location_context"),
                threshold_adjustments=entry_data.get("threshold_adjustments"),
                impact_zones=entry_data.get("impact_zones"),
                priority=entry_data.get("priority", 5),
                source_url=entry_data.get("source_url"),
                processed=False,
            )
            session.add(entry)
            await session.commit()
            await session.refresh(entry)

            return self._fmt_entry(entry)

    async def get_active_context(self) -> Dict[str, Any]:
        """Get all active, non-expired threat intel as context for agents."""
        from backend.models.advanced_models import ThreatIntelEntry

        async with async_session() as session:
            now = datetime.now(timezone.utc)
            result = await session.execute(
                select(ThreatIntelEntry)
                .where(
                    or_(
                        ThreatIntelEntry.valid_until == None,
                        ThreatIntelEntry.valid_until > now,
                    )
                )
                .order_by(ThreatIntelEntry.priority.asc(), desc(ThreatIntelEntry.created_at))
            )
            entries = result.scalars().all()

            threats = []
            weather = []
            events = []
            bulletins = []
            adjustments: Dict[str, Dict[str, float]] = {}

            for e in entries:
                item = self._fmt_entry(e)
                intel_type = e.intel_type or "threat"

                if intel_type == "weather_warning":
                    weather.append(item)
                elif intel_type == "event_calendar":
                    events.append(item)
                elif intel_type == "community_bulletin":
                    bulletins.append(item)
                else:
                    threats.append(item)

                # Aggregate threshold adjustments per zone
                if e.threshold_adjustments and e.impact_zones:
                    zones = e.impact_zones if isinstance(e.impact_zones, list) else []
                    for zone_id in zones:
                        zone_key = str(zone_id)
                        if zone_key not in adjustments:
                            adjustments[zone_key] = {}
                        for k, v in e.threshold_adjustments.items():
                            adjustments[zone_key][k] = adjustments[zone_key].get(k, 0) + v

            return {
                "threats": threats,
                "weather_warnings": weather,
                "nearby_events": events,
                "community_bulletins": bulletins,
                "threshold_adjustments": adjustments,
                "total_active": len(entries),
            }

    async def get_contextual_summary(self) -> str:
        """Generate natural language summary of all active threats for agents."""
        ctx = await self.get_active_context()
        parts = []

        if ctx["threats"]:
            count = len(ctx["threats"])
            critical = sum(1 for t in ctx["threats"] if t.get("severity") == "critical")
            high = sum(1 for t in ctx["threats"] if t.get("severity") == "high")
            parts.append(f"{count} active threats ({critical} critical, {high} high)")
            for t in ctx["threats"][:3]:
                details = t.get("details") or {}
                desc = details.get("description") or t.get("alert_type", "")
                parts.append(f"  - [{t.get('severity','?').upper()}] {desc}")

        if ctx["weather_warnings"]:
            for w in ctx["weather_warnings"]:
                details = w.get("details") or {}
                parts.append(f"Weather: {details.get('description', 'Weather warning active')}")

        if ctx["nearby_events"]:
            for ev in ctx["nearby_events"]:
                details = ev.get("details") or {}
                parts.append(f"Event: {details.get('description', 'Nearby event active')}")
                if ev.get("threshold_adjustments"):
                    adj_parts = [f"{k}: {v:+.0%}" for k, v in ev["threshold_adjustments"].items()]
                    parts.append(f"  Threshold adjustments: {', '.join(adj_parts)}")

        if ctx["threshold_adjustments"]:
            zones_affected = len(ctx["threshold_adjustments"])
            parts.append(f"Threshold adjustments active for {zones_affected} zone(s)")

        if not parts:
            return "No active threat intelligence."

        return "\n".join(parts)

    async def compute_threshold_adjustments(self, zone_id: str) -> Dict[str, float]:
        """Compute recommended threshold adjustments for a zone."""
        ctx = await self.get_active_context()
        return ctx.get("threshold_adjustments", {}).get(zone_id, {})

    async def process_webhook(
        self, feed_id: str, payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Process incoming webhook payload, transform to ThreatIntelEntry."""
        from backend.models.advanced_models import ThreatIntelFeed

        async with async_session() as session:
            feed = (await session.execute(
                select(ThreatIntelFeed).where(
                    ThreatIntelFeed.id == feed_id,
                    ThreatIntelFeed.is_active == True,
                )
            )).scalar_one_or_none()

            if not feed:
                return {"error": "Feed not found or inactive"}

            # Apply transform config if available
            transform = feed.transform_config or {}
            entry_data = {
                "source": feed.name,
                "alert_type": payload.get(transform.get("alert_type_field", "alert_type"), "general"),
                "severity": payload.get(transform.get("severity_field", "severity"), feed.default_severity),
                "details": payload,
                "intel_type": payload.get("intel_type", "threat"),
                "threshold_adjustments": payload.get("threshold_adjustments"),
                "impact_zones": payload.get("impact_zones"),
                "source_url": payload.get("source_url"),
                "valid_until": payload.get("valid_until"),
            }

            result = await self.ingest_entry(entry_data, source=feed.name)

            # Update feed polling status
            feed.last_poll_at = datetime.now(timezone.utc)
            feed.last_poll_status = "success"
            await session.commit()

            return result

    async def get_feeds(self) -> List[Dict[str, Any]]:
        """List all configured feeds."""
        from backend.models.advanced_models import ThreatIntelFeed

        async with async_session() as session:
            result = await session.execute(
                select(ThreatIntelFeed).order_by(desc(ThreatIntelFeed.created_at))
            )
            return [self._fmt_feed(f) for f in result.scalars().all()]

    async def create_feed(self, feed_data: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new feed configuration."""
        from backend.models.advanced_models import ThreatIntelFeed

        async with async_session() as session:
            feed = ThreatIntelFeed(
                name=feed_data["name"],
                feed_type=feed_data.get("feed_type", "webhook_incoming"),
                url=feed_data.get("url"),
                api_key=feed_data.get("api_key"),
                poll_interval_seconds=feed_data.get("poll_interval_seconds", 300),
                transform_config=feed_data.get("transform_config"),
                default_severity=feed_data.get("default_severity", "medium"),
                default_auto_actions=feed_data.get("default_auto_actions"),
                is_active=feed_data.get("is_active", True),
            )
            session.add(feed)
            await session.commit()
            await session.refresh(feed)
            return self._fmt_feed(feed)

    async def update_feed(self, feed_id: str, feed_data: Dict[str, Any]) -> Dict[str, Any]:
        """Update a feed configuration."""
        from backend.models.advanced_models import ThreatIntelFeed

        async with async_session() as session:
            feed = (await session.execute(
                select(ThreatIntelFeed).where(ThreatIntelFeed.id == feed_id)
            )).scalar_one_or_none()
            if not feed:
                return {"error": "Feed not found"}

            for field in ("name", "feed_type", "url", "api_key", "poll_interval_seconds",
                          "transform_config", "default_severity", "default_auto_actions", "is_active"):
                if field in feed_data:
                    setattr(feed, field, feed_data[field])
            await session.commit()
            await session.refresh(feed)
            return self._fmt_feed(feed)

    async def delete_feed(self, feed_id: str) -> bool:
        """Delete a feed."""
        from backend.models.advanced_models import ThreatIntelFeed

        async with async_session() as session:
            feed = (await session.execute(
                select(ThreatIntelFeed).where(ThreatIntelFeed.id == feed_id)
            )).scalar_one_or_none()
            if not feed:
                return False
            await session.delete(feed)
            await session.commit()
            return True

    async def poll_external_feeds(self):
        """Background task: poll configured API feeds for new entries."""
        from backend.models.advanced_models import ThreatIntelFeed

        self._polling = True
        logger.info("Threat intel feed polling started")

        while self._polling:
            try:
                async with async_session() as session:
                    result = await session.execute(
                        select(ThreatIntelFeed).where(
                            ThreatIntelFeed.is_active == True,
                            ThreatIntelFeed.feed_type == "api_poll",
                        )
                    )
                    feeds = result.scalars().all()

                for feed in feeds:
                    now = datetime.now(timezone.utc)
                    last = feed.last_poll_at
                    if last and (now - last).total_seconds() < feed.poll_interval_seconds:
                        continue

                    if feed.url:
                        try:
                            import httpx
                            headers = {}
                            if feed.api_key:
                                headers["Authorization"] = f"Bearer {feed.api_key}"
                            async with httpx.AsyncClient(timeout=30) as client:
                                resp = await client.get(feed.url, headers=headers)
                                resp.raise_for_status()
                                data = resp.json()

                            items = data if isinstance(data, list) else [data]
                            for item in items[:10]:
                                await self.process_webhook(str(feed.id), item)

                            logger.info("threat_intel.poll", feed=feed.name, items=len(items))
                        except Exception as e:
                            logger.warning("threat_intel.poll_error", feed=feed.name, error=str(e))
                            async with async_session() as session:
                                feed_obj = (await session.execute(
                                    select(ThreatIntelFeed).where(ThreatIntelFeed.id == feed.id)
                                )).scalar_one_or_none()
                                if feed_obj:
                                    feed_obj.last_poll_at = now
                                    feed_obj.last_poll_status = f"error: {str(e)[:100]}"
                                    await session.commit()

            except Exception as e:
                logger.error("threat_intel.poll_loop_error", error=str(e))

            await asyncio.sleep(60)

    def _fmt_entry(self, entry) -> Dict[str, Any]:
        return {
            "id": str(entry.id),
            "source": entry.source,
            "alert_type": entry.alert_type,
            "details": entry.details,
            "severity": entry.severity,
            "valid_until": entry.valid_until.isoformat() if entry.valid_until else None,
            "auto_actions_taken": entry.auto_actions_taken,
            "created_at": entry.created_at.isoformat() if entry.created_at else None,
            "intel_type": getattr(entry, "intel_type", None) or "threat",
            "location_context": getattr(entry, "location_context", None),
            "threshold_adjustments": getattr(entry, "threshold_adjustments", None),
            "impact_zones": getattr(entry, "impact_zones", None),
            "priority": getattr(entry, "priority", 5),
            "source_url": getattr(entry, "source_url", None),
            "processed": getattr(entry, "processed", False),
        }

    def _fmt_feed(self, feed) -> Dict[str, Any]:
        return {
            "id": str(feed.id),
            "name": feed.name,
            "feed_type": feed.feed_type,
            "url": feed.url,
            "poll_interval_seconds": feed.poll_interval_seconds,
            "default_severity": feed.default_severity,
            "default_auto_actions": feed.default_auto_actions,
            "is_active": feed.is_active,
            "last_poll_at": feed.last_poll_at.isoformat() if feed.last_poll_at else None,
            "last_poll_status": feed.last_poll_status,
            "created_at": feed.created_at.isoformat() if feed.created_at else None,
        }


# Singleton
threat_intel_service = ThreatIntelService()
