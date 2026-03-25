"""Qdrant vector store with local sentence-transformers embedding.

Uses all-MiniLM-L6-v2 (384d) for text embedding — runs fully offline,
no external API dependency.  CLIP frame embeddings use ViT-bigG-14 (1280d).
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from typing import Any, Dict, List, Optional

from backend.config import settings

logger = logging.getLogger(__name__)

_qdrant_client = None
_st_model = None
_st_lock = threading.Lock()


def _get_st_model():
    """Lazy-load sentence-transformers model (thread-safe)."""
    global _st_model
    if _st_model is None:
        with _st_lock:
            if _st_model is None:
                from sentence_transformers import SentenceTransformer
                _st_model = SentenceTransformer(settings.EMBEDDING_MODEL)
                logger.info("Loaded embedding model: %s (dim=%d)", settings.EMBEDDING_MODEL, settings.EMBEDDING_DIM)
    return _st_model


# All Qdrant collections managed by SENTINEL AI
COLLECTIONS = {
    "sentinel_events": {"dim": settings.EMBEDDING_DIM, "description": "Security events"},
    "vehicle_sightings": {"dim": settings.EMBEDDING_DIM, "description": "Vehicle plate reads and descriptions"},
    "entity_appearances": {"dim": settings.EMBEDDING_DIM, "description": "Person re-identification descriptors"},
    "audio_events": {"dim": settings.EMBEDDING_DIM, "description": "Audio event descriptions"},
    "frame_embeddings": {"dim": settings.CLIP_EMBEDDING_DIM, "description": "CLIP visual frame embeddings"},
}


def _get_client():
    """Lazy-load Qdrant client."""
    global _qdrant_client
    if _qdrant_client is None:
        try:
            from qdrant_client import QdrantClient
            _qdrant_client = QdrantClient(host=settings.QDRANT_HOST, port=settings.QDRANT_PORT)
            logger.info("Qdrant client connected: %s:%s", settings.QDRANT_HOST, settings.QDRANT_PORT)
        except Exception as e:
            logger.error("Failed to connect to Qdrant: %s", e)
            raise
    return _qdrant_client


class VectorStore:
    """Manages Qdrant collections for security event embeddings."""

    def __init__(self):
        self._initialized = False

    def initialize(self):
        """Create or recreate all collections with correct dimensions."""
        try:
            from qdrant_client.models import Distance, VectorParams

            client = _get_client()
            existing_map = {}
            for c in client.get_collections().collections:
                try:
                    info = client.get_collection(c.name)
                    dim = info.config.params.vectors.size
                    existing_map[c.name] = dim
                except Exception:
                    existing_map[c.name] = None

            for name, cfg in COLLECTIONS.items():
                expected_dim = cfg["dim"]
                current_dim = existing_map.get(name)

                if current_dim == expected_dim:
                    logger.info("Qdrant collection OK: %s (%dd)", name, expected_dim)
                    continue

                if name in existing_map:
                    logger.warning(
                        "Qdrant collection %s dim mismatch (%s != %d), recreating",
                        name, current_dim, expected_dim,
                    )
                    client.delete_collection(name)

                client.create_collection(
                    collection_name=name,
                    vectors_config=VectorParams(
                        size=expected_dim,
                        distance=Distance.COSINE,
                    ),
                )
                logger.info("Created Qdrant collection: %s (%dd)", name, expected_dim)

            self._initialized = True
        except Exception as e:
            logger.warning("Qdrant initialization skipped: %s", e)

    async def embed_text(self, text: str) -> List[float]:
        """Generate embedding vector using local sentence-transformers."""
        model = _get_st_model()
        vector = await asyncio.to_thread(model.encode, text)
        return vector.tolist()

    def embed_text_sync(self, text: str) -> List[float]:
        """Synchronous embedding for non-async contexts."""
        model = _get_st_model()
        return model.encode(text).tolist()

    async def upsert_event(
        self,
        event_id: str,
        description: str,
        metadata: Optional[Dict[str, Any]] = None,
        collection: str = "sentinel_events",
    ) -> bool:
        """Embed and store a security event."""
        if not self._initialized:
            logger.warning("Vector store not initialized, skipping upsert")
            return False

        try:
            from qdrant_client.models import PointStruct

            vector = await self.embed_text(description)
            payload = {
                "event_id": event_id,
                "description": description,
                **(metadata or {}),
            }

            client = _get_client()
            client.upsert(
                collection_name=collection,
                points=[
                    PointStruct(
                        id=str(uuid.uuid5(uuid.NAMESPACE_URL, event_id)),
                        vector=vector,
                        payload=payload,
                    )
                ],
            )
            return True
        except Exception as e:
            logger.error("Vector upsert failed: %s", e)
            return False

    async def upsert_with_vector(
        self,
        point_id: str,
        vector: List[float],
        payload: Dict[str, Any],
        collection: str = "sentinel_events",
    ) -> bool:
        """Store a pre-computed vector (avoids double embedding)."""
        if not self._initialized:
            return False
        try:
            from qdrant_client.models import PointStruct
            client = _get_client()
            client.upsert(
                collection_name=collection,
                points=[PointStruct(id=point_id, vector=vector, payload=payload)],
            )
            return True
        except Exception as e:
            logger.error("Vector upsert_with_vector failed: %s", e)
            return False

    async def search(
        self,
        query: str,
        top_k: int = 10,
        filters: Optional[Dict[str, Any]] = None,
        collection: str = "sentinel_events",
    ) -> List[Dict[str, Any]]:
        """Semantic search over a collection."""
        if not self._initialized:
            return []

        try:
            from qdrant_client.models import Filter, FieldCondition, MatchValue

            vector = await self.embed_text(query)
            client = _get_client()

            qdrant_filter = None
            if filters:
                conditions = []
                for key, value in filters.items():
                    conditions.append(
                        FieldCondition(key=key, match=MatchValue(value=value))
                    )
                if conditions:
                    qdrant_filter = Filter(must=conditions)

            try:
                results_obj = client.query_points(
                    collection_name=collection,
                    query=vector,
                    limit=top_k,
                    query_filter=qdrant_filter,
                )
                hits = results_obj.points
            except (AttributeError, TypeError):
                hits = client.search(
                    collection_name=collection,
                    query_vector=vector,
                    limit=top_k,
                    query_filter=qdrant_filter,
                )

            return [
                {
                    "id": str(hit.id),
                    "score": round(hit.score, 4),
                    **hit.payload,
                }
                for hit in hits
            ]
        except Exception as e:
            logger.error("Vector search failed: %s", e)
            return []

    async def search_by_vector(
        self,
        vector: List[float],
        top_k: int = 10,
        filters: Optional[Dict[str, Any]] = None,
        collection: str = "sentinel_events",
        score_threshold: float = 0.0,
    ) -> List[Dict[str, Any]]:
        """Search using a pre-computed vector."""
        if not self._initialized:
            return []
        try:
            from qdrant_client.models import Filter, FieldCondition, MatchValue

            client = _get_client()

            qdrant_filter = None
            if filters:
                conditions = []
                for key, value in filters.items():
                    conditions.append(
                        FieldCondition(key=key, match=MatchValue(value=value))
                    )
                if conditions:
                    qdrant_filter = Filter(must=conditions)

            # Use query_points (v2 API) with fallback to search (v1)
            try:
                results_obj = client.query_points(
                    collection_name=collection,
                    query=vector,
                    limit=top_k,
                    query_filter=qdrant_filter,
                    score_threshold=score_threshold if score_threshold > 0 else None,
                )
                hits = results_obj.points
            except (AttributeError, TypeError):
                hits = client.search(
                    collection_name=collection,
                    query_vector=vector,
                    limit=top_k,
                    query_filter=qdrant_filter,
                    score_threshold=score_threshold,
                )

            return [
                {
                    "id": str(hit.id),
                    "score": round(hit.score, 4),
                    **hit.payload,
                }
                for hit in hits
            ]
        except Exception as e:
            logger.error("Vector search_by_vector failed: %s", e)
            return []

    async def search_similar_events(self, event_id: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """Find events similar to a given event."""
        if not self._initialized:
            return []

        try:
            client = _get_client()
            point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, event_id))

            results = client.recommend(
                collection_name=settings.QDRANT_COLLECTION,
                positive=[point_id],
                limit=top_k,
            )

            return [
                {
                    "event_id": hit.payload.get("event_id", ""),
                    "score": round(hit.score, 4),
                    "description": hit.payload.get("description", ""),
                    "metadata": hit.payload,
                }
                for hit in results
            ]
        except Exception as e:
            logger.error("Similar search failed: %s", e)
            return []

    def delete_event(self, event_id: str) -> bool:
        """Remove an event from the vector store."""
        if not self._initialized:
            return False
        try:
            from qdrant_client.models import PointIdsList
            client = _get_client()
            point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, event_id))
            client.delete(
                collection_name=settings.QDRANT_COLLECTION,
                points_selector=PointIdsList(points=[point_id]),
            )
            return True
        except Exception as e:
            logger.error("Vector delete failed: %s", e)
            return False

    # ── CLIP visual search methods ──────────────────────────

    async def upsert_frame_embedding(
        self,
        point_id: str,
        vector: List[float],
        camera_id: str,
        timestamp: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Store a CLIP frame embedding in the frame_embeddings collection."""
        payload = {
            "camera_id": camera_id,
            "timestamp": timestamp,
            **(metadata or {}),
        }
        return await self.upsert_with_vector(
            point_id=point_id,
            vector=vector,
            payload=payload,
            collection="frame_embeddings",
        )

    async def visual_search_by_text(
        self,
        text_vector: List[float],
        top_k: int = 20,
        camera_ids: Optional[List[str]] = None,
        min_score: float = 0.15,
    ) -> List[Dict[str, Any]]:
        """Search frame embeddings using a CLIP text vector."""
        filters = {}
        if camera_ids:
            filters["camera_id"] = camera_ids[0]  # single camera filter
        return await self.search_by_vector(
            vector=text_vector,
            top_k=top_k,
            filters=filters if filters else None,
            collection="frame_embeddings",
            score_threshold=min_score,
        )

    async def visual_search_by_image(
        self,
        image_vector: List[float],
        top_k: int = 20,
        camera_ids: Optional[List[str]] = None,
        min_score: float = 0.5,
    ) -> List[Dict[str, Any]]:
        """Search frame embeddings using a CLIP image vector."""
        filters = {}
        if camera_ids:
            filters["camera_id"] = camera_ids[0]
        return await self.search_by_vector(
            vector=image_vector,
            top_k=top_k,
            filters=filters if filters else None,
            collection="frame_embeddings",
            score_threshold=min_score,
        )

    async def get_frame_embedding_stats(self) -> Dict[str, Any]:
        """Return stats for the frame_embeddings collection."""
        if not self._initialized:
            return {"points_count": 0, "status": "not_initialized"}
        try:
            client = _get_client()
            info = client.get_collection("frame_embeddings")
            return {
                "points_count": info.points_count,
                "status": info.status.value if info.status else "unknown",
                "vectors_dim": settings.CLIP_EMBEDDING_DIM,
            }
        except Exception:
            return {"points_count": 0, "status": "error"}

    async def get_recent_embeddings(
        self,
        camera_id: str,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Get recent embeddings for a camera (for timeline)."""
        if not self._initialized:
            return []
        try:
            from qdrant_client.models import Filter, FieldCondition, MatchValue

            client = _get_client()
            results = client.scroll(
                collection_name="frame_embeddings",
                scroll_filter=Filter(
                    must=[FieldCondition(key="camera_id", match=MatchValue(value=camera_id))]
                ),
                limit=limit,
                with_vectors=False,
            )
            points = results[0] if results else []
            return [
                {"id": str(p.id), **p.payload}
                for p in points
            ]
        except Exception as e:
            logger.error("get_recent_embeddings failed: %s", e)
            return []

    async def delete_old_embeddings(self, older_than_iso: str) -> int:
        """Delete frame embeddings older than the given ISO timestamp.

        Scrolls for old points and deletes by ID since Qdrant Range
        doesn't support string comparisons on ISO timestamps.
        """
        if not self._initialized:
            return 0
        try:
            from qdrant_client.models import PointIdsList

            client = _get_client()

            # Scroll all points and filter by timestamp string comparison
            old_ids = []
            offset = None
            while True:
                result = client.scroll(
                    collection_name="frame_embeddings",
                    limit=100,
                    offset=offset,
                    with_vectors=False,
                )
                points, next_offset = result
                for p in points:
                    ts = p.payload.get("timestamp", "")
                    if ts and ts < older_than_iso:
                        old_ids.append(p.id)
                if next_offset is None or not points:
                    break
                offset = next_offset

            if old_ids:
                client.delete(
                    collection_name="frame_embeddings",
                    points_selector=PointIdsList(points=old_ids),
                )
            return len(old_ids)
        except Exception as e:
            logger.error("delete_old_embeddings failed: %s", e)
            return 0

    @property
    def collection_info(self) -> Optional[Dict]:
        if not self._initialized:
            return None
        try:
            client = _get_client()
            info = client.get_collection(settings.QDRANT_COLLECTION)
            return {
                "name": info.config.params.vectors.size if hasattr(info.config.params, 'vectors') else None,
                "points_count": info.points_count,
                "status": info.status.value if info.status else "unknown",
            }
        except Exception:
            return None


# Singleton
vector_store = VectorStore()
