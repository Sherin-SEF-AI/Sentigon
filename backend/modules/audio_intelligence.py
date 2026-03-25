"""Audio Intelligence engine — threat detection using Gemini 3 Flash native audio understanding.

Analyzes real-time audio chunks from camera microphones to detect security-relevant
sounds (gunshots, glass breaking, screaming, etc.), correlates audio events with
concurrent video frames, and persists results to both PostgreSQL and Qdrant.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func, desc

from backend.config import settings
from backend.database import async_session
from backend.models.advanced_models import AudioEvent
from backend.modules.gemini_client import (
    analyze_audio_flash,
    analyze_frame_flash,
    generate_embedding,
)
from backend.services.vector_store import vector_store

logger = logging.getLogger(__name__)


class AudioIntelligence:
    """Audio threat detection using Gemini 3 Flash native audio understanding.

    Provides end-to-end audio analysis: classification of security-relevant sounds,
    cross-modal correlation with video frames, persistent storage with semantic
    search capability, and aggregate statistics.
    """

    # ── Prompts & Schemas ────────────────────────────────────

    AUDIO_CLASSIFICATION_PROMPT = """Classify any security-relevant sounds in this audio clip.
Categories by severity:
- CRITICAL: gunshot, explosion
- HIGH: glass_breaking, screaming, aggressive_shouting, vehicle_crash
- MEDIUM: alarm_siren, door_forced, running_footsteps, vehicle_horn_sustained
- LOW: raised_voices, dog_barking, unusual_metallic_sounds
- AMBIENT: normal_conversation, traffic, wind, rain, silence

For each detected sound, provide the type, confidence, approximate timestamp within the clip, whether it's security-relevant, and severity level."""

    AUDIO_SCHEMA: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "detected_sounds": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "sound_type": {"type": "string"},
                        "confidence": {"type": "number"},
                        "timestamp_seconds": {"type": "number"},
                        "security_relevant": {"type": "boolean"},
                        "severity": {
                            "type": "string",
                            "enum": ["none", "low", "medium", "high", "critical"],
                        },
                    },
                    "required": [
                        "sound_type",
                        "confidence",
                        "security_relevant",
                        "severity",
                    ],
                },
            },
            "ambient_noise_level": {"type": "string"},
            "overall_audio_threat": {
                "type": "string",
                "enum": ["none", "low", "medium", "high", "critical"],
            },
        },
        "required": [
            "detected_sounds",
            "ambient_noise_level",
            "overall_audio_threat",
        ],
    }

    CORRELATION_PROMPT = (
        "Audio detected {sound_type} at confidence {confidence}. "
        "Analyze this concurrent video frame — is the visual evidence "
        "consistent with the audio event? What is happening?"
    )

    CORRELATION_SCHEMA: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "visual_confirmation": {"type": "boolean"},
            "visual_description": {"type": "string"},
            "correlation_confidence": {"type": "number"},
            "recommended_action": {"type": "string"},
            "threat_assessment": {
                "type": "string",
                "enum": ["none", "low", "medium", "high", "critical"],
            },
        },
        "required": [
            "visual_confirmation",
            "visual_description",
            "correlation_confidence",
            "threat_assessment",
        ],
    }

    # Minimum confidence threshold for security-relevant sound detections
    CONFIDENCE_THRESHOLD = 0.7

    def __init__(self) -> None:
        self._total_chunks_analyzed: int = 0
        self._total_threats_detected: int = 0
        self._total_correlations: int = 0

    # ── Audio Analysis ───────────────────────────────────────

    async def analyze_audio_chunk(
        self,
        audio_bytes: bytes,
        camera_id: str,
        duration_seconds: float = 5.0,
        mime_type: str = "audio/wav",
    ) -> Dict[str, Any]:
        """Analyze a 5-second audio chunk using Gemini 3 Flash.

        Parameters
        ----------
        audio_bytes : bytes
            Raw audio data (WAV, MP3, or OGG).
        camera_id : str
            Identifier of the source camera/microphone.
        duration_seconds : float
            Duration of the audio clip in seconds.
        mime_type : str
            MIME type of the audio data.

        Returns
        -------
        dict with keys: detected_sounds (filtered), ambient_noise_level,
        overall_audio_threat, camera_id, duration_seconds, analyzed_at.
        """
        try:
            raw_result = await analyze_audio_flash(
                audio_bytes=audio_bytes,
                prompt=self.AUDIO_CLASSIFICATION_PROMPT,
                mime_type=mime_type,
                json_schema=self.AUDIO_SCHEMA,
            )

            self._total_chunks_analyzed += 1

            # Extract detected sounds, defaulting to empty list
            all_sounds = raw_result.get("detected_sounds", [])

            # Filter for security-relevant sounds above confidence threshold
            security_sounds = [
                sound
                for sound in all_sounds
                if sound.get("security_relevant", False)
                and float(sound.get("confidence", 0.0)) >= self.CONFIDENCE_THRESHOLD
            ]

            if security_sounds:
                self._total_threats_detected += len(security_sounds)
                logger.info(
                    "audio_intelligence.threat_detected camera=%s sounds=%d types=%s",
                    camera_id,
                    len(security_sounds),
                    [s.get("sound_type") for s in security_sounds],
                )

            result = {
                "detected_sounds": security_sounds,
                "all_sounds": all_sounds,
                "ambient_noise_level": raw_result.get("ambient_noise_level", "unknown"),
                "overall_audio_threat": raw_result.get("overall_audio_threat", "none"),
                "camera_id": camera_id,
                "duration_seconds": duration_seconds,
                "analyzed_at": datetime.now(timezone.utc).isoformat(),
            }

            return result

        except Exception as exc:
            logger.error(
                "audio_intelligence.analyze_chunk_failed camera=%s error=%s",
                camera_id,
                exc,
            )
            return {
                "detected_sounds": [],
                "all_sounds": [],
                "ambient_noise_level": "unknown",
                "overall_audio_threat": "none",
                "camera_id": camera_id,
                "duration_seconds": duration_seconds,
                "error": str(exc),
                "analyzed_at": datetime.now(timezone.utc).isoformat(),
            }

    # ── Audio-Visual Correlation ─────────────────────────────

    async def correlate_audio_visual(
        self,
        sound_type: str,
        confidence: float,
        frame_bytes: bytes,
        camera_id: str,
    ) -> Dict[str, Any]:
        """Cross-reference an audio event with a concurrent video frame.

        Sends the video frame to Gemini 3 Flash along with a prompt that
        describes the detected audio event, asking the model whether the
        visual evidence is consistent.

        Parameters
        ----------
        sound_type : str
            Classified sound type (e.g. "gunshot", "glass_breaking").
        confidence : float
            Audio classification confidence (0.0-1.0).
        frame_bytes : bytes
            JPEG-encoded video frame captured at the time of the audio event.
        camera_id : str
            Source camera identifier.

        Returns
        -------
        dict containing visual_confirmation, visual_description,
        correlation_confidence, recommended_action, and threat_assessment.
        """
        try:
            prompt = self.CORRELATION_PROMPT.format(
                sound_type=sound_type,
                confidence=f"{confidence:.2f}",
            )

            result = await analyze_frame_flash(
                frame_bytes=frame_bytes,
                prompt=prompt,
                json_schema=self.CORRELATION_SCHEMA,
                thinking_level="medium",
            )

            self._total_correlations += 1

            # Augment result with source metadata
            result["camera_id"] = camera_id
            result["audio_sound_type"] = sound_type
            result["audio_confidence"] = confidence
            result["correlated_at"] = datetime.now(timezone.utc).isoformat()

            confirmed = result.get("visual_confirmation", False)
            logger.info(
                "audio_intelligence.correlation camera=%s sound=%s visual_confirmed=%s threat=%s",
                camera_id,
                sound_type,
                confirmed,
                result.get("threat_assessment", "unknown"),
            )

            return result

        except Exception as exc:
            logger.error(
                "audio_intelligence.correlation_failed camera=%s sound=%s error=%s",
                camera_id,
                sound_type,
                exc,
            )
            return {
                "visual_confirmation": False,
                "visual_description": f"Correlation failed: {exc}",
                "correlation_confidence": 0.0,
                "recommended_action": "Manual review required",
                "threat_assessment": "none",
                "camera_id": camera_id,
                "audio_sound_type": sound_type,
                "audio_confidence": confidence,
                "error": str(exc),
                "correlated_at": datetime.now(timezone.utc).isoformat(),
            }

    # ── Database Persistence ─────────────────────────────────

    async def store_audio_event(
        self,
        analysis: Dict[str, Any],
        camera_id: str,
        audio_clip_path: Optional[str] = None,
        duration: float = 5.0,
    ) -> Optional[AudioEvent]:
        """Store detected audio events in PostgreSQL and Qdrant.

        Creates one AudioEvent row for each security-relevant sound in the
        analysis result.  Also embeds a textual description in the Qdrant
        ``audio_events`` collection for semantic search.

        Parameters
        ----------
        analysis : dict
            Output from :meth:`analyze_audio_chunk`.
        camera_id : str
            Source camera identifier.
        audio_clip_path : str, optional
            Filesystem path to the saved audio clip.
        duration : float
            Duration of the audio clip in seconds.

        Returns
        -------
        The first stored AudioEvent, or ``None`` if nothing was stored.
        """
        detected_sounds = analysis.get("detected_sounds", [])
        if not detected_sounds:
            return None

        first_event: Optional[AudioEvent] = None

        try:
            async with async_session() as session:
                for sound in detected_sounds:
                    sound_type = sound.get("sound_type", "unknown")
                    confidence = sound.get("confidence", 0.0)
                    severity = sound.get("severity", "low")

                    # Build Gemini analysis summary for the record
                    gemini_summary = json.dumps({
                        "sound_type": sound_type,
                        "confidence": confidence,
                        "severity": severity,
                        "timestamp_seconds": sound.get("timestamp_seconds"),
                        "ambient_noise_level": analysis.get("ambient_noise_level"),
                        "overall_audio_threat": analysis.get("overall_audio_threat"),
                    })

                    audio_event = AudioEvent(
                        camera_id=uuid.UUID(camera_id) if isinstance(camera_id, str) else camera_id,
                        duration_seconds=duration,
                        sound_type=sound_type,
                        confidence=confidence,
                        severity=severity,
                        audio_clip_path=audio_clip_path,
                        gemini_analysis=gemini_summary,
                    )

                    session.add(audio_event)
                    await session.flush()

                    if first_event is None:
                        first_event = audio_event

                    # Embed description in Qdrant for semantic search
                    description = (
                        f"{severity.upper()} audio event: {sound_type} "
                        f"detected at confidence {confidence:.2f} "
                        f"on camera {camera_id}"
                    )

                    await vector_store.upsert_event(
                        event_id=str(audio_event.id),
                        description=description,
                        metadata={
                            "camera_id": camera_id,
                            "sound_type": sound_type,
                            "confidence": confidence,
                            "severity": severity,
                            "duration_seconds": duration,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "source": "audio_intelligence",
                        },
                        collection="audio_events",
                    )

                    logger.info(
                        "audio_intelligence.event_stored id=%s camera=%s sound=%s severity=%s",
                        audio_event.id,
                        camera_id,
                        sound_type,
                        severity,
                    )

                await session.commit()

        except Exception as exc:
            logger.error(
                "audio_intelligence.store_event_failed camera=%s error=%s",
                camera_id,
                exc,
            )
            return None

        return first_event

    # ── Query ────────────────────────────────────────────────

    async def get_events(
        self,
        camera_id: Optional[str] = None,
        sound_type: Optional[str] = None,
        severity: Optional[str] = None,
        since: Optional[datetime] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Retrieve audio events with optional filters.

        Parameters
        ----------
        camera_id : str, optional
            Filter by source camera.
        sound_type : str, optional
            Filter by classified sound type.
        severity : str, optional
            Filter by severity level.
        since : datetime, optional
            Only return events after this timestamp.
        limit : int
            Maximum number of records to return.

        Returns
        -------
        List of serialised AudioEvent dicts, ordered by timestamp descending.
        """
        try:
            async with async_session() as session:
                stmt = select(AudioEvent).order_by(desc(AudioEvent.timestamp))

                if camera_id:
                    stmt = stmt.where(
                        AudioEvent.camera_id == uuid.UUID(camera_id)
                    )
                if sound_type:
                    stmt = stmt.where(AudioEvent.sound_type == sound_type)
                if severity:
                    stmt = stmt.where(AudioEvent.severity == severity)
                if since:
                    stmt = stmt.where(AudioEvent.timestamp >= since)

                stmt = stmt.limit(limit)

                result = await session.execute(stmt)
                events = result.scalars().all()

                return [
                    {
                        "id": str(ev.id),
                        "camera_id": str(ev.camera_id),
                        "timestamp": ev.timestamp.isoformat() if ev.timestamp else None,
                        "duration_seconds": ev.duration_seconds,
                        "sound_type": ev.sound_type,
                        "confidence": ev.confidence,
                        "severity": ev.severity,
                        "audio_clip_path": ev.audio_clip_path,
                        "correlated_event_id": str(ev.correlated_event_id) if ev.correlated_event_id else None,
                        "gemini_analysis": ev.gemini_analysis,
                        "created_at": ev.created_at.isoformat() if ev.created_at else None,
                    }
                    for ev in events
                ]

        except Exception as exc:
            logger.error("audio_intelligence.get_events_failed error=%s", exc)
            return []

    # ── Semantic Search ──────────────────────────────────────

    async def search_similar_events(
        self,
        query: str,
        top_k: int = 10,
        camera_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Semantic search over audio events in Qdrant.

        Parameters
        ----------
        query : str
            Natural-language search query (e.g. "gunshot near building A").
        top_k : int
            Maximum number of results.
        camera_id : str, optional
            Filter results to a specific camera.

        Returns
        -------
        List of matching event payloads with similarity scores.
        """
        try:
            filters = {}
            if camera_id:
                filters["camera_id"] = camera_id

            results = await vector_store.search(
                query=query,
                top_k=top_k,
                filters=filters if filters else None,
                collection="audio_events",
            )

            return results

        except Exception as exc:
            logger.error("audio_intelligence.search_failed error=%s", exc)
            return []

    # ── Statistics ────────────────────────────────────────────

    async def get_stats(self) -> Dict[str, Any]:
        """Aggregate audio intelligence statistics.

        Returns
        -------
        dict with total event counts, severity breakdown, recent activity,
        and runtime counters.
        """
        try:
            async with async_session() as session:
                # Total audio events
                total_stmt = select(func.count(AudioEvent.id))
                total_result = await session.execute(total_stmt)
                total_events = total_result.scalar() or 0

                # Events by severity
                severity_stmt = (
                    select(AudioEvent.severity, func.count(AudioEvent.id))
                    .group_by(AudioEvent.severity)
                )
                severity_result = await session.execute(severity_stmt)
                severity_breakdown = {
                    row[0]: row[1] for row in severity_result.all()
                }

                # Events by sound type (top 10)
                type_stmt = (
                    select(AudioEvent.sound_type, func.count(AudioEvent.id))
                    .group_by(AudioEvent.sound_type)
                    .order_by(desc(func.count(AudioEvent.id)))
                    .limit(10)
                )
                type_result = await session.execute(type_stmt)
                sound_type_breakdown = {
                    row[0]: row[1] for row in type_result.all()
                }

                # Events in the last hour
                one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
                recent_stmt = select(func.count(AudioEvent.id)).where(
                    AudioEvent.timestamp >= one_hour_ago
                )
                recent_result = await session.execute(recent_stmt)
                events_last_hour = recent_result.scalar() or 0

                # Events in the last 24 hours
                one_day_ago = datetime.now(timezone.utc) - timedelta(hours=24)
                daily_stmt = select(func.count(AudioEvent.id)).where(
                    AudioEvent.timestamp >= one_day_ago
                )
                daily_result = await session.execute(daily_stmt)
                events_last_24h = daily_result.scalar() or 0

                # Distinct cameras with audio events
                camera_stmt = select(
                    func.count(func.distinct(AudioEvent.camera_id))
                )
                camera_result = await session.execute(camera_stmt)
                active_cameras = camera_result.scalar() or 0

            return {
                "total_events": total_events,
                "events_last_hour": events_last_hour,
                "events_last_24h": events_last_24h,
                "active_cameras": active_cameras,
                "severity_breakdown": severity_breakdown,
                "sound_type_breakdown": sound_type_breakdown,
                "runtime": {
                    "chunks_analyzed": self._total_chunks_analyzed,
                    "threats_detected": self._total_threats_detected,
                    "correlations_performed": self._total_correlations,
                },
            }

        except Exception as exc:
            logger.error("audio_intelligence.get_stats_failed error=%s", exc)
            return {
                "total_events": 0,
                "events_last_hour": 0,
                "events_last_24h": 0,
                "active_cameras": 0,
                "severity_breakdown": {},
                "sound_type_breakdown": {},
                "runtime": {
                    "chunks_analyzed": self._total_chunks_analyzed,
                    "threats_detected": self._total_threats_detected,
                    "correlations_performed": self._total_correlations,
                },
                "error": str(exc),
            }


# Singleton
audio_intelligence = AudioIntelligence()
