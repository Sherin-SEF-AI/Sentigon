"""Inter-agent communication via Redis Pub/Sub."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Callable, Awaitable

import redis.asyncio as aioredis

from backend.config import settings

logger = logging.getLogger(__name__)

# Channel constants
CH_CORTEX = "sentinel:agents:cortex"
CH_PERCEPTIONS = "sentinel:agents:perceptions"
CH_THREATS = "sentinel:agents:threats"
CH_ACTIONS = "sentinel:agents:actions"
CH_INVESTIGATION = "sentinel:agents:investigation"
CH_ANOMALIES = "sentinel:agents:anomalies"
CH_CORRELATION = "sentinel:agents:correlation"
CH_PREDICTIONS = "sentinel:agents:predictions"
CH_HEARTBEAT = "sentinel:agents:heartbeat"

ALL_CHANNELS = [
    CH_CORTEX, CH_PERCEPTIONS, CH_THREATS, CH_ACTIONS,
    CH_INVESTIGATION, CH_ANOMALIES, CH_CORRELATION,
    CH_PREDICTIONS, CH_HEARTBEAT,
]


class AgentComms:
    """Redis Pub/Sub message bus for inter-agent communication."""

    def __init__(self):
        self._redis: aioredis.Redis | None = None
        self._pubsub: aioredis.client.PubSub | None = None
        self._handlers: dict[str, list[Callable[[dict], Awaitable[None]]]] = {}
        self._listen_task: asyncio.Task | None = None
        self._running = False
        self._connected = False

    async def connect(self):
        """Connect to Redis. Non-fatal — sets _connected=False on failure."""
        if self._connected and self._redis is not None:
            return
        try:
            self._redis = aioredis.from_url(
                settings.REDIS_URL,
                decode_responses=True,
                max_connections=20,
            )
            await self._redis.ping()
            self._pubsub = self._redis.pubsub()
            self._connected = True
            logger.info("Agent comms connected to Redis")
        except Exception as exc:
            logger.warning("Agent comms Redis unavailable: %s", exc)
            self._connected = False
            self._redis = None
            self._pubsub = None

    async def disconnect(self):
        """Disconnect from Redis."""
        self._running = False
        self._connected = False
        if self._listen_task and not self._listen_task.done():
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass
        if self._pubsub:
            try:
                await self._pubsub.unsubscribe()
                await self._pubsub.close()
            except Exception:
                pass
            self._pubsub = None
        if self._redis:
            try:
                await self._redis.close()
            except Exception:
                pass
            self._redis = None
        logger.info("Agent comms disconnected")

    async def subscribe(
        self,
        channel: str,
        handler: Callable[[dict], Awaitable[None]],
    ):
        """Subscribe to a channel with an async handler."""
        if channel not in self._handlers:
            self._handlers[channel] = []
            if self._connected and self._pubsub:
                try:
                    await self._pubsub.subscribe(channel)
                except Exception as exc:
                    logger.warning("Failed to subscribe to %s: %s", channel, exc)
        self._handlers[channel].append(handler)

    async def unsubscribe(self, channel: str, handler: Callable | None = None):
        """Unsubscribe from a channel (or remove a specific handler)."""
        if channel not in self._handlers:
            return
        if handler:
            self._handlers[channel] = [
                h for h in self._handlers[channel] if h is not handler
            ]
        else:
            self._handlers[channel] = []
        if not self._handlers[channel]:
            del self._handlers[channel]
            if self._connected and self._pubsub:
                try:
                    await self._pubsub.unsubscribe(channel)
                except Exception:
                    pass

    async def publish(self, channel: str, message: dict):
        """Publish a message to a channel. Non-fatal if Redis unavailable."""
        if not self._connected:
            await self.connect()
        if not self._connected or not self._redis:
            return
        try:
            payload = json.dumps({
                **message,
                "_ts": time.time(),
                "_channel": channel,
            })
            await self._redis.publish(channel, payload)
        except Exception as exc:
            logger.warning("Publish to %s failed: %s", channel, exc)
            self._connected = False

    async def start_listening(self):
        """Start the background listener loop."""
        if self._running:
            return
        if not self._connected:
            await self.connect()
        if not self._connected:
            logger.warning("Cannot start listener — Redis not available")
            return
        # Subscribe to all channels that have handlers
        for ch in self._handlers:
            try:
                await self._pubsub.subscribe(ch)
            except Exception as exc:
                logger.warning("Failed to subscribe to %s: %s", ch, exc)
        self._running = True
        self._listen_task = asyncio.create_task(self._listen_loop())
        logger.info("Agent comms listener started")

    async def _listen_loop(self):
        """Listen for messages and dispatch to handlers."""
        try:
            while self._running:
                if not self._connected or not self._pubsub:
                    await asyncio.sleep(5)
                    await self.connect()
                    if self._connected:
                        for ch in self._handlers:
                            try:
                                await self._pubsub.subscribe(ch)
                            except Exception:
                                pass
                    continue
                try:
                    msg = await self._pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=1.0
                    )
                    if msg and msg["type"] == "message":
                        channel = msg["channel"]
                        try:
                            data = json.loads(msg["data"])
                        except (json.JSONDecodeError, TypeError):
                            continue
                        handlers = self._handlers.get(channel, [])
                        for handler in handlers:
                            try:
                                await handler(data)
                            except Exception:
                                logger.exception(
                                    "Handler error on channel %s", channel
                                )
                except Exception as exc:
                    logger.warning("Listen loop error: %s", exc)
                    self._connected = False
                    await asyncio.sleep(5)
                    continue
                await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Agent comms listener fatal error")

    async def publish_heartbeat(self, agent_name: str, status: dict):
        """Publish an agent heartbeat."""
        await self.publish(CH_HEARTBEAT, {
            "agent": agent_name,
            "status": status,
            "ts": time.time(),
        })


# Singleton
agent_comms = AgentComms()
