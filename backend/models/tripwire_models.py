"""Tripwire (line-crossing) models — per-camera directional crossing lines."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from backend.database import Base


class Tripwire(Base):
    """A directional line on a camera's image. Crossing it (in the configured
    direction, by an object of a watched class) raises a crossing event.

    Coordinates are pixel coordinates in the camera's frame. ``point_a``/
    ``point_b`` define the directed line A→B; ``direction`` filters which way a
    crossing must go (relative to A→B) to fire.
    """

    __tablename__ = "tripwires"
    __table_args__ = (
        Index("ix_tripwires_camera_active", "camera_id", "is_active"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    camera_id = Column(UUID(as_uuid=True), ForeignKey("cameras.id"), nullable=False)
    name = Column(String(255), nullable=False, default="Tripwire")
    point_a = Column(JSONB, nullable=False)  # [x, y]
    point_b = Column(JSONB, nullable=False)  # [x, y]
    # "both" | "left_to_right" | "right_to_left" (relative to A→B)
    direction = Column(String(20), nullable=False, default="both")
    # COCO class names that trigger the wire (e.g. ["person"], ["car","truck"]).
    classes = Column(JSONB, default=lambda: ["person"])
    severity = Column(String(20), default="medium")  # info|low|medium|high|critical
    is_active = Column(Boolean, default=True, nullable=False)
    config = Column(JSONB, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
