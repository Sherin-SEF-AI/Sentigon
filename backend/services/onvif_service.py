"""
Real ONVIF camera integration service.
Supports device discovery via WS-Discovery, PTZ control, event subscriptions,
media profile management, and snapshot retrieval.
"""
import asyncio
import logging
import time
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field
from enum import Enum
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


@dataclass
class ONVIFDevice:
    """Represents a discovered or configured ONVIF device."""
    ip: str
    port: int = 80
    username: str = "admin"
    password: str = "admin"
    name: str = ""
    manufacturer: str = ""
    model: str = ""
    firmware: str = ""
    serial: str = ""
    hardware_id: str = ""
    profiles: List[Dict[str, Any]] = field(default_factory=list)
    ptz_supported: bool = False
    analytics_supported: bool = False
    events_supported: bool = False
    is_connected: bool = False
    last_seen: float = 0
    stream_uris: Dict[str, str] = field(default_factory=dict)
    ptz_presets: List[Dict[str, Any]] = field(default_factory=list)


class PTZDirection(Enum):
    UP = "up"
    DOWN = "down"
    LEFT = "left"
    RIGHT = "right"
    UP_LEFT = "up_left"
    UP_RIGHT = "up_right"
    DOWN_LEFT = "down_left"
    DOWN_RIGHT = "down_right"
    ZOOM_IN = "zoom_in"
    ZOOM_OUT = "zoom_out"


class ONVIFService:
    """Full ONVIF camera management service."""

    def __init__(self):
        self.devices: Dict[str, ONVIFDevice] = {}
        self._discovery_running = False
        self._event_listeners: Dict[str, asyncio.Task] = {}
        self._onvif_cameras: Dict[str, Any] = {}

    async def discover_devices(self, timeout: int = 5) -> List[ONVIFDevice]:
        """Discover ONVIF devices on the network using WS-Discovery."""
        discovered = []
        try:
            from wsdiscovery import WSDiscovery
            wsd = WSDiscovery()
            wsd.start()
            services = wsd.searchServices(
                types=["{http://www.onvif.org/ver10/network/wsdl}NetworkVideoTransmitter"],
                timeout=timeout,
            )
            for service in services:
                for xaddr in service.getXAddrs():
                    parsed = urlparse(xaddr)
                    ip = parsed.hostname
                    port = parsed.port or 80
                    key = f"{ip}:{port}"
                    if key not in self.devices:
                        device = ONVIFDevice(ip=ip, port=port, last_seen=time.time())
                        device.name = f"ONVIF Camera at {ip}"
                        self.devices[key] = device
                        discovered.append(device)
                        logger.info("Discovered ONVIF device at %s:%d", ip, port)
                    else:
                        self.devices[key].last_seen = time.time()
            wsd.stop()
        except ImportError:
            logger.warning("wsdiscovery not installed — network discovery unavailable")
        except Exception as e:
            logger.error("ONVIF discovery error: %s", e)
        return discovered

    async def connect_device(self, ip: str, port: int = 80,
                              username: str = "admin", password: str = "admin") -> ONVIFDevice:
        """Connect to a specific ONVIF device and retrieve its capabilities."""
        key = f"{ip}:{port}"
        try:
            from onvif import ONVIFCamera
            cam = ONVIFCamera(ip, port, username, password)
            await asyncio.get_event_loop().run_in_executor(None, cam.update_xaddrs)
            self._onvif_cameras[key] = cam

            devicemgmt = cam.create_devicemgmt_service()
            info = await asyncio.get_event_loop().run_in_executor(None, devicemgmt.GetDeviceInformation)

            device = self.devices.get(key, ONVIFDevice(ip=ip, port=port))
            device.username = username
            device.password = password
            device.manufacturer = getattr(info, "Manufacturer", "Unknown")
            device.model = getattr(info, "Model", "Unknown")
            device.firmware = getattr(info, "FirmwareVersion", "Unknown")
            device.serial = getattr(info, "SerialNumber", "Unknown")
            device.hardware_id = getattr(info, "HardwareId", "Unknown")
            device.name = f"{device.manufacturer} {device.model}"
            device.is_connected = True
            device.last_seen = time.time()

            capabilities = await asyncio.get_event_loop().run_in_executor(None, devicemgmt.GetCapabilities)
            device.ptz_supported = hasattr(capabilities, "PTZ") and capabilities.PTZ is not None
            device.analytics_supported = hasattr(capabilities, "Analytics") and capabilities.Analytics is not None
            device.events_supported = hasattr(capabilities, "Events") and capabilities.Events is not None

            # Media profiles
            media_service = cam.create_media_service()
            profiles = await asyncio.get_event_loop().run_in_executor(None, media_service.GetProfiles)
            device.profiles = []
            device.stream_uris = {}
            for profile in profiles:
                token = profile.token
                profile_info = {"token": token, "name": profile.Name, "video_encoder": None, "resolution": None, "fps": None}
                if hasattr(profile, "VideoEncoderConfiguration") and profile.VideoEncoderConfiguration:
                    vec = profile.VideoEncoderConfiguration
                    profile_info["video_encoder"] = vec.Encoding
                    if hasattr(vec, "Resolution") and vec.Resolution:
                        profile_info["resolution"] = f"{vec.Resolution.Width}x{vec.Resolution.Height}"
                    if hasattr(vec, "RateControl") and vec.RateControl:
                        profile_info["fps"] = vec.RateControl.FrameRateLimit
                device.profiles.append(profile_info)
                try:
                    stream_setup = media_service.create_type("GetStreamUri")
                    stream_setup.ProfileToken = token
                    stream_setup.StreamSetup = {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}}
                    uri_response = await asyncio.get_event_loop().run_in_executor(None, media_service.GetStreamUri, stream_setup)
                    device.stream_uris[token] = uri_response.Uri
                except Exception as e:
                    logger.warning("Failed to get stream URI for profile %s: %s", token, e)

            # PTZ presets
            if device.ptz_supported and device.profiles:
                try:
                    ptz_service = cam.create_ptz_service()
                    presets = await asyncio.get_event_loop().run_in_executor(
                        None, ptz_service.GetPresets, {"ProfileToken": device.profiles[0]["token"]}
                    )
                    device.ptz_presets = [
                        {"token": p.token, "name": getattr(p, "Name", f"Preset {p.token}")}
                        for p in (presets or [])
                    ]
                except Exception as e:
                    logger.warning("Failed to get PTZ presets: %s", e)

            self.devices[key] = device
            logger.info("Connected to ONVIF device: %s (%s:%d)", device.name, ip, port)
            return device
        except ImportError:
            logger.error("onvif-zeep not installed. Install with: pip install onvif-zeep")
            raise RuntimeError("ONVIF library not available")
        except Exception as e:
            logger.error("Failed to connect to ONVIF device at %s:%d: %s", ip, port, e)
            raise

    async def ptz_move(self, ip: str, port: int, direction: PTZDirection,
                        speed: float = 0.5, profile_token: str = None) -> bool:
        key = f"{ip}:{port}"
        cam = self._onvif_cameras.get(key)
        if not cam:
            raise ValueError(f"Device {key} not connected")
        device = self.devices[key]
        if not device.ptz_supported:
            raise ValueError(f"Device {key} does not support PTZ")
        if not profile_token and device.profiles:
            profile_token = device.profiles[0]["token"]
        try:
            ptz_service = cam.create_ptz_service()
            pan, tilt, zoom = 0.0, 0.0, 0.0
            if direction in (PTZDirection.LEFT, PTZDirection.UP_LEFT, PTZDirection.DOWN_LEFT):
                pan = -speed
            elif direction in (PTZDirection.RIGHT, PTZDirection.UP_RIGHT, PTZDirection.DOWN_RIGHT):
                pan = speed
            if direction in (PTZDirection.UP, PTZDirection.UP_LEFT, PTZDirection.UP_RIGHT):
                tilt = speed
            elif direction in (PTZDirection.DOWN, PTZDirection.DOWN_LEFT, PTZDirection.DOWN_RIGHT):
                tilt = -speed
            if direction == PTZDirection.ZOOM_IN:
                zoom = speed
            elif direction == PTZDirection.ZOOM_OUT:
                zoom = -speed
            request = ptz_service.create_type("ContinuousMove")
            request.ProfileToken = profile_token
            request.Velocity = {"PanTilt": {"x": pan, "y": tilt}, "Zoom": {"x": zoom}}
            await asyncio.get_event_loop().run_in_executor(None, ptz_service.ContinuousMove, request)
            logger.info("PTZ move %s on %s", direction.value, key)
            return True
        except Exception as e:
            logger.error("PTZ move failed on %s: %s", key, e)
            return False

    async def ptz_stop(self, ip: str, port: int, profile_token: str = None) -> bool:
        key = f"{ip}:{port}"
        cam = self._onvif_cameras.get(key)
        if not cam:
            return False
        device = self.devices[key]
        if not profile_token and device.profiles:
            profile_token = device.profiles[0]["token"]
        try:
            ptz_service = cam.create_ptz_service()
            ptz_service.Stop({"ProfileToken": profile_token, "PanTilt": True, "Zoom": True})
            return True
        except Exception as e:
            logger.error("PTZ stop failed: %s", e)
            return False

    async def ptz_goto_preset(self, ip: str, port: int, preset_token: str,
                               speed: float = 1.0, profile_token: str = None) -> bool:
        key = f"{ip}:{port}"
        cam = self._onvif_cameras.get(key)
        if not cam:
            return False
        device = self.devices[key]
        if not profile_token and device.profiles:
            profile_token = device.profiles[0]["token"]
        try:
            ptz_service = cam.create_ptz_service()
            request = ptz_service.create_type("GotoPreset")
            request.ProfileToken = profile_token
            request.PresetToken = preset_token
            request.Speed = {"PanTilt": {"x": speed, "y": speed}, "Zoom": {"x": speed}}
            await asyncio.get_event_loop().run_in_executor(None, ptz_service.GotoPreset, request)
            return True
        except Exception as e:
            logger.error("PTZ goto preset failed: %s", e)
            return False

    async def ptz_set_preset(self, ip: str, port: int, preset_name: str,
                              profile_token: str = None) -> Optional[str]:
        key = f"{ip}:{port}"
        cam = self._onvif_cameras.get(key)
        if not cam:
            return None
        device = self.devices[key]
        if not profile_token and device.profiles:
            profile_token = device.profiles[0]["token"]
        try:
            ptz_service = cam.create_ptz_service()
            request = ptz_service.create_type("SetPreset")
            request.ProfileToken = profile_token
            request.PresetName = preset_name
            result = await asyncio.get_event_loop().run_in_executor(None, ptz_service.SetPreset, request)
            device.ptz_presets.append({"token": str(result), "name": preset_name})
            return str(result)
        except Exception as e:
            logger.error("Set preset failed: %s", e)
            return None

    async def get_snapshot(self, ip: str, port: int, profile_token: str = None) -> Optional[bytes]:
        key = f"{ip}:{port}"
        cam = self._onvif_cameras.get(key)
        if not cam:
            return None
        device = self.devices[key]
        if not profile_token and device.profiles:
            profile_token = device.profiles[0]["token"]
        try:
            media_service = cam.create_media_service()
            uri = await asyncio.get_event_loop().run_in_executor(
                None, media_service.GetSnapshotUri, {"ProfileToken": profile_token}
            )
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.get(uri.Uri, auth=(device.username, device.password), timeout=10)
                if resp.status_code == 200:
                    return resp.content
        except Exception as e:
            logger.error("Snapshot failed: %s", e)
        return None

    async def subscribe_events(self, ip: str, port: int, callback=None) -> bool:
        key = f"{ip}:{port}"
        cam = self._onvif_cameras.get(key)
        if not cam:
            return False
        device = self.devices[key]
        if not device.events_supported:
            logger.warning("Device %s does not support events", key)
            return False
        try:
            events_service = cam.create_events_service()
            pullpoint = await asyncio.get_event_loop().run_in_executor(
                None, events_service.CreatePullPointSubscription
            )

            async def _poll_events():
                while True:
                    try:
                        messages = await asyncio.get_event_loop().run_in_executor(
                            None, lambda: pullpoint.PullMessages({"Timeout": "PT5S", "MessageLimit": 10})
                        )
                        if messages and hasattr(messages, "NotificationMessage"):
                            for msg in messages.NotificationMessage:
                                event_data = {
                                    "device": key,
                                    "topic": str(getattr(msg, "Topic", "")),
                                    "message": str(getattr(msg, "Message", "")),
                                    "timestamp": time.time(),
                                }
                                logger.info("ONVIF event from %s: %s", key, event_data["topic"])
                                if callback:
                                    await callback(event_data)
                    except Exception as e:
                        logger.error("Event poll error for %s: %s", key, e)
                        await asyncio.sleep(5)
                    await asyncio.sleep(1)

            task = asyncio.create_task(_poll_events())
            self._event_listeners[key] = task
            logger.info("Subscribed to ONVIF events from %s", key)
            return True
        except Exception as e:
            logger.error("Event subscription failed for %s: %s", key, e)
            return False

    def get_stream_uri(self, ip: str, port: int, profile_token: str = None) -> Optional[str]:
        key = f"{ip}:{port}"
        device = self.devices.get(key)
        if not device:
            return None
        if profile_token and profile_token in device.stream_uris:
            return device.stream_uris[profile_token]
        if device.stream_uris:
            return next(iter(device.stream_uris.values()))
        return None

    def list_devices(self) -> List[Dict[str, Any]]:
        return [
            {
                "ip": d.ip, "port": d.port, "name": d.name,
                "manufacturer": d.manufacturer, "model": d.model,
                "firmware": d.firmware, "serial": d.serial,
                "is_connected": d.is_connected, "ptz_supported": d.ptz_supported,
                "analytics_supported": d.analytics_supported,
                "events_supported": d.events_supported,
                "profiles": d.profiles, "ptz_presets": d.ptz_presets,
                "stream_uris": d.stream_uris,
            }
            for d in self.devices.values()
        ]

    async def disconnect_device(self, ip: str, port: int):
        key = f"{ip}:{port}"
        if key in self._event_listeners:
            self._event_listeners[key].cancel()
            del self._event_listeners[key]
        self._onvif_cameras.pop(key, None)
        if key in self.devices:
            self.devices[key].is_connected = False

    async def shutdown(self):
        for task in self._event_listeners.values():
            task.cancel()
        self._event_listeners.clear()
        self._onvif_cameras.clear()


# Singleton
onvif_service = ONVIFService()
