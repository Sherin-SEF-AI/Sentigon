"""Shared pytest fixtures: a real Postgres-backed test DB, an ASGI client,
and user/token factories.

The app's models use Postgres-specific types (UUID, JSONB), so tests run
against a real Postgres instance (provided by CI as a service container, or
locally via docker-compose). Set DATABASE_URL / DATABASE_URL_SYNC to point at
the test database.

Design notes:
- Schema DDL is done with a *synchronous* engine (psycopg2) so it is immune to
  the per-test asyncio event-loop churn that breaks session-scoped async fixtures.
- The schema is reset with DROP SCHEMA ... CASCADE (rather than metadata.drop_all)
  to avoid issues dropping unnamed use_alter foreign keys.
- Each test gets its own async engine with NullPool so asyncpg connections never
  leak across event loops.
- Rate limiting is disabled so the test's request volume doesn't trip 429s.
- Lifespan (migrations, agent startup, webcam enumeration) is NOT run for tests.
"""
from __future__ import annotations

import os

# Must be set before importing app/config.
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("RATE_LIMIT_ENABLED", "false")
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/sentinel_test",
)
os.environ.setdefault(
    "DATABASE_URL_SYNC",
    "postgresql+psycopg2://postgres:postgres@localhost:5432/sentinel_test",
)

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from backend.config import settings
from backend.database import Base, get_db
from backend.main import app
from backend.models import models  # noqa: F401 — ensure models are registered on Base


@pytest.fixture(scope="session", autouse=True)
def _create_schema():
    """Reset and create the schema once per session (synchronous, no event loop)."""
    sync_engine = sa.create_engine(settings.DATABASE_URL_SYNC)
    with sync_engine.begin() as conn:
        conn.execute(sa.text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(sa.text("CREATE SCHEMA public"))
    Base.metadata.create_all(sync_engine)
    yield
    sync_engine.dispose()


@pytest_asyncio.fixture
async def _engine():
    """A fresh async engine per test (NullPool → no cross-loop connection reuse)."""
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def db_session(_engine) -> AsyncSession:
    maker = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as session:
        yield session


@pytest_asyncio.fixture
async def client(_engine) -> AsyncClient:
    """ASGI client with get_db overridden to use the test engine."""
    maker = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)

    async def _override_get_db():
        async with maker() as session:
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
