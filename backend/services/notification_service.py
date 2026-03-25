"""Notification service — WebSocket push, email, webhook dispatch."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional, Set

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections with multiplexed channels and heartbeat."""

    # Heartbeat configuration
    HEARTBEAT_INTERVAL: float = 30.0   # seconds between pings
    PONG_TIMEOUT: float = 10.0         # seconds to wait for pong reply

    def __init__(self):
        self._connections: Set[WebSocket] = set()
        self._subscriptions: Dict[str, Set[WebSocket]] = {
            "frames": set(),
            "alerts": set(),
            "metrics": set(),
            "notifications": set(),
            "pending_actions": set(),
            "analysis": set(),
            "threat_response": set(),
        }
        # Connection metadata: ws -> {"connected_at": float, "last_pong": float}
        self._conn_meta: Dict[WebSocket, Dict[str, float]] = {}
        self._heartbeat_task: Optional[asyncio.Task] = None

    async def connect(self, ws: WebSocket, channels: Optional[List[str]] = None):
        await ws.accept()
        now = time.time()
        self._connections.add(ws)
        self._conn_meta[ws] = {"connected_at": now, "last_pong": now}
        # Subscribe to requested channels (default: all)
        for ch in (channels or list(self._subscriptions.keys())):
            if ch in self._subscriptions:
                self._subscriptions[ch].add(ws)
        logger.info("WebSocket connected. Total: %d", len(self._connections))
        # Start heartbeat loop if not running
        if self._heartbeat_task is None or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    def disconnect(self, ws: WebSocket):
        self._connections.discard(ws)
        self._conn_meta.pop(ws, None)
        for subs in self._subscriptions.values():
            subs.discard(ws)
        logger.info("WebSocket disconnected. Total: %d", len(self._connections))

    async def broadcast(self, channel: str, data: Dict[str, Any]):
        """Send message to all subscribers of a channel."""
        message = json.dumps({"channel": channel, "data": data})
        subs = self._subscriptions.get(channel, set())
        dead: List[WebSocket] = []
        for ws in subs:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def send_to(self, ws: WebSocket, channel: str, data: Dict[str, Any]):
        """Send message to a specific connection."""
        try:
            await ws.send_text(json.dumps({"channel": channel, "data": data}))
        except Exception:
            self.disconnect(ws)

    def record_pong(self, ws: WebSocket):
        """Record pong receipt from a client (call from WS receive handler)."""
        meta = self._conn_meta.get(ws)
        if meta is not None:
            meta["last_pong"] = time.time()

    def connection_age(self, ws: WebSocket) -> float:
        """Return how long this connection has been alive (seconds)."""
        meta = self._conn_meta.get(ws)
        if meta is None:
            return 0.0
        return time.time() - meta["connected_at"]

    # ── Heartbeat loop ────────────────────────────────────────

    async def _heartbeat_loop(self):
        """Periodically ping all connections and prune unresponsive ones."""
        while self._connections:
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)
            now = time.time()
            dead: List[WebSocket] = []

            for ws in list(self._connections):
                meta = self._conn_meta.get(ws)
                if meta is None:
                    dead.append(ws)
                    continue

                # Check if previous pong was received within timeout
                since_pong = now - meta["last_pong"]
                if since_pong > self.HEARTBEAT_INTERVAL + self.PONG_TIMEOUT:
                    logger.warning(
                        "WebSocket heartbeat timeout (%.1fs since last pong, age=%.0fs). Removing.",
                        since_pong,
                        now - meta["connected_at"],
                    )
                    dead.append(ws)
                    continue

                # Send ping
                try:
                    await ws.send_text(json.dumps({
                        "channel": "__ping",
                        "data": {"ts": now},
                    }))
                except Exception:
                    dead.append(ws)

            for ws in dead:
                self.disconnect(ws)

        logger.debug("Heartbeat loop exiting — no connections remaining")

    @property
    def active_count(self) -> int:
        return len(self._connections)

    @property
    def channel_counts(self) -> Dict[str, int]:
        return {ch: len(subs) for ch, subs in self._subscriptions.items()}


class NotificationService:
    """Dispatches notifications via multiple channels."""

    def __init__(self, connection_manager: ConnectionManager):
        self.ws_manager = connection_manager
        self._webhook_urls: List[str] = []

    async def push_alert(self, alert_data: Dict[str, Any]):
        """Push alert to all connected WebSocket clients."""
        await self.ws_manager.broadcast("alerts", alert_data)

    async def push_frame(self, camera_id: str, frame_b64: str, detections: Dict = None):
        """Push video frame to subscribers."""
        await self.ws_manager.broadcast("frames", {
            "camera_id": camera_id,
            "frame": frame_b64,
            "detections": detections or {},
        })

    async def push_metrics(self, metrics: Dict[str, Any]):
        """Push SOC metrics update."""
        await self.ws_manager.broadcast("metrics", metrics)

    async def push_notification(self, notification: Dict[str, Any]):
        """Push general notification."""
        await self.ws_manager.broadcast("notifications", notification)

    async def push_analysis(self, camera_id: str, analysis: Dict[str, Any]):
        """Push AI analysis result for a camera to subscribers."""
        await self.ws_manager.broadcast("analysis", {
            "camera_id": camera_id,
            "analysis": analysis,
            "timestamp": time.time(),
        })

    async def push_threat_response(self, response_data: Dict[str, Any]):
        """Push autonomous threat response step update to subscribers."""
        await self.ws_manager.broadcast("threat_response", {
            **response_data,
            "timestamp": response_data.get("timestamp", time.time()),
        })

    async def dispatch_webhook(self, alert_data: Dict[str, Any]):
        """Send alert to registered webhook URLs."""
        if not self._webhook_urls:
            return

        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            for url in self._webhook_urls:
                try:
                    await client.post(url, json=alert_data)
                except Exception as e:
                    logger.error("Webhook dispatch failed for %s: %s", url, e)

    def register_webhook(self, url: str):
        if url not in self._webhook_urls:
            self._webhook_urls.append(url)

    def unregister_webhook(self, url: str):
        self._webhook_urls = [u for u in self._webhook_urls if u != url]


# Singletons
ws_manager = ConnectionManager()
notification_service = NotificationService(ws_manager)
