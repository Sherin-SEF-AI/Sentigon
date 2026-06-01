"""Tests for object-level NL forensic search (plumbing + graceful degradation).

The CLIP model and Qdrant aren't run in CI (heavy / not provisioned), so these
mock the embedder + vector store and verify the query→search→shape→filter
pipeline and graceful fallback. The runtime semantic path reuses the same wiring.
"""
from __future__ import annotations

import pytest

from backend.services.forensic_search_service import _to_epoch
from backend.services.forensic_search_service import forensic_search_service as svc


def test_to_epoch():
    assert _to_epoch(None) is None
    assert _to_epoch(1234) == 1234.0
    assert _to_epoch("2026-01-01T00:00:00+00:00") is not None
    assert _to_epoch("2026-01-01T00:00:00Z") is not None
    assert _to_epoch("not-a-date") is None


@pytest.mark.asyncio
async def test_object_search_empty_when_clip_unavailable(monkeypatch):
    from backend.services.clip_embedder import clip_embedder

    monkeypatch.setattr(clip_embedder, "embed_text_sync", lambda q: [])
    out = await svc.search_objects_by_text("person in a red jacket")
    assert out["result_count"] == 0
    assert out["results"] == []


@pytest.mark.asyncio
async def test_object_search_empty_when_embed_raises(monkeypatch):
    from backend.services.clip_embedder import clip_embedder

    def _boom(_q):
        raise RuntimeError("model not loaded")

    monkeypatch.setattr(clip_embedder, "embed_text_sync", _boom)
    out = await svc.search_objects_by_text("anything")
    assert out["result_count"] == 0  # degraded gracefully, no exception


@pytest.mark.asyncio
async def test_object_search_shapes_results(monkeypatch):
    from backend.services.clip_embedder import clip_embedder
    from backend.services.vector_store import vector_store

    monkeypatch.setattr(clip_embedder, "embed_text_sync", lambda q: [0.1] * 512)
    hits = [
        {"id": "1", "score": 0.91, "entity_id": "e1", "camera_id": "c1",
         "zone_id": None, "timestamp": 1000.0, "behavior": "walking_past"},
        {"id": "2", "score": 0.80, "entity_id": "e2", "camera_id": "c1",
         "zone_id": "z1", "timestamp": 5000.0, "behavior": "loitering"},
    ]

    async def _fake_search(**kwargs):
        assert kwargs["collection"] == "object_crops"
        return hits

    monkeypatch.setattr(vector_store, "search_by_vector", _fake_search)

    out = await svc.search_objects_by_text("red jacket", camera_id="c1")
    assert out["result_count"] == 2
    assert out["results"][0]["entity_id"] == "e1"
    assert out["results"][0]["score"] == 0.91


@pytest.mark.asyncio
async def test_object_search_time_window_filters(monkeypatch):
    from backend.services.clip_embedder import clip_embedder
    from backend.services.vector_store import vector_store

    monkeypatch.setattr(clip_embedder, "embed_text_sync", lambda q: [0.1] * 512)
    hits = [
        {"id": "1", "score": 0.9, "entity_id": "e1", "timestamp": 1000.0},
        {"id": "2", "score": 0.8, "entity_id": "e2", "timestamp": 5000.0},
    ]

    async def _fake_search(**kwargs):
        return hits

    monkeypatch.setattr(vector_store, "search_by_vector", _fake_search)

    out = await svc.search_objects_by_text("x", time_from=0, time_to=2000)
    assert out["result_count"] == 1
    assert out["results"][0]["entity_id"] == "e1"  # ts 5000 excluded by window
