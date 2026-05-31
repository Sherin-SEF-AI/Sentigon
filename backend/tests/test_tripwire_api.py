"""Tripwire API + check_camera integration tests (need the test Postgres)."""
from __future__ import annotations

from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
async def test_tripwire_list_requires_auth(client):
    resp = await client.get("/api/tripwires")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_tripwire_crud(client, make_user, auth_headers, db_session):
    from backend.models import Camera

    user, _ = await make_user("tw-user@test.local")
    cam = Camera(name="tw-cam", source="9")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    h = auth_headers(user)
    create = await client.post(
        "/api/tripwires",
        headers=h,
        json={
            "camera_id": str(cam.id),
            "name": "front-door",
            "point_a": [5, 0],
            "point_b": [5, 10],
            "direction": "both",
            "classes": ["person"],
            "severity": "high",
        },
    )
    assert create.status_code == 201, create.text
    wid = create.json()["id"]

    listed = await client.get(f"/api/tripwires?camera_id={cam.id}", headers=h)
    assert listed.status_code == 200
    assert any(w["id"] == wid for w in listed.json())

    deleted = await client.delete(f"/api/tripwires/{wid}", headers=h)
    assert deleted.status_code == 204


@pytest.mark.asyncio
async def test_invalid_direction_rejected(client, make_user, auth_headers, db_session):
    from backend.models import Camera

    user, _ = await make_user("tw-user2@test.local")
    cam = Camera(name="tw-cam-x", source="11")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    resp = await client.post(
        "/api/tripwires",
        headers=auth_headers(user),
        json={
            "camera_id": str(cam.id),
            "point_a": [0, 0],
            "point_b": [1, 1],
            "direction": "sideways",  # invalid
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_check_camera_detects_crossing(db_session):
    from backend.models import Camera
    from backend.models.tripwire_models import Tripwire
    from backend.services.tripwire_service import TripwireService

    cam = Camera(name="tw-cam2", source="8")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    wire = Tripwire(
        camera_id=cam.id,
        name="line",
        point_a=[5, 0],
        point_b=[5, 10],
        direction="both",
        classes=["person"],
        severity="high",
    )
    db_session.add(wire)
    await db_session.commit()

    svc = TripwireService()  # fresh instance — no cache pollution
    obj = SimpleNamespace(class_name="person", track_id=1, trajectory=[(0, 5), (10, 5)])
    events = await svc.check_camera(db_session, str(cam.id), [obj])
    assert len(events) == 1
    assert events[0]["signature"] == "tripwire_crossing"
    assert events[0]["tripwire_name"] == "line"
