"""Integration test: composite signatures over persisted entity appearances."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest


@pytest.mark.asyncio
async def test_loiter_then_intrusion_detected_from_appearances(db_session):
    from backend.models import Camera, Zone
    from backend.models.phase3_models import EntityAppearance, EntityTrack
    from backend.services.entity_tracker_service import entity_tracker_service as svc

    cam = Camera(name="cs-cam", source="40")
    zone = Zone(name="vault", zone_type="restricted", polygon=[[0, 0], [1, 0], [1, 1]])
    db_session.add_all([cam, zone])
    await db_session.commit()
    await db_session.refresh(cam)
    await db_session.refresh(zone)

    tid = uuid.uuid4()
    now = datetime.now(timezone.utc)
    et = EntityTrack(
        id=tid, entity_type="person", first_seen_at=now, last_seen_at=now,
        first_camera_id=cam.id, last_camera_id=cam.id, behavioral_flags=[],
    )
    db_session.add(et)
    await db_session.commit()  # parent before child (FK)

    db_session.add_all([
        EntityAppearance(
            entity_track_id=tid, camera_id=cam.id, zone_id=None,
            timestamp=now - timedelta(seconds=120), behavior="loitering",
        ),
        EntityAppearance(
            entity_track_id=tid, camera_id=cam.id, zone_id=zone.id,
            timestamp=now, behavior="walking_past",
        ),
    ])
    await db_session.commit()

    result = await svc.evaluate_composite_signatures(db_session, str(tid))
    assert result is not None, "loiter→restricted sequence should fire a composite signature"
    assert result["signature"] == "loiter_then_intrusion"
    assert result["severity"] == "high"
    assert result["alert_needed"] is True

    # Dedup: once flagged, the same signature must not re-fire.
    again = await svc.evaluate_composite_signatures(db_session, str(tid))
    assert again is None, "already-flagged signature should not re-fire"


@pytest.mark.asyncio
async def test_benign_appearances_fire_nothing(db_session):
    from backend.models import Camera
    from backend.models.phase3_models import EntityAppearance, EntityTrack
    from backend.services.entity_tracker_service import entity_tracker_service as svc

    cam = Camera(name="cs-cam2", source="41")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    tid = uuid.uuid4()
    now = datetime.now(timezone.utc)
    et = EntityTrack(
        id=tid, entity_type="person", first_seen_at=now, last_seen_at=now,
        first_camera_id=cam.id, last_camera_id=cam.id, behavioral_flags=[],
    )
    db_session.add(et)
    await db_session.commit()

    db_session.add_all([
        EntityAppearance(entity_track_id=tid, camera_id=cam.id, zone_id=None,
                         timestamp=now - timedelta(seconds=60), behavior="walking_past"),
        EntityAppearance(entity_track_id=tid, camera_id=cam.id, zone_id=None,
                         timestamp=now, behavior="walking_past"),
    ])
    await db_session.commit()

    assert await svc.evaluate_composite_signatures(db_session, str(tid)) is None
