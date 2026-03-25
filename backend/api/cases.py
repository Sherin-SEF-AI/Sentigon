"""Case management API."""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from backend.database import get_db
from backend.models import Case, CaseEvidence, InvestigationRun
from backend.models.models import CaseStatus, UserRole
from backend.schemas import (
    CaseCreate,
    CaseUpdate,
    CaseResponse,
    CaseEvidenceCreate,
    CaseEvidenceResponse,
    InvestigationRunCreate,
    InvestigationRunResponse,
)
from backend.api.auth import get_current_user, require_role

router = APIRouter(prefix="/api/cases", tags=["cases"])


# ── Helpers ────────────────────────────────────────────────────

async def _get_case_or_404(case_id: uuid.UUID, db: AsyncSession) -> Case:
    result = await db.execute(select(Case).where(Case.id == case_id))
    case = result.scalar_one_or_none()
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


# ── Case CRUD ──────────────────────────────────────────────────

@router.get("", response_model=List[CaseResponse])
async def list_cases(
    status: Optional[str] = Query(None, description="Filter by case status"),
    priority: Optional[str] = Query(None, description="Filter by priority"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List cases with optional filters."""
    stmt = select(Case)

    if status is not None:
        try:
            status_enum = CaseStatus(status)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid status: {status}")
        stmt = stmt.where(Case.status == status_enum)

    if priority is not None:
        from backend.models.models import AlertSeverity
        try:
            priority_enum = AlertSeverity(priority)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid priority: {priority}")
        stmt = stmt.where(Case.priority == priority_enum)

    stmt = stmt.order_by(Case.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)
    cases = result.scalars().all()
    return [CaseResponse.model_validate(c) for c in cases]


@router.post("", response_model=CaseResponse, status_code=201)
async def create_case(
    body: CaseCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Create a new investigation case."""
    from backend.models.models import AlertSeverity

    try:
        priority_enum = AlertSeverity(body.priority)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid priority: {body.priority}")

    case = Case(
        title=body.title,
        description=body.description,
        priority=priority_enum,
        status=CaseStatus.OPEN,
        assigned_to=body.assigned_to,
        tags=body.tags,
    )
    db.add(case)
    await db.flush()
    await db.refresh(case)
    return CaseResponse.model_validate(case)


@router.get("/{case_id}", response_model=CaseResponse)
async def get_case(
    case_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get a single case by ID (includes evidence count in ai_insights)."""
    case = await _get_case_or_404(case_id, db)

    # Attach evidence count as supplementary info
    ev_count_result = await db.execute(
        select(func.count(CaseEvidence.id)).where(CaseEvidence.case_id == case_id)
    )
    evidence_count = ev_count_result.scalar() or 0

    resp = CaseResponse.model_validate(case)
    # Merge evidence count into ai_insights for convenience
    insights = resp.ai_insights or {}
    insights["evidence_count"] = evidence_count
    resp.ai_insights = insights
    return resp


@router.patch("/{case_id}", response_model=CaseResponse)
async def update_case(
    case_id: uuid.UUID,
    body: CaseUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Update a case. Handles status transitions and closed_at timestamp."""
    case = await _get_case_or_404(case_id, db)
    update_data = body.model_dump(exclude_unset=True)

    for field, value in update_data.items():
        if field == "status" and value is not None:
            try:
                new_status = CaseStatus(value)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid status: {value}")
            case.status = new_status
            if new_status == CaseStatus.CLOSED and case.closed_at is None:
                case.closed_at = datetime.now(timezone.utc)
        elif field == "priority" and value is not None:
            from backend.models.models import AlertSeverity
            try:
                case.priority = AlertSeverity(value)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid priority: {value}")
        elif field == "tags":
            case.tags = value
        elif field == "assigned_to":
            case.assigned_to = value
        elif field == "title" and value is not None:
            case.title = value
        elif field == "description":
            case.description = value
        elif field == "summary":
            case.summary = value

    await db.flush()
    await db.refresh(case)
    return CaseResponse.model_validate(case)


# ── Evidence ───────────────────────────────────────────────────

@router.post("/{case_id}/evidence", response_model=CaseEvidenceResponse, status_code=201)
async def add_evidence(
    case_id: uuid.UUID,
    body: CaseEvidenceCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Attach evidence to a case."""
    # Ensure the case exists
    await _get_case_or_404(case_id, db)

    valid_types = {"event", "alert", "recording", "note", "file"}
    if body.evidence_type not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid evidence_type. Must be one of: {', '.join(sorted(valid_types))}",
        )

    evidence = CaseEvidence(
        case_id=case_id,
        evidence_type=body.evidence_type,
        reference_id=body.reference_id,
        title=body.title,
        content=body.content,
        file_url=body.file_url,
        metadata_=body.metadata,
    )
    db.add(evidence)
    await db.flush()
    await db.refresh(evidence)
    return CaseEvidenceResponse.model_validate(evidence)


@router.get("/{case_id}/evidence", response_model=List[CaseEvidenceResponse])
async def list_evidence(
    case_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all evidence for a case."""
    await _get_case_or_404(case_id, db)

    result = await db.execute(
        select(CaseEvidence)
        .where(CaseEvidence.case_id == case_id)
        .order_by(CaseEvidence.added_at.desc())
    )
    items = result.scalars().all()
    return [CaseEvidenceResponse.model_validate(e) for e in items]


# ── Investigation Runs ─────────────────────────────────────────

@router.post("/{case_id}/investigate", response_model=InvestigationRunResponse, status_code=201)
async def start_investigation(
    case_id: uuid.UUID,
    body: InvestigationRunCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Start an AI investigation run for a case."""
    case = await _get_case_or_404(case_id, db)

    if body.case_id != case_id:
        raise HTTPException(status_code=400, detail="case_id in body must match URL")

    valid_agents = {"threat_analyzer", "timeline_builder", "correlation_engine", "forensic_agent", "general"}
    if body.agent_type not in valid_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid agent_type. Must be one of: {', '.join(sorted(valid_agents))}",
        )

    # Build the investigation query
    query = body.query or (body.input_params or {}).get("query", "")
    if not query:
        # Default to case title + description
        query = case.title
        if case.description:
            query = f"{case.title}. {case.description}"

    # Transition case to investigating if still open
    if case.status == CaseStatus.OPEN:
        case.status = CaseStatus.INVESTIGATING

    input_params = body.input_params or {}
    input_params["query"] = query

    run = InvestigationRun(
        case_id=case_id,
        agent_type=body.agent_type,
        status="running",
        input_params=input_params,
        steps=[],
        findings=None,
        summary=None,
    )
    db.add(run)
    await db.flush()
    await db.refresh(run)

    # Spawn background task to actually run the investigation
    asyncio.create_task(
        _run_investigation_background(str(case_id), query, body.agent_type)
    )

    return InvestigationRunResponse.model_validate(run)


async def _run_investigation_background(
    case_id: str, query: str, agent_type: str,
) -> None:
    """Background task that runs the investigation agent and updates case summary."""
    try:
        from backend.agents.investigation_agent import investigation_agent
        result = await investigation_agent.run_investigation(
            case_id=case_id, query=query, agent_type=agent_type,
        )
        # Update case summary with investigation findings
        if result.get("status") == "completed":
            findings = result.get("findings", {})
            summary = findings.get("incident_summary", "")
            if summary:
                try:
                    from backend.database import async_session as _async_session
                    async with _async_session() as session:
                        db_case = (await session.execute(
                            select(Case).where(Case.id == uuid.UUID(case_id))
                        )).scalar_one_or_none()
                        if db_case:
                            db_case.summary = summary
                            db_case.ai_insights = {
                                "last_investigation": result.get("investigation_id"),
                                "key_findings": findings.get("key_findings", []),
                                "risk_assessment": findings.get("risk_assessment", ""),
                                "evidence_count": findings.get("evidence_count", 0),
                            }
                            await session.commit()
                except Exception as e:
                    logger.warning("Failed to update case summary: %s", e)
    except Exception as e:
        logger.error("Background investigation failed for case %s: %s", case_id, e)


@router.get("/{case_id}/investigations", response_model=List[InvestigationRunResponse])
async def list_investigations(
    case_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all investigation runs for a case."""
    await _get_case_or_404(case_id, db)

    result = await db.execute(
        select(InvestigationRun)
        .where(InvestigationRun.case_id == case_id)
        .order_by(InvestigationRun.started_at.desc())
    )
    runs = result.scalars().all()
    return [InvestigationRunResponse.model_validate(r) for r in runs]
