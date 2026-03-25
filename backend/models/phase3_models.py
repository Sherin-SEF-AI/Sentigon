"""Phase 3 models — Context-Aware Intelligence, Alarm Management, Agentic Ops,
Advanced Detection, Privacy-First Architecture."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, Column, DateTime, Enum, Float, ForeignKey, Index, Integer,
    String, Text, func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from backend.database import Base


# ── Phase 3A: Context-Aware Intelligence ─────────────────────────────

class ActivityBaseline(Base):
    """Per-camera, per-zone, per-time-slot learned baselines."""
    __tablename__ = "activity_baselines"
    __table_args__ = (
        Index("ix_baseline_camera_slot", "camera_id", "day_of_week", "time_slot"),
        Index("ix_baseline_zone_slot", "zone_id", "day_of_week", "time_slot"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=True)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True)
    day_of_week = Column(Integer, nullable=False)  # 0=Monday..6=Sunday
    time_slot = Column(Integer, nullable=False)  # 0-95 (15-min slots, 96 per day)
    # Learned baseline metrics
    avg_person_count = Column(Float, default=0.0)
    std_person_count = Column(Float, default=0.0)
    avg_vehicle_count = Column(Float, default=0.0)
    std_vehicle_count = Column(Float, default=0.0)
    avg_movement_intensity = Column(Float, default=0.0)
    std_movement_intensity = Column(Float, default=0.0)
    avg_dwell_time = Column(Float, default=0.0)
    sample_count = Column(Integer, default=0)  # How many observations built this baseline
    # Adaptive thresholds (auto-computed)
    person_count_threshold = Column(Float, default=5.0)
    vehicle_count_threshold = Column(Float, default=3.0)
    movement_threshold = Column(Float, default=0.8)
    is_holiday = Column(Boolean, default=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ContextRule(Base):
    """Zone-type-aware context rules for spatial scoring."""
    __tablename__ = "context_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    zone_type = Column(String(50), index=True, nullable=False)  # restricted, kitchen, lobby, server_room, parking, etc.
    object_class = Column(String(100), nullable=False)  # knife, person, vehicle, backpack, etc.
    base_threat_score = Column(Float, default=0.5)  # 0.0=benign, 1.0=critical
    time_multiplier_night = Column(Float, default=1.5)  # Multiplier for nighttime (22:00-06:00)
    time_multiplier_offhours = Column(Float, default=1.2)  # Multiplier for off-hours
    dwell_escalation_seconds = Column(Integer, default=60)  # Seconds before dwell escalates score
    dwell_escalation_factor = Column(Float, default=0.3)  # How much dwell adds to score
    requires_access_event = Column(Boolean, default=False)  # Must correlate with PACS
    description = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class IntentClassification(Base):
    """Classified intent for tracked entities based on behavioral sequences."""
    __tablename__ = "intent_classifications"
    __table_args__ = (
        Index("ix_intent_camera_created", "camera_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=True)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True)
    track_id = Column(Integer, nullable=True)
    # Intent classification
    intent_category = Column(String(50), index=True)  # authorized_access, passerby, delivery, reconnaissance, evasive, forced_entry
    confidence = Column(Float, default=0.0)
    # Behavioral evidence
    trajectory_points = Column(JSONB, default=list)  # [{x, y, t}, ...]
    dwell_time_seconds = Column(Float, default=0.0)
    approach_speed = Column(Float, nullable=True)  # pixels/second
    direction_changes = Column(Integer, default=0)
    gaze_direction_variance = Column(Float, nullable=True)
    near_restricted_area = Column(Boolean, default=False)
    # Pre-incident indicators matched
    precursor_indicators = Column(JSONB, default=list)  # ["slowing_pace", "looking_around", ...]
    risk_score = Column(Float, default=0.0)  # Final computed risk
    # Resolution
    resolved = Column(Boolean, default=False)
    alert_id = Column(UUID(as_uuid=True), ForeignKey("alerts.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ── Phase 3B: Intelligent Alarm Management ───────────────────────────

class AlertFeedback(Base):
    """Operator feedback on alerts for continuous learning."""
    __tablename__ = "alert_feedbacks"
    __table_args__ = (
        Index("ix_feedback_alert", "alert_id"),
        Index("ix_feedback_camera_sig", "camera_id", "signature_name"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    alert_id = Column(UUID(as_uuid=True), ForeignKey("alerts.id"), nullable=False)
    operator_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=True)
    signature_name = Column(String(255), nullable=True)
    # Feedback
    is_true_positive = Column(Boolean, nullable=False)  # True=confirmed threat, False=false positive
    fp_reason = Column(String(100), nullable=True)  # lighting, weather, animal, authorized_person, shadow, reflection, etc.
    fp_notes = Column(Text, nullable=True)
    original_confidence = Column(Float, nullable=True)
    severity = Column(String(20), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class FalsePositiveProfile(Base):
    """Per-camera false positive learning profile."""
    __tablename__ = "false_positive_profiles"
    __table_args__ = (
        Index("ix_fp_profile_camera_sig", "camera_id", "signature_name", unique=True),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False)
    signature_name = Column(String(255), nullable=False)
    total_alerts = Column(Integer, default=0)
    true_positives = Column(Integer, default=0)
    false_positives = Column(Integer, default=0)
    tp_rate = Column(Float, default=0.5)  # true_positives / total_alerts
    # Top FP reasons
    fp_reasons = Column(JSONB, default=dict)  # {"lighting": 5, "animal": 3, ...}
    # Adaptive threshold
    original_threshold = Column(Float, default=0.35)
    adjusted_threshold = Column(Float, default=0.35)  # Auto-adjusted based on feedback
    suppressed = Column(Boolean, default=False)  # True if auto-suppressed due to high FP rate
    last_feedback_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AlarmCorrelationEvent(Base):
    """Multi-sensor correlated alarm event."""
    __tablename__ = "alarm_correlation_events"
    __table_args__ = (
        Index("ix_alarm_corr_created", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Source alarm
    source_type = Column(String(50), nullable=False)  # pacs, camera, motion_sensor, door_contact, alarm_panel
    source_id = Column(String(255), nullable=True)  # ID of the source device/sensor
    source_event_id = Column(UUID(as_uuid=True), nullable=True)
    # Correlation result
    correlated_sources = Column(JSONB, default=list)  # [{type, id, event_id, timestamp, signal}, ...]
    fusion_score = Column(Float, default=0.0)  # Combined confidence from all sensors
    sensors_expected = Column(Integer, default=1)  # How many sensors should have fired
    sensors_triggered = Column(Integer, default=1)  # How many actually fired
    cascade_match = Column(Boolean, default=True)  # Did expected cascade happen?
    # Classification
    classification = Column(String(50), default="unclassified")  # real_threat, false_alarm, equipment_fault, authorized_activity
    auto_cleared = Column(Boolean, default=False)
    clear_reason = Column(Text, nullable=True)
    # Linked alert
    alert_id = Column(UUID(as_uuid=True), ForeignKey("alerts.id"), nullable=True)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=True)
    metadata_ = Column("metadata", JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AlarmFatigueMetric(Base):
    """Track operator alarm fatigue over time."""
    __tablename__ = "alarm_fatigue_metrics"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    operator_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    period_start = Column(DateTime(timezone=True), nullable=False)
    period_end = Column(DateTime(timezone=True), nullable=False)
    total_alerts = Column(Integer, default=0)
    acknowledged_count = Column(Integer, default=0)
    avg_response_time_seconds = Column(Float, nullable=True)
    missed_count = Column(Integer, default=0)
    fatigue_score = Column(Float, default=0.0)  # 0.0=fresh, 1.0=severely fatigued
    recommended_threshold_adjustment = Column(Float, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ── Phase 3C: Agentic Security Operations ────────────────────────────

class NLAlertRule(Base):
    """Natural language defined alert rules."""
    __tablename__ = "nl_alert_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    natural_language = Column(Text, nullable=False)  # "Notify me when someone is in parking garage after midnight"
    # Parsed conditions (auto-generated from NL)
    parsed_conditions = Column(JSONB, default=dict)  # {zone_types: [...], time_start, time_end, object_classes: [...], min_count, ...}
    zone_ids = Column(JSONB, default=list)
    camera_ids = Column(JSONB, default=list)
    severity = Column(String(20), default="medium")
    notification_channels = Column(JSONB, default=list)  # ["push", "email"]
    # State
    is_active = Column(Boolean, default=True)
    last_triggered_at = Column(DateTime(timezone=True), nullable=True)
    trigger_count = Column(Integer, default=0)
    cooldown_seconds = Column(Integer, default=300)  # Min time between triggers
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class InvestigationSession(Base):
    """Agentic investigation sessions."""
    __tablename__ = "investigation_sessions"
    __table_args__ = (
        Index("ix_investigation_created", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    query_text = Column(Text, nullable=False)  # "Show me everyone who entered Building C after 10pm"
    query_type = Column(String(50), default="natural_language")  # natural_language, follow_subject, timeline
    # Parsed query
    parsed_params = Column(JSONB, default=dict)  # {locations, time_range, subjects, actions, ...}
    # Results
    status = Column(String(30), default="processing", index=True)  # processing, complete, failed, partial
    timeline = Column(JSONB, default=list)  # [{timestamp, camera, description, frame_path, evidence_type}, ...]
    subjects_found = Column(JSONB, default=list)  # [{descriptor, first_seen, last_seen, cameras, ...}, ...]
    cameras_searched = Column(JSONB, default=list)
    events_matched = Column(Integer, default=0)
    ai_narrative = Column(Text, nullable=True)  # AI-generated investigation summary
    evidence_package_id = Column(UUID(as_uuid=True), nullable=True)
    # Context
    initiated_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    incident_id = Column(UUID(as_uuid=True), nullable=True)
    processing_steps = Column(JSONB, default=list)  # [{step, status, detail, timestamp}, ...]
    duration_seconds = Column(Float, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)


class EvidencePackage(Base):
    """Exported evidence packages for investigations."""
    __tablename__ = "evidence_packages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    investigation_id = Column(UUID(as_uuid=True), ForeignKey("investigation_sessions.id"), nullable=True)
    incident_id = Column(UUID(as_uuid=True), nullable=True)
    title = Column(String(500), nullable=False)
    description = Column(Text, nullable=True)
    # Contents
    video_clips = Column(JSONB, default=list)  # [{camera_id, start, end, file_path}, ...]
    screenshots = Column(JSONB, default=list)  # [{camera_id, timestamp, file_path, annotations}, ...]
    access_logs = Column(JSONB, default=list)
    timeline_data = Column(JSONB, default=list)
    ai_analysis = Column(Text, nullable=True)
    # Export
    export_format = Column(String(20), default="pdf")  # pdf, zip, json
    export_path = Column(String(512), nullable=True)
    file_size_bytes = Column(Integer, nullable=True)
    hash_sha256 = Column(String(64), nullable=True)
    # Metadata
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class OperatorAttentionLog(Base):
    """Track which cameras operators are viewing for attention management."""
    __tablename__ = "operator_attention_logs"
    __table_args__ = (
        Index("ix_attention_camera_time", "camera_id", "viewed_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    operator_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False)
    viewed_at = Column(DateTime(timezone=True), server_default=func.now())
    duration_seconds = Column(Float, default=0.0)
    interaction_type = Column(String(50), default="view")  # view, ptz_control, zoom, replay


# ── Phase 3D: Advanced Detection ─────────────────────────────────────

class EntityTrack(Base):
    """Persistent entity tracking across cameras (appearance-based, no facial recognition)."""
    __tablename__ = "entity_tracks"
    __table_args__ = (
        Index("ix_entity_first_seen", "first_seen_at"),
        Index("ix_entity_last_seen", "last_seen_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_type = Column(String(30), default="person")  # person, vehicle
    # Appearance descriptor (no facial features)
    appearance_descriptor = Column(JSONB, default=dict)  # {upper_color, lower_color, hair, build, height_est, carried_objects, clothing_type, ...}
    appearance_embedding = Column(JSONB, nullable=True)  # CLIP/ReID embedding vector
    # Tracking stats
    first_seen_at = Column(DateTime(timezone=True), nullable=False)
    last_seen_at = Column(DateTime(timezone=True), nullable=False)
    first_camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=True)
    last_camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=True)
    cameras_visited = Column(JSONB, default=list)  # [camera_id, ...]
    zones_entered = Column(JSONB, default=list)  # [zone_id, ...]
    total_appearances = Column(Integer, default=1)
    total_dwell_seconds = Column(Float, default=0.0)
    # Behavioral flags
    revisit_count = Column(Integer, default=0)  # Times revisited same restricted area
    restricted_area_visits = Column(Integer, default=0)
    escalation_level = Column(Integer, default=0)  # 0=normal, 1=watching, 2=suspicious, 3=threat
    behavioral_flags = Column(JSONB, default=list)  # ["reconnaissance", "escalating", "tailgating_multiple"]
    risk_score = Column(Float, default=0.0)
    # Resolution
    resolved = Column(Boolean, default=False)
    linked_alert_id = Column(UUID(as_uuid=True), ForeignKey("alerts.id"), nullable=True)
    metadata_ = Column("metadata", JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class EntityAppearance(Base):
    """Individual appearance of a tracked entity at a specific camera."""
    __tablename__ = "entity_appearances"
    __table_args__ = (
        Index("ix_appearance_entity_time", "entity_track_id", "timestamp"),
        Index("ix_appearance_camera_time", "camera_id", "timestamp"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_track_id = Column(UUID(as_uuid=True), ForeignKey("entity_tracks.id"), nullable=False, index=True)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True)
    track_id = Column(Integer, nullable=True)  # YOLO ByteTrack ID
    timestamp = Column(DateTime(timezone=True), nullable=False, index=True)
    duration_seconds = Column(Float, default=0.0)
    # Snapshot
    frame_path = Column(String(512), nullable=True)
    bounding_box = Column(JSONB, nullable=True)
    appearance_snapshot = Column(JSONB, default=dict)  # {upper_color, lower_color, ...} at this moment
    # Behavior at this appearance
    behavior = Column(String(50), nullable=True)  # walking_past, stopping, looking, testing_door, running
    trajectory = Column(JSONB, nullable=True)  # [{x, y}, ...] movement path
    interaction_with = Column(JSONB, nullable=True)  # {object_class, door_id, ...}


class WeaponDetectionEvent(Base):
    """Advanced weapon detection events with behavioral pre-indicators."""
    __tablename__ = "weapon_detection_events"
    __table_args__ = (
        Index("ix_weapon_camera_time", "camera_id", "timestamp"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True)
    timestamp = Column(DateTime(timezone=True), nullable=False, index=True)
    # Weapon info
    weapon_type = Column(String(50), nullable=False)  # firearm, knife, blunt_weapon, edged_weapon, improvised
    detection_method = Column(String(50), default="yolo")  # yolo, behavioral, multi_model, acoustic_correlation
    confidence = Column(Float, default=0.0)
    # Status
    threat_posture = Column(String(30), default="detected")  # detected, concealed, holding, brandishing, aiming
    posture_confidence = Column(Float, nullable=True)
    # Behavioral pre-indicators
    pre_indicators = Column(JSONB, default=list)  # ["asymmetric_gait", "hand_to_waistband", "protective_positioning", ...]
    pre_indicator_duration_seconds = Column(Float, nullable=True)
    # Visual evidence
    frame_path = Column(String(512), nullable=True)
    bounding_box = Column(JSONB, nullable=True)
    track_id = Column(Integer, nullable=True)
    # Correlation
    acoustic_correlated = Column(Boolean, default=False)
    audio_event_id = Column(UUID(as_uuid=True), nullable=True)
    alert_id = Column(UUID(as_uuid=True), ForeignKey("alerts.id"), nullable=True)
    metadata_ = Column("metadata", JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SafetyEvent(Base):
    """Safety detection events — fire, falls, medical distress, mass egress."""
    __tablename__ = "safety_events"
    __table_args__ = (
        Index("ix_safety_type_created", "event_type", "created_at"),
        Index("ix_safety_camera_time", "camera_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_type = Column(String(50), nullable=False, index=True)  # smoke, flame, fire_spread, person_down, medical_distress, mass_egress, slip_fall
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True)
    severity = Column(String(20), default="high")
    confidence = Column(Float, default=0.0)
    # Detection details
    detection_stage = Column(String(30), nullable=True)  # For fire: smoke→flame→spread
    person_count_involved = Column(Integer, default=0)
    egress_direction = Column(String(50), nullable=True)  # For mass egress: toward_exit, away_from, scattered
    egress_speed = Column(Float, nullable=True)  # avg pixels/frame
    # Correlation
    correlated_alarm = Column(Boolean, default=False)  # Correlates with fire alarm, panic button, etc.
    alarm_source = Column(String(100), nullable=True)
    acoustic_correlated = Column(Boolean, default=False)
    # Evidence
    frame_path = Column(String(512), nullable=True)
    bounding_boxes = Column(JSONB, default=list)
    # Location tracking (for slip/fall zone analysis)
    location_x = Column(Float, nullable=True)
    location_y = Column(Float, nullable=True)
    # Resolution
    resolved = Column(Boolean, default=False)
    alert_id = Column(UUID(as_uuid=True), ForeignKey("alerts.id"), nullable=True)
    metadata_ = Column("metadata", JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SlipFallZone(Base):
    """Aggregate slip/fall frequency by location for safety improvement."""
    __tablename__ = "slip_fall_zones"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True)
    grid_x = Column(Integer, nullable=False)  # Grid cell X (0-based)
    grid_y = Column(Integer, nullable=False)  # Grid cell Y (0-based)
    incident_count = Column(Integer, default=0)
    last_incident_at = Column(DateTime(timezone=True), nullable=True)
    risk_level = Column(String(20), default="low")  # low, moderate, high, critical
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ── Phase 3E: Privacy-First Architecture ─────────────────────────────

class SilhouetteConfig(Base):
    """Per-zone silhouette/privacy rendering configuration."""
    __tablename__ = "silhouette_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True, unique=True)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=True)
    # Privacy mode
    mode = Column(String(30), default="full_video")  # silhouette_only, blurred_faces, full_video
    silhouette_color_mode = Column(String(30), default="single")  # single (cyan), per_track (random), risk_based (green→red)
    blur_faces = Column(Boolean, default=False)
    blur_plates = Column(Boolean, default=False)
    blur_screens = Column(Boolean, default=False)
    # Access tiers
    tier1_access_roles = Column(JSONB, default=list)  # Roles that see silhouettes only
    tier2_access_roles = Column(JSONB, default=list)  # Roles that see blurred faces
    tier3_access_roles = Column(JSONB, default=list)  # Roles that see full video (audit-logged)
    # Auto-redaction on export
    auto_redact_on_export = Column(Boolean, default=True)
    redact_faces = Column(Boolean, default=True)
    redact_plates = Column(Boolean, default=True)
    redact_documents = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class VideoAccessLog(Base):
    """Audit log for tiered video access."""
    __tablename__ = "video_access_logs"
    __table_args__ = (
        Index("ix_video_access_user_time", "user_id", "accessed_at"),
        Index("ix_video_access_camera_time", "camera_id", "accessed_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False)
    access_tier = Column(Integer, nullable=False)  # 1=silhouette, 2=blurred, 3=full
    reason = Column(Text, nullable=True)  # Why full access was requested
    approved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    time_limit_minutes = Column(Integer, nullable=True)  # How long full access was granted
    accessed_at = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=True)


class ComplianceAssessment(Base):
    """Privacy compliance scorecard entries."""
    __tablename__ = "compliance_assessments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    assessment_type = Column(String(50), nullable=False, index=True)  # gdpr, ccpa, bipa, internal
    scope = Column(String(50), default="global")  # global, site, zone, camera
    scope_id = Column(UUID(as_uuid=True), nullable=True)
    # Scores (0-100)
    overall_score = Column(Float, default=0.0)
    data_retention_score = Column(Float, default=0.0)
    consent_score = Column(Float, default=0.0)
    access_control_score = Column(Float, default=0.0)
    redaction_score = Column(Float, default=0.0)
    audit_trail_score = Column(Float, default=0.0)
    # Issues
    issues = Column(JSONB, default=list)  # [{category, description, severity, recommendation}, ...]
    issue_count = Column(Integer, default=0)
    critical_issues = Column(Integer, default=0)
    # Status
    status = Column(String(30), default="current")  # current, outdated, needs_review
    assessed_at = Column(DateTime(timezone=True), server_default=func.now())
    next_assessment_at = Column(DateTime(timezone=True), nullable=True)
    assessed_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
