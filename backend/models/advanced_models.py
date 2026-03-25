"""Advanced module ORM models — vehicle, audio, compliance, evidence, threat intel."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.database import Base


# ── Vehicle Intelligence (Modules A & H) ─────────────────────


class VehicleSighting(Base):
    __tablename__ = "vehicle_sightings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    plate_text: Mapped[str | None] = mapped_column(String(50), index=True)
    plate_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    plate_region: Mapped[str | None] = mapped_column(String(50))
    vehicle_color: Mapped[str | None] = mapped_column(String(50))
    vehicle_type: Mapped[str | None] = mapped_column(String(50))
    vehicle_make: Mapped[str | None] = mapped_column(String(100))
    vehicle_model: Mapped[str | None] = mapped_column(String(100))
    vehicle_direction: Mapped[str | None] = mapped_column(String(50))
    frame_path: Mapped[str | None] = mapped_column(String(512))
    bounding_box: Mapped[dict | None] = mapped_column(JSONB)
    event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("events.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class VehicleWatchlist(Base):
    __tablename__ = "vehicle_watchlist"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plate_text: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    plate_pattern: Mapped[str | None] = mapped_column(String(100))
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(String(20), default="high")
    added_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class VehicleTrip(Base):
    __tablename__ = "vehicle_trips"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plate_text: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    entry_camera_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=True)
    entry_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exit_camera_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=True)
    exit_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    path: Mapped[dict | None] = mapped_column(JSONB)
    total_dwell_seconds: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Audio Intelligence (Module B) ────────────────────────────


class AudioEvent(Base):
    __tablename__ = "audio_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    sound_type: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    severity: Mapped[str] = mapped_column(String(20), default="low")
    audio_clip_path: Mapped[str | None] = mapped_column(String(512))
    correlated_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("events.id"), nullable=True)
    gemini_analysis: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Camera Baselines (Module K) ──────────────────────────────


class CameraBaseline(Base):
    __tablename__ = "camera_baselines"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False, index=True)
    baseline_frame_path: Mapped[str] = mapped_column(String(512), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ssim_threshold: Mapped[float] = mapped_column(Float, default=0.6)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


# ── PPE Compliance (Module L) ────────────────────────────────


class PPEComplianceEvent(Base):
    __tablename__ = "ppe_compliance_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False, index=True)
    zone_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    person_snapshot_path: Mapped[str | None] = mapped_column(String(512))
    required_ppe: Mapped[dict | None] = mapped_column(JSONB)
    detected_ppe: Mapped[dict | None] = mapped_column(JSONB)
    missing_ppe: Mapped[dict | None] = mapped_column(JSONB)
    compliance_status: Mapped[str] = mapped_column(String(30), default="unknown")
    event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("events.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Evidence (Module M) ──────────────────────────────────────


class EvidenceHash(Base):
    __tablename__ = "evidence_hashes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    evidence_type: Mapped[str] = mapped_column(String(50), nullable=False)
    evidence_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    file_path: Mapped[str] = mapped_column(String(512), nullable=False)
    sha256_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    verification_status: Mapped[str] = mapped_column(String(20), default="pending")


# ── Copilot (Module C) ──────────────────────────────────────


class CopilotConversation(Base):
    __tablename__ = "copilot_conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    operator_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    session_id: Mapped[str] = mapped_column(String(100), nullable=False, unique=True, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    message_count: Mapped[int] = mapped_column(Integer, default=0)
    messages: Mapped[list | None] = mapped_column(JSONB, default=list)
    status: Mapped[str] = mapped_column(String(20), default="active")


# ── Threat Intelligence (Module I) ───────────────────────────


class ThreatIntelEntry(Base):
    __tablename__ = "threat_intel_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(255), nullable=False)
    alert_type: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    details: Mapped[dict | None] = mapped_column(JSONB)
    severity: Mapped[str] = mapped_column(String(20), default="medium")
    valid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    auto_actions_taken: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Extended fields for feed integration
    intel_type: Mapped[str | None] = mapped_column(String(100), default="threat")
    location_context: Mapped[dict | None] = mapped_column(JSONB)
    threshold_adjustments: Mapped[dict | None] = mapped_column(JSONB)
    impact_zones: Mapped[dict | None] = mapped_column(JSONB)
    priority: Mapped[int] = mapped_column(Integer, default=5)
    source_url: Mapped[str | None] = mapped_column(String(1024))
    processed: Mapped[bool] = mapped_column(Boolean, default=False)
    agent_acknowledgments: Mapped[dict | None] = mapped_column(JSONB)


class ThreatIntelFeed(Base):
    __tablename__ = "threat_intel_feeds"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    feed_type: Mapped[str] = mapped_column(String(50), nullable=False)
    url: Mapped[str | None] = mapped_column(String(1024))
    api_key: Mapped[str | None] = mapped_column(String(512))
    poll_interval_seconds: Mapped[int] = mapped_column(Integer, default=300)
    transform_config: Mapped[dict | None] = mapped_column(JSONB)
    default_severity: Mapped[str] = mapped_column(String(20), default="medium")
    default_auto_actions: Mapped[dict | None] = mapped_column(JSONB)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_poll_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_poll_status: Mapped[str | None] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Vehicle Analytics (Feature 9) ────────────────────────────


class VehicleAnalyticsEvent(Base):
    __tablename__ = "vehicle_analytics_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vehicle_sighting_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("vehicle_sightings.id"), nullable=True)
    camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False, index=True)
    zone_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=True)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    plate_text: Mapped[str | None] = mapped_column(String(50), index=True)
    vehicle_description: Mapped[dict | None] = mapped_column(JSONB)
    severity: Mapped[str] = mapped_column(String(20), default="medium")
    details: Mapped[dict | None] = mapped_column(JSONB)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    frame_path: Mapped[str | None] = mapped_column(String(512))
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ParkingZoneConfig(Base):
    __tablename__ = "parking_zone_configs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    zone_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("zones.id"), nullable=False, unique=True)
    zone_type: Mapped[str] = mapped_column(String(50), nullable=False)
    max_dwell_minutes: Mapped[int | None] = mapped_column(Integer)
    allowed_vehicle_types: Mapped[dict | None] = mapped_column(JSONB)
    allowed_directions: Mapped[dict | None] = mapped_column(JSONB)
    total_spots: Mapped[int | None] = mapped_column(Integer)
    occupied_spots: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Incident Replay (Feature 7) ─────────────────────────────


class IncidentSnapshot(Base):
    __tablename__ = "incident_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    camera_ids: Mapped[dict | None] = mapped_column(JSONB)
    zone_ids: Mapped[dict | None] = mapped_column(JSONB)
    trigger_alert_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    trigger_case_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="recording")
    total_frames: Mapped[int] = mapped_column(Integer, default=0)
    total_agent_actions: Mapped[int] = mapped_column(Integer, default=0)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class IncidentFrame(Base):
    __tablename__ = "incident_frames"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    incident_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("incident_snapshots.id"), nullable=False, index=True)
    camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False)
    sequence_num: Mapped[int] = mapped_column(Integer, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    frame_path: Mapped[str] = mapped_column(String(512), nullable=False)
    detections: Mapped[dict | None] = mapped_column(JSONB)
    gemini_analysis: Mapped[dict | None] = mapped_column(JSONB)
    zone_occupancy: Mapped[dict | None] = mapped_column(JSONB)


class IncidentAgentAction(Base):
    __tablename__ = "incident_agent_actions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    incident_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("incident_snapshots.id"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    agent_name: Mapped[str] = mapped_column(String(100), nullable=False)
    action_type: Mapped[str] = mapped_column(String(100), nullable=False)
    tool_name: Mapped[str | None] = mapped_column(String(100))
    tool_args: Mapped[dict | None] = mapped_column(JSONB)
    tool_result: Mapped[dict | None] = mapped_column(JSONB)
    decision_summary: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column(Float)


# ── Video Summary (Feature 11) ────────────────────────────────


class VideoSummary(Base):
    __tablename__ = "video_summaries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False, index=True)
    summary_type: Mapped[str] = mapped_column(String(30), nullable=False)  # highlight | timelapse
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    file_path: Mapped[str | None] = mapped_column(String(512))
    file_size: Mapped[int | None] = mapped_column(Integer)
    duration_seconds: Mapped[float | None] = mapped_column(Float)
    event_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(30), default="pending")  # pending|processing|complete|failed
    threshold: Mapped[str | None] = mapped_column(String(20))  # low|medium|high|critical
    speed_factor: Mapped[int | None] = mapped_column(Integer)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, default=dict)
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Webhook Integration (Feature 15) ─────────────────────────


class WebhookConfig(Base):
    __tablename__ = "webhook_configs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    url: Mapped[str] = mapped_column(String(1024), nullable=False)
    method: Mapped[str] = mapped_column(String(10), default="POST")
    headers: Mapped[dict | None] = mapped_column(JSONB, default=dict)
    secret: Mapped[str | None] = mapped_column(String(512))  # HMAC signing key
    event_types: Mapped[dict | None] = mapped_column(JSONB, default=list)  # ["alert", "threat", "compliance", ...]
    severity_filter: Mapped[str | None] = mapped_column(String(20))  # Minimum severity to trigger
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=3)
    retry_delay_seconds: Mapped[int] = mapped_column(Integer, default=5)
    template: Mapped[dict | None] = mapped_column(JSONB)  # Payload template
    integration_type: Mapped[str] = mapped_column(String(50), default="generic")  # generic|slack|teams|jira|splunk
    last_triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[str | None] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now())


class WebhookDeliveryLog(Base):
    __tablename__ = "webhook_delivery_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    webhook_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("webhook_configs.id"), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSONB)
    status_code: Mapped[int | None] = mapped_column(Integer)
    response_body: Mapped[str | None] = mapped_column(Text)
    success: Mapped[bool] = mapped_column(Boolean, default=False)
    attempt_number: Mapped[int] = mapped_column(Integer, default=1)
    error_message: Mapped[str | None] = mapped_column(Text)
    delivered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
