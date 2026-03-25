"""Agent lifecycle management — registry, health monitoring, startup/shutdown."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from backend.agents.agent_comms import agent_comms, CH_HEARTBEAT
from backend.agents.base_agent import BaseAgent

logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL = 30  # seconds
HEARTBEAT_MISS_THRESHOLD = 3  # restarts after this many misses


class AgentRegistry:
    """Manages the lifecycle of all SENTINEL AI agents."""

    def __init__(self):
        self._agents: dict[str, BaseAgent] = {}
        self._heartbeats: dict[str, float] = {}
        self._health_task: asyncio.Task | None = None
        self._running = False

    def register(self, agent: BaseAgent):
        """Register an agent (does not start it)."""
        self._agents[agent.name] = agent
        logger.info("Registered agent: %s (tier=%s)", agent.name, agent.tier)

    def get(self, name: str) -> BaseAgent | None:
        return self._agents.get(name)

    @property
    def all_agents(self) -> dict[str, BaseAgent]:
        return dict(self._agents)

    def agents_by_tier(self, tier: str) -> list[BaseAgent]:
        return [a for a in self._agents.values() if a.tier == tier]

    # ── Startup / Shutdown ─────────────────────────────────────

    async def start_all(self):
        """Start all agents in dependency order: perception → reasoning → action → supervisor."""
        self._running = True

        # Connect comms
        await agent_comms.connect()
        await agent_comms.subscribe(CH_HEARTBEAT, self._handle_heartbeat)
        await agent_comms.start_listening()

        # Start by tier order
        for tier in ["perception", "reasoning", "action", "supervisor"]:
            agents = self.agents_by_tier(tier)
            if agents:
                logger.info("Starting %d %s-tier agents...", len(agents), tier)
                for agent in agents:
                    try:
                        await agent.start()
                        self._heartbeats[agent.name] = time.time()
                        await asyncio.sleep(0.2)  # Stagger starts
                    except Exception:
                        logger.exception("Failed to start agent %s", agent.name)

        # Start health monitor
        self._health_task = asyncio.create_task(self._health_monitor())
        logger.info("All %d agents started", len(self._agents))

    async def stop_all(self):
        """Stop all agents in reverse dependency order."""
        self._running = False

        if self._health_task and not self._health_task.done():
            self._health_task.cancel()
            try:
                await self._health_task
            except asyncio.CancelledError:
                pass

        # Stop in reverse order
        for tier in ["supervisor", "action", "reasoning", "perception"]:
            agents = self.agents_by_tier(tier)
            for agent in agents:
                try:
                    await agent.stop()
                except Exception:
                    logger.exception("Error stopping agent %s", agent.name)

        await agent_comms.disconnect()
        logger.info("All agents stopped")

    async def start_agent(self, name: str) -> bool:
        """Start a single agent by name."""
        agent = self._agents.get(name)
        if not agent:
            return False
        await agent.start()
        self._heartbeats[name] = time.time()
        return True

    async def stop_agent(self, name: str) -> bool:
        """Stop a single agent by name."""
        agent = self._agents.get(name)
        if not agent:
            return False
        await agent.stop()
        return True

    async def restart_agent(self, name: str) -> bool:
        """Restart a single agent."""
        await self.stop_agent(name)
        await asyncio.sleep(1)
        return await self.start_agent(name)

    # ── Health Monitoring ──────────────────────────────────────

    async def _handle_heartbeat(self, message: dict):
        """Record heartbeats from agents."""
        agent_name = message.get("agent")
        if agent_name:
            self._heartbeats[agent_name] = time.time()

    async def _health_monitor(self):
        """Periodically check agent health and restart failed agents."""
        try:
            while self._running:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                now = time.time()
                for name, agent in self._agents.items():
                    if not agent._running:
                        continue
                    last_hb = self._heartbeats.get(name, 0)
                    missed = (now - last_hb) / HEARTBEAT_INTERVAL
                    if missed > HEARTBEAT_MISS_THRESHOLD:
                        logger.warning(
                            "Agent %s missed %d heartbeats, restarting...",
                            name, int(missed),
                        )
                        try:
                            await self.restart_agent(name)
                        except Exception:
                            logger.exception("Failed to restart agent %s", name)
        except asyncio.CancelledError:
            pass

    # ── Status ─────────────────────────────────────────────────

    def get_all_status(self) -> list[dict]:
        """Get status of all registered agents."""
        return [agent.status for agent in self._agents.values()]

    def get_fleet_summary(self) -> dict:
        """Get summary of the agent fleet."""
        running = sum(1 for a in self._agents.values() if a._running)
        by_tier = {}
        for a in self._agents.values():
            tier = a.tier
            if tier not in by_tier:
                by_tier[tier] = {"total": 0, "running": 0}
            by_tier[tier]["total"] += 1
            if a._running:
                by_tier[tier]["running"] += 1
        return {
            "total_agents": len(self._agents),
            "running": running,
            "stopped": len(self._agents) - running,
            "by_tier": by_tier,
        }


# Singleton
agent_registry = AgentRegistry()


def setup_all_agents():
    """Create and register all SENTINEL AI agents. Call once at startup."""
    # Lazy imports to avoid circular deps
    from backend.agents.perception.sentinel_eye import SentinelEyeAgent
    from backend.agents.perception.patrol_agent import PatrolAgent
    from backend.agents.perception.anomaly_detector import AnomalyDetectorAgent
    from backend.agents.perception.crowd_monitor import CrowdMonitorAgent
    from backend.agents.perception.lpr_agent import LPRAgent
    from backend.agents.perception.audio_agent import AudioIntelligenceAgent
    from backend.agents.perception.environmental_agent import EnvironmentalSafetyAgent
    from backend.agents.perception.tamper_agent import TamperDetectionAgent
    from backend.agents.perception.ppe_agent import PPEComplianceAgent
    from backend.agents.reasoning.threat_analyst import ThreatAnalystAgent
    from backend.agents.reasoning.investigator import InvestigatorAgent
    from backend.agents.reasoning.correlator import CorrelatorAgent
    from backend.agents.reasoning.reid_agent import ReIDAgent
    from backend.agents.action.response_agent import ResponseActionAgent
    from backend.agents.action.report_agent import ReportAgent
    from backend.agents.action.dispatch_agent import DispatchAgent
    from backend.agents.action.compliance_agent import ComplianceAgent
    from backend.agents.perception.micro_behavior_agent import MicroBehaviorAgent
    from backend.agents.reasoning.ghost_tracer_agent import GhostTracerAgent
    from backend.agents.reasoning.companion_agent import CompanionDiscoveryAgent
    from backend.agents.orchestrator import SentinelCortex

    # Perception tier
    agent_registry.register(SentinelEyeAgent())
    agent_registry.register(PatrolAgent())
    agent_registry.register(AnomalyDetectorAgent())
    agent_registry.register(CrowdMonitorAgent())
    agent_registry.register(LPRAgent())
    agent_registry.register(AudioIntelligenceAgent())
    agent_registry.register(EnvironmentalSafetyAgent())
    agent_registry.register(TamperDetectionAgent())
    agent_registry.register(PPEComplianceAgent())
    agent_registry.register(MicroBehaviorAgent())

    # Reasoning tier
    agent_registry.register(ThreatAnalystAgent())
    agent_registry.register(InvestigatorAgent())
    agent_registry.register(CorrelatorAgent())
    agent_registry.register(ReIDAgent())
    agent_registry.register(GhostTracerAgent())
    agent_registry.register(CompanionDiscoveryAgent())

    # Action tier
    agent_registry.register(ResponseActionAgent())
    agent_registry.register(ReportAgent())
    agent_registry.register(DispatchAgent())
    agent_registry.register(ComplianceAgent())

    # Supervisor
    agent_registry.register(SentinelCortex())

    logger.info("Registered %d agents", len(agent_registry.all_agents))
