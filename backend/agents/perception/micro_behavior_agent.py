"""Micro-Behavior Detection Agent — pose-based pre-incident indicators.

Runs YOLOv8-pose on cameras with active person tracks (dwell >3s),
executes PoseAnalyzer micro-behavior checks, sends positives to
Gemini for confirmation, and creates alerts for verified threats.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_PERCEPTIONS, CH_THREATS

logger = logging.getLogger(__name__)

_MAX_CAMERAS_PER_CYCLE = 3
_MIN_DWELL_FOR_ANALYSIS = 3.0

# Map pose feature keys to human-readable labels for Gemini prompts
_BEHAVIOR_LABELS = {
    "blading": "Blading Stance (sideways orientation toward target)",
    "target_fixation": "Target Fixation (sustained gaze on single entity)",
    "pre_assault": "Pre-Assault Posturing (wide stance, clenched fists)",
    "staking": "Staking Behavior (stationary vantage point positioning)",
    "concealed_carry": "Concealed Object Carry (asymmetric arm swing)",
    "evasive": "Evasive Movement (camera avoidance, direction changes)",
}


class MicroBehaviorAgent(BaseAgent):
    """Perception-tier agent for micro-behavior threat detection.

    On each cycle:
    1. Finds cameras with person tracks dwelling >3s.
    2. Runs PoseAnalyzer on those tracks via YOLODetector.
    3. For any detected micro-behaviors, sends context to Gemini
       for confirmation (reduces false positives).
    4. Creates alerts for Gemini-confirmed micro-behaviors.
    5. Publishes findings to CH_PERCEPTIONS and CH_THREATS.
    """

    def __init__(self) -> None:
        super().__init__(
            name="micro_behavior",
            role="Micro-Behavior Threat Detection",
            description=(
                "Detects pre-incident body language indicators using "
                "YOLOv8-pose keypoint analysis: blading stance, target "
                "fixation, pre-assault posturing, staking, concealed "
                "carry, and evasive movement patterns."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "capture_frame",
                "get_current_detections",
                "create_alert",
                "store_observation",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=4.0,
            token_budget_per_cycle=12000,
        )
        self._camera_index = 0
        self._alerted_tracks: dict[str, set[int]] = {}  # camera_id -> set of track_ids already alerted

    async def think(self, context: dict) -> dict:
        """Main micro-behavior detection loop."""
        from backend.services.yolo_detector import yolo_detector, pose_analyzer
        from backend.services.video_capture import capture_manager

        inbox = context.get("inbox_messages", [])
        results: list[dict] = []

        # Handle Cortex directives
        for msg in inbox:
            if msg.get("type") == "force_behavior_check":
                camera_id = msg.get("camera_id")
                if camera_id:
                    r = await self._analyze_camera(camera_id)
                    results.extend(r)

        # Find cameras with active person tracks
        camera_ids = self._get_cameras_with_dwelling_persons()
        if not camera_ids:
            return {"status": "idle", "reason": "no_cameras_with_dwelling_persons"}

        # Round-robin through cameras
        start = self._camera_index % len(camera_ids)
        batch = []
        for i in range(_MAX_CAMERAS_PER_CYCLE):
            idx = (start + i) % len(camera_ids)
            batch.append(camera_ids[idx])
            if len(batch) >= len(camera_ids):
                break
        self._camera_index = (start + len(batch)) % max(len(camera_ids), 1)

        for camera_id in batch:
            try:
                r = await self._analyze_camera(camera_id)
                results.extend(r)
            except Exception as exc:
                logger.error("Micro-behavior analysis failed for camera %s: %s", camera_id, exc)

        detections = sum(1 for r in results if r.get("behaviors_detected"))
        confirmed = sum(1 for r in results if r.get("confirmed"))

        return {
            "status": "processed" if results else "idle",
            "cameras_analyzed": len(batch),
            "persons_analyzed": len(results),
            "behaviors_detected": detections,
            "confirmed_threats": confirmed,
        }

    async def _analyze_camera(self, camera_id: str) -> list[dict]:
        """Run micro-behavior analysis on all tracked persons in a camera."""
        from backend.services.yolo_detector import yolo_detector
        from backend.services.video_capture import capture_manager

        results = []

        stream = capture_manager.get_stream(camera_id)
        if stream is None or not stream.is_running:
            return results

        frame = stream.get_frame()
        if frame is None:
            return results

        # Run pose estimation + micro-behavior analysis
        try:
            pose_results = yolo_detector.detect_pose(frame, camera_id)
        except Exception as exc:
            logger.warning("Pose detection failed on camera %s: %s", camera_id, exc)
            return results

        if not pose_results:
            return results

        # Run micro-behavior analysis through the yolo_detector convenience method
        behavior_results = yolo_detector.analyze_micro_behavior(pose_results, camera_id)

        if camera_id not in self._alerted_tracks:
            self._alerted_tracks[camera_id] = set()

        for br in behavior_results:
            track_id = br.get("track_id")
            pose_features = br.get("pose_features", {})

            # Filter to only tracks with detected behaviors
            detected_behaviors = {
                k: v for k, v in pose_features.items()
                if isinstance(v, dict) and v.get("detected")
            }

            if not detected_behaviors:
                results.append({"track_id": track_id, "behaviors_detected": False})
                continue

            # Skip if already alerted for this track
            if track_id in self._alerted_tracks[camera_id]:
                continue

            # Prepare context for Gemini confirmation
            behavior_descriptions = []
            for bkey, bdata in detected_behaviors.items():
                label = _BEHAVIOR_LABELS.get(bkey, bkey)
                confidence = bdata.get("confidence", 0)
                behavior_descriptions.append(f"- {label} (confidence: {confidence:.2f})")

            behavior_text = "\n".join(behavior_descriptions)

            # Send to Gemini for confirmation
            prompt = (
                f"MICRO-BEHAVIOR ANALYSIS — Camera {camera_id}, Track {track_id}\n\n"
                f"The pose analyzer detected the following behaviors:\n"
                f"{behavior_text}\n\n"
                f"Dwell time: {br.get('dwell_time', 0):.1f}s\n"
                f"Is stationary: {br.get('is_stationary', False)}\n\n"
                f"Based on these indicators, assess whether this person poses "
                f"a genuine security concern. Consider:\n"
                f"1. Could these be normal behaviors (e.g., someone waiting, stretching)?\n"
                f"2. Are multiple indicators present (higher confidence)?\n"
                f"3. What is the threat level: NONE, LOW, MEDIUM, HIGH, CRITICAL?\n\n"
                f"Respond with JSON: {{\"confirmed\": true/false, \"threat_level\": \"...\", "
                f"\"reasoning\": \"...\", \"recommended_action\": \"...\"}}\n\n"
                f"Example output:\n"
                f"{{\"confirmed\": true, \"threat_level\": \"high\", "
                f"\"reasoning\": \"Multiple pre-assault indicators present: blading stance combined with target fixation on a single individual for over 10 seconds suggests imminent threat.\", "
                f"\"recommended_action\": \"Dispatch security to camera location immediately\"}}\n\n"
                f"Example output:\n"
                f"{{\"confirmed\": false, \"threat_level\": \"none\", "
                f"\"reasoning\": \"Person appears to be waiting for someone. Stationary posture is consistent with normal waiting behavior, not staking.\", "
                f"\"recommended_action\": \"Continue monitoring, no immediate action needed\"}}"
            )

            ai_result = await self.execute_tool_loop(prompt)
            response_text = ai_result.get("response", "")

            # Parse AI response
            confirmed = False
            threat_level = "low"
            reasoning = ""

            try:
                import json
                # Try to extract JSON from response
                json_start = response_text.find("{")
                json_end = response_text.rfind("}") + 1
                if json_start >= 0 and json_end > json_start:
                    parsed = json.loads(response_text[json_start:json_end])
                    confirmed = parsed.get("confirmed", False)
                    threat_level = parsed.get("threat_level", "low").lower()
                    reasoning = parsed.get("reasoning", "")
            except (json.JSONDecodeError, ValueError):
                # If AI says "confirmed" or "threat" in text, treat as positive
                confirmed = "confirmed" in response_text.lower() and "not confirmed" not in response_text.lower()
                threat_level = "medium" if confirmed else "low"
                reasoning = response_text[:200]

            result = {
                "track_id": track_id,
                "camera_id": camera_id,
                "behaviors_detected": True,
                "detected_behaviors": list(detected_behaviors.keys()),
                "confirmed": confirmed,
                "threat_level": threat_level,
                "reasoning": reasoning,
            }
            results.append(result)

            if confirmed and threat_level in ("medium", "high", "critical"):
                # Create alert
                severity_map = {"medium": "medium", "high": "high", "critical": "critical"}
                severity = severity_map.get(threat_level, "medium")
                behavior_names = ", ".join(detected_behaviors.keys())

                from backend.agents.agent_tools import create_alert
                await create_alert(
                    camera_id=camera_id,
                    severity=severity,
                    threat_type="micro_behavior",
                    description=(
                        f"Micro-behavior threat detected: {behavior_names} "
                        f"(Track {track_id}, dwell {br.get('dwell_time', 0):.1f}s). "
                        f"AI assessment: {reasoning[:200]}"
                    ),
                    confidence=max(
                        (d.get("confidence", 0) for d in detected_behaviors.values()),
                        default=0.5,
                    ),
                )

                # Publish to threat channel
                await self.send_message(CH_THREATS, {
                    "type": "micro_behavior_confirmed",
                    "camera_id": camera_id,
                    "track_id": track_id,
                    "behaviors": list(detected_behaviors.keys()),
                    "threat_level": threat_level,
                    "reasoning": reasoning[:200],
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

                # Mark as alerted
                self._alerted_tracks[camera_id].add(track_id)

                await self.log_action("micro_behavior_alert", {
                    "camera_id": camera_id,
                    "track_id": track_id,
                    "behaviors": list(detected_behaviors.keys()),
                    "threat_level": threat_level,
                    "decision": f"Confirmed micro-behavior: {behavior_names}",
                    "confidence": max(
                        (d.get("confidence", 0) for d in detected_behaviors.values()),
                        default=0.5,
                    ),
                })

            # Publish perception event regardless of confirmation
            await self.send_message(CH_PERCEPTIONS, {
                "type": "micro_behavior_scan",
                "camera_id": camera_id,
                "track_id": track_id,
                "behaviors": list(detected_behaviors.keys()),
                "confirmed": confirmed,
                "threat_level": threat_level,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        # Clean stale track IDs
        tracked = yolo_detector.get_tracked_objects(camera_id)
        active_tids = {obj.track_id for obj in tracked}
        self._alerted_tracks[camera_id] = self._alerted_tracks[camera_id] & active_tids

        return results

    @staticmethod
    def _get_cameras_with_dwelling_persons() -> list[str]:
        """Get cameras with at least one person track dwelling > threshold."""
        from backend.services.video_capture import capture_manager
        from backend.services.yolo_detector import yolo_detector

        camera_ids = []
        streams = capture_manager.list_streams()
        for cam_id, stream in streams.items():
            if not stream.is_running:
                continue
            tracked = yolo_detector.get_tracked_objects(cam_id)
            has_dwelling = any(
                obj.class_name == "person" and obj.dwell_time >= _MIN_DWELL_FOR_ANALYSIS
                for obj in tracked
            )
            if has_dwelling:
                camera_ids.append(cam_id)
        return camera_ids
