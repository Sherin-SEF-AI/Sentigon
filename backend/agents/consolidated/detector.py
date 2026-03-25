"""Detector Agent — Unified object detection, LPR, PPE compliance, crowd analytics, and abandoned objects.

Consolidates: LPR Agent, PPE Compliance Agent, Crowd Monitor Agent.
Runs specialized detection pipelines on camera frames: license plate reading,
PPE compliance checking, crowd density monitoring, and abandoned object detection.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_PERCEPTIONS

logger = logging.getLogger(__name__)

_LPR_CYCLE_INTERVAL = 4
_PPE_ZONE_TYPES = {"industrial", "construction", "warehouse", "manufacturing"}
_DEFAULT_REQUIRED_PPE = ["hard_hat", "hi_vis_vest"]
_ABANDONED_THRESHOLD_S = 120.0
_ABANDONED_PROXIMITY_PX = 150
_CROWD_TREND_WINDOW = 10
_VEHICLE_FLOW_WINDOW_S = 300.0
_PARKED_DWELL_ALERT_S = 600.0
_VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle"}
_SUSPICIOUS_CLASSES = {"backpack", "suitcase", "handbag", "briefcase", "bag"}


class DetectorAgent(BaseAgent):
    """Unified detection agent: LPR, PPE, crowd density, abandoned objects, vehicle analytics."""

    def __init__(self) -> None:
        super().__init__(
            name="detector",
            role="Specialized Object Detection & Analytics",
            description=(
                "Runs specialized detection pipelines: license plate recognition, "
                "PPE compliance, crowd density monitoring, vehicle analytics, and "
                "abandoned object detection across all cameras."
            ),
            tier="perception",
            model_name="gemma3:4b",
            tool_names=[
                "capture_frame", "get_current_detections", "analyze_frame_with_gemini",
                "get_zone_occupancy", "get_site_context", "store_observation",
                "get_all_cameras_status",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=15.0,
            token_budget_per_cycle=12000,
        )
        self._camera_index = 0
        self._crowd_trends: dict[str, deque] = defaultdict(lambda: deque(maxlen=_CROWD_TREND_WINDOW))
        self._unattended: dict[tuple[str, int], dict] = {}
        self._vehicle_timestamps: dict[str, deque] = defaultdict(lambda: deque(maxlen=200))
        self._parked_vehicles: dict[tuple[str, int], float] = {}

    # ── Main think loop ───────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Multi-pipeline detection cycle across all active cameras."""
        from backend.agents.agent_tools import TOOL_REGISTRY

        cycle = context.get("cycle", 0)
        cameras_result = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        if not cameras_result.get("success"):
            return {"status": "idle", "reason": "cameras_unavailable"}

        cameras = [c for c in cameras_result.get("cameras", []) if c.get("status") == "online"]
        if not cameras:
            return {"status": "idle", "reason": "no_online_cameras"}

        cam = cameras[self._camera_index % len(cameras)]
        self._camera_index = (self._camera_index + 1) % len(cameras)
        camera_id = cam["id"]

        detections = await TOOL_REGISTRY["get_current_detections"]["fn"](camera_id=camera_id)
        if not detections.get("success"):
            return {"status": "skip", "reason": "detection_unavailable", "camera": camera_id}

        objects = detections.get("detections", [])
        person_count = detections.get("person_count", 0)
        vehicle_count = detections.get("vehicle_count", 0)
        results: dict[str, Any] = {"camera_id": camera_id, "pipelines": []}

        # Pipeline 1: Crowd Density
        crowd = await self._pipeline_crowd(camera_id, cam, person_count)
        if crowd:
            results["pipelines"].append("crowd")
            results["crowd"] = crowd

        # Pipeline 2: License Plate Recognition (every N cycles)
        if cycle % _LPR_CYCLE_INTERVAL == 0 and vehicle_count > 0:
            lpr = await self._pipeline_lpr(camera_id, cam, objects)
            if lpr:
                results["pipelines"].append("lpr")
                results["lpr"] = lpr

        # Pipeline 3: PPE Compliance (industrial/construction zones)
        ppe = await self._pipeline_ppe(camera_id, cam, person_count)
        if ppe:
            results["pipelines"].append("ppe")
            results["ppe"] = ppe

        # Pipeline 4: Abandoned Object Detection
        abandoned = self._pipeline_abandoned(camera_id, objects)
        if abandoned:
            results["pipelines"].append("abandoned")
            results["abandoned"] = abandoned
            await self._publish_abandoned(abandoned)

        # Pipeline 5: Vehicle Analytics
        va = self._pipeline_vehicle_analytics(camera_id, objects, vehicle_count)
        if va:
            results["pipelines"].append("vehicle_analytics")
            results["vehicle_analytics"] = va
            await self.send_message(CH_PERCEPTIONS, {
                "type": "vehicle_analytics", "camera_id": camera_id,
                "vehicle_count": va["vehicle_count"],
                "flow_rate_per_min": va["flow_rate_per_min"],
                "parked_alerts": va.get("parked_alerts", []),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        results["status"] = "processed" if results["pipelines"] else "idle"
        return results

    # ── Pipeline: Crowd Density ───────────────────────────────────

    async def _pipeline_crowd(self, camera_id: str, cam: dict, person_count: int) -> dict | None:
        if person_count == 0:
            return None
        zone_info = await self._get_zone_for_camera(camera_id)
        zone_id = zone_info.get("zone_id", camera_id) if zone_info else camera_id
        zone_name = (zone_info or {}).get("zone_name", cam.get("name", camera_id))
        max_occ = (zone_info or {}).get("max_occupancy", 0)

        self._crowd_trends[zone_id].append({"count": person_count, "ts": time.time()})
        trend_dir = self._compute_trend(list(self._crowd_trends[zone_id]))
        is_over = max_occ > 0 and person_count > max_occ
        util_pct = round((person_count / max_occ) * 100, 1) if max_occ > 0 else 0.0

        if is_over or person_count >= 15 or trend_dir == "increasing":
            await self.send_message(CH_PERCEPTIONS, {
                "type": "crowd_density", "camera_id": camera_id,
                "zone_id": zone_id, "zone_name": zone_name,
                "person_count": person_count, "max_occupancy": max_occ,
                "utilisation_pct": util_pct, "is_over_capacity": is_over,
                "trend_direction": trend_dir,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            await self.log_action("crowd_density", {
                "decision": f"zone={zone_name} count={person_count}/{max_occ} trend={trend_dir}",
                "camera_id": camera_id,
            })
        return {"person_count": person_count, "zone_id": zone_id, "trend": trend_dir, "over_capacity": is_over}

    # ── Pipeline: LPR ─────────────────────────────────────────────

    async def _pipeline_lpr(self, camera_id: str, cam: dict, objects: list[dict]) -> dict | None:
        vehicles = [o for o in objects if o.get("class") in _VEHICLE_CLASSES]
        if not vehicles:
            return None
        cam_name = cam.get("name", camera_id)
        result = await self.execute_tool_loop(
            prompt=(
                f"Analyze current frame from camera {camera_id} ({cam_name}). "
                f"{len(vehicles)} vehicle(s) detected. Use analyze_frame_with_gemini to "
                f"read all visible license plates. For each plate report: plate_text, "
                f"vehicle_type, vehicle_color, confidence. Then use store_observation to "
                f"record each reading with category='plate_read'."
            ),
            context_data={"camera_id": camera_id, "vehicle_count": len(vehicles), "task": "lpr"},
        )
        resp = result.get("response", "")
        await self.send_message(CH_PERCEPTIONS, {
            "type": "plate_read", "camera_id": camera_id, "camera_name": cam_name,
            "vehicle_count": len(vehicles), "analysis": resp[:500],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        await self.log_action("lpr_scan", {
            "camera_id": camera_id, "vehicles_detected": len(vehicles),
            "decision": f"LPR scan {cam_name}: {len(vehicles)} vehicle(s)",
        })
        return {"vehicles_scanned": len(vehicles), "response": resp[:300]}

    # ── Pipeline: PPE Compliance ──────────────────────────────────

    async def _pipeline_ppe(self, camera_id: str, cam: dict, person_count: int) -> dict | None:
        if person_count == 0:
            return None
        zone_info = await self._get_zone_for_camera(camera_id)
        if not zone_info or zone_info.get("zone_type", "") not in _PPE_ZONE_TYPES:
            return None

        zone_id = zone_info["zone_id"]
        zone_name = zone_info.get("zone_name", "")
        zone_type = zone_info["zone_type"]
        required_ppe = zone_info.get("required_ppe", _DEFAULT_REQUIRED_PPE)

        result = await self.execute_tool_loop(
            prompt=(
                f"Analyze frame from camera {camera_id} in zone '{zone_name}' "
                f"(type={zone_type}). {person_count} person(s) detected. "
                f"Required PPE: {', '.join(required_ppe)}. Use analyze_frame_with_gemini "
                f"to check PPE compliance per person. Report compliant/non-compliant "
                f"with missing items. Use store_observation category='ppe_check' for violations."
            ),
            context_data={
                "camera_id": camera_id, "zone_id": zone_id,
                "zone_type": zone_type, "required_ppe": required_ppe,
                "person_count": person_count,
            },
        )
        resp = result.get("response", "")
        await self.send_message(CH_PERCEPTIONS, {
            "type": "ppe_compliance", "camera_id": camera_id,
            "zone_id": zone_id, "zone_name": zone_name, "zone_type": zone_type,
            "persons_checked": person_count, "required_ppe": required_ppe,
            "analysis": resp[:500], "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        await self.log_action("ppe_check", {
            "camera_id": camera_id, "zone_id": zone_id,
            "persons_checked": person_count,
            "decision": f"PPE check zone={zone_name} persons={person_count}",
        })
        return {"zone_id": zone_id, "persons_checked": person_count, "response": resp[:300]}

    # ── Pipeline: Abandoned Object Detection ──────────────────────

    def _pipeline_abandoned(self, camera_id: str, objects: list[dict]) -> dict | None:
        now = time.time()
        persons = [o for o in objects if o.get("class") == "person" and o.get("bbox")]
        suspects = [o for o in objects if o.get("class") in _SUSPICIOUS_CLASSES
                    and o.get("track_id") is not None and o.get("bbox")]

        active_keys: set[tuple[str, int]] = set()
        for obj in suspects:
            key = (camera_id, obj["track_id"])
            active_keys.add(key)
            bbox = obj["bbox"]
            cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
            nearest = min(
                (((cx - (p["bbox"][0]+p["bbox"][2])/2)**2 + (cy - (p["bbox"][1]+p["bbox"][3])/2)**2)**0.5
                 for p in persons),
                default=float("inf"),
            )
            if key not in self._unattended:
                self._unattended[key] = {
                    "first_seen": now, "class_name": obj["class"],
                    "bbox": bbox, "last_seen": now,
                    "has_owner": nearest < _ABANDONED_PROXIMITY_PX,
                }
            else:
                e = self._unattended[key]
                e.update(last_seen=now, bbox=bbox, has_owner=nearest < _ABANDONED_PROXIMITY_PX)

        # Prune stale entries not seen for >30s
        for k in [k for k, v in self._unattended.items()
                  if k[0] == camera_id and k not in active_keys and now - v["last_seen"] > 30]:
            del self._unattended[k]

        flagged = [
            {"track_id": k[1], "class": v["class_name"], "bbox": v["bbox"],
             "unattended_seconds": round(now - v["first_seen"], 1)}
            for k, v in self._unattended.items()
            if k[0] == camera_id and now - v["first_seen"] >= _ABANDONED_THRESHOLD_S and not v["has_owner"]
        ]
        return {"flagged_objects": flagged, "camera_id": camera_id} if flagged else None

    # ── Pipeline: Vehicle Analytics ───────────────────────────────

    def _pipeline_vehicle_analytics(
        self, camera_id: str, objects: list[dict], vehicle_count: int,
    ) -> dict | None:
        if vehicle_count == 0:
            return None
        now = time.time()
        vehicles = [o for o in objects if o.get("class") in _VEHICLE_CLASSES]

        self._vehicle_timestamps[camera_id].append(now)
        cutoff = now - _VEHICLE_FLOW_WINDOW_S
        recent = [ts for ts in self._vehicle_timestamps[camera_id] if ts >= cutoff]
        flow_rate = round(len(recent) / (_VEHICLE_FLOW_WINDOW_S / 60.0), 1) if recent else 0.0

        alerts: list[dict] = []
        active_keys: set[tuple[str, int]] = set()
        for v in vehicles:
            tid = v.get("track_id")
            if tid is None:
                continue
            key = (camera_id, tid)
            active_keys.add(key)
            if v.get("is_stationary", False):
                if key not in self._parked_vehicles:
                    self._parked_vehicles[key] = now
                dur = now - self._parked_vehicles[key]
                if dur >= _PARKED_DWELL_ALERT_S:
                    alerts.append({
                        "track_id": tid, "class": v.get("class", "vehicle"),
                        "parked_seconds": round(dur, 1), "dwell_time": round(v.get("dwell_time", 0), 1),
                    })
            else:
                self._parked_vehicles.pop(key, None)

        for k in [k for k in self._parked_vehicles if k[0] == camera_id and k not in active_keys]:
            del self._parked_vehicles[k]

        result: dict[str, Any] = {"vehicle_count": vehicle_count, "flow_rate_per_min": flow_rate}
        if alerts:
            result["parked_alerts"] = alerts
        return result

    # ── Abandoned-object publishing ───────────────────────────────

    async def _publish_abandoned(self, data: dict) -> None:
        camera_id = data["camera_id"]
        for obj in data["flagged_objects"]:
            await self.send_message(CH_PERCEPTIONS, {
                "type": "abandoned_object", "camera_id": camera_id,
                "track_id": obj["track_id"], "object_class": obj["class"],
                "bbox": obj["bbox"], "unattended_seconds": obj["unattended_seconds"],
                "severity": "high", "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            await self.log_action("abandoned_object", {
                "camera_id": camera_id, "object_class": obj["class"],
                "track_id": obj["track_id"], "unattended_seconds": obj["unattended_seconds"],
                "decision": f"Abandoned {obj['class']} on {camera_id}, unattended {obj['unattended_seconds']}s",
            })

    # ── Helpers ────────────────────────────────────────────────────

    async def _get_zone_for_camera(self, camera_id: str) -> dict | None:
        """Resolve zone info for a camera, cached in short-term memory."""
        cache_key = f"zone_for_{camera_id}"
        cached = await self.recall(cache_key)
        if cached:
            return cached
        try:
            from backend.database import async_session
            from backend.models.models import Camera, Zone
            from sqlalchemy import select

            async with async_session() as session:
                row = await session.execute(select(Camera).where(Camera.id == camera_id))
                camera = row.scalar_one_or_none()
                if not camera or not camera.zone_id:
                    return None
                zone = await session.get(Zone, camera.zone_id)
                if not zone:
                    return None
                config = zone.config or {} if hasattr(zone, "config") else {}
                info = {
                    "zone_id": str(zone.id), "zone_name": zone.name,
                    "zone_type": zone.zone_type or "",
                    "max_occupancy": zone.max_occupancy or 0,
                    "required_ppe": config.get("required_ppe", _DEFAULT_REQUIRED_PPE),
                }
                await self.remember(cache_key, info, ttl=120)
                return info
        except Exception as exc:
            logger.debug("Zone lookup failed for camera %s: %s", camera_id, exc)
            return None

    @staticmethod
    def _compute_trend(readings: list[dict]) -> str:
        """Compute trend direction from rolling count readings."""
        if len(readings) < 3:
            return "stable"
        counts = [r.get("count", 0) for r in readings]
        recent = counts[-3:]
        diffs = [recent[i] - recent[i - 1] for i in range(1, len(recent))]
        total_change = counts[-1] - counts[0]
        up = sum(1 for d in diffs if d > 0)
        down = sum(1 for d in diffs if d < 0)
        if up > down and total_change > 2:
            return "increasing"
        if down > up and total_change < -2:
            return "decreasing"
        return "stable"
