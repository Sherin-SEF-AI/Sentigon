"""SOC Copilot — conversational AI security analyst using Gemini 3 Pro.

Natural Language SOC Copilot for SENTINEL AI.  Provides a conversational
interface backed by Gemini 3 Pro with direct tool access to the security
platform's databases, vector store, and live system telemetry.

Operators can ask questions in plain English and the copilot will
automatically invoke the correct internal tools, aggregate data, and
return contextual answers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func

from backend.config import settings
from backend.database import async_session
from backend.models.advanced_models import CopilotConversation
from backend.models.models import (
    Alert,
    AlertSeverity,
    AlertStatus,
    Camera,
    CameraStatus,
    Event,
    Zone,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# System prompt injected at the start of every Gemini conversation turn.
# Placeholders are filled with live telemetry before each request.
# ---------------------------------------------------------------------------

COPILOT_SYSTEM_PROMPT = """\
You are SENTINEL Copilot, an AI security analyst assistant embedded in the \
SENTINEL AI physical security platform. You have direct access to all \
security system capabilities through your tools.

Your role:
- Answer operator questions about current security status, historical \
events, and trends
- Execute searches, investigations, and analyses on demand
- Generate reports and summaries
- Proactively suggest actions based on context
- Explain agent decisions and system behaviour

When answering questions:
- ALWAYS use your tools to get real data — never guess or assume
- For "what's happening now" questions: use get_system_status, \
get_active_alerts
- For "what happened" questions: use get_event_history, search_events
- For "find me" questions: use search_events, search_vehicles
- For "generate report" requests: use get_threat_statistics
- For "compare" or "trend" questions: use get_threat_statistics

Guidelines:
- Be concise but thorough.  Always cite camera IDs and timestamps.
- If you are unsure, say so — never fabricate data.
- When presenting lists, use markdown tables.
- When asked for a report, provide a structured markdown document.

Current time: {current_time}
Active cameras: {camera_count}
Active alerts: {alert_count}
"""

# Maximum number of messages retained in a single copilot session before
# the oldest entries are pruned to stay within the Gemini context window.
_MAX_HISTORY_MESSAGES = 100

# Maximum number of in-memory sessions before least-recently-used cleanup.
_MAX_SESSIONS = 200


class SOCCopilot:
    """Conversational AI copilot for security operations.

    Maintains per-session message history in memory and persists
    conversation metadata to the ``copilot_conversations`` table.
    Each inbound message is forwarded to Gemini 3 Pro with a set
    of callable tool functions that give the model live access to
    system data.
    """

    def __init__(self) -> None:
        self._sessions: Dict[str, List[Dict[str, str]]] = {}
        # Track last-access time for LRU eviction
        self._session_access: Dict[str, datetime] = {}

    # ------------------------------------------------------------------
    # Tool functions — callable by Gemini during generation
    # ------------------------------------------------------------------

    async def get_system_status(self) -> dict:
        """Get current system status including cameras, alerts, and agent health."""
        async with async_session() as session:
            total_cameras = (
                await session.execute(select(func.count(Camera.id)))
            ).scalar() or 0

            online_cameras = (
                await session.execute(
                    select(func.count(Camera.id)).where(
                        Camera.status == CameraStatus.ONLINE
                    )
                )
            ).scalar() or 0

            active_alerts = (
                await session.execute(
                    select(func.count(Alert.id)).where(
                        Alert.status.in_([
                            AlertStatus.NEW,
                            AlertStatus.ACKNOWLEDGED,
                            AlertStatus.INVESTIGATING,
                        ])
                    )
                )
            ).scalar() or 0

            critical_alerts = (
                await session.execute(
                    select(func.count(Alert.id)).where(
                        Alert.status.in_([
                            AlertStatus.NEW,
                            AlertStatus.ACKNOWLEDGED,
                            AlertStatus.INVESTIGATING,
                        ]),
                        Alert.severity == AlertSeverity.CRITICAL,
                    )
                )
            ).scalar() or 0

            events_last_hour = (
                await session.execute(
                    select(func.count(Event.id)).where(
                        Event.timestamp >= datetime.now(timezone.utc) - timedelta(hours=1)
                    )
                )
            ).scalar() or 0

            events_last_24h = (
                await session.execute(
                    select(func.count(Event.id)).where(
                        Event.timestamp >= datetime.now(timezone.utc) - timedelta(hours=24)
                    )
                )
            ).scalar() or 0

            return {
                "total_cameras": total_cameras,
                "online_cameras": online_cameras,
                "active_alerts": active_alerts,
                "critical_alerts": critical_alerts,
                "events_last_hour": events_last_hour,
                "events_last_24h": events_last_24h,
                "system_status": "operational",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

    async def get_active_alerts(self, limit: int = 20) -> list:
        """Get current active (new / acknowledged / investigating) alerts."""
        async with async_session() as session:
            result = await session.execute(
                select(Alert)
                .where(
                    Alert.status.in_([
                        AlertStatus.NEW,
                        AlertStatus.ACKNOWLEDGED,
                        AlertStatus.INVESTIGATING,
                    ])
                )
                .order_by(Alert.created_at.desc())
                .limit(limit)
            )
            alerts = result.scalars().all()
            return [
                {
                    "id": str(a.id),
                    "title": a.title,
                    "severity": a.severity.value if a.severity else "unknown",
                    "status": a.status.value if a.status else "unknown",
                    "threat_type": a.threat_type,
                    "camera": a.source_camera,
                    "zone": a.zone_name,
                    "confidence": a.confidence,
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                    "description": a.description,
                }
                for a in alerts
            ]

    async def get_event_history(
        self,
        hours: int = 24,
        event_type: Optional[str] = None,
        limit: int = 50,
    ) -> list:
        """Get recent event history, optionally filtered by type."""
        async with async_session() as session:
            query = select(Event).where(
                Event.timestamp >= datetime.now(timezone.utc) - timedelta(hours=hours)
            )
            if event_type:
                query = query.where(Event.event_type == event_type)
            query = query.order_by(Event.timestamp.desc()).limit(limit)

            result = await session.execute(query)
            events = result.scalars().all()
            return [
                {
                    "id": str(e.id),
                    "type": e.event_type,
                    "description": e.description,
                    "severity": e.severity.value if e.severity else "info",
                    "camera_id": str(e.camera_id) if e.camera_id else None,
                    "zone_id": str(e.zone_id) if e.zone_id else None,
                    "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                    "confidence": e.confidence,
                }
                for e in events
            ]

    async def search_events(self, query: str, top_k: int = 10) -> list:
        """Semantic search across security events using the Qdrant vector store."""
        try:
            from backend.services.vector_store import vector_store
            results = await vector_store.search(query, top_k=top_k)
            return results
        except Exception as exc:
            logger.warning("Vector search unavailable: %s", exc)
            return [{"error": f"Vector search unavailable: {exc}"}]

    async def search_vehicles(
        self,
        plate_text: Optional[str] = None,
        hours: int = 24,
        limit: int = 20,
    ) -> list:
        """Search vehicle sightings by plate text or time window."""
        try:
            from backend.models.advanced_models import VehicleSighting

            async with async_session() as session:
                query = select(VehicleSighting).where(
                    VehicleSighting.timestamp
                    >= datetime.now(timezone.utc) - timedelta(hours=hours)
                )
                if plate_text:
                    query = query.where(
                        VehicleSighting.plate_text.ilike(f"%{plate_text}%")
                    )
                query = query.order_by(VehicleSighting.timestamp.desc()).limit(limit)

                result = await session.execute(query)
                sightings = result.scalars().all()
                return [
                    {
                        "id": str(v.id),
                        "plate_text": v.plate_text,
                        "plate_confidence": v.plate_confidence,
                        "vehicle_color": v.vehicle_color,
                        "vehicle_type": v.vehicle_type,
                        "vehicle_make": v.vehicle_make,
                        "vehicle_model": v.vehicle_model,
                        "camera_id": str(v.camera_id),
                        "timestamp": v.timestamp.isoformat() if v.timestamp else None,
                    }
                    for v in sightings
                ]
        except Exception as exc:
            logger.warning("Vehicle search failed: %s", exc)
            return [{"error": f"Vehicle search unavailable: {exc}"}]

    async def get_threat_statistics(self, hours: int = 24) -> dict:
        """Get threat statistics and severity breakdown for a time period."""
        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

            total_events = (
                await session.execute(
                    select(func.count(Event.id)).where(Event.timestamp >= cutoff)
                )
            ).scalar() or 0

            total_alerts = (
                await session.execute(
                    select(func.count(Alert.id)).where(Alert.created_at >= cutoff)
                )
            ).scalar() or 0

            resolved_alerts = (
                await session.execute(
                    select(func.count(Alert.id)).where(
                        Alert.created_at >= cutoff,
                        Alert.status == AlertStatus.RESOLVED,
                    )
                )
            ).scalar() or 0

            # Severity breakdown
            severity_counts: Dict[str, int] = {}
            for sev in AlertSeverity:
                count = (
                    await session.execute(
                        select(func.count(Alert.id)).where(
                            Alert.created_at >= cutoff,
                            Alert.severity == sev,
                        )
                    )
                ).scalar() or 0
                severity_counts[sev.value] = count

            # Event type breakdown (top 10)
            event_type_rows = (
                await session.execute(
                    select(Event.event_type, func.count(Event.id).label("cnt"))
                    .where(Event.timestamp >= cutoff)
                    .group_by(Event.event_type)
                    .order_by(func.count(Event.id).desc())
                    .limit(10)
                )
            ).all()
            event_type_breakdown = {row[0]: row[1] for row in event_type_rows}

            return {
                "period_hours": hours,
                "total_events": total_events,
                "total_alerts": total_alerts,
                "resolved_alerts": resolved_alerts,
                "open_alerts": total_alerts - resolved_alerts,
                "severity_breakdown": severity_counts,
                "event_type_breakdown": event_type_breakdown,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

    async def get_zone_status(self) -> list:
        """Get status of all active zones including occupancy."""
        async with async_session() as session:
            result = await session.execute(
                select(Zone).where(Zone.is_active == True)  # noqa: E712
            )
            zones = result.scalars().all()
            zone_list = []
            for z in zones:
                # Count cameras per zone
                cam_count = (
                    await session.execute(
                        select(func.count(Camera.id)).where(Camera.zone_id == z.id)
                    )
                ).scalar() or 0

                # Count recent events per zone (last hour)
                event_count = (
                    await session.execute(
                        select(func.count(Event.id)).where(
                            Event.zone_id == z.id,
                            Event.timestamp
                            >= datetime.now(timezone.utc) - timedelta(hours=1),
                        )
                    )
                ).scalar() or 0

                zone_list.append(
                    {
                        "id": str(z.id),
                        "name": z.name,
                        "type": z.zone_type,
                        "occupancy": z.current_occupancy,
                        "max_occupancy": z.max_occupancy,
                        "camera_count": cam_count,
                        "events_last_hour": event_count,
                        "alert_on_breach": z.alert_on_breach,
                    }
                )
            return zone_list

    async def get_camera_details(self, camera_id: Optional[str] = None) -> list:
        """Get details about cameras.  If *camera_id* is supplied only that
        camera is returned; otherwise all cameras are listed."""
        async with async_session() as session:
            query = select(Camera)
            if camera_id:
                try:
                    uid = uuid.UUID(camera_id)
                    query = query.where(Camera.id == uid)
                except ValueError:
                    # Try matching by name instead
                    query = query.where(Camera.name.ilike(f"%{camera_id}%"))
            query = query.order_by(Camera.name)
            result = await session.execute(query)
            cameras = result.scalars().all()
            return [
                {
                    "id": str(c.id),
                    "name": c.name,
                    "location": c.location,
                    "status": c.status.value if c.status else "unknown",
                    "fps": c.fps,
                    "resolution": c.resolution,
                    "zone_id": str(c.zone_id) if c.zone_id else None,
                    "is_active": c.is_active,
                }
                for c in cameras
            ]

    # ------------------------------------------------------------------
    # Core message processing
    # ------------------------------------------------------------------

    async def process_message(
        self,
        session_id: str,
        user_message: str,
        operator_id: Optional[str] = None,
    ) -> dict:
        """Process a copilot message using Ollama reasoning tier.

        Args:
            session_id: Unique conversation session identifier.
            user_message: The operator's natural-language message.
            operator_id: Optional UUID of the authenticated operator.

        Returns:
            Dict with ``response``, ``tool_calls``, ``session_id``, and
            optional ``error`` flag.
        """
        from backend.services.ollama_provider import ollama_generate_text

        # Build live system context for the system prompt
        try:
            system_status = await self.get_system_status()
        except Exception:
            logger.warning("Could not fetch system status for copilot context")
            system_status = {
                "total_cameras": "N/A",
                "active_alerts": "N/A",
            }

        system_prompt = COPILOT_SYSTEM_PROMPT.format(
            current_time=datetime.now(timezone.utc).isoformat(),
            camera_count=system_status.get("total_cameras", "N/A"),
            alert_count=system_status.get("active_alerts", "N/A"),
        )

        # -- Session management -------------------------------------------
        self._touch_session(session_id)

        if session_id not in self._sessions:
            self._sessions[session_id] = []

        history = self._sessions[session_id]
        history.append({"role": "user", "content": user_message})

        if len(history) > _MAX_HISTORY_MESSAGES:
            history[:] = history[-_MAX_HISTORY_MESSAGES:]

        # -- Build conversation text for Ollama ----------------------------
        messages_text = system_prompt + "\n\n"
        for msg in history:
            role = msg["role"].upper()
            messages_text += f"{role}: {msg['content']}\n\n"
        messages_text += "ASSISTANT:"

        try:
            response_text = await ollama_generate_text(
                messages_text,
                system_prompt=system_prompt,
                temperature=0.3,
                max_tokens=4096,
                tier="reasoning",
            )

            if not response_text.strip():
                response_text = "I wasn't able to process that request. Could you rephrase?"

            history.append({"role": "assistant", "content": response_text})
            await self._update_conversation(session_id, operator_id)

            logger.info(
                "copilot.response session=%s provider=ollama length=%d",
                session_id, len(response_text),
            )

            return {
                "response": response_text,
                "tool_calls": [],
                "session_id": session_id,
                "ai_provider": "ollama",
            }

        except Exception as exc:
            logger.error("Copilot Ollama failed for session %s: %s", session_id, exc)
            error_msg = f"AI provider failed: {exc}"
            history.append({"role": "assistant", "content": error_msg})
            return {
                "response": error_msg,
                "tool_calls": [],
                "session_id": session_id,
                "error": True,
            }

    # ------------------------------------------------------------------
    # Conversation persistence
    # ------------------------------------------------------------------

    async def _update_conversation(
        self,
        session_id: str,
        operator_id: Optional[str] = None,
    ) -> None:
        """Create or update the ``CopilotConversation`` row for this session."""
        try:
            async with async_session() as db:
                result = await db.execute(
                    select(CopilotConversation).where(
                        CopilotConversation.session_id == session_id
                    )
                )
                conv = result.scalar_one_or_none()

                now = datetime.now(timezone.utc)

                if conv:
                    conv.last_message_at = now
                    conv.message_count = len(
                        self._sessions.get(session_id, [])
                    )
                elif operator_id:
                    conv = CopilotConversation(
                        operator_id=(
                            uuid.UUID(operator_id)
                            if isinstance(operator_id, str)
                            else operator_id
                        ),
                        session_id=session_id,
                        last_message_at=now,
                        message_count=len(
                            self._sessions.get(session_id, [])
                        ),
                    )
                    db.add(conv)

                await db.commit()
        except Exception as exc:
            logger.warning(
                "Failed to update conversation record for %s: %s",
                session_id,
                exc,
            )

    # ------------------------------------------------------------------
    # Session management helpers
    # ------------------------------------------------------------------

    def _touch_session(self, session_id: str) -> None:
        """Mark a session as recently accessed and evict stale ones."""
        self._session_access[session_id] = datetime.now(timezone.utc)

        if len(self._sessions) > _MAX_SESSIONS:
            # Evict the least-recently-used sessions
            sorted_sessions = sorted(
                self._session_access.items(), key=lambda kv: kv[1]
            )
            to_evict = len(self._sessions) - _MAX_SESSIONS + 10  # headroom
            for sid, _ in sorted_sessions[:to_evict]:
                self._sessions.pop(sid, None)
                self._session_access.pop(sid, None)
            logger.info("copilot.session.evict count=%d", to_evict)

    async def get_history(self, session_id: str) -> List[Dict[str, str]]:
        """Return the in-memory conversation history for *session_id*."""
        return list(self._sessions.get(session_id, []))

    async def clear_session(self, session_id: str) -> None:
        """Remove a conversation session from memory."""
        self._sessions.pop(session_id, None)
        self._session_access.pop(session_id, None)
        logger.info("copilot.session.clear session=%s", session_id)

    async def list_sessions(self) -> List[Dict[str, Any]]:
        """Return metadata for all active in-memory sessions."""
        sessions = []
        for sid, messages in self._sessions.items():
            last_access = self._session_access.get(sid)
            sessions.append(
                {
                    "session_id": sid,
                    "message_count": len(messages),
                    "last_access": (
                        last_access.isoformat() if last_access else None
                    ),
                }
            )
        return sessions

    # ------------------------------------------------------------------
    # Contextual suggested prompts
    # ------------------------------------------------------------------

    async def get_suggested_prompts(self) -> List[Dict[str, str]]:
        """Return contextual prompt suggestions based on live system state.

        The UI can display these as quick-action buttons to help operators
        start conversations faster.
        """
        try:
            status = await self.get_system_status()
        except Exception:
            status = {"active_alerts": 0, "critical_alerts": 0}

        prompts: List[Dict[str, str]] = []

        # Urgent prompts first
        critical = status.get("critical_alerts", 0)
        if critical and critical > 0:
            prompts.append(
                {
                    "text": f"Investigate the {critical} critical alert(s)",
                    "category": "critical",
                }
            )

        active = status.get("active_alerts", 0)
        if active and active > 0:
            prompts.append(
                {
                    "text": f"Summarize the {active} active alerts",
                    "category": "alerts",
                }
            )

        # General prompts
        prompts.extend(
            [
                {
                    "text": "Summarize the last hour of activity",
                    "category": "overview",
                },
                {
                    "text": "What's the current threat level?",
                    "category": "status",
                },
                {
                    "text": "Show me all camera zones and their status",
                    "category": "zones",
                },
                {
                    "text": "Generate a shift handoff report",
                    "category": "report",
                },
                {
                    "text": "Compare threat activity: last 4 hours vs previous 4 hours",
                    "category": "trends",
                },
                {
                    "text": "List all offline cameras",
                    "category": "maintenance",
                },
            ]
        )

        return prompts


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

soc_copilot = SOCCopilot()
