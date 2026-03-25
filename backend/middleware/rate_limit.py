"""Rate Limiting Middleware — token-bucket per-IP rate limiting.

Limits: 100 req/min general, 10 req/min login, 30 req/min AI endpoints.
"""
from __future__ import annotations

import time
import logging
from collections import defaultdict
from typing import Dict, Tuple

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)

# ── Rate limit configurations ────────────────────────────────────
_LIMITS: Dict[str, Tuple[int, int]] = {
    # path_prefix: (max_requests, window_seconds)
    "/api/auth/login": (10, 60),
    "/api/intelligence": (30, 60),
    "/api/copilot": (30, 60),
    "/api/neural-council": (20, 60),
    "/api/forensics": (30, 60),
    "default": (100, 60),
}


class _TokenBucket:
    """Simple token bucket for rate limiting."""

    def __init__(self, max_tokens: int, refill_seconds: int) -> None:
        self.max_tokens = max_tokens
        self.refill_seconds = refill_seconds
        self.tokens = float(max_tokens)
        self.last_refill = time.monotonic()

    def consume(self) -> bool:
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.tokens = min(
            self.max_tokens,
            self.tokens + elapsed * (self.max_tokens / self.refill_seconds),
        )
        self.last_refill = now

        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False

    @property
    def retry_after(self) -> int:
        if self.tokens >= 1:
            return 0
        return max(1, int(self.refill_seconds / self.max_tokens))


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Per-IP rate limiting middleware with path-specific limits."""

    def __init__(self, app, **kwargs):
        super().__init__(app, **kwargs)
        # {(ip, limit_key): TokenBucket}
        self._buckets: Dict[Tuple[str, str], _TokenBucket] = defaultdict(
            lambda: _TokenBucket(100, 60)
        )

    def _get_limit(self, path: str) -> Tuple[str, int, int]:
        """Get the applicable rate limit for a path."""
        for prefix, (max_req, window) in _LIMITS.items():
            if prefix != "default" and path.startswith(prefix):
                return prefix, max_req, window
        return "default", *_LIMITS["default"]

    def _get_bucket(self, ip: str, limit_key: str, max_req: int, window: int) -> _TokenBucket:
        key = (ip, limit_key)
        if key not in self._buckets:
            self._buckets[key] = _TokenBucket(max_req, window)
        return self._buckets[key]

    async def dispatch(self, request: Request, call_next):
        # Skip rate limiting for health checks and WebSocket
        path = request.url.path
        if path in ("/health", "/ws") or path.startswith("/docs") or path.startswith("/openapi"):
            return await call_next(request)

        ip = request.client.host if request.client else "unknown"
        limit_key, max_req, window = self._get_limit(path)
        bucket = self._get_bucket(ip, limit_key, max_req, window)

        if not bucket.consume():
            logger.warning(
                "rate_limit.exceeded ip=%s path=%s limit=%d/%ds",
                ip, path, max_req, window,
            )
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "Rate limit exceeded",
                    "retry_after": bucket.retry_after,
                    "limit": f"{max_req} requests per {window}s",
                },
                headers={"Retry-After": str(bucket.retry_after)},
            )

        return await call_next(request)
