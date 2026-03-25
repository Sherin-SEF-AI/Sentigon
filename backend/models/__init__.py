"""SQLAlchemy ORM models for SENTINEL AI."""

from backend.models.models import (
    ActivityNotification,
    Alert,
    AuditLog,
    Camera,
    Case,
    CaseEvidence,
    Event,
    InvestigationRun,
    Recording,
    ThreatSignature,
    User,
    VideoBookmark,
    Zone,
)
from backend.models.agent_state import AgentState, AgentMemory
from backend.models.agent_audit import AgentAuditLog
from backend.models.pending_action import PendingAction, PendingActionStatus
from backend.models.system_settings import SystemSetting
from backend.models.advanced_models import (
    AudioEvent,
    CameraBaseline,
    CopilotConversation,
    EvidenceHash,
    PPEComplianceEvent,
    ThreatIntelEntry,
    VehicleSighting,
    VehicleTrip,
    VehicleWatchlist,
)
from backend.models.phase2_models import (
    AccessEvent,
    BOLOEntry,
    CompanionLink,
    DispatchResource,
    InsiderThreatProfile,
    PatrolRoute,
    PatrolShift,
    ShiftLogbook,
    Site,
    SOPInstance,
    SOPTemplate,
    VIPProfile,
    VIPProximityEvent,
)

__all__ = [
    "User",
    "Camera",
    "Zone",
    "Event",
    "Alert",
    "ActivityNotification",
    "Case",
    "CaseEvidence",
    "InvestigationRun",
    "Recording",
    "VideoBookmark",
    "AuditLog",
    "ThreatSignature",
    "AgentState",
    "AgentMemory",
    "AgentAuditLog",
    "AudioEvent",
    "CameraBaseline",
    "CopilotConversation",
    "EvidenceHash",
    "PPEComplianceEvent",
    "ThreatIntelEntry",
    "VehicleSighting",
    "VehicleTrip",
    "VehicleWatchlist",
    "PendingAction",
    "PendingActionStatus",
    "SystemSetting",
]
