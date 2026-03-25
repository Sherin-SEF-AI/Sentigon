"""
Phase 2B Database Models — Incident Lifecycle, Visitor Management, Mass Notification,
Floor Plan Devices, Video Wall Layouts, Behavioral Events, Data Retention,
Privacy Requests, Integration Connectors, SOC Workspace, Forensic Search,
Site Hierarchy, Lockdown Sequences.
"""

import uuid
import enum
from datetime import datetime

from sqlalchemy import (
    Column, String, Text, Integer, Float, Boolean,
    DateTime, ForeignKey, Index,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy import Enum as SAEnum

from backend.database import Base


# ──────────────────────────────────────────────
# Enums
# ──────────────────────────────────────────────

class IncidentStatus(str, enum.Enum):
    detected = "detected"
    triaged = "triaged"
    assigned = "assigned"
    in_progress = "in_progress"
    resolved = "resolved"
    closed = "closed"
    reviewed = "reviewed"


class VisitorStatus(str, enum.Enum):
    pre_registered = "pre_registered"
    checked_in = "checked_in"
    checked_out = "checked_out"
    denied = "denied"
    overstay = "overstay"
    expired = "expired"


class NotificationChannelEnum(str, enum.Enum):
    email = "email"
    sms = "sms"
    push = "push"
    pa_system = "pa_system"
    digital_signage = "digital_signage"
    webhook = "webhook"


# ──────────────────────────────────────────────
# Incident Lifecycle
# ──────────────────────────────────────────────

class Incident(Base):
    __tablename__ = "incidents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String, nullable=False)
    description = Column(Text)
    status = Column(SAEnum(IncidentStatus), default=IncidentStatus.detected, index=True)
    severity = Column(String, default="medium", index=True)
    incident_type = Column(String, index=True)
    source = Column(String, default="ai")
    confidence = Column(Float)
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"))
    camera_ids = Column(JSONB, default=list)
    assigned_to = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    merged_into = Column(UUID(as_uuid=True), ForeignKey("incidents.id"), nullable=True)
    merged_from = Column(JSONB, default=list)
    trigger_alert_ids = Column(JSONB, default=list)
    sla_acknowledge_minutes = Column(Integer, default=5)
    sla_respond_minutes = Column(Integer, default=15)
    sla_resolve_minutes = Column(Integer, default=60)
    acknowledged_at = Column(DateTime(timezone=True))
    responded_at = Column(DateTime(timezone=True))
    resolved_at = Column(DateTime(timezone=True))
    closed_at = Column(DateTime(timezone=True))
    reviewed_at = Column(DateTime(timezone=True))
    review_notes = Column(Text)
    ai_summary = Column(Text)
    evidence_ids = Column(JSONB, default=list)
    metadata_ = Column("metadata", JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_incidents_status_severity", "status", "severity"),
        Index("ix_incidents_created", "created_at"),
    )


class IncidentStatusLog(Base):
    __tablename__ = "incident_status_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    incident_id = Column(UUID(as_uuid=True), ForeignKey("incidents.id"), nullable=False, index=True)
    from_status = Column(String)
    to_status = Column(String, nullable=False)
    changed_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    notes = Column(Text)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


# ──────────────────────────────────────────────
# Visitor Management
# ──────────────────────────────────────────────

class Visitor(Base):
    __tablename__ = "visitors"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    first_name = Column(String, nullable=False)
    last_name = Column(String, nullable=False)
    email = Column(String, index=True)
    phone = Column(String)
    company = Column(String)
    visitor_type = Column(String, default="visitor")
    photo_path = Column(String)
    id_document_path = Column(String)
    host_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    host_name = Column(String)
    purpose = Column(String)
    status = Column(SAEnum(VisitorStatus), default=VisitorStatus.pre_registered, index=True)
    badge_number = Column(String, unique=True)
    badge_qr_data = Column(Text)
    allowed_zones = Column(JSONB, default=list)
    check_in_time = Column(DateTime(timezone=True))
    expected_check_out = Column(DateTime(timezone=True))
    check_out_time = Column(DateTime(timezone=True))
    watchlist_match = Column(Boolean, default=False)
    watchlist_notes = Column(Text)
    access_log = Column(JSONB, default=list)
    nda_signed = Column(Boolean, default=False)
    escort_required = Column(Boolean, default=False)
    metadata_ = Column("metadata", JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class VisitorWatchlistEntry(Base):
    __tablename__ = "visitor_watchlist"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    first_name = Column(String)
    last_name = Column(String)
    email = Column(String, index=True)
    phone = Column(String)
    reason = Column(String, nullable=False)
    severity = Column(String, default="high")
    photo_path = Column(String)
    active = Column(Boolean, default=True)
    added_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    notes = Column(Text)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    expires_at = Column(DateTime(timezone=True))


# ──────────────────────────────────────────────
# Mass Notification & Emergency
# ──────────────────────────────────────────────

class NotificationTemplate(Base):
    __tablename__ = "notification_templates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False, unique=True)
    category = Column(String, nullable=False, index=True)
    subject = Column(String)
    body = Column(Text, nullable=False)
    channels = Column(JSONB, default=list)
    severity = Column(String, default="critical")
    auto_trigger_event_type = Column(String)
    zone_targeted = Column(Boolean, default=False)
    requires_acknowledgment = Column(Boolean, default=True)
    lockdown_sequence = Column(JSONB)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class MassNotification(Base):
    __tablename__ = "mass_notifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    template_id = Column(UUID(as_uuid=True), ForeignKey("notification_templates.id"))
    title = Column(String, nullable=False)
    message = Column(Text, nullable=False)
    severity = Column(String, default="critical")
    channels_used = Column(JSONB, default=list)
    target_zones = Column(JSONB, default=list)
    target_roles = Column(JSONB, default=list)
    sent_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    total_recipients = Column(Integer, default=0)
    acknowledged_count = Column(Integer, default=0)
    acknowledgments = Column(JSONB, default=list)
    lockdown_activated = Column(Boolean, default=False)
    lockdown_details = Column(JSONB)
    status = Column(String, default="sent")
    incident_id = Column(UUID(as_uuid=True), ForeignKey("incidents.id", use_alter=True))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    resolved_at = Column(DateTime(timezone=True))


class LockdownSequence(Base):
    __tablename__ = "lockdown_sequences"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    trigger_type = Column(String)
    steps = Column(JSONB, nullable=False, default=list)
    target_zones = Column(JSONB, default=list)
    is_active = Column(Boolean, default=False)
    activated_at = Column(DateTime(timezone=True))
    activated_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    deactivated_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


# ──────────────────────────────────────────────
# Floor Plan Devices & Video Wall Layouts
# ──────────────────────────────────────────────

class FloorPlanDevice(Base):
    __tablename__ = "floor_plan_devices"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    floor_plan_id = Column(String, nullable=False, index=True)
    device_type = Column(String, nullable=False, index=True)
    device_id = Column(String, nullable=False)
    x_percent = Column(Float, nullable=False)
    y_percent = Column(Float, nullable=False)
    rotation = Column(Float, default=0)
    icon_size = Column(Float, default=1.0)
    label = Column(String)
    fov_angle = Column(Float)
    fov_range = Column(Float)
    config = Column(JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class VideoWallLayout(Base):
    __tablename__ = "video_wall_layouts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    grid_cols = Column(Integer, default=2)
    grid_rows = Column(Integer, default=2)
    cells = Column(JSONB, default=list)
    is_default = Column(Boolean, default=False)
    cycle_enabled = Column(Boolean, default=False)
    cycle_interval_seconds = Column(Integer, default=30)
    cycle_cameras = Column(JSONB, default=list)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


# ──────────────────────────────────────────────
# Behavioral Events
# ──────────────────────────────────────────────

class BehavioralEvent(Base):
    __tablename__ = "behavioral_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_type = Column(String, nullable=False, index=True)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"))
    zone_id = Column(UUID(as_uuid=True), ForeignKey("zones.id"))
    severity = Column(String, default="medium")
    confidence = Column(Float)
    subject_track_id = Column(String)
    details = Column(JSONB, default=dict)
    duration_seconds = Column(Float)
    frame_path = Column(String)
    resolved = Column(Boolean, default=False)
    resolved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        Index("ix_behavioral_type_created", "event_type", "created_at"),
    )


# ──────────────────────────────────────────────
# Data Retention & Privacy
# ──────────────────────────────────────────────

class DataRetentionPolicy(Base):
    __tablename__ = "data_retention_policies"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False, unique=True)
    data_type = Column(String, nullable=False, index=True)
    retention_days = Column(Integer, nullable=False)
    auto_purge = Column(Boolean, default=True)
    last_purge_at = Column(DateTime(timezone=True))
    records_purged = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class PrivacyRequest(Base):
    __tablename__ = "privacy_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_type = Column(String, nullable=False)
    subject_name = Column(String, nullable=False)
    subject_email = Column(String)
    subject_identifier = Column(String)
    status = Column(String, default="pending", index=True)
    data_categories = Column(JSONB, default=list)
    processing_log = Column(JSONB, default=list)
    completed_at = Column(DateTime(timezone=True))
    processed_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


# ──────────────────────────────────────────────
# Integration Connectors & SIEM
# ──────────────────────────────────────────────

class IntegrationConnector(Base):
    __tablename__ = "integration_connectors"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    connector_type = Column(String, nullable=False, index=True)
    direction = Column(String, default="outbound")
    config = Column(JSONB, nullable=False, default=dict)
    event_filter = Column(JSONB, default=dict)
    transform_template = Column(Text)
    is_active = Column(Boolean, default=True)
    last_sync_at = Column(DateTime(timezone=True))
    last_sync_status = Column(String)
    error_count = Column(Integer, default=0)
    events_sent = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class SIEMDeliveryLog(Base):
    __tablename__ = "siem_delivery_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    connector_id = Column(UUID(as_uuid=True), ForeignKey("integration_connectors.id"), index=True)
    event_type = Column(String)
    payload_summary = Column(String)
    status = Column(String)
    error_message = Column(Text)
    delivered_at = Column(DateTime(timezone=True), default=datetime.utcnow)


# ──────────────────────────────────────────────
# SOC Operator Workspace
# ──────────────────────────────────────────────

class OperatorWorkspace(Base):
    __tablename__ = "operator_workspaces"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), unique=True)
    layout = Column(JSONB, default=list)
    theme = Column(String, default="dark")
    alert_sound_enabled = Column(Boolean, default=True)
    alert_tiers = Column(JSONB, default=dict)
    keyboard_shortcuts = Column(JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


# ──────────────────────────────────────────────
# Forensic Search Results
# ──────────────────────────────────────────────

class ForensicSearchResult(Base):
    __tablename__ = "forensic_search_results"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    search_type = Column(String, nullable=False)
    query = Column(JSONB, nullable=False)
    results = Column(JSONB, default=list)
    result_count = Column(Integer, default=0)
    searched_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


# ──────────────────────────────────────────────
# Multi-Site Hierarchy
# ──────────────────────────────────────────────

class SiteHierarchy(Base):
    __tablename__ = "site_hierarchy"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("site_hierarchy.id"), index=True)
    level = Column(String, nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text)
    address = Column(String)
    lat = Column(Float)
    lng = Column(Float)
    timezone_str = Column(String, default="UTC")
    config = Column(JSONB, default=dict)
    status = Column(String, default="active")
    metadata_ = Column("metadata", JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_site_hierarchy_parent_level", "parent_id", "level"),
    )
