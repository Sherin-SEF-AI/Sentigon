"""Environmental Agent — Environmental hazard detection from sensors and cameras.

Monitors IoT sensor data (temperature, humidity, smoke, gas, water leak)
and analyses camera frames for visual hazards (smoke, fire, flooding).
Tracks environmental baselines per zone and alerts on threshold breaches.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_CORTEX,
    CH_PERCEPTIONS,
    CH_THREATS,
)

logger = logging.getLogger(__name__)

# ── Hazard types ──────────────────────────────────────────────────
VISUAL_HAZARD_TYPES = [
    "smoke",
    "fire_flame",
    "electrical_sparking",
    "water_flooding",
    "gas_fog",
    "structural_damage",
    "chemical_spill",
    "unusual_lighting",
]

IOT_SENSOR_TYPES = [
    "temperature",
    "humidity",
    "smoke_detector",
    "gas_detector",
    "water_leak",
]

# ── Sensor threshold defaults ────────────────────────────────────
_SENSOR_THRESHOLDS: dict[str, dict[str, float]] = {
    "temperature": {"warning": 35.0, "critical": 50.0},  # Celsius
    "humidity": {"warning": 80.0, "critical": 95.0},      # Percent
    "smoke_detector": {"warning": 0.5, "critical": 0.8},  # 0-1 normalized
    "gas_detector": {"warning": 0.3, "critical": 0.6},    # 0-1 normalized
    "water_leak": {"warning": 0.1, "critical": 0.5},      # 0-1 normalized
}

# Cooldown between alerts for the same hazard on the same camera
_HAZARD_COOLDOWN_SECONDS = 120


class EnvironmentalAgent(BaseAgent):
    """Environmental hazard detection agent.

    Combines IoT sensor monitoring with camera-based visual hazard
    detection.  Maintains rolling baselines per zone to distinguish
    genuine anomalies from normal fluctuations.
    """

    def __init__(self) -> None:
        super().__init__(
            name="environmental",
            role="Environmental Hazard Monitor",
            description=(
                "Monitors IoT sensor data (temperature, humidity, smoke, "
                "gas, water leak) and camera feeds for visual hazards "
                "(smoke, fire, flooding, electrical arcing). Tracks "
                "environmental baselines per zone and generates alerts "
                "when thresholds are breached."
            ),
            tier="perception",
            model_name="gemma3:4b",
            tool_names=[
                "capture_frame",
                "get_all_cameras_status",
                "analyze_frame_with_gemini",
                "analyze_frame_sequence_deep",
                "create_alert",
                "store_observation",
                "recall_observations",
                "get_site_context",
                "get_all_zones_status",
                "send_notification",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=30.0,
            token_budget_per_cycle=15000,
        )
        # Round-robin camera index
        self._camera_index: int = 0
        # Per-zone rolling baselines: zone_id -> {sensor_type -> [values]}
        self._baselines: dict[str, dict[str, list[float]]] = defaultdict(
            lambda: defaultdict(list)
        )
        self._baseline_window: int = 30  # keep last N readings
        # Cooldown tracker: "camera_id:hazard" -> ts
        self._last_hazard_alerts: dict[str, float] = {}

    # ── Core reasoning loop ───────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main environmental scanning cycle.

        1. Optionally process IoT sensor data from inbox messages.
        2. Select next camera (round-robin) and run visual hazard scan.
        3. Publish structured environmental_alert perceptions.
        """
        from backend.agents.agent_tools import TOOL_REGISTRY
        from backend.agents.agent_comms import agent_comms

        # ── 1. Process any IoT sensor data from inbox ─────────────
        inbox = context.get("inbox_messages", [])
        sensor_alerts = await self._process_sensor_data(inbox)

        # ── 2. Visual hazard scan via camera ──────────────────────
        try:
            cameras_result = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        except Exception as exc:
            logger.warning("environmental: camera status unavailable: %s", exc)
            return {"status": "idle", "reason": f"camera query failed: {exc}"}

        if not cameras_result.get("success"):
            return {"status": "idle", "reason": "no cameras available", "sensor_alerts": sensor_alerts}

        cameras = [
            c for c in cameras_result.get("cameras", [])
            if c.get("status") == "online"
        ]
        if not cameras:
            return {"status": "idle", "reason": "no online cameras", "sensor_alerts": sensor_alerts}

        if self._camera_index >= len(cameras):
            self._camera_index = 0
        camera = cameras[self._camera_index]
        self._camera_index += 1
        camera_id = camera["id"]

        # ── 3. LLM tool loop — visual hazard analysis ─────────────
        result = await self.execute_tool_loop(
            prompt=(
                f"You are an Environmental Hazard Monitor analyzing camera "
                f"{camera_id} ({camera.get('name', 'Unknown')}).\n\n"
                f"CRITICAL TASK: Scan the current frame for environmental hazards.\n"
                f"Use analyze_frame_with_gemini with this prompt:\n"
                f"'ENVIRONMENTAL HAZARD SCAN — Carefully analyze for:\n"
                f"1. SMOKE: Haze, wisps, or cloud formations (even subtle)\n"
                f"2. FIRE: Visible flames, glowing embers, fire reflections\n"
                f"3. ELECTRICAL: Sparking, arcing, exposed wiring, overheating\n"
                f"4. WATER/FLOODING: Water on floors, leaking pipes, wet surfaces\n"
                f"5. GAS/FOG: Unusual atmospheric conditions, visible vapor\n"
                f"6. STRUCTURAL: Cracks, collapse signs, damaged infrastructure\n"
                f"7. CHEMICAL: Spills, surface discoloration\n"
                f"8. LIGHTING: Flickering lights, unusual shadows\n"
                f"For each hazard: type, severity (1-10), confidence (0-1), "
                f"location in frame, recommended action.\n"
                f"If NO hazards detected, confirm all-clear.'\n\n"
                f"If severity >= 7, create a CRITICAL alert.\n"
                f"If severity 4-6, create a HIGH alert.\n"
                f"Always store observations for baseline tracking."
            ),
            context_data={
                "camera_id": camera_id,
                "task": "environmental_hazard_scan",
                "visual_hazard_types": VISUAL_HAZARD_TYPES,
                "iot_sensor_types": IOT_SENSOR_TYPES,
            },
        )

        # ── 4. Publish environmental perception ───────────────────
        if result.get("response"):
            now = datetime.now(timezone.utc)
            await agent_comms.publish(CH_PERCEPTIONS, {
                "agent": self.name,
                "type": "environmental_alert",
                "camera_id": camera_id,
                "zone_id": camera.get("zone_id", "unknown"),
                "analysis": result.get("response", ""),
                "sensor_alerts": sensor_alerts,
                "tool_calls": len(result.get("tool_calls", [])),
                "timestamp": now.isoformat(),
            })

        return {
            "status": "scanned",
            "camera": camera_id,
            "sensor_alerts": sensor_alerts,
        }

    # ── IoT sensor processing ────────────────────────────────────

    async def _process_sensor_data(
        self, inbox: list[dict],
    ) -> int:
        """Process IoT sensor readings from inbox messages.

        Returns the number of threshold-breach alerts generated.
        """
        from backend.agents.agent_comms import agent_comms

        alerts_generated = 0

        for msg in inbox:
            msg_type = msg.get("type", "")
            if msg_type != "sensor_reading":
                continue

            sensor_type = msg.get("sensor_type", "")
            value = msg.get("value")
            zone_id = msg.get("zone_id", "unknown")

            if sensor_type not in _SENSOR_THRESHOLDS or value is None:
                continue

            try:
                value = float(value)
            except (ValueError, TypeError):
                continue

            # Update rolling baseline
            baseline = self._baselines[zone_id][sensor_type]
            baseline.append(value)
            if len(baseline) > self._baseline_window:
                baseline.pop(0)

            # Check thresholds
            thresholds = _SENSOR_THRESHOLDS[sensor_type]
            severity = None
            if value >= thresholds["critical"]:
                severity = "critical"
            elif value >= thresholds["warning"]:
                severity = "high"

            if severity:
                avg_baseline = (
                    sum(baseline) / len(baseline) if baseline else value
                )
                await agent_comms.publish(CH_PERCEPTIONS, {
                    "agent": self.name,
                    "type": "environmental_alert",
                    "subtype": "sensor_threshold_breach",
                    "sensor_type": sensor_type,
                    "value": value,
                    "baseline_avg": round(avg_baseline, 2),
                    "severity": severity,
                    "zone_id": zone_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                alerts_generated += 1

                await self.log_action("sensor_alert", {
                    "sensor_type": sensor_type,
                    "value": value,
                    "severity": severity,
                    "zone_id": zone_id,
                })

        return alerts_generated

    # ── Helpers ───────────────────────────────────────────────────

    def _is_hazard_cooldown_active(
        self, camera_id: str, hazard_type: str,
    ) -> bool:
        """Check whether a recent alert was already raised."""
        key = f"{camera_id}:{hazard_type}"
        last_ts = self._last_hazard_alerts.get(key)
        if last_ts is None:
            return False
        return (time.time() - last_ts) < _HAZARD_COOLDOWN_SECONDS

    def _record_hazard_alert(
        self, camera_id: str, hazard_type: str,
    ) -> None:
        self._last_hazard_alerts[f"{camera_id}:{hazard_type}"] = time.time()
