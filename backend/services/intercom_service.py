"""
Intercom / VoIP integration service.
Supports SIP-based intercoms with door release, broadcast announcements,
and call management (initiate, answer, end, history).
"""
import asyncio
import logging
import time
import uuid
from typing import Optional, Dict, List, Any, Callable
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class IntercomState(Enum):
    IDLE = "idle"
    RINGING = "ringing"
    IN_CALL = "in_call"
    BROADCASTING = "broadcasting"
    OFFLINE = "offline"
    ERROR = "error"


class CallDirection(Enum):
    INBOUND = "inbound"
    OUTBOUND = "outbound"


@dataclass
class IntercomDevice:
    id: str
    name: str
    zone: str
    ip_address: str
    sip_uri: str
    state: IntercomState = IntercomState.OFFLINE
    has_door_release: bool = False
    has_camera: bool = False
    camera_id: Optional[str] = None
    volume: int = 75
    last_call_time: float = 0
    call_count: int = 0


@dataclass
class IntercomCall:
    call_id: str
    device_id: str
    caller: str
    callee: str
    state: IntercomState
    started_at: float
    ended_at: float = 0
    duration: float = 0
    direction: CallDirection = CallDirection.OUTBOUND
    recording_path: Optional[str] = None


class IntercomService:
    """Manages SIP-based intercom devices, calls, door release, and broadcast."""

    def __init__(self):
        self.devices: Dict[str, IntercomDevice] = {}
        self.active_calls: Dict[str, IntercomCall] = {}
        self.call_history: List[IntercomCall] = []
        self.max_history = 10000
        self._callbacks: List[Callable] = []
        self._stats = {
            "total_calls": 0,
            "active_calls": 0,
            "door_releases": 0,
            "broadcasts": 0,
        }

    # ── Device management ─────────────────────────────────────────

    def register_device(self, device: IntercomDevice):
        """Register an intercom device with the system."""
        self.devices[device.id] = device
        device.state = IntercomState.IDLE
        logger.info("Registered intercom device: %s (%s) at %s", device.name, device.id, device.sip_uri)

    def get_device(self, device_id: str) -> Optional[IntercomDevice]:
        """Return a single device by ID, or None."""
        return self.devices.get(device_id)

    def list_devices(self) -> List[Dict[str, Any]]:
        """Return all registered devices as serialisable dicts."""
        return [
            {
                "id": d.id,
                "name": d.name,
                "zone": d.zone,
                "ip_address": d.ip_address,
                "sip_uri": d.sip_uri,
                "state": d.state.value,
                "has_door_release": d.has_door_release,
                "has_camera": d.has_camera,
                "camera_id": d.camera_id,
                "volume": d.volume,
                "last_call_time": d.last_call_time,
                "call_count": d.call_count,
            }
            for d in self.devices.values()
        ]

    # ── Call management ───────────────────────────────────────────

    async def initiate_call(self, device_id: str, caller: str) -> Optional[IntercomCall]:
        """Start an outbound call to a device."""
        device = self.devices.get(device_id)
        if not device:
            logger.warning("Call initiation failed — device %s not found", device_id)
            return None

        if device.state not in (IntercomState.IDLE, IntercomState.OFFLINE):
            logger.warning("Call initiation failed — device %s is %s", device_id, device.state.value)
            return None

        call = IntercomCall(
            call_id=f"call_{uuid.uuid4().hex[:12]}",
            device_id=device_id,
            caller=caller,
            callee=device.sip_uri,
            state=IntercomState.RINGING,
            started_at=time.time(),
            direction=CallDirection.OUTBOUND,
        )

        device.state = IntercomState.RINGING
        self.active_calls[device_id] = call
        self._stats["total_calls"] += 1
        self._stats["active_calls"] = len(self.active_calls)

        logger.info("Call %s initiated to %s by %s", call.call_id, device.name, caller)
        await self._notify("call_initiated", call)
        return call

    async def answer_call(self, device_id: str) -> Optional[IntercomCall]:
        """Answer a ringing call on a device."""
        call = self.active_calls.get(device_id)
        if not call:
            logger.warning("Answer failed — no active call on device %s", device_id)
            return None

        device = self.devices.get(device_id)
        if not device:
            return None

        call.state = IntercomState.IN_CALL
        device.state = IntercomState.IN_CALL

        logger.info("Call %s answered on %s", call.call_id, device.name)
        await self._notify("call_answered", call)
        return call

    async def end_call(self, device_id: str) -> Optional[IntercomCall]:
        """End the active or ringing call on a device."""
        call = self.active_calls.pop(device_id, None)
        if not call:
            logger.warning("End call failed — no active call on device %s", device_id)
            return None

        device = self.devices.get(device_id)
        now = time.time()

        call.ended_at = now
        call.duration = now - call.started_at
        call.state = IntercomState.IDLE

        if device:
            device.state = IntercomState.IDLE
            device.last_call_time = now
            device.call_count += 1

        self.call_history.append(call)
        if len(self.call_history) > self.max_history:
            self.call_history = self.call_history[-self.max_history:]

        self._stats["active_calls"] = len(self.active_calls)

        logger.info("Call %s ended on %s (%.1fs)", call.call_id, device_id, call.duration)
        await self._notify("call_ended", call)
        return call

    # ── Door release ──────────────────────────────────────────────

    async def door_release(self, device_id: str) -> bool:
        """Trigger the door release relay on a device."""
        device = self.devices.get(device_id)
        if not device:
            logger.warning("Door release failed — device %s not found", device_id)
            return False

        if not device.has_door_release:
            logger.warning("Door release failed — device %s has no door release", device_id)
            return False

        # In production this would send a SIP INFO or DTMF tone to the device
        self._stats["door_releases"] += 1
        logger.info("Door release triggered on %s (%s)", device.name, device_id)
        await self._notify("door_release", {"device_id": device_id, "device_name": device.name})
        return True

    # ── Broadcast ─────────────────────────────────────────────────

    async def broadcast(
        self,
        message: str,
        zone: Optional[str] = None,
        device_ids: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Broadcast an announcement to devices.
        If *device_ids* is provided those devices are targeted;
        otherwise all devices in *zone* are targeted (or all devices if zone is None).
        """
        targets: List[IntercomDevice] = []

        if device_ids:
            for did in device_ids:
                dev = self.devices.get(did)
                if dev:
                    targets.append(dev)
        elif zone:
            targets = [d for d in self.devices.values() if d.zone == zone]
        else:
            targets = list(self.devices.values())

        if not targets:
            logger.warning("Broadcast skipped — no target devices resolved")
            return {"sent": False, "target_count": 0, "reason": "no matching devices"}

        succeeded: List[str] = []
        failed: List[str] = []

        for device in targets:
            if device.state == IntercomState.OFFLINE:
                failed.append(device.id)
                continue
            prev_state = device.state
            device.state = IntercomState.BROADCASTING
            # In production: stream TTS audio to the device via SIP multicast/RTP
            device.state = prev_state if prev_state != IntercomState.BROADCASTING else IntercomState.IDLE
            succeeded.append(device.id)

        self._stats["broadcasts"] += 1
        logger.info(
            "Broadcast to %d devices (zone=%s): %d ok, %d failed",
            len(targets), zone, len(succeeded), len(failed),
        )
        await self._notify("broadcast", {"message": message, "zone": zone, "succeeded": succeeded, "failed": failed})

        return {
            "sent": True,
            "message": message,
            "zone": zone,
            "target_count": len(targets),
            "succeeded": succeeded,
            "failed": failed,
        }

    # ── Volume ────────────────────────────────────────────────────

    async def set_volume(self, device_id: str, level: int) -> bool:
        """Set the speaker volume on a device (0-100)."""
        device = self.devices.get(device_id)
        if not device:
            logger.warning("Set volume failed — device %s not found", device_id)
            return False

        level = max(0, min(100, level))
        device.volume = level
        logger.info("Volume on %s set to %d", device.name, level)
        return True

    # ── History & status ──────────────────────────────────────────

    def get_call_history(
        self,
        device_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Return recent call history, optionally filtered by device."""
        calls = self.call_history
        if device_id:
            calls = [c for c in calls if c.device_id == device_id]
        return [
            {
                "call_id": c.call_id,
                "device_id": c.device_id,
                "caller": c.caller,
                "callee": c.callee,
                "state": c.state.value,
                "started_at": c.started_at,
                "ended_at": c.ended_at,
                "duration": round(c.duration, 2),
                "direction": c.direction.value,
                "recording_path": c.recording_path,
            }
            for c in calls[-limit:]
        ]

    def get_status(self) -> Dict[str, Any]:
        """Return overall intercom system status."""
        return {
            "device_count": len(self.devices),
            "devices_online": sum(
                1 for d in self.devices.values() if d.state != IntercomState.OFFLINE
            ),
            "active_calls": {
                did: {
                    "call_id": c.call_id,
                    "caller": c.caller,
                    "callee": c.callee,
                    "state": c.state.value,
                    "started_at": c.started_at,
                    "direction": c.direction.value,
                }
                for did, c in self.active_calls.items()
            },
            "stats": self._stats,
        }

    # ── Internal helpers ──────────────────────────────────────────

    def on_event(self, callback: Callable):
        """Register a callback for intercom events."""
        self._callbacks.append(callback)

    async def _notify(self, event_type: str, data: Any):
        """Fire registered callbacks."""
        for cb in self._callbacks:
            try:
                if asyncio.iscoroutinefunction(cb):
                    await cb(event_type, data)
                else:
                    cb(event_type, data)
            except Exception as e:
                logger.error("Intercom callback error: %s", e)


intercom_service = IntercomService()
