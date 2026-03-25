"""Emergency Code Service — manages real-time emergency activations for Sentinel AI.

Supports hospital (Code Blue/Red/Silver/Pink/Orange/Gray/Black), mall (Code Adam,
Evacuate, Shelter), and all other industry templates. Stores active emergencies
in-memory for instant access; also attempts DB audit logging.
"""

from __future__ import annotations

import logging
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Deque, Dict, List, Optional

from backend.services.industry_templates import INDUSTRY_TEMPLATES

logger = logging.getLogger(__name__)


# ── Build master code list from all industry templates ────────────────────────

def _build_master_codes() -> Dict[str, dict]:
    """Merge emergency codes from every industry into one de-duplicated master dict.

    Keys are the code name (e.g. "Code Blue"). If two industries share the same
    code name the first occurrence wins; a ``_industries`` list tracks which
    industries define each code.
    """
    master: Dict[str, dict] = {}
    for industry_key, template in INDUSTRY_TEMPLATES.items():
        for ec in template.get("emergency_codes", []):
            code_name: str = ec["code"]
            if code_name not in master:
                master[code_name] = {
                    "code": code_name,
                    "color": ec.get("color", "#ef4444"),
                    "description": ec.get("description", ""),
                    "actions": ec.get("actions", []),
                    "_industries": [industry_key],
                }
            else:
                if industry_key not in master[code_name]["_industries"]:
                    master[code_name]["_industries"].append(industry_key)
    return master


MASTER_CODES: Dict[str, dict] = _build_master_codes()


# ── In-memory state ───────────────────────────────────────────────────────────

# active_emergencies: code_name -> activation record (only currently active ones)
_active_emergencies: Dict[str, dict] = {}

# history ring-buffer — most-recent first; max 200 entries
_history: Deque[dict] = deque(maxlen=200)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_record(
    code: str,
    activated_by: str,
    site_id: Optional[str],
    notes: Optional[str],
) -> dict:
    code_def = MASTER_CODES.get(code, {})
    return {
        "id": str(uuid.uuid4()),
        "code": code,
        "color": code_def.get("color", "#ef4444"),
        "description": code_def.get("description", ""),
        "actions": code_def.get("actions", []),
        "activated_by": activated_by,
        "activated_at": _now_iso(),
        "deactivated_at": None,
        "site_id": site_id,
        "notes": notes,
        "status": "active",
    }


def _audit_log(action: str, details: dict) -> None:
    """Attempt to write an audit log entry to the database.

    This is fire-and-forget; any exception is swallowed so emergencies never
    fail due to a database outage.
    """
    try:
        import asyncio

        async def _write():
            try:
                from backend.database import async_session
                from backend.models import AuditLog

                async with async_session() as session:
                    entry = AuditLog(
                        action=action,
                        resource_type="emergency_code",
                        details=details,
                    )
                    session.add(entry)
                    await session.commit()
            except Exception as db_exc:  # noqa: BLE001
                logger.debug("emergency.audit_log.db_skip: %s", db_exc)

        # Run in background; do not block the caller.
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(_write())
        else:
            loop.run_until_complete(_write())
    except Exception as exc:  # noqa: BLE001
        logger.debug("emergency.audit_log.skip: %s", exc)


# ── Public API ────────────────────────────────────────────────────────────────

def get_all_codes() -> List[dict]:
    """Return all known emergency codes (from all industry templates)."""
    return list(MASTER_CODES.values())


def activate_emergency(
    code: str,
    activated_by: str = "operator",
    site_id: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    """Activate an emergency code.

    If the code is already active the existing record is returned unchanged.

    Args:
        code: The emergency code name, e.g. ``"Code Blue"``.
        activated_by: Identifier of the operator triggering the activation.
        site_id: Optional site/facility identifier.
        notes: Optional free-text notes logged with the activation.

    Returns:
        The activation record dict.
    """
    if code in _active_emergencies:
        logger.info("emergency.already_active code=%s", code)
        return _active_emergencies[code]

    record = _make_record(code, activated_by, site_id, notes)
    _active_emergencies[code] = record
    _history.appendleft(record.copy())

    logger.warning(
        "emergency.activated code=%s activated_by=%s site_id=%s record_id=%s",
        code, activated_by, site_id, record["id"],
    )

    _audit_log(
        f"EMERGENCY_ACTIVATE:{code}",
        {
            "record_id": record["id"],
            "code": code,
            "activated_by": activated_by,
            "site_id": site_id,
            "notes": notes,
        },
    )

    return record


def deactivate_emergency(
    code: str,
    deactivated_by: str = "operator",
) -> dict:
    """Deactivate an active emergency code.

    Args:
        code: The emergency code name to deactivate.
        deactivated_by: Identifier of the operator clearing the emergency.

    Returns:
        The resolved activation record dict, or an error dict if the code was
        not active.
    """
    record = _active_emergencies.pop(code, None)
    if record is None:
        logger.info("emergency.not_active code=%s", code)
        return {"error": f"Code '{code}' is not currently active", "code": code}

    resolved_at = _now_iso()
    record["deactivated_at"] = resolved_at
    record["status"] = "resolved"
    record["deactivated_by"] = deactivated_by

    # Update the copy that sits in history (first matching id)
    for hist_record in _history:
        if hist_record.get("id") == record["id"]:
            hist_record.update(
                deactivated_at=resolved_at,
                status="resolved",
                deactivated_by=deactivated_by,
            )
            break

    logger.warning(
        "emergency.deactivated code=%s deactivated_by=%s record_id=%s",
        code, deactivated_by, record["id"],
    )

    _audit_log(
        f"EMERGENCY_DEACTIVATE:{code}",
        {
            "record_id": record["id"],
            "code": code,
            "deactivated_by": deactivated_by,
            "deactivated_at": resolved_at,
        },
    )

    return record


def get_active_emergencies() -> List[dict]:
    """Return all currently active emergencies."""
    return list(_active_emergencies.values())


def get_emergency_history(limit: int = 50) -> List[dict]:
    """Return the most recent *limit* emergency activations/deactivations."""
    capped = min(limit, len(_history))
    return [_history[i] for i in range(capped)]
