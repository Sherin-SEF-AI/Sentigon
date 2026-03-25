"""License Plate Recognition engine using Gemini 3 Flash vision.

Provides plate reading, vehicle sighting storage, watchlist matching,
semantic vehicle search, plate timeline tracking, and dwell-time analysis.
All AI calls go through the unified gemini_client; vector storage uses Qdrant.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from backend.config import settings
from backend.database import async_session
from backend.models.advanced_models import (
    VehicleSighting,
    VehicleWatchlist,
    VehicleTrip,
)
from backend.modules.gemini_client import analyze_frame_flash, generate_embedding
from backend.services.vector_store import vector_store

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────

VEHICLE_SIGHTINGS_COLLECTION = "vehicle_sightings"

# Default dwell-time threshold (seconds) after which to flag a vehicle.
# 8 hours = 28 800 seconds.  Applies outside business hours by default.
DEFAULT_DWELL_THRESHOLD_SECONDS = 8 * 60 * 60

# Business-hour window used by dwell-time logic (24-h clock, local).
BUSINESS_HOUR_START = 8   # 08:00
BUSINESS_HOUR_END = 18    # 18:00


class LPREngine:
    """License Plate Recognition using Gemini 3 Flash vision."""

    LPR_PROMPT = (
        "You are a license plate recognition system. Analyze this vehicle image and extract:\n"
        "1. License plate text (alphanumeric characters only, no spaces)\n"
        "2. Plate confidence (0.0-1.0)\n"
        "3. Plate region/format if identifiable (e.g., \"Indian\", \"US\", \"EU\")\n"
        "4. Vehicle attributes: color, type (sedan/SUV/truck/van/motorcycle/bus), make, model (if identifiable)\n"
        "5. Vehicle direction of travel (if determinable from image context)\n\n"
        "If no plate is visible or readable, set plate_text to null and confidence to 0.\n"
        "If plate is partially visible, return what you can read and set confidence accordingly."
    )

    LPR_SCHEMA: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "plate_text": {"type": ["string", "null"]},
            "plate_confidence": {"type": "number"},
            "plate_region": {"type": "string"},
            "vehicle_color": {"type": "string"},
            "vehicle_type": {"type": "string"},
            "vehicle_make": {"type": ["string", "null"]},
            "vehicle_model": {"type": ["string", "null"]},
            "vehicle_direction": {"type": ["string", "null"]},
        },
        "required": [
            "plate_text",
            "plate_confidence",
            "plate_region",
            "vehicle_color",
            "vehicle_type",
        ],
    }

    # ── Core plate reading ───────────────────────────────────────

    async def read_plate(self, frame_bytes: bytes, camera_id: str) -> dict:
        """Read license plate from a vehicle crop image using Gemini 3 Flash.

        Args:
            frame_bytes: JPEG-encoded image bytes of the vehicle crop.
            camera_id: Identifier of the source camera.

        Returns:
            Dict with plate_text, plate_confidence, plate_region, vehicle_color,
            vehicle_type, vehicle_make, vehicle_model, vehicle_direction, and
            camera_id.  Returns a fallback dict on failure.
        """
        try:
            result = await analyze_frame_flash(
                frame_bytes=frame_bytes,
                prompt=self.LPR_PROMPT,
                json_schema=self.LPR_SCHEMA,
                media_resolution="media_resolution_high",
            )

            # Normalise plate text: strip whitespace, uppercase
            plate_text = result.get("plate_text")
            if plate_text:
                plate_text = re.sub(r"\s+", "", plate_text).upper()
                result["plate_text"] = plate_text

            result["camera_id"] = camera_id
            logger.info(
                "lpr.read_plate camera=%s plate=%s conf=%.2f",
                camera_id,
                result.get("plate_text", "N/A"),
                result.get("plate_confidence", 0.0),
            )
            return result

        except Exception as exc:
            logger.error("lpr.read_plate failed camera=%s: %s", camera_id, exc)
            return {
                "plate_text": None,
                "plate_confidence": 0.0,
                "plate_region": "unknown",
                "vehicle_color": "unknown",
                "vehicle_type": "unknown",
                "vehicle_make": None,
                "vehicle_model": None,
                "vehicle_direction": None,
                "camera_id": camera_id,
                "error": str(exc),
            }

    # ── Sighting storage ─────────────────────────────────────────

    async def store_sighting(
        self,
        plate_data: dict,
        camera_id: str,
        frame_path: str = None,
    ) -> VehicleSighting:
        """Persist a plate sighting in PostgreSQL and index it in Qdrant.

        Args:
            plate_data: Dict returned by :meth:`read_plate`.
            camera_id: UUID-string of the camera that captured the vehicle.
            frame_path: Optional filesystem path to the saved JPEG frame.

        Returns:
            The created :class:`VehicleSighting` ORM instance.
        """
        sighting_id = uuid.uuid4()

        # -- 1. Database insert ------------------------------------------------
        async with async_session() as session:
            try:
                sighting = VehicleSighting(
                    id=sighting_id,
                    camera_id=uuid.UUID(camera_id) if isinstance(camera_id, str) else camera_id,
                    plate_text=plate_data.get("plate_text"),
                    plate_confidence=plate_data.get("plate_confidence", 0.0),
                    plate_region=plate_data.get("plate_region"),
                    vehicle_color=plate_data.get("vehicle_color"),
                    vehicle_type=plate_data.get("vehicle_type"),
                    vehicle_make=plate_data.get("vehicle_make"),
                    vehicle_model=plate_data.get("vehicle_model"),
                    vehicle_direction=plate_data.get("vehicle_direction"),
                    frame_path=frame_path,
                )
                session.add(sighting)
                await session.commit()
                await session.refresh(sighting)
                logger.info(
                    "lpr.store_sighting id=%s plate=%s camera=%s",
                    sighting_id,
                    plate_data.get("plate_text", "N/A"),
                    camera_id,
                )
            except Exception as exc:
                await session.rollback()
                logger.error("lpr.store_sighting db error: %s", exc)
                raise

        # -- 2. Vector index (best-effort) ------------------------------------
        try:
            description = (
                f"{plate_data.get('vehicle_color', 'unknown')} "
                f"{plate_data.get('vehicle_type', 'vehicle')} "
                f"plate:{plate_data.get('plate_text', 'unreadable')} "
                f"at {camera_id}"
            )
            embedding = await generate_embedding(description, dimensions=settings.EMBEDDING_DIM)

            payload = {
                "sighting_id": str(sighting_id),
                "plate_text": plate_data.get("plate_text"),
                "plate_confidence": plate_data.get("plate_confidence", 0.0),
                "vehicle_color": plate_data.get("vehicle_color"),
                "vehicle_type": plate_data.get("vehicle_type"),
                "vehicle_make": plate_data.get("vehicle_make"),
                "vehicle_model": plate_data.get("vehicle_model"),
                "camera_id": str(camera_id),
                "description": description,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

            point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, str(sighting_id)))
            await vector_store.upsert_with_vector(
                point_id=point_id,
                vector=embedding,
                payload=payload,
                collection=VEHICLE_SIGHTINGS_COLLECTION,
            )
            logger.debug("lpr.store_sighting vector indexed id=%s", sighting_id)

        except Exception as exc:
            # Vector failure is non-fatal; the DB record is the source of truth.
            logger.warning("lpr.store_sighting vector upsert failed: %s", exc)

        return sighting

    # ── Watchlist checking ───────────────────────────────────────

    async def check_watchlist(self, plate_text: str) -> list:
        """Check a plate against the watchlist (exact match + regex patterns).

        Args:
            plate_text: Normalised plate string to look up.

        Returns:
            List of dicts, each containing watchlist entry details and the
            match_type ("exact" or "pattern").
        """
        if not plate_text:
            return []

        matches: List[Dict[str, Any]] = []
        normalised = plate_text.upper().strip()

        async with async_session() as session:
            try:
                # Fetch all active watchlist entries
                stmt = select(VehicleWatchlist).where(
                    VehicleWatchlist.active.is_(True),
                )
                result = await session.execute(stmt)
                entries = result.scalars().all()

                for entry in entries:
                    matched = False
                    match_type: Optional[str] = None

                    # Exact match (case-insensitive)
                    if entry.plate_text and entry.plate_text.upper() == normalised:
                        matched = True
                        match_type = "exact"

                    # Regex / pattern match
                    if not matched and entry.plate_pattern:
                        try:
                            if re.fullmatch(entry.plate_pattern, normalised, re.IGNORECASE):
                                matched = True
                                match_type = "pattern"
                        except re.error as regex_err:
                            logger.warning(
                                "lpr.check_watchlist invalid regex id=%s pattern=%s: %s",
                                entry.id,
                                entry.plate_pattern,
                                regex_err,
                            )

                    if matched:
                        matches.append({
                            "watchlist_id": str(entry.id),
                            "plate_text": entry.plate_text,
                            "plate_pattern": entry.plate_pattern,
                            "reason": entry.reason,
                            "severity": entry.severity,
                            "notes": entry.notes,
                            "match_type": match_type,
                            "expires_at": entry.expires_at.isoformat() if entry.expires_at else None,
                        })

                logger.info(
                    "lpr.check_watchlist plate=%s matches=%d",
                    normalised,
                    len(matches),
                )

            except Exception as exc:
                logger.error("lpr.check_watchlist error: %s", exc)

        return matches

    # ── Semantic vehicle search ──────────────────────────────────

    async def search_vehicles(self, query: str, top_k: int = 20) -> list:
        """Semantic search across vehicle sightings in Qdrant.

        Args:
            query: Free-text description, e.g. "red truck near main gate".
            top_k: Maximum number of results to return.

        Returns:
            List of result dicts with score and sighting metadata.
        """
        try:
            results = await vector_store.search(
                query=query,
                top_k=top_k,
                collection=VEHICLE_SIGHTINGS_COLLECTION,
            )
            logger.info(
                "lpr.search_vehicles query=%r results=%d",
                query,
                len(results),
            )
            return results

        except Exception as exc:
            logger.error("lpr.search_vehicles error: %s", exc)
            return []

    # ── Plate timeline ───────────────────────────────────────────

    async def get_plate_timeline(self, plate_text: str) -> dict:
        """Retrieve every sighting of a plate ordered chronologically.

        Args:
            plate_text: The license plate string.

        Returns:
            Dict with plate_text, sightings list, cameras visited, total
            sighting count, and any watchlist matches.
        """
        if not plate_text:
            return {
                "plate_text": plate_text,
                "sightings": [],
                "sighting_count": 0,
                "cameras": [],
                "watchlist_matches": [],
            }

        normalised = plate_text.upper().strip()

        async with async_session() as session:
            try:
                # All sightings for this plate, chronological
                stmt = (
                    select(VehicleSighting)
                    .where(VehicleSighting.plate_text == normalised)
                    .order_by(VehicleSighting.timestamp.asc())
                )
                result = await session.execute(stmt)
                sightings = result.scalars().all()

                sighting_dicts = []
                cameras_seen: List[str] = []
                for s in sightings:
                    cam_id = str(s.camera_id)
                    if cam_id not in cameras_seen:
                        cameras_seen.append(cam_id)
                    sighting_dicts.append({
                        "id": str(s.id),
                        "camera_id": cam_id,
                        "timestamp": s.timestamp.isoformat() if s.timestamp else None,
                        "plate_confidence": s.plate_confidence,
                        "vehicle_color": s.vehicle_color,
                        "vehicle_type": s.vehicle_type,
                        "vehicle_make": s.vehicle_make,
                        "vehicle_model": s.vehicle_model,
                        "vehicle_direction": s.vehicle_direction,
                        "frame_path": s.frame_path,
                    })

            except Exception as exc:
                logger.error("lpr.get_plate_timeline db error: %s", exc)
                sighting_dicts = []
                cameras_seen = []

        # Attach watchlist info
        watchlist_matches = await self.check_watchlist(normalised)

        timeline = {
            "plate_text": normalised,
            "sightings": sighting_dicts,
            "sighting_count": len(sighting_dicts),
            "cameras": cameras_seen,
            "first_seen": sighting_dicts[0]["timestamp"] if sighting_dicts else None,
            "last_seen": sighting_dicts[-1]["timestamp"] if sighting_dicts else None,
            "watchlist_matches": watchlist_matches,
        }

        logger.info(
            "lpr.get_plate_timeline plate=%s sightings=%d cameras=%d",
            normalised,
            len(sighting_dicts),
            len(cameras_seen),
        )
        return timeline

    # ── Dwell-time tracking ──────────────────────────────────────

    async def track_dwell_time(
        self,
        plate_text: str,
        camera_id: str,
        dwell_threshold_seconds: int = DEFAULT_DWELL_THRESHOLD_SECONDS,
    ) -> dict:
        """Calculate how long a vehicle has been present at a specific camera.

        Args:
            plate_text: The license plate to track.
            camera_id: Camera / zone identifier to scope the calculation.
            dwell_threshold_seconds: Seconds after which the vehicle is flagged
                as overstaying.  Defaults to 8 hours.

        Returns:
            Dict with first_seen, last_seen, dwell_seconds, flagged bool, and
            optional trip_id if an active trip record exists.
        """
        if not plate_text:
            return {
                "plate_text": plate_text,
                "camera_id": camera_id,
                "dwell_seconds": 0,
                "flagged": False,
                "reason": "no plate text provided",
            }

        normalised = plate_text.upper().strip()
        now = datetime.now(timezone.utc)

        async with async_session() as session:
            try:
                camera_uuid = uuid.UUID(camera_id) if isinstance(camera_id, str) else camera_id

                # First sighting at this camera
                first_stmt = (
                    select(VehicleSighting)
                    .where(
                        VehicleSighting.plate_text == normalised,
                        VehicleSighting.camera_id == camera_uuid,
                    )
                    .order_by(VehicleSighting.timestamp.asc())
                    .limit(1)
                )
                first_result = await session.execute(first_stmt)
                first_sighting = first_result.scalar_one_or_none()

                # Last sighting at this camera
                last_stmt = (
                    select(VehicleSighting)
                    .where(
                        VehicleSighting.plate_text == normalised,
                        VehicleSighting.camera_id == camera_uuid,
                    )
                    .order_by(VehicleSighting.timestamp.desc())
                    .limit(1)
                )
                last_result = await session.execute(last_stmt)
                last_sighting = last_result.scalar_one_or_none()

                if not first_sighting or not last_sighting:
                    return {
                        "plate_text": normalised,
                        "camera_id": camera_id,
                        "dwell_seconds": 0,
                        "flagged": False,
                        "reason": "no sightings found at this camera",
                    }

                first_ts = first_sighting.timestamp
                last_ts = last_sighting.timestamp
                dwell_seconds = int((last_ts - first_ts).total_seconds())

                # Determine if vehicle is still present (last seen within
                # the last 10 minutes is considered "still here").
                still_present = (now - last_ts).total_seconds() < 600

                # Flag logic: exceed threshold, and — if within business
                # hours — apply a more generous threshold (no flag during
                # business hours unless truly excessive).
                current_hour = now.hour
                is_business_hours = BUSINESS_HOUR_START <= current_hour < BUSINESS_HOUR_END
                effective_threshold = dwell_threshold_seconds
                if is_business_hours:
                    # During business hours, do not flag unless dwell is
                    # double the after-hours threshold (i.e., 16 h equiv).
                    effective_threshold = dwell_threshold_seconds * 2

                flagged = dwell_seconds >= effective_threshold

                # Look for existing trip record
                trip_stmt = (
                    select(VehicleTrip)
                    .where(
                        VehicleTrip.plate_text == normalised,
                        VehicleTrip.entry_camera_id == camera_uuid,
                        VehicleTrip.exit_time.is_(None),
                    )
                    .order_by(VehicleTrip.entry_time.desc())
                    .limit(1)
                )
                trip_result = await session.execute(trip_stmt)
                active_trip = trip_result.scalar_one_or_none()

                # Update trip dwell if one exists
                if active_trip:
                    active_trip.total_dwell_seconds = dwell_seconds
                    await session.commit()

                result = {
                    "plate_text": normalised,
                    "camera_id": camera_id,
                    "first_seen": first_ts.isoformat(),
                    "last_seen": last_ts.isoformat(),
                    "dwell_seconds": dwell_seconds,
                    "dwell_formatted": str(timedelta(seconds=dwell_seconds)),
                    "still_present": still_present,
                    "flagged": flagged,
                    "threshold_seconds": effective_threshold,
                    "is_business_hours": is_business_hours,
                    "trip_id": str(active_trip.id) if active_trip else None,
                }

                if flagged:
                    logger.warning(
                        "lpr.dwell_flag plate=%s camera=%s dwell=%ds threshold=%ds",
                        normalised,
                        camera_id,
                        dwell_seconds,
                        effective_threshold,
                    )
                else:
                    logger.info(
                        "lpr.track_dwell plate=%s camera=%s dwell=%ds",
                        normalised,
                        camera_id,
                        dwell_seconds,
                    )

                return result

            except Exception as exc:
                logger.error(
                    "lpr.track_dwell_time error plate=%s camera=%s: %s",
                    plate_text,
                    camera_id,
                    exc,
                )
                return {
                    "plate_text": normalised,
                    "camera_id": camera_id,
                    "dwell_seconds": 0,
                    "flagged": False,
                    "error": str(exc),
                }


# ── Singleton ────────────────────────────────────────────────────

lpr_engine = LPREngine()
