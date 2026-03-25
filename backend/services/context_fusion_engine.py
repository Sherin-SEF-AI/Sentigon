"""Four-Dimensional Context Fusion Engine — Phase 3A core.

Re-scores raw YOLO/Gemini threat detections through four contextual
dimensions: spatial (zone-type awareness), temporal (time-of-day
normalization against baselines), behavioral (entity tracking history),
and environmental (PACS, alarm panels, sensors).

Each dimension produces a modifier in [0.0, 1.0] that is fused via
weighted combination to yield a contextual confidence score that
replaces the raw detection confidence.
"""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Camera, Zone, Event, Alert
from backend.models.phase3_models import (
    ActivityBaseline,
    AlarmCorrelationEvent,
    ContextRule,
    EntityAppearance,
    EntityTrack,
    IntentClassification,
)

logger = logging.getLogger(__name__)

# ── Sensible Defaults (used when no ContextRule row exists) ──────────

_DEFAULT_SPATIAL_SCORES: Dict[str, Dict[str, float]] = {
    "restricted": {
        "person": 0.70, "knife": 0.95, "backpack": 0.55, "vehicle": 0.80,
        "cell phone": 0.30, "laptop": 0.40, "scissors": 0.80,
        "default": 0.60,
    },
    "entry": {
        "person": 0.10, "knife": 0.85, "backpack": 0.15, "vehicle": 0.15,
        "cell phone": 0.05, "laptop": 0.10, "scissors": 0.60,
        "default": 0.20,
    },
    "exit": {
        "person": 0.10, "knife": 0.80, "backpack": 0.15, "vehicle": 0.10,
        "default": 0.15,
    },
    "parking": {
        "person": 0.20, "knife": 0.90, "backpack": 0.20, "vehicle": 0.05,
        "default": 0.15,
    },
    "general": {
        "person": 0.05, "knife": 0.75, "backpack": 0.05, "vehicle": 0.05,
        "cell phone": 0.02, "laptop": 0.05,
        "default": 0.10,
    },
    "kitchen": {
        "person": 0.05, "knife": 0.10, "scissors": 0.10, "backpack": 0.30,
        "default": 0.08,
    },
    "server_room": {
        "person": 0.80, "backpack": 0.70, "laptop": 0.50, "cell phone": 0.40,
        "default": 0.65,
    },
}

# Weights for dimension fusion
_W_SPATIAL = 0.30
_W_TEMPORAL = 0.25
_W_BEHAVIORAL = 0.25
_W_ENVIRONMENTAL = 0.20

# Epsilon for standard-deviation denominator to avoid division by zero
_EPSILON = 0.1

# Night-hours window
_NIGHT_START = time(22, 0)
_NIGHT_END = time(6, 0)

# Off-hours (weekday evenings + weekends)
_OFFHOURS_START = time(18, 0)
_OFFHOURS_END = time(7, 0)


def _is_night(ts: datetime) -> bool:
    t = ts.time()
    return t >= _NIGHT_START or t < _NIGHT_END


def _is_offhours(ts: datetime) -> bool:
    if ts.weekday() >= 5:  # Saturday, Sunday
        return True
    t = ts.time()
    return t >= _OFFHOURS_START or t < _OFFHOURS_END


def _time_slot(ts: datetime) -> int:
    """0-95: 15-minute slot index within a day."""
    return ts.hour * 4 + ts.minute // 15


class ContextFusionEngine:
    """Re-calculates threat scores through four context dimensions."""

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    async def evaluate_context(
        self,
        db: AsyncSession,
        camera_id: uuid.UUID,
        zone_id: Optional[uuid.UUID],
        detections: Dict[str, Any],
        raw_threats: List[Dict[str, Any]],
        timestamp: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """Take raw YOLO/Gemini threats and re-score through all four
        context dimensions.

        Parameters
        ----------
        db : AsyncSession
            Active database session.
        camera_id : UUID of the source camera.
        zone_id : UUID of the zone (may be None).
        detections : YOLO detections dict
            ``{person_count, vehicle_count, objects: [{class, confidence, bbox, track_id, dwell_time, is_stationary}]}``
        raw_threats : list of dicts
            Each dict must have at least ``{"threat_type", "raw_confidence", "object_class"}``.
        timestamp : When the frame was captured (defaults to now-UTC).

        Returns
        -------
        list[dict]  -- re-scored threats with per-dimension evidence attached.
        """
        ts = timestamp or datetime.now(timezone.utc)
        results: List[Dict[str, Any]] = []

        for threat in raw_threats:
            try:
                spatial = await self._apply_spatial_context(db, zone_id, threat, detections)
                temporal = await self._apply_temporal_context(db, camera_id, zone_id, threat, ts)
                behavioral = await self._apply_behavioral_context(db, camera_id, detections, threat)
                environmental = await self._apply_environmental_context(db, zone_id, threat, ts)

                raw_conf = float(threat.get("raw_confidence", threat.get("confidence", 0.5)))
                final_score = await self._compute_final_score(
                    spatial["score"],
                    temporal["score"],
                    behavioral["score"],
                    environmental["score"],
                    raw_conf,
                )

                results.append({
                    "threat_type": threat.get("threat_type", "unknown"),
                    "object_class": threat.get("object_class", "unknown"),
                    "raw_confidence": raw_conf,
                    "contextual_confidence": final_score,
                    "delta": round(final_score - raw_conf, 4),
                    "dimensions": {
                        "spatial": spatial,
                        "temporal": temporal,
                        "behavioral": behavioral,
                        "environmental": environmental,
                    },
                    "timestamp": ts.isoformat(),
                })
            except Exception:
                logger.exception(
                    "Context evaluation failed for threat %s — passing through raw score",
                    threat.get("threat_type"),
                )
                results.append({
                    "threat_type": threat.get("threat_type", "unknown"),
                    "object_class": threat.get("object_class", "unknown"),
                    "raw_confidence": float(threat.get("raw_confidence", 0.5)),
                    "contextual_confidence": float(threat.get("raw_confidence", 0.5)),
                    "delta": 0.0,
                    "dimensions": {},
                    "error": "context_evaluation_failed",
                    "timestamp": ts.isoformat(),
                })

        return results

    # ------------------------------------------------------------------
    # Dimension 1 — Spatial Context
    # ------------------------------------------------------------------

    async def _apply_spatial_context(
        self,
        db: AsyncSession,
        zone_id: Optional[uuid.UUID],
        threat: Dict[str, Any],
        detections: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Zone-type-aware scoring.

        A knife in a kitchen is benign (0.10); the same knife in a lobby
        is critical (0.95).  Queries the ``ContextRule`` table for a
        matching (zone_type, object_class) row.  Falls back to built-in
        defaults if no rule exists.
        """
        zone_type = "general"
        zone_name = "unknown"

        if zone_id:
            try:
                result = await db.execute(
                    select(Zone.zone_type, Zone.name).where(Zone.id == zone_id)
                )
                row = result.first()
                if row:
                    zone_type = row[0] or "general"
                    zone_name = row[1] or "unknown"
            except Exception:
                logger.debug("Could not fetch zone %s — defaulting to 'general'", zone_id)

        object_class = (threat.get("object_class") or "unknown").lower()

        # Try the ContextRule table first
        rule_score: Optional[float] = None
        dwell_escalation_sec = 60
        dwell_escalation_factor = 0.3
        try:
            result = await db.execute(
                select(ContextRule).where(
                    and_(
                        ContextRule.zone_type == zone_type,
                        ContextRule.object_class == object_class,
                        ContextRule.is_active.is_(True),
                    )
                )
            )
            rule = result.scalars().first()
            if rule:
                rule_score = rule.base_threat_score
                dwell_escalation_sec = rule.dwell_escalation_seconds or 60
                dwell_escalation_factor = rule.dwell_escalation_factor or 0.3
        except Exception:
            logger.debug("ContextRule query failed — using defaults")

        if rule_score is not None:
            score = rule_score
        else:
            zone_defaults = _DEFAULT_SPATIAL_SCORES.get(zone_type, _DEFAULT_SPATIAL_SCORES["general"])
            score = zone_defaults.get(object_class, zone_defaults.get("default", 0.15))

        # Dwell-time escalation: if any matching detected object has been
        # stationary beyond the dwell threshold, bump the score.
        objects = detections.get("objects", [])
        max_dwell = 0.0
        for obj in objects:
            if (obj.get("class") or "").lower() == object_class:
                max_dwell = max(max_dwell, float(obj.get("dwell_time", 0)))
        if max_dwell > dwell_escalation_sec:
            overshoot = (max_dwell - dwell_escalation_sec) / dwell_escalation_sec
            score = min(1.0, score + dwell_escalation_factor * min(overshoot, 2.0))

        return {
            "score": round(score, 4),
            "zone_type": zone_type,
            "zone_name": zone_name,
            "object_class": object_class,
            "dwell_seconds": round(max_dwell, 1),
            "rule_source": "database" if rule_score is not None else "default",
        }

    # ------------------------------------------------------------------
    # Dimension 2 — Temporal Context
    # ------------------------------------------------------------------

    async def _apply_temporal_context(
        self,
        db: AsyncSession,
        camera_id: uuid.UUID,
        zone_id: Optional[uuid.UUID],
        threat: Dict[str, Any],
        timestamp: datetime,
    ) -> Dict[str, Any]:
        """Time-of-day normalization against learned baselines.

        Computes an anomaly score =
            |current_value - baseline_mean| / (baseline_std + epsilon).
        Night hours (22:00-06:00) and off-hours get multipliers pulled
        from the ContextRule (or sensible defaults of 1.5 / 1.2).
        """
        day_of_week = timestamp.weekday()
        slot = _time_slot(timestamp)

        # Fetch the ActivityBaseline for this camera + time slot
        baseline_query = select(ActivityBaseline).where(
            and_(
                ActivityBaseline.camera_id == camera_id,
                ActivityBaseline.day_of_week == day_of_week,
                ActivityBaseline.time_slot == slot,
            )
        )
        if zone_id:
            baseline_query = baseline_query.where(
                or_(ActivityBaseline.zone_id == zone_id, ActivityBaseline.zone_id.is_(None))
            )

        try:
            result = await db.execute(baseline_query.order_by(ActivityBaseline.sample_count.desc()))
            baseline = result.scalars().first()
        except Exception:
            logger.debug("Baseline query failed for camera %s", camera_id)
            baseline = None

        anomaly_score = 0.0
        evidence: Dict[str, Any] = {
            "day_of_week": day_of_week,
            "time_slot": slot,
            "is_night": _is_night(timestamp),
            "is_offhours": _is_offhours(timestamp),
        }

        if baseline and baseline.sample_count >= 5:
            raw_conf = float(threat.get("raw_confidence", threat.get("confidence", 0.5)))
            # Use the person-count baseline as a proxy for activity level.
            # A high raw_confidence in a normally-quiet period = more suspicious.
            mean = baseline.avg_person_count or 0.0
            std = baseline.std_person_count or 0.0
            # Anomaly relative to expected activity
            anomaly_score = abs(raw_conf - mean / max(mean + 1, 1)) / (std + _EPSILON)
            anomaly_score = min(anomaly_score, 3.0) / 3.0  # Normalize to [0, 1]

            evidence["baseline_mean"] = round(mean, 2)
            evidence["baseline_std"] = round(std, 2)
            evidence["sample_count"] = baseline.sample_count
        else:
            # No reliable baseline — neutral score
            anomaly_score = 0.5
            evidence["baseline_status"] = "insufficient_data"

        # Time multipliers
        night_mult = 1.0
        offhours_mult = 1.0

        # Try to load multipliers from ContextRule
        object_class = (threat.get("object_class") or "").lower()
        if object_class:
            try:
                result = await db.execute(
                    select(
                        ContextRule.time_multiplier_night,
                        ContextRule.time_multiplier_offhours,
                    ).where(
                        and_(
                            ContextRule.object_class == object_class,
                            ContextRule.is_active.is_(True),
                        )
                    ).limit(1)
                )
                mult_row = result.first()
                if mult_row:
                    night_mult = mult_row[0] or 1.5
                    offhours_mult = mult_row[1] or 1.2
            except Exception:
                pass

        if night_mult == 1.0:
            night_mult = 1.5
        if offhours_mult == 1.0:
            offhours_mult = 1.2

        temporal_score = anomaly_score
        if _is_night(timestamp):
            temporal_score = min(1.0, temporal_score * night_mult)
            evidence["applied_multiplier"] = f"night x{night_mult}"
        elif _is_offhours(timestamp):
            temporal_score = min(1.0, temporal_score * offhours_mult)
            evidence["applied_multiplier"] = f"offhours x{offhours_mult}"

        return {"score": round(temporal_score, 4), **evidence}

    # ------------------------------------------------------------------
    # Dimension 3 — Behavioral Context
    # ------------------------------------------------------------------

    async def _apply_behavioral_context(
        self,
        db: AsyncSession,
        camera_id: uuid.UUID,
        detections: Dict[str, Any],
        threat: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Entity-track-based behavioral scoring.

        Checks the EntityTrack / EntityAppearance tables for:
        - Repeat visitors to restricted areas (revisit_count).
        - Dwell-time escalation.
        - Direction-change frequency as a suspicion indicator.
        - Existing behavioral flags (reconnaissance, tailgating, etc.).
        """
        score = 0.0
        evidence: Dict[str, Any] = {"factors": []}

        objects = detections.get("objects", [])
        track_ids = [obj.get("track_id") for obj in objects if obj.get("track_id") is not None]

        if not track_ids:
            return {"score": 0.3, "reason": "no_tracked_entities"}

        try:
            # Find EntityAppearances for these track IDs at this camera recently
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            result = await db.execute(
                select(EntityAppearance.entity_track_id).where(
                    and_(
                        EntityAppearance.camera_id == camera_id,
                        EntityAppearance.track_id.in_(track_ids),
                        EntityAppearance.timestamp >= cutoff,
                    )
                ).distinct()
            )
            entity_track_ids = [r[0] for r in result.all()]

            if not entity_track_ids:
                return {"score": 0.25, "reason": "no_entity_history"}

            # Fetch EntityTrack records for scoring
            result = await db.execute(
                select(EntityTrack).where(EntityTrack.id.in_(entity_track_ids))
            )
            tracks = result.scalars().all()

            if not tracks:
                return {"score": 0.25, "reason": "no_entity_tracks"}

            component_scores: List[float] = []
            for track in tracks:
                track_score = 0.0

                # Factor 1: Restricted-area visit count
                restricted_visits = track.restricted_area_visits or 0
                if restricted_visits >= 3:
                    track_score += 0.35
                    evidence["factors"].append(
                        f"entity has {restricted_visits} restricted-area visits"
                    )
                elif restricted_visits >= 1:
                    track_score += 0.15
                    evidence["factors"].append(
                        f"entity has {restricted_visits} restricted-area visit(s)"
                    )

                # Factor 2: Revisit count (same area)
                revisit_count = track.revisit_count or 0
                if revisit_count >= 3:
                    track_score += 0.25
                    evidence["factors"].append(f"revisit_count={revisit_count}")
                elif revisit_count >= 1:
                    track_score += 0.10

                # Factor 3: Dwell time
                total_dwell = track.total_dwell_seconds or 0.0
                if total_dwell > 300:
                    track_score += 0.20
                    evidence["factors"].append(f"total_dwell={total_dwell:.0f}s")
                elif total_dwell > 120:
                    track_score += 0.10

                # Factor 4: Escalation level already assigned
                escalation = track.escalation_level or 0
                if escalation >= 3:
                    track_score += 0.30
                    evidence["factors"].append(f"escalation_level={escalation}")
                elif escalation >= 2:
                    track_score += 0.15
                elif escalation >= 1:
                    track_score += 0.05

                # Factor 5: Behavioral flags
                flags = track.behavioral_flags or []
                high_risk_flags = {"reconnaissance", "escalating", "tailgating_multiple", "evasive"}
                matched_flags = high_risk_flags.intersection(set(flags))
                if matched_flags:
                    track_score += 0.20 * len(matched_flags)
                    evidence["factors"].append(f"behavioral_flags={list(matched_flags)}")

                component_scores.append(min(track_score, 1.0))

            # Use the maximum risk across all matched entity tracks
            score = max(component_scores) if component_scores else 0.25

        except Exception:
            logger.exception("Behavioral context lookup failed")
            score = 0.3
            evidence["error"] = "query_failed"

        # Incorporate per-object dwell time from current detections
        max_obj_dwell = 0.0
        stationary_count = 0
        for obj in objects:
            d = float(obj.get("dwell_time", 0))
            if d > max_obj_dwell:
                max_obj_dwell = d
            if obj.get("is_stationary"):
                stationary_count += 1

        if max_obj_dwell > 180:
            score = min(1.0, score + 0.15)
            evidence["factors"].append(f"current_dwell={max_obj_dwell:.0f}s")
        if stationary_count >= 2:
            score = min(1.0, score + 0.10)
            evidence["factors"].append(f"stationary_objects={stationary_count}")

        # Direction-change heuristic from detections metadata
        direction_changes = 0
        for obj in objects:
            direction_changes += int(obj.get("direction_changes", 0))
        if direction_changes >= 6:
            score = min(1.0, score + 0.15)
            evidence["factors"].append(f"direction_changes={direction_changes}")
        elif direction_changes >= 3:
            score = min(1.0, score + 0.05)

        return {"score": round(min(score, 1.0), 4), **evidence}

    # ------------------------------------------------------------------
    # Dimension 4 — Environmental Context
    # ------------------------------------------------------------------

    async def _apply_environmental_context(
        self,
        db: AsyncSession,
        zone_id: Optional[uuid.UUID],
        threat: Dict[str, Any],
        timestamp: datetime,
    ) -> Dict[str, Any]:
        """Cross-references PACS access events, alarm panel states, and
        correlated alarm events.

        Logic:
        - A person in a restricted zone with a valid recent access event
          within the past 5 minutes -> suppress (lower score).
        - No access event + person in restricted zone -> escalate.
        - Propped door during a known maintenance window -> suppress.
        - Active alarm in the zone -> amplify.
        """
        score = 0.5  # neutral
        evidence: Dict[str, Any] = {"factors": []}

        if not zone_id:
            return {"score": 0.4, "reason": "no_zone_assigned"}

        # Fetch zone type
        zone_type = "general"
        try:
            result = await db.execute(select(Zone.zone_type).where(Zone.id == zone_id))
            row = result.first()
            if row:
                zone_type = row[0] or "general"
        except Exception:
            pass

        # Check for recent AlarmCorrelationEvents in this zone (last 10 min)
        alarm_cutoff = timestamp - timedelta(minutes=10)
        active_alarms = 0
        try:
            result = await db.execute(
                select(func.count()).select_from(AlarmCorrelationEvent).where(
                    and_(
                        AlarmCorrelationEvent.zone_id == zone_id,
                        AlarmCorrelationEvent.created_at >= alarm_cutoff,
                        AlarmCorrelationEvent.classification.in_(["real_threat", "unclassified"]),
                        AlarmCorrelationEvent.auto_cleared.is_(False),
                    )
                )
            )
            active_alarms = result.scalar() or 0
        except Exception:
            logger.debug("AlarmCorrelationEvent query failed for zone %s", zone_id)

        if active_alarms > 0:
            score = min(1.0, score + 0.25 + 0.05 * (active_alarms - 1))
            evidence["factors"].append(f"active_alarms={active_alarms}")

        # Check for recently cleared/authorized events (maintenance, etc.)
        try:
            result = await db.execute(
                select(func.count()).select_from(AlarmCorrelationEvent).where(
                    and_(
                        AlarmCorrelationEvent.zone_id == zone_id,
                        AlarmCorrelationEvent.created_at >= alarm_cutoff,
                        AlarmCorrelationEvent.classification == "authorized_activity",
                    )
                )
            )
            authorized_count = result.scalar() or 0
            if authorized_count > 0:
                score = max(0.0, score - 0.30)
                evidence["factors"].append(f"authorized_activity_events={authorized_count}")
        except Exception:
            pass

        # Check if there's a ContextRule that requires an access event
        requires_access = False
        object_class = (threat.get("object_class") or "").lower()
        if object_class and zone_type in ("restricted", "server_room"):
            try:
                result = await db.execute(
                    select(ContextRule.requires_access_event).where(
                        and_(
                            ContextRule.zone_type == zone_type,
                            ContextRule.object_class == object_class,
                            ContextRule.is_active.is_(True),
                        )
                    ).limit(1)
                )
                row = result.first()
                if row and row[0]:
                    requires_access = True
            except Exception:
                pass

        # If the zone is restricted and the object is a person,
        # check for a recent correlated PACS event (access granted).
        if zone_type in ("restricted", "server_room") and object_class in ("person", ""):
            pacs_cutoff = timestamp - timedelta(minutes=5)
            try:
                result = await db.execute(
                    select(func.count()).select_from(AlarmCorrelationEvent).where(
                        and_(
                            AlarmCorrelationEvent.zone_id == zone_id,
                            AlarmCorrelationEvent.source_type == "pacs",
                            AlarmCorrelationEvent.created_at >= pacs_cutoff,
                            AlarmCorrelationEvent.classification == "authorized_activity",
                        )
                    )
                )
                pacs_grants = result.scalar() or 0
            except Exception:
                pacs_grants = 0

            if pacs_grants > 0:
                score = max(0.05, score - 0.35)
                evidence["factors"].append("recent_pacs_access_grant")
            elif requires_access:
                score = min(1.0, score + 0.25)
                evidence["factors"].append("no_pacs_event_but_access_required")
            elif zone_type == "restricted":
                # No PACS data available but zone is restricted — mild escalation
                score = min(1.0, score + 0.10)
                evidence["factors"].append("restricted_zone_no_access_data")

        # Equipment-fault auto-clear: if the alarm source was classified as
        # equipment_fault, suppress heavily.
        try:
            result = await db.execute(
                select(func.count()).select_from(AlarmCorrelationEvent).where(
                    and_(
                        AlarmCorrelationEvent.zone_id == zone_id,
                        AlarmCorrelationEvent.created_at >= alarm_cutoff,
                        AlarmCorrelationEvent.classification == "equipment_fault",
                    )
                )
            )
            faults = result.scalar() or 0
            if faults > 0:
                score = max(0.05, score - 0.30)
                evidence["factors"].append(f"equipment_faults={faults}")
        except Exception:
            pass

        evidence["zone_type"] = zone_type
        return {"score": round(max(min(score, 1.0), 0.0), 4), **evidence}

    # ------------------------------------------------------------------
    # Final fusion
    # ------------------------------------------------------------------

    async def _compute_final_score(
        self,
        spatial: float,
        temporal: float,
        behavioral: float,
        environmental: float,
        raw_confidence: float,
    ) -> float:
        """Weighted fusion of all four dimensions, combined with the
        original raw confidence.

        Formula:
            context_modifier = W_S*spatial + W_T*temporal + W_B*behavioral + W_E*environmental
            final = 0.4 * raw_confidence + 0.6 * context_modifier

        The raw confidence retains 40 % influence so that strong
        detections are never completely suppressed and weak ones are
        never inflated beyond reason.
        """
        context_modifier = (
            _W_SPATIAL * spatial
            + _W_TEMPORAL * temporal
            + _W_BEHAVIORAL * behavioral
            + _W_ENVIRONMENTAL * environmental
        )
        final = 0.4 * raw_confidence + 0.6 * context_modifier
        return round(max(0.0, min(1.0, final)), 4)


# ── Module-level singleton ───────────────────────────────────────────

context_fusion_engine = ContextFusionEngine()
