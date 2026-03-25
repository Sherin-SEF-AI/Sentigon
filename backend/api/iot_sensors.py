"""
FastAPI router for IoT sensor management via MQTT.
Exposes endpoints to connect/disconnect the broker, register sensors,
retrieve readings, and publish messages.
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.mqtt_service import SensorConfig, SensorType, mqtt_service

router = APIRouter(prefix="/api/iot", tags=["IoT Sensors"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class SensorRegisterRequest(BaseModel):
    sensor_id: str
    sensor_type: SensorType
    topic: str
    name: str = ""
    zone: str = ""
    location: str = ""
    thresholds: Dict[str, float] = Field(default_factory=dict)
    enabled: bool = True


class PublishRequest(BaseModel):
    topic: str
    payload: Dict[str, Any]
    qos: int = Field(default=1, ge=0, le=2)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status")
async def get_status():
    """Return MQTT service status including connection state, broker info,
    registered sensors, and aggregate statistics."""
    return mqtt_service.get_status()


@router.post("/connect")
async def connect():
    """Connect the MQTT service to the configured broker."""
    success = await mqtt_service.connect()
    if not success:
        raise HTTPException(
            status_code=503,
            detail="Failed to connect to MQTT broker. Ensure aiomqtt is installed and the broker is reachable.",
        )
    return {"status": "connected", "broker": f"{mqtt_service.broker_host}:{mqtt_service.broker_port}"}


@router.post("/disconnect")
async def disconnect():
    """Disconnect the MQTT service from the broker."""
    await mqtt_service.disconnect()
    return {"status": "disconnected"}


@router.post("/sensors", status_code=201)
async def register_sensor(body: SensorRegisterRequest):
    """Register a new IoT sensor with the MQTT service."""
    config = SensorConfig(
        sensor_id=body.sensor_id,
        sensor_type=body.sensor_type,
        topic=body.topic,
        name=body.name,
        zone=body.zone,
        location=body.location,
        thresholds=body.thresholds,
        enabled=body.enabled,
    )
    mqtt_service.register_sensor(config)
    return {
        "sensor_id": config.sensor_id,
        "sensor_type": config.sensor_type.value,
        "topic": config.topic,
        "registered": True,
    }


@router.get("/sensors")
async def list_sensors():
    """List all registered sensors."""
    return [
        {
            "sensor_id": sid,
            "name": s.name,
            "sensor_type": s.sensor_type.value,
            "topic": s.topic,
            "zone": s.zone,
            "location": s.location,
            "enabled": s.enabled,
            "reading_count": s.reading_count,
            "alert_count": s.alert_count,
            "last_value": s.last_reading.value if s.last_reading else None,
            "last_timestamp": s.last_reading.timestamp if s.last_reading else None,
        }
        for sid, s in mqtt_service.sensors.items()
    ]


@router.get("/sensors/{sensor_id}")
async def get_sensor(sensor_id: str):
    """Get details for a single registered sensor."""
    sensor = mqtt_service.sensors.get(sensor_id)
    if sensor is None:
        raise HTTPException(status_code=404, detail=f"Sensor '{sensor_id}' not found")
    return {
        "sensor_id": sensor_id,
        "name": sensor.name,
        "sensor_type": sensor.sensor_type.value,
        "topic": sensor.topic,
        "zone": sensor.zone,
        "location": sensor.location,
        "thresholds": sensor.thresholds,
        "enabled": sensor.enabled,
        "reading_count": sensor.reading_count,
        "alert_count": sensor.alert_count,
        "last_value": sensor.last_reading.value if sensor.last_reading else None,
        "last_timestamp": sensor.last_reading.timestamp if sensor.last_reading else None,
    }


@router.delete("/sensors/{sensor_id}")
async def remove_sensor(sensor_id: str):
    """Remove a registered sensor."""
    if sensor_id not in mqtt_service.sensors:
        raise HTTPException(status_code=404, detail=f"Sensor '{sensor_id}' not found")
    del mqtt_service.sensors[sensor_id]
    return {"sensor_id": sensor_id, "removed": True}


@router.get("/readings")
async def get_readings(
    sensor_id: Optional[str] = Query(default=None, description="Filter by sensor ID"),
    sensor_type: Optional[SensorType] = Query(default=None, description="Filter by sensor type"),
    limit: int = Query(default=50, ge=1, le=500, description="Max number of readings to return"),
):
    """Retrieve recent sensor readings with optional filters."""
    return mqtt_service.get_recent_readings(
        sensor_id=sensor_id,
        sensor_type=sensor_type,
        limit=limit,
    )


@router.post("/publish")
async def publish(body: PublishRequest):
    """Publish a message to an MQTT topic."""
    success = await mqtt_service.publish(body.topic, body.payload, qos=body.qos)
    if not success:
        raise HTTPException(status_code=503, detail="Failed to publish message to MQTT broker")
    return {"topic": body.topic, "published": True}


@router.get("/readings/alerts")
async def get_alert_readings(
    limit: int = Query(default=50, ge=1, le=500, description="Max number of alert readings to return"),
):
    """Retrieve only readings that triggered alerts."""
    all_readings = mqtt_service.get_recent_readings(limit=mqtt_service.max_buffer)
    alerts = [r for r in all_readings if r.get("is_alert")]
    return alerts[-limit:]
