"""Agent memory management — short-term (Redis) + long-term (PostgreSQL)."""
from __future__ import annotations

import json
import logging
from datetime import datetime

import redis.asyncio as aioredis
from sqlalchemy import select, update, func

from backend.config import settings
from backend.database import async_session
from backend.models.agent_state import AgentMemory

logger = logging.getLogger(__name__)

MEMORY_PREFIX = "sentinel:agent_memory:"


class AgentMemoryManager:
    """Manages short-term (Redis TTL) and long-term (PostgreSQL) agent memory."""

    def __init__(self):
        self._redis: aioredis.Redis | None = None
        self._redis_available: bool = True

    async def _get_redis(self) -> aioredis.Redis | None:
        if not self._redis_available:
            return None
        if self._redis is None:
            try:
                self._redis = aioredis.from_url(
                    settings.REDIS_URL, decode_responses=True
                )
                await self._redis.ping()
            except Exception as exc:
                logger.warning("Redis unavailable for agent memory: %s", exc)
                self._redis_available = False
                self._redis = None
                return None
        return self._redis

    # ── Short-term memory (Redis) ───────────────────────────

    async def remember(
        self, agent_name: str, key: str, value: object, ttl: int = 300
    ):
        """Store a value in short-term memory with TTL (default 5 minutes)."""
        r = await self._get_redis()
        if r is None:
            return
        try:
            redis_key = f"{MEMORY_PREFIX}{agent_name}:{key}"
            await r.set(redis_key, json.dumps(value, default=str), ex=ttl)
        except Exception as exc:
            logger.warning("Redis remember failed for %s:%s — %s", agent_name, key, exc)
            self._redis_available = False
            self._redis = None

    async def recall(self, agent_name: str, key: str) -> object | None:
        """Retrieve a value from short-term memory."""
        r = await self._get_redis()
        if r is None:
            return None
        try:
            redis_key = f"{MEMORY_PREFIX}{agent_name}:{key}"
            raw = await r.get(redis_key)
            if raw is None:
                return None
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return raw
        except Exception as exc:
            logger.warning("Redis recall failed for %s:%s — %s", agent_name, key, exc)
            self._redis_available = False
            self._redis = None
            return None

    async def forget(self, agent_name: str, key: str):
        """Remove a value from short-term memory."""
        r = await self._get_redis()
        if r is None:
            return
        try:
            await r.delete(f"{MEMORY_PREFIX}{agent_name}:{key}")
        except Exception as exc:
            logger.warning("Redis forget failed for %s:%s — %s", agent_name, key, exc)
            self._redis_available = False
            self._redis = None

    async def recall_all(self, agent_name: str) -> dict:
        """Retrieve all short-term memories for an agent."""
        r = await self._get_redis()
        if r is None:
            return {}
        try:
            prefix = f"{MEMORY_PREFIX}{agent_name}:"
            keys = []
            async for k in r.scan_iter(match=f"{prefix}*", count=100):
                keys.append(k)
            result = {}
            for k in keys:
                raw = await r.get(k)
                short_key = k.replace(prefix, "")
                try:
                    result[short_key] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    result[short_key] = raw
            return result
        except Exception as exc:
            logger.warning("Redis recall_all failed for %s — %s", agent_name, exc)
            self._redis_available = False
            self._redis = None
            return {}

    async def reconnect_redis(self):
        """Attempt to reconnect to Redis (called periodically)."""
        self._redis_available = True
        self._redis = None

    # ── Long-term memory (PostgreSQL) ───────────────────────

    async def learn(
        self,
        agent_name: str,
        content: str,
        category: str = "observation",
        camera_id: str | None = None,
        zone_id: str | None = None,
        confidence: float = 1.0,
        expires_at: datetime | None = None,
    ):
        """Store a long-term memory entry in PostgreSQL."""
        async with async_session() as db:
            entry = AgentMemory(
                agent_name=agent_name,
                category=category,
                content=content,
                camera_id=camera_id,
                zone_id=zone_id,
                confidence=confidence,
                expires_at=expires_at,
            )
            db.add(entry)
            await db.commit()
            logger.debug(
                "Agent %s learned [%s]: %s", agent_name, category, content[:80]
            )

    async def recall_knowledge(
        self,
        agent_name: str,
        category: str | None = None,
        camera_id: str | None = None,
        limit: int = 10,
    ) -> list[dict]:
        """Retrieve long-term memories from PostgreSQL."""
        async with async_session() as db:
            q = select(AgentMemory).where(AgentMemory.agent_name == agent_name)
            if category:
                q = q.where(AgentMemory.category == category)
            if camera_id:
                q = q.where(AgentMemory.camera_id == camera_id)
            # Exclude expired
            q = q.where(
                (AgentMemory.expires_at.is_(None))
                | (AgentMemory.expires_at > func.now())
            )
            q = q.order_by(AgentMemory.created_at.desc()).limit(limit)
            result = await db.execute(q)
            rows = result.scalars().all()

            # Update access counts
            ids = [r.id for r in rows]
            if ids:
                await db.execute(
                    update(AgentMemory)
                    .where(AgentMemory.id.in_(ids))
                    .values(
                        access_count=AgentMemory.access_count + 1,
                        last_accessed_at=func.now(),
                    )
                )
                await db.commit()

            return [
                {
                    "id": str(r.id),
                    "category": r.category,
                    "content": r.content,
                    "confidence": r.confidence,
                    "camera_id": str(r.camera_id) if r.camera_id else None,
                    "zone_id": str(r.zone_id) if r.zone_id else None,
                    "access_count": r.access_count,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ]

    async def close(self):
        if self._redis:
            try:
                await self._redis.close()
            except Exception:
                pass
            self._redis = None


# Singleton
agent_memory = AgentMemoryManager()
