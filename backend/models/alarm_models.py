"""Alarm panel persistence models — panels + zones survive restarts.

Durable *configuration* (which panels/zones exist and their arm state) is stored
here; live runtime fields (connection, heartbeat, alarm counters) remain in the
in-memory alarm service.
"""
from __future__ import annotations

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, func

from backend.database import Base


class AlarmPanelRow(Base):
    __tablename__ = "alarm_panels"

    panel_id = Column(String(64), primary_key=True)
    name = Column(String(255), nullable=False)
    model = Column(String(128), default="")
    ip_address = Column(String(64), default="")
    port = Column(Integer, default=0)
    arm_state = Column(String(32), default="disarmed")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AlarmZoneRow(Base):
    __tablename__ = "alarm_zones"

    panel_id = Column(String(64), ForeignKey("alarm_panels.panel_id", ondelete="CASCADE"), primary_key=True)
    zone_number = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    zone_type = Column(String(32), default="perimeter")
    partition = Column(Integer, default=1)
    camera_id = Column(Integer, nullable=True)
    bypassed = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
