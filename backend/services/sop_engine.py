"""SOP Engine — manage Standard Operating Procedure templates, instances, and AI generation."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

logger = logging.getLogger(__name__)


class SOPEngine:
    """Manage SOP (Standard Operating Procedure) lifecycle.

    Supports template matching, instance creation, stage advancement,
    abort, and Gemini-powered SOP generation for novel threats.
    """

    # ── Template matching ────────────────────────────────────────

    async def get_matching_template(
        self,
        threat_type: str,
        severity: str,
    ) -> Optional[Dict[str, Any]]:
        """Find the best-matching active SOPTemplate for a given threat type and severity.

        Matching logic:
        1. Exact match on both ``threat_type`` and ``severity``.
        2. If no exact match, match on ``threat_type`` only (any severity).
        3. Returns ``None`` if nothing matches.

        Args:
            threat_type: The threat category string (e.g. ``"intrusion"``).
            severity: The severity level (e.g. ``"critical"``).

        Returns:
            Template dict or ``None``.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import SOPTemplate

            async with async_session() as session:
                # Try exact match first
                stmt = (
                    select(SOPTemplate)
                    .where(SOPTemplate.is_active.is_(True))
                    .where(SOPTemplate.threat_type == threat_type)
                    .where(SOPTemplate.severity == severity)
                    .order_by(SOPTemplate.created_at.desc())
                    .limit(1)
                )
                result = await session.execute(stmt)
                template = result.scalar_one_or_none()

                # Fall back to threat_type-only match
                if not template:
                    stmt = (
                        select(SOPTemplate)
                        .where(SOPTemplate.is_active.is_(True))
                        .where(SOPTemplate.threat_type == threat_type)
                        .order_by(SOPTemplate.created_at.desc())
                        .limit(1)
                    )
                    result = await session.execute(stmt)
                    template = result.scalar_one_or_none()

                if not template:
                    logger.info("No SOP template found for threat_type=%s severity=%s", threat_type, severity)
                    return None

                logger.info("SOP template matched: id=%s name=%s", template.id, template.name)
                return {
                    "id": str(template.id),
                    "name": template.name,
                    "threat_type": template.threat_type,
                    "severity": template.severity,
                    "workflow_stages": template.workflow_stages,
                    "auto_trigger": template.auto_trigger,
                    "is_active": template.is_active,
                    "created_at": template.created_at.isoformat() if template.created_at else None,
                }
        except Exception as exc:
            logger.error("Failed to match SOP template: %s", exc, exc_info=True)
            return None

    # ── Start SOP instance ───────────────────────────────────────

    async def start_sop(
        self,
        template_id: uuid.UUID,
        alert_id: Optional[uuid.UUID] = None,
    ) -> Dict[str, Any]:
        """Create a new SOPInstance from a template.

        The instance starts at ``current_stage=0`` with an empty
        ``stage_history`` and status ``"active"``.

        Args:
            template_id: UUID of the SOPTemplate to instantiate.
            alert_id: Optional UUID of the triggering alert.

        Returns:
            Dict representation of the created instance.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import SOPInstance, SOPTemplate

            async with async_session() as session:
                # Verify template exists
                tmpl_stmt = select(SOPTemplate).where(SOPTemplate.id == template_id)
                tmpl_result = await session.execute(tmpl_stmt)
                template = tmpl_result.scalar_one_or_none()

                if not template:
                    logger.warning("SOP template not found: %s", template_id)
                    return {"error": "template_not_found"}

                instance = SOPInstance(
                    template_id=template_id,
                    alert_id=alert_id,
                    current_stage=0,
                    stage_history=[],
                    status="active",
                )
                session.add(instance)
                await session.commit()
                await session.refresh(instance)

                logger.info(
                    "SOP started: instance=%s template=%s (%s) alert=%s",
                    instance.id, template.name, template_id, alert_id,
                )
                return {
                    "id": str(instance.id),
                    "template_id": str(instance.template_id),
                    "template_name": template.name,
                    "alert_id": str(instance.alert_id) if instance.alert_id else None,
                    "current_stage": instance.current_stage,
                    "total_stages": len(template.workflow_stages or []),
                    "workflow_stages": template.workflow_stages,
                    "stage_history": instance.stage_history,
                    "status": instance.status,
                    "created_at": instance.created_at.isoformat() if instance.created_at else None,
                }
        except Exception as exc:
            logger.error("Failed to start SOP: %s", exc, exc_info=True)
            raise

    # ── Advance stage ────────────────────────────────────────────

    async def advance_stage(
        self,
        instance_id: uuid.UUID,
        stage_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Increment the current stage and append stage_data to the history.

        If the new stage exceeds the total number of workflow stages, the
        instance is automatically marked ``"completed"``.

        Args:
            instance_id: UUID of the SOPInstance.
            stage_data: Freeform dict with stage completion details (notes,
                operator, timestamp, etc.).

        Returns:
            Updated instance dict.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import SOPInstance, SOPTemplate

            async with async_session() as session:
                stmt = select(SOPInstance).where(SOPInstance.id == instance_id)
                result = await session.execute(stmt)
                instance = result.scalar_one_or_none()

                if not instance:
                    logger.warning("SOP instance not found: %s", instance_id)
                    return {"error": "instance_not_found"}

                if instance.status != "active":
                    logger.warning("Cannot advance non-active SOP: %s (status=%s)", instance_id, instance.status)
                    return {"error": "instance_not_active", "status": instance.status}

                # Append to stage history
                stage_data["stage_number"] = instance.current_stage
                stage_data["completed_at"] = datetime.now(timezone.utc).isoformat()
                history = list(instance.stage_history or [])
                history.append(stage_data)
                instance.stage_history = history

                # Increment stage
                instance.current_stage = (instance.current_stage or 0) + 1
                instance.updated_at = datetime.now(timezone.utc)

                # Check if all stages complete
                tmpl_stmt = select(SOPTemplate).where(SOPTemplate.id == instance.template_id)
                tmpl_result = await session.execute(tmpl_stmt)
                template = tmpl_result.scalar_one_or_none()

                total_stages = len(template.workflow_stages or []) if template else 0
                if total_stages > 0 and instance.current_stage >= total_stages:
                    instance.status = "completed"
                    logger.info("SOP instance completed: %s", instance_id)

                await session.commit()
                await session.refresh(instance)

                return {
                    "id": str(instance.id),
                    "current_stage": instance.current_stage,
                    "total_stages": total_stages,
                    "stage_history": instance.stage_history,
                    "status": instance.status,
                    "updated_at": instance.updated_at.isoformat() if instance.updated_at else None,
                }
        except Exception as exc:
            logger.error("Failed to advance SOP stage for %s: %s", instance_id, exc, exc_info=True)
            raise

    # ── Abort SOP ────────────────────────────────────────────────

    async def abort_sop(
        self,
        instance_id: uuid.UUID,
        reason: str,
    ) -> Dict[str, Any]:
        """Abort an active SOP instance.

        Sets ``status="aborted"`` and records the reason in the stage history.

        Args:
            instance_id: UUID of the SOPInstance.
            reason: Human-readable reason for aborting.

        Returns:
            Updated instance dict.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import SOPInstance

            async with async_session() as session:
                stmt = select(SOPInstance).where(SOPInstance.id == instance_id)
                result = await session.execute(stmt)
                instance = result.scalar_one_or_none()

                if not instance:
                    logger.warning("SOP instance not found for abort: %s", instance_id)
                    return {"error": "instance_not_found"}

                history = list(instance.stage_history or [])
                history.append({
                    "action": "aborted",
                    "reason": reason,
                    "aborted_at": datetime.now(timezone.utc).isoformat(),
                    "stage_at_abort": instance.current_stage,
                })
                instance.stage_history = history
                instance.status = "aborted"
                instance.updated_at = datetime.now(timezone.utc)

                await session.commit()
                await session.refresh(instance)

                logger.info("SOP aborted: instance=%s reason=%s", instance_id, reason)
                return {
                    "id": str(instance.id),
                    "status": instance.status,
                    "stage_history": instance.stage_history,
                    "updated_at": instance.updated_at.isoformat() if instance.updated_at else None,
                }
        except Exception as exc:
            logger.error("Failed to abort SOP %s: %s", instance_id, exc, exc_info=True)
            raise

    # ── AI-generated SOP ─────────────────────────────────────────

    async def generate_sop_from_threat(
        self,
        threat_type: str,
        severity: str,
        context: str,
    ) -> Dict[str, Any]:
        """Use Gemini to generate a structured SOP workflow for a novel threat.

        The generated SOP includes numbered workflow stages with instructions,
        responsible parties, and escalation criteria.

        Args:
            threat_type: The threat category (e.g. ``"active_shooter"``).
            severity: Severity level.
            context: Free-text context about the specific scenario.

        Returns:
            Dict with ``workflow_stages`` list and ``metadata``.
        """
        prompt = (
            f"Generate a detailed Standard Operating Procedure (SOP) for the "
            f"following security threat scenario.\n\n"
            f"Threat type: {threat_type}\n"
            f"Severity: {severity}\n"
            f"Context: {context}\n\n"
            f"Produce a JSON array of workflow stages. Each stage should have:\n"
            f"- \"stage_number\": sequential integer starting from 0\n"
            f"- \"title\": short stage title\n"
            f"- \"instructions\": detailed step-by-step instructions\n"
            f"- \"responsible_party\": who should execute this stage\n"
            f"- \"estimated_duration_minutes\": time estimate\n"
            f"- \"escalation_criteria\": when to escalate to next stage or external help\n\n"
            f"Return ONLY a valid JSON array (no markdown, no wrapping)."
        )
        system_prompt = (
            "You are a security operations expert specialising in Standard "
            "Operating Procedures. Generate precise, actionable SOP workflows "
            "that comply with industry best practices and ASIS/NFPA standards."
        )

        try:
            from backend.services.ai_text_service import ai_generate_text
            import json

            response = await ai_generate_text(
                prompt=prompt,
                system_prompt=system_prompt,
                temperature=0.3,
                max_tokens=2000,
            )

            if not response:
                logger.warning("AI returned empty response for SOP generation")
                return {"workflow_stages": [], "error": "empty_response"}

            # Parse JSON from response (handle markdown code blocks)
            cleaned = response.strip()
            if cleaned.startswith("```"):
                lines = cleaned.split("\n")
                lines = [ln for ln in lines if not ln.strip().startswith("```")]
                cleaned = "\n".join(lines)

            stages = json.loads(cleaned)
            if not isinstance(stages, list):
                stages = stages.get("stages", stages.get("workflow_stages", []))

            logger.info(
                "SOP generated via AI: %d stages for %s/%s",
                len(stages), threat_type, severity,
            )
            return {
                "threat_type": threat_type,
                "severity": severity,
                "workflow_stages": stages,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "source": "ai_generated",
            }

        except ImportError:
            logger.warning("ai_text_service not available for SOP generation")
            return self._fallback_sop(threat_type, severity, context)
        except Exception as exc:
            logger.error("AI SOP generation failed: %s", exc, exc_info=True)
            return self._fallback_sop(threat_type, severity, context)

    # ── Fallback SOP ─────────────────────────────────────────────

    @staticmethod
    def _fallback_sop(threat_type: str, severity: str, context: str) -> Dict[str, Any]:
        """Return a generic SOP template when Gemini is unavailable."""
        stages = [
            {
                "stage_number": 0,
                "title": "Initial Assessment",
                "instructions": (
                    "Verify the threat report. Confirm threat type, location, "
                    "and number of people affected. Review camera feeds."
                ),
                "responsible_party": "Security Operator",
                "estimated_duration_minutes": 2,
                "escalation_criteria": "Threat confirmed or casualties reported",
            },
            {
                "stage_number": 1,
                "title": "Notification & Escalation",
                "instructions": (
                    "Notify on-site security team, facility manager, and "
                    "emergency services if severity is high or critical."
                ),
                "responsible_party": "Shift Supervisor",
                "estimated_duration_minutes": 3,
                "escalation_criteria": "Emergency services required or threat escalates",
            },
            {
                "stage_number": 2,
                "title": "Containment & Response",
                "instructions": (
                    "Initiate appropriate containment measures. Secure affected "
                    "area, redirect foot traffic, and deploy response team."
                ),
                "responsible_party": "Response Team Lead",
                "estimated_duration_minutes": 10,
                "escalation_criteria": "Containment fails or additional threats detected",
            },
            {
                "stage_number": 3,
                "title": "Resolution & Recovery",
                "instructions": (
                    "Confirm threat neutralised or resolved. Begin recovery "
                    "procedures, document evidence, and file incident report."
                ),
                "responsible_party": "Security Manager",
                "estimated_duration_minutes": 15,
                "escalation_criteria": "Unresolved issues or post-incident threats",
            },
        ]
        return {
            "threat_type": threat_type,
            "severity": severity,
            "workflow_stages": stages,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "fallback_template",
        }


# ── Singleton ────────────────────────────────────────────────────
sop_engine = SOPEngine()
