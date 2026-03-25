"""Agent audit log ORM model — append-only action tracking."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Float, Text, DateTime, Index, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.database import Base


class AgentAuditLog(Base):
    """Append-only audit log for every agent action."""

    __tablename__ = "agent_audit_log"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    agent_name: Mapped[str] = mapped_column(String(100), nullable=False)
    action_type: Mapped[str] = mapped_column(
        String(50), nullable=False
    )  # tool_call, decision, message_sent, message_received, error, escalation
    tool_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    tool_params: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    tool_result_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    gemini_prompt_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    gemini_response_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    decision: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    tokens_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_agent: Mapped[str | None] = mapped_column(String(100), nullable=True)
    channel: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )

    __table_args__ = (
        Index("idx_agent_audit_agent", "agent_name", "created_at"),
        Index("idx_agent_audit_action", "action_type", "created_at"),
        Index("idx_agent_audit_time", "created_at"),
    )
