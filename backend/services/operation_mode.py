"""Operation Mode service — manages Autonomous vs HITL mode."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from backend.database import async_session
from backend.models.system_settings import SystemSetting

logger = logging.getLogger(__name__)

# Default settings
_DEFAULT_MODE = "autonomous"
_DEFAULT_AUTO_APPROVE_TIMEOUT = 600  # 10 minutes
_DEFAULT_PERFORMANCE_MODE = "standard"
_DEFAULT_AI_PROVIDER = "gemini"  # Primary: Gemini, Fallback: Ollama
_VALID_AI_PROVIDERS = {"gemini", "ollama"}

# Performance mode definitions
PERFORMANCE_MODES = {
    "ultra_fast": {
        "label": "Ultra Fast",
        "gemini_enabled": False,
        "thinking_level": None,
        "cycle_multiplier": 0.2,
        "analysis_interval": 0,
        "max_output_tokens": 0,
        "ai_provider": None,
        "description": "YOLO detection only, zero AI latency, sub-second response",
        "use_case": "Maximum throughput when AI analysis is not needed",
    },
    "low_latency": {
        "label": "Low Latency",
        "gemini_enabled": True,
        "thinking_level": None,
        "cycle_multiplier": 0.5,
        "analysis_interval": 10,
        "max_output_tokens": 1024,
        "ai_provider": "gemini",
        "model": "gemini-3.1-flash-lite-preview",
        "description": "Gemini 3.1 Flash Lite for fast AI analysis with minimal delay",
        "use_case": "Real-time monitoring with quick threat classification",
    },
    "standard": {
        "label": "Standard",
        "gemini_enabled": True,
        "thinking_level": "low",
        "cycle_multiplier": 1.0,
        "analysis_interval": 15,
        "max_output_tokens": 2048,
        "ai_provider": "gemini",
        "model": "gemini-3-flash-preview",
        "description": "Gemini 3 Flash with thinking, balanced speed and depth",
        "use_case": "Default operational mode for SOC operations",
    },
    "advanced": {
        "label": "Advanced",
        "gemini_enabled": True,
        "thinking_level": "medium",
        "cycle_multiplier": 2.0,
        "analysis_interval": 5,
        "max_output_tokens": 4096,
        "ai_provider": "gemini",
        "model": "gemini-3.1-pro-preview",
        "description": "Gemini Pro with deep reasoning for complex threat analysis",
        "use_case": "Active incidents requiring thorough investigation",
    },
    "max_accuracy": {
        "label": "Max Accuracy",
        "gemini_enabled": True,
        "thinking_level": "high",
        "cycle_multiplier": 3.0,
        "analysis_interval": 3,
        "max_output_tokens": 8192,
        "ai_provider": "gemini",
        "model": "gemini-3.1-pro-preview",
        "description": "Maximum AI depth with extended reasoning and multi-pass analysis",
        "use_case": "Critical incidents, forensic investigation, threat hunting",
    },
}


class OperationModeService:
    """Singleton that manages the system operation mode (autonomous vs HITL)."""

    # Tools that require human approval in HITL mode (action tools only)
    GATED_TOOLS = frozenset({
        "create_alert",
        "escalate_alert",
        "update_alert_status",
        "send_notification",
        "trigger_recording",
    })

    def __init__(self):
        self._mode: str = _DEFAULT_MODE
        self._auto_approve_timeout: int = _DEFAULT_AUTO_APPROVE_TIMEOUT
        self._performance_mode: str = _DEFAULT_PERFORMANCE_MODE
        self._ai_provider: str = _DEFAULT_AI_PROVIDER
        self._initialized: bool = False

    async def _ensure_init(self):
        """Load mode from DB on first access."""
        if self._initialized:
            return
        try:
            async with async_session() as session:
                # Load operation mode
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "operation_mode")
                )
                setting = result.scalar_one_or_none()
                if setting:
                    self._mode = setting.value
                else:
                    # Insert default
                    session.add(SystemSetting(key="operation_mode", value=_DEFAULT_MODE))
                    await session.commit()

                # Load auto-approve timeout
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "hitl_auto_approve_timeout")
                )
                setting = result.scalar_one_or_none()
                if setting:
                    self._auto_approve_timeout = int(setting.value)
                else:
                    session.add(SystemSetting(
                        key="hitl_auto_approve_timeout",
                        value=str(_DEFAULT_AUTO_APPROVE_TIMEOUT),
                    ))
                    await session.commit()

                # Load performance mode
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "performance_mode")
                )
                setting = result.scalar_one_or_none()
                if setting and setting.value in PERFORMANCE_MODES:
                    self._performance_mode = setting.value
                else:
                    session.add(SystemSetting(key="performance_mode", value=_DEFAULT_PERFORMANCE_MODE))
                    await session.commit()

                # Load AI provider preference
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "ai_provider")
                )
                setting = result.scalar_one_or_none()
                if setting and setting.value in _VALID_AI_PROVIDERS:
                    self._ai_provider = setting.value
                else:
                    session.add(SystemSetting(key="ai_provider", value=_DEFAULT_AI_PROVIDER))
                    await session.commit()

            self._initialized = True
        except Exception as e:
            logger.warning("operation_mode.init_failed", error=str(e))
            self._initialized = True  # Use defaults

    async def get_mode(self) -> str:
        await self._ensure_init()
        return self._mode

    async def set_mode(self, mode: str, user_id: uuid.UUID | None = None) -> str:
        """Switch operation mode. Returns previous mode."""
        await self._ensure_init()
        previous = self._mode
        self._mode = mode

        try:
            async with async_session() as session:
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "operation_mode")
                )
                setting = result.scalar_one_or_none()
                if setting:
                    setting.value = mode
                    setting.updated_by = user_id
                    setting.updated_at = datetime.now(timezone.utc)
                else:
                    session.add(SystemSetting(
                        key="operation_mode", value=mode, updated_by=user_id,
                    ))
                await session.commit()
        except Exception as e:
            logger.error("operation_mode.set_failed", error=str(e))

        logger.info("operation_mode.changed", previous=previous, new=mode)
        return previous

    def is_hitl(self) -> bool:
        """Check if currently in HITL mode (non-async for hot path)."""
        return self._mode == "hitl"

    def should_gate_tool(self, agent_tier: str, tool_name: str) -> bool:
        """Check whether a tool call should be gated for human approval.

        Only gates action-tier agents calling action tools in HITL mode.
        """
        if not self.is_hitl():
            return False
        if agent_tier not in ("action", "supervisor"):
            return False
        return tool_name in self.GATED_TOOLS

    async def get_auto_approve_timeout(self) -> int:
        await self._ensure_init()
        return self._auto_approve_timeout

    async def set_auto_approve_timeout(self, seconds: int, user_id: uuid.UUID | None = None):
        await self._ensure_init()
        self._auto_approve_timeout = seconds
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "hitl_auto_approve_timeout")
                )
                setting = result.scalar_one_or_none()
                if setting:
                    setting.value = str(seconds)
                    setting.updated_by = user_id
                    setting.updated_at = datetime.now(timezone.utc)
                else:
                    session.add(SystemSetting(
                        key="hitl_auto_approve_timeout",
                        value=str(seconds),
                        updated_by=user_id,
                    ))
                await session.commit()
        except Exception as e:
            logger.error("operation_mode.timeout_set_failed", error=str(e))

    # ── Performance Mode ──────────────────────────────────────────

    async def get_performance_mode(self) -> str:
        await self._ensure_init()
        return self._performance_mode

    def get_performance_config(self) -> dict:
        """Return the full config dict for the current performance mode (non-async for hot path)."""
        return PERFORMANCE_MODES.get(self._performance_mode, PERFORMANCE_MODES["standard"])

    async def set_performance_mode(self, mode: str, user_id: uuid.UUID | None = None) -> str:
        """Switch performance mode. Returns previous mode."""
        if mode not in PERFORMANCE_MODES:
            raise ValueError(f"Invalid performance mode: {mode}")
        await self._ensure_init()
        previous = self._performance_mode
        self._performance_mode = mode

        try:
            async with async_session() as session:
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "performance_mode")
                )
                setting = result.scalar_one_or_none()
                if setting:
                    setting.value = mode
                    setting.updated_by = user_id
                    setting.updated_at = datetime.now(timezone.utc)
                else:
                    session.add(SystemSetting(
                        key="performance_mode", value=mode, updated_by=user_id,
                    ))
                await session.commit()
        except Exception as e:
            logger.error("performance_mode.set_failed", error=str(e))

        logger.info("performance_mode.changed", previous=previous, new=mode)
        return previous

    # ── AI Provider ─────────────────────────────────────────────

    async def get_ai_provider(self) -> str:
        await self._ensure_init()
        return self._ai_provider

    def get_ai_provider_sync(self) -> str:
        """Non-async for hot path."""
        return self._ai_provider

    async def set_ai_provider(self, provider: str, user_id: uuid.UUID | None = None) -> str:
        """Switch AI provider. Returns previous provider."""
        if provider not in _VALID_AI_PROVIDERS:
            raise ValueError(f"Invalid AI provider: {provider}. Valid: {_VALID_AI_PROVIDERS}")
        await self._ensure_init()
        previous = self._ai_provider
        self._ai_provider = provider

        try:
            async with async_session() as session:
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "ai_provider")
                )
                setting = result.scalar_one_or_none()
                if setting:
                    setting.value = provider
                    setting.updated_by = user_id
                    setting.updated_at = datetime.now(timezone.utc)
                else:
                    session.add(SystemSetting(
                        key="ai_provider", value=provider, updated_by=user_id,
                    ))
                await session.commit()
        except Exception as e:
            logger.error("ai_provider.set_failed", error=str(e))

        logger.info("ai_provider.changed", previous=previous, new=provider)
        return previous

    def should_use_groq(self) -> bool:
        """Legacy — always False. Only Ollama is available."""
        return False

    def should_try_gemini_first(self) -> bool:
        """Legacy — always False. Only Ollama is available."""
        return False

    def should_use_ollama(self) -> bool:
        """Always True — Ollama is the only provider."""
        return True

    def should_use_openai(self) -> bool:
        """Legacy — always False. Only Ollama is available."""
        return False

    async def get_status(self) -> dict:
        """Full status for API response."""
        await self._ensure_init()
        from backend.services.pending_action_service import pending_action_service
        count = await pending_action_service.get_pending_count()
        return {
            "mode": self._mode,
            "auto_approve_timeout": self._auto_approve_timeout,
            "pending_count": count,
            "performance_mode": self._performance_mode,
            "ai_provider": self._ai_provider,
        }


    # ── Adaptive Time Scheduling ─────────────────────────────────

    def __init_schedule(self):
        """Lazily initialize schedule list."""
        if not hasattr(self, "_schedule"):
            self._schedule: list[dict] = []

    async def get_schedule(self) -> list[dict]:
        """Get the current adaptive schedule entries."""
        self.__init_schedule()
        return list(self._schedule)

    async def set_schedule(self, entries: list[dict], user_id: uuid.UUID | None = None) -> list[dict]:
        """Replace the schedule with new entries.

        Each entry: {
            "name": str,
            "days": ["mon","tue",...],  # days of week
            "start_hour": int (0-23),
            "end_hour": int (0-23),
            "mode": "autonomous"|"hitl" (optional),
            "performance": "ultra_fast"|"low_latency"|"standard"|"advanced" (optional),
            "context_profile": str (optional),
        }
        """
        self.__init_schedule()
        validated = []
        for e in entries:
            entry = {
                "name": e.get("name", "Unnamed"),
                "days": e.get("days", []),
                "start_hour": int(e.get("start_hour", 0)),
                "end_hour": int(e.get("end_hour", 23)),
            }
            if "mode" in e:
                entry["mode"] = e["mode"]
            if "performance" in e:
                if e["performance"] in PERFORMANCE_MODES:
                    entry["performance"] = e["performance"]
            if "context_profile" in e:
                entry["context_profile"] = e["context_profile"]
            validated.append(entry)

        self._schedule = validated

        # Persist to DB
        import json as _json
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == "adaptive_schedule")
                )
                setting = result.scalar_one_or_none()
                if setting:
                    setting.value = _json.dumps(validated)
                    setting.updated_by = user_id
                    setting.updated_at = datetime.now(timezone.utc)
                else:
                    session.add(SystemSetting(
                        key="adaptive_schedule",
                        value=_json.dumps(validated),
                        updated_by=user_id,
                    ))
                await session.commit()
        except Exception as e:
            logger.error("schedule.set_failed", error=str(e))

        logger.info("schedule.updated entries=%d", len(validated))
        return validated

    async def check_and_apply_schedule(self) -> dict | None:
        """Check schedule and apply matching entry for current time/day.

        Called periodically (every 60s) from main.py background task.
        Returns dict with applied changes, or None if no match.
        """
        self.__init_schedule()

        # Load schedule from DB if empty
        if not self._schedule:
            try:
                import json as _json
                async with async_session() as session:
                    result = await session.execute(
                        select(SystemSetting).where(SystemSetting.key == "adaptive_schedule")
                    )
                    setting = result.scalar_one_or_none()
                    if setting and setting.value:
                        self._schedule = _json.loads(setting.value)
            except Exception:
                pass

        if not self._schedule:
            return None

        now = datetime.now()
        day_name = now.strftime("%a").lower()  # mon, tue, etc.
        hour = now.hour

        for entry in self._schedule:
            days = [d.lower()[:3] for d in entry.get("days", [])]
            if days and day_name not in days:
                continue

            start_h = entry.get("start_hour", 0)
            end_h = entry.get("end_hour", 23)

            # Handle overnight ranges (e.g., 22 to 6)
            if start_h <= end_h:
                in_window = start_h <= hour < end_h
            else:
                in_window = hour >= start_h or hour < end_h

            if not in_window:
                continue

            # This entry matches — apply its settings
            changes = {"schedule_entry": entry["name"]}

            if "mode" in entry and entry["mode"] != self._mode:
                await self.set_mode(entry["mode"])
                changes["mode"] = entry["mode"]

            if "performance" in entry and entry["performance"] != self._performance_mode:
                await self.set_performance_mode(entry["performance"])
                changes["performance"] = entry["performance"]

            if "context_profile" in entry:
                try:
                    from backend.services.context_profiles import context_profile_service
                    if context_profile_service.active_profile_name != entry["context_profile"]:
                        context_profile_service.set_active_profile(entry["context_profile"])
                        changes["context_profile"] = entry["context_profile"]
                except Exception:
                    pass

            if len(changes) > 1:  # More than just the entry name
                logger.info("schedule.applied entry=%s changes=%s", entry["name"], changes)
                return changes

            return None  # Matched but no changes needed

        return None


# Singleton
operation_mode_service = OperationModeService()
