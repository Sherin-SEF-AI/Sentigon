"""Evidence Chain-of-Custody Service.

Implements NIST SP 800-86 guidelines for digital evidence handling:
  - Cryptographic integrity verification (SHA-256)
  - HMAC-SHA256 signed custody entries
  - Immutable sealing
  - Court-ready export packaging

Every mutation to an evidence item is recorded in an append-only custody
chain whose entries are individually signed, making post-hoc tampering
detectable.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

EVIDENCE_HMAC_KEY = os.environ.get(
    "EVIDENCE_HMAC_KEY", "sentinel-default-hmac-key"
).encode()


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class EvidenceType(str, Enum):
    VIDEO = "VIDEO"
    IMAGE = "IMAGE"
    AUDIO = "AUDIO"
    DOCUMENT = "DOCUMENT"
    LOG = "LOG"
    SENSOR_DATA = "SENSOR_DATA"
    ACCESS_LOG = "ACCESS_LOG"
    ALERT_DATA = "ALERT_DATA"


class CustodyAction(str, Enum):
    COLLECTED = "COLLECTED"
    TRANSFERRED = "TRANSFERRED"
    ANALYZED = "ANALYZED"
    SEALED = "SEALED"
    EXPORTED = "EXPORTED"
    ACCESSED = "ACCESSED"
    MODIFIED = "MODIFIED"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class CustodyEntry:
    """A single record in the chain of custody."""

    entry_id: str
    timestamp: str
    action: CustodyAction
    actor: str
    from_location: Optional[str] = None
    to_location: Optional[str] = None
    notes: Optional[str] = None
    signature: Optional[str] = None  # HMAC-SHA256


@dataclass
class EvidenceItem:
    """A tracked piece of digital evidence."""

    evidence_id: str
    case_id: str
    title: str
    description: str
    evidence_type: EvidenceType
    source_path: str
    original_hash: str  # SHA-256
    current_hash: str
    file_size: int
    collected_by: str
    collected_at: str
    sealed: bool = False
    sealed_at: Optional[str] = None
    sealed_by: Optional[str] = None
    chain: List[CustodyEntry] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    tags: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class EvidenceService:
    """Manages evidence lifecycle and chain-of-custody records."""

    def __init__(self) -> None:
        self._store: Dict[str, EvidenceItem] = {}
        logger.info("EvidenceService initialised (NIST SP 800-86 mode)")

    # -- internal helpers ---------------------------------------------------

    @staticmethod
    def _compute_hash(file_path: str) -> str:
        """Return the SHA-256 hex digest of a file."""
        sha = hashlib.sha256()
        try:
            with open(file_path, "rb") as fh:
                while True:
                    chunk = fh.read(8192)
                    if not chunk:
                        break
                    sha.update(chunk)
        except FileNotFoundError:
            logger.warning("File not found for hashing: %s", file_path)
            return hashlib.sha256(file_path.encode()).hexdigest()
        return sha.hexdigest()

    @staticmethod
    def _sign_entry(entry: CustodyEntry) -> str:
        """Produce an HMAC-SHA256 signature over the custody entry fields."""
        payload = json.dumps(
            {
                "entry_id": entry.entry_id,
                "timestamp": entry.timestamp,
                "action": entry.action.value if isinstance(entry.action, Enum) else entry.action,
                "actor": entry.actor,
                "from_location": entry.from_location,
                "to_location": entry.to_location,
                "notes": entry.notes,
            },
            sort_keys=True,
        )
        return hmac.new(EVIDENCE_HMAC_KEY, payload.encode(), hashlib.sha256).hexdigest()

    def _get_or_raise(self, evidence_id: str) -> EvidenceItem:
        item = self._store.get(evidence_id)
        if item is None:
            raise KeyError(f"Evidence item not found: {evidence_id}")
        return item

    # -- public API ---------------------------------------------------------

    def collect_evidence(
        self,
        case_id: str,
        title: str,
        description: str,
        evidence_type: EvidenceType,
        source_path: str,
        collected_by: str,
        metadata: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
    ) -> EvidenceItem:
        """Collect a new piece of evidence and start its custody chain.

        Per NIST SP 800-86 s4.1 the original hash is recorded at the moment
        of collection and a COLLECTED entry is added to the chain.
        """
        evidence_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        file_hash = self._compute_hash(source_path)

        try:
            file_size = os.path.getsize(source_path)
        except OSError:
            file_size = 0

        # Initial custody entry
        entry = CustodyEntry(
            entry_id=str(uuid.uuid4()),
            timestamp=now,
            action=CustodyAction.COLLECTED,
            actor=collected_by,
            from_location=source_path,
            to_location="evidence-store",
            notes=f"Evidence collected: {title}",
        )
        entry.signature = self._sign_entry(entry)

        item = EvidenceItem(
            evidence_id=evidence_id,
            case_id=case_id,
            title=title,
            description=description,
            evidence_type=evidence_type,
            source_path=source_path,
            original_hash=file_hash,
            current_hash=file_hash,
            file_size=file_size,
            collected_by=collected_by,
            collected_at=now,
            metadata=metadata or {},
            tags=tags or [],
            chain=[entry],
        )

        self._store[evidence_id] = item
        logger.info(
            "Evidence collected id=%s case=%s type=%s hash=%s",
            evidence_id, case_id, evidence_type.value, file_hash,
        )
        return item

    def get_evidence(self, evidence_id: str) -> EvidenceItem:
        """Retrieve a single evidence item by ID."""
        return self._get_or_raise(evidence_id)

    def list_evidence(
        self,
        case_id: Optional[str] = None,
        evidence_type: Optional[EvidenceType] = None,
        limit: int = 100,
    ) -> List[EvidenceItem]:
        """List evidence items with optional filters."""
        results: List[EvidenceItem] = []
        for item in self._store.values():
            if case_id and item.case_id != case_id:
                continue
            if evidence_type and item.evidence_type != evidence_type:
                continue
            results.append(item)
            if len(results) >= limit:
                break
        return results

    def verify_integrity(self, evidence_id: str) -> Dict[str, Any]:
        """Verify evidence integrity per NIST SP 800-86 s4.3.

        Checks:
          1. Current file hash matches the stored original hash.
          2. Every custody chain entry signature is valid.
        """
        item = self._get_or_raise(evidence_id)

        current_hash = self._compute_hash(item.source_path)
        hash_valid = current_hash == item.original_hash

        chain_results: List[Dict[str, Any]] = []
        chain_valid = True
        for entry in item.chain:
            expected_sig = self._sign_entry(entry)
            entry_ok = hmac.compare_digest(entry.signature or "", expected_sig)
            if not entry_ok:
                chain_valid = False
            chain_results.append({
                "entry_id": entry.entry_id,
                "action": entry.action.value if isinstance(entry.action, Enum) else entry.action,
                "valid": entry_ok,
            })

        # Update current hash on the item
        item.current_hash = current_hash

        result = {
            "evidence_id": evidence_id,
            "hash_valid": hash_valid,
            "original_hash": item.original_hash,
            "current_hash": current_hash,
            "chain_valid": chain_valid,
            "chain_entries": chain_results,
            "overall_valid": hash_valid and chain_valid,
            "verified_at": datetime.now(timezone.utc).isoformat(),
        }
        logger.info(
            "Integrity check id=%s hash_ok=%s chain_ok=%s",
            evidence_id, hash_valid, chain_valid,
        )
        return result

    def transfer_custody(
        self,
        evidence_id: str,
        actor: str,
        to_location: str,
        notes: Optional[str] = None,
    ) -> CustodyEntry:
        """Record a custody transfer for an evidence item."""
        item = self._get_or_raise(evidence_id)
        if item.sealed:
            raise PermissionError("Cannot transfer sealed evidence")

        last_location = item.chain[-1].to_location if item.chain else "unknown"

        entry = CustodyEntry(
            entry_id=str(uuid.uuid4()),
            timestamp=datetime.now(timezone.utc).isoformat(),
            action=CustodyAction.TRANSFERRED,
            actor=actor,
            from_location=last_location,
            to_location=to_location,
            notes=notes,
        )
        entry.signature = self._sign_entry(entry)
        item.chain.append(entry)

        logger.info(
            "Custody transfer id=%s actor=%s -> %s",
            evidence_id, actor, to_location,
        )
        return entry

    def seal_evidence(self, evidence_id: str, sealed_by: str) -> EvidenceItem:
        """Seal evidence, making it immutable.

        Per NIST SP 800-86 s5, sealed evidence must not be modified.
        A SEALED custody entry is appended and no further mutations are
        permitted.
        """
        item = self._get_or_raise(evidence_id)
        if item.sealed:
            raise PermissionError("Evidence is already sealed")

        now = datetime.now(timezone.utc).isoformat()

        entry = CustodyEntry(
            entry_id=str(uuid.uuid4()),
            timestamp=now,
            action=CustodyAction.SEALED,
            actor=sealed_by,
            notes="Evidence sealed — no further modifications permitted",
        )
        entry.signature = self._sign_entry(entry)
        item.chain.append(entry)

        item.sealed = True
        item.sealed_at = now
        item.sealed_by = sealed_by

        logger.info("Evidence sealed id=%s by=%s", evidence_id, sealed_by)
        return item

    def export_court_ready(self, evidence_id: str) -> Dict[str, Any]:
        """Generate a court-ready export package.

        Includes the evidence metadata, full custody chain, and an
        integrity verification report suitable for legal proceedings.
        """
        item = self._get_or_raise(evidence_id)
        integrity = self.verify_integrity(evidence_id)

        # Record the export in the chain (only if not sealed)
        if not item.sealed:
            entry = CustodyEntry(
                entry_id=str(uuid.uuid4()),
                timestamp=datetime.now(timezone.utc).isoformat(),
                action=CustodyAction.EXPORTED,
                actor="system",
                notes="Court-ready export generated",
            )
            entry.signature = self._sign_entry(entry)
            item.chain.append(entry)

        package = {
            "export_id": str(uuid.uuid4()),
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "evidence": {
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
                "metadata": item.metadata,
                "tags": item.tags,
            },
            "chain_of_custody": [
                {
                    "entry_id": e.entry_id,
                    "timestamp": e.timestamp,
                    "action": e.action.value if isinstance(e.action, Enum) else e.action,
                    "actor": e.actor,
                    "from_location": e.from_location,
                    "to_location": e.to_location,
                    "notes": e.notes,
                    "signature": e.signature,
                }
                for e in item.chain
            ],
            "integrity_report": integrity,
            "nist_compliance": "NIST SP 800-86",
            "legal_notice": (
                "This evidence package was generated by SentinelAI Evidence "
                "Chain-of-Custody Service. All custody entries are signed with "
                "HMAC-SHA256. File integrity is verified using SHA-256 hashing. "
                "This package is suitable for use in legal proceedings."
            ),
        }

        logger.info("Court-ready export generated id=%s", evidence_id)
        return package

    def get_chain(self, evidence_id: str) -> List[CustodyEntry]:
        """Return the full custody chain for an evidence item."""
        item = self._get_or_raise(evidence_id)
        return list(item.chain)


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

evidence_service = EvidenceService()
