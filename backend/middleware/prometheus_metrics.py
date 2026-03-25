"""Prometheus Metrics Middleware — HTTP and business metrics for SENTINEL AI.

Exports PrometheusMiddleware (Starlette BaseHTTPMiddleware) and business-level
gauges/counters for alerts, cameras, agents, detections, WebSocket connections,
and AI inference latency.

Usage:
    from backend.middleware.prometheus_metrics import PrometheusMiddleware
    app.add_middleware(PrometheusMiddleware)

Metrics endpoint:
    from backend.middleware.prometheus_metrics import get_metrics_response
    @app.get("/metrics")
    async def metrics():
        return get_metrics_response()
"""
from __future__ import annotations

import logging
import re
import time
from typing import Callable, Optional

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import PlainTextResponse

logger = logging.getLogger(__name__)

# ── Prometheus client (graceful fallback) ─────────────────────────────────

try:
    from prometheus_client import (
        Counter,
        Gauge,
        Histogram,
        generate_latest,
        CONTENT_TYPE_LATEST,
        CollectorRegistry,
        REGISTRY,
    )

    _PROMETHEUS_AVAILABLE = True
except ImportError:
    _PROMETHEUS_AVAILABLE = False
    logger.info("prometheus_client not installed — metrics disabled")

# ── Path normalisation ────────────────────────────────────────────────────
# Replace UUIDs and numeric IDs in URL paths with placeholders to keep
# cardinality under control.

_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_NUMERIC_ID_RE = re.compile(r"/\d+(?=/|$)")


def _normalise_path(path: str) -> str:
    """Strip UUIDs and numeric IDs from a URL path for metric labels."""
    path = _UUID_RE.sub("{id}", path)
    path = _NUMERIC_ID_RE.sub("/{id}", path)
    return path


# ══════════════════════════════════════════════════════════════════════════
# HTTP metrics
# ══════════════════════════════════════════════════════════════════════════

if _PROMETHEUS_AVAILABLE:
    # --- HTTP request metrics ---
    http_requests_total = Counter(
        "http_requests_total",
        "Total HTTP requests",
        ["method", "path", "status_code"],
    )

    http_request_duration_seconds = Histogram(
        "http_request_duration_seconds",
        "HTTP request latency in seconds",
        ["method", "path"],
        buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
    )

    http_requests_in_progress = Gauge(
        "http_requests_in_progress",
        "Number of HTTP requests currently being processed",
        ["method"],
    )

    # --- SENTINEL AI business metrics ---

    sentinel_alerts_total = Counter(
        "sentinel_alerts_total",
        "Total security alerts raised",
        ["severity", "source"],
    )

    sentinel_cameras_active = Gauge(
        "sentinel_cameras_active",
        "Number of cameras currently streaming",
    )

    sentinel_agents_active = Gauge(
        "sentinel_agents_active",
        "Number of AI agents currently running",
    )

    sentinel_detections_total = Counter(
        "sentinel_detections_total",
        "Total object/event detections",
        ["detection_type"],
    )

    sentinel_ws_connections = Gauge(
        "sentinel_ws_connections",
        "Current WebSocket connections",
    )

    sentinel_ai_inference_duration = Histogram(
        "sentinel_ai_inference_duration_seconds",
        "AI model inference latency in seconds",
        ["model"],
        buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0),
    )

else:
    # ── Fallback stubs so callers don't need to guard every usage ─────────

    class _NoOpMetric:
        """No-op stand-in when prometheus_client is not installed."""

        def labels(self, *args, **kwargs):  # type: ignore[override]
            return self

        def inc(self, amount: float = 1) -> None:
            pass

        def dec(self, amount: float = 1) -> None:
            pass

        def set(self, value: float) -> None:
            pass

        def observe(self, amount: float) -> None:
            pass

    http_requests_total = _NoOpMetric()  # type: ignore[assignment]
    http_request_duration_seconds = _NoOpMetric()  # type: ignore[assignment]
    http_requests_in_progress = _NoOpMetric()  # type: ignore[assignment]

    sentinel_alerts_total = _NoOpMetric()  # type: ignore[assignment]
    sentinel_cameras_active = _NoOpMetric()  # type: ignore[assignment]
    sentinel_agents_active = _NoOpMetric()  # type: ignore[assignment]
    sentinel_detections_total = _NoOpMetric()  # type: ignore[assignment]
    sentinel_ws_connections = _NoOpMetric()  # type: ignore[assignment]
    sentinel_ai_inference_duration = _NoOpMetric()  # type: ignore[assignment]


# ══════════════════════════════════════════════════════════════════════════
# Middleware
# ══════════════════════════════════════════════════════════════════════════

# Paths to exclude from request metrics (high-cardinality or internal).
_SKIP_PATHS = frozenset({"/metrics", "/health", "/docs", "/openapi.json", "/redoc"})


class PrometheusMiddleware(BaseHTTPMiddleware):
    """Track per-request HTTP metrics and expose them for Prometheus scraping."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        method = request.method
        raw_path = request.url.path

        # Skip internal / high-frequency paths
        if raw_path in _SKIP_PATHS or raw_path.startswith("/ws"):
            return await call_next(request)

        path = _normalise_path(raw_path)

        http_requests_in_progress.labels(method=method).inc()
        start = time.perf_counter()

        try:
            response = await call_next(request)
            status_code = str(response.status_code)
        except Exception:
            status_code = "500"
            raise
        finally:
            elapsed = time.perf_counter() - start
            http_requests_total.labels(
                method=method, path=path, status_code=status_code
            ).inc()
            http_request_duration_seconds.labels(method=method, path=path).observe(
                elapsed
            )
            http_requests_in_progress.labels(method=method).dec()

        return response


# ══════════════════════════════════════════════════════════════════════════
# Metrics endpoint helper
# ══════════════════════════════════════════════════════════════════════════


def get_metrics_response() -> Response:
    """Return an HTTP response containing all registered Prometheus metrics
    in the standard text exposition format.

    If prometheus_client is not installed, returns a 501 plaintext response.
    """
    if not _PROMETHEUS_AVAILABLE:
        return PlainTextResponse(
            "prometheus_client is not installed", status_code=501
        )

    return Response(
        content=generate_latest(REGISTRY),
        media_type=CONTENT_TYPE_LATEST,
    )
