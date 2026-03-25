"""Circuit breaker pattern for external service calls (DB, Redis, Ollama, Gemini).

Prevents cascading failures by short-circuiting calls to failing services
and allowing periodic recovery probes.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import time
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


class CircuitBreakerOpenError(Exception):
    """Raised when a call is attempted on an open circuit."""

    def __init__(self, name: str, remaining_seconds: float = 0.0):
        self.name = name
        self.remaining_seconds = remaining_seconds
        super().__init__(
            f"Circuit '{name}' is OPEN. Recovery in {remaining_seconds:.1f}s"
        )


class CircuitState(enum.Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    """Async-aware circuit breaker.

    Parameters
    ----------
    name : str
        Human-readable identifier for logging.
    failure_threshold : int
        Consecutive failures before the circuit opens (default 5).
    recovery_timeout : float
        Seconds the circuit stays open before moving to half-open (default 30).
    half_open_max_calls : int
        Max concurrent probe calls allowed in half-open state (default 1).
    """

    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        recovery_timeout: float = 30.0,
        half_open_max_calls: int = 1,
    ):
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.half_open_max_calls = half_open_max_calls

        self._state: CircuitState = CircuitState.CLOSED
        self._failure_count: int = 0
        self._success_count: int = 0
        self._last_failure_time: float = 0.0
        self._half_open_calls: int = 0
        self._lock = asyncio.Lock()

        # Metrics
        self._total_calls: int = 0
        self._total_failures: int = 0
        self._total_blocked: int = 0
        self._last_state_change: float = time.time()

    # ── Public API ────────────────────────────────────────────

    @property
    def state(self) -> CircuitState:
        """Return current state, auto-transitioning OPEN -> HALF_OPEN if timeout elapsed."""
        if self._state == CircuitState.OPEN:
            elapsed = time.time() - self._last_failure_time
            if elapsed >= self.recovery_timeout:
                self._transition(CircuitState.HALF_OPEN)
        return self._state

    async def call(self, func: Callable, *args: Any, **kwargs: Any) -> Any:
        """Execute *func* through the circuit breaker.

        Parameters
        ----------
        func : Callable
            An async or sync callable to protect.
        *args, **kwargs :
            Arguments forwarded to *func*.

        Returns
        -------
        Any
            The result of *func*.

        Raises
        ------
        CircuitBreakerOpenError
            If the circuit is open and recovery timeout has not elapsed.
        """
        async with self._lock:
            current_state = self.state

            if current_state == CircuitState.OPEN:
                remaining = self.recovery_timeout - (time.time() - self._last_failure_time)
                self._total_blocked += 1
                raise CircuitBreakerOpenError(self.name, max(remaining, 0))

            if current_state == CircuitState.HALF_OPEN:
                if self._half_open_calls >= self.half_open_max_calls:
                    self._total_blocked += 1
                    raise CircuitBreakerOpenError(self.name, 0)
                self._half_open_calls += 1

        self._total_calls += 1

        try:
            if asyncio.iscoroutinefunction(func):
                result = await func(*args, **kwargs)
            else:
                result = func(*args, **kwargs)
            await self._on_success()
            return result
        except CircuitBreakerOpenError:
            raise
        except Exception as exc:
            await self._on_failure(exc)
            raise

    # ── Internal state management ─────────────────────────────

    async def _on_success(self) -> None:
        async with self._lock:
            if self._state == CircuitState.HALF_OPEN:
                self._success_count += 1
                if self._success_count >= self.half_open_max_calls:
                    self._transition(CircuitState.CLOSED)
                    logger.info(
                        "Circuit '%s' CLOSED after successful probe(s)",
                        self.name,
                    )
            else:
                # Reset consecutive failure count on any success in CLOSED
                self._failure_count = 0

    async def _on_failure(self, exc: Exception) -> None:
        async with self._lock:
            self._failure_count += 1
            self._total_failures += 1
            self._last_failure_time = time.time()

            if self._state == CircuitState.HALF_OPEN:
                # Probe failed — go back to OPEN
                self._transition(CircuitState.OPEN)
                logger.warning(
                    "Circuit '%s' re-OPENED after half-open probe failure: %s",
                    self.name,
                    exc,
                )
            elif self._failure_count >= self.failure_threshold:
                self._transition(CircuitState.OPEN)
                logger.error(
                    "Circuit '%s' OPENED after %d consecutive failures: %s",
                    self.name,
                    self._failure_count,
                    exc,
                )

    def _transition(self, new_state: CircuitState) -> None:
        old = self._state
        self._state = new_state
        self._last_state_change = time.time()
        if new_state == CircuitState.CLOSED:
            self._failure_count = 0
            self._success_count = 0
            self._half_open_calls = 0
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_calls = 0
            self._success_count = 0
        logger.debug(
            "Circuit '%s' transitioned %s -> %s",
            self.name,
            old.value,
            new_state.value,
        )

    # ── Introspection ─────────────────────────────────────────

    def reset(self) -> None:
        """Manually reset the circuit to CLOSED."""
        self._transition(CircuitState.CLOSED)
        self._last_failure_time = 0.0
        logger.info("Circuit '%s' manually reset to CLOSED", self.name)

    @property
    def metrics(self) -> dict:
        return {
            "name": self.name,
            "state": self.state.value,
            "failure_count": self._failure_count,
            "total_calls": self._total_calls,
            "total_failures": self._total_failures,
            "total_blocked": self._total_blocked,
            "last_failure": self._last_failure_time,
            "last_state_change": self._last_state_change,
        }

    # Backward-compatible alias
    @property
    def status(self) -> dict:
        return self.metrics

    def __repr__(self) -> str:
        return (
            f"CircuitBreaker(name={self.name!r}, state={self.state.value}, "
            f"failures={self._failure_count}/{self.failure_threshold})"
        )


# ── Global Circuit Breaker Instances ──────────────────────────

db_circuit = CircuitBreaker(
    name="database",
    failure_threshold=5,
    recovery_timeout=30.0,
    half_open_max_calls=1,
)

redis_circuit = CircuitBreaker(
    name="redis",
    failure_threshold=3,
    recovery_timeout=15.0,
    half_open_max_calls=2,
)

ollama_circuit = CircuitBreaker(
    name="ollama",
    failure_threshold=5,
    recovery_timeout=60.0,
    half_open_max_calls=1,
)

gemini_circuit = CircuitBreaker(
    name="gemini",
    failure_threshold=5,
    recovery_timeout=45.0,
    half_open_max_calls=1,
)
