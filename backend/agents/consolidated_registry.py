"""Consolidated agent registry — 12 lean agents replacing the original 28.

Registers and manages the lifecycle of all 12 SENTINEL AI consolidated agents.
Call `setup_consolidated_agents()` at startup to register all agents.
"""
from __future__ import annotations

import logging

from backend.agents.agent_registry import agent_registry

logger = logging.getLogger(__name__)


def setup_consolidated_agents():
    """Create and register all 12 consolidated SENTINEL AI agents.

    Architecture:
        Perception Tier (5 agents):
            1. Watcher        — scene monitoring, patrol, anomaly, tamper
            2. Detector        — LPR, PPE, crowd, abandoned objects, vehicle analytics
            3. Audio Sentinel  — audio event detection & classification
            4. Environmental   — sensor monitoring & visual hazard detection
            5. Access Guardian  — PACS, alarm panels, visitor analytics

        Reasoning Tier (2 agents):
            6. Tracker          — cross-camera correlation, ReID, path reconstruction
            7. Threat Analyzer  — threat assessment, micro-behavior, insider threat

        Action Tier (4 agents):
            8. Investigator    — forensic investigation, timeline, evidence
            9. Responder       — response execution, alert dispatch, auto-response
           10. Reporter        — reports, compliance, shift briefings
           11. Red Team        — adversarial self-testing

        Supervisor Tier (1 agent):
           12. Sentinel Cortex — central intelligence coordinator
    """
    # Lazy imports to avoid circular dependencies
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

    # Perception tier
    agent_registry.register(WatcherAgent())
    agent_registry.register(DetectorAgent())
    agent_registry.register(AudioSentinel())
    agent_registry.register(EnvironmentalAgent())
    agent_registry.register(AccessGuardianAgent())

    # Reasoning tier
    agent_registry.register(TrackerAgent())
    agent_registry.register(ThreatAnalyzerAgent())

    # Action tier
    agent_registry.register(InvestigatorAgent())
    agent_registry.register(ResponderAgent())
    agent_registry.register(ReporterAgent())
    agent_registry.register(RedTeamAgent())

    # Supervisor tier
    agent_registry.register(SentinelCortexAgent())

    logger.info(
        "Registered %d consolidated agents (down from 28)",
        len(agent_registry.all_agents),
    )
