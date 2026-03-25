"""AI Incident Reconstruction -- generates comprehensive narrative from incident data."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


class IncidentReconstructor:
    """Reconstructs a full incident narrative from recorded frames, detections,
    and agent actions using AI-powered analysis.

    Combines data from the incident recorder with Gemini forensic analysis
    and causal reasoning to produce a structured, court-ready reconstruction.
    """

    def __init__(self) -> None:
        self._reconstruction_count = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def reconstruct(self, incident_id: str) -> Dict[str, Any]:
        """Build a comprehensive incident reconstruction.

        Steps:
          1. Load incident metadata
          2. Load all frames and agent actions
          3. Sample key frames around agent action timestamps
          4. Group frames by camera
          5. Build event data list
          6. Generate AI narrative via Gemini forensics
          7. Attempt causal chain reconstruction
          8. Compile key moments, entity summary, and risk assessment
        """
        try:
            self._reconstruction_count += 1
            logger.info(
                "incident_reconstruction.start",
                extra={"incident_id": incident_id, "count": self._reconstruction_count},
            )

            # 1. Load incident metadata -----------------------------------
            from backend.services.incident_recorder import incident_recorder

            incident = await incident_recorder.get_incident(incident_id)
            if not incident:
                logger.warning("incident_reconstruction.not_found id=%s", incident_id)
                return {"error": f"Incident {incident_id} not found"}

            start_time_str = incident.get("start_time")
            start_time: Optional[datetime] = None
            if start_time_str:
                try:
                    start_time = datetime.fromisoformat(start_time_str)
                except (ValueError, TypeError):
                    start_time = None

            # 2. Load ALL frames and agent actions -------------------------
            all_frames = await incident_recorder.get_frames(
                incident_id, start_offset=0, duration=99999,
            )
            all_actions = await incident_recorder.get_agent_actions(incident_id)

            logger.info(
                "incident_reconstruction.data_loaded",
                extra={
                    "incident_id": incident_id,
                    "frames": len(all_frames),
                    "actions": len(all_actions),
                },
            )

            # 3. Sample key frames -----------------------------------------
            key_frame_indices = self._select_key_frames(
                all_frames, all_actions, start_time,
            )
            key_frames = [all_frames[i] for i in key_frame_indices if i < len(all_frames)]

            # 4. Group frames by camera ------------------------------------
            frames_by_camera: Dict[str, List[Dict[str, Any]]] = {}
            for frame in all_frames:
                cam = frame.get("camera_id", "unknown")
                frames_by_camera.setdefault(cam, []).append(frame)

            # 5. Build event_data list for AI summary ----------------------
            event_data = self._build_event_data(all_frames)

            # 6. Generate AI narrative via Gemini forensics -----------------
            ai_summary = await self._generate_narrative(event_data)

            # 7. Attempt causal chain reconstruction -----------------------
            causal_chain = await self._try_causal_chain(incident)

            # 8. Compile structured output ---------------------------------
            key_moments = self._build_key_moments(key_frames, all_actions, start_time)
            entity_summary = self._build_entity_summary(all_frames)

            threat_count = sum(
                1 for m in key_moments if m.get("severity") in ("high", "critical")
            )
            overall_risk = "critical" if threat_count > 3 else (
                "high" if threat_count > 1 else (
                    "medium" if threat_count > 0 else "low"
                )
            )

            result = {
                "incident_id": incident_id,
                "narrative": ai_summary.get("incident_summary", ai_summary.get("raw_response", "")),
                "key_moments": key_moments,
                "entity_summary": entity_summary,
                "causal_chain": causal_chain,
                "risk_assessment": {
                    "overall_risk": overall_risk,
                    "threat_count": threat_count,
                    "entity_count": len(entity_summary),
                },
                "recommendations": ai_summary.get("recommended_actions", []),
                "ai_provider": ai_summary.get("ai_provider", "unknown"),
            }

            logger.info(
                "incident_reconstruction.complete",
                extra={
                    "incident_id": incident_id,
                    "key_moments": len(key_moments),
                    "entities": len(entity_summary),
                    "ai_provider": result["ai_provider"],
                },
            )
            return result

        except Exception as exc:
            logger.exception("incident_reconstruction.error id=%s: %s", incident_id, exc)
            return {
                "incident_id": incident_id,
                "error": str(exc),
                "narrative": "",
                "key_moments": [],
                "entity_summary": [],
                "causal_chain": [],
                "risk_assessment": {"overall_risk": "unknown", "threat_count": 0, "entity_count": 0},
                "recommendations": [],
                "ai_provider": "none",
            }

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _select_key_frames(
        self,
        frames: List[Dict[str, Any]],
        actions: List[Dict[str, Any]],
        start_time: Optional[datetime],
    ) -> List[int]:
        """Return indices of key frames: first, last, and those closest to
        each agent-action timestamp."""
        if not frames:
            return []

        indices: Set[int] = set()
        # Always include first and last
        indices.add(0)
        indices.add(len(frames) - 1)

        if not actions or not start_time:
            return sorted(indices)

        # Pre-compute frame offsets from incident start_time
        frame_offsets: List[float] = []
        for f in frames:
            ts_str = f.get("timestamp")
            if ts_str:
                try:
                    ts = datetime.fromisoformat(ts_str)
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    if start_time.tzinfo is None:
                        start_time = start_time.replace(tzinfo=timezone.utc)
                    frame_offsets.append((ts - start_time).total_seconds())
                except (ValueError, TypeError):
                    frame_offsets.append(0.0)
            else:
                frame_offsets.append(0.0)

        # For each action, find the frame with the closest offset
        for action in actions:
            action_ts_str = action.get("timestamp")
            if not action_ts_str:
                continue
            try:
                action_ts = datetime.fromisoformat(action_ts_str)
                if action_ts.tzinfo is None:
                    action_ts = action_ts.replace(tzinfo=timezone.utc)
                action_offset = (action_ts - start_time).total_seconds()
            except (ValueError, TypeError):
                continue

            best_idx = 0
            best_diff = abs(frame_offsets[0] - action_offset) if frame_offsets else float("inf")
            for i, fo in enumerate(frame_offsets):
                diff = abs(fo - action_offset)
                if diff < best_diff:
                    best_diff = diff
                    best_idx = i
            indices.add(best_idx)

        return sorted(indices)

    def _build_event_data(self, frames: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Build a summarised event list from frames for the AI prompt."""
        events: List[Dict[str, Any]] = []
        for frame in frames:
            detections = frame.get("detections") or {}
            det_list = detections.get("detections", [])
            det_summary = ", ".join(
                f"{d.get('class', 'object')} ({d.get('confidence', 0):.0%})"
                for d in det_list[:10]
            ) if det_list else "no detections"

            analysis = frame.get("gemini_analysis") or {}
            analysis_summary = analysis.get("summary", analysis.get("forensic_summary", ""))

            events.append({
                "timestamp": frame.get("timestamp"),
                "camera_id": frame.get("camera_id", "unknown"),
                "detections": det_summary,
                "analysis": analysis_summary[:300] if analysis_summary else "",
            })
        return events

    async def _generate_narrative(
        self, event_data: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Call Gemini forensics to generate an incident summary narrative."""
        try:
            from backend.services.gemini_forensics import gemini_forensics

            result = await gemini_forensics.generate_incident_summary(
                event_data, query="Reconstruct this incident in detail",
            )
            return result
        except Exception as exc:
            logger.warning("incident_reconstruction.narrative_failed: %s", exc)
            return {
                "incident_summary": "AI narrative generation failed.",
                "recommended_actions": [],
                "ai_provider": "none",
            }

    async def _try_causal_chain(self, incident: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Attempt causal-chain reconstruction; returns empty list on failure."""
        try:
            from backend.services.causal_reasoning import causal_engine

            alert_id = incident.get("trigger_alert_id")
            if not alert_id:
                logger.debug("incident_reconstruction.no_alert_id — skipping causal chain")
                return []

            chain = await causal_engine.reconstruct_chain(
                alert_id=alert_id,
                threat_data={
                    "incident_id": incident.get("id"),
                    "title": incident.get("title", ""),
                    "cameras": incident.get("camera_ids", []),
                },
                time_window_minutes=30,
            )

            # CausalChain is a dataclass; serialise it
            if hasattr(chain, "links"):
                return [
                    {
                        "event": getattr(link, "event", str(link)),
                        "timestamp": getattr(link, "timestamp", None),
                        "camera_id": getattr(link, "camera_id", None),
                        "confidence": getattr(link, "confidence", None),
                        "evidence": getattr(link, "evidence", None),
                    }
                    for link in chain.links
                ]
            # Fallback: if chain is already a dict or list
            if isinstance(chain, list):
                return chain
            if isinstance(chain, dict):
                return chain.get("links", [chain])
            return []

        except Exception as exc:
            logger.debug("incident_reconstruction.causal_chain_skipped: %s", exc)
            return []

    def _build_key_moments(
        self,
        key_frames: List[Dict[str, Any]],
        actions: List[Dict[str, Any]],
        start_time: Optional[datetime],
    ) -> List[Dict[str, Any]]:
        """Compile a list of key moments from sampled frames and agent actions."""
        moments: List[Dict[str, Any]] = []

        # Build a lookup: action timestamps for quick matching
        action_map: Dict[str, Dict[str, Any]] = {}
        for action in actions:
            ts = action.get("timestamp")
            if ts:
                action_map[ts] = action

        for frame in key_frames:
            frame_ts = frame.get("timestamp")
            offset = 0.0
            if frame_ts and start_time:
                try:
                    ts = datetime.fromisoformat(frame_ts)
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    if start_time.tzinfo is None:
                        start_time = start_time.replace(tzinfo=timezone.utc)
                    offset = (ts - start_time).total_seconds()
                except (ValueError, TypeError):
                    pass

            # Build description from detections + analysis
            detections = frame.get("detections") or {}
            det_list = detections.get("detections", [])
            analysis = frame.get("gemini_analysis") or {}
            description = analysis.get("summary", analysis.get("forensic_summary", ""))
            if not description and det_list:
                classes = [d.get("class", "object") for d in det_list[:5]]
                description = f"Detected: {', '.join(classes)}"

            # Severity from analysis or detection count
            severity = analysis.get("severity", "low")
            if isinstance(analysis.get("risk_assessment"), dict):
                risk_score = analysis["risk_assessment"].get("risk_score", 0)
                if isinstance(risk_score, (int, float)):
                    if risk_score > 70:
                        severity = "critical"
                    elif risk_score > 50:
                        severity = "high"
                    elif risk_score > 30:
                        severity = "medium"

            moments.append({
                "offset": round(offset, 2),
                "camera_id": frame.get("camera_id", "unknown"),
                "description": description[:500] if description else "Frame captured",
                "frame_url": frame.get("frame_path", ""),
                "severity": severity,
            })

        return moments

    def _build_entity_summary(
        self, frames: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Extract unique entities (track IDs) across all frame detections."""
        entities: Dict[str, Dict[str, Any]] = {}

        for frame in frames:
            detections = frame.get("detections") or {}
            det_list = detections.get("detections", [])
            cam = frame.get("camera_id", "unknown")
            ts = frame.get("timestamp")

            for det in det_list:
                track_id = det.get("track_id") or det.get("id")
                if not track_id:
                    continue
                track_id = str(track_id)

                if track_id not in entities:
                    entities[track_id] = {
                        "entity_id": track_id,
                        "description": det.get("class", "object"),
                        "first_seen": ts,
                        "last_seen": ts,
                        "cameras": set(),
                        "risk_level": "low",
                        "appearances": 0,
                    }

                ent = entities[track_id]
                ent["last_seen"] = ts
                ent["cameras"].add(cam)
                ent["appearances"] += 1

                # Elevate risk if entity seen on multiple cameras
                cam_count = len(ent["cameras"])
                if cam_count >= 3:
                    ent["risk_level"] = "high"
                elif cam_count >= 2:
                    ent["risk_level"] = "medium"

        # Convert sets to lists for JSON serialisation
        result: List[Dict[str, Any]] = []
        for ent in entities.values():
            result.append({
                "entity_id": ent["entity_id"],
                "description": ent["description"],
                "first_seen": ent["first_seen"],
                "last_seen": ent["last_seen"],
                "cameras": sorted(ent["cameras"]),
                "risk_level": ent["risk_level"],
            })

        return result


# Singleton
incident_reconstructor = IncidentReconstructor()
