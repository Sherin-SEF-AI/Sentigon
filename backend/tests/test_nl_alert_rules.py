"""NL alert-rule evaluation tests (need the test Postgres).

Guards the bugs found in W2.2: the evaluator silently received the wrong shape
(the full detector dict instead of the detection list), and cooldown never
engaged because last_triggered_at was never set.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest


async def _make_rule(db, conditions, name="rule", cooldown=300, severity="high"):
    from backend.models.phase3_models import NLAlertRule

    rule = NLAlertRule(
        name=name,
        natural_language=f"test rule {name}",
        parsed_conditions=conditions,
        is_active=True,
        severity=severity,
        cooldown_seconds=cooldown,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return rule


@pytest.mark.asyncio
async def test_evaluate_matches_object_class(db_session):
    from backend.services.nl_alert_rules_service import nl_alert_rules_service as svc

    rule = await _make_rule(db_session, {"object_classes": ["person"]}, name="person-rule")
    triggered = await svc.evaluate_rules(
        db_session, "cam1", None, "general", [{"class": "person"}], datetime.now(timezone.utc)
    )
    assert any(t["rule_id"] == str(rule.id) for t in triggered)


@pytest.mark.asyncio
async def test_evaluate_no_match_when_class_absent(db_session):
    from backend.services.nl_alert_rules_service import nl_alert_rules_service as svc

    rule = await _make_rule(db_session, {"object_classes": ["knife"]}, name="knife-rule")
    triggered = await svc.evaluate_rules(
        db_session, "cam1", None, "general", [{"class": "person"}], datetime.now(timezone.utc)
    )
    assert all(t["rule_id"] != str(rule.id) for t in triggered)


@pytest.mark.asyncio
async def test_evaluate_accepts_dict_defensively(db_session):
    """Regression: passing the full detector dict must still evaluate (it used
    to iterate dict keys and silently fail)."""
    from backend.services.nl_alert_rules_service import nl_alert_rules_service as svc

    rule = await _make_rule(db_session, {"object_classes": ["person"]}, name="dict-rule")
    detector_output = {"detections": [{"class": "person"}], "person_count": 1}
    triggered = await svc.evaluate_rules(
        db_session, "cam1", None, "general", detector_output, datetime.now(timezone.utc)
    )
    assert any(t["rule_id"] == str(rule.id) for t in triggered)


@pytest.mark.asyncio
async def test_cooldown_blocks_refire(db_session):
    from backend.services.nl_alert_rules_service import nl_alert_rules_service as svc

    rule = await _make_rule(db_session, {"object_classes": ["person"]}, name="cooldown-rule", cooldown=300)
    dets = [{"class": "person"}]

    first = await svc.evaluate_rules(db_session, "cam1", None, "general", dets, datetime.now(timezone.utc))
    assert any(t["rule_id"] == str(rule.id) for t in first)

    # Record the trigger (sets last_triggered_at + count) — this is what the
    # monitoring loop now does and what makes cooldown engage.
    res = await svc.trigger_rule(db_session, str(rule.id), "cam1", {})
    assert res["triggered"] is True
    assert res["trigger_count"] == 1

    second = await svc.evaluate_rules(db_session, "cam1", None, "general", dets, datetime.now(timezone.utc))
    assert all(t["rule_id"] != str(rule.id) for t in second), "cooldown should block immediate re-fire"
