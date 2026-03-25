"""Building Management System (BMS) integration service.

Controls HVAC, lighting, and correlates building sensor data
during emergency events.
"""
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

@dataclass
class HVACZone:
    id: str
    name: str
    mode: str = "auto"  # auto, heating, cooling, off, emergency_off
    temperature: float = 22.0
    humidity: float = 45.0
    ventilation: str = "normal"  # normal, high, low, off
    last_updated: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

@dataclass
class LightingZone:
    id: str
    name: str
    mode: str = "auto"  # auto, on, off, emergency, dim
    brightness: int = 100  # 0-100%
    emergency_lighting: bool = False

class BMSService:
    def __init__(self):
        self._hvac_zones: Dict[str, HVACZone] = {}
        self._lighting_zones: Dict[str, LightingZone] = {}
        self._emergency_mode = False

    def register_hvac_zone(self, zone_id: str, name: str) -> HVACZone:
        zone = HVACZone(id=zone_id, name=name)
        self._hvac_zones[zone_id] = zone
        return zone

    def register_lighting_zone(self, zone_id: str, name: str) -> LightingZone:
        zone = LightingZone(id=zone_id, name=name)
        self._lighting_zones[zone_id] = zone
        return zone

    def get_hvac_status(self) -> List[dict]:
        return [vars(z) for z in self._hvac_zones.values()]

    def get_lighting_status(self) -> List[dict]:
        return [vars(z) for z in self._lighting_zones.values()]

    async def emergency_hvac_shutdown(self, zone_id: Optional[str] = None) -> dict:
        self._emergency_mode = True
        affected = []
        for z in self._hvac_zones.values():
            if zone_id and z.id != zone_id:
                continue
            z.mode = "emergency_off"
            z.ventilation = "off"
            z.last_updated = datetime.now(timezone.utc).isoformat()
            affected.append(z.id)
        logger.warning("Emergency HVAC shutdown: %d zones", len(affected))
        return {"affected_zones": affected, "mode": "emergency_off"}

    async def activate_emergency_lighting(self, zone_id: Optional[str] = None) -> dict:
        affected = []
        for z in self._lighting_zones.values():
            if zone_id and z.id != zone_id:
                continue
            z.mode = "emergency"
            z.emergency_lighting = True
            z.brightness = 100
            affected.append(z.id)
        return {"affected_zones": affected, "mode": "emergency"}

    async def restore_normal_operations(self) -> dict:
        self._emergency_mode = False
        for z in self._hvac_zones.values():
            z.mode = "auto"
            z.ventilation = "normal"
        for z in self._lighting_zones.values():
            z.mode = "auto"
            z.emergency_lighting = False
        return {"status": "restored"}

    def get_system_status(self) -> dict:
        return {
            "emergency_mode": self._emergency_mode,
            "hvac_zones": len(self._hvac_zones),
            "lighting_zones": len(self._lighting_zones),
            "hvac_status": self.get_hvac_status(),
            "lighting_status": self.get_lighting_status(),
        }


bms_service = BMSService()
