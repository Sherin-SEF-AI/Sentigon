"""Phase 2 DB models — 14 new tables for advanced security features."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from backend.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


def _uuid():
    return uuid.uuid4()


# ── BOLO (Be On the Lookout) ────────────────────────────────

class BOLOEntry(Base):
    __tablename__ = "bolo_entries"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    bolo_type = Column(String(20), nullable=False)  # "person" | "vehicle"
    description = Column(JSONB, default=dict)
    plate_text = Column(String(20), nullable=True)
    severity = Column(String(20), default="high")
    reason = Column(Text, nullable=True)
    active = Column(Boolean, default=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    image_path = Column(String(500), nullable=True)
    created_by = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


# ── Shift Logbook ────────────────────────────────────────────

class ShiftLogbook(Base):
    __tablename__ = "shift_logbook"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    shift_start = Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    shift_end = Column(DateTime(timezone=True), nullable=True)
    operator_id = Column(UUID(as_uuid=True), nullable=True)
    notes = Column(Text, nullable=True)
    handover_notes = Column(Text, nullable=True)
    status = Column(String(20), default="active")  # active, ended, handed_over
    alerts_during_shift = Column(JSONB, default=list)
    summary = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=_utcnow)


# ── Patrol ────────────────────────────────────────────────────

class PatrolShift(Base):
    __tablename__ = "patrol_shifts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    guard_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    zone_ids = Column(JSONB, default=list)
    start_time = Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    end_time = Column(DateTime(timezone=True), nullable=True)
    route_waypoints = Column(JSONB, default=list)
    status = Column(String(20), default="scheduled")  # scheduled, active, completed, cancelled
    checkpoints_completed = Column(JSONB, default=list)
    created_at = Column(DateTime(timezone=True), default=_utcnow)


class PatrolRoute(Base):
    __tablename__ = "patrol_routes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    name = Column(String(200), nullable=False)
    zone_sequence = Column(JSONB, default=list)
    risk_score = Column(Float, default=0.0)
    estimated_duration_minutes = Column(Integer, default=30)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


# ── VIP Protection ───────────────────────────────────────────

class VIPProfile(Base):
    __tablename__ = "vip_profiles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    appearance = Column(JSONB, default=dict)
    threat_level = Column(String(20), default="normal")
    active = Column(Boolean, default=True)
    geofence_radius_meters = Column(Float, default=50.0)
    image_path = Column(String(500), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)

    proximity_events = relationship("VIPProximityEvent", back_populates="vip")


class VIPProximityEvent(Base):
    __tablename__ = "vip_proximity_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    vip_id = Column(UUID(as_uuid=True), ForeignKey("vip_profiles.id"), nullable=False)
    threat_type = Column(String(100), nullable=True)
    distance_meters = Column(Float, nullable=True)
    camera_id = Column(String(100), nullable=True)
    severity = Column(String(20), default="medium")
    timestamp = Column(DateTime(timezone=True), default=_utcnow)

    vip = relationship("VIPProfile", back_populates="proximity_events")


# ── Insider Threat ───────────────────────────────────────────

class InsiderThreatProfile(Base):
    __tablename__ = "insider_threat_profiles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    risk_score = Column(Float, default=0.0)
    baseline_access_pattern = Column(JSONB, default=dict)
    anomaly_count = Column(Integer, default=0)
    behavioral_flags = Column(JSONB, default=list)
    status = Column(String(20), default="monitoring")  # monitoring, flagged, cleared
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


# ── Physical Access Control (PACS) ──────────────────────────

class AccessEvent(Base):
    __tablename__ = "access_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_identifier = Column(String(200), nullable=True)
    door_id = Column(String(100), nullable=True)
    event_type = Column(String(30), nullable=False)  # granted, denied, forced, held_open, tailgating
    camera_id = Column(String(100), nullable=True)
    timestamp = Column(DateTime(timezone=True), default=_utcnow)
    event_metadata = Column("metadata", JSONB, default=dict)


# ── SOPs (Standard Operating Procedures) ────────────────────

class SOPTemplate(Base):
    __tablename__ = "sop_templates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    threat_type = Column(String(100), nullable=False)
    severity = Column(String(20), nullable=False)
    name = Column(String(200), nullable=False)
    workflow_stages = Column(JSONB, default=list)
    auto_trigger = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)

    instances = relationship("SOPInstance", back_populates="template")


class SOPInstance(Base):
    __tablename__ = "sop_instances"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    template_id = Column(UUID(as_uuid=True), ForeignKey("sop_templates.id"), nullable=False)
    alert_id = Column(UUID(as_uuid=True), nullable=True)
    current_stage = Column(Integer, default=0)
    stage_history = Column(JSONB, default=list)
    status = Column(String(20), default="active")  # active, completed, aborted
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)

    template = relationship("SOPTemplate", back_populates="instances")


# ── Dispatch ─────────────────────────────────────────────────

class DispatchResource(Base):
    __tablename__ = "dispatch_resources"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    resource_type = Column(String(30), nullable=False)  # police, fire, ems, security
    name = Column(String(200), nullable=False)
    status = Column(String(20), default="available")  # available, dispatched, en_route, on_scene
    current_location = Column(JSONB, default=dict)
    eta_minutes = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


# ── Companion Discovery ─────────────────────────────────────

class CompanionLink(Base):
    __tablename__ = "companion_links"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    entity_a_track_id = Column(Integer, nullable=False)
    entity_b_track_id = Column(Integer, nullable=False)
    camera_id = Column(String(100), nullable=True)
    proximity_duration_seconds = Column(Float, default=0.0)
    behavioral_sync_score = Column(Float, default=0.0)
    link_type = Column(String(30), default="proximity")  # proximity, behavioral, both
    created_at = Column(DateTime(timezone=True), default=_utcnow)


# ── Multi-Site ───────────────────────────────────────────────

class Site(Base):
    __tablename__ = "sites"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    name = Column(String(200), nullable=False)
    address = Column(Text, nullable=True)
    lat = Column(Float, nullable=True)
    lng = Column(Float, nullable=True)
    timezone_str = Column(String(50), default="UTC")
    total_cameras = Column(Integer, default=0)
    status = Column(String(20), default="active")  # active, offline, maintenance
    alert_summary = Column(JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)
