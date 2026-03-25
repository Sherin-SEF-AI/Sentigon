"""Enhanced LPR Service — plate search, vehicle profiles, parking management, gate control, BOLO."""

import logging
from datetime import datetime, timedelta
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


class LPREnhancedService:

    async def search_plates(self, db: AsyncSession, query: dict) -> dict:
        try:
            from backend.models.advanced_models import VehicleSighting
        except ImportError:
            return {"results": [], "total": 0}
        q = select(VehicleSighting)
        if query.get("plate_text"):
            q = q.where(VehicleSighting.plate_text.ilike(f"%{query['plate_text']}%"))
        if query.get("time_from"):
            q = q.where(VehicleSighting.timestamp >= query["time_from"])
        if query.get("time_to"):
            q = q.where(VehicleSighting.timestamp <= query["time_to"])
        if query.get("camera_id"):
            q = q.where(VehicleSighting.camera_id == query["camera_id"])
        if query.get("direction"):
            q = q.where(VehicleSighting.vehicle_direction.ilike(f"%{query['direction']}%"))
        count_q = select(func.count()).select_from(q.subquery())
        total = (await db.execute(count_q)).scalar() or 0
        q = q.order_by(VehicleSighting.timestamp.desc()).limit(query.get("limit", 50))
        result = await db.execute(q)
        items = [{
            "id": str(s.id), "plate_text": s.plate_text,
            "plate_confidence": s.plate_confidence,
            "vehicle_color": s.vehicle_color, "vehicle_type": s.vehicle_type,
            "vehicle_direction": s.vehicle_direction,
            "camera_id": str(s.camera_id) if s.camera_id else None,
            "timestamp": s.timestamp.isoformat() if s.timestamp else None,
            "frame_path": s.frame_path,
        } for s in result.scalars().all()]
        return {"results": items, "total": total}

    async def get_vehicle_full_profile(self, db: AsyncSession, plate_text: str) -> dict:
        try:
            from backend.models.advanced_models import VehicleSighting, VehicleWatchlist, VehicleTrip
        except ImportError:
            return {"plate_text": plate_text, "sightings": [], "trips": []}
        # Sightings
        sightings_r = await db.execute(
            select(VehicleSighting).where(VehicleSighting.plate_text.ilike(f"%{plate_text}%"))
            .order_by(VehicleSighting.timestamp.desc()).limit(100)
        )
        sightings = [{"timestamp": s.timestamp.isoformat() if s.timestamp else None,
                       "camera_id": str(s.camera_id) if s.camera_id else None,
                       "vehicle_color": s.vehicle_color, "vehicle_type": s.vehicle_type,
                       "direction": s.vehicle_direction}
                      for s in sightings_r.scalars().all()]
        # Watchlist check
        wl_r = await db.execute(select(VehicleWatchlist).where(
            VehicleWatchlist.plate_text.ilike(f"%{plate_text}%")
        ))
        watchlist = [{"reason": w.reason, "severity": w.severity, "active": w.active}
                      for w in wl_r.scalars().all()]
        # Trips
        trips_r = await db.execute(
            select(VehicleTrip).where(VehicleTrip.plate_text.ilike(f"%{plate_text}%"))
            .order_by(VehicleTrip.entry_time.desc()).limit(50)
        )
        trips = [{"entry_time": t.entry_time.isoformat() if t.entry_time else None,
                   "exit_time": t.exit_time.isoformat() if t.exit_time else None,
                   "dwell_seconds": t.total_dwell_seconds}
                  for t in trips_r.scalars().all()]
        return {
            "plate_text": plate_text,
            "total_sightings": len(sightings),
            "sightings": sightings,
            "watchlist_entries": watchlist,
            "on_watchlist": bool(watchlist),
            "trips": trips,
        }

    async def manage_parking(self, db: AsyncSession, zone_id: str) -> dict:
        try:
            from backend.models.advanced_models import ParkingZoneConfig, VehicleSighting
        except ImportError:
            return {"zone_id": zone_id, "config": None}
        config_r = await db.execute(select(ParkingZoneConfig).where(ParkingZoneConfig.zone_id == zone_id))
        config = config_r.scalar_one_or_none()
        if not config:
            return {"zone_id": zone_id, "config": None, "occupied": 0, "available": 0}
        return {
            "zone_id": zone_id,
            "total_spots": config.total_spots,
            "occupied_spots": config.occupied_spots or 0,
            "available_spots": (config.total_spots or 0) - (config.occupied_spots or 0),
            "max_dwell_minutes": config.max_dwell_minutes,
            "zone_type": config.zone_type,
        }

    async def trigger_gate_action(self, db: AsyncSession, gate_id: str, plate_text: str, action: str) -> dict:
        # Check watchlist
        try:
            from backend.models.advanced_models import VehicleWatchlist
            wl_r = await db.execute(
                select(VehicleWatchlist).where(and_(
                    VehicleWatchlist.plate_text.ilike(f"%{plate_text}%"),
                    VehicleWatchlist.active == True
                ))
            )
            on_watchlist = wl_r.scalars().first()
            if on_watchlist and action == "open":
                return {"gate_id": gate_id, "action": "denied", "reason": f"Vehicle on watchlist: {on_watchlist.reason}"}
        except ImportError:
            pass
        # Send to PACS for gate control
        try:
            from backend.services.pacs_service import pacs_service
            if action == "open":
                await pacs_service.unlock_door(gate_id)
            elif action == "close":
                await pacs_service.lock_door(gate_id)
        except Exception as e:
            logger.warning("Gate control via PACS failed: %s", e)
        return {"gate_id": gate_id, "plate_text": plate_text, "action": action, "status": "executed"}

    async def create_bolo_alert(self, db: AsyncSession, data: dict) -> dict:
        try:
            from backend.models.phase2_models import BOLOEntry
        except ImportError:
            return {"error": "BOLO model not available"}
        bolo = BOLOEntry(
            bolo_type="vehicle",
            description=data.get("description", {}),
            plate_text=data.get("plate_text"),
            severity=data.get("severity", "high"),
            reason=data.get("reason", ""),
            active=True,
            image_path=data.get("image_path"),
            created_by=data.get("created_by"),
        )
        db.add(bolo)
        await db.commit()
        await db.refresh(bolo)
        return {"id": str(bolo.id), "plate_text": bolo.plate_text, "status": "active"}

    async def check_plate_against_bolo(self, db: AsyncSession, plate_text: str) -> list:
        try:
            from backend.models.phase2_models import BOLOEntry
        except ImportError:
            return []
        result = await db.execute(
            select(BOLOEntry).where(and_(
                BOLOEntry.active == True,
                BOLOEntry.bolo_type == "vehicle",
                BOLOEntry.plate_text.ilike(f"%{plate_text}%"),
            ))
        )
        return [{"id": str(b.id), "plate_text": b.plate_text, "severity": b.severity,
                 "reason": b.reason} for b in result.scalars().all()]

    async def get_entry_exit_log(self, db: AsyncSession, plate_text: str = None,
                                  time_from=None, time_to=None) -> list:
        try:
            from backend.models.advanced_models import VehicleTrip
        except ImportError:
            return []
        q = select(VehicleTrip)
        if plate_text:
            q = q.where(VehicleTrip.plate_text.ilike(f"%{plate_text}%"))
        if time_from:
            q = q.where(VehicleTrip.entry_time >= time_from)
        if time_to:
            q = q.where(VehicleTrip.entry_time <= time_to)
        q = q.order_by(VehicleTrip.entry_time.desc()).limit(100)
        result = await db.execute(q)
        return [{"plate_text": t.plate_text,
                 "entry_time": t.entry_time.isoformat() if t.entry_time else None,
                 "exit_time": t.exit_time.isoformat() if t.exit_time else None,
                 "dwell_seconds": t.total_dwell_seconds}
                for t in result.scalars().all()]

    async def get_parking_analytics(self, db: AsyncSession, zone_id: str = None) -> dict:
        try:
            from backend.models.advanced_models import ParkingZoneConfig
        except ImportError:
            return {"zones": []}
        q = select(ParkingZoneConfig)
        if zone_id:
            q = q.where(ParkingZoneConfig.zone_id == zone_id)
        result = await db.execute(q)
        zones = []
        for pz in result.scalars().all():
            total = pz.total_spots or 0
            occupied = pz.occupied_spots or 0
            zones.append({
                "zone_id": str(pz.zone_id),
                "zone_type": pz.zone_type,
                "total_spots": total,
                "occupied": occupied,
                "available": total - occupied,
                "utilization_pct": round((occupied / total * 100), 1) if total > 0 else 0,
                "max_dwell_minutes": pz.max_dwell_minutes,
            })
        return {"zones": zones}


lpr_enhanced_service = LPREnhancedService()
