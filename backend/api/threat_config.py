"""Adaptive Threat Configuration API — deploy AI sentinels via NLP or quick-start protocols.

All mutable state (active protocol, sensitivity, detection rules, deployed scenarios)
is persisted to the SystemSetting table and survives server restarts.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from backend.api.auth import get_current_user, require_role
from backend.database import async_session
from backend.models.models import UserRole
from backend.models.system_settings import SystemSetting
from backend.agents.agent_registry import agent_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/threat-config", tags=["threat-config"])


# ── Schemas ───────────────────────────────────────────────────

class NLPDeployRequest(BaseModel):
    command: str = Field(..., description="Natural language deployment command")

class ProtocolDeployRequest(BaseModel):
    protocol_id: str
    parameters: Optional[Dict[str, Any]] = None

class SensitivityUpdate(BaseModel):
    perception_sensitivity: Optional[float] = Field(None, ge=0.0, le=1.0)
    anomaly_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    threat_escalation_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    crowd_density_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)

class DetectionRule(BaseModel):
    id: Optional[str] = None
    name: str
    description: str
    category: str  # intrusion, anomaly, crowd, compliance, custom
    conditions: Dict[str, Any]
    actions: List[str]  # alert, escalate, dispatch, lock_zone, notify
    severity: str  # critical, high, medium, low
    enabled: bool = True

class AgentTierConfig(BaseModel):
    tier: str
    agents: List[str]
    action: str  # start, stop, restart

class QuickScenarioDeploy(BaseModel):
    scenario_id: str

class CustomScenarioDeploy(BaseModel):
    description: str = Field(..., min_length=5, max_length=2000, description="Natural language threat scenario description")


# ── Persistent Config Store ───────────────────────────────────

_DEFAULT_ACTIVE_PROTOCOL = {
    "protocol_id": "standard",
    "name": "Standard Monitoring",
    "deployed_at": datetime.now(timezone.utc).isoformat(),
    "status": "active",
}

_DEFAULT_SENSITIVITY = {
    "perception_sensitivity": 0.7,
    "anomaly_threshold": 0.65,
    "threat_escalation_threshold": 0.8,
    "crowd_density_threshold": 0.75,
}

_DEFAULT_RULES = [
    {
        "id": str(uuid.uuid4()),
        "name": "Perimeter Breach Detection",
        "description": "Detect unauthorized entry through restricted perimeter zones",
        "category": "intrusion",
        "conditions": {"zone_type": "restricted", "person_detected": True, "authorized": False},
        "actions": ["alert", "escalate", "dispatch"],
        "severity": "critical",
        "enabled": True,
    },
    {
        "id": str(uuid.uuid4()),
        "name": "Crowd Density Alert",
        "description": "Alert when crowd density exceeds safe threshold in monitored zones",
        "category": "crowd",
        "conditions": {"density_threshold": 0.8, "sustained_seconds": 30},
        "actions": ["alert", "notify"],
        "severity": "high",
        "enabled": True,
    },
    {
        "id": str(uuid.uuid4()),
        "name": "Loitering Detection",
        "description": "Detect individuals loitering in sensitive areas beyond time threshold",
        "category": "anomaly",
        "conditions": {"zone_type": "sensitive", "dwell_time_seconds": 300, "stationary": True},
        "actions": ["alert"],
        "severity": "medium",
        "enabled": True,
    },
    {
        "id": str(uuid.uuid4()),
        "name": "Tailgating Prevention",
        "description": "Detect multiple individuals entering through a single access event",
        "category": "intrusion",
        "conditions": {"access_point": True, "person_count_gt": 1, "single_auth_event": True},
        "actions": ["alert", "escalate"],
        "severity": "high",
        "enabled": True,
    },
    {
        "id": str(uuid.uuid4()),
        "name": "After-Hours Activity",
        "description": "Flag any human activity detected outside of business hours",
        "category": "compliance",
        "conditions": {"time_range": "22:00-06:00", "person_detected": True},
        "actions": ["alert", "notify"],
        "severity": "medium",
        "enabled": True,
    },
]


class ThreatConfigStore:
    """Persists threat configuration to SystemSetting table with in-memory cache."""

    _KEY_PROTOCOL = "threat.active_protocol"
    _KEY_SENSITIVITY = "threat.sensitivity"
    _KEY_RULES = "threat.detection_rules"
    _KEY_SCENARIOS = "threat.deployed_scenarios"

    def __init__(self):
        self._cache: Dict[str, Any] = {}
        self._initialized = False

    async def _ensure_init(self):
        if self._initialized:
            return
        try:
            async with async_session() as session:
                for key, default in [
                    (self._KEY_PROTOCOL, _DEFAULT_ACTIVE_PROTOCOL),
                    (self._KEY_SENSITIVITY, _DEFAULT_SENSITIVITY),
                    (self._KEY_RULES, _DEFAULT_RULES),
                    (self._KEY_SCENARIOS, []),
                ]:
                    result = await session.execute(
                        select(SystemSetting).where(SystemSetting.key == key)
                    )
                    setting = result.scalar_one_or_none()
                    if setting:
                        self._cache[key] = json.loads(setting.value)
                    else:
                        self._cache[key] = default
                        session.add(SystemSetting(key=key, value=json.dumps(default, default=str)))
                        await session.commit()
        except Exception as e:
            logger.warning("threat_config.init_failed: %s — using defaults", e)
            self._cache = {
                self._KEY_PROTOCOL: _DEFAULT_ACTIVE_PROTOCOL,
                self._KEY_SENSITIVITY: _DEFAULT_SENSITIVITY,
                self._KEY_RULES: _DEFAULT_RULES,
                self._KEY_SCENARIOS: [],
            }
        self._initialized = True

    async def _save(self, key: str):
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == key)
                )
                setting = result.scalar_one_or_none()
                value_json = json.dumps(self._cache[key], default=str)
                if setting:
                    setting.value = value_json
                    setting.updated_at = datetime.now(timezone.utc)
                else:
                    session.add(SystemSetting(key=key, value=value_json))
                await session.commit()
        except Exception as e:
            logger.error("threat_config.save_failed key=%s: %s", key, e)

    @property
    async def active_protocol(self) -> Dict[str, Any]:
        await self._ensure_init()
        return self._cache[self._KEY_PROTOCOL]

    async def set_active_protocol(self, protocol: Dict[str, Any]):
        await self._ensure_init()
        self._cache[self._KEY_PROTOCOL] = protocol
        await self._save(self._KEY_PROTOCOL)

    @property
    async def sensitivity(self) -> Dict[str, float]:
        await self._ensure_init()
        return self._cache[self._KEY_SENSITIVITY]

    async def update_sensitivity(self, updates: Dict[str, float]):
        await self._ensure_init()
        self._cache[self._KEY_SENSITIVITY].update(updates)
        await self._save(self._KEY_SENSITIVITY)

    @property
    async def detection_rules(self) -> List[Dict[str, Any]]:
        await self._ensure_init()
        return self._cache[self._KEY_RULES]

    async def set_detection_rules(self, rules: List[Dict[str, Any]]):
        await self._ensure_init()
        self._cache[self._KEY_RULES] = rules
        await self._save(self._KEY_RULES)

    @property
    async def deployed_scenarios(self) -> List[Dict[str, Any]]:
        await self._ensure_init()
        return self._cache[self._KEY_SCENARIOS]

    async def add_deployed_scenario(self, scenario: Dict[str, Any]):
        await self._ensure_init()
        self._cache[self._KEY_SCENARIOS].append(scenario)
        await self._save(self._KEY_SCENARIOS)


_store = ThreatConfigStore()


# ── Quick-Start Protocols (static templates) ──────────────────

PROTOCOLS = {
    "standard": {
        "id": "standard",
        "name": "Standard Monitoring",
        "description": "Balanced surveillance with all agents active at normal sensitivity. Ideal for day-to-day operations.",
        "icon": "shield",
        "color": "cyan",
        "agents": {
            "perception": ["sentinel_eye", "patrol_agent", "anomaly_detector", "crowd_monitor"],
            "reasoning": ["threat_analyst", "correlator", "predictor", "investigator"],
            "action": ["response_agent", "dispatch_agent", "report_agent", "compliance_agent"],
            "supervisor": ["sentinel_cortex"],
        },
        "sensitivity": {
            "perception_sensitivity": 0.7,
            "anomaly_threshold": 0.65,
            "threat_escalation_threshold": 0.8,
            "crowd_density_threshold": 0.75,
        },
        "tier_status": {"perception": True, "reasoning": True, "action": True, "supervisor": True},
    },
    "perimeter_defense": {
        "id": "perimeter_defense",
        "name": "Perimeter Defense",
        "description": "Enhanced perimeter monitoring with high sensitivity on intrusion detection. Focused on entry points and restricted zones.",
        "icon": "target",
        "color": "orange",
        "agents": {
            "perception": ["sentinel_eye", "patrol_agent", "anomaly_detector"],
            "reasoning": ["threat_analyst", "correlator", "predictor"],
            "action": ["response_agent", "dispatch_agent"],
            "supervisor": ["sentinel_cortex"],
        },
        "sensitivity": {
            "perception_sensitivity": 0.9,
            "anomaly_threshold": 0.5,
            "threat_escalation_threshold": 0.6,
            "crowd_density_threshold": 0.8,
        },
        "tier_status": {"perception": True, "reasoning": True, "action": True, "supervisor": True},
    },
    "crowd_control": {
        "id": "crowd_control",
        "name": "Crowd Control",
        "description": "Optimized for high-density areas and events. Prioritizes crowd behavior analysis and density monitoring.",
        "icon": "users",
        "color": "violet",
        "agents": {
            "perception": ["sentinel_eye", "crowd_monitor", "anomaly_detector"],
            "reasoning": ["threat_analyst", "correlator", "predictor"],
            "action": ["response_agent", "dispatch_agent", "report_agent"],
            "supervisor": ["sentinel_cortex"],
        },
        "sensitivity": {
            "perception_sensitivity": 0.75,
            "anomaly_threshold": 0.6,
            "threat_escalation_threshold": 0.7,
            "crowd_density_threshold": 0.5,
        },
        "tier_status": {"perception": True, "reasoning": True, "action": True, "supervisor": True},
    },
    "full_lockdown": {
        "id": "full_lockdown",
        "name": "Full Lockdown",
        "description": "Maximum security posture. All agents at maximum sensitivity. Every anomaly triggers immediate escalation.",
        "icon": "lock",
        "color": "red",
        "agents": {
            "perception": ["sentinel_eye", "patrol_agent", "anomaly_detector", "crowd_monitor"],
            "reasoning": ["threat_analyst", "investigator", "correlator", "predictor"],
            "action": ["response_agent", "dispatch_agent", "report_agent", "compliance_agent"],
            "supervisor": ["sentinel_cortex"],
        },
        "sensitivity": {
            "perception_sensitivity": 0.95,
            "anomaly_threshold": 0.3,
            "threat_escalation_threshold": 0.4,
            "crowd_density_threshold": 0.4,
        },
        "tier_status": {"perception": True, "reasoning": True, "action": True, "supervisor": True},
    },
    "stealth_ops": {
        "id": "stealth_ops",
        "name": "Stealth Operations",
        "description": "Silent monitoring mode. Perception agents only, no automated responses. Ideal for covert surveillance operations.",
        "icon": "eye",
        "color": "emerald",
        "agents": {
            "perception": ["sentinel_eye", "anomaly_detector"],
            "reasoning": ["threat_analyst", "correlator"],
            "action": [],
            "supervisor": ["sentinel_cortex"],
        },
        "sensitivity": {
            "perception_sensitivity": 0.85,
            "anomaly_threshold": 0.55,
            "threat_escalation_threshold": 0.9,
            "crowd_density_threshold": 0.8,
        },
        "tier_status": {"perception": True, "reasoning": True, "action": False, "supervisor": True},
    },
    "compliance_audit": {
        "id": "compliance_audit",
        "name": "Compliance Audit",
        "description": "Full compliance monitoring with detailed audit logging. Ensures regulatory adherence and evidence collection.",
        "icon": "clipboard",
        "color": "blue",
        "agents": {
            "perception": ["sentinel_eye", "patrol_agent"],
            "reasoning": ["threat_analyst", "investigator", "correlator"],
            "action": ["report_agent", "compliance_agent"],
            "supervisor": ["sentinel_cortex"],
        },
        "sensitivity": {
            "perception_sensitivity": 0.8,
            "anomaly_threshold": 0.6,
            "threat_escalation_threshold": 0.75,
            "crowd_density_threshold": 0.7,
        },
        "tier_status": {"perception": True, "reasoning": True, "action": True, "supervisor": True},
    },
}


# ── 1. List available protocols ──────────────────────────────

@router.get("/protocols")
async def list_protocols(_user=Depends(get_current_user)):
    """Get all available quick-start security protocols."""
    return {
        "protocols": list(PROTOCOLS.values()),
        "active_protocol": await _store.active_protocol,
    }


# ── 2. Get active configuration ─────────────────────────────

@router.get("/active")
async def get_active_config(_user=Depends(get_current_user)):
    """Get the currently active threat configuration."""
    fleet = agent_registry.get_fleet_summary()
    all_status = agent_registry.get_all_status()
    rules = await _store.detection_rules

    return {
        "protocol": await _store.active_protocol,
        "sensitivity": await _store.sensitivity,
        "fleet": fleet,
        "agents": all_status,
        "rules_count": len([r for r in rules if r.get("enabled")]),
        "total_rules": len(rules),
    }


# ── 3. Deploy a protocol ────────────────────────────────────

@router.post("/deploy")
async def deploy_protocol(
    body: ProtocolDeployRequest,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Deploy a quick-start security protocol. Configures agents and sensitivity."""
    protocol = PROTOCOLS.get(body.protocol_id)
    if not protocol:
        raise HTTPException(status_code=404, detail=f"Protocol '{body.protocol_id}' not found")

    # Update sensitivity
    await _store.update_sensitivity(protocol["sensitivity"])

    # Track which agents should be running for this protocol
    target_agents = set()
    for tier_agents in protocol["agents"].values():
        target_agents.update(tier_agents)

    # Start/stop agents based on protocol
    results = {"started": [], "stopped": [], "already_running": [], "already_stopped": [], "errors": []}
    all_agents = agent_registry.all_agents

    for agent_name, agent in all_agents.items():
        should_run = agent_name in target_agents
        is_running = agent._running

        if should_run and not is_running:
            try:
                await agent_registry.start_agent(agent_name)
                results["started"].append(agent_name)
            except Exception as e:
                results["errors"].append({"agent": agent_name, "error": str(e)})
        elif not should_run and is_running:
            try:
                await agent_registry.stop_agent(agent_name)
                results["stopped"].append(agent_name)
            except Exception as e:
                results["errors"].append({"agent": agent_name, "error": str(e)})
        elif should_run and is_running:
            results["already_running"].append(agent_name)
        else:
            results["already_stopped"].append(agent_name)

    new_protocol = {
        "protocol_id": protocol["id"],
        "name": protocol["name"],
        "deployed_at": datetime.now(timezone.utc).isoformat(),
        "status": "active",
        "deployment_results": results,
    }
    await _store.set_active_protocol(new_protocol)

    logger.info("Protocol deployed: %s", protocol["name"])

    return {
        "status": "deployed",
        "protocol": new_protocol,
        "sensitivity": await _store.sensitivity,
        "results": results,
    }


# ── 4. NLP deployment command ────────────────────────────────

@router.post("/nlp-deploy")
async def nlp_deploy(
    body: NLPDeployRequest,
    _user=Depends(get_current_user),
):
    """Process a natural language deployment command via Sentinel Cortex."""
    cortex = agent_registry.get("sentinel_cortex")
    if cortex is None or not cortex._running:
        raise HTTPException(
            status_code=503,
            detail="Sentinel Cortex is not available for NLP processing",
        )

    active_protocol = await _store.active_protocol
    sensitivity = await _store.sensitivity

    enhanced_prompt = (
        f"OPERATOR THREAT CONFIGURATION COMMAND:\n"
        f"{body.command}\n\n"
        f"CONTEXT: The operator is using the Adaptive Threat Configuration interface. "
        f"They want to configure the security system. "
        f"Current active protocol: {active_protocol.get('name', 'Unknown')}. "
        f"Available protocols: {', '.join(p['name'] for p in PROTOCOLS.values())}. "
        f"Current sensitivity levels: {sensitivity}. "
        f"Please interpret their command and provide a detailed action plan. "
        f"If they want to activate a specific protocol, identify which one. "
        f"If they want to adjust sensitivity, specify the new values. "
        f"If they want to start/stop specific agents, list them."
    )

    try:
        result = await cortex.handle_operator_chat(enhanced_prompt)
        return {
            "status": "processed",
            "command": body.command,
            "cortex_response": result,
            "current_protocol": active_protocol,
        }
    except Exception as e:
        logger.exception("NLP deploy error")
        raise HTTPException(status_code=500, detail=f"NLP processing error: {str(e)}")


# ── 5. Update sensitivity ───────────────────────────────────

@router.put("/sensitivity")
async def update_sensitivity(
    body: SensitivityUpdate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Update threat detection sensitivity levels."""
    updates = body.model_dump(exclude_none=True)
    await _store.update_sensitivity(updates)

    logger.info("Sensitivity updated: %s", updates)

    return {
        "status": "updated",
        "sensitivity": await _store.sensitivity,
    }


# ── 6. Get sensitivity config ───────────────────────────────

@router.get("/sensitivity")
async def get_sensitivity(_user=Depends(get_current_user)):
    """Get current threat detection sensitivity configuration."""
    return await _store.sensitivity


# ── 7. List detection rules ─────────────────────────────────

@router.get("/rules")
async def list_rules(_user=Depends(get_current_user)):
    """Get all detection rules."""
    rules = await _store.detection_rules
    return {
        "rules": rules,
        "total": len(rules),
        "active": len([r for r in rules if r.get("enabled")]),
    }


# ── 8. Create detection rule ────────────────────────────────

@router.post("/rules")
async def create_rule(
    body: DetectionRule,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Create a new detection rule."""
    rules = await _store.detection_rules
    rule = body.model_dump()
    rule["id"] = str(uuid.uuid4())
    rules.append(rule)
    await _store.set_detection_rules(rules)

    logger.info("Detection rule created: %s", rule["name"])

    return {"status": "created", "rule": rule}


# ── 9. Update detection rule ────────────────────────────────

@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: str,
    body: DetectionRule,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Update an existing detection rule."""
    rules = await _store.detection_rules
    for i, rule in enumerate(rules):
        if rule["id"] == rule_id:
            updated = body.model_dump()
            updated["id"] = rule_id
            rules[i] = updated
            await _store.set_detection_rules(rules)
            return {"status": "updated", "rule": updated}

    raise HTTPException(status_code=404, detail="Rule not found")


# ── 10. Delete detection rule ────────────────────────────────

@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: str,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Delete a detection rule."""
    rules = await _store.detection_rules
    new_rules = [r for r in rules if r["id"] != rule_id]

    if len(new_rules) == len(rules):
        raise HTTPException(status_code=404, detail="Rule not found")

    await _store.set_detection_rules(new_rules)
    return {"status": "deleted", "rule_id": rule_id}


# ── 11. Toggle detection rule ────────────────────────────────

@router.post("/rules/{rule_id}/toggle")
async def toggle_rule(
    rule_id: str,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Enable or disable a detection rule."""
    rules = await _store.detection_rules
    for rule in rules:
        if rule["id"] == rule_id:
            rule["enabled"] = not rule.get("enabled", True)
            await _store.set_detection_rules(rules)
            return {"status": "toggled", "rule": rule}

    raise HTTPException(status_code=404, detail="Rule not found")


# ── 12. Configure agent tier ────────────────────────────────

@router.post("/tier-config")
async def configure_tier(
    body: AgentTierConfig,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Start, stop, or restart all agents in a specific tier."""
    tier_agents = agent_registry.agents_by_tier(body.tier)
    if not tier_agents:
        raise HTTPException(status_code=404, detail=f"No agents found in tier '{body.tier}'")

    results = {"success": [], "errors": []}

    for agent in tier_agents:
        if body.agents and agent.name not in body.agents:
            continue
        try:
            if body.action == "start":
                await agent_registry.start_agent(agent.name)
            elif body.action == "stop":
                await agent_registry.stop_agent(agent.name)
            elif body.action == "restart":
                await agent_registry.restart_agent(agent.name)
            results["success"].append(agent.name)
        except Exception as e:
            results["errors"].append({"agent": agent.name, "error": str(e)})

    return {"status": "completed", "tier": body.tier, "action": body.action, "results": results}


# ── Quick-Deploy Threat Scenarios (static templates) ─────────

QUICK_SCENARIOS = [
    {
        "id": "perimeter_breach",
        "name": "Perimeter Breach",
        "description": "After-hours intrusion detection.",
        "icon": "target",
        "sensitivity_overrides": {
            "perception_sensitivity": 0.9,
            "anomaly_threshold": 0.45,
            "threat_escalation_threshold": 0.55,
        },
        "rules_to_enable": ["Perimeter Breach Detection", "After-Hours Activity"],
        "agents_focus": ["sentinel_eye", "patrol_agent", "anomaly_detector", "threat_analyst"],
    },
    {
        "id": "server_room_loitering",
        "name": "Server Room Loitering",
        "description": "Sensitive zone dwell time monitoring.",
        "icon": "clock",
        "sensitivity_overrides": {
            "perception_sensitivity": 0.85,
            "anomaly_threshold": 0.4,
        },
        "rules_to_enable": ["Loitering Detection"],
        "agents_focus": ["sentinel_eye", "anomaly_detector", "threat_analyst", "reid_agent"],
    },
    {
        "id": "unattended_object",
        "name": "Unattended Object",
        "description": "Abandoned package detection in public areas.",
        "icon": "package",
        "sensitivity_overrides": {
            "perception_sensitivity": 0.92,
            "anomaly_threshold": 0.35,
            "threat_escalation_threshold": 0.5,
        },
        "rules_to_enable": [],
        "agents_focus": ["sentinel_eye", "anomaly_detector", "threat_analyst", "environmental_agent"],
    },
    {
        "id": "crowd_dynamics",
        "name": "Crowd Dynamics",
        "description": "Unusual gathering or mob detection.",
        "icon": "users",
        "sensitivity_overrides": {
            "perception_sensitivity": 0.8,
            "crowd_density_threshold": 0.45,
            "anomaly_threshold": 0.5,
        },
        "rules_to_enable": ["Crowd Density Alert"],
        "agents_focus": ["sentinel_eye", "crowd_monitor", "anomaly_detector", "threat_analyst"],
    },
]


# ── 13. List quick-deploy scenarios ───────────────────────────

@router.get("/quick-scenarios")
async def list_quick_scenarios(_user=Depends(get_current_user)):
    """Get available quick-deploy threat scenarios."""
    return {
        "scenarios": QUICK_SCENARIOS,
        "deployed": await _store.deployed_scenarios,
    }


# ── 14. Deploy a quick scenario ───────────────────────────────

@router.post("/deploy-scenario")
async def deploy_quick_scenario(
    body: QuickScenarioDeploy,
    _user=Depends(get_current_user),
):
    """Deploy a predefined quick threat scenario."""
    scenario = next((s for s in QUICK_SCENARIOS if s["id"] == body.scenario_id), None)
    if not scenario:
        raise HTTPException(status_code=404, detail=f"Scenario '{body.scenario_id}' not found")

    # Apply sensitivity overrides
    await _store.update_sensitivity(scenario["sensitivity_overrides"])

    # Enable associated rules
    rules = await _store.detection_rules
    for rule in rules:
        if rule["name"] in scenario["rules_to_enable"]:
            rule["enabled"] = True
    await _store.set_detection_rules(rules)

    # Track deployment
    deployment = {
        "id": str(uuid.uuid4()),
        "scenario_id": scenario["id"],
        "scenario_name": scenario["name"],
        "deployed_at": datetime.now(timezone.utc).isoformat(),
        "status": "active",
        "sensitivity_applied": scenario["sensitivity_overrides"],
        "agents_focused": scenario["agents_focus"],
    }
    await _store.add_deployed_scenario(deployment)

    logger.info("Quick scenario deployed: %s", scenario["name"])

    return {
        "status": "deployed",
        "deployment": deployment,
        "sensitivity": await _store.sensitivity,
    }


# ── 15. Deploy custom threat scenario ─────────────────────────

@router.post("/deploy-custom-scenario")
async def deploy_custom_scenario(
    body: CustomScenarioDeploy,
    _user=Depends(get_current_user),
):
    """Deploy a custom threat scenario described in natural language."""
    cortex = agent_registry.get("sentinel_cortex")

    if cortex is None or not cortex._running:
        # Fallback: create a generic high-sensitivity deployment
        overrides = {
            "perception_sensitivity": 0.85,
            "anomaly_threshold": 0.45,
            "threat_escalation_threshold": 0.6,
        }
        await _store.update_sensitivity(overrides)

        deployment = {
            "id": str(uuid.uuid4()),
            "scenario_id": "custom",
            "scenario_name": f"Custom: {body.description[:60]}",
            "deployed_at": datetime.now(timezone.utc).isoformat(),
            "status": "active",
            "description": body.description,
            "cortex_analysis": "Sentinel Cortex unavailable — deployed with elevated baseline sensitivity.",
            "sensitivity_applied": overrides,
        }
        await _store.add_deployed_scenario(deployment)

        return {
            "status": "deployed",
            "deployment": deployment,
            "sensitivity": await _store.sensitivity,
        }

    # Route through Cortex for intelligent deployment
    sensitivity = await _store.sensitivity
    enhanced_prompt = (
        f"CUSTOM THREAT SCENARIO DEPLOYMENT:\n"
        f"Operator describes: {body.description}\n\n"
        f"Analyze this threat scenario and recommend:\n"
        f"1. Which detection sensitivity levels to apply\n"
        f"2. Which agents should be prioritized\n"
        f"3. What detection rules should be enabled or created\n"
        f"4. Recommended response actions\n\n"
        f"Current sensitivity: {sensitivity}\n"
        f"Available agents: {[a.name for a in agent_registry.all_agents.values()]}\n"
    )

    try:
        result = await cortex.handle_operator_chat(enhanced_prompt)
        cortex_text = result.get("response", "Scenario analysis complete.")
    except Exception as e:
        cortex_text = f"Cortex analysis error: {str(e)}. Deployed with elevated sensitivity."

    overrides = {
        "perception_sensitivity": 0.88,
        "anomaly_threshold": 0.4,
        "threat_escalation_threshold": 0.55,
    }
    await _store.update_sensitivity(overrides)

    deployment = {
        "id": str(uuid.uuid4()),
        "scenario_id": "custom",
        "scenario_name": f"Custom: {body.description[:60]}",
        "deployed_at": datetime.now(timezone.utc).isoformat(),
        "status": "active",
        "description": body.description,
        "cortex_analysis": cortex_text,
        "sensitivity_applied": overrides,
    }
    await _store.add_deployed_scenario(deployment)

    logger.info("Custom scenario deployed: %s", body.description[:60])

    return {
        "status": "deployed",
        "deployment": deployment,
        "cortex_analysis": cortex_text,
        "sensitivity": await _store.sensitivity,
    }


# ── 16. Threat metrics overview ───────────────────────────────

@router.get("/metrics")
async def get_threat_metrics(_user=Depends(get_current_user)):
    """Get real-time threat detection metrics and signature statistics."""
    from backend.services.threat_engine import threat_engine

    rules = await _store.detection_rules
    sensitivity = await _store.sensitivity
    protocol = await _store.active_protocol
    deployed = await _store.deployed_scenarios

    # Signature stats by category
    all_categories = threat_engine.get_all_categories()
    category_stats = []
    for cat in sorted(all_categories):
        sigs = threat_engine.get_signatures_by_category(cat)
        category_stats.append({
            "category": cat,
            "count": len(sigs),
            "signatures": [
                {
                    "name": s.name,
                    "severity": s.severity,
                    "detection_method": s.detection_method,
                    "detection_count": getattr(s, "detection_count", 0),
                }
                for s in sigs
            ],
        })

    # Agent health
    all_agents = agent_registry.get_all_status()
    running_count = sum(1 for a in all_agents if a.get("running"))
    total_agents = len(all_agents)

    # Rule stats
    enabled_rules = [r for r in rules if r.get("enabled")]
    rules_by_severity = {}
    for r in enabled_rules:
        sev = r.get("severity", "medium")
        rules_by_severity[sev] = rules_by_severity.get(sev, 0) + 1

    rules_by_category = {}
    for r in enabled_rules:
        cat = r.get("category", "custom")
        rules_by_category[cat] = rules_by_category.get(cat, 0) + 1

    return {
        "total_signatures": threat_engine.get_signature_count(),
        "total_categories": len(all_categories),
        "category_stats": category_stats,
        "agents_running": running_count,
        "agents_total": total_agents,
        "active_rules": len(enabled_rules),
        "total_rules": len(rules),
        "rules_by_severity": rules_by_severity,
        "rules_by_category": rules_by_category,
        "sensitivity": sensitivity,
        "active_protocol": protocol.get("name", "Unknown") if protocol else "None",
        "deployed_scenarios_count": len([d for d in deployed if d.get("status") == "active"]),
    }


# ── 17. Deployment history ────────────────────────────────────

@router.get("/deployment-history")
async def get_deployment_history(_user=Depends(get_current_user)):
    """Get full deployment history of protocols and scenarios."""
    deployed = await _store.deployed_scenarios
    protocol = await _store.active_protocol

    return {
        "active_protocol": protocol,
        "deployments": list(reversed(deployed)),  # newest first
        "total": len(deployed),
    }


# ── 18. Deactivate a deployed scenario ────────────────────────

@router.post("/deployments/{deployment_id}/deactivate")
async def deactivate_deployment(
    deployment_id: str,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Deactivate a deployed scenario."""
    await _store._ensure_init()
    scenarios = _store._cache[_store._KEY_SCENARIOS]

    found = False
    for s in scenarios:
        if s.get("id") == deployment_id:
            s["status"] = "deactivated"
            s["deactivated_at"] = datetime.now(timezone.utc).isoformat()
            found = True
            break

    if not found:
        raise HTTPException(status_code=404, detail="Deployment not found")

    await _store._save(_store._KEY_SCENARIOS)

    # Reset sensitivity to defaults
    await _store.update_sensitivity(_DEFAULT_SENSITIVITY)

    return {
        "status": "deactivated",
        "deployment_id": deployment_id,
        "sensitivity": await _store.sensitivity,
    }


# ── 19. Bulk rule operations ──────────────────────────────────

class BulkRuleAction(BaseModel):
    rule_ids: List[str]
    action: str  # enable, disable, delete

@router.post("/rules/bulk")
async def bulk_rule_action(
    body: BulkRuleAction,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Bulk enable/disable/delete detection rules."""
    rules = await _store.detection_rules

    if body.action == "delete":
        rules = [r for r in rules if r["id"] not in body.rule_ids]
    elif body.action in ("enable", "disable"):
        for r in rules:
            if r["id"] in body.rule_ids:
                r["enabled"] = body.action == "enable"

    await _store.set_detection_rules(rules)

    return {
        "status": "completed",
        "action": body.action,
        "affected": len(body.rule_ids),
        "total_rules": len(rules),
        "active_rules": len([r for r in rules if r.get("enabled")]),
    }
