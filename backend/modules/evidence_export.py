"""Evidence Export -- forensic-grade evidence packages with hash verification.

Creates tamper-evident evidence bundles for legal proceedings.  Each file is
hashed with SHA-256, a manifest is generated, and the entire package is signed
with HMAC-SHA256 using the application secret.  Chain of custody is tracked
through the audit_logs table.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import logging
import os
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from backend.config import settings
from backend.database import async_session
from backend.models.advanced_models import EvidenceHash
from backend.models.models import Case, CaseEvidence, Alert, Event, AuditLog, Recording

logger = logging.getLogger(__name__)

# Directory where evidence packages are written
EVIDENCE_EXPORT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data",
    "evidence_exports",
)


class EvidenceExport:
    """Forensic-grade evidence packaging with chain-of-custody tracking."""

    # ── Hash computation ─────────────────────────────────────────

    async def compute_hash(self, file_path: str) -> str:
        """Compute SHA-256 hash of a file on disk.

        Args:
            file_path: Absolute or relative path to the file.

        Returns:
            Hex-encoded SHA-256 digest string.

        Raises:
            FileNotFoundError: If the file does not exist.
        """
        sha256 = hashlib.sha256()
        try:
            with open(file_path, "rb") as fh:
                while True:
                    chunk = fh.read(8192)
                    if not chunk:
                        break
                    sha256.update(chunk)
            file_hash = sha256.hexdigest()
            logger.debug("evidence.compute_hash file=%s hash=%s", file_path, file_hash)
            return file_hash
        except FileNotFoundError:
            logger.error("evidence.compute_hash file not found: %s", file_path)
            raise
        except Exception as exc:
            logger.error("evidence.compute_hash failed file=%s: %s", file_path, exc)
            raise

    # ── Hash recording ───────────────────────────────────────────

    async def create_evidence_hash(
        self,
        evidence_type: str,
        evidence_id: str,
        file_path: str,
    ) -> EvidenceHash:
        """Record the SHA-256 hash of an evidence item for tamper detection.

        Args:
            evidence_type: Category of evidence (e.g. "video", "frame", "report").
            evidence_id: UUID-string of the evidence record.
            file_path: Path to the evidence file on disk.

        Returns:
            The persisted EvidenceHash ORM instance.
        """
        file_hash = await self.compute_hash(file_path)
        hash_id = uuid.uuid4()

        async with async_session() as session:
            try:
                evidence_hash = EvidenceHash(
                    id=hash_id,
                    evidence_type=evidence_type,
                    evidence_id=uuid.UUID(evidence_id) if isinstance(evidence_id, str) else evidence_id,
                    file_path=file_path,
                    sha256_hash=file_hash,
                    verification_status="verified",
                    verified_at=datetime.now(timezone.utc),
                )
                session.add(evidence_hash)
                await session.commit()
                await session.refresh(evidence_hash)

                logger.info(
                    "evidence.create_hash id=%s type=%s evidence_id=%s hash=%s",
                    hash_id,
                    evidence_type,
                    evidence_id,
                    file_hash,
                )
                return evidence_hash

            except Exception as exc:
                await session.rollback()
                logger.error("evidence.create_hash failed: %s", exc)
                raise

    # ── Hash verification ────────────────────────────────────────

    async def verify_evidence(self, evidence_id: str) -> dict:
        """Verify that an evidence file has not been tampered with.

        Recomputes the SHA-256 hash of the file on disk and compares it
        to the stored hash.

        Args:
            evidence_id: UUID-string of the evidence record.

        Returns:
            Dict with evidence_id, file_path, original_hash, current_hash,
            verified (bool), and status.
        """
        evidence_uuid = uuid.UUID(evidence_id) if isinstance(evidence_id, str) else evidence_id

        async with async_session() as session:
            try:
                stmt = select(EvidenceHash).where(
                    EvidenceHash.evidence_id == evidence_uuid,
                ).order_by(EvidenceHash.created_at.desc()).limit(1)

                result = await session.execute(stmt)
                hash_record = result.scalar_one_or_none()

                if not hash_record:
                    logger.warning(
                        "evidence.verify no hash record for evidence_id=%s",
                        evidence_id,
                    )
                    return {
                        "evidence_id": evidence_id,
                        "verified": False,
                        "status": "no_hash_record",
                        "message": "No hash record found for this evidence item.",
                    }

                # Recompute hash from the file on disk
                try:
                    current_hash = await self.compute_hash(hash_record.file_path)
                except FileNotFoundError:
                    hash_record.verification_status = "file_missing"
                    hash_record.verified_at = datetime.now(timezone.utc)
                    await session.commit()
                    return {
                        "evidence_id": evidence_id,
                        "file_path": hash_record.file_path,
                        "original_hash": hash_record.sha256_hash,
                        "current_hash": None,
                        "verified": False,
                        "status": "file_missing",
                        "message": "Evidence file is missing from disk.",
                    }

                is_valid = current_hash == hash_record.sha256_hash

                # Update verification record
                hash_record.verified_at = datetime.now(timezone.utc)
                hash_record.verification_status = "verified" if is_valid else "tampered"
                await session.commit()

                status = "verified" if is_valid else "tampered"
                log_fn = logger.info if is_valid else logger.critical
                log_fn(
                    "evidence.verify evidence_id=%s status=%s",
                    evidence_id,
                    status,
                )

                return {
                    "evidence_id": evidence_id,
                    "file_path": hash_record.file_path,
                    "original_hash": hash_record.sha256_hash,
                    "current_hash": current_hash,
                    "verified": is_valid,
                    "status": status,
                    "verified_at": datetime.now(timezone.utc).isoformat(),
                }

            except Exception as exc:
                logger.error("evidence.verify failed evidence_id=%s: %s", evidence_id, exc)
                return {
                    "evidence_id": evidence_id,
                    "verified": False,
                    "status": "error",
                    "error": str(exc),
                }

    # ── Full case export ─────────────────────────────────────────

    async def export_case(self, case_id: str) -> dict:
        """Export a complete evidence package for a case.

        Gathers all evidence items, recordings, alerts, and events linked
        to the case.  Creates a ZIP archive containing:
            /metadata/    - case info, manifest, chain of custody
            /reports/     - alert and event JSON reports
            /video/       - referenced recording files (if they exist)
            /frames/      - referenced frame/snapshot files (if they exist)

        The ZIP is signed with HMAC-SHA256 and a manifest of all file hashes
        is included.

        Args:
            case_id: UUID-string of the case to export.

        Returns:
            Dict with export_path, manifest_path, case_id, file_count,
            total_size, and hmac_signature.
        """
        case_uuid = uuid.UUID(case_id) if isinstance(case_id, str) else case_id
        now = datetime.now(timezone.utc)
        export_id = uuid.uuid4()

        # Ensure export directory exists
        os.makedirs(EVIDENCE_EXPORT_DIR, exist_ok=True)

        async with async_session() as session:
            try:
                # -- Load the case ------------------------------------------------
                case_stmt = select(Case).where(Case.id == case_uuid)
                case_result = await session.execute(case_stmt)
                case = case_result.scalar_one_or_none()

                if not case:
                    logger.error("evidence.export_case case not found: %s", case_id)
                    return {
                        "case_id": case_id,
                        "status": "error",
                        "message": "Case not found.",
                    }

                # -- Load evidence items ------------------------------------------
                evidence_stmt = select(CaseEvidence).where(
                    CaseEvidence.case_id == case_uuid
                ).order_by(CaseEvidence.added_at.asc())
                evidence_result = await session.execute(evidence_stmt)
                evidence_items = evidence_result.scalars().all()

                # -- Load related alerts ------------------------------------------
                alert_ids = [
                    e.reference_id for e in evidence_items
                    if e.evidence_type == "alert" and e.reference_id
                ]
                alerts = []
                if alert_ids:
                    alert_stmt = select(Alert).where(Alert.id.in_(alert_ids))
                    alert_result = await session.execute(alert_stmt)
                    alerts = alert_result.scalars().all()

                # -- Load related events ------------------------------------------
                event_ids = [
                    e.reference_id for e in evidence_items
                    if e.evidence_type == "event" and e.reference_id
                ]
                events = []
                if event_ids:
                    event_stmt = select(Event).where(Event.id.in_(event_ids))
                    event_result = await session.execute(event_stmt)
                    events = event_result.scalars().all()

                # -- Load related recordings --------------------------------------
                recording_ids = [
                    e.reference_id for e in evidence_items
                    if e.evidence_type == "recording" and e.reference_id
                ]
                recordings = []
                if recording_ids:
                    rec_stmt = select(Recording).where(Recording.id.in_(recording_ids))
                    rec_result = await session.execute(rec_stmt)
                    recordings = rec_result.scalars().all()

                # -- Chain of custody from audit logs -----------------------------
                custody_stmt = select(AuditLog).where(
                    AuditLog.resource_type == "case",
                    AuditLog.resource_id == str(case_uuid),
                ).order_by(AuditLog.timestamp.asc())
                custody_result = await session.execute(custody_stmt)
                custody_logs = custody_result.scalars().all()

                # -- Build the ZIP archive ----------------------------------------
                zip_filename = f"case_{case_id}_{now.strftime('%Y%m%d_%H%M%S')}.zip"
                zip_path = os.path.join(EVIDENCE_EXPORT_DIR, zip_filename)

                manifest: Dict[str, str] = {}
                file_count = 0

                zip_buffer = io.BytesIO()
                with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                    # -- metadata/case_info.json ----------------------------------
                    case_info = {
                        "case_id": str(case.id),
                        "title": case.title,
                        "description": case.description,
                        "status": case.status.value if hasattr(case.status, "value") else str(case.status),
                        "priority": case.priority.value if hasattr(case.priority, "value") else str(case.priority),
                        "created_at": case.created_at.isoformat() if case.created_at else None,
                        "updated_at": case.updated_at.isoformat() if case.updated_at else None,
                        "closed_at": case.closed_at.isoformat() if case.closed_at else None,
                        "summary": case.summary,
                        "export_id": str(export_id),
                        "exported_at": now.isoformat(),
                        "evidence_count": len(evidence_items),
                        "alert_count": len(alerts),
                        "event_count": len(events),
                        "recording_count": len(recordings),
                    }
                    case_info_bytes = json.dumps(case_info, indent=2).encode("utf-8")
                    zf.writestr("metadata/case_info.json", case_info_bytes)
                    manifest["metadata/case_info.json"] = hashlib.sha256(case_info_bytes).hexdigest()
                    file_count += 1

                    # -- metadata/chain_of_custody.json ---------------------------
                    custody_data = []
                    for log in custody_logs:
                        custody_data.append({
                            "timestamp": log.timestamp.isoformat() if log.timestamp else None,
                            "user_id": str(log.user_id) if log.user_id else None,
                            "action": log.action,
                            "details": log.details,
                            "ip_address": log.ip_address,
                        })
                    custody_bytes = json.dumps(custody_data, indent=2).encode("utf-8")
                    zf.writestr("metadata/chain_of_custody.json", custody_bytes)
                    manifest["metadata/chain_of_custody.json"] = hashlib.sha256(custody_bytes).hexdigest()
                    file_count += 1

                    # -- metadata/evidence_items.json -----------------------------
                    evidence_data = []
                    for item in evidence_items:
                        evidence_data.append({
                            "id": str(item.id),
                            "evidence_type": item.evidence_type,
                            "reference_id": str(item.reference_id) if item.reference_id else None,
                            "title": item.title,
                            "content": item.content,
                            "file_url": item.file_url,
                            "metadata": item.metadata_,
                            "added_at": item.added_at.isoformat() if item.added_at else None,
                        })
                    evidence_bytes = json.dumps(evidence_data, indent=2).encode("utf-8")
                    zf.writestr("metadata/evidence_items.json", evidence_bytes)
                    manifest["metadata/evidence_items.json"] = hashlib.sha256(evidence_bytes).hexdigest()
                    file_count += 1

                    # -- reports/alerts.json --------------------------------------
                    alert_data = []
                    for alert in alerts:
                        alert_data.append({
                            "id": str(alert.id),
                            "title": alert.title,
                            "description": alert.description,
                            "severity": alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity),
                            "status": alert.status.value if hasattr(alert.status, "value") else str(alert.status),
                            "threat_type": alert.threat_type,
                            "source_camera": alert.source_camera,
                            "zone_name": alert.zone_name,
                            "confidence": alert.confidence,
                            "created_at": alert.created_at.isoformat() if alert.created_at else None,
                            "acknowledged_at": alert.acknowledged_at.isoformat() if alert.acknowledged_at else None,
                            "resolved_at": alert.resolved_at.isoformat() if alert.resolved_at else None,
                            "resolution_notes": alert.resolution_notes,
                            "metadata": alert.metadata_,
                        })
                    alert_bytes = json.dumps(alert_data, indent=2).encode("utf-8")
                    zf.writestr("reports/alerts.json", alert_bytes)
                    manifest["reports/alerts.json"] = hashlib.sha256(alert_bytes).hexdigest()
                    file_count += 1

                    # -- reports/events.json --------------------------------------
                    event_data = []
                    for event in events:
                        event_data.append({
                            "id": str(event.id),
                            "camera_id": str(event.camera_id),
                            "zone_id": str(event.zone_id) if event.zone_id else None,
                            "event_type": event.event_type,
                            "description": event.description,
                            "severity": event.severity.value if hasattr(event.severity, "value") else str(event.severity),
                            "confidence": event.confidence,
                            "detections": event.detections,
                            "frame_url": event.frame_url,
                            "gemini_analysis": event.gemini_analysis,
                            "timestamp": event.timestamp.isoformat() if event.timestamp else None,
                            "metadata": event.metadata_,
                        })
                    event_bytes = json.dumps(event_data, indent=2).encode("utf-8")
                    zf.writestr("reports/events.json", event_bytes)
                    manifest["reports/events.json"] = hashlib.sha256(event_bytes).hexdigest()
                    file_count += 1

                    # -- video/ and frames/ from evidence file_urls ---------------
                    for item in evidence_items:
                        if not item.file_url:
                            continue

                        file_on_disk = item.file_url
                        if not os.path.isfile(file_on_disk):
                            logger.warning(
                                "evidence.export_case file missing: %s",
                                file_on_disk,
                            )
                            continue

                        # Determine archive subdirectory
                        ext = os.path.splitext(file_on_disk)[1].lower()
                        if ext in (".mp4", ".avi", ".mkv", ".mov", ".webm"):
                            archive_dir = "video"
                        elif ext in (".jpg", ".jpeg", ".png", ".bmp", ".tiff"):
                            archive_dir = "frames"
                        else:
                            archive_dir = "files"

                        archive_name = f"{archive_dir}/{str(item.id)}_{os.path.basename(file_on_disk)}"
                        zf.write(file_on_disk, archive_name)
                        file_hash = await self.compute_hash(file_on_disk)
                        manifest[archive_name] = file_hash
                        file_count += 1

                    # -- video/ from recordings -----------------------------------
                    for rec in recordings:
                        if not rec.file_path or not os.path.isfile(rec.file_path):
                            logger.warning(
                                "evidence.export_case recording missing: %s",
                                rec.file_path,
                            )
                            continue
                        archive_name = f"video/{str(rec.id)}_{os.path.basename(rec.file_path)}"
                        zf.write(rec.file_path, archive_name)
                        file_hash = await self.compute_hash(rec.file_path)
                        manifest[archive_name] = file_hash
                        file_count += 1

                    # -- metadata/manifest.json -----------------------------------
                    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
                    zf.writestr("metadata/manifest.json", manifest_bytes)

                # -- Write ZIP to disk --------------------------------------------
                zip_bytes = zip_buffer.getvalue()
                with open(zip_path, "wb") as fh:
                    fh.write(zip_bytes)

                total_size = len(zip_bytes)

                # -- HMAC-SHA256 signature of the ZIP -----------------------------
                signing_key = settings.JWT_SECRET_KEY.encode("utf-8")
                hmac_signature = hmac.new(
                    signing_key,
                    zip_bytes,
                    hashlib.sha256,
                ).hexdigest()

                # Write signature file alongside the ZIP
                sig_path = zip_path + ".sig"
                sig_data = {
                    "export_id": str(export_id),
                    "case_id": case_id,
                    "zip_file": zip_filename,
                    "zip_sha256": hashlib.sha256(zip_bytes).hexdigest(),
                    "hmac_sha256": hmac_signature,
                    "signed_at": now.isoformat(),
                    "file_count": file_count,
                    "total_size_bytes": total_size,
                }
                with open(sig_path, "w") as fh:
                    json.dump(sig_data, fh, indent=2)

                logger.info(
                    "evidence.export_case case=%s export_id=%s files=%d size=%d path=%s",
                    case_id,
                    export_id,
                    file_count,
                    total_size,
                    zip_path,
                )

                return {
                    "export_id": str(export_id),
                    "case_id": case_id,
                    "export_path": zip_path,
                    "signature_path": sig_path,
                    "manifest": manifest,
                    "file_count": file_count,
                    "total_size_bytes": total_size,
                    "hmac_signature": hmac_signature,
                    "exported_at": now.isoformat(),
                }

            except Exception as exc:
                logger.error("evidence.export_case failed case=%s: %s", case_id, exc)
                return {
                    "case_id": case_id,
                    "status": "error",
                    "error": str(exc),
                }

    # ── Chain of custody ─────────────────────────────────────────

    async def get_chain_of_custody(self, case_id: str) -> list:
        """Get chain of custody log for a case.

        Retrieves all audit log entries related to this case, ordered
        chronologically.

        Args:
            case_id: UUID-string of the case.

        Returns:
            List of custody log dicts with timestamp, user, action, details.
        """
        async with async_session() as session:
            try:
                stmt = select(AuditLog).where(
                    AuditLog.resource_type == "case",
                    AuditLog.resource_id == str(case_id),
                ).order_by(AuditLog.timestamp.asc())

                result = await session.execute(stmt)
                logs = result.scalars().all()

                custody_chain = []
                for log in logs:
                    custody_chain.append({
                        "id": str(log.id),
                        "timestamp": log.timestamp.isoformat() if log.timestamp else None,
                        "user_id": str(log.user_id) if log.user_id else "system",
                        "action": log.action,
                        "details": log.details,
                        "ip_address": log.ip_address,
                    })

                logger.info(
                    "evidence.get_chain_of_custody case=%s entries=%d",
                    case_id,
                    len(custody_chain),
                )
                return custody_chain

            except Exception as exc:
                logger.error(
                    "evidence.get_chain_of_custody failed case=%s: %s",
                    case_id,
                    exc,
                )
                return []


# ── Singleton ────────────────────────────────────────────────────

evidence_export = EvidenceExport()
