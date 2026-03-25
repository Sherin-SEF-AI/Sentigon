"""
Real MQTT IoT sensor integration service.
Connects to MQTT broker, subscribes to sensor topics, processes environmental data,
gunshot detection, vibration alerts, PIR motion events, and custom IoT payloads.
"""
import asyncio
import json
import logging
import time
from typing import Optional, Dict, List, Any, Callable
from dataclasses import dataclass, field
from enum import Enum
import os

logger = logging.getLogger(__name__)


class SensorType(Enum):
    TEMPERATURE = "temperature"
    HUMIDITY = "humidity"
    AIR_QUALITY = "air_quality"
    MOTION_PIR = "motion_pir"
    VIBRATION = "vibration"
    ACOUSTIC = "acoustic"
    DOOR_CONTACT = "door_contact"
    SMOKE = "smoke"
    WATER_LEAK = "water_leak"
    PRESSURE = "pressure"
    LIGHT_LEVEL = "light_level"
    GAS = "gas"
    GUNSHOT = "gunshot"
    GLASS_BREAK = "glass_break"
    PANIC_BUTTON = "panic_button"
    CUSTOM = "custom"


@dataclass
class SensorReading:
    sensor_id: str
    sensor_type: SensorType
    value: Any
    unit: str = ""
    zone: str = ""
    location: str = ""
    timestamp: float = field(default_factory=time.time)
    raw_payload: Dict = field(default_factory=dict)
    is_alert: bool = False
    alert_message: str = ""


@dataclass
class SensorConfig:
    sensor_id: str
    sensor_type: SensorType
    topic: str
    name: str = ""
    zone: str = ""
    location: str = ""
    thresholds: Dict[str, float] = field(default_factory=dict)
    enabled: bool = True
    last_reading: Optional[SensorReading] = None
    alert_count: int = 0
    reading_count: int = 0


# Immediate-alert sensor types (always alert on detection)
_IMMEDIATE_ALERT_TYPES = frozenset({
    SensorType.GUNSHOT, SensorType.GLASS_BREAK,
    SensorType.PANIC_BUTTON, SensorType.SMOKE, SensorType.GAS,
})


class MQTTService:
    """Full MQTT broker integration for IoT sensors."""

    def __init__(self):
        self.broker_host = os.getenv("MQTT_BROKER_HOST", "localhost")
        self.broker_port = int(os.getenv("MQTT_BROKER_PORT", "1883"))
        self.username = os.getenv("MQTT_USERNAME", "")
        self.password = os.getenv("MQTT_PASSWORD", "")
        self.client_id = os.getenv("MQTT_CLIENT_ID", "sentinel-ai")
        self.base_topic = os.getenv("MQTT_BASE_TOPIC", "sentinel/#")

        self.sensors: Dict[str, SensorConfig] = {}
        self.readings_buffer: List[SensorReading] = []
        self.max_buffer = 1000
        self._connected = False
        self._task: Optional[asyncio.Task] = None
        self._callbacks: List[Callable] = []
        self._alert_callback: Optional[Callable] = None
        self._stats = {
            "messages_received": 0,
            "alerts_triggered": 0,
            "errors": 0,
            "connected_since": None,
            "last_message": None,
        }

    def register_sensor(self, config: SensorConfig):
        self.sensors[config.sensor_id] = config
        logger.info("Registered sensor: %s (%s) on topic %s", config.sensor_id, config.sensor_type.value, config.topic)

    def on_reading(self, callback: Callable):
        self._callbacks.append(callback)

    def set_alert_callback(self, callback: Callable):
        self._alert_callback = callback

    async def connect(self) -> bool:
        try:
            import aiomqtt  # noqa: F401
            self._task = asyncio.create_task(self._listen_loop())
            logger.info("MQTT service connecting to %s:%d", self.broker_host, self.broker_port)
            return True
        except ImportError:
            logger.error("aiomqtt not installed. Install with: pip install aiomqtt")
            return False

    async def _listen_loop(self):
        import aiomqtt
        reconnect_delay = 1
        max_delay = 60
        while True:
            try:
                async with aiomqtt.Client(
                    hostname=self.broker_host, port=self.broker_port,
                    username=self.username or None, password=self.password or None,
                    identifier=self.client_id,
                ) as client:
                    self._connected = True
                    self._stats["connected_since"] = time.time()
                    reconnect_delay = 1
                    logger.info("MQTT connected to %s:%d", self.broker_host, self.broker_port)
                    await client.subscribe(self.base_topic)
                    for sensor in self.sensors.values():
                        if sensor.topic != self.base_topic:
                            await client.subscribe(sensor.topic)
                    async for message in client.messages:
                        try:
                            await self._process_message(str(message.topic), message.payload)
                        except Exception as e:
                            logger.error("MQTT message processing error: %s", e)
                            self._stats["errors"] += 1
            except asyncio.CancelledError:
                logger.info("MQTT listener cancelled")
                break
            except Exception as e:
                self._connected = False
                logger.warning("MQTT connection lost: %s. Reconnecting in %ds...", e, reconnect_delay)
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, max_delay)

    async def _process_message(self, topic: str, payload: bytes):
        self._stats["messages_received"] += 1
        self._stats["last_message"] = time.time()
        try:
            data = json.loads(payload.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            data = {"raw": payload.hex()}

        sensor_config = None
        for config in self.sensors.values():
            if self._topic_matches(config.topic, topic):
                sensor_config = config
                break

        reading = self._parse_reading(topic, data, sensor_config)
        if sensor_config and reading:
            self._check_thresholds(reading, sensor_config)
            sensor_config.last_reading = reading
            sensor_config.reading_count += 1

        if reading:
            self.readings_buffer.append(reading)
            if len(self.readings_buffer) > self.max_buffer:
                self.readings_buffer = self.readings_buffer[-self.max_buffer:]
            for callback in self._callbacks:
                try:
                    if asyncio.iscoroutinefunction(callback):
                        await callback(reading)
                    else:
                        callback(reading)
                except Exception as e:
                    logger.error("MQTT callback error: %s", e)

    def _parse_reading(self, topic: str, data: Any, config: Optional[SensorConfig]) -> Optional[SensorReading]:
        sensor_type = config.sensor_type if config else self._detect_type(topic)
        value = None
        unit = ""
        if isinstance(data, dict):
            value = data.get("value", data.get("reading", data.get("state", data.get("payload"))))
            unit = data.get("unit", data.get("units", ""))
        elif isinstance(data, (int, float)):
            value = data
        sensor_id = config.sensor_id if config else f"auto_{topic.replace('/', '_')}"
        return SensorReading(
            sensor_id=sensor_id, sensor_type=sensor_type, value=value, unit=unit,
            zone=config.zone if config else "", location=config.location if config else "",
            timestamp=time.time(), raw_payload=data if isinstance(data, dict) else {"raw": data},
        )

    @staticmethod
    def _detect_type(topic: str) -> SensorType:
        t = topic.lower()
        for name, st in [
            ("temperature", SensorType.TEMPERATURE), ("temp", SensorType.TEMPERATURE),
            ("humidity", SensorType.HUMIDITY), ("motion", SensorType.MOTION_PIR),
            ("pir", SensorType.MOTION_PIR), ("vibration", SensorType.VIBRATION),
            ("acoustic", SensorType.ACOUSTIC), ("door", SensorType.DOOR_CONTACT),
            ("smoke", SensorType.SMOKE), ("water", SensorType.WATER_LEAK),
            ("leak", SensorType.WATER_LEAK), ("gunshot", SensorType.GUNSHOT),
            ("glass", SensorType.GLASS_BREAK), ("panic", SensorType.PANIC_BUTTON),
            ("gas", SensorType.GAS), ("air", SensorType.AIR_QUALITY),
        ]:
            if name in t:
                return st
        return SensorType.CUSTOM

    def _check_thresholds(self, reading: SensorReading, config: SensorConfig):
        if not config.thresholds and reading.sensor_type not in _IMMEDIATE_ALERT_TYPES:
            return
        if reading.value is not None:
            try:
                val = float(reading.value)
                if "max" in config.thresholds and val > config.thresholds["max"]:
                    reading.is_alert = True
                    reading.alert_message = (
                        f"{config.name or config.sensor_id}: {reading.sensor_type.value} "
                        f"{val}{reading.unit} exceeds max {config.thresholds['max']}{reading.unit}"
                    )
                elif "min" in config.thresholds and val < config.thresholds["min"]:
                    reading.is_alert = True
                    reading.alert_message = (
                        f"{config.name or config.sensor_id}: {reading.sensor_type.value} "
                        f"{val}{reading.unit} below min {config.thresholds['min']}{reading.unit}"
                    )
            except (ValueError, TypeError):
                pass
        if reading.sensor_type in _IMMEDIATE_ALERT_TYPES:
            if reading.value and str(reading.value).lower() not in ("0", "false", "off", "none"):
                reading.is_alert = True
                reading.alert_message = (
                    f"CRITICAL: {reading.sensor_type.value} detected at "
                    f"{config.location or config.zone or config.sensor_id}"
                )
        if reading.is_alert:
            config.alert_count += 1
            self._stats["alerts_triggered"] += 1
            logger.warning("IoT ALERT: %s", reading.alert_message)
            if self._alert_callback:
                asyncio.create_task(self._alert_callback(reading))

    @staticmethod
    def _topic_matches(pattern: str, topic: str) -> bool:
        pp = pattern.split("/")
        tp = topic.split("/")
        for i, part in enumerate(pp):
            if part == "#":
                return True
            if i >= len(tp):
                return False
            if part != "+" and part != tp[i]:
                return False
        return len(pp) == len(tp)

    async def publish(self, topic: str, payload: Dict, qos: int = 1) -> bool:
        try:
            import aiomqtt
            async with aiomqtt.Client(
                hostname=self.broker_host, port=self.broker_port,
                username=self.username or None, password=self.password or None,
            ) as client:
                await client.publish(topic, json.dumps(payload).encode(), qos=qos)
                return True
        except Exception as e:
            logger.error("MQTT publish failed: %s", e)
            return False

    def get_recent_readings(self, sensor_id: str = None, sensor_type: SensorType = None, limit: int = 50) -> List[Dict]:
        readings = self.readings_buffer
        if sensor_id:
            readings = [r for r in readings if r.sensor_id == sensor_id]
        if sensor_type:
            readings = [r for r in readings if r.sensor_type == sensor_type]
        return [
            {"sensor_id": r.sensor_id, "sensor_type": r.sensor_type.value, "value": r.value,
             "unit": r.unit, "zone": r.zone, "location": r.location, "timestamp": r.timestamp,
             "is_alert": r.is_alert, "alert_message": r.alert_message}
            for r in readings[-limit:]
        ]

    def get_status(self) -> Dict:
        return {
            "connected": self._connected,
            "broker": f"{self.broker_host}:{self.broker_port}",
            "sensors_registered": len(self.sensors),
            "sensors": {
                sid: {
                    "name": s.name, "type": s.sensor_type.value, "topic": s.topic,
                    "zone": s.zone, "enabled": s.enabled, "reading_count": s.reading_count,
                    "alert_count": s.alert_count,
                    "last_value": s.last_reading.value if s.last_reading else None,
                    "last_timestamp": s.last_reading.timestamp if s.last_reading else None,
                }
                for sid, s in self.sensors.items()
            },
            **self._stats,
        }

    async def disconnect(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._connected = False


# Singleton
mqtt_service = MQTTService()
