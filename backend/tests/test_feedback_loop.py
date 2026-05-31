"""False-alarm feedback loop tests (need the test Postgres).

Guards the W3.1 fixes: operator feedback is recorded WITH attribution, updates
the camera+signature profile the live loop consults, and the previously-broken
profile endpoints work. Plus the measured accuracy endpoint.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select


@pytest.mark.asyncio
async def test_feedback_records_with_operator_and_updates_profile(make_user, db_session):
    """Core loop on a single session: feedback is attributed to the operator and
    the camera+signature FP profile is created (drives live suppression)."""
    from backend.models import Camera
    from backend.models.models import Alert, AlertSeverity
    from backend.models.phase3_models import AlertFeedback, FalsePositiveProfile
    from backend.services.feedback_tuning_service import feedback_tuning_service

    operator, _ = await make_user("fb-op@test.local")
    cam = Camera(name="fb-cam", source="3")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    alert = Alert(
        title="loiter",
        description="d",
        severity=AlertSeverity.MEDIUM,
        threat_type="loitering",
        source_camera=str(cam.id),
        confidence=0.8,
    )
    db_session.add(alert)
    await db_session.commit()
    await db_session.refresh(alert)

    result = await feedback_tuning_service.record_feedback(
        db_session,
        alert_id=str(alert.id),
        operator_id=str(operator.id),
        is_true_positive=False,
        fp_reason="shadow",
    )
    assert result  # service returns a summary dict

    fb = (
        await db_session.execute(select(AlertFeedback).where(AlertFeedback.alert_id == alert.id))
    ).scalars().all()
    assert len(fb) == 1
    assert str(fb[0].operator_id) == str(operator.id)  # attribution works when passed
    assert fb[0].is_true_positive is False

    profiles = (
        await db_session.execute(
            select(FalsePositiveProfile).where(FalsePositiveProfile.signature_name == "loitering")
        )
    ).scalars().all()
    assert profiles, "an FP profile should be created for the alert's signature"


@pytest.mark.asyncio
async def test_feedback_requires_auth(client):
    resp = await client.post(
        "/api/feedback/", json={"alert_id": "x", "is_true_positive": True}
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_accuracy_endpoint_shape(client, make_user, auth_headers):
    user, _ = await make_user("fb-acc@test.local")
    resp = await client.get("/api/feedback/accuracy", headers=auth_headers(user))
    assert resp.status_code == 200
    body = resp.json()
    for key in ("labelled_alerts", "true_positives", "false_positives", "precision", "false_alarm_rate"):
        assert key in body


@pytest.mark.asyncio
async def test_camera_profile_endpoints_no_longer_500(client, make_user, auth_headers, db_session):
    """These called nonexistent service methods before W3.1."""
    from backend.models import Camera

    user, _ = await make_user("fb-prof@test.local")
    cam = Camera(name="fb-cam2", source="4")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    h = auth_headers(user)
    prof = await client.get(f"/api/feedback/camera/{cam.id}/profile", headers=h)
    assert prof.status_code == 200

    reset = await client.post(f"/api/feedback/camera/{cam.id}/reset", headers=h)
    assert reset.status_code == 200
