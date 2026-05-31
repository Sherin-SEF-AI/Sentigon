"""Authentication & RBAC tests.

Covers the security-critical behaviors hardened in M0.1:
- login success/failure and disabled accounts
- /me requires a valid token
- registration NEVER grants elevated roles (privilege-escalation guard)
- role hierarchy enforcement on admin-only routes
"""
from __future__ import annotations

import pytest

from backend.models.models import UserRole


@pytest.mark.asyncio
async def test_login_success_returns_token(client, make_user):
    user, password = await make_user("login-ok@test.local")
    resp = await client.post(
        "/api/auth/login", json={"email": user.email, "password": password}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["access_token"]
    assert body["user"]["email"] == user.email


@pytest.mark.asyncio
async def test_login_wrong_password_rejected(client, make_user):
    user, _ = await make_user("login-bad@test.local")
    resp = await client.post(
        "/api/auth/login", json={"email": user.email, "password": "wrong"}
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_me_requires_token(client):
    resp = await client.get("/api/auth/me")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_me_with_token(client, make_user, auth_headers):
    user, _ = await make_user("me@test.local")
    resp = await client.get("/api/auth/me", headers=auth_headers(user))
    assert resp.status_code == 200
    assert resp.json()["email"] == user.email


@pytest.mark.asyncio
async def test_register_ignores_requested_admin_role(client):
    """A self-service registration must never produce a privileged account."""
    resp = await client.post(
        "/api/auth/register",
        json={
            "email": "escalate@test.local",
            "password": "supersecret",
            "full_name": "Would-be Admin",
            "role": "admin",  # malicious: try to self-assign admin
        },
    )
    assert resp.status_code == 201
    assert resp.json()["role"] == UserRole.VIEWER.value


@pytest.mark.asyncio
async def test_viewer_cannot_list_users(client, make_user, auth_headers):
    viewer, _ = await make_user("viewer@test.local", role=UserRole.VIEWER)
    resp = await client.get("/api/auth/users", headers=auth_headers(viewer))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_admin_can_list_users(client, make_user, auth_headers):
    admin, _ = await make_user("admin@test.local", role=UserRole.ADMIN)
    resp = await client.get("/api/auth/users", headers=auth_headers(admin))
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_inactive_user_cannot_login(client, make_user, db_session):
    user, password = await make_user("disabled@test.local")
    user.is_active = False
    await db_session.commit()
    resp = await client.post(
        "/api/auth/login", json={"email": user.email, "password": password}
    )
    assert resp.status_code == 403
