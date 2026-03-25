"""Consolidated SENTINEL AI agents — 12 lean agents replacing the original 28.

Architecture:
    Perception Tier (5):  Watcher, Detector, AudioSentinel, Environmental, AccessGuardian
    Reasoning Tier (2):   Tracker, ThreatAnalyzer
    Action Tier (4):      Investigator, Responder, Reporter, RedTeam
    Supervisor Tier (1):  SentinelCortex
"""
from backend.agents.consolidated.watcher import WatcherAgent
from backend.agents.consolidated.detector import DetectorAgent
from backend.agents.consolidated.audio_sentinel import AudioSentinel
from backend.agents.consolidated.environmental import EnvironmentalAgent
from backend.agents.consolidated.access_guardian import AccessGuardianAgent
from backend.agents.consolidated.tracker import TrackerAgent
from backend.agents.consolidated.threat_analyzer import ThreatAnalyzerAgent
from backend.agents.consolidated.investigator import InvestigatorAgent
from backend.agents.consolidated.responder import ResponderAgent
from backend.agents.consolidated.reporter import ReporterAgent
from backend.agents.consolidated.red_team import RedTeamAgent
from backend.agents.consolidated.cortex import SentinelCortexAgent

__all__ = [
    # Perception
    "WatcherAgent",
    "DetectorAgent",
    "AudioSentinel",
    "EnvironmentalAgent",
    "AccessGuardianAgent",
    # Reasoning
    "TrackerAgent",
    "ThreatAnalyzerAgent",
    # Action
    "InvestigatorAgent",
    "ResponderAgent",
    "ReporterAgent",
    "RedTeamAgent",
    # Supervisor
    "SentinelCortexAgent",
]
