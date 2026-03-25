"""Natural Language SOC Copilot API — full conversational security assistant.

Beyond the agent chat interface, this provides a persistent conversational
copilot that operators interact with throughout their shift. Has full access
to all agent tools and Qdrant search.  Sessions are persisted in the database.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, update, func as sa_func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user
from backend.database import get_db
from backend.models.advanced_models import CopilotConversation
from backend.agents.agent_registry import agent_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/copilot", tags=["copilot"])


# ── Schemas ───────────────────────────────────────────────────

class CopilotContext(BaseModel):
    page: Optional[str] = None
    page_label: Optional[str] = None
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    filters: Optional[Dict[str, Any]] = None


class CopilotMessage(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    session_id: Optional[str] = None
    context: Optional[CopilotContext] = None

class CopilotQuickAction(BaseModel):
    action: str
    params: Optional[Dict[str, Any]] = None


QUICK_ACTIONS = [
    {
        "id": "shift_summary",
        "label": "Shift Summary",
        "description": "Summarize everything that happened in the last 8 hours",
        "prompt": "Give me a comprehensive shift summary for the last 8 hours. Include all alerts, notable events, agent activities, and any anomalies detected. Highlight anything that needs attention.",
        "icon": "clock",
    },
    {
        "id": "threat_assessment",
        "label": "Current Threat Level",
        "description": "Assess the current security threat level across all zones",
        "prompt": "Perform a current threat assessment across all zones and cameras. What is the current threat level? Are there any active threats or suspicious activities? What zones need attention?",
        "icon": "shield_alert",
    },
    {
        "id": "unusual_activity",
        "label": "Unusual Activity",
        "description": "Find anything unusual in the last hour",
        "prompt": "Analyze the last hour of activity across all cameras and sensors. Identify anything unusual, out of pattern, or potentially concerning. Compare against learned baselines.",
        "icon": "activity",
    },
    {
        "id": "camera_health",
        "label": "Camera Health",
        "description": "Check the status of all cameras and sensors",
        "prompt": "Give me a health check on all cameras and sensors. Which cameras are online/offline? Any degraded feeds? Are there any blind spots in our coverage?",
        "icon": "camera",
    },
    {
        "id": "foot_traffic",
        "label": "Foot Traffic Analysis",
        "description": "Analyze current foot traffic patterns",
        "prompt": "Analyze current foot traffic patterns across all monitored areas. Which zones have the highest traffic? Are patterns normal for this time of day? Any unusual gathering points?",
        "icon": "footprints",
    },
    {
        "id": "incident_report",
        "label": "Draft Incident Report",
        "description": "Draft a report for the most recent incident",
        "prompt": "Draft a professional incident report for the most recent security event. Include timeline, involved parties (described by appearance only), response actions taken, and recommendations.",
        "icon": "file_text",
    },
    {
        "id": "compliance_check",
        "label": "Compliance Status",
        "description": "Check compliance with security protocols",
        "prompt": "Run a compliance check against active security protocols. Are all required patrols being performed? Any access control violations? Are all monitoring zones adequately covered?",
        "icon": "shield_check",
    },
    {
        "id": "agent_briefing",
        "label": "Agent Briefing",
        "description": "Get a briefing from all AI agents",
        "prompt": "Collect a briefing from all active AI agents. What has each agent been working on? Any insights from the threat analyst, anomaly detector, or correlator? What predictions are active?",
        "icon": "users",
    },
]


# ── DB helpers ───────────────────────────────────────────────

async def _get_or_create_session(
    db: AsyncSession, session_id: str, operator_id: uuid.UUID
) -> CopilotConversation:
    """Load an existing conversation or create a new one."""
    result = await db.execute(
        select(CopilotConversation).where(
            CopilotConversation.session_id == session_id,
            CopilotConversation.status == "active",
        )
    )
    conv = result.scalar_one_or_none()
    if conv is not None:
        return conv

    conv = CopilotConversation(
        operator_id=operator_id,
        session_id=session_id,
        messages=[],
        message_count=0,
        status="active",
    )
    db.add(conv)
    await db.flush()
    return conv


async def _append_message(
    db: AsyncSession,
    conv: CopilotConversation,
    role: str,
    content: str,
    extra: Dict[str, Any] | None = None,
):
    """Append a message to a conversation and update metadata."""
    msg: Dict[str, Any] = {
        "role": role,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if extra:
        msg.update(extra)

    messages = list(conv.messages or [])
    messages.append(msg)
    conv.messages = messages
    conv.message_count = len(messages)
    conv.last_message_at = datetime.now(timezone.utc)
    await db.flush()


# ── 1. Send message to copilot ──────────────────────────────

@router.post("/chat")
async def copilot_chat(
    body: CopilotMessage,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Send a message to the SOC Copilot and get a response."""
    session_id = body.session_id or str(uuid.uuid4())
    operator_id = uuid.UUID(_user.id) if isinstance(_user.id, str) else _user.id

    conv = await _get_or_create_session(db, session_id, operator_id)

    # Add user message
    await _append_message(db, conv, "user", body.message)

    # Route to Sentinel Cortex for processing
    cortex = agent_registry.get("sentinel_cortex")
    if cortex is None or not cortex._running:
        response_text = (
            "Sentinel Cortex is currently unavailable. "
            "The SOC Copilot requires the Sentinel Cortex agent to be running. "
            "Please check the Agent Operations page to start it."
        )
        tool_calls: list = []
    else:
        # Build context from conversation history (last 10 messages)
        recent = (conv.messages or [])[-10:]
        history_context = "\n".join(
            f"{'Operator' if m['role'] == 'user' else 'Copilot'}: {m['content']}"
            for m in recent
        )

        # Build page context section
        context_section = ""
        if body.context:
            ctx = body.context
            context_section = (
                f"\nOPERATOR CONTEXT:\n"
                f"- Current page: {ctx.page_label or ctx.page or 'Unknown'} ({ctx.page or '/'})\n"
                f"- Entity type in focus: {ctx.entity_type or 'general'}\n"
            )
            if ctx.entity_id:
                context_section += f"- Focused entity ID: {ctx.entity_id}\n"
            if ctx.filters:
                context_section += f"- Active filters: {ctx.filters}\n"
            context_section += (
                "\nUse this context to tailor your response. "
                "If the operator asks about 'this' or 'these', they likely mean "
                f"items on the {ctx.page_label or 'current'} page.\n"
            )

        enhanced_prompt = (
            f"SOC COPILOT SESSION — You are the operator's AI security partner.\n\n"
            f"CONVERSATION HISTORY:\n{history_context}\n\n"
            f"{context_section}\n"
            f"LATEST OPERATOR MESSAGE: {body.message}\n\n"
            f"INSTRUCTIONS: Respond as a knowledgeable SOC analyst partner. "
            f"Use your tools to gather real-time data when needed. "
            f"Be concise but thorough. Provide actionable insights. "
            f"If the operator asks about specific events, search for them. "
            f"If they ask for reports, generate them. "
            f"Always back up assessments with data from the system. "
            f"When the operator asks you to take action (acknowledge alerts, "
            f"create cases, lock doors, etc.), use the appropriate tools to "
            f"execute the action and confirm the result."
        )

        try:
            result = await cortex.handle_operator_chat(enhanced_prompt)
            response_text = result.get("response", "I processed your request but have no specific findings to report.")
            tool_calls = result.get("tool_calls", [])
        except Exception as e:
            logger.exception("Copilot chat error")
            response_text = f"I encountered an error processing your request: {str(e)}"
            tool_calls = []

    # Add assistant response
    tc_count = len(tool_calls) if isinstance(tool_calls, list) else 0
    await _append_message(db, conv, "assistant", response_text, {"tool_calls": tc_count})

    return {
        "session_id": session_id,
        "response": response_text,
        "tool_calls_made": tc_count,
        "tools_used": [
            tc.get("name", "unknown") if isinstance(tc, dict) else str(tc)
            for tc in (tool_calls if isinstance(tool_calls, list) else [])
        ],
    }


# ── 2. Quick actions ────────────────────────────────────────

@router.get("/quick-actions")
async def get_quick_actions(_user=Depends(get_current_user)):
    """Get available quick actions for the copilot."""
    return {"actions": QUICK_ACTIONS}


@router.post("/quick-action")
async def execute_quick_action(
    body: CopilotQuickAction,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Execute a predefined quick action."""
    action = next((a for a in QUICK_ACTIONS if a["id"] == body.action), None)
    if not action:
        raise HTTPException(status_code=404, detail=f"Quick action '{body.action}' not found")

    msg = CopilotMessage(message=action["prompt"])
    return await copilot_chat(msg, _user, db)


# ── 3. Session management ───────────────────────────────────

@router.get("/sessions")
async def list_sessions(
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List active copilot sessions."""
    result = await db.execute(
        select(CopilotConversation)
        .where(CopilotConversation.status == "active")
        .order_by(desc(CopilotConversation.last_message_at))
        .limit(50)
    )
    convs = result.scalars().all()

    sessions = []
    for c in convs:
        msgs = c.messages or []
        sessions.append({
            "id": c.session_id,
            "message_count": c.message_count,
            "last_message": msgs[-1]["timestamp"] if msgs else (
                c.last_message_at.isoformat() if c.last_message_at else None
            ),
            "preview": msgs[-1]["content"][:100] if msgs else None,
        })

    return {"sessions": sessions, "total": len(sessions)}


@router.get("/sessions/{session_id}")
async def get_session(
    session_id: str,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get a specific copilot session with full history."""
    result = await db.execute(
        select(CopilotConversation).where(
            CopilotConversation.session_id == session_id,
        )
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Session not found")

    return {
        "session_id": conv.session_id,
        "messages": conv.messages or [],
        "total_messages": conv.message_count,
    }


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Archive a copilot session (soft delete)."""
    result = await db.execute(
        select(CopilotConversation).where(
            CopilotConversation.session_id == session_id,
        )
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Session not found")

    conv.status = "archived"
    await db.flush()
    return {"status": "archived"}
