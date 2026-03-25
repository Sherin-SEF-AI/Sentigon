"""Correlator Agent — cross-camera entity tracking and event correlation.

Monitors perception events for notable entities, searches for their
appearances across other cameras, builds movement tracks, and detects
suspicious cross-camera patterns such as repeated passes or coordinated
movement.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_PERCEPTIONS,
    CH_THREATS,
    CH_CORRELATION,
)
from backend.services.sensory_fusion import sensory_fusion_engine, SensoryEvent

logger = logging.getLogger(__name__)

# ── Correlation analysis prompt ──────────────────────────────────────
_CORRELATION_PROMPT = """\
You are a cross-camera event correlator in an autonomous physical security \
system. An entity of interest has been observed and you need to determine \
if it appears on other cameras.

**Entity observed:**
{entity_details}

**Cross-camera search results:**
{search_results}

**Known entity positions (from memory):**
{entity_map}

Analyse the cross-camera data. Use the available tools to gather more \
context if needed — check event history, get tracking trajectories, \
search for similar entities.

Provide your correlation analysis as structured JSON:
{{
  "entity_description": "<description of the tracked entity>",
  "appearances": [
    {{
      "camera_id": "<camera>",
      "timestamp": "<ISO timestamp>",
      "confidence": <0.0-1.0>,
      "activity": "<what entity was doing>"
    }}
  ],
  "movement_track": "<camera A at time1 -> camera B at time2 -> ...>",
  "pattern_detected": "<none|repeated_pass|restricted_area|coordinated|loitering>",
  "pattern_description": "<description of suspicious pattern if any>",
  "risk_level": "<low|medium|high>",
  "total_cameras_seen": <int>,
  "dwell_summary": "<summary of time spent at each location>"
}}

Example:
{{"entity_description": "Male in red jacket", "appearances": [{{"camera_id": "cam-01", "timestamp": "2026-02-17T10:00:00Z", "confidence": 0.85, "activity": "walking east"}}, {{"camera_id": "cam-03", "timestamp": "2026-02-17T10:05:00Z", "confidence": 0.78, "activity": "standing near entrance"}}], "movement_track": "cam-01 at 10:00 -> cam-03 at 10:05", "pattern_detected": "none", "pattern_description": "", "risk_level": "low", "total_cameras_seen": 2, "dwell_summary": "30s at entrance, 45s at lobby"}}
"""

_PATTERN_PROMPT = """\
You are analysing movement patterns across a camera network.

**Entity tracking data:**
{tracking_data}

**Historical patterns from memory:**
{historical_patterns}

Detect the following pattern types:
1. **Repeated passes** — entity seen at the same camera more than twice
2. **Restricted area visits** — entity accessing areas with limited access
3. **Coordinated movement** — multiple entities moving together across cameras
4. **Loitering** — entity dwelling at a location for abnormally long
5. **Counter-surveillance** — entity appearing to survey camera positions

Provide your pattern analysis as JSON:
{{
  "patterns_detected": [
    {{
      "type": "<pattern type>",
      "description": "<what was observed>",
      "entities_involved": ["<entity>", ...],
      "cameras_involved": ["<camera_id>", ...],
      "risk_level": "<low|medium|high|critical>",
      "confidence": <0.0-1.0>
    }}
  ],
  "summary": "<overall assessment>"
}}
"""


class CorrelatorAgent(BaseAgent):
    """Cross-camera event correlator agent.

    Tracks entities across the camera network by searching for visual
    and semantic matches when notable entities are detected. Maintains
    an entity position map in short-term memory and detects suspicious
    cross-camera patterns.
    """

    def __init__(self) -> None:
        super().__init__(
            name="correlator",
            role="Cross-Camera Event Correlator",
            description=(
                "Tracks entities across the camera network by correlating "
                "detection events between cameras. Maintains a real-time "
                "entity position map and detects suspicious movement "
                "patterns including repeated passes, restricted area visits, "
                "and coordinated movement."
            ),
            tier="reasoning",
            model_name="deepseek-v3.1:671b-cloud",
            tool_names=[
                "get_current_detections",
                "search_entity_appearances",
                "similarity_search",
                "get_tracking_trajectory",
                "get_event_history",
                "semantic_search_video",
                "store_observation",
            ],
            subscriptions=[CH_PERCEPTIONS, CH_THREATS],
            cycle_interval=5.0,
            token_budget_per_cycle=25000,
        )
        # In-memory entity position map (also synced to Redis short-term memory)
        self._entity_map: dict[str, list[dict]] = {}
        # Pattern detection every Nth cycle
        self._pattern_check_interval = 10

    # ── Core reasoning ────────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main reasoning loop executed every cycle.

        1. Extract notable entities from inbox perception events.
        2. Search for cross-camera appearances of each entity.
        3. Update entity position map.
        4. Detect suspicious cross-camera patterns.
        5. Publish correlations to CH_CORRELATION.
        """
        inbox = context.get("inbox_messages", [])
        cycle = context.get("cycle", 0)
        correlations_found = 0
        entities_tracked = 0

        # ── 1. Extract notable entities from perception events ────────
        entity_observations = self._extract_entities(inbox)

        if entity_observations:
            logger.info(
                "Correlator processing %d entity observations (cycle %d)",
                len(entity_observations), cycle,
            )

        # ── 2. Search for cross-camera appearances ────────────────────
        for entity in entity_observations:
            try:
                correlation = await self._correlate_entity(entity, context)
                if correlation and correlation.get("total_cameras_seen", 0) > 1:
                    correlations_found += 1

                    # Publish correlation finding
                    await self.send_message(CH_CORRELATION, {
                        "type": "cross_camera_correlation",
                        "entity": entity.get("description", "unknown"),
                        "source_camera": entity.get("camera_id"),
                        "correlation": correlation,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

                entities_tracked += 1
            except Exception as exc:
                logger.error(
                    "Correlation failed for entity on camera %s: %s",
                    entity.get("camera_id"), exc,
                )

        # ── 3. Sensory fusion: cross-modal verification ────────────────
        audio_events = self._extract_audio_events(inbox)
        fused_count = 0
        for audio_ev in audio_events:
            try:
                fused = sensory_fusion_engine.verify_cross_modal(audio_ev)
                if fused.verdict in ("confirmed", "likely"):
                    fused_count += 1
                    await self.send_message(CH_CORRELATION, {
                        "type": "fused_event",
                        "verdict": fused.verdict,
                        "confidence": fused.confidence,
                        "audio_type": fused.audio_event.event_type if fused.audio_event else None,
                        "visual_matches": len(fused.visual_events),
                        "description": fused.description,
                        "fusion_rule": fused.fusion_rule,
                        "camera_id": audio_ev.camera_id,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

                    # Create alert for confirmed multi-modal threats
                    if fused.verdict == "confirmed" and fused.confidence > 0.8:
                        from backend.agents.agent_tools import TOOL_REGISTRY
                        await TOOL_REGISTRY["create_alert"]["fn"](
                            camera_id=audio_ev.camera_id,
                            severity="critical",
                            threat_type=f"fused_{audio_ev.event_type}",
                            description=fused.description,
                            confidence=fused.confidence,
                        )
            except Exception as exc:
                logger.debug("Sensory fusion error: %s", exc)

        # ── 4. Update entity map in short-term memory ─────────────────
        await self._sync_entity_map()

        # ── 5. Periodic pattern detection ─────────────────────────────
        if cycle > 0 and cycle % self._pattern_check_interval == 0:
            try:
                await self._detect_patterns(context)
            except Exception as exc:
                logger.error("Pattern detection failed: %s", exc)

        return {
            "entities_processed": entities_tracked,
            "correlations_found": correlations_found,
            "fused_events": fused_count,
            "entity_map_size": len(self._entity_map),
        }

    # ── Entity extraction ─────────────────────────────────────────────

    def _extract_entities(self, inbox: list[dict]) -> list[dict]:
        """Extract trackable entities from perception events.

        Looks for person detections, vehicle detections, and entities
        flagged by the threat analyst or anomaly detector.
        """
        entities = []

        for msg in inbox:
            channel = msg.get("_channel", "")
            msg_type = msg.get("type", "")
            camera_id = msg.get("camera_id")

            if not camera_id:
                continue

            # From perception events — extract individual detections
            if channel == CH_PERCEPTIONS or msg_type in (
                "perception", "detection", "scene_analysis",
            ):
                detections = msg.get("detections", [])
                for det in detections:
                    det_class = det.get("class", "")
                    track_id = det.get("track_id")
                    confidence = det.get("confidence", 0)

                    # Only track entities with high enough confidence
                    if confidence < 0.5:
                        continue

                    # Focus on persons and vehicles for cross-camera tracking
                    if det_class in ("person", "car", "truck", "motorcycle", "bicycle"):
                        description = self._build_entity_description(det, msg)
                        entities.append({
                            "camera_id": camera_id,
                            "track_id": track_id,
                            "class": det_class,
                            "confidence": confidence,
                            "description": description,
                            "dwell_time": det.get("dwell_time", 0),
                            "is_stationary": det.get("is_stationary", False),
                            "bbox": det.get("bbox"),
                            "timestamp": msg.get("timestamp", datetime.now(timezone.utc).isoformat()),
                        })

            # From threat assessments — track flagged entities
            elif channel == CH_THREATS and msg_type == "threat_assessment":
                if float(msg.get("threat_probability", 0)) > 50:
                    entities.append({
                        "camera_id": camera_id,
                        "track_id": None,
                        "class": "unknown",
                        "confidence": msg.get("confidence", 0.5),
                        "description": msg.get("threat_explanation", "Flagged entity"),
                        "dwell_time": 0,
                        "is_stationary": False,
                        "timestamp": msg.get("timestamp", datetime.now(timezone.utc).isoformat()),
                        "_priority": "high",
                    })

        # Deduplicate by camera+track_id and limit to top 5
        seen = set()
        unique = []
        for e in entities:
            key = f"{e['camera_id']}:{e.get('track_id', 'none')}"
            if key not in seen:
                seen.add(key)
                unique.append(e)

        # Prioritise high-priority entities
        unique.sort(key=lambda x: 0 if x.get("_priority") == "high" else 1)
        return unique[:5]

    def _extract_audio_events(self, inbox: list[dict]) -> list[SensoryEvent]:
        """Extract audio events from inbox for cross-modal fusion.

        Also ingests visual detections into the sensory fusion buffer.
        """
        import time as _time
        audio_events = []

        for msg in inbox:
            msg_type = msg.get("type", "")
            camera_id = msg.get("camera_id", "")

            # Ingest audio events
            if msg_type in ("audio_event", "audio_detection", "acoustic_event"):
                event = SensoryEvent(
                    event_type=msg.get("audio_type", msg.get("event_type", "unknown")),
                    modality="audio",
                    camera_id=camera_id,
                    confidence=float(msg.get("confidence", 0.5)),
                    timestamp=_time.time(),
                    metadata=msg,
                )
                sensory_fusion_engine.ingest_event(event)
                audio_events.append(event)

            # Ingest visual threat detections for cross-modal correlation
            elif msg_type in ("threat_assessment", "detection", "perception"):
                for threat in msg.get("threats", []):
                    event = SensoryEvent(
                        event_type=threat.get("signature", threat.get("type", "detection")),
                        modality="visual",
                        camera_id=camera_id,
                        confidence=float(threat.get("confidence", 0.5)),
                        timestamp=_time.time(),
                    )
                    sensory_fusion_engine.ingest_event(event)

        return audio_events

    @staticmethod
    def _build_entity_description(detection: dict, event: dict) -> str:
        """Build a natural-language description for entity search."""
        det_class = detection.get("class", "unknown")
        track_id = detection.get("track_id")
        dwell = detection.get("dwell_time", 0)
        scene = event.get("scene_description", "")

        parts = [f"{det_class}"]
        if track_id:
            parts.append(f"(track #{track_id})")
        if dwell > 30:
            parts.append(f"dwelling for {dwell:.0f}s")
        if scene:
            parts.append(f"in scene: {scene[:100]}")

        return " ".join(parts)

    # ── Cross-camera correlation ──────────────────────────────────────

    async def _correlate_entity(self, entity: dict, context: dict) -> dict | None:
        """Search for an entity across other cameras and build a track."""
        camera_id = entity.get("camera_id", "unknown")
        description = entity.get("description", "")

        if not description:
            return None

        # Build current entity map for context
        entity_map_summary = json.dumps(
            {k: v[-1] if v else {} for k, v in self._entity_map.items()},
            default=str,
        )[:2000]

        # Use Gemini with tool-calling to perform cross-camera search
        result = await self.execute_tool_loop(
            _CORRELATION_PROMPT.format(
                entity_details=json.dumps(entity, default=str)[:1500],
                search_results=(
                    "Use search_entity_appearances tool to find this entity "
                    "on other cameras. Also check get_event_history for the "
                    "source camera to understand what happened."
                ),
                entity_map=entity_map_summary,
            ),
            context_data={
                "source_camera": camera_id,
                "entity": {k: v for k, v in entity.items() if not k.startswith("_")},
            },
        )

        response_text = result.get("response", "")
        correlation = self._parse_correlation(response_text)

        # ── Update entity map ─────────────────────────────────────────
        if correlation:
            entity_key = entity.get("description", "unknown")[:50]
            if entity_key not in self._entity_map:
                self._entity_map[entity_key] = []

            # Add the current observation
            self._entity_map[entity_key].append({
                "camera_id": camera_id,
                "timestamp": entity.get("timestamp"),
                "confidence": entity.get("confidence", 0),
                "track_id": entity.get("track_id"),
            })

            # Add any cross-camera appearances found
            for appearance in correlation.get("appearances", []):
                if appearance.get("camera_id") != camera_id:
                    self._entity_map[entity_key].append({
                        "camera_id": appearance["camera_id"],
                        "timestamp": appearance.get("timestamp"),
                        "confidence": appearance.get("confidence", 0),
                    })

            # Keep only last 20 observations per entity
            self._entity_map[entity_key] = self._entity_map[entity_key][-20:]

            # Log if cross-camera track was found
            total_cameras = correlation.get("total_cameras_seen", 0)
            if total_cameras > 1:
                await self.log_action("decision", {
                    "decision": f"cross_camera_track: {total_cameras} cameras",
                    "confidence": correlation.get("appearances", [{}])[0].get("confidence", 0) if correlation.get("appearances") else 0,
                    "prompt_summary": f"Entity correlation for {description[:100]}",
                    "response_summary": correlation.get("movement_track", "")[:300],
                })

                # Store significant correlations in long-term memory
                if total_cameras >= 3 or correlation.get("risk_level") in ("medium", "high"):
                    await self.learn(
                        knowledge=(
                            f"Cross-camera track: {description[:100]}. "
                            f"Movement: {correlation.get('movement_track', '')}. "
                            f"Pattern: {correlation.get('pattern_detected', 'none')}"
                        ),
                        category="correlation",
                        camera_id=camera_id,
                    )

        return correlation

    def _parse_correlation(self, response_text: str) -> dict | None:
        """Parse structured correlation analysis from Gemini response."""
        try:
            start = response_text.index("{")
            end = response_text.rindex("}") + 1
            parsed = json.loads(response_text[start:end])
            return {
                "entity_description": parsed.get("entity_description", ""),
                "appearances": parsed.get("appearances", []),
                "movement_track": parsed.get("movement_track", ""),
                "pattern_detected": parsed.get("pattern_detected", "none"),
                "pattern_description": parsed.get("pattern_description", ""),
                "risk_level": parsed.get("risk_level", "low"),
                "total_cameras_seen": int(parsed.get("total_cameras_seen", 0)),
                "dwell_summary": parsed.get("dwell_summary", ""),
            }
        except (ValueError, json.JSONDecodeError, TypeError):
            logger.debug("Could not parse JSON from correlation response")
            return None

    # ── Entity map synchronisation ────────────────────────────────────

    async def _sync_entity_map(self) -> None:
        """Sync the in-memory entity map to Redis short-term memory.

        This allows other agents to access entity positions and enables
        persistence across agent restarts within the TTL window.
        """
        # Prune stale entities (keep only those with recent observations)
        pruned_keys = []
        for key, observations in list(self._entity_map.items()):
            if not observations:
                pruned_keys.append(key)
                continue
            # Keep entities observed in the last 10 minutes
            latest_ts = observations[-1].get("timestamp", "")
            if latest_ts:
                try:
                    latest_dt = datetime.fromisoformat(latest_ts.replace("Z", "+00:00"))
                    age_seconds = (datetime.now(timezone.utc) - latest_dt).total_seconds()
                    if age_seconds > 600:  # 10 minutes
                        pruned_keys.append(key)
                except (ValueError, TypeError):
                    pass

        for key in pruned_keys:
            del self._entity_map[key]

        # Sync to Redis
        summary = {}
        for key, observations in self._entity_map.items():
            if observations:
                latest = observations[-1]
                summary[key] = {
                    "last_camera": latest.get("camera_id"),
                    "last_seen": latest.get("timestamp"),
                    "total_observations": len(observations),
                    "cameras_visited": list({
                        obs.get("camera_id") for obs in observations
                        if obs.get("camera_id")
                    }),
                }

        await self.remember("entity_map", summary, ttl=600)

    # ── Pattern detection ─────────────────────────────────────────────

    async def _detect_patterns(self, context: dict) -> None:
        """Periodic analysis of entity movement patterns across cameras.

        Looks for:
        - Repeated passes (same entity seen at same camera 3+ times)
        - Multiple restricted area visits
        - Coordinated movement of multiple entities
        """
        if not self._entity_map:
            return

        logger.info("Running cross-camera pattern detection")

        # Build tracking summary for analysis
        tracking_data = {}
        for entity_key, observations in self._entity_map.items():
            camera_visits = {}
            for obs in observations:
                cam = obs.get("camera_id", "unknown")
                if cam not in camera_visits:
                    camera_visits[cam] = 0
                camera_visits[cam] += 1

            tracking_data[entity_key] = {
                "total_observations": len(observations),
                "cameras_visited": list(camera_visits.keys()),
                "visit_counts": camera_visits,
                "first_seen": observations[0].get("timestamp") if observations else None,
                "last_seen": observations[-1].get("timestamp") if observations else None,
            }

        # Recall historical patterns from long-term memory
        historical = await self.recall_knowledge("correlation", limit=10)
        historical_summary = json.dumps(historical, default=str)[:2000]

        # Use Gemini to detect complex patterns
        result = await self.execute_tool_loop(
            _PATTERN_PROMPT.format(
                tracking_data=json.dumps(tracking_data, default=str)[:3000],
                historical_patterns=historical_summary,
            ),
        )

        response_text = result.get("response", "")

        # Parse detected patterns
        try:
            start = response_text.index("{")
            end = response_text.rindex("}") + 1
            parsed = json.loads(response_text[start:end])
            patterns = parsed.get("patterns_detected", [])
        except (ValueError, json.JSONDecodeError, TypeError):
            patterns = []

        # Publish significant patterns
        for pattern in patterns:
            risk = pattern.get("risk_level", "low")
            if risk in ("medium", "high", "critical"):
                await self.send_message(CH_CORRELATION, {
                    "type": "pattern_detected",
                    "pattern": pattern,
                    "entity_map_size": len(self._entity_map),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

                # Store in long-term memory
                await self.learn(
                    knowledge=(
                        f"Pattern detected: {pattern.get('type', 'unknown')} — "
                        f"{pattern.get('description', '')}. "
                        f"Risk: {risk}. Entities: {pattern.get('entities_involved', [])}"
                    ),
                    category="pattern",
                )

                logger.info(
                    "Suspicious pattern detected: type=%s risk=%s",
                    pattern.get("type"), risk,
                )

        await self.log_action("pattern_scan", {
            "entities_analysed": len(tracking_data),
            "patterns_found": len(patterns),
            "significant_patterns": sum(
                1 for p in patterns
                if p.get("risk_level") in ("medium", "high", "critical")
            ),
        })
