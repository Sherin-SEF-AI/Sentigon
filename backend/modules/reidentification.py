"""Privacy-preserving re-identification engine.

Tracks individuals across cameras WITHOUT facial recognition, using
appearance descriptors embedded with Gemini. Stores appearance vectors
in Qdrant entity_appearances collection for cross-camera matching.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from backend.config import settings
from backend.database import async_session
from backend.models.advanced_models import CameraBaseline  # noqa: F401 — re-export convenience
from backend.modules.gemini_client import analyze_frame_flash, generate_embedding
from backend.services.vector_store import vector_store
from sqlalchemy import select

logger = logging.getLogger(__name__)


class ReIdentificationEngine:
    """Privacy-preserving re-identification using appearance descriptors.

    Extracts non-biometric descriptors (clothing, build, carried items,
    hair style, accessories) via Gemini 3 Flash and stores them as
    semantic vectors in Qdrant for cross-camera matching.  No facial
    features are captured at any stage.
    """

    COLLECTION = "entity_appearances"

    APPEARANCE_PROMPT = (
        "Extract a detailed appearance descriptor for this person. "
        "Do NOT describe facial features.\n"
        "Focus on: clothing (top color, bottom color, type), footwear, "
        "carried items (bags, umbrellas, etc.), body build (slim/medium/heavy), "
        "approximate height relative to surroundings, hair style/color (general), "
        "distinctive features (hat, glasses shape, visible tattoos on arms, accessories).\n"
        "Generate a concise re-identification string that could match this person "
        "in another camera view."
    )

    APPEARANCE_SCHEMA: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "top_clothing": {
                "type": "object",
                "properties": {
                    "color": {"type": "string"},
                    "type": {"type": "string"},
                },
            },
            "bottom_clothing": {
                "type": "object",
                "properties": {
                    "color": {"type": "string"},
                    "type": {"type": "string"},
                },
            },
            "footwear": {"type": "string"},
            "carried_items": {"type": "array", "items": {"type": "string"}},
            "body_build": {"type": "string", "enum": ["slim", "medium", "heavy"]},
            "hair": {"type": "string"},
            "distinctive_features": {"type": "array", "items": {"type": "string"}},
            "reid_string": {"type": "string"},
        },
        "required": ["top_clothing", "bottom_clothing", "body_build", "reid_string"],
    }

    # ── Public API ────────────────────────────────────────────────

    async def extract_appearance(
        self,
        person_crop_bytes: bytes,
        camera_id: str,
    ) -> dict:
        """Extract appearance descriptor using Gemini 3 Flash.

        Args:
            person_crop_bytes: JPEG-encoded crop of a single person.
            camera_id: Originating camera identifier.

        Returns:
            Parsed appearance descriptor dict (matches APPEARANCE_SCHEMA).
        """
        try:
            result = await analyze_frame_flash(
                frame_bytes=person_crop_bytes,
                prompt=self.APPEARANCE_PROMPT,
                json_schema=self.APPEARANCE_SCHEMA,
                thinking_level="low",
            )
            if not result or "reid_string" not in result:
                logger.warning(
                    "reid.extract.empty camera=%s — Gemini returned no reid_string",
                    camera_id,
                )
                return {}

            # Attach provenance metadata
            result["camera_id"] = camera_id
            result["extracted_at"] = datetime.now(timezone.utc).isoformat()
            logger.info(
                "reid.extract.ok camera=%s build=%s reid=%s",
                camera_id,
                result.get("body_build", "?"),
                result.get("reid_string", "")[:80],
            )
            return result

        except Exception as exc:
            logger.error("reid.extract.error camera=%s err=%s", camera_id, exc)
            return {}

    async def store_appearance(
        self,
        descriptor: dict,
        camera_id: str,
        frame_path: Optional[str] = None,
        bounding_box: Optional[dict] = None,
    ) -> str:
        """Store appearance in Qdrant ``entity_appearances`` collection.

        The ``reid_string`` field is embedded via ``generate_embedding`` and
        used as the vector for similarity matching.

        Args:
            descriptor: Appearance descriptor from :meth:`extract_appearance`.
            camera_id: Camera that captured this sighting.
            frame_path: Optional path to the full frame on disk.
            bounding_box: Optional ``{x, y, w, h}`` of the person crop.

        Returns:
            A newly generated ``entity_id`` (UUID4 hex string).
        """
        reid_string = descriptor.get("reid_string", "")
        if not reid_string:
            logger.warning("reid.store.skip — empty reid_string")
            return ""

        entity_id = uuid.uuid4().hex
        point_id = uuid.uuid4().hex

        try:
            vector = await generate_embedding(reid_string, dimensions=settings.EMBEDDING_DIM)

            payload: Dict[str, Any] = {
                "entity_id": entity_id,
                "camera_id": camera_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "reid_string": reid_string,
                "descriptor": {
                    "top_clothing": descriptor.get("top_clothing"),
                    "bottom_clothing": descriptor.get("bottom_clothing"),
                    "footwear": descriptor.get("footwear"),
                    "body_build": descriptor.get("body_build"),
                    "hair": descriptor.get("hair"),
                    "carried_items": descriptor.get("carried_items", []),
                    "distinctive_features": descriptor.get("distinctive_features", []),
                },
            }
            if frame_path:
                payload["frame_path"] = frame_path
            if bounding_box:
                payload["bounding_box"] = bounding_box

            ok = await vector_store.upsert_with_vector(
                point_id=point_id,
                vector=vector,
                payload=payload,
                collection=self.COLLECTION,
            )
            if ok:
                logger.info(
                    "reid.store.ok entity=%s camera=%s",
                    entity_id,
                    camera_id,
                )
            else:
                logger.warning("reid.store.fail entity=%s — upsert returned False", entity_id)

            return entity_id

        except Exception as exc:
            logger.error("reid.store.error camera=%s err=%s", camera_id, exc)
            return ""

    async def find_matches(
        self,
        descriptor: dict,
        exclude_camera: Optional[str] = None,
        time_window_hours: float = 2.0,
        threshold: float = 0.82,
    ) -> list:
        """Find cross-camera matches for this appearance.

        Embeds the ``reid_string`` and queries Qdrant for similar
        appearance vectors from *other* cameras within the given time
        window.

        Args:
            descriptor: Appearance descriptor containing ``reid_string``.
            exclude_camera: Camera ID to exclude (usually the source camera).
            time_window_hours: How far back to search (default 2 h).
            threshold: Minimum cosine-similarity score to consider a match.

        Returns:
            List of match dicts sorted by descending score, each containing
            ``entity_id``, ``camera_id``, ``score``, ``reid_string``, and
            ``timestamp``.
        """
        reid_string = descriptor.get("reid_string", "")
        if not reid_string:
            return []

        try:
            from qdrant_client.models import (
                FieldCondition,
                Filter,
                MatchValue,
                Range,
            )

            vector = await generate_embedding(reid_string, dimensions=settings.EMBEDDING_DIM)

            # Build filter: exclude source camera and restrict time window
            conditions: List[Any] = []

            if exclude_camera:
                # Qdrant doesn't support "must_not" via search_by_vector helper,
                # so we use the raw client approach through vector_store.
                pass  # Handled below via must_not

            cutoff = (
                datetime.now(timezone.utc) - timedelta(hours=time_window_hours)
            ).isoformat()

            conditions.append(
                FieldCondition(key="timestamp", range=Range(gte=cutoff))
            )

            must_not = []
            if exclude_camera:
                must_not.append(
                    FieldCondition(key="camera_id", match=MatchValue(value=exclude_camera))
                )

            qdrant_filter = Filter(must=conditions, must_not=must_not if must_not else None)

            # Use raw Qdrant client for richer filtering
            from backend.services.vector_store import _get_client

            client = _get_client()
            results = client.search(
                collection_name=self.COLLECTION,
                query_vector=vector,
                limit=20,
                query_filter=qdrant_filter,
                score_threshold=threshold,
            )

            matches = []
            for hit in results:
                matches.append({
                    "entity_id": hit.payload.get("entity_id", ""),
                    "camera_id": hit.payload.get("camera_id", ""),
                    "score": round(hit.score, 4),
                    "reid_string": hit.payload.get("reid_string", ""),
                    "timestamp": hit.payload.get("timestamp", ""),
                    "descriptor": hit.payload.get("descriptor", {}),
                    "frame_path": hit.payload.get("frame_path"),
                })

            matches.sort(key=lambda m: m["score"], reverse=True)
            logger.info(
                "reid.match.ok query_camera=%s matches=%d threshold=%.2f",
                exclude_camera or "any",
                len(matches),
                threshold,
            )
            return matches

        except Exception as exc:
            logger.error("reid.match.error err=%s", exc)
            return []

    async def search_by_description(
        self,
        description: str,
        time_from: Optional[str] = None,
        time_to: Optional[str] = None,
        cameras: Optional[list] = None,
        top_k: int = 20,
    ) -> list:
        """Search for persons matching a natural language description.

        Leverages the vector store semantic search on the
        ``entity_appearances`` collection.

        Args:
            description: Free-text description (e.g. "man in red jacket
                with black backpack").
            time_from: ISO-8601 lower bound (inclusive).
            time_to: ISO-8601 upper bound (inclusive).
            cameras: Optional list of camera IDs to restrict search to.
            top_k: Maximum results to return.

        Returns:
            List of matching appearance records with scores.
        """
        try:
            # Build Qdrant filters
            filters: Dict[str, Any] = {}
            if cameras and len(cameras) == 1:
                filters["camera_id"] = cameras[0]

            results = await vector_store.search(
                query=description,
                top_k=top_k,
                filters=filters if filters else None,
                collection=self.COLLECTION,
            )

            # Post-filter by time window and camera list (multi-camera)
            filtered: List[Dict[str, Any]] = []
            for r in results:
                ts = r.get("timestamp", "")

                if time_from and ts < time_from:
                    continue
                if time_to and ts > time_to:
                    continue
                if cameras and len(cameras) > 1 and r.get("camera_id") not in cameras:
                    continue

                filtered.append(r)

            logger.info(
                "reid.search.ok query='%s' results=%d (of %d raw)",
                description[:60],
                len(filtered),
                len(results),
            )
            return filtered

        except Exception as exc:
            logger.error("reid.search.error query='%s' err=%s", description[:60], exc)
            return []

    async def get_entity_path(self, entity_id: str) -> dict:
        """Get the cross-camera path of an entity.

        Retrieves all sightings linked to this ``entity_id`` across
        cameras, ordered chronologically.

        Args:
            entity_id: The unique entity identifier returned by
                :meth:`store_appearance`.

        Returns:
            Dict with ``entity_id``, ``sightings`` list (each with
            ``camera_id``, ``timestamp``, ``reid_string``), and
            ``camera_count``.
        """
        try:
            from qdrant_client.models import FieldCondition, Filter, MatchValue
            from backend.services.vector_store import _get_client

            client = _get_client()

            # Scroll through all points for this entity
            qdrant_filter = Filter(
                must=[
                    FieldCondition(key="entity_id", match=MatchValue(value=entity_id)),
                ]
            )

            points, _next = client.scroll(
                collection_name=self.COLLECTION,
                scroll_filter=qdrant_filter,
                limit=200,
            )

            sightings = []
            camera_set: set = set()
            for pt in points:
                p = pt.payload or {}
                cam = p.get("camera_id", "")
                camera_set.add(cam)
                sightings.append({
                    "camera_id": cam,
                    "timestamp": p.get("timestamp", ""),
                    "reid_string": p.get("reid_string", ""),
                    "frame_path": p.get("frame_path"),
                    "bounding_box": p.get("bounding_box"),
                })

            # Sort chronologically
            sightings.sort(key=lambda s: s["timestamp"])

            logger.info(
                "reid.path.ok entity=%s sightings=%d cameras=%d",
                entity_id,
                len(sightings),
                len(camera_set),
            )
            return {
                "entity_id": entity_id,
                "sightings": sightings,
                "camera_count": len(camera_set),
                "cameras": sorted(camera_set),
                "first_seen": sightings[0]["timestamp"] if sightings else None,
                "last_seen": sightings[-1]["timestamp"] if sightings else None,
            }

        except Exception as exc:
            logger.error("reid.path.error entity=%s err=%s", entity_id, exc)
            return {
                "entity_id": entity_id,
                "sightings": [],
                "camera_count": 0,
                "cameras": [],
                "first_seen": None,
                "last_seen": None,
            }


# Singleton
reid_engine = ReIdentificationEngine()
