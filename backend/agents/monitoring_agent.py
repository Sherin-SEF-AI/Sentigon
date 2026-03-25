"""Continuous monitoring agent — the main real-time analysis pipeline."""

from __future__ import annotations

import asyncio
import base64
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import async_session
from backend.models import Camera, Event, Zone
from backend.models.models import AlertSeverity, CameraStatus
from backend.services.video_capture import capture_manager
from backend.services.yolo_detector import yolo_detector
from backend.services.gemini_analyzer import gemini_analyzer
from backend.services.threat_engine import threat_engine
from backend.services.alert_manager import alert_manager
from backend.services.vector_store import vector_store
from backend.services.notification_service import notification_service

# Phase 3 — Context-Aware Intelligence imports (all optional)
_phase3_available = True
try:
    from backend.services.context_fusion_engine import context_fusion_engine
    from backend.services.baseline_learning_service import baseline_learning_service
    from backend.services.intent_classifier import intent_classifier
    from backend.services.feedback_tuning_service import feedback_tuning_service
    from backend.services.entity_tracker_service import entity_tracker_service
    from backend.services.weapon_detection_service import weapon_detection_service
    from backend.services.safety_detection_service import safety_detection_service
    from backend.services.nl_alert_rules_service import nl_alert_rules_service
    from backend.services.alarm_correlation_engine import alarm_correlation_engine
except ImportError:
    _phase3_available = False

logger = logging.getLogger(__name__)

# AI vision is expensive; only invoke it every N frames per camera.
_AI_EVERY_N_FRAMES = 15
# Minimum seconds between full pipeline runs for a single camera.
_MIN_INTERVAL_SECONDS = 1.0


class MonitoringAgent:
    """Orchestrates the real-time security monitoring pipeline.

    For every active camera the pipeline is:
    1. Grab the latest frame from the capture manager.
    2. Run YOLO detection (always).
    3. Optionally run Gemini Flash scene analysis (rate-limited).
    4. Evaluate threats via the hybrid threat engine.
    5. Create alerts for detected threats.
    6. Index the event in the vector store for later search.
    7. Push frames, detections, and alerts over WebSocket.
    """

    def __init__(self) -> None:
        self._running: bool = False
        self._frame_counters: Dict[str, int] = {}
        self._last_run: Dict[str, float] = {}
        self._cycle_count: int = 0

    # ------------------------------------------------------------------ #
    #  Single-frame pipeline                                              #
    # ------------------------------------------------------------------ #

    async def process_frame(
        self,
        camera_id: str,
        zone_info: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Run the full analysis pipeline on the latest frame of a camera.

        Returns a dict summarising detections, analysis, and any alerts
        created, or *None* if the camera had no frame available.
        """
        stream = capture_manager.get_stream(camera_id)
        if stream is None or not stream.is_running:
            return None

        latest = stream.get_latest_frame()
        if latest is None:
            return None

        timestamp_epoch, frame = latest
        ts = datetime.fromtimestamp(timestamp_epoch, tz=timezone.utc)

        # ── 1. YOLO detection ─────────────────────────────────────
        detections = yolo_detector.detect(frame, camera_id=camera_id)

        # ── 2. Optional Gemini Flash analysis ─────────────────────
        counter = self._frame_counters.get(camera_id, 0) + 1
        self._frame_counters[camera_id] = counter

        gemini_result: Optional[Dict[str, Any]] = None
        if counter % _AI_EVERY_N_FRAMES == 0:
            gemini_result = await gemini_analyzer.analyze_frame(
                frame, detections=detections, camera_id=camera_id,
            )

        # ── 3. Threat evaluation ──────────────────────────────────
        threats = threat_engine.evaluate_hybrid(
            detections, gemini_result, zone_info,
        )

        # ── 3b. Phase 3: Context-Aware Re-scoring ──────────────────
        if _phase3_available:
            try:
                zone_id_str = zone_info.get("id") if zone_info else None
                zone_id_uuid = uuid.UUID(zone_id_str) if zone_id_str else None
                cam_uuid = uuid.UUID(camera_id)

                async with async_session() as db:
                    # Context fusion: re-score threats through 4 dimensions
                    if threats:
                        threats = await context_fusion_engine.evaluate_context(
                            db, cam_uuid, zone_id_uuid, detections, threats, ts,
                        )

                    # Feedback-driven suppression: remove threats that should be suppressed
                    if threats:
                        filtered = []
                        for thr in threats:
                            sig_name = thr.get("signature", "")
                            if await feedback_tuning_service.should_suppress(db, camera_id, sig_name):
                                logger.debug("Suppressed FP: %s on %s", sig_name, camera_id)
                                continue
                            # Apply adjusted threshold
                            adj_threshold = await feedback_tuning_service.get_adjusted_threshold(
                                db, camera_id, sig_name,
                            )
                            if thr.get("confidence", 0) < adj_threshold:
                                logger.debug("Below adjusted threshold: %s (%.2f < %.2f)",
                                             sig_name, thr.get("confidence", 0), adj_threshold)
                                continue
                            filtered.append(thr)
                        threats = filtered

                    # Baseline learning: record current observation
                    person_count = detections.get("person_count", 0) if isinstance(detections, dict) else 0
                    vehicle_count = detections.get("vehicle_count", 0) if isinstance(detections, dict) else 0
                    await baseline_learning_service.record_observation(
                        db, cam_uuid, zone_id_uuid,
                        person_count=person_count,
                        vehicle_count=vehicle_count,
                        movement_intensity=len(detections.get("objects", [])) if isinstance(detections, dict) else 0,
                        dwell_time=max((o.get("dwell_time", 0) for o in detections.get("objects", [{}])), default=0) if isinstance(detections, dict) else 0,
                    )

                    # Entity tracking: process each person detection
                    if isinstance(detections, dict):
                        for obj in detections.get("objects", []):
                            if obj.get("class") == "person" and obj.get("track_id") is not None:
                                entity_result = await entity_tracker_service.process_detection(
                                    db, camera_id, zone_id_str, obj.get("track_id"), obj,
                                )
                                if entity_result and entity_result.get("alert_needed"):
                                    threats.append({
                                        "signature": entity_result.get("alert_type", "reconnaissance"),
                                        "description": entity_result.get("description", "Suspicious entity behavior detected"),
                                        "severity": "high",
                                        "confidence": entity_result.get("risk_score", 0.7),
                                        "detection_method": "entity_tracking",
                                    })

                    # Weapon detection
                    pose_feats = None
                    if isinstance(detections, dict):
                        for obj in detections.get("objects", []):
                            if obj.get("pose_features"):
                                pose_feats = obj["pose_features"]
                                break
                    weapon_result = await weapon_detection_service.analyze_frame(
                        db, camera_id, zone_id_str, detections, pose_features=pose_feats,
                    )
                    if weapon_result:
                        threats.append({
                            "signature": f"weapon_{weapon_result.get('weapon_type', 'detected')}",
                            "description": f"Weapon detected: {weapon_result.get('weapon_type')} ({weapon_result.get('threat_posture', 'detected')})",
                            "severity": "critical",
                            "confidence": weapon_result.get("confidence", 0.8),
                            "detection_method": "weapon_detection",
                        })

                    # Safety detection
                    safety_events = await safety_detection_service.analyze_frame(
                        db, camera_id, zone_id_str, detections, gemini_analysis=gemini_result,
                    )
                    for se in safety_events:
                        threats.append({
                            "signature": f"safety_{se.get('event_type', 'unknown')}",
                            "description": se.get("description", "Safety event detected"),
                            "severity": se.get("severity", "high"),
                            "confidence": se.get("confidence", 0.7),
                            "detection_method": "safety_detection",
                        })

                    # NL Alert Rules evaluation
                    zone_type = zone_info.get("zone_type", "general") if zone_info else "general"
                    triggered_rules = await nl_alert_rules_service.evaluate_rules(
                        db, camera_id, zone_id_str, zone_type, detections, ts,
                    )
                    for rule in triggered_rules:
                        threats.append({
                            "signature": f"nl_rule_{rule.get('rule_name', 'custom')}",
                            "description": rule.get("description", "Custom alert rule triggered"),
                            "severity": rule.get("severity", "medium"),
                            "confidence": 0.95,
                            "detection_method": "nl_alert_rule",
                        })

            except Exception as exc:
                logger.debug("Phase 3 context processing error: %s", exc)

        # ── 4. Create alerts for significant threats ──────────────
        created_alerts: List[Dict[str, Any]] = []
        event_id: Optional[str] = None

        if threats:
            event_id = await self._persist_event(
                camera_id, ts, detections, gemini_result, threats,
                zone_info=zone_info,
            )

            for thr in threats:
                severity = thr.get("severity", "medium")
                # Only create alerts for medium and above
                if severity in ("critical", "high", "medium"):
                    alert_data = await alert_manager.create_alert(
                        title=thr.get("signature", "Threat Detected"),
                        description=thr.get("description", ""),
                        severity=severity,
                        threat_type=thr.get("signature", ""),
                        source_camera=camera_id,
                        zone_name=(
                            zone_info.get("name", "") if zone_info else ""
                        ),
                        confidence=thr.get("confidence", 0.0),
                        event_id=event_id,
                    )
                    if alert_data is not None:
                        created_alerts.append(alert_data)

        # ── 5. Index event in vector store ────────────────────────
        if event_id:
            description_parts = [
                thr.get("description", "") for thr in threats
            ]
            description_text = "; ".join(filter(None, description_parts))
            await vector_store.upsert_event(
                event_id=event_id,
                description=description_text or f"Detection on camera {camera_id}",
                metadata={
                    "camera_id": camera_id,
                    "event_type": threats[0].get("signature", "detection") if threats else "detection",
                    "timestamp": ts.isoformat(),
                    "severity": threats[0].get("severity", "info") if threats else "info",
                },
            )

        # ── 6. Push to WebSocket subscribers ──────────────────────
        try:
            jpeg = stream.encode_jpeg(quality=50)
            if jpeg:
                frame_b64 = base64.b64encode(jpeg).decode("utf-8")
                await notification_service.push_frame(
                    camera_id, frame_b64, detections,
                )
        except Exception as exc:
            logger.debug("WebSocket frame push failed: %s", exc)

        for alert_data in created_alerts:
            try:
                await notification_service.push_alert(alert_data)
            except Exception as exc:
                logger.debug("WebSocket alert push failed: %s", exc)

        return {
            "camera_id": camera_id,
            "timestamp": ts.isoformat(),
            "detections": detections,
            "gemini_analysis": gemini_result,
            "threats": threats,
            "alerts_created": len(created_alerts),
            "event_id": event_id,
        }

    # ------------------------------------------------------------------ #
    #  Continuous monitoring loop                                         #
    # ------------------------------------------------------------------ #

    async def start_monitoring(self) -> None:
        """Async loop that continuously processes all active cameras.

        The loop runs until ``stop_monitoring()`` is called.  Each
        iteration walks every camera whose stream is active and
        invokes ``process_frame``.
        """
        self._running = True
        logger.info("Monitoring agent started")

        while self._running:
            try:
                cameras = await self._get_active_cameras()

                for cam in cameras:
                    cam_id = str(cam.id)
                    now = time.time()
                    last = self._last_run.get(cam_id, 0)
                    if now - last < _MIN_INTERVAL_SECONDS:
                        continue
                    self._last_run[cam_id] = now

                    zone_info = await self._get_zone_info(cam.zone_id)

                    try:
                        await self.process_frame(cam_id, zone_info)
                    except Exception as exc:
                        logger.error(
                            "Pipeline error for camera %s: %s",
                            cam_id, exc,
                        )

                self._cycle_count += 1

                # Yield control so other coroutines can run
                await asyncio.sleep(0.05)

            except asyncio.CancelledError:
                logger.info("Monitoring loop cancelled")
                break
            except Exception as exc:
                logger.exception("Monitoring loop error: %s", exc)
                await asyncio.sleep(1.0)

        logger.info("Monitoring agent stopped after %d cycles", self._cycle_count)

    def stop_monitoring(self) -> None:
        """Signal the monitoring loop to exit gracefully."""
        self._running = False
        logger.info("Monitoring stop requested")

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def stats(self) -> Dict[str, Any]:
        return {
            "running": self._running,
            "cycle_count": self._cycle_count,
            "cameras_tracked": len(self._frame_counters),
            "frame_counters": dict(self._frame_counters),
        }

    # ------------------------------------------------------------------ #
    #  Database helpers                                                   #
    # ------------------------------------------------------------------ #

    async def _get_active_cameras(self) -> List[Camera]:
        """Return cameras that are both active and online."""
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(Camera).where(
                        Camera.is_active.is_(True),
                        Camera.status == CameraStatus.ONLINE,
                    )
                )
                return list(result.scalars().all())
        except Exception as exc:
            logger.error("Failed to fetch active cameras: %s", exc)
            return []

    async def _get_zone_info(
        self,
        zone_id: Optional[uuid.UUID],
    ) -> Optional[Dict[str, Any]]:
        """Load zone metadata for threat condition checks."""
        if zone_id is None:
            return None
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(Zone).where(Zone.id == zone_id)
                )
                zone = result.scalar_one_or_none()
                if zone is None:
                    return None
                return {
                    "id": str(zone.id),
                    "name": zone.name,
                    "zone_type": zone.zone_type,
                    "max_occupancy": zone.max_occupancy,
                    "alert_on_breach": zone.alert_on_breach,
                }
        except Exception as exc:
            logger.debug("Zone lookup failed for %s: %s", zone_id, exc)
            return None

    async def _persist_event(
        self,
        camera_id: str,
        timestamp: datetime,
        detections: Dict[str, Any],
        gemini_analysis: Optional[Dict[str, Any]],
        threats: List[Dict[str, Any]],
        zone_info: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        """Write an Event row and return its UUID as a string."""
        try:
            top_threat = threats[0] if threats else {}
            severity_str = top_threat.get("severity", "info")
            try:
                severity = AlertSeverity(severity_str)
            except ValueError:
                severity = AlertSeverity.INFO

            async with async_session() as session:
                event = Event(
                    camera_id=uuid.UUID(camera_id),
                    zone_id=(
                        uuid.UUID(zone_info["id"])
                        if zone_info and zone_info.get("id")
                        else None
                    ),
                    event_type=top_threat.get("signature", "detection"),
                    description=top_threat.get("description", ""),
                    severity=severity,
                    confidence=top_threat.get("confidence", 0.0),
                    detections=detections,
                    gemini_analysis=gemini_analysis,
                    metadata_={
                        "threats": threats,
                        "camera_id": camera_id,
                    },
                    timestamp=timestamp,
                )
                session.add(event)
                await session.commit()
                await session.refresh(event)
                return str(event.id)
        except Exception as exc:
            logger.error("Failed to persist event: %s", exc)
            return None


# Singleton
monitoring_agent = MonitoringAgent()
