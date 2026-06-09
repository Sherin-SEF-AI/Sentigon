"""PACS persistence models — doors and badge holders survive restarts.

Runtime state (door open/closed, live event counters) stays in the in-memory
service; these tables hold the durable *configuration* (which doors and badge
holders exist) so it is not lost on restart.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB

from backend.database import Base


class PacsDoor(Base):
    __tablename__ = "pacs_doors"

    door_id = Column(String(64), primary_key=True)
    name = Column(String(255), nullable=False)
    location = Column(String(255), default="")
    zone = Column(String(128), default="")
    locked = Column(Boolean, default=True, nullable=False)
    reader_in = Column(String(64), nullable=True)
    reader_out = Column(String(64), nullable=True)
    held_open_timeout = Column(Integer, default=30)
    requires_access_level = Column(Integer, default=1)
    anti_passback_enabled = Column(Boolean, default=False, nullable=False)
    camera_id = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PacsBadgeHolder(Base):
    __tablename__ = "pacs_badge_holders"

    card_number = Column(String(64), primary_key=True)
    name = Column(String(255), nullable=False)
    department = Column(String(128), default="")
    access_level = Column(Integer, default=0)
    zones_allowed = Column(JSONB, default=list)
    valid_from = Column(DateTime(timezone=True), nullable=True)
    valid_until = Column(DateTime(timezone=True), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    photo_url = Column(String(512), nullable=True)
    anti_passback_zone = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
