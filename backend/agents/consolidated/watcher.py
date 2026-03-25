"""Watcher Agent — Smart scene monitoring with motion-triggered AI analysis.

KEY DESIGN PRINCIPLE: YOLO runs every cycle (cheap, local GPU). LLM is ONLY called when:
  1. Motion detected (new objects appear or existing ones move)
  2. Person enters the scene (wasn't there before)
  3. Anomaly score exceeds threshold
  4. Camera tamper suspected
  5. Dwell time exceeds limit (someone loitering)
  6. Restricted zone entry detected
  7. Object count changes significantly
  8. Scheduled periodic check (every 60s even if no motion)

This reduces LLM calls from ~30/min to ~2-5/min while maintaining full situational awareness.
"""
from __future__ import annotations

import json, logging, time
from datetime import datetime, timezone
from typing import Optional

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_PERCEPTIONS
from backend.agents.agent_tools import TOOL_REGISTRY

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────
_ZONE_WEIGHT = {
    "restricted": 10, "secure": 8, "entrance": 7, "exit": 7, "perimeter": 6,
    "parking": 5, "hallway": 4, "lobby": 4, "office": 3, "common": 2, "default": 3,
}
_BRIGHTNESS_THRESH = 0.50
_HISTOGRAM_THRESH = 0.70
_ANOMALY_PUBLISH_SCORE = 6
_BASELINE_LEARN_STREAK = 10

# ── Smart LLM gating thresholds ──────────────────────────────────
_PERSON_ENTERED_COOLDOWN = 15.0     # seconds between LLM calls for same camera
_DWELL_ALERT_SECONDS = 30           # loitering threshold
_MOTION_DELTA_THRESHOLD = 2         # min object count change to trigger motion
_PERIODIC_ANALYSIS_INTERVAL = 60.0  # forced analysis every N seconds even if no motion
_MAX_LLM_CALLS_PER_MINUTE = 8      # global LLM budget

_ANALYSIS_PROMPT = """\
You are the **Watcher** — unified scene monitor for a physical security system.
Camera **{camera_name}** (zone: {zone_name}).

YOLO detections: Persons={person_count} Vehicles={vehicle_count} Total={total_objects} Tracks={active_tracks}
Trigger reason: {trigger_reason}
Details: {detection_details}
Tamper: brightness_delta={brightness_delta:.1%}  histogram_div={histogram_divergence:.1%}
Previous: {previous_summary}

Assess security concerns. Be accurate — do NOT hallucinate threats. Normal activity = severity "info".
Only flag severity "medium"+ for genuine concerns (weapons, trespassing, fights, abandoned objects, etc.).

Respond JSON:
{{"scene_summary":"<1-2 sentences>","activity_level":"<quiet|normal|busy|crowded>",\
"severity":"<info|low|medium|high|critical>","notable_observations":["..."],\
"potential_concerns":["..."],"confidence":<0-1>,\
"changes_from_previous":"<description>"}}
"""


class WatcherAgent(BaseAgent):
    """Smart watcher — YOLO every cycle, LLM only on motion/events."""

    def __init__(self) -> None:
        super().__init__(
            name="watcher",
            role="Smart Scene Monitor — Motion-Triggered AI",
            description=(
                "Monitors all cameras via YOLO (every 2s). Only invokes LLM when "
                "motion detected, person enters, anomaly detected, or periodic check. "
                "Reduces AI calls by 80% while maintaining full awareness."
            ),
            tier="perception",
            model_name="gemma3:4b",
            tool_names=["capture_frame", "get_current_detections", "analyze_frame_with_gemini",
                        "get_zone_occupancy", "get_site_context", "store_observation",
                        "get_all_cameras_status", "get_all_zones_status"],
            subscriptions=[CH_CORTEX],
            cycle_interval=5.0,
            token_budget_per_cycle=15000,
        )
        # Per-camera state tracking
        self._prev_counts: dict[str, dict] = {}       # {cam_id: {persons, vehicles, objects}}
        self._last_llm_call: dict[str, float] = {}    # {cam_id: timestamp}
        self._last_periodic: dict[str, float] = {}    # {cam_id: timestamp}
        self._normal_streak: dict[str, int] = {}
        self._llm_calls_this_minute: list[float] = [] # timestamps of recent LLM calls

    def _can_call_llm(self) -> bool:
        """Check global LLM budget."""
        now = time.time()
        self._llm_calls_this_minute = [t for t in self._llm_calls_this_minute if t > now - 60]
        return len(self._llm_calls_this_minute) < _MAX_LLM_CALLS_PER_MINUTE

    def _record_llm_call(self, cam_id: str):
        """Record an LLM call for rate tracking."""
        now = time.time()
        self._llm_calls_this_minute.append(now)
        self._last_llm_call[cam_id] = now

    # ── Core reasoning loop ──────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """YOLO every cycle. LLM only when triggered."""
        camera = await self._select_camera()
        if camera is None:
            return {"status": "idle", "reason": "no_active_cameras"}

        cam_id = camera["id"]
        cam_name = camera.get("name", cam_id)
        zone_name = camera.get("zone_name", camera.get("location", "unknown"))
        zone_type = camera.get("zone_type", "default")
        await self.remember(f"last_scan_{cam_id}", time.time(), ttl=600)

        # ── Step 1: YOLO detection (always runs, GPU, ~5ms) ──────────
        try:
            det = await TOOL_REGISTRY["get_current_detections"]["fn"](camera_id=cam_id)
        except Exception as exc:
            logger.warning("Watcher: YOLO failed for %s: %s", cam_id, exc)
            return {"status": "skip", "camera_id": cam_id, "reason": "detection_error"}
        if not det.get("success"):
            return {"status": "skip", "camera_id": cam_id, "reason": "no_frame"}

        persons = det.get("person_count", 0)
        vehicles = det.get("vehicle_count", 0)
        objects = det.get("total_objects", 0)
        tracks = det.get("active_tracks", 0)
        raw = det.get("detections", [])

        # ── Step 2: Tamper check (local math, no LLM) ────────────────
        br_delta, hist_div = await self._check_tamper(cam_id, det)
        tamper = abs(br_delta) > _BRIGHTNESS_THRESH or hist_div > _HISTOGRAM_THRESH

        # ── Step 3: Anomaly score (local math, no LLM) ───────────────
        a_score = await self._score_anomaly(cam_id, persons, vehicles, objects, raw)

        # ── Step 4: Decide if LLM analysis is needed ─────────────────
        trigger_reason = self._should_trigger_llm(
            cam_id, cam_name, zone_type, persons, vehicles, objects, raw, tamper, a_score
        )

        assessment: dict = {}
        llm_invoked = False

        if trigger_reason and self._can_call_llm():
            # Cooldown check — don't spam LLM for same camera
            last_call = self._last_llm_call.get(cam_id, 0)
            if time.time() - last_call >= _PERSON_ENTERED_COOLDOWN:
                llm_invoked = True
                self._record_llm_call(cam_id)
                assessment = await self._run_analysis(
                    cam_id, cam_name, zone_name, det, raw,
                    br_delta, hist_div, trigger_reason, context
                )
                logger.info("Watcher LLM: %s reason=%s severity=%s",
                           cam_name, trigger_reason, assessment.get("severity", "?"))

        # ── Step 5: Update state tracking ────────────────────────────
        self._prev_counts[cam_id] = {
            "persons": persons, "vehicles": vehicles, "objects": objects,
            "classes": {d.get("class", "unknown") for d in raw},
        }

        # ── Step 6: Publish events ───────────────────────────────────
        if tamper:
            t_type = ("obstruction" if br_delta < -_BRIGHTNESS_THRESH
                      else "spray" if hist_div > _HISTOGRAM_THRESH else "reposition")
            await self.send_message(CH_PERCEPTIONS, {
                "type": "tamper_alert", "camera_id": cam_id, "camera_name": cam_name,
                "zone_name": zone_name, "tamper_type": t_type, "severity": "high",
                "timestamp": datetime.now(timezone.utc).isoformat()})

        if a_score >= _ANOMALY_PUBLISH_SCORE:
            self._normal_streak[cam_id] = 0
            sev = "critical" if a_score >= 9 else "high" if a_score >= 7 else "medium"
            await self.send_message(CH_PERCEPTIONS, {
                "type": "anomaly_detected", "camera_id": cam_id, "camera_name": cam_name,
                "zone_name": zone_name, "anomaly_score": a_score, "severity": sev,
                "person_count": persons, "vehicle_count": vehicles,
                "timestamp": datetime.now(timezone.utc).isoformat()})
        else:
            streak = self._normal_streak.get(cam_id, 0) + 1
            self._normal_streak[cam_id] = streak
            if streak >= _BASELINE_LEARN_STREAK:
                await self._update_baseline(cam_id, persons, vehicles, objects)
                self._normal_streak[cam_id] = 0

        severity = assessment.get("severity", "info")
        if severity in ("low", "medium", "high", "critical") and assessment:
            await self.send_message(CH_PERCEPTIONS, {
                "type": "scene_analysis", "camera_id": cam_id, "camera_name": cam_name,
                "zone_name": zone_name, "person_count": persons, "vehicle_count": vehicles,
                "total_objects": objects, "active_tracks": tracks,
                "analysis": assessment.get("scene_summary", ""),
                "notable_observations": assessment.get("notable_observations", []),
                "potential_concerns": assessment.get("potential_concerns", []),
                "severity": severity, "confidence": assessment.get("confidence", 0.0),
                "anomaly_score": a_score, "tamper_suspected": tamper,
                "trigger_reason": trigger_reason or "none",
                "timestamp": datetime.now(timezone.utc).isoformat()})

        # Always store analysis state (even without LLM)
        await self.remember(f"last_analysis_{cam_id}", {
            "person_count": persons, "vehicle_count": vehicles, "total_objects": objects,
            "severity": severity,
            "summary": assessment.get("scene_summary", f"YOLO: {persons}p {vehicles}v {objects}obj"),
            "timestamp": datetime.now(timezone.utc).isoformat()}, ttl=120)

        await self.log_action("watcher_scan", {
            "camera_id": cam_id, "person_count": persons, "severity": severity,
            "anomaly_score": a_score, "tamper_flagged": tamper, "llm_invoked": llm_invoked,
            "trigger": trigger_reason or "none",
            "llm_budget": f"{len(self._llm_calls_this_minute)}/{_MAX_LLM_CALLS_PER_MINUTE}",
            "decision": f"{cam_name} p={persons} sev={severity} trigger={trigger_reason or 'none'}"})

        return {"status": "scanned", "camera_id": cam_id, "person_count": persons,
                "severity": severity, "anomaly_score": a_score,
                "llm_invoked": llm_invoked, "trigger": trigger_reason}

    # ── Smart LLM trigger logic ──────────────────────────────────────

    def _should_trigger_llm(self, cam_id: str, cam_name: str, zone_type: str,
                            persons: int, vehicles: int, objects: int,
                            raw: list[dict], tamper: bool, a_score: int) -> Optional[str]:
        """Determine if this cycle warrants an LLM call. Returns reason or None."""
        prev = self._prev_counts.get(cam_id)
        now = time.time()

        # 1. Camera tamper — always analyze
        if tamper:
            return "tamper_detected"

        # 2. Anomaly score high — always analyze
        if a_score >= _ANOMALY_PUBLISH_SCORE:
            return f"anomaly_score_{a_score}"

        # 3. Person entered scene (wasn't there before)
        if prev is not None:
            was_empty = prev.get("persons", 0) == 0
            if was_empty and persons > 0:
                return "person_entered"

            # 4. Significant object count change (motion)
            prev_obj = prev.get("objects", 0)
            delta = abs(objects - prev_obj)
            if delta >= _MOTION_DELTA_THRESHOLD:
                return f"motion_delta_{delta}"

            # 5. New object class appeared
            prev_classes = prev.get("classes", set())
            cur_classes = {d.get("class", "unknown") for d in raw}
            new_classes = cur_classes - prev_classes - {"unknown"}
            if new_classes:
                return f"new_class_{'_'.join(new_classes)}"

            # 6. Person count increased (new person arrived)
            if persons > prev.get("persons", 0):
                return "person_count_increased"

            # 7. Vehicle entered
            if vehicles > prev.get("vehicles", 0) and prev.get("vehicles", 0) == 0:
                return "vehicle_entered"
        else:
            # First scan of this camera — analyze
            if persons > 0 or vehicles > 0:
                return "first_scan_with_activity"

        # 8. Loitering detected (someone dwelling too long)
        for d in raw:
            if d.get("dwell_time", 0) > _DWELL_ALERT_SECONDS:
                return f"loitering_{d.get('class','person')}_{int(d['dwell_time'])}s"

        # 9. Restricted zone with any person
        if zone_type in ("restricted", "secure") and persons > 0:
            return "person_in_restricted_zone"

        # 10. Periodic check (even if nothing changed)
        last_periodic = self._last_periodic.get(cam_id, 0)
        if now - last_periodic >= _PERIODIC_ANALYSIS_INTERVAL and persons > 0:
            self._last_periodic[cam_id] = now
            return "periodic_check"

        # No trigger — skip LLM, save API costs
        return None

    # ── Priority-weighted camera selection ────────────────────────────

    async def _select_camera(self) -> dict | None:
        """Pick highest-priority camera with motion bias."""
        cam_res = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        if not cam_res.get("success"):
            return None
        cameras = [c for c in cam_res.get("cameras", []) if c.get("status") == "online"]
        if not cameras:
            return None

        zone_res = await TOOL_REGISTRY["get_all_zones_status"]["fn"]()
        zlookup = {z.get("name", "").lower(): z for z in zone_res.get("zones", [])}
        now = time.time()
        scored = []

        for cam in cameras:
            loc = cam.get("location", "").lower()
            z_type, z_name = "default", cam.get("location", "unknown")
            for zn, zd in zlookup.items():
                if zn in loc or loc in zn:
                    z_type = zd.get("type", "default")
                    z_name = zd.get("name", z_name)
                    break

            # Base score from zone sensitivity
            score = _ZONE_WEIGHT.get(z_type, _ZONE_WEIGHT["default"])

            # Time since last scan bonus (cameras not scanned recently get priority)
            last = await self.recall(f"last_scan_{cam['id']}")
            t_bonus = min((now - float(last)) / 30.0, 10.0) if last is not None else 10.0
            score += t_bonus

            # Previous severity bonus (cameras with prior concerns get priority)
            prev = await self.recall(f"last_analysis_{cam['id']}")
            if prev and isinstance(prev, dict):
                sev_bonus = {"critical": 8, "high": 5, "medium": 3, "low": 1}.get(
                    prev.get("severity", "info"), 0)
                score += sev_bonus

                # Motion bonus — cameras where object count was changing
                prev_count = self._prev_counts.get(cam["id"], {})
                if prev_count and prev_count.get("persons", 0) > 0:
                    score += 3  # Active cameras get priority

            cam["zone_name"] = z_name
            cam["zone_type"] = z_type
            scored.append((score, cam))

        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[0][1]

    # ── Tamper check ──────────────────────────────────────────────────

    async def _check_tamper(self, camera_id: str, det: dict) -> tuple[float, float]:
        brightness = det.get("mean_brightness")
        histogram = det.get("histogram")
        if brightness is None:
            return 0.0, 0.0

        bl = await self.recall(f"tamper_baseline_{camera_id}")
        if bl is None or not isinstance(bl, dict):
            await self.remember(f"tamper_baseline_{camera_id}",
                                {"brightness": brightness, "histogram": histogram,
                                 "captured_at": time.time()}, ttl=3600)
            return 0.0, 0.0

        bl_br = bl.get("brightness", brightness)
        br_delta = (brightness - bl_br) / max(bl_br, 1) if bl_br > 0 else 0.0

        hist_div = 0.0
        bl_hist = bl.get("histogram")
        if histogram and bl_hist and isinstance(histogram, list):
            try:
                total = sum(max(abs(c), abs(b), 1) for c, b in zip(histogram, bl_hist))
                diffs = sum(abs(c - b) for c, b in zip(histogram, bl_hist))
                hist_div = diffs / total if total > 0 else 0.0
            except (TypeError, ValueError):
                pass
        return br_delta, hist_div

    # ── Anomaly scoring ──────────────────────────────────────────────

    async def _score_anomaly(self, cam_id: str, persons: int, vehicles: int,
                             objects: int, raw: list[dict]) -> int:
        bl = await self.recall(f"scene_baseline_{cam_id}")
        if not bl or not isinstance(bl, dict):
            return 1
        score = 1
        bp = bl.get("person_count", 0)
        bv = bl.get("vehicle_count", 0)
        bo = bl.get("total_objects", 0)
        bl_cls = set(bl.get("classes", []))

        if bp > 0:
            ratio = abs(persons - bp) / max(bp, 1)
            score += 3 if ratio > 1.0 else 2 if ratio > 0.5 else 0
        elif persons > 0:
            score += 2
        if vehicles > bv + 2:
            score += 2
        elif bv == 0 and vehicles > 0:
            score += 1
        if bo > 0 and objects > bo * 2:
            score += 2
        cur_cls = {d.get("class", "unknown") for d in raw} - bl_cls - {"unknown"}
        score += min(len(cur_cls), 3)
        return min(score, 10)

    async def _update_baseline(self, cam_id: str, persons: int, vehicles: int, objects: int):
        hour = datetime.now(timezone.utc).hour
        await self.remember(f"scene_baseline_{cam_id}", {
            "person_count": persons, "vehicle_count": vehicles, "total_objects": objects,
            "classes": [], "hour": hour,
            "updated_at": datetime.now(timezone.utc).isoformat()}, ttl=3600)
        logger.info("Watcher: baseline updated cam=%s h=%d p=%d v=%d o=%d", cam_id, hour, persons, vehicles, objects)

    # ── LLM Analysis ─────────────────────────────────────────────────

    async def _run_analysis(self, cam_id: str, cam_name: str, zone: str,
                            det: dict, raw: list[dict], br_delta: float, hist_div: float,
                            trigger_reason: str, ctx: dict) -> dict:
        details = json.dumps([{"class": d.get("class", "unknown"), "conf": round(d.get("confidence", 0), 2),
                               "track": d.get("track_id"), "dwell": round(d.get("dwell_time", 0), 1)}
                              for d in raw], default=str)[:2000]

        prev = await self.recall(f"last_analysis_{cam_id}")
        prev_s = json.dumps(prev, default=str)[:500] if prev else "First scan."

        prompt = _ANALYSIS_PROMPT.format(
            camera_name=cam_name, zone_name=zone,
            person_count=det.get("person_count", 0), vehicle_count=det.get("vehicle_count", 0),
            total_objects=det.get("total_objects", 0), active_tracks=det.get("active_tracks", 0),
            trigger_reason=trigger_reason, detection_details=details,
            brightness_delta=br_delta, histogram_divergence=hist_div,
            previous_summary=prev_s)

        result = await self.execute_tool_loop(prompt, context_data={
            "camera_id": cam_id, "trigger": trigger_reason})
        return self._parse_assessment(result.get("response", ""))

    @staticmethod
    def _parse_assessment(text: str) -> dict:
        try:
            start = text.index("{")
            end = text.rindex("}") + 1
            parsed = json.loads(text[start:end])
            return {
                "scene_summary": parsed.get("scene_summary", ""),
                "activity_level": parsed.get("activity_level", "unknown"),
                "severity": parsed.get("severity", "info"),
                "notable_observations": parsed.get("notable_observations", []),
                "potential_concerns": parsed.get("potential_concerns", []),
                "confidence": float(parsed.get("confidence", 0.0)),
                "changes_from_previous": parsed.get("changes_from_previous", ""),
            }
        except (json.JSONDecodeError, ValueError):
            return {"scene_summary": text[:200], "severity": "info", "confidence": 0.0}
