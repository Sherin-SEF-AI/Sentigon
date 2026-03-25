"""WebSocket endpoints for MJPEG streaming and alert push."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from backend.services.notification_service import ws_manager
from backend.services.video_capture import capture_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


async def _keepalive(websocket: WebSocket):
    """Send periodic pings to detect stale connections."""
    try:
        while True:
            await asyncio.sleep(30)
            await websocket.send_json({"type": "ping"})
    except Exception:
        pass


@router.websocket("/ws")
async def websocket_endpoint(
    ws: WebSocket,
    channels: Optional[str] = Query(None),
):
    """Main multiplexed WebSocket endpoint.

    Query params:
        channels: comma-separated list of channels to subscribe to
                  (frames, alerts, metrics, notifications)
    """
    channel_list = channels.split(",") if channels else None
    await ws_manager.connect(ws, channel_list)

    ping_task = asyncio.create_task(_keepalive(ws))
    try:
        while True:
            # Listen for client messages (e.g., subscribe/unsubscribe, commands)
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
                action = msg.get("action")

                if action == "subscribe":
                    ch = msg.get("channel")
                    if ch and ch in ws_manager._subscriptions:
                        ws_manager._subscriptions[ch].add(ws)

                elif action == "unsubscribe":
                    ch = msg.get("channel")
                    if ch and ch in ws_manager._subscriptions:
                        ws_manager._subscriptions[ch].discard(ws)

                elif action == "ping":
                    await ws.send_text(json.dumps({"channel": "system", "data": {"type": "pong"}}))

            except json.JSONDecodeError:
                pass

    except WebSocketDisconnect:
        ping_task.cancel()
        ws_manager.disconnect(ws)
    except Exception as e:
        ping_task.cancel()
        logger.error("WebSocket error: %s", e)
        ws_manager.disconnect(ws)


@router.websocket("/ws/camera/{camera_id}")
async def camera_stream(ws: WebSocket, camera_id: str):
    """Dedicated MJPEG-style WebSocket stream for a single camera."""
    await ws.accept()

    try:
        stream = capture_manager.get_stream(camera_id)
        if not stream or not stream.is_running:
            await ws.send_text(json.dumps({
                "channel": "error",
                "data": {"message": f"Camera {camera_id} not available"},
            }))
            await ws.close()
            return

        while True:
            jpeg = stream.encode_jpeg(quality=65)
            if jpeg:
                frame_b64 = base64.b64encode(jpeg).decode("utf-8")
                await ws.send_text(json.dumps({
                    "channel": "frame",
                    "data": {
                        "camera_id": camera_id,
                        "frame": frame_b64,
                        "timestamp": time.time(),
                    },
                }))
            await asyncio.sleep(1.0 / (stream.fps or 15))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("Camera stream error for %s: %s", camera_id, e)


async def stream_all_cameras():
    """Background task that streams frames from all active cameras to WS subscribers."""
    while True:
        try:
            streams = capture_manager.list_streams()
            for cam_id, stream in streams.items():
                if not stream.is_running:
                    continue
                jpeg = stream.encode_jpeg(quality=60)
                if jpeg:
                    frame_b64 = base64.b64encode(jpeg).decode("utf-8")
                    await ws_manager.broadcast("frames", {
                        "camera_id": cam_id,
                        "frame": frame_b64,
                        "timestamp": time.time(),
                    })
            await asyncio.sleep(0.1)  # ~10 FPS broadcast rate
        except Exception as e:
            logger.error("Stream broadcast error: %s", e)
            await asyncio.sleep(1.0)
