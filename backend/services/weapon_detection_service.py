"""Advanced Weapon Detection Pipeline — Phase 3D.

Combines direct YOLO weapon-class detection with behavioral pre-indicator
analysis from pose keypoints and acoustic correlation from AudioEvents.
Classifies threat posture (detected / holding / brandishing / aiming) by
analysing relative positions of weapon bboxes, person bboxes, and other
people in the scene.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Camera, Zone
from backend.models.advanced_models import AudioEvent
from backend.models.phase3_models import WeaponDetectionEvent
from backend.services.alert_manager import alert_manager

logger = structlog.get_logger()


class WeaponDetectionService:
    """Multi-layered weapon detection: visual + behavioral + acoustic."""

    # YOLO COCO classes that represent weapons
    WEAPON_CLASSES = {"knife", "scissors"}

    # Broader COCO items that become weapons in context
    IMPROVISED_WEAPON_CLASSES = {"baseball bat", "tennis racket", "bottle"}

    BEHAVIORAL_PRE_INDICATORS = {
        "asymmetric_gait": "One arm restricted, other swinging normally",
        "hand_to_waistband": "Repeated hand movement to waistband area",
        "protective_positioning": "Hand guarding one side of body",
        "bulge_indicator": "Unusual protrusion under clothing",
        "nervousness": "Excessive fidgeting, sweating indicators",
        "concealment_check": "Looking down at concealment area repeatedly",
    }

    # Weapon type mapping from COCO class
    _CLASS_TO_WEAPON_TYPE = {
        "knife": "knife",
        "scissors": "edged_weapon",
        "baseball bat": "blunt_weapon",
        "tennis racket": "blunt_weapon",
        "bottle": "improvised",
    }

    # Acoustic event types that correlate with weapons
    _WEAPON_ACOUSTIC_TYPES = {"gunshot", "glass_break", "explosion", "scream"}

    # Minimum confidence to persist an event
    _MIN_PERSIST_CONFIDENCE = 0.40

    def __init__(self) -> None:
        # Per-camera recent pre-indicator history for temporal tracking
        self._pre_indicator_history: Dict[str, Dict[int, List[Dict]]] = defaultdict(
            lambda: defaultdict(list)
        )  # camera_id -> track_id -> [{indicator, timestamp}, ...]
        self._max_indicator_history = 30

    # ── Main analysis entry point ────────────────────────────────

    async def analyze_frame(
        self,
        db: AsyncSession,
        camera_id: str,
        zone_id: str | None,
        detections: list[dict],
        pose_features: dict | None = None,
    ) -> Dict[str, Any] | None:
        """Analyze a frame for weapon threats.

        Returns a weapon event dict when a detection or pre-indicator
        exceeds thresholds, None otherwise.
        """
        now = datetime.now(timezone.utc)

        person_detections = [d for d in detections if d.get("class") == "person"]
        weapon_detections = [
            d for d in detections
            if d.get("class") in self.WEAPON_CLASSES
        ]
        improvised_detections = [
            d for d in detections
            if d.get("class") in self.IMPROVISED_WEAPON_CLASSES
        ]

        all_weapon_dets = weapon_detections + improvised_detections

        # --- Direct weapon detection path ---
        if all_weapon_dets:
            best_det = max(all_weapon_dets, key=lambda d: d.get("confidence", 0))
            weapon_type = self._CLASS_TO_WEAPON_TYPE.get(
                best_det.get("class", ""), "unknown"
            )

            # Classify threat posture
            posture = await self.classify_threat_posture(best_det, detections)

            # Severity mapping
            posture_severity = {
                "detected": "medium",
                "holding": "high",
                "brandishing": "critical",
                "aiming": "critical",
            }
            severity = posture_severity.get(posture, "high")

            # Check acoustic correlation
            acoustic = await self.correlate_acoustic(db, camera_id, now)
            confidence = best_det.get("confidence", 0.5)
            if acoustic:
                confidence = min(confidence + 0.15, 0.99)

            # Persist event
            event = None
            if confidence >= self._MIN_PERSIST_CONFIDENCE:
                event = WeaponDetectionEvent(
                    camera_id=uuid.UUID(str(camera_id)),
                    zone_id=uuid.UUID(str(zone_id)) if zone_id else None,
                    timestamp=now,
                    weapon_type=weapon_type,
                    detection_method="yolo",
                    confidence=round(confidence, 4),
                    threat_posture=posture,
                    posture_confidence=round(confidence, 4),
                    pre_indicators=[],
                    frame_path=None,
                    bounding_box=best_det.get("bbox"),
                    track_id=best_det.get("track_id"),
                    acoustic_correlated=acoustic is not None,
                    audio_event_id=uuid.UUID(acoustic["audio_event_id"]) if acoustic else None,
                    metadata_={
                        "all_weapons_detected": len(all_weapon_dets),
                        "persons_in_scene": len(person_detections),
                    },
                )
                db.add(event)
                await db.flush()

            # Create alert for brandishing/aiming
            if posture in ("brandishing", "aiming") or confidence >= 0.65:
                cam_result = await db.execute(
                    select(Camera.name).where(Camera.id == uuid.UUID(str(camera_id)))
                )
                cam_name = cam_result.scalar_one_or_none() or str(camera_id)[:8]
                zone_name = ""
                if zone_id:
                    zr = await db.execute(
                        select(Zone.name).where(Zone.id == uuid.UUID(str(zone_id)))
                    )
                    zone_name = zr.scalar_one_or_none() or ""

                alert_result = await alert_manager.create_alert(
                    title=f"Weapon detected: {weapon_type} ({posture})",
                    description=(
                        f"{weapon_type.replace('_', ' ').title()} detected with "
                        f"posture '{posture}' at confidence {confidence:.0%}. "
                        f"Persons in scene: {len(person_detections)}."
                    ),
                    severity=severity,
                    threat_type="weapon_detection",
                    source_camera=cam_name,
                    zone_name=zone_name,
                    confidence=round(confidence, 4),
                    metadata={
                        "weapon_type": weapon_type,
                        "posture": posture,
                        "acoustic_correlated": acoustic is not None,
                        "event_id": str(event.id) if event else None,
                    },
                )
                if alert_result and event:
                    event.alert_id = uuid.UUID(alert_result["id"])
                    await db.flush()

            logger.warning(
                "weapon.detected",
                camera_id=str(camera_id)[:8],
                weapon_type=weapon_type,
                posture=posture,
                confidence=round(confidence, 3),
                acoustic=acoustic is not None,
            )

            return {
                "event_type": "weapon_detected",
                "weapon_type": weapon_type,
                "posture": posture,
                "confidence": round(confidence, 4),
                "severity": severity,
                "bbox": best_det.get("bbox"),
                "track_id": best_det.get("track_id"),
                "acoustic_correlated": acoustic is not None,
                "event_id": str(event.id) if event else None,
            }

        # --- No direct weapon detection: check behavioral pre-indicators ---
        if person_detections and pose_features:
            pre_indicators = await self.check_pre_indicators(pose_features)

            if pre_indicators:
                # Build a low-confidence behavioral warning
                indicator_confidence = min(0.25 + len(pre_indicators) * 0.08, 0.55)

                # Check acoustic correlation to escalate
                acoustic = await self.correlate_acoustic(db, camera_id, now)
                if acoustic:
                    indicator_confidence = min(indicator_confidence + 0.20, 0.75)

                if indicator_confidence >= self._MIN_PERSIST_CONFIDENCE:
                    event = WeaponDetectionEvent(
                        camera_id=uuid.UUID(str(camera_id)),
                        zone_id=uuid.UUID(str(zone_id)) if zone_id else None,
                        timestamp=now,
                        weapon_type="unknown",
                        detection_method="behavioral",
                        confidence=round(indicator_confidence, 4),
                        threat_posture="concealed",
                        posture_confidence=round(indicator_confidence * 0.7, 4),
                        pre_indicators=pre_indicators,
                        pre_indicator_duration_seconds=None,
                        bounding_box=person_detections[0].get("bbox"),
                        track_id=person_detections[0].get("track_id"),
                        acoustic_correlated=acoustic is not None,
                        audio_event_id=uuid.UUID(acoustic["audio_event_id"]) if acoustic else None,
                        metadata_={
                            "indicators": pre_indicators,
                            "descriptions": [
                                self.BEHAVIORAL_PRE_INDICATORS.get(pi, pi)
                                for pi in pre_indicators
                            ],
                        },
                    )
                    db.add(event)
                    await db.flush()

                    logger.info(
                        "weapon.pre_indicators",
                        camera_id=str(camera_id)[:8],
                        indicators=pre_indicators,
                        confidence=round(indicator_confidence, 3),
                    )

                    return {
                        "event_type": "weapon_pre_indicator",
                        "pre_indicators": pre_indicators,
                        "confidence": round(indicator_confidence, 4),
                        "severity": "low",
                        "event_id": str(event.id),
                    }

        return None

    # ── Threat posture classification ────────────────────────────

    async def classify_threat_posture(
        self, detection: dict, all_detections: list[dict]
    ) -> str:
        """Classify weapon threat posture from spatial context.

        Returns one of: 'detected', 'holding', 'brandishing', 'aiming'.
        """
        weapon_bbox = detection.get("bbox", [0, 0, 0, 0])
        wx1, wy1, wx2, wy2 = weapon_bbox
        weapon_cx = (wx1 + wx2) / 2
        weapon_cy = (wy1 + wy2) / 2

        person_detections = [d for d in all_detections if d.get("class") == "person"]
        if not person_detections:
            return "detected"

        # Find the closest person to the weapon
        best_person = None
        best_dist = float("inf")
        for p in person_detections:
            pcx, pcy = p.get("center", [0, 0])
            dist = math.sqrt((weapon_cx - pcx) ** 2 + (weapon_cy - pcy) ** 2)
            if dist < best_dist:
                best_dist = dist
                best_person = p

        if not best_person:
            return "detected"

        person_bbox = best_person.get("bbox", [0, 0, 0, 0])
        px1, py1, px2, py2 = person_bbox
        person_h = py2 - py1
        person_w = px2 - px1

        # Check if weapon bbox overlaps with person bbox (holding)
        overlap_x = max(0, min(wx2, px2) - max(wx1, px1))
        overlap_y = max(0, min(wy2, py2) - max(wy1, py1))
        weapon_area = max((wx2 - wx1) * (wy2 - wy1), 1)
        overlap_ratio = (overlap_x * overlap_y) / weapon_area

        if overlap_ratio < 0.1:
            # Weapon not near any person
            return "detected"

        # Weapon center relative to person bbox
        rel_y = (weapon_cy - py1) / max(person_h, 1)  # 0 = top of person, 1 = bottom

        # Check for aiming: weapon pointed toward another person
        other_persons = [d for d in person_detections if d is not best_person]
        if other_persons and rel_y < 0.5:
            # Weapon is in upper body area — check if another person is in line
            for op in other_persons:
                op_cx, op_cy = op.get("center", [0, 0])
                # Weapon center to other person — is the weapon between holder and target?
                dx = op_cx - weapon_cx
                dy = op_cy - weapon_cy
                angle_distance = math.sqrt(dx ** 2 + dy ** 2)
                if angle_distance < person_h * 3:
                    return "aiming"

        # Brandishing: weapon raised above waist (rel_y < 0.45)
        if rel_y < 0.45:
            return "brandishing"

        # Holding: weapon at side / lower body
        if overlap_ratio > 0.2:
            return "holding"

        return "detected"

    # ── Pre-indicator analysis from pose features ────────────────

    async def check_pre_indicators(
        self,
        pose_features: dict,
        track_history: list[dict] | None = None,
    ) -> list[str]:
        """Check behavioral pre-indicators from YOLO pose keypoint analysis.

        Leverages the PoseAnalyzer features already computed by the YOLO
        detector pipeline.
        """
        indicators: list[str] = []

        # --- Asymmetric gait: map from PoseAnalyzer concealed_carry feature ---
        concealed = pose_features.get("concealed_carry")
        if concealed and concealed.get("detected"):
            asymmetry = concealed.get("asymmetry_ratio", 1.0)
            if asymmetry < 0.40:
                indicators.append("asymmetric_gait")

        # --- Hand to waistband: wrist repeatedly near hip ---
        # Detected via PoseAnalyzer or raw keypoint proximity patterns
        pre_assault = pose_features.get("pre_assault")
        if pre_assault and pre_assault.get("detected"):
            indicators.append("hand_to_waistband")

        # --- Protective positioning: one arm guarding torso ---
        if concealed and concealed.get("detected"):
            restricted = concealed.get("restricted_arm")
            if restricted:
                indicators.append("protective_positioning")

        # --- Nervousness: excessive fidgeting from evasive detection ---
        evasive = pose_features.get("evasive")
        if evasive and evasive.get("detected"):
            if evasive.get("confidence", 0) >= 0.5:
                indicators.append("nervousness")

        # --- Concealment check: looking down at concealment area ---
        # Map from target_fixation with downward gaze
        fixation = pose_features.get("target_fixation")
        staking = pose_features.get("staking")
        if fixation and fixation.get("detected") and not staking:
            # Fixed gaze without staking suggests looking at concealment
            indicators.append("concealment_check")

        # --- Blading stance as additional indicator ---
        blading = pose_features.get("blading")
        if blading and blading.get("detected"):
            # Blading is a pre-assault posture but also weapon-relevant
            if blading.get("confidence", 0) >= 0.6:
                indicators.append("protective_positioning")

        # Deduplicate
        return sorted(set(indicators))

    # ── Acoustic correlation ─────────────────────────────────────

    async def correlate_acoustic(
        self,
        db: AsyncSession,
        camera_id: str,
        timestamp: datetime,
        window_seconds: int = 5,
    ) -> Dict[str, Any] | None:
        """Check for weapon-related acoustic events near this timestamp.

        Queries AudioEvent for gunshot, glass_break, explosion, or scream
        within a short time window at the same camera.
        """
        window_start = timestamp - timedelta(seconds=window_seconds)
        window_end = timestamp + timedelta(seconds=window_seconds)

        result = await db.execute(
            select(AudioEvent)
            .where(
                and_(
                    AudioEvent.camera_id == uuid.UUID(str(camera_id)),
                    AudioEvent.timestamp >= window_start,
                    AudioEvent.timestamp <= window_end,
                    AudioEvent.sound_type.in_(list(self._WEAPON_ACOUSTIC_TYPES)),
                )
            )
            .order_by(AudioEvent.confidence.desc())
            .limit(1)
        )
        audio_event = result.scalar_one_or_none()

        if audio_event:
            return {
                "audio_event_id": str(audio_event.id),
                "sound_type": audio_event.sound_type,
                "confidence": audio_event.confidence,
                "timestamp": audio_event.timestamp.isoformat() if audio_event.timestamp else None,
            }
        return None

    # ── Query endpoints ──────────────────────────────────────────

    async def get_weapon_events(
        self,
        db: AsyncSession,
        hours: int = 24,
        severity: str | None = None,
    ) -> list[dict]:
        """Get recent weapon detection events."""
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

        query = select(WeaponDetectionEvent).where(
            WeaponDetectionEvent.timestamp >= cutoff
        )

        if severity:
            # Map severity to confidence/posture ranges
            severity_postures = {
                "critical": ["brandishing", "aiming"],
                "high": ["holding", "brandishing", "aiming"],
                "medium": ["detected", "holding"],
                "low": ["concealed"],
            }
            postures = severity_postures.get(severity, [])
            if postures:
                query = query.where(
                    WeaponDetectionEvent.threat_posture.in_(postures)
                )

        query = query.order_by(WeaponDetectionEvent.timestamp.desc()).limit(200)
        result = await db.execute(query)
        events = result.scalars().all()

        return [
            {
                "id": str(e.id),
                "camera_id": str(e.camera_id),
                "zone_id": str(e.zone_id) if e.zone_id else None,
                "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                "weapon_type": e.weapon_type,
                "detection_method": e.detection_method,
                "confidence": e.confidence,
                "threat_posture": e.threat_posture,
                "pre_indicators": e.pre_indicators or [],
                "acoustic_correlated": e.acoustic_correlated,
                "track_id": e.track_id,
                "bounding_box": e.bounding_box,
            }
            for e in events
        ]

    async def get_stats(self, db: AsyncSession) -> dict:
        """Get weapon detection statistics."""
        cutoff_24h = datetime.now(timezone.utc) - timedelta(hours=24)
        cutoff_7d = datetime.now(timezone.utc) - timedelta(days=7)

        # Total events in 24h
        r24 = await db.execute(
            select(func.count(WeaponDetectionEvent.id)).where(
                WeaponDetectionEvent.timestamp >= cutoff_24h
            )
        )
        total_24h = r24.scalar() or 0

        # Total events in 7d
        r7d = await db.execute(
            select(func.count(WeaponDetectionEvent.id)).where(
                WeaponDetectionEvent.timestamp >= cutoff_7d
            )
        )
        total_7d = r7d.scalar() or 0

        # By weapon type (7d)
        rtype = await db.execute(
            select(
                WeaponDetectionEvent.weapon_type,
                func.count(WeaponDetectionEvent.id),
            )
            .where(WeaponDetectionEvent.timestamp >= cutoff_7d)
            .group_by(WeaponDetectionEvent.weapon_type)
        )
        by_type = {row[0]: row[1] for row in rtype.all()}

        # By posture (7d)
        rposture = await db.execute(
            select(
                WeaponDetectionEvent.threat_posture,
                func.count(WeaponDetectionEvent.id),
            )
            .where(WeaponDetectionEvent.timestamp >= cutoff_7d)
            .group_by(WeaponDetectionEvent.threat_posture)
        )
        by_posture = {row[0]: row[1] for row in rposture.all()}

        # By detection method (7d)
        rmethod = await db.execute(
            select(
                WeaponDetectionEvent.detection_method,
                func.count(WeaponDetectionEvent.id),
            )
            .where(WeaponDetectionEvent.timestamp >= cutoff_7d)
            .group_by(WeaponDetectionEvent.detection_method)
        )
        by_method = {row[0]: row[1] for row in rmethod.all()}

        # Acoustic correlation rate
        racoustic = await db.execute(
            select(func.count(WeaponDetectionEvent.id)).where(
                and_(
                    WeaponDetectionEvent.timestamp >= cutoff_7d,
                    WeaponDetectionEvent.acoustic_correlated == True,  # noqa: E712
                )
            )
        )
        acoustic_count = racoustic.scalar() or 0

        return {
            "total_events_24h": total_24h,
            "total_events_7d": total_7d,
            "by_weapon_type": by_type,
            "by_posture": by_posture,
            "by_detection_method": by_method,
            "acoustic_correlation_count": acoustic_count,
            "acoustic_correlation_rate": round(
                acoustic_count / max(total_7d, 1), 4
            ),
        }


# Singleton
weapon_detection_service = WeaponDetectionService()
