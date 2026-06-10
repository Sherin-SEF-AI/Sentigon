"""Evidence Export API — forensic-grade evidence packages with chain of custody."""
from __future__ import annotations

import hashlib
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select, desc

from backend.api.auth import get_current_user, require_role
from backend.database import async_session
from backend.models.models import UserRole, Case, CaseEvidence
from backend.models.advanced_models import EvidenceHash

logger = logging.getLogger(__name__)

# ── Evidence file upload router (prefix: /api/evidence) ───────────
upload_router = APIRouter(prefix="/api/evidence", tags=["evidence-upload"])


@upload_router.post("/upload")
async def upload_evidence_file(
    file: UploadFile = File(...),
    case_id: Optional[str] = Form(None),
    _user=Depends(get_current_user),
):
    """
    Upload a file as evidence. Optionally attach it to a case.

    Returns: { id, name, size, type, url, case_id, sha256, uploaded_at }
    """
    # Validate allowed MIME types (images, video, common docs)
    allowed_prefixes = ("image/", "video/")
    allowed_types = {
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
    }
    content_type = file.content_type or ""
    if not (
        any(content_type.startswith(p) for p in allowed_prefixes)
        or content_type in allowed_types
    ):
        raise HTTPException(
            status_code=415,
            detail=f"File type '{content_type}' is not allowed.",
        )

    # Read file content
    content = await file.read()
    sha256_hash = hashlib.sha256(content).hexdigest()

    # Persist to disk
    evidence_id = str(uuid.uuid4())
    upload_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "evidence_uploads")
    os.makedirs(upload_dir, exist_ok=True)

    ext = os.path.splitext(file.filename or "file")[1] or ""
    save_filename = f"{evidence_id}{ext}"
    save_path = os.path.join(upload_dir, save_filename)
    with open(save_path, "wb") as fp:
        fp.write(content)

    file_url = f"/api/evidence/files/{save_filename}"
    now = datetime.now(timezone.utc)

    # Optionally record as CaseEvidence + EvidenceHash in the database
    if case_id:
        try:
            async with async_session() as session:
                case = (await session.execute(
                    select(Case).where(Case.id == uuid.UUID(case_id))
                )).scalar_one_or_none()

                if case:
                    ev = CaseEvidence(
                        id=uuid.UUID(evidence_id),
                        case_id=case.id,
                        evidence_type="file",
                        title=file.filename or save_filename,
                        file_url=file_url,
                    )
                    session.add(ev)

                    ev_hash = EvidenceHash(
                        evidence_id=uuid.UUID(evidence_id),
                        evidence_type="file",
                        file_path=save_path,
                        sha256_hash=sha256_hash,
                        verification_status="verified",
                        verified_at=now,
                    )
                    session.add(ev_hash)
                    await session.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("evidence.upload.db_write_failed", error=str(exc))

    return {
        "id": evidence_id,
        "evidence_id": evidence_id,
        "name": file.filename,
        "size": len(content),
        "type": content_type,
        "url": file_url,
        "file_url": file_url,
        "case_id": case_id,
        "sha256": sha256_hash,
        "uploaded_at": now.isoformat(),
    }


@upload_router.post("/{evidence_id}/verify")
async def verify_evidence(evidence_id: str, _user=Depends(get_current_user)):
    """Re-hash the stored file and compare against the recorded SHA-256."""
    try:
        eid = uuid.UUID(evidence_id)
    except ValueError:
        raise HTTPException(400, "Invalid evidence id")
    async with async_session() as session:
        rec = (await session.execute(
            select(EvidenceHash).where(EvidenceHash.evidence_id == eid)
        )).scalar_one_or_none()
        if not rec:
            raise HTTPException(404, "Evidence hash record not found")
        expected = rec.sha256_hash
        actual = None
        try:
            if rec.file_path and os.path.exists(rec.file_path):
                with open(rec.file_path, "rb") as fp:
                    actual = hashlib.sha256(fp.read()).hexdigest()
        except Exception as exc:  # noqa: BLE001
            logger.warning("evidence.verify.read_failed", error=str(exc))
        ok = bool(actual) and actual == expected
        rec.verification_status = "verified" if ok else ("tampered" if actual else "missing")
        rec.verified_at = datetime.now(timezone.utc)
        await session.commit()
        return {
            "evidence_id": evidence_id,
            "verified": ok,
            "expected_hash": expected,
            "actual_hash": actual,
            "status": rec.verification_status,
            "verified_at": rec.verified_at.isoformat(),
        }


@upload_router.get("/{evidence_id}/chain-of-custody")
async def evidence_chain_of_custody(evidence_id: str, _user=Depends(get_current_user)):
    """Custody timeline derived from the real evidence + hash records."""
    try:
        eid = uuid.UUID(evidence_id)
    except ValueError:
        raise HTTPException(400, "Invalid evidence id")
    async with async_session() as session:
        ev = (await session.execute(
            select(CaseEvidence).where(CaseEvidence.id == eid)
        )).scalar_one_or_none()
        h = (await session.execute(
            select(EvidenceHash).where(EvidenceHash.evidence_id == eid)
        )).scalar_one_or_none()
        if ev is None and h is None:
            raise HTTPException(404, "Evidence not found")

        raw = []
        if ev is not None:
            raw.append(("collected", getattr(ev, "added_at", None),
                        f"Evidence '{getattr(ev, 'title', '')}' registered"))
        if h is not None:
            raw.append(("hashed", getattr(h, "created_at", None),
                        f"SHA-256 {(h.sha256_hash or '')[:16]}…"))
            if h.verified_at:
                raw.append(("verified", h.verified_at,
                            f"Integrity check: {h.verification_status}"))

        entries = []
        for action, at, detail in raw:
            if at is None:
                continue
            entries.append({
                "action": action,
                "actor": "system",
                "detail": detail,
                "at": at.isoformat() if hasattr(at, "isoformat") else str(at),
            })
        entries.sort(key=lambda e: e["at"])
        return {"evidence_id": evidence_id, "entries": entries, "total_entries": len(entries)}


@upload_router.get("")
async def list_evidence(
    case_id: Optional[str] = None,
    limit: int = 200,
    _user=Depends(get_current_user),
):
    """List evidence items (newest first), optionally scoped to a case."""
    async with async_session() as session:
        stmt = select(CaseEvidence).order_by(desc(CaseEvidence.added_at)).limit(min(limit, 500))
        if case_id:
            try:
                stmt = select(CaseEvidence).where(
                    CaseEvidence.case_id == uuid.UUID(case_id)
                ).order_by(desc(CaseEvidence.added_at)).limit(min(limit, 500))
            except ValueError:
                raise HTTPException(400, "Invalid case_id")
        rows = (await session.execute(stmt)).scalars().all()
        return [
            {
                "id": str(r.id),
                "case_id": str(r.case_id) if r.case_id else None,
                "type": getattr(r, "evidence_type", None),
                "name": getattr(r, "title", None),
                "title": getattr(r, "title", None),
                "url": getattr(r, "file_url", None),
                "file_url": getattr(r, "file_url", None),
                "created_at": r.added_at.isoformat() if getattr(r, "added_at", None) else None,
            }
            for r in rows
        ]


# Keep the original case-scoped router as well
router_cases = APIRouter(prefix="/api/cases", tags=["evidence"])


@router_cases.post("/{case_id}/export")
async def export_case(case_id: str, _user=Depends(require_role(UserRole.ANALYST))):
    """Export a complete evidence package for a case."""
    async with async_session() as session:
        case = (await session.execute(
            select(Case).where(Case.id == uuid.UUID(case_id))
        )).scalar_one_or_none()
        if not case:
            raise HTTPException(status_code=404, detail="Case not found")

        evidence_items = (await session.execute(
            select(CaseEvidence).where(CaseEvidence.case_id == case.id)
        )).scalars().all()

        # Build manifest
        manifest = {
            "case_id": str(case.id),
            "case_title": case.title,
            "export_timestamp": datetime.now(timezone.utc).isoformat(),
            "evidence_count": len(evidence_items),
            "items": [
                {
                    "id": str(e.id),
                    "type": e.evidence_type,
                    "title": e.title,
                    "file_url": e.file_url,
                }
                for e in evidence_items
            ],
        }

        return {
            "status": "exported",
            "case_id": str(case.id),
            "manifest": manifest,
            "evidence_count": len(evidence_items),
        }


@router_cases.get("/{case_id}/chain-of-custody")
async def get_chain_of_custody(case_id: str, _user=Depends(get_current_user)):
    """Get chain of custody log for a case."""
    async with async_session() as session:
        hashes = (await session.execute(
            select(EvidenceHash)
            .where(EvidenceHash.evidence_id == uuid.UUID(case_id))
            .order_by(EvidenceHash.created_at)
        )).scalars().all()

        return [
            {
                "id": str(h.id),
                "evidence_type": h.evidence_type,
                "file_path": h.file_path,
                "sha256_hash": h.sha256_hash,
                "created_at": h.created_at.isoformat() if h.created_at else None,
                "verified_at": h.verified_at.isoformat() if h.verified_at else None,
                "verification_status": h.verification_status,
            }
            for h in hashes
        ]
