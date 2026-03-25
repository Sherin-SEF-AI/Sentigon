"""Smoke, Fire & Safety Detection Service — Phase 3D.

Detects person-down incidents, mass egress events, slip/fall hazards,
and fire/smoke progression from YOLO detections and optional Gemini
scene analysis.  Maintains slip/fall hotspot zones on a per-camera
grid and provides safety event queries and statistics.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select, func, and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Camera, Zone
from backend.models.phase3_models import SafetyEvent, SlipFallZone
from backend.services.alert_manager import alert_manager

logger = structlog.get_logger()

# Fire/smoke keywords used for Gemini analysis parsing
_FIRE_KEYWORDS = {
    "fire", "flame", "flames", "burning", "blaze", "inferno",
    "combustion", "ignition", "engulfed",
}
_SMOKE_KEYWORDS = {
    "smoke", "haze", "smog", "fumes", "smoky", "visibility",
    "cloudy", "obscured",
}
_SPREAD_KEYWORDS = {
    "spreading", "spread", "engulfing", "expanding", "progressing",
    "out of control", "escalating",
}

# Grid size for slip/fall zone tracking
_GRID_SIZE = 10

# Risk level thresholds by incident count
_RISK_THRESHOLDS = {
    "low": (0, 1),
    "moderate": (2, 4),
    "high": (5, 9),
    "critical": (10, float("inf")),
}


class SafetyDetectionService:
    """Detects safety events: fire, falls, medical distress, mass egress."""

    FIRE_STAGES = ["smoke", "flame", "fire_spread"]
    SAFETY_EVENT_TYPES = [
        "smoke", "flame", "fire_spread", "person_down",
        "medical_distress", "mass_egress", "slip_fall",
    ]

    # Severity per event type
    _TYPE_SEVERITY = {
        "smoke": "high",
        "flame": "critical",
        "fire_spread": "critical",
        "person_down": "high",
        "medical_distress": "high",
        "mass_egress": "critical",
        "slip_fall": "medium",
    }

    def __init__(self) -> None:
        # Store previous-frame detections per camera for motion analysis
        self._prev_detections: Dict[str, List[dict]] = {}
        # Recent person_down locations to avoid duplicates within 60s
        self._recent_person_down: Dict[str, datetime] = {}

    # ── Main analysis entry point ────────────────────────────────

    async def analyze_frame(
        self,
        db: AsyncSession,
        camera_id: str,
        zone_id: str | None,
        detections: list[dict],
        gemini_analysis: dict | None = None,
    ) -> list[dict]:
        """Analyze a frame for safety events.  Returns list of detected events."""
        now = datetime.now(timezone.utc)
        results: list[dict] = []
        cam_key = str(camera_id)

        prev_dets = self._prev_detections.get(cam_key)
        person_detections = [d for d in detections if d.get("class") == "person"]

        # --- 1. Person down detection ---
        person_down = await self.detect_person_down(detections)
        if person_down:
            dedup_key = f"{cam_key}:person_down"
            last_pd = self._recent_person_down.get(dedup_key)
            if not last_pd or (now - last_pd).total_seconds() > 60:
                self._recent_person_down[dedup_key] = now

                # Determine if this is a slip/fall (sudden transition) vs static
                is_slip_fall = False
                if prev_dets:
                    slip = await self.detect_slip_fall(person_detections, prev_dets)
                    if slip:
                        is_slip_fall = True
                        # Track slip/fall zone
                        bbox = person_down.get("bbox", [0, 0, 0, 0])
                        loc_x = (bbox[0] + bbox[2]) / 2
                        loc_y = (bbox[1] + bbox[3]) / 2
                        await self.track_slip_fall_zones(
                            db, camera_id, zone_id, loc_x, loc_y
                        )

                event_type = "slip_fall" if is_slip_fall else "person_down"
                severity = self._TYPE_SEVERITY.get(event_type, "high")

                safety_event = SafetyEvent(
                    event_type=event_type,
                    camera_id=uuid.UUID(str(camera_id)),
                    zone_id=uuid.UUID(str(zone_id)) if zone_id else None,
                    severity=severity,
                    confidence=round(person_down["confidence"], 4),
                    person_count_involved=1,
                    bounding_boxes=[person_down["bbox"]],
                    location_x=person_down.get("location_x"),
                    location_y=person_down.get("location_y"),
                    metadata_={"is_fallen": person_down["is_fallen"]},
                )
                db.add(safety_event)
                await db.flush()

                # Create alert
                cam_name = await self._get_camera_name(db, camera_id)
                zone_name = await self._get_zone_name(db, zone_id) if zone_id else ""

                alert_result = await alert_manager.create_alert(
                    title=f"{'Slip/Fall' if is_slip_fall else 'Person down'} detected",
                    description=(
                        f"A person appears to have {'fallen' if is_slip_fall else 'collapsed'} "
                        f"at camera {cam_name}. Confidence: {person_down['confidence']:.0%}."
                    ),
                    severity=severity,
                    threat_type=event_type,
                    source_camera=cam_name,
                    zone_name=zone_name,
                    confidence=round(person_down["confidence"], 4),
                    metadata={"event_id": str(safety_event.id)},
                )
                if alert_result:
                    safety_event.alert_id = uuid.UUID(alert_result["id"])

                event_dict = {
                    "event_type": event_type,
                    "severity": severity,
                    "confidence": round(person_down["confidence"], 4),
                    "bbox": person_down["bbox"],
                    "event_id": str(safety_event.id),
                }
                results.append(event_dict)

        # --- 2. Mass egress detection ---
        if len(person_detections) >= 5:
            egress = await self.detect_mass_egress(person_detections, prev_dets)
            if egress:
                safety_event = SafetyEvent(
                    event_type="mass_egress",
                    camera_id=uuid.UUID(str(camera_id)),
                    zone_id=uuid.UUID(str(zone_id)) if zone_id else None,
                    severity="critical",
                    confidence=round(egress["confidence"], 4),
                    person_count_involved=egress["person_count"],
                    egress_direction=egress["direction"],
                    egress_speed=round(egress["avg_speed"], 2),
                    metadata_={
                        "person_count": egress["person_count"],
                        "direction_vector": egress.get("direction_vector"),
                    },
                )
                db.add(safety_event)
                await db.flush()

                cam_name = await self._get_camera_name(db, camera_id)
                zone_name = await self._get_zone_name(db, zone_id) if zone_id else ""

                alert_result = await alert_manager.create_alert(
                    title=f"Mass egress: {egress['person_count']} people moving {egress['direction']}",
                    description=(
                        f"{egress['person_count']} persons detected moving rapidly "
                        f"{egress['direction']} at camera {cam_name}. "
                        f"Average speed: {egress['avg_speed']:.1f} px/frame."
                    ),
                    severity="critical",
                    threat_type="mass_egress",
                    source_camera=cam_name,
                    zone_name=zone_name,
                    confidence=round(egress["confidence"], 4),
                    metadata={"event_id": str(safety_event.id)},
                )
                if alert_result:
                    safety_event.alert_id = uuid.UUID(alert_result["id"])

                results.append({
                    "event_type": "mass_egress",
                    "severity": "critical",
                    "confidence": round(egress["confidence"], 4),
                    "person_count": egress["person_count"],
                    "direction": egress["direction"],
                    "event_id": str(safety_event.id),
                })

        # --- 3. Fire/smoke from Gemini analysis ---
        if gemini_analysis:
            fire_info = await self.detect_fire_indicators(gemini_analysis)
            if fire_info:
                severity = "critical" if fire_info["stage"] in ("flame", "fire_spread") else "high"
                safety_event = SafetyEvent(
                    event_type=fire_info["stage"],
                    camera_id=uuid.UUID(str(camera_id)),
                    zone_id=uuid.UUID(str(zone_id)) if zone_id else None,
                    severity=severity,
                    confidence=round(fire_info["confidence"], 4),
                    detection_stage=fire_info["stage"],
                    metadata_={
                        "description": fire_info["description"],
                        "matched_keywords": fire_info.get("matched_keywords", []),
                    },
                )
                db.add(safety_event)
                await db.flush()

                cam_name = await self._get_camera_name(db, camera_id)
                zone_name = await self._get_zone_name(db, zone_id) if zone_id else ""

                alert_result = await alert_manager.create_alert(
                    title=f"Fire alert: {fire_info['stage']} detected",
                    description=fire_info["description"],
                    severity=severity,
                    threat_type=fire_info["stage"],
                    source_camera=cam_name,
                    zone_name=zone_name,
                    confidence=round(fire_info["confidence"], 4),
                    metadata={"event_id": str(safety_event.id)},
                )
                if alert_result:
                    safety_event.alert_id = uuid.UUID(alert_result["id"])

                results.append({
                    "event_type": fire_info["stage"],
                    "severity": severity,
                    "confidence": round(fire_info["confidence"], 4),
                    "stage": fire_info["stage"],
                    "event_id": str(safety_event.id),
                })

        # Store current detections for next-frame comparison
        self._prev_detections[cam_key] = person_detections

        if results:
            logger.info(
                "safety.events_detected",
                camera_id=str(camera_id)[:8],
                event_count=len(results),
                types=[r["event_type"] for r in results],
            )

        return results

    # ── Person down detection ────────────────────────────────────

    async def detect_person_down(self, detections: list[dict]) -> dict | None:
        """Detect a fallen person from YOLO detections.

        A person bbox where height < width * 0.6 (horizontal body)
        and the bottom of the bbox is in the lower portion of the frame
        (y2 > 80% of estimated frame height).
        """
        person_dets = [d for d in detections if d.get("class") == "person"]
        if not person_dets:
            return None

        # Estimate frame height from the maximum y2 across all detections
        max_y = max(d.get("bbox", [0, 0, 0, 0])[3] for d in detections)
        frame_h_est = max(max_y, 480)

        for det in person_dets:
            bbox = det.get("bbox", [0, 0, 0, 0])
            x1, y1, x2, y2 = bbox
            width = max(x2 - x1, 1)
            height = max(y2 - y1, 1)

            # Person is horizontal: height is less than 60% of width
            is_horizontal = height < width * 0.6

            # Person is near ground level (bottom of frame)
            near_ground = y2 > frame_h_est * 0.75

            if is_horizontal and near_ground:
                # Confidence based on aspect ratio deviation
                aspect = height / width
                confidence = min(0.55 + (0.6 - aspect) * 1.5, 0.95)
                confidence = max(confidence, 0.40)

                loc_x = (x1 + x2) / 2
                loc_y = (y1 + y2) / 2

                return {
                    "confidence": round(confidence, 4),
                    "bbox": bbox,
                    "is_fallen": True,
                    "location_x": loc_x,
                    "location_y": loc_y,
                    "aspect_ratio": round(aspect, 3),
                }

        return None

    # ── Slip/fall detection (frame-to-frame) ─────────────────────

    async def detect_slip_fall(
        self,
        current_persons: list[dict],
        prev_persons: list[dict] | None,
    ) -> dict | None:
        """Detect a sudden position change from standing to ground level.

        Compares tracked persons between consecutive frames.  A slip/fall
        is identified when a person's bbox center Y drops by >30% of
        their previous height within one frame interval.
        """
        if not prev_persons:
            return None

        # Build lookup for previous frame by track_id
        prev_by_track: Dict[int, dict] = {}
        for d in prev_persons:
            tid = d.get("track_id")
            if tid is not None:
                prev_by_track[tid] = d

        for cur in current_persons:
            tid = cur.get("track_id")
            if tid is None or tid not in prev_by_track:
                continue

            prev = prev_by_track[tid]
            cur_bbox = cur.get("bbox", [0, 0, 0, 0])
            prev_bbox = prev.get("bbox", [0, 0, 0, 0])

            cur_cy = (cur_bbox[1] + cur_bbox[3]) / 2
            prev_cy = (prev_bbox[1] + prev_bbox[3]) / 2
            prev_h = max(prev_bbox[3] - prev_bbox[1], 1)
            cur_h = max(cur_bbox[3] - cur_bbox[1], 1)
            cur_w = max(cur_bbox[2] - cur_bbox[0], 1)

            # Y center dropped significantly (person fell downward in frame)
            y_drop = cur_cy - prev_cy
            y_drop_ratio = y_drop / prev_h

            # Also check if aspect ratio changed from vertical to horizontal
            prev_aspect = (prev_bbox[3] - prev_bbox[1]) / max(prev_bbox[2] - prev_bbox[0], 1)
            cur_aspect = cur_h / cur_w

            # Criteria: y center dropped >30% of previous height AND
            # aspect ratio went from upright (>1.5) to horizontal (<1.0)
            if y_drop_ratio > 0.30 and prev_aspect > 1.5 and cur_aspect < 1.0:
                confidence = min(0.60 + y_drop_ratio * 0.5, 0.95)
                return {
                    "track_id": tid,
                    "y_drop_ratio": round(y_drop_ratio, 3),
                    "prev_aspect": round(prev_aspect, 3),
                    "cur_aspect": round(cur_aspect, 3),
                    "confidence": round(confidence, 4),
                }

        return None

    # ── Mass egress detection ────────────────────────────────────

    async def detect_mass_egress(
        self,
        detections: list[dict],
        prev_detections: list[dict] | None = None,
    ) -> dict | None:
        """Detect sudden mass movement toward exits.

        Requires 5+ persons with similar movement direction vectors
        and speed exceeding normal walking pace.
        """
        if not prev_detections or len(detections) < 5:
            return None

        # Build previous frame lookup by track_id
        prev_by_track: Dict[int, dict] = {}
        for d in prev_detections:
            tid = d.get("track_id")
            if tid is not None and d.get("class") == "person":
                prev_by_track[tid] = d

        # Compute motion vectors for all tracked persons
        motion_vectors: List[Dict[str, Any]] = []
        for cur in detections:
            tid = cur.get("track_id")
            if tid is None or tid not in prev_by_track:
                continue

            prev = prev_by_track[tid]
            cur_cx, cur_cy = cur.get("center", [0, 0])
            prev_cx, prev_cy = prev.get("center", [0, 0])

            dx = cur_cx - prev_cx
            dy = cur_cy - prev_cy
            speed = math.sqrt(dx ** 2 + dy ** 2)

            if speed > 3:  # Minimum movement threshold (pixels/frame)
                angle = math.atan2(dy, dx)
                motion_vectors.append({
                    "track_id": tid,
                    "dx": dx,
                    "dy": dy,
                    "speed": speed,
                    "angle": angle,
                })

        if len(motion_vectors) < 5:
            return None

        # Find dominant direction: bucket angles into 8 quadrants (45 degrees each)
        buckets: Dict[int, List[Dict]] = defaultdict(list)
        for mv in motion_vectors:
            bucket = int((mv["angle"] + math.pi) / (math.pi / 4)) % 8
            buckets[bucket].append(mv)

        # Find the largest bucket
        largest_bucket_id = max(buckets, key=lambda k: len(buckets[k]))
        aligned = buckets[largest_bucket_id]

        # Also count adjacent buckets (people moving in roughly same direction)
        adjacent_left = (largest_bucket_id - 1) % 8
        adjacent_right = (largest_bucket_id + 1) % 8
        aligned_total = aligned + buckets.get(adjacent_left, []) + buckets.get(adjacent_right, [])

        if len(aligned_total) < 5:
            return None

        # Check speed threshold (faster than normal walking ~15 px/frame)
        avg_speed = sum(mv["speed"] for mv in aligned_total) / len(aligned_total)
        fast_movers = [mv for mv in aligned_total if mv["speed"] > 10]

        if len(fast_movers) < 5:
            return None

        # Determine dominant direction name
        avg_dx = sum(mv["dx"] for mv in aligned_total) / len(aligned_total)
        avg_dy = sum(mv["dy"] for mv in aligned_total) / len(aligned_total)
        direction = self._direction_name(avg_dx, avg_dy)

        confidence = min(0.50 + len(aligned_total) * 0.05 + avg_speed * 0.005, 0.95)

        return {
            "person_count": len(aligned_total),
            "direction": direction,
            "avg_speed": round(avg_speed, 2),
            "confidence": round(confidence, 4),
            "direction_vector": [round(avg_dx, 2), round(avg_dy, 2)],
        }

    @staticmethod
    def _direction_name(dx: float, dy: float) -> str:
        """Convert a motion vector to a human-readable direction."""
        angle = math.degrees(math.atan2(dy, dx))
        if -22.5 <= angle < 22.5:
            return "toward_right_exit"
        elif 22.5 <= angle < 67.5:
            return "toward_lower_right"
        elif 67.5 <= angle < 112.5:
            return "toward_exit"  # downward in frame = toward camera exit
        elif 112.5 <= angle < 157.5:
            return "toward_lower_left"
        elif angle >= 157.5 or angle < -157.5:
            return "toward_left_exit"
        elif -157.5 <= angle < -112.5:
            return "toward_upper_left"
        elif -112.5 <= angle < -67.5:
            return "away_from"  # upward in frame = away from camera
        else:
            return "toward_upper_right"

    # ── Fire / smoke indicators from Gemini ──────────────────────

    async def detect_fire_indicators(self, gemini_analysis: dict) -> dict | None:
        """Extract fire/smoke indicators from Gemini scene analysis.

        Parses the analysis text for fire/smoke keywords and determines
        the fire stage: smoke (early) -> flame (active) -> fire_spread.
        """
        if not gemini_analysis:
            return None

        # Extract text from various analysis formats
        text = ""
        if isinstance(gemini_analysis, dict):
            text = " ".join(str(v) for v in gemini_analysis.values()).lower()
        elif isinstance(gemini_analysis, str):
            text = gemini_analysis.lower()
        else:
            return None

        if not text:
            return None

        # Count keyword matches
        fire_matches = [kw for kw in _FIRE_KEYWORDS if kw in text]
        smoke_matches = [kw for kw in _SMOKE_KEYWORDS if kw in text]
        spread_matches = [kw for kw in _SPREAD_KEYWORDS if kw in text]

        all_matches = fire_matches + smoke_matches + spread_matches
        if not all_matches:
            return None

        # Determine stage
        if spread_matches and fire_matches:
            stage = "fire_spread"
            confidence = min(0.70 + len(all_matches) * 0.05, 0.95)
            description = (
                f"Fire spreading detected. Keywords matched: "
                f"{', '.join(all_matches)}."
            )
        elif fire_matches:
            stage = "flame"
            confidence = min(0.60 + len(fire_matches) * 0.08, 0.95)
            description = (
                f"Active flame detected. Keywords matched: "
                f"{', '.join(fire_matches)}."
            )
        elif smoke_matches:
            stage = "smoke"
            confidence = min(0.50 + len(smoke_matches) * 0.10, 0.90)
            description = (
                f"Smoke or haze detected (early fire warning). Keywords: "
                f"{', '.join(smoke_matches)}."
            )
        else:
            return None

        return {
            "stage": stage,
            "confidence": round(confidence, 4),
            "description": description,
            "matched_keywords": all_matches,
        }

    # ── Slip/fall zone tracking ──────────────────────────────────

    async def track_slip_fall_zones(
        self,
        db: AsyncSession,
        camera_id: str,
        zone_id: str | None,
        location_x: float,
        location_y: float,
    ) -> None:
        """Update slip/fall zone tracking.

        Increments the incident count for the grid cell containing the
        given location coordinates and updates the risk level.
        """
        # Map continuous coordinates to a 10x10 grid
        # Assuming location is in pixel space; normalize to grid
        grid_x = min(int(location_x / 100) % _GRID_SIZE, _GRID_SIZE - 1)
        grid_y = min(int(location_y / 100) % _GRID_SIZE, _GRID_SIZE - 1)
        now = datetime.now(timezone.utc)

        # Try to find existing zone cell
        result = await db.execute(
            select(SlipFallZone).where(
                and_(
                    SlipFallZone.camera_id == uuid.UUID(str(camera_id)),
                    SlipFallZone.grid_x == grid_x,
                    SlipFallZone.grid_y == grid_y,
                )
            )
        )
        cell = result.scalar_one_or_none()

        if cell:
            cell.incident_count = (cell.incident_count or 0) + 1
            cell.last_incident_at = now
            count = cell.incident_count
        else:
            cell = SlipFallZone(
                camera_id=uuid.UUID(str(camera_id)),
                zone_id=uuid.UUID(str(zone_id)) if zone_id else None,
                grid_x=grid_x,
                grid_y=grid_y,
                incident_count=1,
                last_incident_at=now,
                risk_level="low",
            )
            db.add(cell)
            count = 1

        # Update risk level based on incident count
        if count >= 10:
            cell.risk_level = "critical"
        elif count >= 5:
            cell.risk_level = "high"
        elif count >= 2:
            cell.risk_level = "moderate"
        else:
            cell.risk_level = "low"

        await db.flush()
        logger.debug(
            "safety.slip_fall_zone_updated",
            camera_id=str(camera_id)[:8],
            grid=f"({grid_x},{grid_y})",
            count=count,
            risk=cell.risk_level,
        )

    # ── Query endpoints ──────────────────────────────────────────

    async def get_slip_fall_hotspots(
        self, db: AsyncSession, camera_id: str | None = None
    ) -> list[dict]:
        """Get slip/fall hotspot zones ranked by incident count."""
        query = select(SlipFallZone).where(SlipFallZone.incident_count > 0)

        if camera_id:
            query = query.where(
                SlipFallZone.camera_id == uuid.UUID(str(camera_id))
            )

        query = query.order_by(SlipFallZone.incident_count.desc()).limit(50)
        result = await db.execute(query)
        zones = result.scalars().all()

        hotspots = []
        for z in zones:
            cam_name = await self._get_camera_name(db, str(z.camera_id))
            hotspots.append({
                "id": str(z.id),
                "camera_id": str(z.camera_id),
                "camera_name": cam_name,
                "zone_id": str(z.zone_id) if z.zone_id else None,
                "grid_x": z.grid_x,
                "grid_y": z.grid_y,
                "incident_count": z.incident_count,
                "risk_level": z.risk_level,
                "last_incident": z.last_incident_at.isoformat() if z.last_incident_at else None,
            })
        return hotspots

    async def get_safety_events(
        self,
        db: AsyncSession,
        event_type: str | None = None,
        hours: int = 24,
        limit: int = 200,
    ) -> list[dict]:
        """Get recent safety events with optional type filter."""
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

        query = select(SafetyEvent).where(SafetyEvent.created_at >= cutoff)
        if event_type:
            query = query.where(SafetyEvent.event_type == event_type)

        query = query.order_by(SafetyEvent.created_at.desc()).limit(limit)
        result = await db.execute(query)
        events = result.scalars().all()

        return [self._serialize_event(e) for e in events]

    async def get_safety_event(
        self,
        db: AsyncSession,
        event_id: str,
    ) -> dict | None:
        """Get a single safety event by ID."""
        result = await db.execute(
            select(SafetyEvent).where(SafetyEvent.id == uuid.UUID(str(event_id)))
        )
        event = result.scalar_one_or_none()
        if not event:
            return None
        return self._serialize_event(event)

    @staticmethod
    def _serialize_event(e: SafetyEvent) -> dict:
        """Serialize a SafetyEvent model instance to a dict."""
        return {
            "id": str(e.id),
            "event_type": e.event_type,
            "camera_id": str(e.camera_id),
            "zone_id": str(e.zone_id) if e.zone_id else None,
            "severity": e.severity,
            "confidence": e.confidence,
            "detection_stage": e.detection_stage,
            "person_count_involved": e.person_count_involved,
            "egress_direction": e.egress_direction,
            "egress_speed": e.egress_speed,
            "resolved": e.resolved,
            "created_at": e.created_at.isoformat() if e.created_at else None,
            "location_x": e.location_x,
            "location_y": e.location_y,
        }

    async def get_stats(self, db: AsyncSession) -> dict:
        """Safety stats: events by type, hotspot count, active fire alerts."""
        cutoff_24h = datetime.now(timezone.utc) - timedelta(hours=24)
        cutoff_7d = datetime.now(timezone.utc) - timedelta(days=7)

        # Events by type (24h)
        rtype = await db.execute(
            select(
                SafetyEvent.event_type,
                func.count(SafetyEvent.id),
            )
            .where(SafetyEvent.created_at >= cutoff_24h)
            .group_by(SafetyEvent.event_type)
        )
        by_type_24h = {row[0]: row[1] for row in rtype.all()}

        # Events by type (7d)
        rtype7 = await db.execute(
            select(
                SafetyEvent.event_type,
                func.count(SafetyEvent.id),
            )
            .where(SafetyEvent.created_at >= cutoff_7d)
            .group_by(SafetyEvent.event_type)
        )
        by_type_7d = {row[0]: row[1] for row in rtype7.all()}

        # Total events
        rtotal = await db.execute(
            select(func.count(SafetyEvent.id)).where(
                SafetyEvent.created_at >= cutoff_24h
            )
        )
        total_24h = rtotal.scalar() or 0

        # Active fire alerts (unresolved fire/smoke events in last 4 hours)
        fire_cutoff = datetime.now(timezone.utc) - timedelta(hours=4)
        rfire = await db.execute(
            select(func.count(SafetyEvent.id)).where(
                and_(
                    SafetyEvent.created_at >= fire_cutoff,
                    SafetyEvent.event_type.in_(["smoke", "flame", "fire_spread"]),
                    SafetyEvent.resolved == False,  # noqa: E712
                )
            )
        )
        active_fire = rfire.scalar() or 0

        # Hotspot count (zones with risk >= moderate)
        rhotspot = await db.execute(
            select(func.count(SlipFallZone.id)).where(
                SlipFallZone.risk_level.in_(["moderate", "high", "critical"])
            )
        )
        hotspot_count = rhotspot.scalar() or 0

        # Person down events (24h)
        rpd = await db.execute(
            select(func.count(SafetyEvent.id)).where(
                and_(
                    SafetyEvent.created_at >= cutoff_24h,
                    SafetyEvent.event_type.in_(["person_down", "slip_fall"]),
                )
            )
        )
        person_down_24h = rpd.scalar() or 0

        return {
            "total_events_24h": total_24h,
            "events_by_type_24h": by_type_24h,
            "events_by_type_7d": by_type_7d,
            "active_fire_alerts": active_fire,
            "slip_fall_hotspot_count": hotspot_count,
            "person_down_events_24h": person_down_24h,
        }

    # ── Helpers ──────────────────────────────────────────────────

    async def _get_camera_name(self, db: AsyncSession, camera_id: str) -> str:
        """Resolve camera UUID to name."""
        try:
            result = await db.execute(
                select(Camera.name).where(Camera.id == uuid.UUID(str(camera_id)))
            )
            return result.scalar_one_or_none() or str(camera_id)[:8]
        except Exception:
            return str(camera_id)[:8]

    async def _get_zone_name(self, db: AsyncSession, zone_id: str) -> str:
        """Resolve zone UUID to name."""
        try:
            result = await db.execute(
                select(Zone.name).where(Zone.id == uuid.UUID(str(zone_id)))
            )
            return result.scalar_one_or_none() or ""
        except Exception:
            return ""


# Singleton
safety_detection_service = SafetyDetectionService()
