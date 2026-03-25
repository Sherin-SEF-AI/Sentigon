"""Phase 3B: Smart Alarm Correlation Engine.

Multi-sensor fusion, PACS-video cross-correlation, cascade rule matching,
and operator fatigue tracking for intelligent alarm management.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select, func, and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Alert, Event, Camera, AlertStatus
from backend.models.phase2_models import AccessEvent
from backend.models.phase3_models import (
    AlarmCorrelationEvent,
    AlarmFatigueMetric,
)

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_CORRELATION_WINDOW_SECONDS = 30
_FATIGUE_PERIOD_HOURS = 1
_FATIGUE_HIGH_RESPONSE_THRESHOLD = 120  # seconds — slow response indicator
_FATIGUE_MAX_SCORE = 1.0

# Sensor-type to Event.event_type substring mapping for DB lookups
_SENSOR_EVENT_MAP: Dict[str, List[str]] = {
    "motion_sensor": ["motion", "movement"],
    "camera": ["person", "vehicle", "detection", "object", "weapon", "intrusion"],
    "door_contact": ["door", "forced", "held_open", "contact"],
    "alarm_panel": ["alarm", "panic", "tamper", "fire_alarm"],
    "pacs": ["granted", "denied", "forced", "tailgating", "held_open"],
    "smoke_detector": ["smoke", "fire"],
    "thermal_sensor": ["thermal", "heat", "temperature"],
}


class AlarmCorrelationEngine:
    """Multi-sensor alarm correlation with cascade-rule matching."""

    CASCADE_RULES: Dict[str, Dict[str, Any]] = {
        "perimeter_breach": {
            "expected": ["motion_sensor", "camera", "door_contact"],
            "min_match": 2,
        },
        "forced_entry": {
            "expected": ["door_contact", "camera", "alarm_panel"],
            "min_match": 2,
        },
        "tailgating": {
            "expected": ["pacs", "camera"],
            "min_match": 2,
        },
        "fire": {
            "expected": ["smoke_detector", "camera", "thermal_sensor"],
            "min_match": 1,
        },
        "unauthorized_access": {
            "expected": ["pacs", "camera"],
            "min_match": 2,
        },
    }

    # ------------------------------------------------------------------
    # Main correlation entry point
    # ------------------------------------------------------------------

    async def correlate_alarm(
        self,
        db: AsyncSession,
        source_type: str,
        source_id: str,
        event_data: Dict[str, Any],
        camera_id: Optional[str] = None,
        zone_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Correlate an incoming alarm with other sensor data in a time window.

        1. Query recent events from other sensors in the same zone (last 30 s).
        2. Check cascade rules for the inferred alarm category.
        3. Compute a fusion score.
        4. Classify as real_threat / false_alarm / equipment_fault / authorized_activity.
        5. If classified false_alarm with high confidence, auto-clear.
        6. Persist an AlarmCorrelationEvent row.
        """
        now = datetime.now(timezone.utc)
        window_start = now - timedelta(seconds=_CORRELATION_WINDOW_SECONDS)
        alarm_category = event_data.get("alarm_category") or self._infer_category(
            source_type, event_data
        )

        # --- 1. Gather correlated evidence from the DB ---
        correlated_sources: List[Dict[str, Any]] = []
        triggered_sensor_types: set[str] = {source_type}

        # Query recent Events in the same zone / camera neighbourhood
        conditions = [Event.timestamp >= window_start, Event.timestamp <= now]
        if zone_id:
            conditions.append(Event.zone_id == uuid.UUID(zone_id))
        elif camera_id:
            conditions.append(Event.camera_id == uuid.UUID(camera_id))

        result = await db.execute(
            select(Event).where(and_(*conditions)).order_by(Event.timestamp.desc()).limit(50)
        )
        recent_events = result.scalars().all()

        for evt in recent_events:
            matched_type = self._classify_sensor_type(evt.event_type)
            if matched_type and matched_type != source_type:
                triggered_sensor_types.add(matched_type)
                correlated_sources.append(
                    {
                        "type": matched_type,
                        "id": str(evt.camera_id),
                        "event_id": str(evt.id),
                        "timestamp": evt.timestamp.isoformat() if evt.timestamp else None,
                        "signal": evt.event_type,
                        "confidence": evt.confidence,
                    }
                )

        # Also query AccessEvents (PACS) in the same window
        pacs_conditions = [AccessEvent.timestamp >= window_start, AccessEvent.timestamp <= now]
        if camera_id:
            pacs_conditions.append(AccessEvent.camera_id == camera_id)
        pacs_result = await db.execute(
            select(AccessEvent).where(and_(*pacs_conditions)).limit(20)
        )
        pacs_events = pacs_result.scalars().all()
        for pacs_evt in pacs_events:
            triggered_sensor_types.add("pacs")
            correlated_sources.append(
                {
                    "type": "pacs",
                    "id": pacs_evt.door_id or "",
                    "event_id": str(pacs_evt.id),
                    "timestamp": pacs_evt.timestamp.isoformat() if pacs_evt.timestamp else None,
                    "signal": pacs_evt.event_type,
                }
            )

        # --- 2. Check cascade rules ---
        rule = self.CASCADE_RULES.get(alarm_category)
        expected_sensors = rule["expected"] if rule else [source_type]
        min_match = rule["min_match"] if rule else 1
        triggered_list = [s for s in expected_sensors if s in triggered_sensor_types]
        cascade_matched = len(triggered_list) >= min_match

        # --- 3. Compute fusion score ---
        fusion_score = await self.compute_fusion_score(
            triggered_sensors=list(triggered_sensor_types),
            expected_sensors=expected_sensors,
        )

        # --- 4. Classification ---
        classification = self._classify_alarm(
            fusion_score=fusion_score,
            cascade_matched=cascade_matched,
            triggered_count=len(triggered_sensor_types),
            expected_count=len(expected_sensors),
            pacs_events=pacs_events,
            event_data=event_data,
        )

        # --- 5. Auto-clear if false_alarm with high confidence ---
        auto_cleared = False
        clear_reason: Optional[str] = None
        if classification == "false_alarm" and fusion_score < 0.25:
            auto_cleared = True
            clear_reason = (
                f"Auto-cleared: only {len(triggered_sensor_types)}/{len(expected_sensors)} "
                f"sensors triggered (fusion={fusion_score:.2f}). "
                f"Category: {alarm_category}."
            )

        # --- 6. Persist AlarmCorrelationEvent ---
        correlation = AlarmCorrelationEvent(
            source_type=source_type,
            source_id=source_id,
            source_event_id=uuid.UUID(event_data["event_id"]) if event_data.get("event_id") else None,
            correlated_sources=correlated_sources,
            fusion_score=round(fusion_score, 4),
            sensors_expected=len(expected_sensors),
            sensors_triggered=len(triggered_sensor_types),
            cascade_match=cascade_matched,
            classification=classification,
            auto_cleared=auto_cleared,
            clear_reason=clear_reason,
            zone_id=uuid.UUID(zone_id) if zone_id else None,
            camera_id=uuid.UUID(camera_id) if camera_id else None,
            metadata_={"alarm_category": alarm_category, "event_data": event_data},
        )
        db.add(correlation)
        await db.flush()
        correlation_id = str(correlation.id)

        # If auto-cleared, persist that state
        if auto_cleared:
            await self.auto_clear_alarm(db, correlation_id, clear_reason or "auto-cleared")

        await db.commit()

        logger.info(
            "alarm.correlated",
            correlation_id=correlation_id,
            classification=classification,
            fusion_score=round(fusion_score, 4),
            sensors=f"{len(triggered_sensor_types)}/{len(expected_sensors)}",
            auto_cleared=auto_cleared,
        )

        return {
            "correlation_id": correlation_id,
            "classification": classification,
            "fusion_score": round(fusion_score, 4),
            "auto_cleared": auto_cleared,
            "evidence": correlated_sources,
            "sensors_triggered": len(triggered_sensor_types),
            "sensors_expected": len(expected_sensors),
            "cascade_matched": cascade_matched,
            "alarm_category": alarm_category,
        }

    # ------------------------------------------------------------------
    # PACS-Video auto-correlation
    # ------------------------------------------------------------------

    async def correlate_pacs_with_video(
        self,
        db: AsyncSession,
        access_event_id: str,
        door_id: str,
        camera_id: str,
    ) -> Dict[str, Any]:
        """Cross-correlate a PACS alarm with video analytics.

        1. Fetch the AccessEvent.
        2. Query recent Events for person detections on that camera.
        3. Derive person count to detect tailgating.
        4. Classify the combined signal.
        """
        # Fetch PACS event
        pacs_result = await db.execute(
            select(AccessEvent).where(AccessEvent.id == uuid.UUID(access_event_id))
        )
        pacs_event = pacs_result.scalar_one_or_none()
        if not pacs_event:
            logger.warning("pacs_correlation.event_not_found", access_event_id=access_event_id)
            return {
                "classification": "unknown",
                "person_count": 0,
                "tailgating_detected": False,
                "confidence": 0.0,
            }

        access_type = pacs_event.event_type  # granted / denied / forced / held_open / tailgating
        event_time = pacs_event.timestamp or datetime.now(timezone.utc)
        if event_time.tzinfo is None:
            event_time = event_time.replace(tzinfo=timezone.utc)

        window_start = event_time - timedelta(seconds=15)
        window_end = event_time + timedelta(seconds=15)

        # Query video events on that camera around the access event time
        video_result = await db.execute(
            select(Event).where(
                and_(
                    Event.camera_id == uuid.UUID(camera_id),
                    Event.timestamp >= window_start,
                    Event.timestamp <= window_end,
                )
            ).order_by(Event.timestamp.desc()).limit(30)
        )
        video_events = video_result.scalars().all()

        # Count persons detected across video frames
        person_count = 0
        max_persons_in_frame = 0
        for ve in video_events:
            detections = ve.detections or {}
            detected_objects = detections.get("objects", detections.get("detections", []))
            if isinstance(detected_objects, list):
                frame_persons = sum(
                    1 for d in detected_objects
                    if isinstance(d, dict) and d.get("class", "").lower() in ("person", "people")
                )
            elif isinstance(detected_objects, int):
                frame_persons = detected_objects
            else:
                frame_persons = 0
            max_persons_in_frame = max(max_persons_in_frame, frame_persons)
            person_count = max(person_count, frame_persons)

        # Check for person count in metadata fallback
        for ve in video_events:
            meta = ve.metadata_ or {}
            pc = meta.get("person_count", 0)
            if isinstance(pc, (int, float)) and pc > person_count:
                person_count = int(pc)

        tailgating_detected = person_count > 1
        has_video_evidence = len(video_events) > 0

        # Classification logic
        if access_type == "granted" and person_count <= 1:
            classification = "authorized_activity"
            confidence = 0.92
        elif access_type == "granted" and tailgating_detected:
            classification = "tailgating"
            confidence = min(0.60 + (person_count - 1) * 0.12, 0.95)
        elif access_type == "denied" and person_count >= 1 and has_video_evidence:
            classification = "real_threat"
            confidence = 0.80
        elif access_type in ("forced", "forced_open"):
            classification = "real_threat"
            confidence = 0.90 if has_video_evidence else 0.70
        elif access_type == "tailgating":
            classification = "tailgating"
            confidence = 0.85 if tailgating_detected else 0.55
        elif access_type == "held_open":
            classification = "policy_violation" if has_video_evidence else "equipment_fault"
            confidence = 0.65
        elif access_type == "denied" and person_count == 0 and not has_video_evidence:
            classification = "false_alarm"
            confidence = 0.75
        else:
            classification = "unclassified"
            confidence = 0.40

        logger.info(
            "pacs_video.correlated",
            access_event_id=access_event_id,
            access_type=access_type,
            person_count=person_count,
            tailgating=tailgating_detected,
            classification=classification,
        )

        return {
            "classification": classification,
            "person_count": person_count,
            "tailgating_detected": tailgating_detected,
            "confidence": round(confidence, 4),
            "access_type": access_type,
            "video_events_found": len(video_events),
        }

    # ------------------------------------------------------------------
    # Multi-sensor fusion scoring
    # ------------------------------------------------------------------

    async def compute_fusion_score(
        self,
        triggered_sensors: List[str],
        expected_sensors: List[str],
    ) -> float:
        """Multi-sensor fusion scoring.

        Base score = |triggered intersection expected| / |expected|.
        Bonus of 0.10 for each additional triggered sensor beyond minimum.
        Penalty of 0.15 for each missing expected sensor.
        Clamped to [0.0, 1.0].
        """
        if not expected_sensors:
            return 0.5  # no expectations, neutral score

        expected_set = set(expected_sensors)
        triggered_set = set(triggered_sensors)

        matched = expected_set & triggered_set
        missing = expected_set - triggered_set
        extra = triggered_set - expected_set

        base_score = len(matched) / len(expected_set)

        # Bonus for extra corroborating sensors
        bonus = len(extra) * 0.10

        # Penalty for missing expected sensors
        penalty = len(missing) * 0.15

        # Temporal proximity bonus — if multiple sensors fired, they are within
        # the 30-second window by construction, so grant a small boost when 3+ fire
        if len(triggered_set) >= 3:
            bonus += 0.08

        score = base_score + bonus - penalty
        return max(0.0, min(score, 1.0))

    # ------------------------------------------------------------------
    # Auto-clear
    # ------------------------------------------------------------------

    async def auto_clear_alarm(
        self,
        db: AsyncSession,
        alarm_correlation_id: str,
        reason: str,
    ) -> bool:
        """Auto-clear a non-actionable alarm.

        Updates the AlarmCorrelationEvent row to set auto_cleared=True and
        records the clear reason.
        """
        try:
            result = await db.execute(
                select(AlarmCorrelationEvent).where(
                    AlarmCorrelationEvent.id == uuid.UUID(alarm_correlation_id)
                )
            )
            correlation = result.scalar_one_or_none()
            if not correlation:
                logger.warning("auto_clear.not_found", correlation_id=alarm_correlation_id)
                return False

            correlation.auto_cleared = True
            correlation.clear_reason = reason
            correlation.classification = "false_alarm"

            # Also dismiss any linked alert
            if correlation.alert_id:
                await db.execute(
                    update(Alert)
                    .where(Alert.id == correlation.alert_id)
                    .values(
                        status=AlertStatus.DISMISSED,
                        resolution_notes=f"Auto-cleared by correlation engine: {reason}",
                    )
                )

            await db.flush()
            logger.info(
                "alarm.auto_cleared",
                correlation_id=alarm_correlation_id,
                reason=reason,
            )
            return True

        except Exception:
            logger.exception("auto_clear.failed", correlation_id=alarm_correlation_id)
            return False

    # ------------------------------------------------------------------
    # Dashboard statistics
    # ------------------------------------------------------------------

    async def get_correlation_stats(
        self,
        db: AsyncSession,
        hours: int = 24,
    ) -> Dict[str, Any]:
        """Alarm correlation statistics for the dashboard."""
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

        # Total count
        total_result = await db.execute(
            select(func.count(AlarmCorrelationEvent.id)).where(
                AlarmCorrelationEvent.created_at >= cutoff
            )
        )
        total = total_result.scalar() or 0

        # Counts by classification
        class_result = await db.execute(
            select(
                AlarmCorrelationEvent.classification,
                func.count(AlarmCorrelationEvent.id),
            )
            .where(AlarmCorrelationEvent.created_at >= cutoff)
            .group_by(AlarmCorrelationEvent.classification)
        )
        classification_counts: Dict[str, int] = {}
        for row in class_result.all():
            classification_counts[row[0] or "unclassified"] = row[1]

        # Auto-cleared count
        auto_cleared_result = await db.execute(
            select(func.count(AlarmCorrelationEvent.id)).where(
                and_(
                    AlarmCorrelationEvent.created_at >= cutoff,
                    AlarmCorrelationEvent.auto_cleared.is_(True),
                )
            )
        )
        auto_cleared = auto_cleared_result.scalar() or 0

        # Average fusion score
        avg_fusion_result = await db.execute(
            select(func.avg(AlarmCorrelationEvent.fusion_score)).where(
                AlarmCorrelationEvent.created_at >= cutoff
            )
        )
        avg_fusion = avg_fusion_result.scalar()

        auto_clear_rate = round(auto_cleared / total, 4) if total > 0 else 0.0

        return {
            "total": total,
            "auto_cleared": auto_cleared,
            "real_threats": classification_counts.get("real_threat", 0),
            "false_alarms": classification_counts.get("false_alarm", 0),
            "equipment_faults": classification_counts.get("equipment_fault", 0),
            "authorized_activities": classification_counts.get("authorized_activity", 0),
            "auto_clear_rate": auto_clear_rate,
            "avg_fusion_score": round(float(avg_fusion or 0), 4),
            "classification_breakdown": classification_counts,
            "period_hours": hours,
        }

    # ------------------------------------------------------------------
    # Operator fatigue tracking
    # ------------------------------------------------------------------

    async def track_fatigue(
        self,
        db: AsyncSession,
        operator_id: str,
        response_time_seconds: float,
    ) -> Dict[str, Any]:
        """Track operator alarm fatigue metrics.

        Maintains hourly buckets per operator. Fatigue score rises when average
        response time exceeds thresholds or missed-alarm count increases.
        """
        now = datetime.now(timezone.utc)
        period_start = now.replace(minute=0, second=0, microsecond=0)
        period_end = period_start + timedelta(hours=_FATIGUE_PERIOD_HOURS)
        op_uuid = uuid.UUID(operator_id)

        # Fetch or create current period metric
        result = await db.execute(
            select(AlarmFatigueMetric).where(
                and_(
                    AlarmFatigueMetric.operator_id == op_uuid,
                    AlarmFatigueMetric.period_start == period_start,
                )
            )
        )
        metric = result.scalar_one_or_none()

        if not metric:
            metric = AlarmFatigueMetric(
                operator_id=op_uuid,
                period_start=period_start,
                period_end=period_end,
                total_alerts=0,
                acknowledged_count=0,
                avg_response_time_seconds=0.0,
                missed_count=0,
                fatigue_score=0.0,
            )
            db.add(metric)

        # Update running stats
        metric.total_alerts += 1
        is_missed = response_time_seconds > _FATIGUE_HIGH_RESPONSE_THRESHOLD * 3  # > 6 min = missed
        if is_missed:
            metric.missed_count += 1
        else:
            metric.acknowledged_count += 1

        # Incremental average response time (Welford-style running mean)
        prev_avg = metric.avg_response_time_seconds or 0.0
        n = metric.acknowledged_count
        if n > 0 and not is_missed:
            metric.avg_response_time_seconds = prev_avg + (response_time_seconds - prev_avg) / n

        # Compute fatigue score components
        #   - response_component: how much avg response time exceeds baseline
        #   - missed_component: ratio of missed alarms
        #   - volume_component: high alarm volume adds fatigue
        response_baseline = 30.0  # seconds — fresh operator average
        response_component = min(
            (metric.avg_response_time_seconds - response_baseline) / _FATIGUE_HIGH_RESPONSE_THRESHOLD,
            0.5,
        ) if metric.avg_response_time_seconds > response_baseline else 0.0

        missed_component = 0.0
        if metric.total_alerts > 0:
            missed_component = min((metric.missed_count / metric.total_alerts) * 0.8, 0.4)

        volume_component = min(metric.total_alerts / 100.0, 0.2)

        fatigue_score = min(
            response_component + missed_component + volume_component,
            _FATIGUE_MAX_SCORE,
        )
        metric.fatigue_score = round(fatigue_score, 4)

        # Recommended threshold adjustment (raise thresholds when fatigued)
        if fatigue_score > 0.7:
            metric.recommended_threshold_adjustment = 0.20
        elif fatigue_score > 0.4:
            metric.recommended_threshold_adjustment = 0.10
        else:
            metric.recommended_threshold_adjustment = 0.0

        await db.flush()
        await db.commit()

        logger.info(
            "fatigue.tracked",
            operator_id=operator_id,
            fatigue_score=metric.fatigue_score,
            avg_response=round(metric.avg_response_time_seconds or 0.0, 1),
            total=metric.total_alerts,
            missed=metric.missed_count,
        )

        return {
            "operator_id": operator_id,
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "total_alerts": metric.total_alerts,
            "acknowledged_count": metric.acknowledged_count,
            "missed_count": metric.missed_count,
            "avg_response_time_seconds": round(metric.avg_response_time_seconds or 0.0, 2),
            "fatigue_score": metric.fatigue_score,
            "recommended_threshold_adjustment": metric.recommended_threshold_adjustment,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _infer_category(source_type: str, event_data: Dict[str, Any]) -> str:
        """Infer an alarm category from source type and event data."""
        event_type_str = str(event_data.get("event_type", "")).lower()
        threat_type_str = str(event_data.get("threat_type", "")).lower()
        combined = f"{event_type_str} {threat_type_str} {source_type}"

        if any(kw in combined for kw in ("fire", "smoke", "thermal", "flame")):
            return "fire"
        if any(kw in combined for kw in ("forced", "break", "intrusion")):
            return "forced_entry"
        if any(kw in combined for kw in ("tailgat", "piggyback")):
            return "tailgating"
        if any(kw in combined for kw in ("perimete", "fence", "breach")):
            return "perimeter_breach"
        if any(kw in combined for kw in ("unauth", "denied", "badge", "access")):
            return "unauthorized_access"
        return "perimeter_breach"  # default fallback

    @staticmethod
    def _classify_sensor_type(event_type_str: str) -> Optional[str]:
        """Map a raw event_type string to a canonical sensor type."""
        lower = event_type_str.lower()
        for sensor_type, keywords in _SENSOR_EVENT_MAP.items():
            if any(kw in lower for kw in keywords):
                return sensor_type
        return None

    @staticmethod
    def _classify_alarm(
        fusion_score: float,
        cascade_matched: bool,
        triggered_count: int,
        expected_count: int,
        pacs_events: list,
        event_data: Dict[str, Any],
    ) -> str:
        """Determine final classification from all collected evidence."""
        # Check for authorized activity via PACS
        for pe in pacs_events:
            if pe.event_type == "granted":
                # Access was legitimately granted — probably authorized
                if fusion_score < 0.5 and triggered_count <= 2:
                    return "authorized_activity"

        # High fusion score with cascade match = real threat
        if fusion_score >= 0.65 and cascade_matched:
            return "real_threat"

        # Moderate fusion score with cascade match
        if fusion_score >= 0.45 and cascade_matched:
            return "real_threat"

        # Only one sensor triggered out of many expected
        if triggered_count == 1 and expected_count >= 2:
            # Might be equipment fault if no video evidence
            event_type_str = str(event_data.get("event_type", "")).lower()
            if any(kw in event_type_str for kw in ("tamper", "fault", "error", "offline")):
                return "equipment_fault"
            return "false_alarm"

        # Low fusion score — likely false alarm
        if fusion_score < 0.30:
            return "false_alarm"

        # Middle-ground: insufficient evidence to classify definitively
        if fusion_score < 0.50:
            return "false_alarm"

        return "real_threat"


# Module-level singleton
alarm_correlation_engine = AlarmCorrelationEngine()
