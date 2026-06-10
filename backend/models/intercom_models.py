"""Intercom persistence model — devices survive restarts.

Durable device *configuration* is stored here; live call state stays in the
in-memory intercom service.
"""
from __future__ import annotations

from sqlalchemy import Boolean, Column, DateTime, Integer, String, func

from backend.database import Base


class IntercomDeviceRow(Base):
    __tablename__ = "intercom_devices"

    id = Column(String(64), primary_key=True)
    name = Column(String(255), nullable=False)
    zone = Column(String(128), default="")
    ip_address = Column(String(64), default="")
    sip_uri = Column(String(255), default="")
    has_door_release = Column(Boolean, default=False, nullable=False)
    has_camera = Column(Boolean, default=False, nullable=False)
    camera_id = Column(String(64), nullable=True)
    volume = Column(Integer, default=75)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
