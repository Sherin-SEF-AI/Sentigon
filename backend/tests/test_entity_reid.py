"""Integration test for embedding-based cross-camera re-identification.

Proves the appearance embedding actually drives matching: the same clothing
colour re-identifies to one entity, a distinct colour creates a new one.
Requires cv2 + numpy (for synthetic frames) and the test Postgres.
"""
from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_reid_matches_same_appearance_and_separates_different(db_session):
    np = pytest.importorskip("numpy")
    pytest.importorskip("cv2")

    from backend.models import Camera
    from backend.services.entity_tracker_service import entity_tracker_service as svc

    # Reset singleton in-memory state for a clean, deterministic run.
    svc._active_entities.clear()
    svc._entity_behavior_buffer.clear()

    cam = Camera(name="reid-cam", source="0")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)
    cam_id = str(cam.id)

    # Person A — red clothing (BGR).
    frame_a = np.zeros((200, 80, 3), dtype=np.uint8)
    frame_a[:100, :] = (0, 0, 220)
    frame_a[100:, :] = (0, 0, 130)
    det_a = {"class": "person", "track_id": 1, "bbox": [0, 0, 80, 200], "dwell_time": 1.0}

    await svc.process_detection(db_session, cam_id, None, 1, det_a, frame=frame_a)
    assert len(svc._active_entities) == 1

    # Same appearance, different ByteTrack id (e.g. another camera) → re-id match.
    await svc.process_detection(db_session, cam_id, None, 2, det_a, frame=frame_a)
    assert len(svc._active_entities) == 1, "same appearance should map to the same entity"

    # Person B — blue clothing → distinct hue → new entity.
    frame_b = np.zeros((200, 80, 3), dtype=np.uint8)
    frame_b[:100, :] = (220, 0, 0)
    frame_b[100:, :] = (130, 0, 0)
    det_b = {"class": "person", "track_id": 3, "bbox": [0, 0, 80, 200], "dwell_time": 1.0}

    await svc.process_detection(db_session, cam_id, None, 3, det_b, frame=frame_b)
    assert len(svc._active_entities) == 2, "distinct appearance should create a new entity"


@pytest.mark.asyncio
async def test_reid_persists_embedding_to_entity_track(db_session):
    np = pytest.importorskip("numpy")
    pytest.importorskip("cv2")

    from sqlalchemy import select

    from backend.models import Camera
    from backend.models.phase3_models import EntityTrack
    from backend.services.entity_tracker_service import entity_tracker_service as svc

    svc._active_entities.clear()
    svc._entity_behavior_buffer.clear()

    cam = Camera(name="reid-cam-2", source="1")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    frame = np.zeros((200, 80, 3), dtype=np.uint8)
    frame[:, :] = (0, 180, 0)  # green
    det = {"class": "person", "track_id": 7, "bbox": [0, 0, 80, 200], "dwell_time": 1.0}
    await svc.process_detection(db_session, str(cam.id), None, 7, det, frame=frame)

    rows = (await db_session.execute(select(EntityTrack))).scalars().all()
    assert rows, "an EntityTrack should be persisted"
    assert any(r.appearance_embedding for r in rows), "appearance_embedding should be populated"


@pytest.mark.asyncio
async def test_warm_cache_restores_entities_from_db(db_session):
    """re-ID must survive a process restart: warm_cache reloads recent entities
    (with embeddings) into the in-memory matching cache."""
    import uuid
    from datetime import datetime, timezone

    from backend.models import Camera
    from backend.models.phase3_models import EntityTrack
    from backend.services.entity_tracker_service import entity_tracker_service as svc

    cam = Camera(name="warm-cam", source="2")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    tid = uuid.uuid4()
    now = datetime.now(timezone.utc)
    track = EntityTrack(
        id=tid,
        entity_type="person",
        appearance_descriptor={"build": "average"},
        appearance_embedding=[0.1] * 64,
        first_seen_at=now,
        last_seen_at=now,
        first_camera_id=cam.id,
        last_camera_id=cam.id,
        cameras_visited=[str(cam.id)],
        total_appearances=1,
    )
    db_session.add(track)
    await db_session.commit()

    svc._active_entities.clear()
    loaded = await svc.warm_cache(max_age_hours=24)
    assert loaded >= 1
    assert str(tid) in svc._active_entities
    assert svc._active_entities[str(tid)]["embedding"] == [0.1] * 64
