"""Threat Signatures API — browse, search, create, and manage the signature library."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func, update, delete

from backend.api.auth import get_current_user, require_role
from backend.database import async_session
from backend.models.models import (
    AlertSeverity,
    ThreatSignature,
    UserRole,
)
from backend.services.threat_engine import ThreatEngine, THREAT_SIGNATURES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/threat-signatures", tags=["threat-signatures"])


# ── Schemas ───────────────────────────────────────────────────

class SignatureOut(BaseModel):
    id: Optional[str] = None
    name: str
    category: str
    severity: str
    detection_method: str
    description: str
    yolo_classes: List[str] = []
    gemini_keywords: List[str] = []
    conditions: Dict[str, Any] = {}
    is_active: bool = True
    source: str = "built_in"
    detection_count: int = 0
    last_detected_at: Optional[str] = None
    learned_from_event_id: Optional[str] = None
    created_at: Optional[str] = None

    class Config:
        from_attributes = True


class SignatureCreate(BaseModel):
    name: str = Field(..., min_length=3, max_length=255)
    category: str = Field(..., min_length=2, max_length=100)
    severity: str = Field(default="medium")
    detection_method: str = Field(default="gemini")
    description: str = Field(default="")
    yolo_classes: List[str] = []
    gemini_keywords: List[str] = []
    conditions: Dict[str, Any] = {}


class SignatureUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    severity: Optional[str] = None
    detection_method: Optional[str] = None
    description: Optional[str] = None
    yolo_classes: Optional[List[str]] = None
    gemini_keywords: Optional[List[str]] = None
    conditions: Optional[Dict[str, Any]] = None
    is_active: Optional[bool] = None


class CategoryInfo(BaseModel):
    category: str
    count: int
    severities: Dict[str, int]


class SignatureStats(BaseModel):
    total_signatures: int
    active_signatures: int
    built_in_count: int
    auto_learned_count: int
    custom_count: int
    categories: int
    top_triggered: List[Dict[str, Any]]
    recently_learned: List[Dict[str, Any]]


# ── Endpoints ─────────────────────────────────────────────────

@router.get("", response_model=List[SignatureOut])
async def list_signatures(
    category: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    detection_method: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    active_only: bool = Query(True),
    _user=Depends(get_current_user),
):
    """List all threat signatures with optional filters."""
    engine = ThreatEngine()
    results: list[SignatureOut] = []

    # Merge in-memory signatures with DB data
    # First get DB records for detection counts etc.
    db_map: dict[str, ThreatSignature] = {}
    try:
        async with async_session() as session:
            stmt = select(ThreatSignature)
            result = await session.execute(stmt)
            for row in result.scalars().all():
                db_map[row.name] = row
    except Exception:
        pass

    for sig_name, sig in engine.signatures.items():
        db_rec = db_map.get(sig_name)

        # Apply filters
        if category and sig.category != category:
            continue
        if severity and sig.severity != severity:
            continue
        if detection_method and sig.detection_method != detection_method:
            continue

        sig_source = db_rec.source if db_rec else "built_in"
        if source and sig_source != source:
            continue

        if search:
            search_lower = search.lower()
            match = (
                search_lower in sig.name.lower()
                or search_lower in sig.description.lower()
                or search_lower in sig.category.lower()
                or any(search_lower in kw.lower() for kw in (sig.gemini_keywords or []))
            )
            if not match:
                continue

        is_active = db_rec.is_active if db_rec else True
        if active_only and not is_active:
            continue

        results.append(SignatureOut(
            id=str(db_rec.id) if db_rec else None,
            name=sig.name,
            category=sig.category,
            severity=sig.severity,
            detection_method=sig.detection_method,
            description=sig.description,
            yolo_classes=sig.yolo_classes or [],
            gemini_keywords=sig.gemini_keywords or [],
            conditions=sig.conditions or {},
            is_active=is_active,
            source=sig_source,
            detection_count=db_rec.detection_count if db_rec else 0,
            last_detected_at=db_rec.last_detected_at.isoformat() if db_rec and db_rec.last_detected_at else None,
            learned_from_event_id=str(db_rec.learned_from_event_id) if db_rec and db_rec.learned_from_event_id else None,
            created_at=db_rec.created_at.isoformat() if db_rec and db_rec.created_at else None,
        ))

    # Sort: critical first, then by detection count
    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    results.sort(key=lambda s: (sev_order.get(s.severity, 5), -s.detection_count))
    return results


@router.get("/categories", response_model=List[CategoryInfo])
async def list_categories(_user=Depends(get_current_user)):
    """List all signature categories with counts."""
    engine = ThreatEngine()
    cat_map: dict[str, dict] = {}

    for sig in engine.signatures.values():
        if sig.category not in cat_map:
            cat_map[sig.category] = {"count": 0, "severities": {}}
        cat_map[sig.category]["count"] += 1
        sev = sig.severity
        cat_map[sig.category]["severities"][sev] = cat_map[sig.category]["severities"].get(sev, 0) + 1

    results = [
        CategoryInfo(category=cat, count=data["count"], severities=data["severities"])
        for cat, data in sorted(cat_map.items())
    ]
    return results


@router.get("/stats", response_model=SignatureStats)
async def get_stats(_user=Depends(get_current_user)):
    """Get signature library statistics."""
    engine = ThreatEngine()
    total = len(engine.signatures)
    built_in = len(engine._builtin_signatures)
    categories = len(engine.get_all_categories())

    # Get DB stats
    auto_learned = 0
    custom = 0
    active = total
    top_triggered: list[dict] = []
    recently_learned: list[dict] = []

    try:
        async with async_session() as session:
            # Count by source
            result = await session.execute(
                select(ThreatSignature.source, func.count(ThreatSignature.id))
                .group_by(ThreatSignature.source)
            )
            for src, cnt in result.all():
                if src == "auto_learned":
                    auto_learned = cnt
                elif src == "custom":
                    custom = cnt

            # Inactive count
            result = await session.execute(
                select(func.count(ThreatSignature.id))
                .where(ThreatSignature.is_active == False)
            )
            inactive = result.scalar() or 0
            active = total - inactive

            # Top triggered
            result = await session.execute(
                select(ThreatSignature)
                .where(ThreatSignature.detection_count > 0)
                .order_by(ThreatSignature.detection_count.desc())
                .limit(10)
            )
            for row in result.scalars().all():
                top_triggered.append({
                    "name": row.name,
                    "category": row.category,
                    "detection_count": row.detection_count,
                    "last_detected_at": row.last_detected_at.isoformat() if row.last_detected_at else None,
                })

            # Recently learned
            result = await session.execute(
                select(ThreatSignature)
                .where(ThreatSignature.source == "auto_learned")
                .order_by(ThreatSignature.created_at.desc())
                .limit(10)
            )
            for row in result.scalars().all():
                recently_learned.append({
                    "name": row.name,
                    "category": row.category,
                    "severity": row.severity.value if hasattr(row.severity, "value") else str(row.severity),
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                })
    except Exception as e:
        logger.debug("Stats DB query failed: %s", e)

    return SignatureStats(
        total_signatures=total,
        active_signatures=active,
        built_in_count=built_in,
        auto_learned_count=auto_learned,
        custom_count=custom,
        categories=categories,
        top_triggered=top_triggered,
        recently_learned=recently_learned,
    )


@router.get("/recent-learned")
async def get_recent_learned(
    limit: int = Query(20, ge=1, le=100),
    _user=Depends(get_current_user),
):
    """Get recently auto-learned signatures."""
    results = []
    try:
        async with async_session() as session:
            result = await session.execute(
                select(ThreatSignature)
                .where(ThreatSignature.source == "auto_learned")
                .order_by(ThreatSignature.created_at.desc())
                .limit(limit)
            )
            for row in result.scalars().all():
                sev = row.severity.value if hasattr(row.severity, "value") else str(row.severity)
                results.append({
                    "id": str(row.id),
                    "name": row.name,
                    "category": row.category,
                    "severity": sev,
                    "description": row.description,
                    "gemini_keywords": row.gemini_keywords or [],
                    "detection_count": row.detection_count,
                    "learned_from_event_id": str(row.learned_from_event_id) if row.learned_from_event_id else None,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                })
    except Exception as e:
        logger.debug("Recent learned query failed: %s", e)

    return results


@router.get("/{sig_id}")
async def get_signature(sig_id: str, _user=Depends(get_current_user)):
    """Get a single signature by ID or name."""
    engine = ThreatEngine()

    # Try by name first (most common for in-memory)
    if sig_id in engine.signatures:
        sig = engine.signatures[sig_id]
        # Get DB record if available
        db_rec = None
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.name == sig_id)
                )
                db_rec = result.scalar_one_or_none()
        except Exception:
            pass

        return SignatureOut(
            id=str(db_rec.id) if db_rec else None,
            name=sig.name,
            category=sig.category,
            severity=sig.severity,
            detection_method=sig.detection_method,
            description=sig.description,
            yolo_classes=sig.yolo_classes or [],
            gemini_keywords=sig.gemini_keywords or [],
            conditions=sig.conditions or {},
            is_active=db_rec.is_active if db_rec else True,
            source=db_rec.source if db_rec else "built_in",
            detection_count=db_rec.detection_count if db_rec else 0,
            last_detected_at=db_rec.last_detected_at.isoformat() if db_rec and db_rec.last_detected_at else None,
            learned_from_event_id=str(db_rec.learned_from_event_id) if db_rec and db_rec.learned_from_event_id else None,
            created_at=db_rec.created_at.isoformat() if db_rec and db_rec.created_at else None,
        )

    # Try by UUID
    try:
        async with async_session() as session:
            result = await session.execute(
                select(ThreatSignature).where(ThreatSignature.id == uuid.UUID(sig_id))
            )
            db_rec = result.scalar_one_or_none()
            if db_rec:
                sev = db_rec.severity.value if hasattr(db_rec.severity, "value") else str(db_rec.severity)
                return SignatureOut(
                    id=str(db_rec.id),
                    name=db_rec.name,
                    category=db_rec.category,
                    severity=sev,
                    detection_method=db_rec.detection_method,
                    description=db_rec.description or "",
                    yolo_classes=db_rec.yolo_classes or [],
                    gemini_keywords=db_rec.gemini_keywords or [],
                    conditions=db_rec.conditions or {},
                    is_active=db_rec.is_active,
                    source=db_rec.source,
                    detection_count=db_rec.detection_count,
                    last_detected_at=db_rec.last_detected_at.isoformat() if db_rec.last_detected_at else None,
                    learned_from_event_id=str(db_rec.learned_from_event_id) if db_rec.learned_from_event_id else None,
                    created_at=db_rec.created_at.isoformat() if db_rec.created_at else None,
                )
    except (ValueError, Exception):
        pass

    raise HTTPException(status_code=404, detail="Signature not found")


@router.post("", response_model=SignatureOut)
async def create_signature(
    data: SignatureCreate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Create a custom threat signature (admin only)."""
    engine = ThreatEngine()

    # Check for duplicate name
    if data.name in engine.signatures:
        raise HTTPException(status_code=409, detail=f"Signature '{data.name}' already exists")

    # Validate severity
    valid_severities = {"critical", "high", "medium", "low", "info"}
    if data.severity not in valid_severities:
        raise HTTPException(status_code=400, detail=f"Invalid severity. Must be one of: {valid_severities}")

    sev_map = {
        "critical": AlertSeverity.CRITICAL,
        "high": AlertSeverity.HIGH,
        "medium": AlertSeverity.MEDIUM,
        "low": AlertSeverity.LOW,
        "info": AlertSeverity.INFO,
    }

    try:
        async with async_session() as session:
            db_sig = ThreatSignature(
                name=data.name,
                category=data.category,
                severity=sev_map[data.severity],
                detection_method=data.detection_method,
                description=data.description,
                yolo_classes=data.yolo_classes or None,
                gemini_keywords=data.gemini_keywords or None,
                conditions=data.conditions or None,
                source="custom",
                is_active=True,
            )
            session.add(db_sig)
            await session.commit()
            await session.refresh(db_sig)

            # Load into in-memory engine
            from backend.services.threat_engine import ThreatSignatureDef
            engine.signatures[data.name] = ThreatSignatureDef(
                name=data.name,
                category=data.category,
                severity=data.severity,
                detection_method=data.detection_method,
                description=data.description,
                yolo_classes=data.yolo_classes or [],
                conditions=data.conditions or {},
                gemini_keywords=data.gemini_keywords or [],
            )

            return SignatureOut(
                id=str(db_sig.id),
                name=db_sig.name,
                category=db_sig.category,
                severity=data.severity,
                detection_method=db_sig.detection_method,
                description=db_sig.description or "",
                yolo_classes=data.yolo_classes or [],
                gemini_keywords=data.gemini_keywords or [],
                conditions=data.conditions or {},
                is_active=True,
                source="custom",
                detection_count=0,
                created_at=db_sig.created_at.isoformat() if db_sig.created_at else None,
            )
    except Exception as e:
        logger.error("Failed to create signature: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{sig_id}", response_model=SignatureOut)
async def update_signature(
    sig_id: str,
    data: SignatureUpdate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Update a threat signature (admin only)."""
    try:
        async with async_session() as session:
            # Find by UUID or name
            db_rec = None
            try:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.id == uuid.UUID(sig_id))
                )
                db_rec = result.scalar_one_or_none()
            except ValueError:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.name == sig_id)
                )
                db_rec = result.scalar_one_or_none()

            if not db_rec:
                raise HTTPException(status_code=404, detail="Signature not found in database")

            # Apply updates
            update_data = data.model_dump(exclude_unset=True)
            if "severity" in update_data:
                sev_map = {
                    "critical": AlertSeverity.CRITICAL,
                    "high": AlertSeverity.HIGH,
                    "medium": AlertSeverity.MEDIUM,
                    "low": AlertSeverity.LOW,
                    "info": AlertSeverity.INFO,
                }
                if update_data["severity"] not in sev_map:
                    raise HTTPException(status_code=400, detail="Invalid severity")
                db_rec.severity = sev_map[update_data.pop("severity")]

            for field, value in update_data.items():
                if hasattr(db_rec, field):
                    setattr(db_rec, field, value)

            await session.commit()
            await session.refresh(db_rec)

            # Update in-memory engine
            engine = ThreatEngine()
            old_name = sig_id if sig_id in engine.signatures else db_rec.name
            sev = db_rec.severity.value if hasattr(db_rec.severity, "value") else str(db_rec.severity)

            if data.name and data.name != old_name and old_name in engine.signatures:
                del engine.signatures[old_name]

            if db_rec.is_active:
                from backend.services.threat_engine import ThreatSignatureDef
                engine.signatures[db_rec.name] = ThreatSignatureDef(
                    name=db_rec.name,
                    category=db_rec.category,
                    severity=sev,
                    detection_method=db_rec.detection_method,
                    description=db_rec.description or "",
                    yolo_classes=db_rec.yolo_classes or [],
                    conditions=db_rec.conditions or {},
                    gemini_keywords=db_rec.gemini_keywords or [],
                )
            elif db_rec.name in engine.signatures:
                del engine.signatures[db_rec.name]

            return SignatureOut(
                id=str(db_rec.id),
                name=db_rec.name,
                category=db_rec.category,
                severity=sev,
                detection_method=db_rec.detection_method,
                description=db_rec.description or "",
                yolo_classes=db_rec.yolo_classes or [],
                gemini_keywords=db_rec.gemini_keywords or [],
                conditions=db_rec.conditions or {},
                is_active=db_rec.is_active,
                source=db_rec.source,
                detection_count=db_rec.detection_count,
                last_detected_at=db_rec.last_detected_at.isoformat() if db_rec.last_detected_at else None,
                learned_from_event_id=str(db_rec.learned_from_event_id) if db_rec.learned_from_event_id else None,
                created_at=db_rec.created_at.isoformat() if db_rec.created_at else None,
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to update signature: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{sig_id}")
async def delete_signature(
    sig_id: str,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Delete a signature (only auto_learned or custom, not built_in)."""
    try:
        async with async_session() as session:
            db_rec = None
            try:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.id == uuid.UUID(sig_id))
                )
                db_rec = result.scalar_one_or_none()
            except ValueError:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.name == sig_id)
                )
                db_rec = result.scalar_one_or_none()

            if not db_rec:
                raise HTTPException(status_code=404, detail="Signature not found")

            if db_rec.source == "built_in":
                raise HTTPException(
                    status_code=403,
                    detail="Cannot delete built-in signatures. Use toggle to disable instead.",
                )

            sig_name = db_rec.name
            await session.delete(db_rec)
            await session.commit()

            # Remove from in-memory engine
            engine = ThreatEngine()
            engine.signatures.pop(sig_name, None)

            return {"status": "deleted", "name": sig_name}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to delete signature: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{sig_id}/toggle")
async def toggle_signature(
    sig_id: str,
    _user=Depends(get_current_user),
):
    """Enable or disable a signature."""
    try:
        async with async_session() as session:
            db_rec = None
            try:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.id == uuid.UUID(sig_id))
                )
                db_rec = result.scalar_one_or_none()
            except ValueError:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.name == sig_id)
                )
                db_rec = result.scalar_one_or_none()

            if not db_rec:
                # For built-in signatures not yet in DB, create a DB record
                engine = ThreatEngine()
                if sig_id in engine.signatures:
                    sig = engine.signatures[sig_id]
                    sev_map = {
                        "critical": AlertSeverity.CRITICAL,
                        "high": AlertSeverity.HIGH,
                        "medium": AlertSeverity.MEDIUM,
                        "low": AlertSeverity.LOW,
                        "info": AlertSeverity.INFO,
                    }
                    db_rec = ThreatSignature(
                        name=sig.name,
                        category=sig.category,
                        severity=sev_map.get(sig.severity, AlertSeverity.MEDIUM),
                        detection_method=sig.detection_method,
                        description=sig.description,
                        yolo_classes=sig.yolo_classes or None,
                        gemini_keywords=sig.gemini_keywords or None,
                        conditions=sig.conditions or None,
                        source="built_in",
                        is_active=False,  # Toggle to disabled
                    )
                    session.add(db_rec)
                    await session.commit()
                    await session.refresh(db_rec)

                    # Remove from in-memory engine
                    del engine.signatures[sig_id]

                    return {"name": sig.name, "is_active": False}
                else:
                    raise HTTPException(status_code=404, detail="Signature not found")

            # Toggle existing DB record
            db_rec.is_active = not db_rec.is_active
            await session.commit()

            engine = ThreatEngine()
            if db_rec.is_active:
                # Re-add to engine
                from backend.services.threat_engine import ThreatSignatureDef
                sev = db_rec.severity.value if hasattr(db_rec.severity, "value") else str(db_rec.severity)
                engine.signatures[db_rec.name] = ThreatSignatureDef(
                    name=db_rec.name,
                    category=db_rec.category,
                    severity=sev,
                    detection_method=db_rec.detection_method,
                    description=db_rec.description or "",
                    yolo_classes=db_rec.yolo_classes or [],
                    conditions=db_rec.conditions or {},
                    gemini_keywords=db_rec.gemini_keywords or [],
                )
            else:
                engine.signatures.pop(db_rec.name, None)

            return {"name": db_rec.name, "is_active": db_rec.is_active}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to toggle signature: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ── False Positive & Detection Examples ────────────────────

class FalsePositiveRequest(BaseModel):
    detection_id: str = Field(..., description="ID of the detection to mark as false positive")
    reason: Optional[str] = None


@router.post("/{sig_id}/false-positive")
async def mark_false_positive(
    sig_id: str,
    body: FalsePositiveRequest,
    _user=Depends(get_current_user),
):
    """Mark a detection as a false positive for a given signature.

    This feeds back into the threat engine so that detection thresholds can be
    adjusted over time.
    """
    engine = ThreatEngine()

    # Resolve the signature by name or UUID
    sig_name: Optional[str] = None
    if sig_id in engine.signatures:
        sig_name = sig_id
    else:
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.id == uuid.UUID(sig_id))
                )
                db_rec = result.scalar_one_or_none()
                if db_rec:
                    sig_name = db_rec.name
        except (ValueError, Exception):
            pass

    if not sig_name:
        raise HTTPException(status_code=404, detail="Signature not found")

    # Record the false positive via the feedback tuning service
    try:
        from backend.services.feedback_tuning_service import feedback_tuning_service
        await feedback_tuning_service.record_feedback(
            signature_name=sig_name,
            detection_id=body.detection_id,
            feedback_type="false_positive",
            user_id=str(_user.id),
            reason=body.reason,
        )
    except Exception as e:
        logger.debug("Feedback tuning service unavailable, recording locally: %s", e)

    # Also record in the feedback API table if available
    try:
        async with async_session() as session:
            from backend.models.phase3_models import AlertFeedback
            fb = AlertFeedback(
                alert_id=uuid.UUID(body.detection_id) if len(body.detection_id) == 36 else None,
                user_id=_user.id,
                is_correct=False,
                label="false_positive",
                comment=body.reason or f"Marked as false positive for signature: {sig_name}",
            )
            session.add(fb)
            await session.commit()
    except Exception as e:
        logger.debug("AlertFeedback record failed (non-critical): %s", e)

    return {
        "status": "recorded",
        "signature": sig_name,
        "detection_id": body.detection_id,
        "feedback": "false_positive",
    }


@router.get("/{sig_id}/detections")
async def get_detection_examples(
    sig_id: str,
    limit: int = Query(5, ge=1, le=50),
    _user=Depends(get_current_user),
):
    """Get recent detection examples for a given signature."""
    from backend.models.models import Event

    # Resolve signature name
    engine = ThreatEngine()
    sig_name: Optional[str] = None
    if sig_id in engine.signatures:
        sig_name = sig_id
    else:
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.id == uuid.UUID(sig_id))
                )
                db_rec = result.scalar_one_or_none()
                if db_rec:
                    sig_name = db_rec.name
        except (ValueError, Exception):
            pass

    if not sig_name:
        raise HTTPException(status_code=404, detail="Signature not found")

    examples: list[dict] = []
    try:
        async with async_session() as session:
            # Query events that match this signature name in their event_type or metadata
            stmt = (
                select(Event)
                .where(Event.event_type == sig_name)
                .order_by(Event.timestamp.desc())
                .limit(limit)
            )
            result = await session.execute(stmt)
            for event in result.scalars().all():
                examples.append({
                    "id": str(event.id),
                    "event_type": event.event_type,
                    "severity": event.severity,
                    "confidence": event.confidence,
                    "timestamp": event.timestamp.isoformat() if event.timestamp else None,
                    "camera_id": str(event.camera_id) if event.camera_id else None,
                    "description": event.description,
                    "frame_url": event.frame_url,
                })
    except Exception as e:
        logger.debug("Detection examples query failed: %s", e)

    return examples


# ── Natural Language Policy Builder ─────────────────────────

class NLRuleRequest(BaseModel):
    rule: str = Field(..., min_length=10, max_length=1000, description="Natural language security rule")


@router.post("/from-nl")
async def create_signature_from_nl(
    body: NLRuleRequest,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Create a threat signature from a natural language rule (Admin only).

    Example: "Alert when someone loiters near the server room for more than 2 minutes"
    """
    from backend.services.nl_policy_engine import nl_policy_engine

    try:
        result = await nl_policy_engine.create_signature_from_nl(
            natural_language=body.rule,
            user_id=str(_user.id),
        )

        if not result.get("success"):
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Failed to create signature from rule",
                    "errors": result.get("errors", []),
                    "parsed": result.get("parsed"),
                },
            )

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("NL signature creation failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
