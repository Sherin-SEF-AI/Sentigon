"""BOLO (Be On the Lookout) Service — create, query, deactivate BOLOs and fuzzy plate matching."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

logger = logging.getLogger(__name__)


def _levenshtein_distance(s1: str, s2: str) -> int:
    """Compute the Levenshtein (edit) distance between two strings.

    Uses the classic dynamic-programming matrix approach, O(m*n) time and space.
    """
    if len(s1) < len(s2):
        return _levenshtein_distance(s2, s1)

    if len(s2) == 0:
        return len(s1)

    prev_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            # Insertion, deletion, substitution
            insertions = prev_row[j + 1] + 1
            deletions = curr_row[j] + 1
            substitutions = prev_row[j] + (0 if c1 == c2 else 1)
            curr_row.append(min(insertions, deletions, substitutions))
        prev_row = curr_row

    return prev_row[-1]


class BOLOService:
    """Manage BOLO (Be On the Lookout) entries with fuzzy plate matching."""

    # ── Create ───────────────────────────────────────────────────

    async def create_bolo(
        self,
        bolo_type: str,
        description: Dict[str, Any],
        plate_text: Optional[str] = None,
        severity: str = "high",
        reason: Optional[str] = None,
        image_path: Optional[str] = None,
        created_by: Optional[uuid.UUID] = None,
        expires_at: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Persist a new BOLOEntry to the database.

        Args:
            bolo_type: Either ``"person"`` or ``"vehicle"``.
            description: JSONB dict with physical description details.
            plate_text: License plate text for vehicle BOLOs (optional).
            severity: One of ``"low"``, ``"medium"``, ``"high"``, ``"critical"``.
            reason: Free-text reason for the BOLO.
            image_path: Optional path to a reference image.
            created_by: UUID of the user who created the BOLO.
            expires_at: Optional expiry datetime (timezone-aware).

        Returns:
            Dict with the created BOLO entry fields.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import BOLOEntry

            async with async_session() as session:
                entry = BOLOEntry(
                    bolo_type=bolo_type,
                    description=description if isinstance(description, dict) else {"text": str(description)},
                    plate_text=plate_text.strip().upper() if plate_text else None,
                    severity=severity,
                    reason=reason,
                    image_path=image_path,
                    created_by=created_by,
                    expires_at=expires_at,
                    active=True,
                )
                session.add(entry)
                await session.commit()
                await session.refresh(entry)

                logger.info(
                    "BOLO created: id=%s type=%s severity=%s plate=%s",
                    entry.id, bolo_type, severity, plate_text,
                )
                return {
                    "id": str(entry.id),
                    "bolo_type": entry.bolo_type,
                    "description": entry.description,
                    "plate_text": entry.plate_text,
                    "severity": entry.severity,
                    "reason": entry.reason,
                    "image_path": entry.image_path,
                    "active": entry.active,
                    "created_at": entry.created_at.isoformat() if entry.created_at else None,
                    "expires_at": entry.expires_at.isoformat() if entry.expires_at else None,
                }
        except Exception as exc:
            logger.error("Failed to create BOLO: %s", exc, exc_info=True)
            raise

    # ── Query active ─────────────────────────────────────────────

    async def get_active_bolos(
        self, bolo_type: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Return all active, non-expired BOLO entries.

        Args:
            bolo_type: Optional filter by ``"person"`` or ``"vehicle"``.

        Returns:
            List of BOLO dicts.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import BOLOEntry

            now = datetime.now(timezone.utc)

            async with async_session() as session:
                stmt = select(BOLOEntry).where(BOLOEntry.active.is_(True))

                # Exclude expired entries — those with an expiry in the past
                stmt = stmt.where(
                    (BOLOEntry.expires_at.is_(None)) | (BOLOEntry.expires_at > now)
                )

                if bolo_type:
                    stmt = stmt.where(BOLOEntry.bolo_type == bolo_type)

                stmt = stmt.order_by(BOLOEntry.created_at.desc())
                result = await session.execute(stmt)
                entries = result.scalars().all()

                return [
                    {
                        "id": str(e.id),
                        "bolo_type": e.bolo_type,
                        "description": e.description,
                        "plate_text": e.plate_text,
                        "severity": e.severity,
                        "reason": e.reason,
                        "image_path": e.image_path,
                        "active": e.active,
                        "created_at": e.created_at.isoformat() if e.created_at else None,
                        "expires_at": e.expires_at.isoformat() if e.expires_at else None,
                    }
                    for e in entries
                ]
        except Exception as exc:
            logger.error("Failed to fetch active BOLOs: %s", exc, exc_info=True)
            return []

    # ── Deactivate ───────────────────────────────────────────────

    async def deactivate_bolo(self, bolo_id: uuid.UUID) -> bool:
        """Mark a BOLO entry as inactive.

        Returns:
            ``True`` if a row was updated, ``False`` otherwise.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import BOLOEntry

            async with async_session() as session:
                stmt = (
                    update(BOLOEntry)
                    .where(BOLOEntry.id == bolo_id)
                    .values(active=False, updated_at=datetime.now(timezone.utc))
                )
                result = await session.execute(stmt)
                await session.commit()

                updated = result.rowcount > 0
                if updated:
                    logger.info("BOLO deactivated: id=%s", bolo_id)
                else:
                    logger.warning("BOLO not found for deactivation: id=%s", bolo_id)
                return updated
        except Exception as exc:
            logger.error("Failed to deactivate BOLO %s: %s", bolo_id, exc, exc_info=True)
            return False

    # ── Fuzzy plate matching ─────────────────────────────────────

    async def check_plate_match(self, plate_text: str) -> List[Dict[str, Any]]:
        """Check a detected plate against all active vehicle BOLOs.

        Uses Levenshtein distance: a plate is considered a match when the
        edit distance between the normalised (uppercase, stripped) texts
        is **<= 1**.

        Args:
            plate_text: The plate text detected (e.g. from ANPR / OCR).

        Returns:
            List of matching BOLO dicts, each augmented with ``edit_distance``.
        """
        normalised = plate_text.strip().upper()
        if not normalised:
            return []

        active_bolos = await self.get_active_bolos(bolo_type="vehicle")

        matches: List[Dict[str, Any]] = []
        for bolo in active_bolos:
            bolo_plate = (bolo.get("plate_text") or "").strip().upper()
            if not bolo_plate:
                continue

            distance = _levenshtein_distance(normalised, bolo_plate)
            if distance <= 1:
                bolo["edit_distance"] = distance
                bolo["match_type"] = "exact" if distance == 0 else "fuzzy"
                matches.append(bolo)
                logger.info(
                    "Plate match: detected='%s' bolo_plate='%s' distance=%d bolo_id=%s",
                    normalised, bolo_plate, distance, bolo["id"],
                )

        return matches


# ── Singleton ────────────────────────────────────────────────────
bolo_service = BOLOService()
