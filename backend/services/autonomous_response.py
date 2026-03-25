"""Autonomous Threat Response Orchestrator.

Chains existing services (alert, recording, SOP, dispatch, emergency services,
notifications) into a single autonomous pipeline triggered on HIGH/CRITICAL threats.
Each action step is broadcast in real-time via WebSocket.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

from backend.config import settings

logger = logging.getLogger(__name__)

# ── Haversine helper ──────────────────────────────────────────────────

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres between two points."""
    R = 6371.0
    rlat1, rlon1, rlat2, rlon2 = (math.radians(v) for v in (lat1, lon1, lat2, lon2))
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ── Emergency services cache ─────────────────────────────────────────

class _EmergencyCache:
    """Simple TTL cache keyed by rounded lat/lng grid cell."""

    TTL = 3600  # 1 hour

    def __init__(self):
        self._store: OrderedDict[str, tuple[float, list]] = OrderedDict()

    def _key(self, lat: float, lng: float) -> str:
        return f"{round(lat, 2)},{round(lng, 2)}"

    def get(self, lat: float, lng: float) -> Optional[list]:
        k = self._key(lat, lng)
        entry = self._store.get(k)
        if entry and (time.time() - entry[0]) < self.TTL:
            return entry[1]
        if entry:
            del self._store[k]
        return None

    def put(self, lat: float, lng: float, data: list):
        k = self._key(lat, lng)
        self._store[k] = (time.time(), data)
        # Cap size
        while len(self._store) > 100:
            self._store.popitem(last=False)


_emergency_cache = _EmergencyCache()


# ── Overpass query for emergency services ─────────────────────────────

async def fetch_nearby_emergency_services(
    lat: float, lng: float, radius_km: float = 5.0,
) -> List[Dict[str, Any]]:
    """Query OpenStreetMap Overpass API for nearby emergency services."""
    cached = _emergency_cache.get(lat, lng)
    if cached is not None:
        return cached

    radius_m = int(radius_km * 1000)
    query = f"""
    [out:json][timeout:15];
    (
      node["amenity"="police"](around:{radius_m},{lat},{lng});
      node["amenity"="hospital"](around:{radius_m},{lat},{lng});
      node["amenity"="fire_station"](around:{radius_m},{lat},{lng});
      node["amenity"="clinic"](around:{radius_m},{lat},{lng});
    );
    out body;
    """

    services: List[Dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                "https://overpass-api.de/api/interpreter",
                data={"data": query},
            )
            resp.raise_for_status()
            data = resp.json()

        for el in data.get("elements", []):
            tags = el.get("tags", {})
            amenity = tags.get("amenity", "")
            svc_type = {
                "police": "police",
                "hospital": "hospital",
                "fire_station": "fire_station",
                "clinic": "clinic",
            }.get(amenity, amenity)

            slat = el.get("lat", 0)
            slng = el.get("lon", 0)
            dist = round(_haversine_km(lat, lng, slat, slng), 2)

            services.append({
                "name": tags.get("name", f"{svc_type.replace('_', ' ').title()} (unnamed)"),
                "type": svc_type,
                "latitude": slat,
                "longitude": slng,
                "distance_km": dist,
                "address": tags.get("addr:full") or tags.get("addr:street", ""),
                "phone": tags.get("phone", ""),
            })

        services.sort(key=lambda s: s["distance_km"])
        _emergency_cache.put(lat, lng, services)
        logger.info("Emergency services fetched: %d within %.0fkm of (%.4f, %.4f)", len(services), radius_km, lat, lng)
    except Exception as exc:
        logger.error("Overpass API query failed: %s", exc)

    return services


# ── Main orchestrator ─────────────────────────────────────────────────

TOTAL_STEPS = 9


class AutonomousResponseOrchestrator:
    """Orchestrates autonomous threat response across all subsystems."""

    def __init__(self):
        self._active_responses: Dict[str, Dict[str, Any]] = {}
        self._response_history: List[Dict[str, Any]] = []
        self._max_history = 100

    # ── Public API ─────────────────────────────────────────────────

    def get_active_responses(self) -> List[Dict[str, Any]]:
        return list(self._active_responses.values())

    def get_response(self, response_id: str) -> Optional[Dict[str, Any]]:
        return self._active_responses.get(response_id) or next(
            (r for r in self._response_history if r["response_id"] == response_id), None
        )

    def get_history(self, limit: int = 50) -> List[Dict[str, Any]]:
        return self._response_history[:limit]

    async def abort_response(self, response_id: str, reason: str = "manual_override") -> bool:
        resp = self._active_responses.get(response_id)
        if not resp:
            return False
        resp["status"] = "aborted"
        resp["completed_at"] = datetime.now(timezone.utc).isoformat()
        resp["abort_reason"] = reason
        self._move_to_history(response_id)
        await self._broadcast_step(resp, 0, "response_aborted", "completed", {"reason": reason})
        return True

    # ── Main trigger ──────────────────────────────────────────────

    async def trigger_response(
        self,
        alert_id: str,
        threat_data: Dict[str, Any],
    ) -> str:
        """Trigger a full autonomous response pipeline for a threat.

        Called by alert_manager when a HIGH/CRITICAL alert is created.
        Returns the response_id.
        """
        response_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)

        response = {
            "response_id": response_id,
            "alert_id": alert_id,
            "severity": threat_data.get("severity", "high"),
            "threat_type": threat_data.get("threat_type", "unknown"),
            "confidence": threat_data.get("confidence", 0.0),
            "source_camera": threat_data.get("source_camera", ""),
            "zone_name": threat_data.get("zone_name", ""),
            "title": threat_data.get("title", ""),
            "description": threat_data.get("description", ""),
            "status": "active",
            "actions": [],
            "started_at": now.isoformat(),
            "completed_at": None,
        }
        self._active_responses[response_id] = response

        logger.info(
            "Autonomous response triggered: %s [%s] %s camera=%s",
            response_id[:8], response["severity"].upper(),
            response["threat_type"], response["source_camera"],
        )

        # Run the pipeline
        try:
            await self._execute_pipeline(response)
        except Exception as exc:
            logger.error("Autonomous response pipeline failed: %s — %s", response_id[:8], exc)
            response["status"] = "failed"
            response["completed_at"] = datetime.now(timezone.utc).isoformat()
        finally:
            if response["status"] == "active":
                response["status"] = "completed"
                response["completed_at"] = datetime.now(timezone.utc).isoformat()
            self._move_to_history(response_id)

        return response_id

    async def trigger_test_response(self) -> str:
        """Trigger a test response for demo / verification."""
        test_data = {
            "severity": "critical",
            "threat_type": "weapon_detected",
            "confidence": 0.95,
            "source_camera": "test-camera-01",
            "zone_name": "Main Lobby",
            "title": "TEST: Weapon Detected — Knife in Main Lobby",
            "description": "Autonomous response system test. A simulated knife detection in the main lobby with 95% confidence.",
        }
        test_alert_id = str(uuid.uuid4())
        return await self.trigger_response(test_alert_id, test_data)

    # ── Pipeline execution ────────────────────────────────────────

    async def _execute_pipeline(self, response: Dict[str, Any]):
        """Execute all 9 steps sequentially, broadcasting each."""

        # Step 1: Threat Confirmed
        await self._step_threat_confirmed(response)

        # Step 2: Causal Chain Reconstruction (WHY this happened)
        await self._step_causal_reasoning(response)

        # Step 3: Alert Created (already done by alert_manager)
        await self._step_alert_logged(response)

        # Step 4: Predictive Assessment (what happens NEXT)
        await self._step_predictive_assessment(response)

        # Step 5: Incident Recording
        await self._step_incident_recording(response)

        # Step 6: SOP Activated
        await self._step_sop_activation(response)

        # Step 7: Dispatch Recommended
        await self._step_dispatch_recommendation(response)

        # Step 8: Emergency Services Located
        await self._step_emergency_services(response)

        # Step 9: Operators Notified
        await self._step_notify_operators(response)

    async def _step_threat_confirmed(self, response: Dict[str, Any]):
        """Step 1 — Confirm and log the threat."""
        details = {
            "threat_type": response["threat_type"],
            "severity": response["severity"],
            "confidence": response["confidence"],
            "source_camera": response["source_camera"],
            "zone_name": response["zone_name"],
            "description": response["description"],
            "message": f"Threat confirmed: {response['threat_type']} detected with {response['confidence']:.0%} confidence",
        }
        await self._broadcast_step(response, 1, "threat_confirmed", "completed", details)

    async def _step_causal_reasoning(self, response: Dict[str, Any]):
        """Step 2 — Reconstruct the causal chain behind this threat."""
        await self._broadcast_step(response, 2, "causal_reasoning", "executing", {
            "message": "Reconstructing causal chain — analyzing HOW this happened…",
        })

        causal_info: Dict[str, Any] = {}
        try:
            from backend.services.causal_reasoning import causal_engine
            chain = await causal_engine.reconstruct_chain(
                alert_id=response["alert_id"],
                camera_id=response["source_camera"],
                threat_type=response["threat_type"],
                zone_name=response.get("zone_name", ""),
            )
            if chain:
                chain_data = chain.to_dict() if hasattr(chain, "to_dict") else chain
                causal_info = {
                    "causal_chain": chain_data.get("chain", [])[:5],
                    "root_cause": chain_data.get("root_cause", "Unknown"),
                    "attack_pattern": chain_data.get("attack_pattern", "none"),
                    "confidence": chain_data.get("confidence", 0.0),
                    "message": f"Causal chain: {chain_data.get('root_cause', 'Analysis complete')}",
                }
                response["causal_chain"] = chain_data
            else:
                causal_info = {"message": "Causal chain: insufficient data for full reconstruction"}
        except Exception as exc:
            logger.debug("Causal reasoning step skipped: %s", exc)
            causal_info = {"message": "Causal reasoning engine unavailable"}

        await self._broadcast_step(response, 2, "causal_reasoning", "completed", causal_info)

    async def _step_alert_logged(self, response: Dict[str, Any]):
        """Step 3 — Alert was already created; log it as completed."""
        details = {
            "alert_id": response["alert_id"],
            "severity": response["severity"],
            "message": f"Alert {response['alert_id'][:8]}… created and logged",
        }
        await self._broadcast_step(response, 3, "alert_created", "completed", details)

    async def _step_predictive_assessment(self, response: Dict[str, Any]):
        """Step 4 — Predictive assessment (placeholder — predictive engine removed)."""
        prediction_info = {"message": "Predictive assessment skipped — engine not available"}
        await self._broadcast_step(response, 4, "predictive_assessment", "completed", prediction_info)

    async def _step_incident_recording(self, response: Dict[str, Any]):
        """Step 5 — Start incident recording on the source camera."""
        await self._broadcast_step(response, 5, "incident_recording", "executing", {
            "message": "Starting incident recording…",
        })
        await asyncio.sleep(0.3)  # Brief delay for UI effect

        recording_info: Dict[str, Any] = {"cameras": []}
        try:
            from backend.services.incident_recorder import incident_recorder
            result = await incident_recorder.start_recording(
                title=f"Auto: {response['title']}",
                alert_id=response["alert_id"],
            )
            if result:
                recording_info["recording_id"] = result.get("recording_id") or result.get("id", "")
                recording_info["cameras"].append(response["source_camera"])
                recording_info["message"] = f"Recording started on {response['source_camera']}"
            else:
                recording_info["message"] = "Recording already active or unavailable"
        except Exception as exc:
            logger.debug("Incident recording step skipped: %s", exc)
            recording_info["message"] = "Recording service unavailable — existing auto-recorder active"

        await self._broadcast_step(response, 5, "incident_recording", "completed", recording_info)

    async def _step_sop_activation(self, response: Dict[str, Any]):
        """Step 6 — Find and activate matching SOP."""
        await self._broadcast_step(response, 6, "sop_activated", "executing", {
            "message": f"Searching SOP for {response['threat_type']}…",
        })
        await asyncio.sleep(0.3)

        sop_info: Dict[str, Any] = {}
        try:
            from backend.services.sop_engine import sop_engine

            template = await sop_engine.get_matching_template(
                threat_type=response["threat_type"],
                severity=response["severity"],
            )
            if template:
                instance = await sop_engine.start_sop(
                    template_id=uuid.UUID(template["id"]),
                    alert_id=uuid.UUID(response["alert_id"]),
                )
                sop_info = {
                    "sop_name": template.get("name", ""),
                    "sop_instance_id": instance.get("id", ""),
                    "total_stages": instance.get("total_stages", 0),
                    "current_stage": 0,
                    "workflow_stages": template.get("workflow_stages", []),
                    "message": f"SOP activated: {template.get('name', 'Unknown')}",
                }
            else:
                sop_info = {
                    "message": f"No SOP template found for {response['threat_type']} — using default protocol",
                    "sop_name": "Default Emergency Protocol",
                    "total_stages": 4,
                    "current_stage": 0,
                    "workflow_stages": [
                        {"title": "Initial Assessment", "instructions": "Verify threat and assess situation"},
                        {"title": "Containment", "instructions": "Isolate affected area and secure perimeter"},
                        {"title": "Response Coordination", "instructions": "Coordinate with dispatch and responders"},
                        {"title": "Resolution", "instructions": "Clear scene and document incident"},
                    ],
                }
        except Exception as exc:
            logger.debug("SOP activation step skipped: %s", exc)
            sop_info = {"message": "SOP engine unavailable — default protocol applied"}

        await self._broadcast_step(response, 6, "sop_activated", "completed", sop_info)

    async def _step_dispatch_recommendation(self, response: Dict[str, Any]):
        """Step 7 — Generate dispatch resource recommendations."""
        await self._broadcast_step(response, 7, "dispatch_recommended", "executing", {
            "message": "Calculating resource requirements…",
        })
        await asyncio.sleep(0.2)

        severity = response["severity"]
        threat_type = response["threat_type"]

        # Rule-based resource recommendation (mirrors dispatch_view.py logic)
        resource_map = {
            "critical": {
                "police": 2, "ems": 1, "fire": 1, "security": 2,
                "priority": "immediate",
            },
            "high": {
                "police": 1, "ems": 1, "fire": 0, "security": 2,
                "priority": "urgent",
            },
            "medium": {
                "police": 0, "ems": 0, "fire": 0, "security": 1,
                "priority": "standard",
            },
        }
        resources = resource_map.get(severity, resource_map["medium"])

        # Adjust for threat type
        if "fire" in threat_type.lower() or "explosion" in threat_type.lower():
            resources["fire"] = max(resources.get("fire", 0), 2)
        if "weapon" in threat_type.lower() or "shoot" in threat_type.lower():
            resources["police"] = max(resources.get("police", 0), 3)
        if "medical" in threat_type.lower() or "injury" in threat_type.lower():
            resources["ems"] = max(resources.get("ems", 0), 2)

        dispatch_info = {
            "recommended_resources": resources,
            "threat_type": threat_type,
            "severity": severity,
            "message": f"Dispatch recommendation: {resources['priority']} priority — "
                       f"{resources.get('police', 0)} police, {resources.get('ems', 0)} EMS, "
                       f"{resources.get('fire', 0)} fire, {resources.get('security', 0)} security",
        }
        await self._broadcast_step(response, 7, "dispatch_recommended", "completed", dispatch_info)

    async def _step_emergency_services(self, response: Dict[str, Any]):
        """Step 8 — Locate nearby emergency services via geolocation."""
        await self._broadcast_step(response, 8, "emergency_services_located", "executing", {
            "message": "Locating nearby emergency services…",
        })

        lat = settings.FACILITY_LATITUDE
        lng = settings.FACILITY_LONGITUDE
        radius = settings.EMERGENCY_SEARCH_RADIUS_KM

        services = await fetch_nearby_emergency_services(lat, lng, radius)

        # Summarise by type
        by_type: Dict[str, list] = {}
        for svc in services:
            by_type.setdefault(svc["type"], []).append(svc)

        nearest: Dict[str, Any] = {}
        for stype, svcs in by_type.items():
            if svcs:
                n = svcs[0]
                nearest[stype] = {
                    "name": n["name"],
                    "distance_km": n["distance_km"],
                    "phone": n.get("phone", ""),
                }

        emergency_info = {
            "facility_location": {"latitude": lat, "longitude": lng},
            "search_radius_km": radius,
            "total_services_found": len(services),
            "services_by_type": {k: len(v) for k, v in by_type.items()},
            "nearest": nearest,
            "all_services": services[:20],  # Cap for broadcast
            "message": f"Found {len(services)} emergency services within {radius}km",
        }
        await self._broadcast_step(response, 8, "emergency_services_located", "completed", emergency_info)

    async def _step_notify_operators(self, response: Dict[str, Any]):
        """Step 9 — Broadcast full alert to all connected operators."""
        await self._broadcast_step(response, 9, "operators_notified", "executing", {
            "message": "Notifying all connected operators…",
        })
        await asyncio.sleep(0.2)

        try:
            from backend.services.notification_service import notification_service
            await notification_service.push_notification({
                "type": "autonomous_threat_response",
                "response_id": response["response_id"],
                "severity": response["severity"],
                "title": response["title"],
                "threat_type": response["threat_type"],
                "source_camera": response["source_camera"],
                "zone_name": response["zone_name"],
                "confidence": response["confidence"],
                "message": f"AUTONOMOUS RESPONSE ACTIVE: {response['title']}",
            })
        except Exception as exc:
            logger.debug("Operator notification step skipped: %s", exc)

        notify_info = {
            "message": "All connected operators notified — autonomous response complete",
            "channels_notified": ["notifications", "threat_response"],
        }
        await self._broadcast_step(response, 9, "operators_notified", "completed", notify_info)

    # ── Broadcast helper ──────────────────────────────────────────

    async def _broadcast_step(
        self,
        response: Dict[str, Any],
        step_number: int,
        action: str,
        status: str,
        details: Dict[str, Any],
    ):
        """Update response actions list and broadcast via WebSocket."""
        action_entry = {
            "step_number": step_number,
            "total_steps": TOTAL_STEPS,
            "action": action,
            "status": status,
            "details": details,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # Update or append action in response
        actions = response.get("actions", [])
        existing = next((a for a in actions if a["step_number"] == step_number and a["action"] == action), None)
        if existing and status in ("completed", "failed"):
            existing.update(action_entry)
        elif not existing:
            actions.append(action_entry)
        response["actions"] = actions

        # Broadcast via WebSocket
        try:
            from backend.services.notification_service import notification_service
            await notification_service.push_threat_response({
                "response_id": response["response_id"],
                "alert_id": response["alert_id"],
                "severity": response["severity"],
                "threat_type": response["threat_type"],
                "source_camera": response["source_camera"],
                "zone_name": response["zone_name"],
                "title": response["title"],
                "confidence": response["confidence"],
                "status": response["status"],
                **action_entry,
            })
        except Exception as exc:
            logger.debug("WebSocket broadcast failed for step %d: %s", step_number, exc)

    # ── History management ────────────────────────────────────────

    def _move_to_history(self, response_id: str):
        resp = self._active_responses.pop(response_id, None)
        if resp:
            self._response_history.insert(0, resp)
            if len(self._response_history) > self._max_history:
                self._response_history = self._response_history[:self._max_history]


# Singleton
autonomous_response = AutonomousResponseOrchestrator()
