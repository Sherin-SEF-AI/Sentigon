"""Natural Language Alert Rules Service — operators define alert rules in
plain English; the system parses, validates, persists, and evaluates them
against live detection frames.

Phase 3C: Agentic Security Operations.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select, func, and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.models import Zone, Alert, Camera
from backend.models.phase3_models import NLAlertRule

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Keyword extraction helpers
# ---------------------------------------------------------------------------

_ZONE_TYPE_KEYWORDS: dict[str, list[str]] = {
    "parking": ["parking", "garage", "lot", "carpark"],
    "lobby": ["lobby", "reception", "entrance", "foyer"],
    "restricted": ["restricted", "secure", "server room", "data center",
                    "vault", "armory", "control room"],
    "perimeter": ["perimeter", "fence", "gate", "boundary", "exterior"],
    "loading": ["loading", "dock", "delivery", "receiving"],
    "stairwell": ["stairwell", "stairs", "staircase"],
    "roof": ["roof", "rooftop"],
    "hallway": ["hallway", "corridor"],
    "office": ["office", "workspace"],
}

_ACTION_KEYWORDS: dict[str, list[str]] = {
    "entering": ["enter", "entering", "enters", "arrived", "arriving", "walk in",
                  "walks in", "goes in"],
    "leaving": ["leave", "leaving", "exits", "exiting", "depart", "departing",
                 "walk out"],
    "loitering": ["loiter", "loitering", "lingering", "hanging around", "standing",
                   "waiting", "idle", "dwell"],
    "running": ["run", "running", "sprint", "sprinting", "rushing"],
    "tailgating": ["tailgate", "tailgating", "piggybacking"],
    "forced_entry": ["forced", "break in", "breaking in", "pry", "prying",
                      "smash", "kick"],
    "climbing": ["climb", "climbing", "scaling"],
    "crawling": ["crawl", "crawling"],
}

_OBJECT_CLASS_KEYWORDS: dict[str, list[str]] = {
    "person": ["person", "people", "someone", "individual", "man", "woman",
               "anyone", "somebody"],
    "vehicle": ["vehicle", "car", "truck", "van", "suv", "motorcycle", "bike"],
    "backpack": ["backpack", "bag", "rucksack"],
    "weapon": ["weapon", "gun", "firearm", "rifle", "pistol"],
    "knife": ["knife", "blade"],
    "package": ["package", "box", "parcel", "crate"],
    "animal": ["animal", "dog", "cat", "bird"],
}

_DAY_NAMES = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
    "weekday": [0, 1, 2, 3, 4], "weekend": [5, 6],
    "weekdays": [0, 1, 2, 3, 4], "weekends": [5, 6],
}

_TIME_RE = re.compile(
    r"(\d{1,2})\s*:\s*(\d{2})?\s*(am|pm)?",
    re.IGNORECASE,
)

_COUNT_RE = re.compile(
    r"(?:more\s+than|over|at\s+least|>=?)\s*(\d+)",
    re.IGNORECASE,
)


def _extract_time_pair(text: str) -> tuple[Optional[str], Optional[str]]:
    """Extract start/end times from text like 'after 10pm', 'between 8am and 6pm'."""
    matches = _TIME_RE.findall(text)
    if not matches:
        return None, None
    times: list[str] = []
    for h, m, ampm in matches:
        hour = int(h)
        minute = int(m) if m else 0
        if ampm and ampm.lower() == "pm" and hour != 12:
            hour += 12
        elif ampm and ampm.lower() == "am" and hour == 12:
            hour = 0
        times.append(f"{hour:02d}:{minute:02d}")
    if len(times) == 1:
        if "after" in text.lower() or "past" in text.lower():
            return times[0], "23:59"
        if "before" in text.lower():
            return "00:00", times[0]
        return times[0], "23:59"
    return times[0], times[-1]


def _keyword_extract(text: str) -> dict:
    """Extract structured conditions from natural language via keyword matching."""
    lower = text.lower()
    conditions: dict[str, Any] = {}

    # Zone types
    zone_types = [
        zt for zt, keywords in _ZONE_TYPE_KEYWORDS.items()
        if any(kw in lower for kw in keywords)
    ]
    if zone_types:
        conditions["zone_types"] = zone_types

    # Zone names — look for capitalized proper nouns after spatial prepositions
    zone_name_match = re.search(
        r"(?:in|at|near|around|inside)\s+(?:the\s+)?([A-Z][A-Za-z0-9 ]+?)(?:\s+after|\s+before|\s+between|\s+during|$|\.)",
        text,
    )
    if zone_name_match:
        conditions["zone_names"] = [zone_name_match.group(1).strip()]

    # Time
    t_start, t_end = _extract_time_pair(text)
    if t_start:
        conditions["time_start"] = t_start
    if t_end:
        conditions["time_end"] = t_end

    # Days of week
    for day_name, day_val in _DAY_NAMES.items():
        if day_name in lower:
            if isinstance(day_val, list):
                conditions["day_of_week"] = day_val
            else:
                conditions.setdefault("day_of_week", []).append(day_val)
            break

    # Object classes
    obj_classes = [
        oc for oc, keywords in _OBJECT_CLASS_KEYWORDS.items()
        if any(kw in lower for kw in keywords)
    ]
    if obj_classes:
        conditions["object_classes"] = obj_classes

    # Actions
    actions = [
        act for act, keywords in _ACTION_KEYWORDS.items()
        if any(kw in lower for kw in keywords)
    ]
    if actions:
        conditions["actions"] = actions

    # Count threshold
    count_match = _COUNT_RE.search(text)
    if count_match:
        conditions["min_count"] = int(count_match.group(1))

    # Compound operators
    if " and " in lower and " or " in lower:
        conditions["compound_operator"] = "AND"
    elif " or " in lower:
        conditions["compound_operator"] = "OR"
    else:
        conditions["compound_operator"] = "AND"

    return conditions


def _generate_confirmation(conditions: dict, nl_text: str) -> str:
    """Generate a human-readable confirmation of the parsed rule."""
    parts: list[str] = ["I will alert you when"]

    if conditions.get("object_classes"):
        parts.append(f"a {' or '.join(conditions['object_classes'])}")
    else:
        parts.append("activity")

    if conditions.get("actions"):
        parts.append(f"is detected {' or '.join(conditions['actions'])}")
    else:
        parts.append("is detected")

    if conditions.get("zone_types"):
        parts.append(f"in {', '.join(conditions['zone_types'])} zones")
    if conditions.get("zone_names"):
        parts.append(f"at {', '.join(conditions['zone_names'])}")

    if conditions.get("time_start") and conditions.get("time_end"):
        parts.append(f"between {conditions['time_start']} and {conditions['time_end']}")
    elif conditions.get("time_start"):
        parts.append(f"after {conditions['time_start']}")

    if conditions.get("day_of_week"):
        day_labels = {0: "Mon", 1: "Tue", 2: "Wed", 3: "Thu",
                      4: "Fri", 5: "Sat", 6: "Sun"}
        days = [day_labels.get(d, str(d)) for d in conditions["day_of_week"]]
        parts.append(f"on {', '.join(days)}")

    if conditions.get("min_count"):
        parts.append(f"with count >= {conditions['min_count']}")

    return " ".join(parts) + "."


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class NLAlertRulesService:
    """Manages natural-language-defined alert rules: creation, NL parsing,
    live evaluation against detection frames, and triggering."""

    # ── NL parsing ────────────────────────────────────────────

    async def parse_nl_to_conditions(self, natural_language: str) -> dict:
        """Parse natural language rule into structured conditions.
        Uses AI when available, with keyword fallback."""
        try:
            from backend.services.ai_text_service import ai_generate_text

            prompt = (
                "You are a physical security rule parser. Convert the following "
                "natural language alert rule into structured JSON conditions.\n"
                "Return ONLY valid JSON with applicable fields:\n"
                "  zone_types: list of zone types (parking, lobby, restricted, perimeter, etc.)\n"
                "  zone_names: list of specific zone/location names\n"
                "  time_start: HH:MM (24h)\n"
                "  time_end: HH:MM (24h)\n"
                "  day_of_week: list of integers (0=Mon..6=Sun)\n"
                "  object_classes: list (person, vehicle, weapon, backpack, etc.)\n"
                "  min_count: integer threshold\n"
                "  actions: list (entering, leaving, loitering, running, tailgating, forced_entry)\n"
                "  compound_operator: AND or OR\n\n"
                f"Rule: \"{natural_language}\"\n\nJSON:"
            )
            raw = await ai_generate_text(prompt, temperature=0.1, max_tokens=512)
            if raw:
                cleaned = re.sub(r"```(?:json)?", "", raw).strip().rstrip("`")
                parsed = json.loads(cleaned)
                if isinstance(parsed, dict):
                    confirmation = _generate_confirmation(parsed, natural_language)
                    logger.info("ai_rule_parse_success", conditions=parsed)
                    return {"conditions_dict": parsed, "confirmation_text": confirmation}
        except Exception as exc:
            logger.warning("ai_rule_parse_failed", error=str(exc))

        conditions = _keyword_extract(natural_language)
        confirmation = _generate_confirmation(conditions, natural_language)
        logger.info("keyword_rule_parse", conditions=conditions)
        return {"conditions_dict": conditions, "confirmation_text": confirmation}

    # ── CRUD ──────────────────────────────────────────────────

    async def create_rule(
        self,
        db: AsyncSession,
        natural_language: str,
        name: Optional[str] = None,
        severity: str = "medium",
        created_by: Optional[str] = None,
    ) -> dict:
        """Create a new NL alert rule: parse, validate, persist."""
        parse_result = await self.parse_nl_to_conditions(natural_language)
        conditions = parse_result["conditions_dict"]
        confirmation = parse_result["confirmation_text"]

        # Validate zone references if zone_names specified
        zone_ids: list[str] = []
        if conditions.get("zone_names"):
            for zn in conditions["zone_names"]:
                zres = await db.execute(
                    select(Zone).where(Zone.name.ilike(f"%{zn}%"))
                )
                for z in zres.scalars().all():
                    zone_ids.append(str(z.id))

        if not name:
            name = natural_language[:100]

        rule = NLAlertRule(
            name=name,
            natural_language=natural_language,
            parsed_conditions=conditions,
            zone_ids=zone_ids or [],
            camera_ids=[],
            severity=severity,
            notification_channels=["push"],
            is_active=True,
            cooldown_seconds=300,
            created_by=created_by,
        )
        db.add(rule)
        await db.commit()
        await db.refresh(rule)

        logger.info("nl_rule_created", rule_id=str(rule.id), name=name,
                     conditions_keys=list(conditions.keys()))

        return {
            "rule_id": str(rule.id),
            "name": rule.name,
            "parsed_conditions": conditions,
            "confirmation_text": confirmation,
            "zone_ids": zone_ids,
            "severity": severity,
        }

    async def list_rules(
        self,
        db: AsyncSession,
        active_only: bool = True,
    ) -> list[dict]:
        """List all NL alert rules."""
        q = select(NLAlertRule).order_by(NLAlertRule.created_at.desc())
        if active_only:
            q = q.where(NLAlertRule.is_active.is_(True))
        result = await db.execute(q)
        rules = result.scalars().all()
        return [
            {
                "rule_id": str(r.id),
                "name": r.name,
                "natural_language": r.natural_language,
                "parsed_conditions": r.parsed_conditions,
                "severity": r.severity,
                "is_active": r.is_active,
                "trigger_count": r.trigger_count,
                "last_triggered_at": r.last_triggered_at.isoformat() if r.last_triggered_at else None,
                "cooldown_seconds": r.cooldown_seconds,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rules
        ]

    async def update_rule(
        self,
        db: AsyncSession,
        rule_id: str,
        updates: dict,
    ) -> dict:
        """Update an existing rule."""
        result = await db.execute(
            select(NLAlertRule).where(NLAlertRule.id == rule_id)
        )
        rule = result.scalar_one_or_none()
        if not rule:
            return {"error": "Rule not found"}

        allowed_fields = {
            "name", "severity", "is_active", "cooldown_seconds",
            "notification_channels",
        }
        for key, val in updates.items():
            if key in allowed_fields:
                setattr(rule, key, val)

        # Re-parse if natural_language changed
        if "natural_language" in updates:
            rule.natural_language = updates["natural_language"]
            parse_result = await self.parse_nl_to_conditions(updates["natural_language"])
            rule.parsed_conditions = parse_result["conditions_dict"]

        await db.commit()
        await db.refresh(rule)

        logger.info("nl_rule_updated", rule_id=rule_id, fields=list(updates.keys()))

        return {
            "rule_id": str(rule.id),
            "name": rule.name,
            "severity": rule.severity,
            "is_active": rule.is_active,
            "parsed_conditions": rule.parsed_conditions,
            "updated_at": rule.updated_at.isoformat() if rule.updated_at else None,
        }

    async def delete_rule(self, db: AsyncSession, rule_id: str) -> bool:
        """Delete a rule."""
        result = await db.execute(
            select(NLAlertRule).where(NLAlertRule.id == rule_id)
        )
        rule = result.scalar_one_or_none()
        if not rule:
            return False
        await db.delete(rule)
        await db.commit()
        logger.info("nl_rule_deleted", rule_id=rule_id)
        return True

    # ── Rule evaluation ───────────────────────────────────────

    async def evaluate_rules(
        self,
        db: AsyncSession,
        camera_id: str,
        zone_id: Optional[str],
        zone_type: Optional[str],
        detections: list[dict],
        timestamp: datetime,
    ) -> list[dict]:
        """Evaluate ALL active NL rules against a detection frame.
        Returns a list of triggered rules with match details."""
        q = select(NLAlertRule).where(NLAlertRule.is_active.is_(True))
        result = await db.execute(q)
        rules = result.scalars().all()

        triggered: list[dict] = []
        now = datetime.now(timezone.utc)

        for rule in rules:
            conds = rule.parsed_conditions or {}
            matched_conditions: list[str] = []
            failed = False

            # 1 — Zone match
            if conds.get("zone_types"):
                if zone_type and zone_type in conds["zone_types"]:
                    matched_conditions.append(f"zone_type={zone_type}")
                else:
                    failed = True

            if conds.get("zone_names") and not failed:
                # Check if camera's zone matches any named zone
                if zone_id:
                    zone_res = await db.execute(
                        select(Zone).where(Zone.id == zone_id)
                    )
                    zone_obj = zone_res.scalar_one_or_none()
                    if zone_obj and any(
                        zn.lower() in zone_obj.name.lower()
                        for zn in conds["zone_names"]
                    ):
                        matched_conditions.append(f"zone_name={zone_obj.name}")
                    else:
                        failed = True
                else:
                    failed = True

            if rule.zone_ids:
                if zone_id and str(zone_id) in [str(z) for z in rule.zone_ids]:
                    matched_conditions.append("zone_id_match")
                elif rule.zone_ids:
                    failed = True

            if failed:
                continue

            # 2 — Time match
            if conds.get("time_start") and conds.get("time_end"):
                try:
                    t_start_parts = conds["time_start"].split(":")
                    t_end_parts = conds["time_end"].split(":")
                    start_minutes = int(t_start_parts[0]) * 60 + int(t_start_parts[1])
                    end_minutes = int(t_end_parts[0]) * 60 + int(t_end_parts[1])
                    current_minutes = timestamp.hour * 60 + timestamp.minute

                    if start_minutes <= end_minutes:
                        if not (start_minutes <= current_minutes <= end_minutes):
                            continue
                    else:
                        # Overnight range (e.g., 22:00 - 06:00)
                        if not (current_minutes >= start_minutes or current_minutes <= end_minutes):
                            continue
                    matched_conditions.append(f"time={conds['time_start']}-{conds['time_end']}")
                except (ValueError, IndexError):
                    pass

            # 3 — Day of week match
            if conds.get("day_of_week"):
                if timestamp.weekday() not in conds["day_of_week"]:
                    continue
                matched_conditions.append(f"day={timestamp.strftime('%A')}")

            # 4 — Object class match
            if conds.get("object_classes"):
                det_classes = set()
                for det in detections:
                    cls = det.get("class", det.get("label", det.get("object_class", "")))
                    if cls:
                        det_classes.add(cls.lower())
                matching_classes = det_classes.intersection(
                    {c.lower() for c in conds["object_classes"]}
                )
                if not matching_classes:
                    continue
                matched_conditions.append(f"objects={','.join(matching_classes)}")

            # 5 — Count threshold
            if conds.get("min_count"):
                relevant_count = len(detections)
                if conds.get("object_classes"):
                    relevant_count = sum(
                        1 for d in detections
                        if d.get("class", d.get("label", "")).lower()
                        in {c.lower() for c in conds["object_classes"]}
                    )
                if relevant_count < conds["min_count"]:
                    continue
                matched_conditions.append(f"count={relevant_count}>={conds['min_count']}")

            # 6 — Action match (if available in detections metadata)
            if conds.get("actions"):
                det_actions = set()
                for det in detections:
                    act = det.get("action", det.get("behavior", ""))
                    if act:
                        det_actions.add(act.lower())
                if det_actions:
                    matching_actions = det_actions.intersection(
                        {a.lower() for a in conds["actions"]}
                    )
                    if matching_actions:
                        matched_conditions.append(f"actions={','.join(matching_actions)}")

            # 7 — Cooldown check
            if rule.last_triggered_at:
                cooldown_end = rule.last_triggered_at + timedelta(seconds=rule.cooldown_seconds or 300)
                if now < cooldown_end:
                    logger.debug("rule_in_cooldown", rule_id=str(rule.id),
                                  cooldown_remaining=(cooldown_end - now).total_seconds())
                    continue

            # If we get here with at least one matched condition, rule triggers
            if matched_conditions:
                triggered.append({
                    "rule_id": str(rule.id),
                    "rule_name": rule.name,
                    "severity": rule.severity,
                    "natural_language": rule.natural_language,
                    "matched_conditions": matched_conditions,
                    "camera_id": camera_id,
                    "zone_id": zone_id,
                    "timestamp": timestamp.isoformat(),
                    "detection_count": len(detections),
                })

        if triggered:
            logger.info("nl_rules_triggered", count=len(triggered),
                         rule_ids=[t["rule_id"] for t in triggered])

        return triggered

    # ── Rule triggering ───────────────────────────────────────

    async def trigger_rule(
        self,
        db: AsyncSession,
        rule_id: str,
        camera_id: str,
        match_details: dict,
    ) -> dict:
        """Mark a rule as triggered, update counters, and dispatch notification."""
        result = await db.execute(
            select(NLAlertRule).where(NLAlertRule.id == rule_id)
        )
        rule = result.scalar_one_or_none()
        if not rule:
            return {"triggered": False, "error": "Rule not found"}

        now = datetime.now(timezone.utc)
        rule.trigger_count = (rule.trigger_count or 0) + 1
        rule.last_triggered_at = now
        await db.commit()

        # Dispatch notification via configured channels
        notification_sent = False
        try:
            from backend.services.notification_service import manager
            await manager.broadcast("notifications", {
                "type": "nl_rule_triggered",
                "rule_id": str(rule.id),
                "rule_name": rule.name,
                "severity": rule.severity,
                "natural_language": rule.natural_language,
                "camera_id": camera_id,
                "match_details": match_details,
                "timestamp": now.isoformat(),
            })
            notification_sent = True
        except Exception as exc:
            logger.warning("notification_dispatch_failed", rule_id=rule_id, error=str(exc))

        logger.info("rule_triggered", rule_id=rule_id, trigger_count=rule.trigger_count,
                     notification_sent=notification_sent)

        return {
            "triggered": True,
            "rule_id": str(rule.id),
            "trigger_count": rule.trigger_count,
            "notification_sent": notification_sent,
        }

    # ── Stats ─────────────────────────────────────────────────

    async def get_rule_stats(self, db: AsyncSession) -> dict:
        """Get aggregate stats: total rules, active rules, triggers today,
        and the most-triggered rule."""
        # Total and active counts
        total_res = await db.execute(select(func.count(NLAlertRule.id)))
        total_rules = total_res.scalar() or 0

        active_res = await db.execute(
            select(func.count(NLAlertRule.id)).where(NLAlertRule.is_active.is_(True))
        )
        active_rules = active_res.scalar() or 0

        # Triggers today
        today_start = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        triggers_res = await db.execute(
            select(func.sum(NLAlertRule.trigger_count)).where(
                NLAlertRule.last_triggered_at >= today_start
            )
        )
        triggers_today = triggers_res.scalar() or 0

        # Most triggered rule
        most_triggered_res = await db.execute(
            select(NLAlertRule)
            .where(NLAlertRule.trigger_count > 0)
            .order_by(NLAlertRule.trigger_count.desc())
            .limit(1)
        )
        most = most_triggered_res.scalar_one_or_none()

        most_triggered = None
        if most:
            most_triggered = {
                "rule_id": str(most.id),
                "name": most.name,
                "trigger_count": most.trigger_count,
                "last_triggered_at": most.last_triggered_at.isoformat() if most.last_triggered_at else None,
            }

        return {
            "total_rules": total_rules,
            "active_rules": active_rules,
            "triggers_today": triggers_today,
            "most_triggered_rule": most_triggered,
        }


nl_alert_rules_service = NLAlertRulesService()
