"""OpenTelemetry Distributed Tracing — auto-instrument FastAPI, SQLAlchemy, httpx.

Environment variables:
    OTEL_ENABLED                 – "true" to activate tracing (default: "false")
    OTEL_SERVICE_NAME            – logical service name (default: "sentinel-ai")
    OTEL_EXPORTER_OTLP_ENDPOINT  – OTLP gRPC collector (default: "localhost:4317")

Usage:
    from backend.middleware.tracing import setup_tracing, get_tracer
    setup_tracing(app, service_name="sentinel-ai")

    tracer = get_tracer(__name__)
    with tracer.start_as_current_span("my-operation"):
        ...
"""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# ── Feature flag ──────────────────────────────────────────────────────────
_OTEL_ENABLED = os.getenv("OTEL_ENABLED", "false").lower() in ("true", "1", "yes")
_SERVICE_NAME = os.getenv("OTEL_SERVICE_NAME", "sentinel-ai")
_OTLP_ENDPOINT = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317")

# ── Internal state ────────────────────────────────────────────────────────
_tracer_provider = None  # set by setup_tracing when OTel is available
_tracing_initialised = False


def setup_tracing(app, service_name: Optional[str] = None) -> None:
    """Configure OpenTelemetry tracing and instrument FastAPI + optional libs.

    Parameters
    ----------
    app:
        The FastAPI application instance.
    service_name:
        Override for the OTEL_SERVICE_NAME env var.

    All instrumentation is best-effort: missing packages are silently skipped.
    """
    global _tracer_provider, _tracing_initialised

    if _tracing_initialised:
        logger.debug("tracing.setup: already initialised — skipping")
        return

    if not _OTEL_ENABLED:
        logger.info("tracing.setup: OTEL_ENABLED is not set — tracing disabled")
        _tracing_initialised = True
        return

    svc = service_name or _SERVICE_NAME

    # ── Core SDK ──────────────────────────────────────────────────────────
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.resources import Resource, SERVICE_NAME as RES_SVC
    except ImportError:
        logger.warning(
            "tracing.setup: opentelemetry-sdk not installed — tracing disabled"
        )
        _tracing_initialised = True
        return

    # ── OTLP exporter ─────────────────────────────────────────────────────
    try:
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter,
        )

        exporter = OTLPSpanExporter(endpoint=_OTLP_ENDPOINT, insecure=True)
    except ImportError:
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter as OTLPHttpExporter,
            )

            # HTTP fallback uses a different default port convention
            http_endpoint = _OTLP_ENDPOINT
            if not http_endpoint.startswith("http"):
                http_endpoint = f"http://{http_endpoint}"
            exporter = OTLPHttpExporter(endpoint=f"{http_endpoint}/v1/traces")
        except ImportError:
            logger.warning(
                "tracing.setup: no OTLP exporter installed "
                "(install opentelemetry-exporter-otlp-proto-grpc or "
                "opentelemetry-exporter-otlp-proto-http) — tracing disabled"
            )
            _tracing_initialised = True
            return

    # ── TracerProvider ────────────────────────────────────────────────────
    resource = Resource.create({RES_SVC: svc})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    _tracer_provider = provider

    logger.info(
        "tracing.setup: TracerProvider configured",
        extra={"service": svc, "endpoint": _OTLP_ENDPOINT},
    )

    # ── FastAPI instrumentation ───────────────────────────────────────────
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app)
        logger.info("tracing.instrument: FastAPI instrumented")
    except ImportError:
        logger.debug(
            "tracing.instrument: opentelemetry-instrumentation-fastapi not installed"
        )
    except Exception as exc:
        logger.warning("tracing.instrument: FastAPI instrumentation failed: %s", exc)

    # ── SQLAlchemy instrumentation ────────────────────────────────────────
    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        # Attempt to grab the sync engine URL for instrumentation; if the
        # project only uses async engines, skip gracefully.
        try:
            from backend.database import engine as _db_engine

            SQLAlchemyInstrumentor().instrument(
                engine=_db_engine.sync_engine,
            )
            logger.info("tracing.instrument: SQLAlchemy instrumented")
        except Exception as db_exc:
            # Instrument globally without a specific engine
            SQLAlchemyInstrumentor().instrument()
            logger.info(
                "tracing.instrument: SQLAlchemy instrumented (global, no engine bind): %s",
                db_exc,
            )
    except ImportError:
        logger.debug(
            "tracing.instrument: opentelemetry-instrumentation-sqlalchemy not installed"
        )
    except Exception as exc:
        logger.warning("tracing.instrument: SQLAlchemy instrumentation failed: %s", exc)

    # ── httpx instrumentation ─────────────────────────────────────────────
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
        logger.info("tracing.instrument: httpx instrumented")
    except ImportError:
        logger.debug(
            "tracing.instrument: opentelemetry-instrumentation-httpx not installed"
        )
    except Exception as exc:
        logger.warning("tracing.instrument: httpx instrumentation failed: %s", exc)

    _tracing_initialised = True
    logger.info("tracing.setup: initialisation complete for service=%s", svc)


# ══════════════════════════════════════════════════════════════════════════
# Convenience accessor
# ══════════════════════════════════════════════════════════════════════════


def get_tracer(name: str = __name__):
    """Return an OpenTelemetry tracer.

    Falls back to the global NoOp tracer if OTel is not installed or not
    enabled, so callers never need to guard usage.
    """
    try:
        from opentelemetry import trace

        return trace.get_tracer(name)
    except ImportError:
        # Return a no-op object whose start_as_current_span() is a no-op
        # context manager.  This lets callers write tracing code without
        # feature-flag guards.
        return _NoOpTracer()


# ── No-op fallback tracer ─────────────────────────────────────────────────

class _NoOpSpan:
    """Minimal stand-in for an OTel span."""

    def set_attribute(self, key, value):
        pass

    def set_status(self, status):
        pass

    def record_exception(self, exc):
        pass

    def end(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class _NoOpTracer:
    """Minimal stand-in for an OTel tracer when the SDK is absent."""

    def start_as_current_span(self, name: str, **kwargs):
        return _NoOpSpan()

    def start_span(self, name: str, **kwargs):
        return _NoOpSpan()
