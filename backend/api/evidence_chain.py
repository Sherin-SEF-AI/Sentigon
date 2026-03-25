"""Evidence Chain-of-Custody API.

Exposes endpoints for collecting, tracking, verifying, and exporting
digital evidence in accordance with NIST SP 800-86 guidelines.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.evidence_service import (
    CustodyAction,
    EvidenceType,
    evidence_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/evidence-chain", tags=["Evidence Chain of Custody"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class CollectEvidenceRequest(BaseModel):
    case_id: str
    title: str
    description: str = ""
    evidence_type: EvidenceType
    source_path: str
    collected_by: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    tags: List[str] = Field(default_factory=list)


class TransferCustodyRequest(BaseModel):
    actor: str
    to_location: str
    notes: Optional[str] = None


class SealEvidenceRequest(BaseModel):
    sealed_by: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _item_to_dict(item) -> Dict[str, Any]:
    """Serialise an EvidenceItem to a JSON-safe dictionary."""
    return {
        "evidence_id": item.evidence_id,
        "case_id": item.case_id,
        "title": item.title,
        "description": item.description,
        "evidence_type": item.evidence_type.value,
        "source_path": item.source_path,
        "original_hash": item.original_hash,
        "current_hash": item.current_hash,
        "file_size": item.file_size,
        "collected_by": item.collected_by,
        "collected_at": item.collected_at,
        "sealed": item.sealed,
        "sealed_at": item.sealed_at,
        "sealed_by": item.sealed_by,
        "chain_length": len(item.chain),
        "metadata": item.metadata,
        "tags": item.tags,
    }


def _entry_to_dict(entry) -> Dict[str, Any]:
    """Serialise a CustodyEntry to a JSON-safe dictionary."""
    from enum import Enum

    return {
        "entry_id": entry.entry_id,
        "timestamp": entry.timestamp,
        "action": entry.action.value if isinstance(entry.action, Enum) else entry.action,
        "actor": entry.actor,
        "from_location": entry.from_location,
        "to_location": entry.to_location,
        "notes": entry.notes,
        "signature": entry.signature,
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/collect")
async def collect_evidence(body: CollectEvidenceRequest):
    """Collect a new piece of evidence and start its custody chain."""
    try:
        item = evidence_service.collect_evidence(
            case_id=body.case_id,
            title=body.title,
            description=body.description,
            evidence_type=body.evidence_type,
            source_path=body.source_path,
            collected_by=body.collected_by,
            metadata=body.metadata,
            tags=body.tags,
        )
        return {"status": "collected", "evidence": _item_to_dict(item)}
    except Exception as exc:
        logger.exception("Failed to collect evidence")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/{evidence_id}")
async def get_evidence(evidence_id: str):
    """Retrieve full details for a single evidence item."""
    try:
        item = evidence_service.get_evidence(evidence_id)
        return _item_to_dict(item)
    except KeyError:
        raise HTTPException(status_code=404, detail="Evidence item not found")


@router.get("/")
async def list_evidence(
    case_id: Optional[str] = Query(None),
    evidence_type: Optional[EvidenceType] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
):
    """List evidence items with optional filters."""
    items = evidence_service.list_evidence(
        case_id=case_id,
        evidence_type=evidence_type,
        limit=limit,
    )
    return {"items": [_item_to_dict(i) for i in items], "count": len(items)}


@router.post("/{evidence_id}/verify")
async def verify_integrity(evidence_id: str):
    """Verify the integrity of an evidence item (hash + chain signatures)."""
    try:
        result = evidence_service.verify_integrity(evidence_id)
        return result
    except KeyError:
        raise HTTPException(status_code=404, detail="Evidence item not found")


@router.post("/{evidence_id}/transfer")
async def transfer_custody(evidence_id: str, body: TransferCustodyRequest):
    """Record a custody transfer for an evidence item."""
    try:
        entry = evidence_service.transfer_custody(
            evidence_id=evidence_id,
            actor=body.actor,
            to_location=body.to_location,
            notes=body.notes,
        )
        return {"status": "transferred", "entry": _entry_to_dict(entry)}
    except KeyError:
        raise HTTPException(status_code=404, detail="Evidence item not found")
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))


@router.post("/{evidence_id}/seal")
async def seal_evidence(evidence_id: str, body: SealEvidenceRequest):
    """Seal an evidence item, making it immutable."""
    try:
        item = evidence_service.seal_evidence(
            evidence_id=evidence_id,
            sealed_by=body.sealed_by,
        )
        return {"status": "sealed", "evidence": _item_to_dict(item)}
    except KeyError:
        raise HTTPException(status_code=404, detail="Evidence item not found")
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))


@router.get("/{evidence_id}/export")
async def export_court_ready(evidence_id: str):
    """Generate a court-ready export package with integrity report."""
    try:
        package = evidence_service.export_court_ready(evidence_id)
        return package
    except KeyError:
        raise HTTPException(status_code=404, detail="Evidence item not found")


@router.get("/{evidence_id}/chain")
async def get_chain(evidence_id: str):
    """Retrieve the full chain of custody for an evidence item."""
    try:
        chain = evidence_service.get_chain(evidence_id)
        return {
            "evidence_id": evidence_id,
            "chain": [_entry_to_dict(e) for e in chain],
            "total_entries": len(chain),
        }
    except KeyError:
        raise HTTPException(status_code=404, detail="Evidence item not found")
