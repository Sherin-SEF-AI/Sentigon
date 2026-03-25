"""Incident Recorder — captures frames, detections, and agent actions for replay."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, desc, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import async_session

logger = logging.getLogger(__name__)

# Active recordings: incident_id -> True
_active_recordings: Dict[str, bool] = {}


class IncidentRecorder:
    """Records incident data (frames, detections, agent actions) for replay."""

    PRE_BUFFER_SECONDS = 60
    MAX_RECORDING_MINUTES = 30

    async def start_recording(
        self,
        title: str,
        camera_ids: Optional[List[str]] = None,
        zone_ids: Optional[List[str]] = None,
        alert_id: Optional[str] = None,
        case_id: Optional[str] = None,
        pre_buffer_seconds: int = 60,
    ) -> Dict[str, Any]:
        """Start recording an incident. Returns the incident snapshot."""
        from backend.models.advanced_models import IncidentSnapshot
        import uuid

        now = datetime.now(timezone.utc)
        start_time = now - timedelta(seconds=pre_buffer_seconds)

        async with async_session() as session:
            snapshot = IncidentSnapshot(
                title=title,
                description=f"Recording started at {now.isoformat()}",
                start_time=start_time,
                camera_ids=camera_ids or [],
                zone_ids=zone_ids or [],
                trigger_alert_id=uuid.UUID(alert_id) if alert_id else None,
                trigger_case_id=uuid.UUID(case_id) if case_id else None,
                status="recording",
                metadata_={"pre_buffer_seconds": pre_buffer_seconds},
            )
            session.add(snapshot)
            await session.commit()
            await session.refresh(snapshot)

            incident_id = str(snapshot.id)
            _active_recordings[incident_id] = True

            logger.info(
                "incident_recorder.started",
                incident_id=incident_id,
                cameras=len(camera_ids or []),
            )
            return self._fmt_snapshot(snapshot)

    async def stop_recording(self, incident_id: str) -> Dict[str, Any]:
        """Stop recording and finalize the incident snapshot."""
        from backend.models.advanced_models import IncidentSnapshot, IncidentFrame, IncidentAgentAction
        import uuid

        _active_recordings.pop(incident_id, None)

        async with async_session() as session:
            snapshot = (await session.execute(
                select(IncidentSnapshot).where(IncidentSnapshot.id == uuid.UUID(incident_id))
            )).scalar_one_or_none()

            if not snapshot:
                return {"error": "Incident not found"}

            snapshot.status = "complete"
            snapshot.end_time = datetime.now(timezone.utc)

            # Count frames and actions
            frame_count = (await session.execute(
                select(func.count(IncidentFrame.id)).where(
                    IncidentFrame.incident_id == uuid.UUID(incident_id)
                )
            )).scalar() or 0

            action_count = (await session.execute(
                select(func.count(IncidentAgentAction.id)).where(
                    IncidentAgentAction.incident_id == uuid.UUID(incident_id)
                )
            )).scalar() or 0

            snapshot.total_frames = frame_count
            snapshot.total_agent_actions = action_count

            await session.commit()
            await session.refresh(snapshot)

            logger.info(
                "incident_recorder.stopped",
                incident_id=incident_id,
                frames=frame_count,
                actions=action_count,
            )
            return self._fmt_snapshot(snapshot)

    async def add_frame(
        self,
        incident_id: str,
        camera_id: str,
        frame_path: str,
        detections: Optional[dict] = None,
        analysis: Optional[dict] = None,
        zone_occupancy: Optional[dict] = None,
    ) -> bool:
        """Add a frame to an active recording."""
        if incident_id not in _active_recordings:
            return False

        from backend.models.advanced_models import IncidentFrame, IncidentSnapshot
        import uuid

        async with async_session() as session:
            # Get current sequence number
            max_seq = (await session.execute(
                select(func.max(IncidentFrame.sequence_num)).where(
                    IncidentFrame.incident_id == uuid.UUID(incident_id)
                )
            )).scalar() or 0

            frame = IncidentFrame(
                incident_id=uuid.UUID(incident_id),
                camera_id=uuid.UUID(camera_id),
                sequence_num=max_seq + 1,
                timestamp=datetime.now(timezone.utc),
                frame_path=frame_path,
                detections=detections,
                gemini_analysis=analysis,
                zone_occupancy=zone_occupancy,
            )
            session.add(frame)
            await session.commit()
        return True

    async def add_agent_action(
        self,
        incident_id: str,
        agent_name: str,
        action_type: str,
        tool_name: Optional[str] = None,
        tool_args: Optional[dict] = None,
        tool_result: Optional[dict] = None,
        decision_summary: Optional[str] = None,
        confidence: Optional[float] = None,
    ) -> bool:
        """Add an agent action to an active recording."""
        if incident_id not in _active_recordings:
            return False

        from backend.models.advanced_models import IncidentAgentAction
        import uuid

        async with async_session() as session:
            action = IncidentAgentAction(
                incident_id=uuid.UUID(incident_id),
                timestamp=datetime.now(timezone.utc),
                agent_name=agent_name,
                action_type=action_type,
                tool_name=tool_name,
                tool_args=tool_args,
                tool_result=tool_result,
                decision_summary=decision_summary,
                confidence=confidence,
            )
            session.add(action)
            await session.commit()
        return True

    async def log_agent_action_if_recording(
        self,
        agent_name: str,
        action_type: str,
        details: dict,
    ):
        """Called from base_agent.log_action — records if any incident is active."""
        if not _active_recordings:
            return

        for incident_id in list(_active_recordings.keys()):
            await self.add_agent_action(
                incident_id=incident_id,
                agent_name=agent_name,
                action_type=action_type,
                tool_name=details.get("tool"),
                tool_args=details.get("args"),
                tool_result={"summary": details.get("result_summary", "")},
                decision_summary=details.get("response_summary") or details.get("decision"),
                confidence=details.get("confidence"),
            )

    def get_active_recordings(self) -> List[str]:
        """Return list of currently recording incident IDs."""
        return list(_active_recordings.keys())

    def is_recording(self, incident_id: str) -> bool:
        return incident_id in _active_recordings

    async def list_incidents(
        self,
        status: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """List recorded incidents."""
        from backend.models.advanced_models import IncidentSnapshot

        async with async_session() as session:
            query = select(IncidentSnapshot).order_by(desc(IncidentSnapshot.created_at)).limit(limit)
            if status:
                query = query.where(IncidentSnapshot.status == status)
            result = await session.execute(query)
            return [self._fmt_snapshot(s) for s in result.scalars().all()]

    async def get_incident(self, incident_id: str) -> Optional[Dict[str, Any]]:
        """Get full incident metadata."""
        from backend.models.advanced_models import IncidentSnapshot
        import uuid

        async with async_session() as session:
            snapshot = (await session.execute(
                select(IncidentSnapshot).where(IncidentSnapshot.id == uuid.UUID(incident_id))
            )).scalar_one_or_none()
            if not snapshot:
                return None
            return self._fmt_snapshot(snapshot)

    async def get_frames(
        self,
        incident_id: str,
        start_offset: float = 0.0,
        duration: float = 60.0,
        camera_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Get frames for a time range within an incident."""
        from backend.models.advanced_models import IncidentSnapshot, IncidentFrame
        import uuid

        async with async_session() as session:
            snapshot = (await session.execute(
                select(IncidentSnapshot).where(IncidentSnapshot.id == uuid.UUID(incident_id))
            )).scalar_one_or_none()
            if not snapshot:
                return []

            start = snapshot.start_time + timedelta(seconds=start_offset)
            end = start + timedelta(seconds=duration)

            query = (
                select(IncidentFrame)
                .where(
                    IncidentFrame.incident_id == uuid.UUID(incident_id),
                    IncidentFrame.timestamp.between(start, end),
                )
                .order_by(IncidentFrame.sequence_num)
            )
            if camera_id:
                query = query.where(IncidentFrame.camera_id == uuid.UUID(camera_id))

            result = await session.execute(query)
            return [self._fmt_frame(f) for f in result.scalars().all()]

    async def get_agent_actions(
        self,
        incident_id: str,
        start_offset: float = 0.0,
        duration: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """Get agent actions for a time range within an incident."""
        from backend.models.advanced_models import IncidentSnapshot, IncidentAgentAction
        import uuid

        async with async_session() as session:
            snapshot = (await session.execute(
                select(IncidentSnapshot).where(IncidentSnapshot.id == uuid.UUID(incident_id))
            )).scalar_one_or_none()
            if not snapshot:
                return []

            start = snapshot.start_time + timedelta(seconds=start_offset)
            conditions = [
                IncidentAgentAction.incident_id == uuid.UUID(incident_id),
                IncidentAgentAction.timestamp >= start,
            ]
            if duration:
                end = start + timedelta(seconds=duration)
                conditions.append(IncidentAgentAction.timestamp <= end)

            result = await session.execute(
                select(IncidentAgentAction)
                .where(and_(*conditions))
                .order_by(IncidentAgentAction.timestamp)
            )
            return [self._fmt_action(a) for a in result.scalars().all()]

    async def simulate_with_thresholds(
        self,
        incident_id: str,
        threshold_overrides: Dict[str, float],
    ) -> Dict[str, Any]:
        """What-if simulation: replay detections with modified thresholds.

        Compares what alerts WOULD have been generated vs what actually happened.
        """
        from backend.models.advanced_models import IncidentSnapshot, IncidentFrame
        import uuid

        async with async_session() as session:
            snapshot = (await session.execute(
                select(IncidentSnapshot).where(IncidentSnapshot.id == uuid.UUID(incident_id))
            )).scalar_one_or_none()
            if not snapshot:
                return {"error": "Incident not found"}

            # Get all frames with detections
            frames = (await session.execute(
                select(IncidentFrame)
                .where(IncidentFrame.incident_id == uuid.UUID(incident_id))
                .order_by(IncidentFrame.sequence_num)
            )).scalars().all()

        # Simulate with new thresholds
        anomaly_threshold = threshold_overrides.get("anomaly_threshold", 0.5)
        crowd_threshold = threshold_overrides.get("crowd_threshold", 10)
        dwell_threshold = threshold_overrides.get("dwell_threshold", 300)

        simulated_alerts = []
        for frame in frames:
            detections = frame.detections or {}
            det_list = detections.get("detections", [])

            # Check crowd threshold
            person_count = sum(1 for d in det_list if d.get("class") == "person")
            if person_count > crowd_threshold:
                simulated_alerts.append({
                    "type": "crowd_threshold",
                    "timestamp": frame.timestamp.isoformat() if frame.timestamp else None,
                    "details": f"{person_count} persons detected (threshold: {crowd_threshold})",
                    "severity": "high" if person_count > crowd_threshold * 1.5 else "medium",
                })

            # Check anomaly scores
            analysis = frame.gemini_analysis or {}
            threat_level = analysis.get("threat_level", 0)
            if isinstance(threat_level, (int, float)) and threat_level > anomaly_threshold:
                simulated_alerts.append({
                    "type": "anomaly_threshold",
                    "timestamp": frame.timestamp.isoformat() if frame.timestamp else None,
                    "details": f"Threat level {threat_level:.2f} (threshold: {anomaly_threshold})",
                    "severity": "critical" if threat_level > 0.8 else "high",
                })

        # Compare with actual actions
        actual_actions = await self.get_agent_actions(incident_id)
        actual_alerts = [a for a in actual_actions if a["action_type"] in ("alert", "tool_call")]

        return {
            "incident_id": incident_id,
            "threshold_overrides": threshold_overrides,
            "simulated_alerts": simulated_alerts,
            "simulated_alert_count": len(simulated_alerts),
            "actual_alert_count": len(actual_alerts),
            "diff": len(simulated_alerts) - len(actual_alerts),
            "total_frames_analyzed": len(frames),
        }

    def _fmt_snapshot(self, s) -> Dict[str, Any]:
        return {
            "id": str(s.id),
            "title": s.title,
            "description": s.description,
            "start_time": s.start_time.isoformat() if s.start_time else None,
            "end_time": s.end_time.isoformat() if s.end_time else None,
            "camera_ids": s.camera_ids or [],
            "zone_ids": s.zone_ids or [],
            "trigger_alert_id": str(s.trigger_alert_id) if s.trigger_alert_id else None,
            "trigger_case_id": str(s.trigger_case_id) if s.trigger_case_id else None,
            "status": s.status,
            "total_frames": s.total_frames,
            "total_agent_actions": s.total_agent_actions,
            "metadata": s.metadata_,
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }

    def _fmt_frame(self, f) -> Dict[str, Any]:
        return {
            "id": str(f.id),
            "incident_id": str(f.incident_id),
            "camera_id": str(f.camera_id),
            "sequence_num": f.sequence_num,
            "timestamp": f.timestamp.isoformat() if f.timestamp else None,
            "frame_path": f.frame_path,
            "detections": f.detections,
            "gemini_analysis": f.gemini_analysis,
            "zone_occupancy": f.zone_occupancy,
        }

    def _fmt_action(self, a) -> Dict[str, Any]:
        return {
            "id": str(a.id),
            "incident_id": str(a.incident_id),
            "timestamp": a.timestamp.isoformat() if a.timestamp else None,
            "agent_name": a.agent_name,
            "action_type": a.action_type,
            "tool_name": a.tool_name,
            "tool_args": a.tool_args,
            "tool_result": a.tool_result,
            "decision_summary": a.decision_summary,
            "confidence": a.confidence,
        }


# Singleton
incident_recorder = IncidentRecorder()
