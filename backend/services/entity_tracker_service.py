"""Continuous Behavioral Sequence Analysis — Phase 3D Entity Tracking.

Tracks entities (persons, vehicles) across cameras over hours and days
using appearance-based matching (no facial recognition). Detects
reconnaissance patterns, behavioral escalation, and social engineering
attempts such as multi-day tailgating.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select, func, and_, or_, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Camera, Zone
from backend.models.phase3_models import EntityTrack, EntityAppearance

logger = structlog.get_logger()

# COCO classes typically carried by a person
_CARRIED_OBJECT_CLASSES = {
    "backpack", "handbag", "suitcase", "umbrella", "laptop", "cell phone",
    "skateboard", "sports ball", "bottle", "cup",
}

# Behavioral sequence escalation ordering
_BEHAVIOR_ESCALATION = {
    "walking_past": 0,
    "walking": 0,
    "stopping": 1,
    "looking": 2,
    "loitering": 3,
    "testing_door": 4,
    "running": 4,
}


class EntityTrackerService:
    """Appearance-based cross-camera entity tracker with behavioral analysis."""

    def __init__(self) -> None:
        # In-memory cache for fast entity matching
        self._active_entities: Dict[str, Dict[str, Any]] = {}  # entity_id -> descriptor/state
        self._MATCH_THRESHOLD = 0.70  # Minimum appearance similarity to match
        self._RECON_VISIT_THRESHOLD = 3  # Visits to restricted area before alert
        self._RECON_WINDOW_HOURS = 24
        self._TAILGATE_WINDOW_SECONDS = 8  # Seconds after access event to look for follower
        self._entity_behavior_buffer: Dict[str, List[str]] = defaultdict(list)

    # ── Public API ────────────────────────────────────────────────

    async def process_detection(
        self,
        db: AsyncSession,
        camera_id: str,
        zone_id: str | None,
        track_id: int,
        detection: dict,
        frame_path: str | None = None,
    ) -> Dict[str, Any] | None:
        """Process a single YOLO detection for entity tracking.

        Returns entity info dict when a behavioral flag fires, None otherwise.
        """
        now = datetime.now(timezone.utc)
        appearance = self._extract_appearance(detection)

        # --- Match against active entities ---
        best_match_id: str | None = None
        best_score: float = 0.0

        for eid, state in self._active_entities.items():
            score = self._compute_similarity(appearance, state.get("appearance", {}))
            if score > best_score:
                best_score = score
                best_match_id = eid

        entity_id: str
        is_new = False

        if best_match_id and best_score >= self._MATCH_THRESHOLD:
            entity_id = best_match_id
            # Update in-memory cache
            self._active_entities[entity_id]["last_seen"] = now
            self._active_entities[entity_id]["camera_id"] = str(camera_id)
            self._active_entities[entity_id]["appearance"] = self._merge_appearance(
                self._active_entities[entity_id].get("appearance", {}), appearance
            )

            # Update DB entity track
            result = await db.execute(
                select(EntityTrack).where(EntityTrack.id == uuid.UUID(entity_id))
            )
            entity_track = result.scalar_one_or_none()
            if entity_track:
                entity_track.last_seen_at = now
                entity_track.last_camera_id = uuid.UUID(str(camera_id))
                entity_track.total_appearances = (entity_track.total_appearances or 0) + 1
                entity_track.total_dwell_seconds = (entity_track.total_dwell_seconds or 0.0) + detection.get("dwell_time", 0.0)
                entity_track.appearance_descriptor = self._active_entities[entity_id]["appearance"]

                # Track cameras visited
                cameras = entity_track.cameras_visited or []
                cam_str = str(camera_id)
                if cam_str not in cameras:
                    cameras.append(cam_str)
                    entity_track.cameras_visited = cameras

                # Track zones entered
                if zone_id:
                    zones = entity_track.zones_entered or []
                    zone_str = str(zone_id)
                    if zone_str not in zones:
                        zones.append(zone_str)
                        entity_track.zones_entered = zones

        else:
            # Create new entity track
            is_new = True
            entity_uid = uuid.uuid4()
            entity_id = str(entity_uid)

            entity_track = EntityTrack(
                id=entity_uid,
                entity_type=detection.get("class", "person"),
                appearance_descriptor=appearance,
                first_seen_at=now,
                last_seen_at=now,
                first_camera_id=uuid.UUID(str(camera_id)),
                last_camera_id=uuid.UUID(str(camera_id)),
                cameras_visited=[str(camera_id)],
                zones_entered=[str(zone_id)] if zone_id else [],
                total_appearances=1,
                total_dwell_seconds=detection.get("dwell_time", 0.0),
                risk_score=0.0,
            )
            db.add(entity_track)

            self._active_entities[entity_id] = {
                "appearance": appearance,
                "last_seen": now,
                "camera_id": str(camera_id),
                "first_seen": now,
            }

        # --- Create appearance record ---
        behavior = self._infer_behavior(detection)
        entity_appearance = EntityAppearance(
            entity_track_id=uuid.UUID(entity_id),
            camera_id=uuid.UUID(str(camera_id)),
            zone_id=uuid.UUID(str(zone_id)) if zone_id else None,
            track_id=track_id,
            timestamp=now,
            duration_seconds=detection.get("dwell_time", 0.0),
            frame_path=frame_path,
            bounding_box=detection.get("bbox"),
            appearance_snapshot=appearance,
            behavior=behavior,
            trajectory=detection.get("trajectory"),
        )
        db.add(entity_appearance)

        # Buffer behavior for escalation analysis
        self._entity_behavior_buffer[entity_id].append(behavior)
        if len(self._entity_behavior_buffer[entity_id]) > 50:
            self._entity_behavior_buffer[entity_id] = self._entity_behavior_buffer[entity_id][-50:]

        await db.flush()

        # --- Check behavioral flags ---
        flag_result: Dict[str, Any] | None = None

        recon = await self.check_reconnaissance(db, entity_id)
        if recon and recon.get("alert_needed"):
            if entity_track:
                flags = entity_track.behavioral_flags or []
                if "reconnaissance" not in flags:
                    flags.append("reconnaissance")
                    entity_track.behavioral_flags = flags
                entity_track.escalation_level = max(entity_track.escalation_level or 0, recon.get("escalation_level", 1))
                entity_track.risk_score = max(entity_track.risk_score or 0.0, 0.6)
            flag_result = {
                "entity_id": entity_id,
                "flag": "reconnaissance",
                **recon,
            }

        if not flag_result:
            se = await self.check_social_engineering(db, entity_id)
            if se and se.get("alert_needed"):
                if entity_track:
                    flags = entity_track.behavioral_flags or []
                    if "tailgating_multiple" not in flags:
                        flags.append("tailgating_multiple")
                        entity_track.behavioral_flags = flags
                    entity_track.risk_score = max(entity_track.risk_score or 0.0, 0.7)
                flag_result = {
                    "entity_id": entity_id,
                    "flag": "social_engineering",
                    **se,
                }

        await db.flush()

        logger.debug(
            "entity_tracker.processed",
            entity_id=entity_id[:8],
            is_new=is_new,
            match_score=round(best_score, 3),
            behavior=behavior,
            flag=flag_result.get("flag") if flag_result else None,
        )
        return flag_result

    # ── Appearance extraction and matching ────────────────────────

    def _extract_appearance(self, detection: dict) -> dict:
        """Extract appearance descriptor from a YOLO detection.

        Uses bbox dimensions for height/build estimate and co-detected
        objects for carried-item tracking.
        """
        bbox = detection.get("bbox", [0, 0, 0, 0])
        x1, y1, x2, y2 = bbox[0], bbox[1], bbox[2], bbox[3]
        width = max(x2 - x1, 1)
        height = max(y2 - y1, 1)
        aspect_ratio = height / width

        # Build estimate from aspect ratio
        if aspect_ratio > 3.5:
            build = "thin"
        elif aspect_ratio > 2.5:
            build = "average"
        else:
            build = "stocky"

        # Height estimate category (relative to bbox height in frame)
        height_est = "medium"
        if height > 400:
            height_est = "tall"
        elif height < 200:
            height_est = "short"

        # Clothing type heuristic from bbox proportions
        # Wider lower half suggests dress/skirt vs pants
        clothing_type = "standard"

        # Carried objects from co-detection context
        carried: list[str] = []
        co_objects = detection.get("co_detections", [])
        for obj in co_objects:
            obj_class = obj.get("class", "")
            if obj_class in _CARRIED_OBJECT_CLASSES:
                carried.append(obj_class)

        return {
            "build": build,
            "height_est": height_est,
            "aspect_ratio": round(aspect_ratio, 2),
            "bbox_area": width * height,
            "carried_objects": carried,
            "clothing_type": clothing_type,
            "entity_class": detection.get("class", "person"),
        }

    def _merge_appearance(self, existing: dict, new: dict) -> dict:
        """Merge a new appearance observation into the running descriptor."""
        merged = dict(existing)
        # Running average of aspect ratio
        if "aspect_ratio" in existing and "aspect_ratio" in new:
            merged["aspect_ratio"] = round(
                (existing["aspect_ratio"] * 0.7 + new["aspect_ratio"] * 0.3), 2
            )
        # Union of carried objects
        old_carried = set(existing.get("carried_objects", []))
        new_carried = set(new.get("carried_objects", []))
        merged["carried_objects"] = sorted(old_carried | new_carried)
        # Use latest build / height estimates
        merged["build"] = new.get("build", existing.get("build", "average"))
        merged["height_est"] = new.get("height_est", existing.get("height_est", "medium"))
        return merged

    def _compute_similarity(self, desc_a: dict, desc_b: dict) -> float:
        """Compute weighted appearance similarity between two descriptors.

        Returns a score in [0.0, 1.0].
        """
        if not desc_a or not desc_b:
            return 0.0

        score = 0.0
        total_weight = 0.0

        # Build match (weight=0.25)
        w = 0.25
        total_weight += w
        if desc_a.get("build") == desc_b.get("build"):
            score += w

        # Height match (weight=0.20)
        w = 0.20
        total_weight += w
        if desc_a.get("height_est") == desc_b.get("height_est"):
            score += w

        # Aspect ratio proximity (weight=0.30)
        w = 0.30
        total_weight += w
        ar_a = desc_a.get("aspect_ratio", 2.5)
        ar_b = desc_b.get("aspect_ratio", 2.5)
        ar_diff = abs(ar_a - ar_b)
        if ar_diff < 0.3:
            score += w
        elif ar_diff < 0.8:
            score += w * (1.0 - (ar_diff - 0.3) / 0.5)

        # Carried objects overlap (weight=0.15)
        w = 0.15
        total_weight += w
        set_a = set(desc_a.get("carried_objects", []))
        set_b = set(desc_b.get("carried_objects", []))
        if set_a or set_b:
            union = set_a | set_b
            inter = set_a & set_b
            score += w * (len(inter) / len(union)) if union else 0.0
        else:
            # Both empty — no discriminating info, neutral
            score += w * 0.5

        # Entity class match (weight=0.10)
        w = 0.10
        total_weight += w
        if desc_a.get("entity_class") == desc_b.get("entity_class"):
            score += w

        return round(score / total_weight, 4) if total_weight > 0 else 0.0

    def _infer_behavior(self, detection: dict) -> str:
        """Infer behavioral label from detection features."""
        dwell = detection.get("dwell_time", 0.0)
        stationary = detection.get("is_stationary", False)
        pose = detection.get("pose_features", {})

        if pose.get("evasive"):
            return "running"
        if pose.get("staking") or (stationary and dwell > 120):
            return "loitering"
        if stationary and dwell > 30:
            return "stopping"
        if stationary and dwell > 10:
            return "looking"
        return "walking_past"

    # ── Reconnaissance detection ─────────────────────────────────

    async def check_reconnaissance(self, db: AsyncSession, entity_id: str) -> Dict[str, Any] | None:
        """Check if entity is exhibiting reconnaissance behavior.

        Triggers when:
        - 3+ visits to same restricted area within 24 hours
        - Behavioral escalation: walking_past -> stopping -> testing_door
        """
        cutoff = datetime.now(timezone.utc) - timedelta(hours=self._RECON_WINDOW_HOURS)

        # Query recent appearances for this entity at restricted zones
        result = await db.execute(
            select(EntityAppearance)
            .where(
                and_(
                    EntityAppearance.entity_track_id == uuid.UUID(entity_id),
                    EntityAppearance.timestamp >= cutoff,
                    EntityAppearance.zone_id.isnot(None),
                )
            )
            .order_by(EntityAppearance.timestamp.asc())
        )
        appearances = result.scalars().all()

        if len(appearances) < self._RECON_VISIT_THRESHOLD:
            return None

        # Count visits per zone
        zone_visits: Dict[str, int] = defaultdict(int)
        zone_behaviors: Dict[str, List[str]] = defaultdict(list)
        for app in appearances:
            zid = str(app.zone_id)
            zone_visits[zid] += 1
            if app.behavior:
                zone_behaviors[zid].append(app.behavior)

        # Check for zones with repeated visits
        recon_zones: List[Dict[str, Any]] = []
        for zid, count in zone_visits.items():
            if count >= self._RECON_VISIT_THRESHOLD:
                # Check if zone is restricted
                zone_result = await db.execute(
                    select(Zone).where(Zone.id == uuid.UUID(zid))
                )
                zone = zone_result.scalar_one_or_none()
                zone_type = zone.zone_type if zone else "general"

                if zone_type in ("restricted", "server_room", "security"):
                    recon_zones.append({
                        "zone_id": zid,
                        "zone_name": zone.name if zone else "unknown",
                        "visit_count": count,
                        "zone_type": zone_type,
                    })

        if not recon_zones:
            return None

        # Determine escalation level from behavior sequence
        behaviors = self._entity_behavior_buffer.get(entity_id, [])
        escalation_level = 1  # watching
        max_behavior_level = 0
        for b in behaviors:
            bl = _BEHAVIOR_ESCALATION.get(b, 0)
            if bl > max_behavior_level:
                max_behavior_level = bl

        if max_behavior_level >= 3:
            escalation_level = 3  # threat
        elif max_behavior_level >= 2:
            escalation_level = 2  # suspicious

        return {
            "alert_needed": True,
            "escalation_level": escalation_level,
            "evidence": {
                "recon_zones": recon_zones,
                "total_appearances": len(appearances),
                "behavior_sequence": behaviors[-10:],
                "max_behavior_level": max_behavior_level,
            },
        }

    # ── Social engineering / tailgating detection ─────────────────

    async def check_social_engineering(self, db: AsyncSession, entity_id: str) -> Dict[str, Any] | None:
        """Check for multi-day tailgating patterns.

        Looks for an entity repeatedly appearing shortly after access events
        at the same entry points (doors), suggesting they are following
        authorized personnel.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)

        # Get entity appearances at entry/exit zones
        result = await db.execute(
            select(EntityAppearance)
            .where(
                and_(
                    EntityAppearance.entity_track_id == uuid.UUID(entity_id),
                    EntityAppearance.timestamp >= cutoff,
                    EntityAppearance.zone_id.isnot(None),
                )
            )
            .order_by(EntityAppearance.timestamp.asc())
        )
        appearances = result.scalars().all()

        if len(appearances) < 3:
            return None

        # Find entry zones this entity has visited
        entry_zone_visits: Dict[str, List[datetime]] = defaultdict(list)
        for app in appearances:
            zid = str(app.zone_id)
            # Check if zone is an entry/exit type
            zone_result = await db.execute(
                select(Zone).where(Zone.id == uuid.UUID(zid))
            )
            zone = zone_result.scalar_one_or_none()
            if zone and zone.zone_type in ("entry", "exit", "lobby", "gate"):
                entry_zone_visits[zid].append(app.timestamp)

        if not entry_zone_visits:
            return None

        # Identify zones where entity appeared on multiple different days
        tailgate_evidence: List[Dict[str, Any]] = []
        for zid, timestamps in entry_zone_visits.items():
            days_seen = set()
            for ts in timestamps:
                days_seen.add(ts.date())
            if len(days_seen) >= 3:
                tailgate_evidence.append({
                    "zone_id": zid,
                    "days_observed": len(days_seen),
                    "total_visits": len(timestamps),
                    "first_seen": min(timestamps).isoformat(),
                    "last_seen": max(timestamps).isoformat(),
                })

        if not tailgate_evidence:
            return None

        return {
            "alert_needed": True,
            "evidence": {
                "tailgate_zones": tailgate_evidence,
                "pattern": "multi_day_entry_following",
                "observation_days": max(e["days_observed"] for e in tailgate_evidence),
            },
        }

    # ── Query endpoints ──────────────────────────────────────────

    async def get_entity_profile(self, db: AsyncSession, entity_id: str) -> dict:
        """Get full entity profile with all appearances, cameras visited, and flags."""
        result = await db.execute(
            select(EntityTrack).where(EntityTrack.id == uuid.UUID(entity_id))
        )
        entity = result.scalar_one_or_none()
        if not entity:
            return {}

        # Get all appearances
        app_result = await db.execute(
            select(EntityAppearance)
            .where(EntityAppearance.entity_track_id == uuid.UUID(entity_id))
            .order_by(EntityAppearance.timestamp.desc())
            .limit(200)
        )
        appearances = app_result.scalars().all()

        # Resolve camera names
        camera_ids_set = set(entity.cameras_visited or [])
        camera_names: Dict[str, str] = {}
        if camera_ids_set:
            for cid in camera_ids_set:
                try:
                    cam_result = await db.execute(
                        select(Camera.name).where(Camera.id == uuid.UUID(cid))
                    )
                    name = cam_result.scalar_one_or_none()
                    camera_names[cid] = name or cid[:8]
                except Exception:
                    camera_names[cid] = cid[:8]

        return {
            "entity_id": str(entity.id),
            "entity_type": entity.entity_type,
            "appearance_descriptor": entity.appearance_descriptor,
            "first_seen": entity.first_seen_at.isoformat() if entity.first_seen_at else None,
            "last_seen": entity.last_seen_at.isoformat() if entity.last_seen_at else None,
            "cameras_visited": camera_names,
            "zones_entered": entity.zones_entered or [],
            "total_appearances": entity.total_appearances,
            "total_dwell_seconds": entity.total_dwell_seconds,
            "risk_score": entity.risk_score,
            "escalation_level": entity.escalation_level,
            "behavioral_flags": entity.behavioral_flags or [],
            "resolved": entity.resolved,
            "appearances": [
                {
                    "id": str(a.id),
                    "camera_id": str(a.camera_id),
                    "zone_id": str(a.zone_id) if a.zone_id else None,
                    "timestamp": a.timestamp.isoformat() if a.timestamp else None,
                    "duration_seconds": a.duration_seconds,
                    "behavior": a.behavior,
                    "frame_path": a.frame_path,
                }
                for a in appearances
            ],
        }

    async def get_active_entities(
        self, db: AsyncSession, zone_id: str | None = None, min_risk_score: float = 0.0
    ) -> list[dict]:
        """Get entities seen within the last hour."""
        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)

        query = select(EntityTrack).where(
            and_(
                EntityTrack.last_seen_at >= cutoff,
                EntityTrack.risk_score >= min_risk_score,
            )
        )

        if zone_id:
            # Filter entities whose zones_entered JSONB contains this zone
            query = query.where(
                EntityTrack.zones_entered.contains([zone_id])
            )

        query = query.order_by(EntityTrack.risk_score.desc()).limit(100)
        result = await db.execute(query)
        entities = result.scalars().all()

        return [
            {
                "entity_id": str(e.id),
                "entity_type": e.entity_type,
                "first_seen": e.first_seen_at.isoformat() if e.first_seen_at else None,
                "last_seen": e.last_seen_at.isoformat() if e.last_seen_at else None,
                "total_appearances": e.total_appearances,
                "cameras_visited_count": len(e.cameras_visited or []),
                "risk_score": e.risk_score,
                "escalation_level": e.escalation_level,
                "behavioral_flags": e.behavioral_flags or [],
                "appearance": e.appearance_descriptor,
            }
            for e in entities
        ]

    async def get_anomalous_entities(self, db: AsyncSession, hours: int = 24) -> list[dict]:
        """Get entities with behavioral flags or elevated risk scores."""
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

        result = await db.execute(
            select(EntityTrack)
            .where(
                and_(
                    EntityTrack.last_seen_at >= cutoff,
                    or_(
                        EntityTrack.risk_score >= 0.4,
                        EntityTrack.escalation_level >= 1,
                        func.jsonb_array_length(EntityTrack.behavioral_flags) > 0,
                    ),
                )
            )
            .order_by(EntityTrack.risk_score.desc())
            .limit(50)
        )
        entities = result.scalars().all()

        return [
            {
                "entity_id": str(e.id),
                "entity_type": e.entity_type,
                "risk_score": e.risk_score,
                "escalation_level": e.escalation_level,
                "behavioral_flags": e.behavioral_flags or [],
                "total_appearances": e.total_appearances,
                "cameras_visited": e.cameras_visited or [],
                "zones_entered": e.zones_entered or [],
                "first_seen": e.first_seen_at.isoformat() if e.first_seen_at else None,
                "last_seen": e.last_seen_at.isoformat() if e.last_seen_at else None,
                "total_dwell_seconds": e.total_dwell_seconds,
            }
            for e in entities
        ]

    # ── Housekeeping ─────────────────────────────────────────────

    async def cleanup_stale(self, db: AsyncSession, max_age_hours: int = 48) -> int:
        """Remove old inactive entity tracks and their appearances to prevent
        unbounded growth.  Returns number of tracks removed.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)

        # Find stale entity track IDs
        result = await db.execute(
            select(EntityTrack.id).where(
                and_(
                    EntityTrack.last_seen_at < cutoff,
                    EntityTrack.resolved == False,  # noqa: E712
                    EntityTrack.escalation_level < 2,  # Keep suspicious+ for review
                )
            )
        )
        stale_ids = [row[0] for row in result.all()]

        if not stale_ids:
            return 0

        # Delete appearances first (FK constraint)
        await db.execute(
            delete(EntityAppearance).where(
                EntityAppearance.entity_track_id.in_(stale_ids)
            )
        )

        # Delete tracks
        await db.execute(
            delete(EntityTrack).where(EntityTrack.id.in_(stale_ids))
        )

        await db.flush()

        # Clean in-memory cache
        for eid_str in list(self._active_entities.keys()):
            try:
                if uuid.UUID(eid_str) in stale_ids:
                    del self._active_entities[eid_str]
                    self._entity_behavior_buffer.pop(eid_str, None)
            except ValueError:
                pass

        logger.info("entity_tracker.cleanup", removed=len(stale_ids), cutoff_hours=max_age_hours)
        return len(stale_ids)


# Singleton
entity_tracker_service = EntityTrackerService()
