"""Intent Classification Layer — Phase 3A behavioral intelligence.

Classifies the intent of tracked entities based on multi-frame
trajectory analysis, dwell-time patterns, interactions with restricted
areas, and pre-incident precursor indicators drawn from security
research.

The classifier operates on a trajectory (list of {x, y, t} points)
plus contextual signals (zone type, dwell time, detection metadata)
to produce:
- An intent category (e.g., ``reconnaissance``, ``casual_passerby``).
- A confidence score.
- A risk score 0.0-1.0.
- Matched precursor indicators with explanations.
"""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Zone
from backend.models.phase3_models import IntentClassification, EntityTrack

logger = logging.getLogger(__name__)

# ── Pre-incident precursor pattern definitions ───────────────────────

PRECURSORS = {
    "slowing_pace": {"speed_ratio_threshold": 0.3},
    "looking_around": {"gaze_variance_threshold": 0.5},
    "testing_access": {"near_door_dwell": 10},
    "pacing": {"direction_changes_min": 4},
    "photographing": {"device_interaction": True},
    "hiding": {"seeking_concealment": True},
    "following": {"trajectory_correlation": 0.7},
    "counter_surveillance": {"frequent_stops_and_looks": True},
    "perimeter_probing": {"near_perimeter_time": 30},
    "distraction_behavior": {"attention_diversion": True},
}

INTENT_CATEGORIES = [
    "authorized_access",
    "casual_passerby",
    "delivery",
    "reconnaissance",
    "evasive_approach",
    "forced_entry",
    "loitering_benign",
    "loitering_suspicious",
]

# Risk weights by intent category
_INTENT_BASE_RISK: Dict[str, float] = {
    "authorized_access": 0.05,
    "casual_passerby": 0.05,
    "delivery": 0.10,
    "loitering_benign": 0.15,
    "loitering_suspicious": 0.45,
    "reconnaissance": 0.65,
    "evasive_approach": 0.75,
    "forced_entry": 0.90,
}

# Zone-type risk multipliers
_ZONE_RISK_MULT: Dict[str, float] = {
    "restricted": 1.5,
    "server_room": 1.6,
    "entry": 1.0,
    "exit": 1.0,
    "parking": 1.2,
    "general": 0.8,
}


class IntentClassifier:
    """Classify tracked entity intent from trajectory and context."""

    # ------------------------------------------------------------------
    # Main classification entry point
    # ------------------------------------------------------------------

    async def classify_intent(
        self,
        db: AsyncSession,
        camera_id: uuid.UUID,
        zone_id: Optional[uuid.UUID],
        track_id: Optional[int],
        trajectory_points: List[Dict[str, float]],
        dwell_time: float,
        detections: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Classify the intent of a tracked entity.

        Parameters
        ----------
        trajectory_points : list of ``{x, y, t}`` dicts (pixel coords +
            epoch-seconds timestamp).
        dwell_time : total dwell time in seconds for this entity in the
            current zone.
        detections : YOLO detections dict for contextual signals.

        Returns
        -------
        dict with keys: ``intent_category``, ``confidence``,
        ``risk_score``, ``precursor_indicators``, ``explanation``,
        ``trajectory_analysis``.
        """
        # Resolve zone type
        zone_type = "general"
        if zone_id:
            try:
                result = await db.execute(
                    select(Zone.zone_type).where(Zone.id == zone_id)
                )
                row = result.first()
                if row:
                    zone_type = row[0] or "general"
            except Exception:
                logger.debug("Could not fetch zone type for %s", zone_id)

        # Analyze trajectory
        traj = await self.analyze_trajectory(trajectory_points)

        # Check precursors
        precursors = await self.check_precursors(traj, dwell_time, zone_type, detections)

        # Determine intent category
        intent_category, confidence = self._determine_intent(
            traj, dwell_time, zone_type, precursors, detections,
        )

        # Compute final risk score
        risk_score = await self.score_risk(intent_category, precursors, zone_type, dwell_time)

        # Build human-readable explanation
        explanation = self._build_explanation(
            intent_category, confidence, risk_score, precursors, traj, zone_type, dwell_time,
        )

        classification = {
            "intent_category": intent_category,
            "confidence": round(confidence, 3),
            "risk_score": round(risk_score, 4),
            "precursor_indicators": precursors,
            "explanation": explanation,
            "trajectory_analysis": traj,
            "zone_type": zone_type,
            "dwell_time": round(dwell_time, 1),
            "track_id": track_id,
        }

        # Persist to database
        try:
            classification_id = await self.persist_classification(
                db, camera_id, zone_id, track_id, classification,
            )
            classification["classification_id"] = classification_id
        except Exception:
            logger.exception("Failed to persist intent classification")

        return classification

    # ------------------------------------------------------------------
    # Trajectory analysis
    # ------------------------------------------------------------------

    async def analyze_trajectory(
        self,
        trajectory_points: List[Dict[str, float]],
    ) -> Dict[str, Any]:
        """Analyze movement trajectory for suspicious patterns.

        Computes: approach_speed, direction_changes, path_linearity,
        near_restricted_area, is_circling, total_distance,
        displacement, speed_variance.
        """
        n = len(trajectory_points)
        if n < 2:
            return {
                "approach_speed": 0.0,
                "direction_changes": 0,
                "path_linearity": 1.0,
                "is_circling": False,
                "total_distance": 0.0,
                "displacement": 0.0,
                "speed_variance": 0.0,
                "avg_speed": 0.0,
                "point_count": n,
                "duration_seconds": 0.0,
            }

        # Compute segment distances and speeds
        distances: List[float] = []
        speeds: List[float] = []
        angles: List[float] = []

        for i in range(1, n):
            dx = trajectory_points[i]["x"] - trajectory_points[i - 1]["x"]
            dy = trajectory_points[i]["y"] - trajectory_points[i - 1]["y"]
            dist = math.hypot(dx, dy)
            distances.append(dist)

            dt = trajectory_points[i].get("t", 0) - trajectory_points[i - 1].get("t", 0)
            if dt > 0:
                speeds.append(dist / dt)
            elif dist > 0:
                speeds.append(dist)  # fallback: 1-second assumed

            angle = math.atan2(dy, dx)
            angles.append(angle)

        total_distance = sum(distances)

        # Displacement: straight-line from first to last point
        dx_total = trajectory_points[-1]["x"] - trajectory_points[0]["x"]
        dy_total = trajectory_points[-1]["y"] - trajectory_points[0]["y"]
        displacement = math.hypot(dx_total, dy_total)

        # Path linearity: displacement / total_distance (1.0 = perfectly straight)
        path_linearity = displacement / total_distance if total_distance > 0 else 1.0
        path_linearity = min(path_linearity, 1.0)

        # Direction changes: count significant angle changes (> 45 degrees)
        direction_changes = 0
        for i in range(1, len(angles)):
            delta_angle = abs(angles[i] - angles[i - 1])
            # Normalize to [0, pi]
            if delta_angle > math.pi:
                delta_angle = 2 * math.pi - delta_angle
            if delta_angle > math.pi / 4:  # > 45 degrees
                direction_changes += 1

        # Speed statistics
        avg_speed = sum(speeds) / len(speeds) if speeds else 0.0
        speed_variance = 0.0
        if len(speeds) >= 2:
            speed_mean = avg_speed
            speed_variance = sum((s - speed_mean) ** 2 for s in speeds) / len(speeds)

        # Approach speed: speed of the last few segments (how fast approaching now)
        last_n = min(3, len(speeds))
        approach_speed = sum(speeds[-last_n:]) / last_n if last_n > 0 else 0.0

        # Duration
        duration = 0.0
        if trajectory_points[-1].get("t") and trajectory_points[0].get("t"):
            duration = trajectory_points[-1]["t"] - trajectory_points[0]["t"]

        # Circling detection: low linearity + high direction changes
        is_circling = path_linearity < 0.3 and direction_changes >= 4

        return {
            "approach_speed": round(approach_speed, 2),
            "direction_changes": direction_changes,
            "path_linearity": round(path_linearity, 3),
            "is_circling": is_circling,
            "total_distance": round(total_distance, 1),
            "displacement": round(displacement, 1),
            "speed_variance": round(speed_variance, 3),
            "avg_speed": round(avg_speed, 2),
            "point_count": n,
            "duration_seconds": round(duration, 1),
        }

    # ------------------------------------------------------------------
    # Precursor checking
    # ------------------------------------------------------------------

    async def check_precursors(
        self,
        trajectory_analysis: Dict[str, Any],
        dwell_time: float,
        zone_type: str,
        detections: Dict[str, Any],
    ) -> List[str]:
        """Check which pre-incident precursor indicators are present
        based on trajectory analysis, dwell patterns, and detection
        context.

        Returns a list of matched precursor names.
        """
        matched: List[str] = []

        avg_speed = trajectory_analysis.get("avg_speed", 0)
        approach_speed = trajectory_analysis.get("approach_speed", 0)
        direction_changes = trajectory_analysis.get("direction_changes", 0)
        path_linearity = trajectory_analysis.get("path_linearity", 1.0)
        is_circling = trajectory_analysis.get("is_circling", False)
        speed_variance = trajectory_analysis.get("speed_variance", 0)
        duration = trajectory_analysis.get("duration_seconds", 0)

        # 1. Slowing pace: approach speed is much slower than average
        if avg_speed > 0:
            speed_ratio = approach_speed / avg_speed
            if speed_ratio < PRECURSORS["slowing_pace"]["speed_ratio_threshold"]:
                matched.append("slowing_pace")

        # 2. Looking around: high speed variance suggests stops and starts
        #    (proxy for gaze changes when gaze tracking unavailable)
        if speed_variance > PRECURSORS["looking_around"]["gaze_variance_threshold"]:
            matched.append("looking_around")

        # 3. Testing access: lingering near entry/restricted zone
        if zone_type in ("entry", "restricted", "server_room"):
            if dwell_time >= PRECURSORS["testing_access"]["near_door_dwell"]:
                matched.append("testing_access")

        # 4. Pacing: many direction changes
        if direction_changes >= PRECURSORS["pacing"]["direction_changes_min"]:
            matched.append("pacing")

        # 5. Photographing: detect held cell phone or camera in detections
        objects = detections.get("objects", [])
        device_classes = {"cell phone", "camera", "tablet"}
        for obj in objects:
            obj_class = (obj.get("class") or "").lower()
            if obj_class in device_classes:
                is_stat = obj.get("is_stationary", False)
                obj_dwell = float(obj.get("dwell_time", 0))
                if is_stat or obj_dwell > 5:
                    matched.append("photographing")
                    break

        # 6. Hiding: very low speed + near perimeter/concealment areas
        if avg_speed < 2.0 and path_linearity < 0.2 and dwell_time > 30:
            matched.append("hiding")

        # 7. Following: high trajectory correlation (needs multi-track;
        #    use circling + multiple persons as proxy)
        person_count = detections.get("person_count", 0)
        if person_count >= 2 and path_linearity > 0.6 and direction_changes <= 2:
            matched.append("following")

        # 8. Counter-surveillance: frequent stops (high speed variance)
        #    combined with direction changes
        if speed_variance > 0.3 and direction_changes >= 3 and duration > 20:
            matched.append("counter_surveillance")

        # 9. Perimeter probing: extended time near perimeter zones
        if zone_type in ("parking", "entry", "exit", "general"):
            if dwell_time >= PRECURSORS["perimeter_probing"]["near_perimeter_time"]:
                if path_linearity < 0.5:
                    matched.append("perimeter_probing")

        # 10. Distraction behavior: sudden speed increase after dwell
        if dwell_time > 15 and approach_speed > avg_speed * 2.5 and avg_speed > 0:
            matched.append("distraction_behavior")

        # 11. Circling (bonus indicator, not in the base PRECURSORS dict)
        if is_circling:
            matched.append("circling")

        return matched

    # ------------------------------------------------------------------
    # Risk scoring
    # ------------------------------------------------------------------

    async def score_risk(
        self,
        intent_category: str,
        precursors: List[str],
        zone_type: str,
        dwell_time: float,
    ) -> float:
        """Compute risk score 0.0-1.0 from intent, precursors, zone
        context, and dwell time.

        Reconnaissance in a restricted zone with 3+ precursors = 0.9+.
        """
        base = _INTENT_BASE_RISK.get(intent_category, 0.3)

        # Precursor bonus: each precursor adds incremental risk
        precursor_bonus = len(precursors) * 0.07
        # High-signal precursors get extra weight
        high_signal = {"testing_access", "counter_surveillance", "pacing", "hiding"}
        high_signal_count = len(set(precursors) & high_signal)
        precursor_bonus += high_signal_count * 0.05

        # Zone multiplier
        zone_mult = _ZONE_RISK_MULT.get(zone_type, 1.0)

        # Dwell escalation
        dwell_bonus = 0.0
        if dwell_time > 300:
            dwell_bonus = 0.15
        elif dwell_time > 120:
            dwell_bonus = 0.08
        elif dwell_time > 60:
            dwell_bonus = 0.03

        raw_risk = (base + precursor_bonus + dwell_bonus) * zone_mult
        return max(0.0, min(1.0, raw_risk))

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    async def persist_classification(
        self,
        db: AsyncSession,
        camera_id: uuid.UUID,
        zone_id: Optional[uuid.UUID],
        track_id: Optional[int],
        classification: Dict[str, Any],
    ) -> str:
        """Save an ``IntentClassification`` row to the database.

        Returns the UUID string of the created row.
        """
        traj = classification.get("trajectory_analysis", {})

        record = IntentClassification(
            camera_id=camera_id,
            zone_id=zone_id,
            track_id=track_id,
            intent_category=classification["intent_category"],
            confidence=classification["confidence"],
            trajectory_points=classification.get("trajectory_analysis", {}).get("_raw_points"),
            dwell_time_seconds=classification.get("dwell_time", 0.0),
            approach_speed=traj.get("approach_speed"),
            direction_changes=traj.get("direction_changes", 0),
            gaze_direction_variance=traj.get("speed_variance"),
            near_restricted_area=classification.get("zone_type") in ("restricted", "server_room"),
            precursor_indicators=classification.get("precursor_indicators", []),
            risk_score=classification["risk_score"],
        )
        db.add(record)
        await db.flush()

        record_id = str(record.id)
        logger.info(
            "Persisted IntentClassification %s: %s (risk=%.2f) cam=%s track=%s",
            record_id,
            classification["intent_category"],
            classification["risk_score"],
            camera_id,
            track_id,
        )
        return record_id

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _determine_intent(
        self,
        traj: Dict[str, Any],
        dwell_time: float,
        zone_type: str,
        precursors: List[str],
        detections: Dict[str, Any],
    ) -> Tuple[str, float]:
        """Rule-based intent determination from trajectory analysis,
        precursors, zone type, and detections.

        Returns (intent_category, confidence).
        """
        direction_changes = traj.get("direction_changes", 0)
        path_linearity = traj.get("path_linearity", 1.0)
        approach_speed = traj.get("approach_speed", 0)
        avg_speed = traj.get("avg_speed", 0)
        is_circling = traj.get("is_circling", False)
        duration = traj.get("duration_seconds", 0)

        precursor_set = set(precursors)
        n_precursors = len(precursors)

        # Forced entry: very fast approach toward restricted area
        if zone_type in ("restricted", "entry", "server_room"):
            if approach_speed > 100 and path_linearity > 0.7:
                return ("forced_entry", 0.80)

        # Evasive approach: low linearity + hiding/counter-surveillance
        evasive_indicators = {"hiding", "counter_surveillance", "distraction_behavior"}
        if len(precursor_set & evasive_indicators) >= 2:
            return ("evasive_approach", 0.75)
        if path_linearity < 0.25 and direction_changes >= 5 and zone_type in ("restricted", "server_room"):
            return ("evasive_approach", 0.70)

        # Reconnaissance: circling, looking around, testing access, pacing
        recon_indicators = {"looking_around", "testing_access", "pacing", "photographing", "perimeter_probing"}
        recon_matches = len(precursor_set & recon_indicators)
        if recon_matches >= 3:
            return ("reconnaissance", min(0.60 + recon_matches * 0.08, 0.95))
        if is_circling and n_precursors >= 2:
            return ("reconnaissance", 0.70)
        if recon_matches >= 2 and zone_type in ("restricted", "server_room", "parking"):
            return ("reconnaissance", 0.65)

        # Loitering suspicious: high dwell + suspicious precursors
        if dwell_time > 120 and n_precursors >= 2:
            return ("loitering_suspicious", 0.65)
        if dwell_time > 180 and zone_type in ("restricted", "server_room"):
            return ("loitering_suspicious", 0.60)

        # Loitering benign: high dwell but no suspicious precursors
        if dwell_time > 60 and n_precursors <= 1:
            return ("loitering_benign", 0.55)

        # Delivery: linear approach, moderate speed, short dwell
        if path_linearity > 0.7 and dwell_time < 120 and zone_type in ("entry", "exit", "general"):
            objects = detections.get("objects", [])
            carrying = any(
                (o.get("class") or "").lower() in ("backpack", "suitcase", "handbag", "box")
                for o in objects
            )
            if carrying:
                return ("delivery", 0.60)

        # Authorized access: very linear, fast approach to entry, short dwell
        if path_linearity > 0.8 and dwell_time < 30 and zone_type in ("entry", "restricted"):
            return ("authorized_access", 0.55)

        # Casual passerby: linear, brief, no precursors
        if path_linearity > 0.6 and dwell_time < 30 and n_precursors == 0:
            return ("casual_passerby", 0.70)

        # Default fallback: look at precursor count
        if n_precursors >= 3:
            return ("reconnaissance", 0.50)
        if n_precursors >= 1:
            return ("loitering_suspicious", 0.40)

        return ("casual_passerby", 0.45)

    def _build_explanation(
        self,
        intent_category: str,
        confidence: float,
        risk_score: float,
        precursors: List[str],
        traj: Dict[str, Any],
        zone_type: str,
        dwell_time: float,
    ) -> str:
        """Generate a human-readable explanation of the classification."""
        parts: List[str] = []

        # Intent summary
        intent_labels = {
            "authorized_access": "Authorized access pattern detected",
            "casual_passerby": "Casual passerby behavior",
            "delivery": "Delivery or logistics activity",
            "reconnaissance": "Potential reconnaissance behavior",
            "evasive_approach": "Evasive or covert approach pattern",
            "forced_entry": "Aggressive/forced entry trajectory",
            "loitering_benign": "Benign loitering",
            "loitering_suspicious": "Suspicious loitering behavior",
        }
        parts.append(
            f"{intent_labels.get(intent_category, intent_category)} "
            f"(confidence {confidence:.0%})."
        )

        # Zone context
        if zone_type in ("restricted", "server_room"):
            parts.append(f"Entity is in a {zone_type} zone, which elevates concern.")

        # Trajectory highlights
        if traj.get("is_circling"):
            parts.append("Entity appears to be circling the area.")
        if traj.get("direction_changes", 0) >= 4:
            parts.append(
                f"Frequent direction changes ({traj['direction_changes']}) suggest non-purposeful movement."
            )
        if traj.get("path_linearity", 1) < 0.3:
            parts.append("Movement path is highly non-linear.")

        # Dwell
        if dwell_time > 120:
            parts.append(f"Extended dwell time of {dwell_time:.0f} seconds.")

        # Precursors
        if precursors:
            formatted = ", ".join(p.replace("_", " ") for p in precursors)
            parts.append(f"Pre-incident indicators: {formatted}.")

        # Risk
        risk_label = "low"
        if risk_score >= 0.8:
            risk_label = "critical"
        elif risk_score >= 0.6:
            risk_label = "high"
        elif risk_score >= 0.35:
            risk_label = "moderate"
        parts.append(f"Overall risk: {risk_label} ({risk_score:.0%}).")

        return " ".join(parts)


# ── Module-level singleton ───────────────────────────────────────────

intent_classifier = IntentClassifier()
