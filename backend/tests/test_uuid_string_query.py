"""Decisive check: does SQLAlchemy + asyncpg coerce a string to UUID when
comparing against a UUID(as_uuid=True) column?

Many service methods accept string ids (from HTTP path/query params) and compare
them directly to UUID columns, e.g. `where(Model.id == some_str)`. An audit
flagged ~30 such sites as crash bugs. This test settles whether that pattern
actually works on the real stack before any mass "fix".

If this passes, the pattern is safe and no change is needed. If it fails, the
sites are real bugs and need uuid.UUID(...) coercion.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select


@pytest.mark.asyncio
async def test_uuid_column_accepts_string_equality(db_session):
    from backend.models import Camera

    cam = Camera(name="uuid-coerce-test", source="99")
    db_session.add(cam)
    await db_session.commit()
    await db_session.refresh(cam)

    str_id = str(cam.id)  # the form an API path/query param arrives as
    row = (
        await db_session.execute(select(Camera).where(Camera.id == str_id))
    ).scalar_one_or_none()

    assert row is not None, (
        "UUID column == string returned no row — asyncpg did NOT coerce; "
        "the ~30 service sites comparing UUID columns to string ids are real bugs."
    )
    assert row.id == cam.id
