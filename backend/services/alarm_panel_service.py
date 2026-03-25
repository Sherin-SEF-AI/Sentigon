"""
Alarm panel integration service.
Supports SIA DC-07 protocol, Contact ID format parsing, zone monitoring,
arm/disarm operations, and alarm verification with video.
"""
import asyncio
import logging
import time
from typing import Optional, Dict, List, Any, Callable
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class AlarmZoneType(Enum):
    PERIMETER = "perimeter"
    INTERIOR = "interior"
    ENTRY_EXIT = "entry_exit"
    FIRE = "fire"
    PANIC = "panic"
    MEDICAL = "medical"
    ENVIRONMENTAL = "environmental"


class AlarmZoneState(Enum):
    NORMAL = "normal"
    ALARM = "alarm"
    TROUBLE = "trouble"
    BYPASS = "bypass"
    TAMPER = "tamper"


class PanelArmState(Enum):
    DISARMED = "disarmed"
    ARMED_AWAY = "armed_away"
    ARMED_STAY = "armed_stay"
    ARMED_NIGHT = "armed_night"
    ALARM_ACTIVE = "alarm_active"


@dataclass
class AlarmZone:
    zone_number: int
    name: str
    zone_type: AlarmZoneType
    state: AlarmZoneState = AlarmZoneState.NORMAL
    bypassed: bool = False
    camera_id: Optional[int] = None
    partition: int = 1
    alarm_count: int = 0
    last_event_time: float = 0


@dataclass
class AlarmPanel:
    panel_id: str
    name: str
    model: str = ""
    ip_address: str = ""
    port: int = 0
    arm_state: PanelArmState = PanelArmState.DISARMED
    zones: Dict[int, AlarmZone] = field(default_factory=dict)
    partitions: Dict[int, PanelArmState] = field(default_factory=dict)
    is_connected: bool = False
    last_heartbeat: float = 0
    ac_power: bool = True
    battery_ok: bool = True
    trouble: bool = False


@dataclass
class AlarmEvent:
    event_id: str
    timestamp: float
    panel_id: str
    event_code: str
    event_description: str
    zone_number: Optional[int] = None
    partition: int = 1
    qualifier: str = "E"
    is_alarm: bool = False
    is_verified: bool = False
    verification_camera_id: Optional[int] = None


class ContactIDParser:
    EVENT_DESCRIPTIONS = {
        "100": "Medical Emergency", "110": "Fire Alarm", "120": "Panic Alarm",
        "121": "Duress Alarm", "130": "Burglary Alarm", "131": "Perimeter Alarm",
        "132": "Interior Alarm", "137": "Tamper Alarm", "150": "Fire Supervisory",
        "151": "Gas Detected", "154": "Water Leak", "301": "AC Power Lost",
        "302": "Low Battery", "380": "Sensor Trouble", "400": "Armed Away",
        "401": "Disarmed", "403": "Auto-Armed", "406": "Alarm Cancelled",
        "409": "Open/Close", "441": "Armed Stay", "601": "Test Report",
    }
    ALARM_CODES = frozenset({"100", "110", "120", "121", "130", "131", "132", "137", "150", "151", "154"})

    @staticmethod
    def parse(raw: str) -> Optional[Dict[str, Any]]:
        try:
            raw = raw.strip()
            if len(raw) < 16:
                return None
            qualifier = raw[6:7]
            event_code = raw[7:10]
            group = raw[10:12]
            zone = raw[12:15]
            return {
                "account": raw[0:4], "qualifier": qualifier,
                "event_code": event_code,
                "event_description": ContactIDParser.EVENT_DESCRIPTIONS.get(event_code, f"Unknown ({event_code})"),
                "group_partition": int(group), "zone": int(zone),
                "is_alarm": event_code in ContactIDParser.ALARM_CODES,
            }
        except Exception as e:
            logger.error("Contact ID parse error: %s", e)
            return None


class SIAReceiver:
    def __init__(self, host: str = "0.0.0.0", port: int = 5000):
        self.host = host
        self.port = port
        self._server: Optional[asyncio.Server] = None
        self._callback: Optional[Callable] = None

    def on_event(self, callback: Callable):
        self._callback = callback

    async def start(self):
        self._server = await asyncio.start_server(self._handle_client, self.host, self.port)
        logger.info("SIA DC-07 receiver listening on %s:%d", self.host, self.port)

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        addr = writer.get_extra_info("peername")
        try:
            while True:
                data = await asyncio.wait_for(reader.read(1024), timeout=60)
                if not data:
                    break
                message = data.decode("ascii", errors="replace").strip()
                writer.write(b"ACK\r\n")
                await writer.drain()
                if self._callback:
                    await self._callback(message, str(addr))
        except (asyncio.TimeoutError, Exception):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()


class AlarmPanelService:
    def __init__(self):
        self.panels: Dict[str, AlarmPanel] = {}
        self.events: List[AlarmEvent] = []
        self.max_events = 10000
        self._callbacks: List[Callable] = []
        self._alert_callback: Optional[Callable] = None
        self._sia_receiver: Optional[SIAReceiver] = None
        self._parser = ContactIDParser()
        self._stats = {"total_events": 0, "alarms": 0, "troubles": 0, "arm_disarm": 0}

    def register_panel(self, panel: AlarmPanel):
        self.panels[panel.panel_id] = panel
        logger.info("Registered alarm panel: %s (%s)", panel.name, panel.panel_id)

    def on_event(self, callback: Callable):
        self._callbacks.append(callback)

    def set_alert_callback(self, callback: Callable):
        self._alert_callback = callback

    async def start_sia_receiver(self, host: str = "0.0.0.0", port: int = 5000):
        self._sia_receiver = SIAReceiver(host, port)
        self._sia_receiver.on_event(self._handle_sia_message)
        await self._sia_receiver.start()

    async def _handle_sia_message(self, message: str, source: str):
        parsed = self._parser.parse(message)
        if not parsed:
            return
        panel = next(iter(self.panels.values()), None)
        panel_id = panel.panel_id if panel else "unknown"
        event = AlarmEvent(
            event_id=f"alarm_{panel_id}_{int(time.time())}",
            timestamp=time.time(), panel_id=panel_id,
            event_code=parsed["event_code"],
            event_description=parsed["event_description"],
            zone_number=parsed["zone"], partition=parsed["group_partition"],
            qualifier=parsed["qualifier"], is_alarm=parsed["is_alarm"],
        )
        await self._process_event(event)

    async def process_contact_id(self, panel_id: str, raw_message: str) -> Optional[AlarmEvent]:
        parsed = self._parser.parse(raw_message)
        if not parsed:
            return None
        event = AlarmEvent(
            event_id=f"alarm_{panel_id}_{int(time.time())}",
            timestamp=time.time(), panel_id=panel_id,
            event_code=parsed["event_code"],
            event_description=parsed["event_description"],
            zone_number=parsed["zone"], partition=parsed["group_partition"],
            qualifier=parsed["qualifier"], is_alarm=parsed["is_alarm"],
        )
        await self._process_event(event)
        return event

    async def _process_event(self, event: AlarmEvent):
        self._stats["total_events"] += 1
        panel = self.panels.get(event.panel_id)
        if panel and event.zone_number and event.zone_number in panel.zones:
            zone = panel.zones[event.zone_number]
            if event.is_alarm:
                zone.state = AlarmZoneState.ALARM
                zone.alarm_count += 1
                zone.last_event_time = event.timestamp
            elif event.qualifier == "R":
                zone.state = AlarmZoneState.NORMAL
        if panel:
            code_to_state = {"400": PanelArmState.ARMED_AWAY, "441": PanelArmState.ARMED_STAY, "401": PanelArmState.DISARMED}
            if event.event_code in code_to_state:
                panel.arm_state = code_to_state[event.event_code]
                self._stats["arm_disarm"] += 1
            elif event.is_alarm:
                panel.arm_state = PanelArmState.ALARM_ACTIVE
            if event.event_code == "301":
                panel.ac_power = event.qualifier != "E"
            elif event.event_code == "302":
                panel.battery_ok = event.qualifier != "E"
            elif event.event_code in ("380", "137"):
                panel.trouble = event.qualifier == "E"
                self._stats["troubles"] += 1
        if event.is_alarm:
            self._stats["alarms"] += 1
        self.events.append(event)
        if len(self.events) > self.max_events:
            self.events = self.events[-self.max_events:]
        for cb in self._callbacks:
            try:
                if asyncio.iscoroutinefunction(cb):
                    await cb(event)
                else:
                    cb(event)
            except Exception as e:
                logger.error("Alarm callback error: %s", e)
        if event.is_alarm and self._alert_callback:
            zone_name = ""
            camera_id = None
            if panel and event.zone_number and event.zone_number in panel.zones:
                z = panel.zones[event.zone_number]
                zone_name = z.name
                camera_id = z.camera_id
            sev = "critical" if event.event_code in ("110", "120", "121") else "high"
            await self._alert_callback({
                "type": "alarm_panel", "event_code": event.event_code,
                "description": event.event_description,
                "panel": panel.name if panel else event.panel_id,
                "zone": zone_name, "camera_id": camera_id, "severity": sev,
            })

    async def arm_panel(self, panel_id: str, mode: str = "away") -> bool:
        panel = self.panels.get(panel_id)
        if not panel:
            return False
        modes = {"away": PanelArmState.ARMED_AWAY, "stay": PanelArmState.ARMED_STAY, "night": PanelArmState.ARMED_NIGHT}
        panel.arm_state = modes.get(mode, PanelArmState.ARMED_AWAY)
        return True

    async def disarm_panel(self, panel_id: str) -> bool:
        panel = self.panels.get(panel_id)
        if not panel:
            return False
        panel.arm_state = PanelArmState.DISARMED
        for zone in panel.zones.values():
            if zone.state == AlarmZoneState.ALARM:
                zone.state = AlarmZoneState.NORMAL
        return True

    async def bypass_zone(self, panel_id: str, zone_number: int) -> bool:
        panel = self.panels.get(panel_id)
        if not panel or zone_number not in panel.zones:
            return False
        panel.zones[zone_number].state = AlarmZoneState.BYPASS
        panel.zones[zone_number].bypassed = True
        return True

    def get_events(self, panel_id: str = None, is_alarm: bool = None, limit: int = 100) -> List[Dict]:
        evts = self.events
        if panel_id:
            evts = [e for e in evts if e.panel_id == panel_id]
        if is_alarm is not None:
            evts = [e for e in evts if e.is_alarm == is_alarm]
        return [
            {"event_id": e.event_id, "timestamp": e.timestamp, "panel_id": e.panel_id,
             "event_code": e.event_code, "event_description": e.event_description,
             "zone_number": e.zone_number, "partition": e.partition,
             "qualifier": e.qualifier, "is_alarm": e.is_alarm}
            for e in evts[-limit:]
        ]

    def get_status(self) -> Dict:
        return {
            "panels": {pid: {
                "name": p.name, "model": p.model, "arm_state": p.arm_state.value,
                "is_connected": p.is_connected, "ac_power": p.ac_power,
                "battery_ok": p.battery_ok, "trouble": p.trouble,
                "zones": {zn: {"name": z.name, "type": z.zone_type.value,
                               "state": z.state.value, "bypassed": z.bypassed,
                               "alarm_count": z.alarm_count}
                          for zn, z in p.zones.items()},
            } for pid, p in self.panels.items()},
            "stats": self._stats,
            "sia_receiver": self._sia_receiver is not None,
        }

    async def shutdown(self):
        if self._sia_receiver:
            await self._sia_receiver.stop()


alarm_service = AlarmPanelService()
