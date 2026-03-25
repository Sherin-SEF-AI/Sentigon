"""Pydantic request/response schemas for all models."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, EmailStr, Field


# ── Auth ──────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserResponse"


class RegisterRequest(BaseModel):
    email: str
    password: str = Field(min_length=8)
    full_name: str
    role: str = "viewer"


# ── User ──────────────────────────────────────────────────────

class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None


# ── Camera ────────────────────────────────────────────────────

class CameraCreate(BaseModel):
    name: str
    source: str
    location: Optional[str] = None
    fps: int = 15
    resolution: Optional[str] = None
    zone_id: Optional[uuid.UUID] = None
    config: Optional[Dict[str, Any]] = None


class CameraUpdate(BaseModel):
    name: Optional[str] = None
    source: Optional[str] = None
    location: Optional[str] = None
    status: Optional[str] = None
    fps: Optional[int] = None
    resolution: Optional[str] = None
    zone_id: Optional[uuid.UUID] = None
    config: Optional[Dict[str, Any]] = None
    is_active: Optional[bool] = None


class CameraResponse(BaseModel):
    id: uuid.UUID
    name: str
    source: str
    location: Optional[str]
    status: str
    fps: int
    resolution: Optional[str]
    zone_id: Optional[uuid.UUID]
    config: Optional[Dict[str, Any]]
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Zone ──────────────────────────────────────────────────────

class ZoneCreate(BaseModel):
    name: str
    description: Optional[str] = None
    zone_type: str = "general"
    polygon: Optional[List[List[float]]] = None
    max_occupancy: Optional[int] = None
    alert_on_breach: bool = False
    config: Optional[Dict[str, Any]] = None


class ZoneUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    zone_type: Optional[str] = None
    polygon: Optional[List[List[float]]] = None
    max_occupancy: Optional[int] = None
    current_occupancy: Optional[int] = None
    alert_on_breach: Optional[bool] = None
    config: Optional[Dict[str, Any]] = None
    is_active: Optional[bool] = None


class ZoneResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: Optional[str]
    zone_type: str
    polygon: Optional[List[List[float]]]
    max_occupancy: Optional[int]
    current_occupancy: int
    alert_on_breach: bool
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Event ─────────────────────────────────────────────────────

class EventCreate(BaseModel):
    camera_id: uuid.UUID
    zone_id: Optional[uuid.UUID] = None
    event_type: str
    description: Optional[str] = None
    severity: str = "info"
    confidence: float = 0.0
    detections: Optional[Dict[str, Any]] = None
    frame_url: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    gemini_analysis: Optional[Dict[str, Any]] = None


class EventResponse(BaseModel):
    id: uuid.UUID
    camera_id: uuid.UUID
    zone_id: Optional[uuid.UUID]
    event_type: str
    description: Optional[str]
    severity: str
    confidence: float
    detections: Optional[Dict[str, Any]]
    frame_url: Optional[str]
    embedding_id: Optional[str]
    gemini_analysis: Optional[Dict[str, Any]]
    timestamp: datetime

    model_config = {"from_attributes": True}


# ── Alert ─────────────────────────────────────────────────────

class AlertCreate(BaseModel):
    event_id: Optional[uuid.UUID] = None
    title: str
    description: Optional[str] = None
    severity: str = "medium"
    threat_type: Optional[str] = None
    source_camera: Optional[str] = None
    zone_name: Optional[str] = None
    confidence: float = 0.0
    metadata: Optional[Dict[str, Any]] = None


class AlertUpdate(BaseModel):
    status: Optional[str] = None
    assigned_to: Optional[uuid.UUID] = None
    resolution_notes: Optional[str] = None


class AlertResponse(BaseModel):
    id: uuid.UUID
    event_id: Optional[uuid.UUID]
    title: str
    description: Optional[str]
    severity: str
    status: str
    threat_type: Optional[str]
    source_camera: Optional[str]
    zone_name: Optional[str]
    confidence: float
    assigned_to: Optional[uuid.UUID]
    resolution_notes: Optional[str]
    created_at: datetime
    acknowledged_at: Optional[datetime]
    resolved_at: Optional[datetime]

    model_config = {"from_attributes": True}


# ── Activity Notification ─────────────────────────────────────

class ActivityNotificationCreate(BaseModel):
    name: str
    description: Optional[str] = None
    rule_nl: str
    severity: str = "medium"
    zones: Optional[List[str]] = None
    schedule: Optional[Dict[str, Any]] = None
    is_active: bool = True


class ActivityNotificationResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: Optional[str]
    rule_nl: str
    severity: str
    zones: Optional[List[str]]
    schedule: Optional[Dict[str, Any]]
    is_active: bool
    last_triggered: Optional[datetime]
    trigger_count: int
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Case ──────────────────────────────────────────────────────

class CaseCreate(BaseModel):
    title: str
    description: Optional[str] = None
    priority: str = "medium"
    assigned_to: Optional[uuid.UUID] = None
    tags: Optional[List[str]] = None


class CaseUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    assigned_to: Optional[uuid.UUID] = None
    tags: Optional[List[str]] = None
    summary: Optional[str] = None


class CaseResponse(BaseModel):
    id: uuid.UUID
    title: str
    description: Optional[str]
    status: str
    priority: str
    assigned_to: Optional[uuid.UUID]
    tags: Optional[List[str]]
    summary: Optional[str]
    ai_insights: Optional[Dict[str, Any]]
    created_at: datetime
    updated_at: datetime
    closed_at: Optional[datetime]

    model_config = {"from_attributes": True}


# ── Case Evidence ─────────────────────────────────────────────

class CaseEvidenceCreate(BaseModel):
    evidence_type: str
    reference_id: Optional[uuid.UUID] = None
    title: str
    content: Optional[str] = None
    file_url: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class CaseEvidenceResponse(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    evidence_type: str
    reference_id: Optional[uuid.UUID]
    title: str
    content: Optional[str]
    file_url: Optional[str]
    added_at: datetime

    model_config = {"from_attributes": True}


# ── Investigation ─────────────────────────────────────────────

class InvestigationRunCreate(BaseModel):
    case_id: uuid.UUID
    agent_type: str
    query: Optional[str] = None
    input_params: Optional[Dict[str, Any]] = None


class InvestigationRunResponse(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    agent_type: str
    status: str
    steps: Optional[List[Dict[str, Any]]]
    findings: Optional[Dict[str, Any]]
    summary: Optional[str]
    started_at: datetime
    completed_at: Optional[datetime]

    model_config = {"from_attributes": True}


# ── Recording ─────────────────────────────────────────────────

class RecordingResponse(BaseModel):
    id: uuid.UUID
    camera_id: uuid.UUID
    recording_type: str
    file_path: str
    file_size: Optional[int]
    duration_seconds: Optional[float]
    start_time: datetime
    end_time: Optional[datetime]

    model_config = {"from_attributes": True}


# ── Audit Log ─────────────────────────────────────────────────

class AuditLogResponse(BaseModel):
    id: uuid.UUID
    user_id: Optional[uuid.UUID]
    action: str
    resource_type: Optional[str]
    resource_id: Optional[str]
    details: Optional[Dict[str, Any]]
    ip_address: Optional[str]
    timestamp: datetime

    model_config = {"from_attributes": True}


# ── Search ────────────────────────────────────────────────────

class SemanticSearchRequest(BaseModel):
    query: str
    top_k: int = 10
    filters: Optional[Dict[str, Any]] = None


class SearchResult(BaseModel):
    event_id: str
    score: float
    description: Optional[str]
    event_type: Optional[str]
    camera_id: Optional[str]
    timestamp: Optional[str]
    metadata: Optional[Dict[str, Any]]


class SemanticSearchResponse(BaseModel):
    query: str
    results: List[SearchResult]
    total: int


# ── Analytics ─────────────────────────────────────────────────

class AnalyticsRequest(BaseModel):
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    camera_ids: Optional[List[uuid.UUID]] = None
    zone_ids: Optional[List[uuid.UUID]] = None
    metric: str = "events_over_time"


class AnalyticsResponse(BaseModel):
    metric: str
    data: List[Dict[str, Any]]
    summary: Optional[Dict[str, Any]] = None


# ── Threat Signature ──────────────────────────────────────────

class ThreatSignatureCreate(BaseModel):
    name: str
    category: str
    description: Optional[str] = None
    severity: str = "medium"
    detection_method: str = "hybrid"
    yolo_classes: Optional[List[str]] = None
    gemini_prompt: Optional[str] = None
    conditions: Optional[Dict[str, Any]] = None
    is_active: bool = True


class ThreatSignatureResponse(BaseModel):
    id: uuid.UUID
    name: str
    category: str
    description: Optional[str]
    severity: str
    detection_method: str
    yolo_classes: Optional[List[str]]
    gemini_prompt: Optional[str]
    conditions: Optional[Dict[str, Any]]
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ── WebSocket Messages ────────────────────────────────────────

class WSMessage(BaseModel):
    channel: str  # "frame", "alert", "metric", "notification"
    data: Dict[str, Any]


class SOCMetrics(BaseModel):
    total_cameras: int = 0
    active_cameras: int = 0
    total_alerts: int = 0
    critical_alerts: int = 0
    open_cases: int = 0
    total_detections_today: int = 0
    avg_response_time: Optional[float] = None
    threat_level: str = "normal"  # normal, elevated, high, critical
