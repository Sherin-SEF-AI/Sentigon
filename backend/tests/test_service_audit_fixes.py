"""Regression tests for the service-audit fixes.

- behavioral_analytics now reads the detector-dict shape (Event.detections holds
  the full detector output) and the correct "class" key — loitering/crowd-flow
  were silently returning nothing before.
- API endpoints now call methods that actually exist on their services
  (agentic_video_wall, bolo) — same AttributeError class as the feedback bug.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest


@pytest.mark.asyncio
async def test_loitering_reads_detector_dict_shape(db_session):
    from backend.models import Camera
    from backend.models.models import AlertSeverity, Event
    from backend.services.behavioral_analytics_service import behavioral_analytics_service

    cam = Camera(name="bh-cam", source="30")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    # Event.detections is the FULL detector dict (not a bare list).
    ev = Event(
        camera_id=cam.id,
        event_type="detection",
        severity=AlertSeverity.INFO,
        confidence=0.5,
        detections={
            "detections": [{"class": "person", "dwell_time": 400, "track_id": 7}],
            "person_count": 1,
        },
        timestamp=datetime.now(timezone.utc),
    )
    db_session.add(ev)
    await db_session.commit()

    loitering = await behavioral_analytics_service.detect_loitering(
        db_session, dwell_threshold_seconds=300
    )
    assert any(r.get("dwell_seconds") == 400 and r.get("track_id") == 7 for r in loitering), (
        "loitering must be detected from the detector-dict-shaped Event.detections"
    )


@pytest.mark.asyncio
async def test_crowd_flow_counts_persons_with_class_key(db_session):
    from backend.models import Camera, Zone
    from backend.models.models import AlertSeverity, Event
    from backend.services.behavioral_analytics_service import behavioral_analytics_service

    zone = Zone(name="bh-zone", zone_type="general", polygon=[[0, 0], [10, 0], [10, 10]])
    db_session.add(zone)
    await db_session.commit()
    await db_session.refresh(zone)
    cam = Camera(name="bh-cam2", source="31", zone_id=zone.id)
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    now = datetime.now(timezone.utc)
    ev = Event(
        camera_id=cam.id,
        zone_id=zone.id,
        event_type="detection",
        severity=AlertSeverity.INFO,
        confidence=0.5,
        detections={"detections": [
            {"class": "person", "track_id": 1},
            {"class": "person", "track_id": 2},
            {"class": "car", "track_id": 3},
        ]},
        timestamp=now,
    )
    db_session.add(ev)
    await db_session.commit()

    from datetime import timedelta

    flow = await behavioral_analytics_service.analyze_crowd_flow(
        db_session, str(zone.id), now - timedelta(minutes=5), now + timedelta(minutes=5)
    )
    assert flow["peak_occupancy"] == 2, "must count the two persons via the 'class' key"


def test_renamed_api_methods_exist_on_services():
    """Guard the AttributeError-class bugs: API endpoints must call methods that
    actually exist on their services."""
    from backend.services.agentic_video_wall_service import agentic_video_wall_service
    from backend.services.bolo_service import bolo_service

    assert hasattr(agentic_video_wall_service, "compute_smart_grid")
    assert hasattr(agentic_video_wall_service, "record_operator_view")
    assert hasattr(bolo_service, "check_plate_match")
    # The old, wrong names must NOT be what we call (sanity).
    assert not hasattr(agentic_video_wall_service, "get_smart_grid")
    assert not hasattr(bolo_service, "check_plate")
