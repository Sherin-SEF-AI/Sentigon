"""Shared pytest fixtures: a real Postgres-backed test DB, an ASGI client,
and user/token factories.

The app's models use Postgres-specific types (UUID, JSONB), so tests run
against a real Postgres instance (provided by CI as a service container, or
locally via docker-compose). Set DATABASE_URL to point at the test database.

Lifespan (migrations, agent startup, webcam enumeration) is intentionally NOT
run for tests — schema is created directly from the models below.
"""
from __future__ import annotations

import os

# Must be set before importing app/config so the settings validator treats this
# as a non-production environment (no fail-fast on the dev JWT default).
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/sentinel_test",
)

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.config import settings
from backend.database import Base, get_db
from backend.main import app
from backend.models import models  # noqa: F401 — ensure models are registered on Base

_engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
_TestSession = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _create_schema():
    """Create all tables once per session; drop them at the end."""
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await _engine.dispose()


@pytest_asyncio.fixture
async def db_session() -> AsyncSession:
    async with _TestSession() as session:
        yield session


@pytest_asyncio.fixture
async def client() -> AsyncClient:
    """ASGI client with get_db overridden to use the test session factory."""

    async def _override_get_db():
        async with _TestSession() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.pop(get_db, None)


@pytest_asyncio.fixture
async def make_user(db_session: AsyncSession):
    """Factory: create a user with a given role and return (user, password)."""
    from backend.api.auth import hash_password
    from backend.models import User
    from backend.models.models import UserRole

    created = []

    async def _make(email: str, password: str = "testpass123", role: UserRole = UserRole.VIEWER):
        user = User(
            email=email,
            hashed_password=hash_password(password),
            full_name=email.split("@")[0],
            role=role,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)
        created.append(user)
        return user, password

    return _make


@pytest_asyncio.fixture
def auth_headers():
    """Factory: build an Authorization header for a given user."""
    from backend.api.auth import create_access_token

    def _headers(user) -> dict:
        token = create_access_token(str(user.id), user.role.value)
        return {"Authorization": f"Bearer {token}"}

    return _headers
