"""Agent management API — lifecycle control, audit, memory, and real-time activity."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user, require_role
from backend.database import get_db
from backend.models.models import UserRole
from backend.models.agent_state import AgentState, AgentMemory
from backend.models.agent_audit import AgentAuditLog
from backend.agents.agent_registry import agent_registry
from backend.agents.agent_comms import agent_comms, ALL_CHANNELS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["agents"])


# ── Request / Response Schemas ────────────────────────────────

class OperatorChatRequest(BaseModel):
    query: str


# ── Helpers ───────────────────────────────────────────────────

def _agent_or_404(agent_name: str):
    """Return the agent from the registry or raise 404."""
    agent = agent_registry.get(agent_name)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")
    return agent


# ── 1. Fleet-wide agent status ────────────────────────────────

@router.get("/status")
async def get_all_agents_status(
    _user=Depends(get_current_user),
):
    """Get status of all registered agents plus a fleet summary."""
    agents_status = agent_registry.get_all_status()
    fleet_summary = agent_registry.get_fleet_summary()
    return {
        "agents": agents_status,
        "fleet": fleet_summary,
    }


# ── 1b. Per-agent performance metrics ────────────────────────

@router.get("/metrics")
async def get_agent_metrics(
    _user=Depends(get_current_user),
):
    """Get per-agent performance metrics."""
    metrics = {}
    for name, agent in agent_registry._agents.items():
        metrics[name] = {
            "tier": agent.tier,
            "is_running": agent._running,
            "cycle_count": getattr(agent, '_cycle_count', 0),
            "total_tokens": getattr(agent, '_total_tokens_session', 0),
            "error_count": getattr(agent, '_error_count', 0),
            "circuit_breaker_open": getattr(agent, '_circuit_open', False),
            "idle_streak": getattr(agent, '_idle_streak', 0),
            "last_cycle_time": getattr(agent, '_last_cycle_at', None),
            "avg_cycle_time": getattr(agent, '_avg_cycle_time', 0),
        }
    return {"success": True, "agents": metrics}


# ── 2. Single agent status ───────────────────────────────────

@router.get("/{agent_name}/status")
async def get_agent_status(
    agent_name: str,
    _user=Depends(get_current_user),
):
    """Get the status of a single agent by name."""
    agent = _agent_or_404(agent_name)
    return agent.status


# ── 3. Start agent ───────────────────────────────────────────

@router.post("/{agent_name}/start")
async def start_agent(
    agent_name: str,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Start a single agent. Requires ADMIN role."""
    _agent_or_404(agent_name)
    success = await agent_registry.start_agent(agent_name)
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to start agent '{agent_name}'")
    return {"status": "started", "agent": agent_name}


# ── 4. Stop agent ────────────────────────────────────────────

@router.post("/{agent_name}/stop")
async def stop_agent(
    agent_name: str,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Stop a single agent. Requires ADMIN role."""
    _agent_or_404(agent_name)
    success = await agent_registry.stop_agent(agent_name)
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to stop agent '{agent_name}'")
    return {"status": "stopped", "agent": agent_name}


# ── 5. Restart agent ─────────────────────────────────────────

@router.post("/{agent_name}/restart")
async def restart_agent(
    agent_name: str,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Restart a single agent. Requires ADMIN role."""
    _agent_or_404(agent_name)
    success = await agent_registry.restart_agent(agent_name)
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to restart agent '{agent_name}'")
    return {"status": "restarted", "agent": agent_name}


# ── 5b. Reset agent errors ─────────────────────────────────

@router.post("/{agent_name}/reset-errors")
async def reset_agent_errors(
    agent_name: str,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Reset error counters and circuit breaker for a single agent."""
    agent = _agent_or_404(agent_name)
    agent.reset_errors()
    return {"status": "errors_reset", "agent": agent_name, **agent.status}


@router.post("/reset-all-errors")
async def reset_all_agent_errors(
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Reset error counters and circuit breakers for all agents."""
    results = []
    for name, agent in agent_registry._agents.items():
        agent.reset_errors()
        results.append({"agent": name, "status_text": agent.status_text, "error_count": agent._error_count})
    return {"status": "all_errors_reset", "agents": results}


# ── 5c. Start / Stop all agents ────────────────────────────

@router.post("/start-all")
async def start_all_agents(
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Start all agents in tier order. Requires ADMIN role."""
    try:
        await agent_registry.start_all()
        summary = agent_registry.get_fleet_summary()
        return {"status": "started", **summary}
    except Exception as e:
        logger.exception("Failed to start all agents")
        raise HTTPException(status_code=500, detail=f"Failed to start agents: {e}")


@router.post("/stop-all")
async def stop_all_agents(
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Stop all agents in reverse tier order. Requires ADMIN role."""
    try:
        await agent_registry.stop_all()
        summary = agent_registry.get_fleet_summary()
        return {"status": "stopped", **summary}
    except Exception as e:
        logger.exception("Failed to stop all agents")
        raise HTTPException(status_code=500, detail=f"Failed to stop agents: {e}")


# ── 6. Global audit log ──────────────────────────────────────

@router.get("/audit")
async def get_audit_log(
    agent_name: Optional[str] = Query(None, description="Filter by agent name"),
    action_type: Optional[str] = Query(None, description="Filter by action type"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get agent audit log entries with optional filters."""
    stmt = select(AgentAuditLog)

    if agent_name is not None:
        stmt = stmt.where(AgentAuditLog.agent_name == agent_name)
    if action_type is not None:
        stmt = stmt.where(AgentAuditLog.action_type == action_type)

    stmt = stmt.order_by(desc(AgentAuditLog.created_at)).offset(offset).limit(limit)
    result = await db.execute(stmt)
    entries = result.scalars().all()

    return [
        {
            "id": str(e.id),
            "agent_name": e.agent_name,
            "action_type": e.action_type,
            "tool_name": e.tool_name,
            "tool_params": e.tool_params,
            "tool_result_summary": e.tool_result_summary,
            "gemini_prompt_summary": e.gemini_prompt_summary,
            "gemini_response_summary": e.gemini_response_summary,
            "decision": e.decision,
            "confidence": e.confidence,
            "tokens_used": e.tokens_used,
            "latency_ms": e.latency_ms,
            "target_agent": e.target_agent,
            "channel": e.channel,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in entries
    ]


# ── 7. Agent-specific audit log ──────────────────────────────

@router.get("/{agent_name}/audit")
async def get_agent_audit_log(
    agent_name: str,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get audit log entries for a specific agent."""
    _agent_or_404(agent_name)

    stmt = (
        select(AgentAuditLog)
        .where(AgentAuditLog.agent_name == agent_name)
        .order_by(desc(AgentAuditLog.created_at))
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    entries = result.scalars().all()

    return [
        {
            "id": str(e.id),
            "agent_name": e.agent_name,
            "action_type": e.action_type,
            "tool_name": e.tool_name,
            "tool_params": e.tool_params,
            "tool_result_summary": e.tool_result_summary,
            "gemini_prompt_summary": e.gemini_prompt_summary,
            "gemini_response_summary": e.gemini_response_summary,
            "decision": e.decision,
            "confidence": e.confidence,
            "tokens_used": e.tokens_used,
            "latency_ms": e.latency_ms,
            "target_agent": e.target_agent,
            "channel": e.channel,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in entries
    ]


# ── 8. Agent long-term memory ────────────────────────────────

@router.get("/{agent_name}/memory")
async def get_agent_memory(
    agent_name: str,
    category: Optional[str] = Query(None, description="Filter by memory category"),
    limit: int = Query(20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Get an agent's long-term memory entries. Requires ANALYST role."""
    _agent_or_404(agent_name)

    stmt = select(AgentMemory).where(AgentMemory.agent_name == agent_name)

    if category is not None:
        stmt = stmt.where(AgentMemory.category == category)

    stmt = stmt.order_by(desc(AgentMemory.created_at)).limit(limit)
    result = await db.execute(stmt)
    memories = result.scalars().all()

    return [
        {
            "id": str(m.id),
            "agent_name": m.agent_name,
            "category": m.category,
            "content": m.content,
            "camera_id": str(m.camera_id) if m.camera_id else None,
            "zone_id": str(m.zone_id) if m.zone_id else None,
            "confidence": m.confidence,
            "access_count": m.access_count,
            "last_accessed_at": m.last_accessed_at.isoformat() if m.last_accessed_at else None,
            "created_at": m.created_at.isoformat() if m.created_at else None,
            "expires_at": m.expires_at.isoformat() if m.expires_at else None,
        }
        for m in memories
    ]


# ── 9. Operator chat with cortex ─────────────────────────────

@router.post("/chat")
async def operator_chat(
    body: OperatorChatRequest,
    _user=Depends(get_current_user),
):
    """Send an operator query to the Sentinel Cortex agent and get a response."""
    cortex = agent_registry.get("sentinel_cortex")
    if cortex is None:
        raise HTTPException(
            status_code=503,
            detail="Sentinel Cortex agent is not registered",
        )

    if not cortex._running:
        raise HTTPException(
            status_code=503,
            detail="Sentinel Cortex agent is not currently running",
        )

    if not hasattr(cortex, "handle_operator_chat"):
        raise HTTPException(
            status_code=503,
            detail="Sentinel Cortex agent does not support operator chat",
        )

    try:
        result = await cortex.handle_operator_chat(body.query)
        return result
    except Exception as e:
        logger.exception("Operator chat error")
        raise HTTPException(
            status_code=500,
            detail=f"Chat processing error: {str(e)}",
        )


# ── 10. Fleet summary ────────────────────────────────────────

@router.get("/fleet")
async def get_fleet_summary(
    _user=Depends(get_current_user),
):
    """Get a summary of the agent fleet."""
    return agent_registry.get_fleet_summary()


# ── 11. WebSocket — real-time agent activity stream ───────────

@router.websocket("/activity")
async def agent_activity_stream(
    ws: WebSocket,
    channel: Optional[str] = Query(None),
):
    """Stream agent activity in real-time via WebSocket.

    Query params:
        channel: optional channel name to filter messages.
                 If omitted, all agent channels are forwarded.
    """
    await ws.accept()

    # Queue to bridge Redis pub/sub callbacks into the WebSocket send loop
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=500)

    async def _forward_message(message: dict):
        """Handler called by agent_comms for each pub/sub message."""
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            # Drop oldest to avoid backpressure stalling Redis listener
            try:
                queue.get_nowait()
                queue.put_nowait(message)
            except asyncio.QueueEmpty:
                pass

    # Determine which channels to subscribe to
    if channel and channel in ALL_CHANNELS:
        channels_to_subscribe = [channel]
    else:
        channels_to_subscribe = list(ALL_CHANNELS)

    # Ensure comms are connected before subscribing
    await agent_comms.connect()

    # Subscribe
    for ch in channels_to_subscribe:
        await agent_comms.subscribe(ch, _forward_message)

    try:
        while True:
            try:
                # Wait for a message from the queue with a timeout so we can
                # also detect client disconnects periodically
                msg = await asyncio.wait_for(queue.get(), timeout=30.0)
                await ws.send_text(json.dumps(msg, default=str))
            except asyncio.TimeoutError:
                # Send a keep-alive ping to detect stale connections
                try:
                    await ws.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break

    except WebSocketDisconnect:
        logger.debug("Agent activity WebSocket client disconnected")
    except Exception as e:
        logger.error("Agent activity WebSocket error: %s", e)
    finally:
        # Clean up subscriptions
        for ch in channels_to_subscribe:
            await agent_comms.unsubscribe(ch, _forward_message)
