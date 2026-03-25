"""Abstract base agent class with Ollama function-calling loop.

Every SENTINEL AI agent inherits from BaseAgent and gets:
- An Ollama model instance with function-calling tools
- Short-term memory (Redis) and long-term memory (PostgreSQL)
- Inter-agent communication via Redis Pub/Sub
- An autonomous execution loop with circuit breaker and backoff
- Full observability (every action logged)
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any

from backend.config import settings
from backend.database import async_session
from backend.models.agent_state import AgentState
from backend.models.agent_audit import AgentAuditLog
from backend.agents.agent_comms import agent_comms, CH_HEARTBEAT
from backend.agents.agent_memory import agent_memory
from backend.agents.agent_tools import TOOL_REGISTRY

logger = logging.getLogger(__name__)


def _build_openai_tools(tool_names: list[str]) -> list[dict[str, Any]]:
    """Convert tool registry entries to OpenAI-format tool definitions (for Ollama)."""
    tools = []
    for name in tool_names:
        tool_def = TOOL_REGISTRY.get(name)
        if not tool_def:
            continue
        properties = {}
        for pname, pdef in tool_def.get("parameters", {}).items():
            prop: dict[str, Any] = {"type": pdef.get("type", "string")}
            if "description" in pdef:
                prop["description"] = pdef["description"]
            if "items" in pdef:
                prop["items"] = {"type": pdef["items"].get("type", "string")}
            properties[pname] = prop

        tools.append({
            "type": "function",
            "function": {
                "name": name,
                "description": tool_def["description"],
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": tool_def.get("required", []),
                },
            },
        })
    return tools


# ── Circuit Breaker Constants ──────────────────────────────────
CIRCUIT_FAILURE_THRESHOLD = 5      # Open circuit after N consecutive failures
CIRCUIT_INITIAL_TIMEOUT = 60.0     # First timeout in seconds
CIRCUIT_MAX_TIMEOUT = 300.0        # Maximum timeout
BACKOFF_MAX_SLEEP = 60.0           # Maximum backoff sleep

# ── Token Optimization Constants ──────────────────────────────
IDLE_CYCLE_THRESHOLD = 3           # After N idle cycles, start slowing down
IDLE_MAX_MULTIPLIER = 4.0          # Maximum idle slowdown (4x cycle interval)
CONTEXT_DATA_MAX_CHARS = 2000      # Context data truncation
TOOL_RESULT_MAX_CHARS = 4000       # Tool result truncation
TOOL_RESULT_SUMMARY_CHARS = 300    # Tool call summary truncation

# ── Global LLM Concurrency Limiter ───────────────────────────
# Prevents all agents from hitting Ollama/Gemini simultaneously
# Max 2 concurrent LLM calls to avoid resource exhaustion
_LLM_SEMAPHORE: asyncio.Semaphore | None = None


def _get_llm_semaphore() -> asyncio.Semaphore:
    global _LLM_SEMAPHORE
    if _LLM_SEMAPHORE is None:
        _LLM_SEMAPHORE = asyncio.Semaphore(2)
    return _LLM_SEMAPHORE


class BaseAgent(ABC):
    """Abstract base for all SENTINEL AI autonomous agents."""

    def __init__(
        self,
        name: str,
        role: str,
        description: str,
        tier: str,
        model_name: str = "gemma3:27b-cloud",
        tool_names: list[str] | None = None,
        subscriptions: list[str] | None = None,
        cycle_interval: float = 15.0,
        max_tool_calls_per_cycle: int = 10,
        token_budget_per_cycle: int = 50000,
    ):
        self.name = name
        self.role = role
        self.description = description
        self.tier = tier
        self.model_name = model_name
        self.tool_names = tool_names or []
        self.subscriptions = subscriptions or []
        self.cycle_interval = cycle_interval
        self.max_tool_calls_per_cycle = max_tool_calls_per_cycle
        self.token_budget_per_cycle = token_budget_per_cycle

        # State
        self._running = False
        self._task: asyncio.Task | None = None
        self._cycle_count = 0
        self._last_cycle_at: datetime | None = None
        self._last_error: str | None = None
        self._error_count = 0
        self._consecutive_errors = 0
        self._started_at: datetime | None = None
        self._tokens_used_cycle = 0

        # Idle tracking for adaptive intervals
        self._idle_cycles = 0
        self._idle_streak: int = 0
        self._max_idle_multiplier: int = 4
        self._total_tokens_session = 0

        # Circuit breaker state
        self._circuit_open = False
        self._circuit_opened_at: float = 0.0
        self._circuit_timeout = CIRCUIT_INITIAL_TIMEOUT

        # Inbox for inter-agent messages
        self._inbox: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)

        # Build OpenAI-format tools for Ollama
        self._openai_tools = _build_openai_tools(self.tool_names)

        # System prompt
        self._system_prompt = self._build_system_prompt()

    def _build_system_prompt(self) -> str:
        return (
            f"You are {self.name}, a {self.role} agent in the SENTINEL AI "
            f"autonomous physical security system.\n\n"
            f"Your tier: {self.tier}\n"
            f"Your description: {self.description}\n\n"
            f"RULES:\n"
            f"- You are part of a multi-agent team. Communicate findings clearly.\n"
            f"- Use tools to gather real data before making decisions.\n"
            f"- Always provide reasoning for your assessments.\n"
            f"- Be concise but thorough. This is a real-time security system.\n"
            f"- Return structured JSON responses when possible.\n"
            f"- If you're unsure, say so and explain what additional data you need.\n"
        )

    # ── Circuit Breaker ────────────────────────────────────────

    def _check_circuit(self) -> bool:
        """Check if the circuit breaker allows a call. Returns True if call is allowed."""
        if not self._circuit_open:
            return True
        elapsed = time.time() - self._circuit_opened_at
        if elapsed >= self._circuit_timeout:
            logger.info("Agent %s circuit half-open — allowing probe call", self.name)
            return True
        return False

    def _on_call_success(self):
        """Called when an API call succeeds — close circuit and recover."""
        if self._circuit_open:
            logger.info("Agent %s circuit closed — call succeeded", self.name)
        self._circuit_open = False
        self._circuit_timeout = CIRCUIT_INITIAL_TIMEOUT
        self._consecutive_errors = 0
        if self._error_count > 0:
            self._error_count = max(0, self._error_count - 1)

    def _on_call_failure(self, error: str):
        """Called when an API call fails — maybe open circuit."""
        self._consecutive_errors += 1
        self._error_count += 1
        self._last_error = error
        if self._consecutive_errors >= CIRCUIT_FAILURE_THRESHOLD and not self._circuit_open:
            self._circuit_open = True
            self._circuit_opened_at = time.time()
            logger.warning(
                "Agent %s circuit OPEN after %d consecutive failures (timeout=%.0fs)",
                self.name, self._consecutive_errors, self._circuit_timeout,
            )
        elif self._circuit_open:
            self._circuit_timeout = min(self._circuit_timeout * 2, CIRCUIT_MAX_TIMEOUT)
            self._circuit_opened_at = time.time()
            logger.warning(
                "Agent %s circuit re-opened (timeout=%.0fs)",
                self.name, self._circuit_timeout,
            )

    def reset_errors(self):
        """Reset all error counters and close circuit breaker."""
        self._error_count = 0
        self._consecutive_errors = 0
        self._last_error = None
        self._circuit_open = False
        self._circuit_timeout = CIRCUIT_INITIAL_TIMEOUT
        logger.info("Agent %s errors reset", self.name)

    @property
    def status_text(self) -> str:
        if not self._running:
            return "stopped"
        if self._circuit_open:
            return "circuit_open"
        if self._error_count > 0:
            return "degraded"
        return "running"

    # ── Lifecycle ──────────────────────────────────────────────

    async def start(self):
        if self._running:
            return
        self._running = True
        self._started_at = datetime.now(timezone.utc)

        await agent_comms.connect()
        for channel in self.subscriptions:
            await agent_comms.subscribe(channel, self._handle_incoming)

        await self._update_db_state("running")

        self._task = asyncio.create_task(self._run_loop(), name=f"agent_{self.name}")
        logger.info("Agent %s started (tier=%s, model=%s)", self.name, self.tier, self.model_name)

    async def stop(self):
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        for channel in self.subscriptions:
            await agent_comms.unsubscribe(channel)
        await self._update_db_state("stopped")
        logger.info("Agent %s stopped", self.name)

    async def _run_loop(self):
        try:
            while self._running:
                cycle_start = time.time()
                self._tokens_used_cycle = 0
                try:
                    context = await self._collect_context()
                    async with _get_llm_semaphore():
                        result = await self.think(context)
                    if self._is_idle_result(result):
                        self._idle_cycles += 1
                        self._idle_streak += 1
                    else:
                        self._idle_cycles = 0
                        self._idle_streak = 0
                    self._total_tokens_session += self._tokens_used_cycle
                    self._cycle_count += 1
                    self._last_cycle_at = datetime.now(timezone.utc)
                    self._consecutive_errors = 0
                    if self._cycle_count % 5 == 0:
                        await self._send_heartbeat()
                except Exception as e:
                    self._error_count += 1
                    self._consecutive_errors += 1
                    self._last_error = str(e)
                    logger.warning("Agent %s cycle error: %s", self.name, e)
                    await self.log_action("error", {"error": str(e)})

                elapsed = time.time() - cycle_start
                if self._consecutive_errors > 0:
                    backoff = min(
                        self.cycle_interval * (2 ** self._consecutive_errors),
                        BACKOFF_MAX_SLEEP,
                    )
                    sleep_time = max(0, backoff - elapsed)
                else:
                    from backend.services.operation_mode import operation_mode_service
                    perf = operation_mode_service.get_performance_config()
                    effective_interval = self._adaptive_sleep_time() * perf.get("cycle_multiplier", 1.0)
                    if self._idle_cycles > IDLE_CYCLE_THRESHOLD:
                        idle_mult = min(
                            1.0 + (self._idle_cycles - IDLE_CYCLE_THRESHOLD) * 0.5,
                            IDLE_MAX_MULTIPLIER,
                        )
                        effective_interval *= idle_mult
                    sleep_time = max(0, effective_interval - elapsed)
                if sleep_time > 0:
                    await asyncio.sleep(sleep_time)

        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Agent %s loop fatal error", self.name)
            await self._update_db_state("error")

    async def _collect_context(self) -> dict:
        messages = []
        while not self._inbox.empty():
            try:
                messages.append(self._inbox.get_nowait())
            except asyncio.QueueEmpty:
                break

        short_term = await agent_memory.recall_all(self.name)
        return {
            "agent_name": self.name,
            "cycle": self._cycle_count,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "inbox_messages": messages[-20:],
            "short_term_memory": short_term,
        }

    # ── Core reasoning ─────────────────────────────────────────

    @staticmethod
    def _is_idle_result(result) -> bool:
        if not result or not isinstance(result, dict):
            return True
        status = result.get("status", "")
        return status in ("idle", "skip", "no_data", "")

    def _adaptive_sleep_time(self) -> float:
        if self._idle_streak >= 3:
            multiplier = min(2 ** (self._idle_streak - 2), self._max_idle_multiplier)
            return self.cycle_interval * multiplier
        return self.cycle_interval

    @abstractmethod
    async def think(self, context: dict) -> dict:
        ...

    async def execute_tool_loop(
        self,
        prompt: str,
        context_data: dict | None = None,
    ) -> dict:
        """Execute an Ollama function-calling loop."""
        # Circuit breaker check
        if not self._check_circuit():
            remaining = self._circuit_timeout - (time.time() - self._circuit_opened_at)
            return {
                "response": f"Circuit breaker open — retrying in {int(remaining)}s",
                "tool_calls": [],
                "circuit_open": True,
            }

        # Token budget check
        if self._tokens_used_cycle >= self.token_budget_per_cycle:
            return {
                "response": "Token budget exhausted for this cycle",
                "tool_calls": [],
                "budget_exhausted": True,
            }

        # Build full prompt
        full_prompt = prompt
        if context_data:
            full_prompt += f"\n\nCurrent context:\n```json\n{json.dumps(context_data, default=str)[:CONTEXT_DATA_MAX_CHARS]}\n```"

        return await self._execute_tool_loop_ollama(full_prompt, prompt)

    async def _execute_tool_loop_ollama(self, full_prompt: str, original_prompt: str) -> dict:
        """Execute tool loop using Ollama."""
        from backend.services.ollama_provider import ollama_generate_with_tools, is_available_sync

        if not is_available_sync():
            return {
                "response": "Ollama unavailable — is it running?",
                "tool_calls": [],
                "error": True,
            }

        openai_tools = self._openai_tools

        async def tool_executor(fn_name: str, fn_args: dict) -> dict:
            return await self._execute_single_tool(fn_name, fn_args)

        start_ms = time.time()
        try:
            result = await ollama_generate_with_tools(
                prompt=full_prompt,
                tools_schema=openai_tools,
                tool_executor=tool_executor,
                system_prompt=self._system_prompt,
                temperature=0.3,
                max_tokens=4096,
                max_iterations=self.max_tool_calls_per_cycle,
                model=self.model_name,
            )
            self._on_call_success()
        except Exception as e:
            self._on_call_failure(str(e))
            logger.warning("Agent %s Ollama call failed: %s", self.name, e)
            await self.log_action("error", {"error": f"Ollama API error: {e}"})
            return {
                "response": f"Ollama API error: {e}",
                "tool_calls": [],
                "error": True,
            }

        latency = int((time.time() - start_ms) * 1000)

        for tc in result.get("tool_calls", []):
            tc["latency_ms"] = latency
            await self.log_action("tool_call", {
                "tool": tc["tool"],
                "args": tc["args"],
                "result_summary": tc.get("result_summary", "")[:300],
                "latency_ms": latency,
            })

        await self.log_action("decision", {
            "prompt_summary": original_prompt[:300],
            "response_summary": result.get("response", "")[:500],
            "tool_calls_count": len(result.get("tool_calls", [])),
            "latency_ms": latency,
            "ai_provider": "ollama",
        })

        return result

    async def _execute_single_tool(self, fn_name: str, fn_args: dict) -> dict:
        """Execute a single tool call with HITL gate check."""
        tool_def = TOOL_REGISTRY.get(fn_name)
        if not tool_def:
            return {"error": f"Unknown tool: {fn_name}"}
        try:
            from backend.services.operation_mode import operation_mode_service
            if operation_mode_service.should_gate_tool(self.tier, fn_name):
                from backend.services.pending_action_service import pending_action_service
                pending = await pending_action_service.create_pending(
                    agent_name=self.name,
                    tool_name=fn_name,
                    tool_args=fn_args,
                    context_summary=f"{self.name} wants to {fn_name}",
                    severity=fn_args.get("severity", "medium"),
                )
                return {
                    "queued": True,
                    "pending_action_id": str(pending.id),
                    "message": f"Action '{fn_name}' queued for human approval (HITL mode)",
                }
            else:
                return await tool_def["fn"](**fn_args)
        except Exception as e:
            return {"error": str(e)}

    # ── Communication ──────────────────────────────────────────

    async def send_message(self, channel: str, message: dict):
        msg = {
            "from_agent": self.name,
            "tier": self.tier,
            **message,
        }
        await agent_comms.publish(channel, msg)
        await self.log_action("message_sent", {
            "channel": channel,
            "message_type": message.get("type", "unknown"),
        })

    async def _handle_incoming(self, message: dict):
        try:
            self._inbox.put_nowait(message)
        except asyncio.QueueFull:
            try:
                self._inbox.get_nowait()
                self._inbox.put_nowait(message)
            except asyncio.QueueEmpty:
                pass

    # ── Memory ─────────────────────────────────────────────────

    async def remember(self, key: str, value: Any, ttl: int = 300):
        await agent_memory.remember(self.name, key, value, ttl=ttl)

    async def recall(self, key: str) -> Any:
        return await agent_memory.recall(self.name, key)

    async def learn(self, knowledge: str, category: str = "observation",
                    camera_id: str | None = None):
        await agent_memory.learn(
            self.name, knowledge, category=category, camera_id=camera_id
        )

    async def recall_knowledge(self, category: str, limit: int = 10) -> list[dict]:
        return await agent_memory.recall_knowledge(
            self.name, category=category, limit=limit
        )

    # ── Observability ──────────────────────────────────────────

    async def log_action(self, action_type: str, details: dict):
        try:
            async with async_session() as db:
                entry = AgentAuditLog(
                    agent_name=self.name,
                    action_type=action_type,
                    tool_name=details.get("tool"),
                    tool_params=details.get("args"),
                    tool_result_summary=details.get("result_summary"),
                    gemini_prompt_summary=details.get("prompt_summary"),
                    gemini_response_summary=details.get("response_summary"),
                    decision=details.get("decision"),
                    confidence=details.get("confidence"),
                    tokens_used=details.get("tokens_used"),
                    latency_ms=details.get("latency_ms"),
                    target_agent=details.get("target_agent"),
                    channel=details.get("channel"),
                )
                db.add(entry)
                await db.commit()
        except Exception:
            logger.debug("Failed to log agent action for %s", self.name)

        try:
            from backend.services.incident_recorder import incident_recorder
            await incident_recorder.log_agent_action_if_recording(
                agent_name=self.name,
                action_type=action_type,
                details=details,
            )
        except Exception:
            pass

    async def _send_heartbeat(self):
        await agent_comms.publish_heartbeat(self.name, self.status)

    async def _update_db_state(self, status: str):
        try:
            async with async_session() as db:
                from sqlalchemy import select
                result = await db.execute(
                    select(AgentState).where(AgentState.agent_name == self.name)
                )
                state = result.scalar_one_or_none()
                if state is None:
                    state = AgentState(
                        agent_name=self.name,
                        agent_type=self.__class__.__name__,
                        tier=self.tier,
                        status=status,
                    )
                    db.add(state)
                else:
                    state.status = status
                    state.cycle_count = self._cycle_count
                    state.last_cycle_at = self._last_cycle_at
                    state.last_error = self._last_error
                    state.error_count = self._error_count
                    if status == "running":
                        state.started_at = self._started_at
                await db.commit()
        except Exception:
            logger.debug("Failed to update DB state for %s", self.name)

    @property
    def status(self) -> dict:
        return {
            "name": self.name,
            "tier": self.tier,
            "running": self._running,
            "status_text": self.status_text,
            "cycle_count": self._cycle_count,
            "last_cycle_at": self._last_cycle_at.isoformat() if self._last_cycle_at else None,
            "last_error": self._last_error,
            "error_count": self._error_count,
            "consecutive_errors": self._consecutive_errors,
            "circuit_open": self._circuit_open,
            "circuit_timeout": self._circuit_timeout if self._circuit_open else None,
            "started_at": self._started_at.isoformat() if self._started_at else None,
            "tokens_used_last_cycle": self._tokens_used_cycle,
            "total_tokens_session": self._total_tokens_session,
            "idle_cycles": self._idle_cycles,
            "idle_streak": self._idle_streak,
        }
