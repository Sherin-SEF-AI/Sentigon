"""Ghost Tracer Agent — cross-camera entity path reconstruction.

Listens for ReID matches and gait matches on CH_CORRELATION, queries
Qdrant entity_appearances for all sightings, and builds chronological
cross-camera movement paths for tracked entities.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_CORRELATION, CH_CORTEX, CH_INVESTIGATION, CH_PERCEPTIONS,
)

logger = logging.getLogger(__name__)


class GhostTracerAgent(BaseAgent):
    """Reasoning-tier agent for cross-camera entity tracking.

    On each cycle:
    1. Checks inbox for ReID/gait match events from CH_CORRELATION.
    2. For each match, queries Qdrant entity_appearances collection
       for all sightings of the matched entity.
    3. Builds a chronological cross-camera movement path.
    4. Sends the path to Gemini for behavioral analysis.
    5. Publishes ghost_trace events to CH_INVESTIGATION.
    """

    def __init__(self) -> None:
        super().__init__(
            name="ghost_tracer",
            role="Cross-Camera Entity Path Reconstruction",
            description=(
                "Reconstructs entity movement paths across multiple cameras "
                "using ReID matches, gait analysis, and vector search. "
                "Identifies suspicious cross-camera movement patterns like "
                "repeated visits, surveillance routes, and facility probing."
            ),
            tier="reasoning",
            model_name="deepseek-v3.1:671b-cloud",
            tool_names=[
                "search_entity_appearances",
                "get_tracking_trajectory",
                "get_event_history",
                "get_alert_history",
                "create_alert",
                "store_observation",
            ],
            subscriptions=[CH_CORTEX, CH_CORRELATION],
            cycle_interval=8.0,
            token_budget_per_cycle=15000,
        )
        self._pending_traces: list[dict] = []
        self._completed_traces: dict[str, dict] = {}  # entity_key -> trace result
        self._trace_count = 0

    async def think(self, context: dict) -> dict:
        """Process correlation events and build entity paths."""
        inbox = context.get("inbox_messages", [])

        # Collect ReID and gait match events
        for msg in inbox:
            msg_type = msg.get("type", "")
            if msg_type in ("reid_match", "gait_match", "appearance_match"):
                self._pending_traces.append(msg)
            elif msg_type == "force_trace":
                # Cortex directive to trace a specific entity
                self._pending_traces.append(msg)

        if not self._pending_traces:
            return {"status": "idle", "reason": "no_pending_traces"}

        # Process up to 3 traces per cycle
        batch = self._pending_traces[:3]
        self._pending_traces = self._pending_traces[3:]

        results = []
        for trace_event in batch:
            try:
                result = await self._trace_entity(trace_event)
                results.append(result)
            except Exception as exc:
                logger.error("Ghost trace failed: %s", exc)
                results.append({"status": "error", "error": str(exc)})

        self._trace_count += len(results)
        traces_with_paths = sum(1 for r in results if r.get("path_length", 0) > 1)

        return {
            "status": "processed",
            "traces_attempted": len(batch),
            "traces_with_paths": traces_with_paths,
            "pending_remaining": len(self._pending_traces),
            "total_traces": self._trace_count,
        }

    async def _trace_entity(self, event: dict) -> dict:
        """Build a cross-camera path for a matched entity."""
        msg_type = event.get("type", "")

        # Extract entity identifiers
        source_camera = event.get("source_camera", event.get("camera_id", ""))
        source_track_id = event.get("source_track_id", event.get("track_id", ""))
        matched_camera = event.get("matched_camera", "")
        matched_track_id = event.get("matched_track_id", "")
        match_score = event.get("match_score", event.get("score", 0))
        entity_description = event.get("description", event.get("gait_description", ""))

        entity_key = f"{source_camera}:{source_track_id}"

        # Skip if recently traced
        if entity_key in self._completed_traces:
            return {"status": "skip", "reason": "recently_traced", "entity": entity_key}

        # Step 1: Search for all appearances in Qdrant
        appearances = []
        try:
            from backend.services.vector_store import vector_store

            # Search by entity description
            search_query = entity_description or f"person track {source_track_id}"
            search_results = await vector_store.search(
                search_query, top_k=20
            )
            for r in search_results:
                payload = r.payload if hasattr(r, "payload") else r.get("payload", {})
                score = r.score if hasattr(r, "score") else r.get("score", 0)
                if score > 0.5:  # Only high-confidence matches
                    appearances.append({
                        "camera_id": payload.get("camera_id", ""),
                        "timestamp": payload.get("timestamp", ""),
                        "description": payload.get("description", ""),
                        "event_type": payload.get("event_type", ""),
                        "score": round(score, 3),
                    })
        except Exception as exc:
            logger.warning("Qdrant search failed for ghost trace: %s", exc)

        # Step 2: Get trajectory data for source and matched tracks
        trajectory_data = []
        for cam_id, tid in [(source_camera, source_track_id), (matched_camera, matched_track_id)]:
            if not cam_id or not tid:
                continue
            try:
                from backend.agents.agent_tools import get_tracking_trajectory
                traj = await get_tracking_trajectory(str(tid), cam_id)
                if traj.get("success"):
                    trajectory_data.append({
                        "camera_id": cam_id,
                        "track_id": tid,
                        "dwell_time": traj.get("dwell_time", 0),
                        "trajectory_points": len(traj.get("trajectory", [])),
                        "is_stationary": traj.get("is_stationary", False),
                    })
            except Exception:
                pass

        # Step 3: Build chronological path
        path_points = []

        # Add known sightings
        if source_camera and source_track_id:
            path_points.append({
                "camera_id": source_camera,
                "track_id": source_track_id,
                "timestamp": event.get("timestamp", datetime.now(timezone.utc).isoformat()),
                "type": "source",
            })
        if matched_camera and matched_track_id:
            path_points.append({
                "camera_id": matched_camera,
                "track_id": matched_track_id,
                "timestamp": event.get("matched_timestamp", event.get("timestamp", "")),
                "type": "matched",
            })

        # Add Qdrant appearances
        for app in appearances:
            path_points.append({
                "camera_id": app["camera_id"],
                "timestamp": app["timestamp"],
                "type": "appearance",
                "score": app["score"],
                "description": app["description"][:100],
            })

        # Sort by timestamp
        def sort_key(p):
            ts = p.get("timestamp", "")
            if isinstance(ts, str) and ts:
                try:
                    return datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass
            return datetime.min.replace(tzinfo=timezone.utc)

        path_points.sort(key=sort_key)

        # Deduplicate by camera
        unique_cameras = []
        seen_cameras = set()
        for point in path_points:
            cam = point.get("camera_id", "")
            if cam and cam not in seen_cameras:
                unique_cameras.append(point)
                seen_cameras.add(cam)

        # Step 4: Analyze path with Gemini if multiple cameras
        analysis = None
        if len(unique_cameras) >= 2:
            path_description = "\n".join(
                f"  {i+1}. Camera {p['camera_id']} at {p.get('timestamp', 'unknown')} "
                f"({p.get('type', 'unknown')})"
                for i, p in enumerate(unique_cameras)
            )

            prompt = (
                f"GHOST TRACE — Cross-Camera Entity Path Analysis\n\n"
                f"Entity movement path ({len(unique_cameras)} cameras):\n"
                f"{path_description}\n\n"
                f"Match type: {msg_type} (score: {match_score:.3f})\n"
                f"Entity description: {entity_description[:200] if entity_description else 'unknown'}\n\n"
                f"Analyze this cross-camera movement pattern:\n"
                f"1. Is the movement pattern normal or suspicious?\n"
                f"2. Does it suggest surveillance, probing, or reconnaissance?\n"
                f"3. Are there repeated visits or looping patterns?\n"
                f"4. Threat assessment: NONE, LOW, MEDIUM, HIGH\n\n"
                f"Respond with structured JSON:\n"
                f"{{\"movement_assessment\": \"<normal|suspicious|threatening>\", "
                f"\"threat_level\": \"<NONE|LOW|MEDIUM|HIGH>\", "
                f"\"pattern_type\": \"<none|surveillance|probing|looping|reconnaissance>\", "
                f"\"reasoning\": \"<explanation>\"}}\n\n"
                f"Example output:\n"
                f"{{\"movement_assessment\": \"suspicious\", \"threat_level\": \"MEDIUM\", "
                f"\"pattern_type\": \"surveillance\", \"reasoning\": \"Entity visited 4 cameras along the perimeter in sequence over 12 minutes, consistent with facility perimeter mapping. No legitimate reason for this route.\"}}\n\n"
                f"Example output:\n"
                f"{{\"movement_assessment\": \"normal\", \"threat_level\": \"NONE\", "
                f"\"pattern_type\": \"none\", \"reasoning\": \"Entity moved from parking entrance to lobby to elevator — consistent with normal visitor arrival pattern.\"}}"
            )

            ai_result = await self.execute_tool_loop(prompt)
            analysis = ai_result.get("response", "")

        # Step 5: Publish ghost trace
        trace_result = {
            "entity_key": entity_key,
            "match_type": msg_type,
            "match_score": match_score,
            "path": unique_cameras,
            "path_length": len(unique_cameras),
            "total_appearances": len(appearances),
            "trajectory_data": trajectory_data,
            "analysis": analysis[:500] if analysis else None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # Publish to investigation channel
        await self.send_message(CH_INVESTIGATION, {
            "type": "ghost_trace",
            **trace_result,
        })

        # Store in memory
        self._completed_traces[entity_key] = trace_result

        # Log the trace
        await self.log_action("ghost_trace", {
            "entity_key": entity_key,
            "path_length": len(unique_cameras),
            "match_type": msg_type,
            "match_score": match_score,
            "decision": f"Ghost trace: {len(unique_cameras)} cameras, {len(appearances)} appearances",
        })

        # Store observation for long-term learning
        if len(unique_cameras) >= 3:
            cameras_str = " -> ".join(p["camera_id"][:8] for p in unique_cameras)
            await self.learn(
                f"Cross-camera path detected: {cameras_str} "
                f"(match: {msg_type}, score: {match_score:.2f})",
                category="cross_camera_path",
            )

        return {
            "status": "traced",
            "entity_key": entity_key,
            "path_length": len(unique_cameras),
            "total_appearances": len(appearances),
        }
