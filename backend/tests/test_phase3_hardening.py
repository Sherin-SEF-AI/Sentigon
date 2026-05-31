"""Regression tests for Phase-3 services revived by the W1 key fix.

These services used to never run (wrong detection key). Now that they receive
real data, guard the bugs found in the hardening audit:
- weapon/safety analyze_frame crashed when handed the detector dict (vs list);
- context_fusion dropped the original threat keys (signature/severity/...),
  breaking downstream suppression + alert creation.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

# A realistic detector output dict (the shape the monitoring loop actually has).
_DETECTOR_DICT = {
    "detections": [
        {"class": "person", "confidence": 0.9, "bbox": [0, 0, 40, 120],
         "center": [20, 60], "track_id": 1, "dwell_time": 2.0, "is_stationary": False},
    ],
    "person_count": 1,
    "vehicle_count": 0,
}


@pytest.mark.asyncio
async def test_weapon_analyze_frame_accepts_dict_without_crashing(db_session):
    from backend.models import Camera
    from backend.services.weapon_detection_service import weapon_detection_service

    cam = Camera(name="wp-cam", source="20")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    # Must not raise (previously: AttributeError iterating dict keys).
    result = await weapon_detection_service.analyze_frame(
        db_session, str(cam.id), None, _DETECTOR_DICT
    )
    assert result is None or isinstance(result, dict)


@pytest.mark.asyncio
async def test_safety_analyze_frame_accepts_dict_without_crashing(db_session):
    from backend.models import Camera
    from backend.services.safety_detection_service import safety_detection_service

    cam = Camera(name="sf-cam", source="21")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    result = await safety_detection_service.analyze_frame(
        db_session, str(cam.id), None, _DETECTOR_DICT
    )
    assert isinstance(result, list)


@pytest.mark.asyncio
async def test_context_fusion_preserves_downstream_keys(db_session):
    """The re-scored threat must keep signature/severity/description so the
    feedback suppression and alert-creation downstream keep working."""
    from backend.services.context_fusion_engine import context_fusion_engine

    threat = {
        "signature": "weapon_detected",
        "severity": "high",
        "confidence": 0.8,
        "description": "knife visible",
        "detection_method": "yolo",
    }
    out = await context_fusion_engine.evaluate_context(
        db_session,
        uuid.uuid4(),       # camera with no history → default context scores
        None,
        _DETECTOR_DICT,
        [threat],
        datetime.now(timezone.utc),
    )
    assert len(out) == 1
    fused = out[0]
    assert fused["signature"] == "weapon_detected"   # preserved (was dropped before)
    assert fused["severity"] == "high"
    assert fused["description"] == "knife visible"
    assert "confidence" in fused                       # re-scored value present
    assert isinstance(fused["confidence"], (int, float))
