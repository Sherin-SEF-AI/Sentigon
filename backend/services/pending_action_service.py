"""Pending Action service — queue management for HITL mode."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select, func, update, desc

from backend.database import async_session
from backend.models.pending_action import PendingAction, PendingActionStatus

logger = logging.getLogger(__name__)


class PendingActionService:
    """Manages the pending action queue for HITL mode."""

    async def create_pending(
        self,
        agent_name: str,
        tool_name: str,
        tool_args: dict,
        context_summary: str,
        severity: str = "medium",
    ) -> PendingAction:
        """Create a new pending action and notify via WebSocket."""
        from backend.services.operation_mode import operation_mode_service

        timeout = await operation_mode_service.get_auto_approve_timeout()
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=timeout) if timeout > 0 else None

        async with async_session() as session:
            pending = PendingAction(
                agent_name=agent_name,
                tool_name=tool_name,
                tool_args=tool_args,
                context_summary=context_summary[:2000],
                severity=severity,
                status=PendingActionStatus.PENDING,
                expires_at=expires_at,
            )
            session.add(pending)
            await session.commit()
            await session.refresh(pending)

        # Push WebSocket notification
        try:
            from backend.services.notification_service import notification_service
            await notification_service.push_notification({
                "type": "pending_action",
                "action_id": str(pending.id),
                "agent_name": agent_name,
                "tool_name": tool_name,
                "severity": severity,
                "summary": context_summary[:200],
                "created_at": pending.created_at.isoformat() if pending.created_at else None,
                "expires_at": pending.expires_at.isoformat() if pending.expires_at else None,
            })
        except Exception as e:
            logger.warning("pending_action.notify_failed", error=str(e))

        logger.info(
            "pending_action.created",
            id=str(pending.id),
            agent=agent_name,
            tool=tool_name,
            severity=severity,
        )
        return pending

    async def approve(
        self,
        action_id: uuid.UUID,
        user_id: uuid.UUID,
        notes: Optional[str] = None,
        modified_args: Optional[dict] = None,
    ) -> dict:
        """Approve a pending action and execute the tool."""
        async with async_session() as session:
            result = await session.execute(
                select(PendingAction).where(
                    PendingAction.id == action_id,
                    PendingAction.status == PendingActionStatus.PENDING,
                )
            )
            action = result.scalar_one_or_none()
            if not action:
                return {"error": "Action not found or already resolved"}

            action.status = PendingActionStatus.APPROVED
            action.resolved_by = user_id
            action.resolved_at = datetime.now(timezone.utc)
            action.resolution_notes = notes
            if modified_args:
                action.modified_args = modified_args

            # Execute the tool
            args = modified_args or action.tool_args
            exec_result = await self._execute_tool(action.tool_name, args)
            action.execution_result = exec_result
            action.executed_at = datetime.now(timezone.utc)

            await session.commit()

        # Notify resolution
        await self._notify_resolution(action_id, "approved")

        logger.info("pending_action.approved", id=str(action_id), tool=action.tool_name)
        return exec_result

    async def reject(
        self,
        action_id: uuid.UUID,
        user_id: uuid.UUID,
        notes: Optional[str] = None,
    ) -> bool:
        """Reject a pending action (do not execute)."""
        async with async_session() as session:
            result = await session.execute(
                select(PendingAction).where(
                    PendingAction.id == action_id,
                    PendingAction.status == PendingActionStatus.PENDING,
                )
            )
            action = result.scalar_one_or_none()
            if not action:
                return False

            action.status = PendingActionStatus.REJECTED
            action.resolved_by = user_id
            action.resolved_at = datetime.now(timezone.utc)
            action.resolution_notes = notes
            await session.commit()

        await self._notify_resolution(action_id, "rejected")
        logger.info("pending_action.rejected", id=str(action_id))
        return True

    async def get_pending(
        self,
        limit: int = 50,
        severity: Optional[str] = None,
    ) -> list[dict]:
        """Get pending actions for review."""
        async with async_session() as session:
            query = select(PendingAction).where(
                PendingAction.status == PendingActionStatus.PENDING
            )
            if severity:
                query = query.where(PendingAction.severity == severity)
            query = query.order_by(desc(PendingAction.created_at)).limit(limit)
            result = await session.execute(query)
            return [self._fmt(a) for a in result.scalars().all()]

    async def get_all_actions(
        self,
        limit: int = 100,
        status: Optional[str] = None,
    ) -> list[dict]:
        """Get all actions (including resolved) for history view."""
        async with async_session() as session:
            query = select(PendingAction)
            if status:
                query = query.where(PendingAction.status == status)
            query = query.order_by(desc(PendingAction.created_at)).limit(limit)
            result = await session.execute(query)
            return [self._fmt(a) for a in result.scalars().all()]

    async def get_pending_count(self) -> int:
        """Count pending actions."""
        async with async_session() as session:
            result = await session.execute(
                select(func.count(PendingAction.id)).where(
                    PendingAction.status == PendingActionStatus.PENDING
                )
            )
            return result.scalar() or 0

    async def check_expirations(self) -> list[str]:
        """Auto-approve expired actions. Returns list of auto-approved IDs."""
        now = datetime.now(timezone.utc)
        auto_approved = []

        async with async_session() as session:
            result = await session.execute(
                select(PendingAction).where(
                    PendingAction.status == PendingActionStatus.PENDING,
                    PendingAction.expires_at != None,  # noqa: E711
                    PendingAction.expires_at <= now,
                )
            )
            expired = result.scalars().all()

            for action in expired:
                try:
                    exec_result = await self._execute_tool(action.tool_name, action.tool_args)
                    action.status = PendingActionStatus.EXPIRED
                    action.resolved_at = now
                    action.execution_result = exec_result
                    action.executed_at = now
                    action.resolution_notes = "Auto-approved: timeout expired"
                    auto_approved.append(str(action.id))
                except Exception as e:
                    logger.error("pending_action.auto_approve_failed", id=str(action.id), error=str(e))

            if expired:
                await session.commit()

        for aid in auto_approved:
            await self._notify_resolution(uuid.UUID(aid), "expired")

        if auto_approved:
            logger.info("pending_action.auto_approved", count=len(auto_approved))
        return auto_approved

    async def bulk_action(
        self,
        action_ids: list[uuid.UUID],
        action: str,  # "approve" | "reject"
        user_id: uuid.UUID,
        notes: Optional[str] = None,
    ) -> dict:
        """Approve or reject a list of pending actions by ID."""
        approved = []
        rejected = []
        failed = []

        for action_id in action_ids:
            try:
                if action == "approve":
                    result = await self.approve(action_id=action_id, user_id=user_id, notes=notes)
                    if "error" in result:
                        failed.append(str(action_id))
                    else:
                        approved.append(str(action_id))
                elif action == "reject":
                    ok = await self.reject(action_id=action_id, user_id=user_id, notes=notes)
                    if ok:
                        rejected.append(str(action_id))
                    else:
                        failed.append(str(action_id))
            except Exception as e:
                logger.error("pending_action.bulk_action_failed", id=str(action_id), action=action, error=str(e))
                failed.append(str(action_id))

        logger.info("pending_action.bulk_action_done", action=action, approved=len(approved), rejected=len(rejected), failed=len(failed))
        return {
            "action": action,
            "approved": approved,
            "rejected": rejected,
            "failed": failed,
        }

    async def approve_all(self, user_id: uuid.UUID) -> int:
        """Approve all pending actions (used when switching to autonomous mode)."""
        async with async_session() as session:
            result = await session.execute(
                select(PendingAction).where(
                    PendingAction.status == PendingActionStatus.PENDING
                )
            )
            pending = result.scalars().all()
            count = 0
            now = datetime.now(timezone.utc)

            for action in pending:
                try:
                    exec_result = await self._execute_tool(action.tool_name, action.tool_args)
                    action.status = PendingActionStatus.APPROVED
                    action.resolved_by = user_id
                    action.resolved_at = now
                    action.execution_result = exec_result
                    action.executed_at = now
                    action.resolution_notes = "Bulk approved (mode switch to autonomous)"
                    count += 1
                except Exception as e:
                    logger.error("pending_action.bulk_approve_failed", id=str(action.id), error=str(e))

            if pending:
                await session.commit()

        logger.info("pending_action.bulk_approved", count=count)
        return count

    async def _execute_tool(self, tool_name: str, tool_args: dict) -> dict:
        """Execute a tool from the TOOL_REGISTRY."""
        try:
            from backend.agents.agent_tools import TOOL_REGISTRY
            tool_def = TOOL_REGISTRY.get(tool_name)
            if not tool_def:
                return {"error": f"Unknown tool: {tool_name}"}
            result = await tool_def["fn"](**tool_args)
            return result if isinstance(result, dict) else {"result": str(result)}
        except Exception as e:
            logger.error("pending_action.execute_failed", tool=tool_name, error=str(e))
            return {"error": str(e)}

    async def _notify_resolution(self, action_id: uuid.UUID, resolution: str):
        """Push WebSocket notification about action resolution."""
        try:
            from backend.services.notification_service import notification_service
            await notification_service.push_notification({
                "type": "pending_action_resolved",
                "action_id": str(action_id),
                "resolution": resolution,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:
            pass

    @staticmethod
    def _fmt(a: PendingAction) -> dict:
        return {
            "id": str(a.id),
            "agent_name": a.agent_name,
            "tool_name": a.tool_name,
            "tool_args": a.tool_args,
            "context_summary": a.context_summary,
            "severity": a.severity,
            "status": a.status.value if a.status else "pending",
            "resolved_by": str(a.resolved_by) if a.resolved_by else None,
            "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
            "resolution_notes": a.resolution_notes,
            "modified_args": a.modified_args,
            "execution_result": a.execution_result,
            "executed_at": a.executed_at.isoformat() if a.executed_at else None,
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "expires_at": a.expires_at.isoformat() if a.expires_at else None,
        }


# Singleton
pending_action_service = PendingActionService()
