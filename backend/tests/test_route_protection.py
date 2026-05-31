"""Security regression guard: every mounted HTTP route must reject
unauthenticated access, except a small, explicitly-documented allowlist.

This is the acceptance test for M0.1 (default-deny authorization). If someone
later adds a router or route without auth, this test fails.

Run: pytest backend/tests/test_route_protection.py
"""
from __future__ import annotations

import re

import pytest
from fastapi.routing import APIRoute
from starlette.testclient import TestClient

from backend.main import app

# Paths that are PUBLIC by design. Matched by exact path or prefix.
# Keep this list short and justified — each entry is an auth exception.
_PUBLIC_EXACT = {
    "/health",
    "/api/status",
    "/api/auth/login",
    "/api/auth/register",
    "/openapi.json",
    "/docs",
    "/docs/oauth2-redirect",
    "/redoc",
    "/metrics",
}
_PUBLIC_PREFIXES = (
    "/health",            # top-level liveness probe
    "/api/health",        # k8s liveness/readiness/deep probes
    "/ws",                # WebSocket upgrades (auth handled in-handler)
    "/api/emergency",     # emergency codes — public by design
    "/api/slack",         # Slack HMAC signature verification
    "/api/sso",           # mixed OAuth/LDAP callbacks (FOLLOW-UP: per-route auth + de-mock)
)

# Placeholder values for path parameters so we exercise routing, not 404s.
_PARAM_FILLERS = {
    "default": "00000000-0000-0000-0000-000000000000",
}


def _is_public(path: str) -> bool:
    if path in _PUBLIC_EXACT:
        return True
    return any(path.startswith(p) for p in _PUBLIC_PREFIXES)


def _fill_path(path: str) -> str:
    """Replace {param} segments with a dummy value."""
    return re.sub(r"\{[^}]+\}", _PARAM_FILLERS["default"], path)


def _iter_routes():
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        methods = (route.methods or set()) - {"HEAD", "OPTIONS"}
        if not methods:
            continue
        yield route.path, methods


def _route_cases():
    cases = []
    for path, methods in _iter_routes():
        if _is_public(path):
            continue
        # Prefer a non-mutating method when available to avoid side effects.
        method = "GET" if "GET" in methods else sorted(methods)[0]
        cases.append((method, path))
    return cases


client = TestClient(app)


@pytest.mark.parametrize("method,path", _route_cases())
def test_protected_route_rejects_anonymous(method: str, path: str):
    """An unauthenticated request to a protected route must NOT succeed.

    The security property we assert is: no anonymous request returns a 2xx.
    A 2xx means the route served real data without auth (a hole). 401/403 are
    the expected denials; 404/405/422 can also occur (bad path-param filler or
    method) and are acceptable since the request was not served.
    """
    url = _fill_path(path)
    resp = client.request(method, url)
    assert not (200 <= resp.status_code < 300), (
        f"{method} {path} returned {resp.status_code} WITHOUT authentication "
        "— route appears to be unprotected (served a 2xx anonymously)."
    )


def test_public_allowlist_is_reachable_without_500():
    """Sanity: documented public endpoints don't require auth to be hit."""
    resp = client.get("/health")
    assert resp.status_code == 200
