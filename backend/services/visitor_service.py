"""Visitor Management Service — pre-registration, check-in/out, watchlist screening, QR badges."""

import uuid
import io
import os
import base64
import json
import logging
from datetime import datetime
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.phase2b_models import Visitor, VisitorStatus, VisitorWatchlistEntry

logger = logging.getLogger(__name__)


def _generate_qr_base64(data: dict) -> str:
    try:
        import qrcode
        qr = qrcode.QRCode(version=1, box_size=10, border=4)
        qr.add_data(json.dumps(data, default=str))
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()
    except ImportError:
        return base64.b64encode(json.dumps(data, default=str).encode()).decode()


class VisitorService:

    async def pre_register(self, db: AsyncSession, data: dict) -> dict:
        today = datetime.utcnow().strftime("%Y%m%d")
        count_r = await db.execute(select(func.count(Visitor.id)))
        seq = (count_r.scalar() or 0) + 1
        badge_number = f"V-{today}-{seq:04d}"
        visitor_id = uuid.uuid4()
        qr_data = _generate_qr_base64({
            "visitor_id": str(visitor_id),
            "badge": badge_number,
            "name": f"{data['first_name']} {data['last_name']}",
        })
        visitor = Visitor(
            id=visitor_id,
            first_name=data["first_name"],
            last_name=data["last_name"],
            email=data.get("email"),
            phone=data.get("phone"),
            company=data.get("company"),
            visitor_type=data.get("visitor_type", "visitor"),
            host_user_id=data.get("host_user_id"),
            host_name=data.get("host_name"),
            purpose=data.get("purpose"),
            badge_number=badge_number,
            badge_qr_data=qr_data,
            allowed_zones=data.get("allowed_zones", []),
            expected_check_out=data.get("expected_check_out"),
            escort_required=data.get("escort_required", False),
            nda_signed=data.get("nda_signed", False),
        )
        db.add(visitor)
        await db.commit()
        await db.refresh(visitor)
        return self._to_dict(visitor)

    async def check_in(self, db: AsyncSession, visitor_id: str, photo_base64: str = None) -> dict:
        result = await db.execute(select(Visitor).where(Visitor.id == visitor_id))
        visitor = result.scalar_one_or_none()
        if not visitor:
            raise ValueError("Visitor not found")
        # Screen watchlist
        matches = await self.screen_watchlist(db, visitor.first_name, visitor.last_name, visitor.email)
        if matches:
            visitor.watchlist_match = True
            visitor.watchlist_notes = f"Matched {len(matches)} watchlist entries"
        # Save photo
        if photo_base64:
            photo_dir = os.path.join("evidence", "visitor_photos")
            os.makedirs(photo_dir, exist_ok=True)
            photo_path = os.path.join(photo_dir, f"{visitor_id}.jpg")
            with open(photo_path, "wb") as f:
                f.write(base64.b64decode(photo_base64))
            visitor.photo_path = photo_path
        visitor.status = VisitorStatus.checked_in
        visitor.check_in_time = datetime.utcnow()
        visitor.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(visitor)
        d = self._to_dict(visitor)
        d["watchlist_matches"] = matches
        return d

    async def check_out(self, db: AsyncSession, visitor_id: str) -> dict:
        result = await db.execute(select(Visitor).where(Visitor.id == visitor_id))
        visitor = result.scalar_one_or_none()
        if not visitor:
            raise ValueError("Visitor not found")
        visitor.status = VisitorStatus.checked_out
        visitor.check_out_time = datetime.utcnow()
        visitor.updated_at = datetime.utcnow()
        await db.commit()
        await db.refresh(visitor)
        return self._to_dict(visitor)

    async def get_visitors(self, db: AsyncSession, status: str = None, date: str = None, search: str = None, limit: int = 50, offset: int = 0) -> dict:
        q = select(Visitor)
        if status:
            q = q.where(Visitor.status == status)
        if date:
            q = q.where(func.date(Visitor.created_at) == date)
        if search:
            pattern = f"%{search}%"
            q = q.where(or_(Visitor.first_name.ilike(pattern), Visitor.last_name.ilike(pattern), Visitor.company.ilike(pattern), Visitor.email.ilike(pattern)))
        count_q = select(func.count()).select_from(q.subquery())
        total = (await db.execute(count_q)).scalar() or 0
        q = q.order_by(Visitor.created_at.desc()).limit(limit).offset(offset)
        result = await db.execute(q)
        return {"total": total, "items": [self._to_dict(v) for v in result.scalars().all()]}

    async def get_visitor(self, db: AsyncSession, visitor_id: str) -> dict | None:
        result = await db.execute(select(Visitor).where(Visitor.id == visitor_id))
        v = result.scalar_one_or_none()
        return self._to_dict(v) if v else None

    async def screen_watchlist(self, db: AsyncSession, first_name: str, last_name: str, email: str = None) -> list:
        q = select(VisitorWatchlistEntry).where(VisitorWatchlistEntry.active == True)
        conditions = []
        conditions.append(and_(
            VisitorWatchlistEntry.first_name.ilike(f"%{first_name}%"),
            VisitorWatchlistEntry.last_name.ilike(f"%{last_name}%"),
        ))
        if email:
            conditions.append(VisitorWatchlistEntry.email.ilike(f"%{email}%"))
        q = q.where(or_(*conditions))
        result = await db.execute(q)
        return [self._watchlist_to_dict(e) for e in result.scalars().all()]

    async def add_to_watchlist(self, db: AsyncSession, data: dict) -> dict:
        entry = VisitorWatchlistEntry(
            first_name=data.get("first_name"),
            last_name=data.get("last_name"),
            email=data.get("email"),
            phone=data.get("phone"),
            reason=data["reason"],
            severity=data.get("severity", "high"),
            added_by=data.get("added_by"),
            notes=data.get("notes"),
            expires_at=data.get("expires_at"),
        )
        db.add(entry)
        await db.commit()
        await db.refresh(entry)
        return self._watchlist_to_dict(entry)

    async def remove_from_watchlist(self, db: AsyncSession, entry_id: str) -> bool:
        result = await db.execute(select(VisitorWatchlistEntry).where(VisitorWatchlistEntry.id == entry_id))
        entry = result.scalar_one_or_none()
        if not entry:
            return False
        entry.active = False
        await db.commit()
        return True

    async def get_watchlist(self, db: AsyncSession, active_only: bool = True) -> list:
        q = select(VisitorWatchlistEntry)
        if active_only:
            q = q.where(VisitorWatchlistEntry.active == True)
        q = q.order_by(VisitorWatchlistEntry.created_at.desc())
        result = await db.execute(q)
        return [self._watchlist_to_dict(e) for e in result.scalars().all()]

    async def log_zone_access(self, db: AsyncSession, visitor_id: str, zone_id: str, direction: str) -> dict:
        result = await db.execute(select(Visitor).where(Visitor.id == visitor_id))
        visitor = result.scalar_one_or_none()
        if not visitor:
            raise ValueError("Visitor not found")
        allowed = visitor.allowed_zones or []
        is_allowed = not allowed or zone_id in [str(z) for z in allowed]
        log = list(visitor.access_log or [])
        log.append({"zone_id": zone_id, "direction": direction, "time": datetime.utcnow().isoformat(), "allowed": is_allowed})
        visitor.access_log = log
        visitor.updated_at = datetime.utcnow()
        await db.commit()
        return {"logged": True, "allowed": is_allowed}

    async def check_overstays(self, db: AsyncSession) -> list:
        now = datetime.utcnow()
        result = await db.execute(
            select(Visitor).where(and_(
                Visitor.status == VisitorStatus.checked_in,
                Visitor.expected_check_out < now,
                Visitor.expected_check_out.isnot(None),
            ))
        )
        overstays = []
        for v in result.scalars().all():
            v.status = VisitorStatus.overstay
            v.updated_at = now
            overstays.append(self._to_dict(v))
        if overstays:
            await db.commit()
        return overstays

    async def get_visitor_stats(self, db: AsyncSession) -> dict:
        checked_in = (await db.execute(
            select(func.count(Visitor.id)).where(Visitor.status == VisitorStatus.checked_in)
        )).scalar() or 0
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        today_total = (await db.execute(
            select(func.count(Visitor.id)).where(Visitor.created_at >= today)
        )).scalar() or 0
        overstays = (await db.execute(
            select(func.count(Visitor.id)).where(Visitor.status == VisitorStatus.overstay)
        )).scalar() or 0
        watchlist_today = (await db.execute(
            select(func.count(Visitor.id)).where(and_(Visitor.watchlist_match == True, Visitor.created_at >= today))
        )).scalar() or 0
        return {"checked_in": checked_in, "today_total": today_total, "overstays": overstays, "watchlist_matches_today": watchlist_today}

    def _to_dict(self, v: Visitor) -> dict:
        return {
            "id": str(v.id), "first_name": v.first_name, "last_name": v.last_name,
            "email": v.email, "phone": v.phone, "company": v.company,
            "visitor_type": v.visitor_type, "photo_path": v.photo_path,
            "host_name": v.host_name, "purpose": v.purpose,
            "status": v.status.value if v.status else None,
            "badge_number": v.badge_number, "badge_qr_data": v.badge_qr_data,
            "allowed_zones": v.allowed_zones or [],
            "check_in_time": v.check_in_time.isoformat() if v.check_in_time else None,
            "expected_check_out": v.expected_check_out.isoformat() if v.expected_check_out else None,
            "check_out_time": v.check_out_time.isoformat() if v.check_out_time else None,
            "watchlist_match": v.watchlist_match, "watchlist_notes": v.watchlist_notes,
            "access_log": v.access_log or [], "escort_required": v.escort_required,
            "nda_signed": v.nda_signed,
            "created_at": v.created_at.isoformat() if v.created_at else None,
        }

    def _watchlist_to_dict(self, e: VisitorWatchlistEntry) -> dict:
        return {
            "id": str(e.id), "first_name": e.first_name, "last_name": e.last_name,
            "email": e.email, "phone": e.phone, "reason": e.reason,
            "severity": e.severity, "active": e.active, "notes": e.notes,
            "created_at": e.created_at.isoformat() if e.created_at else None,
            "expires_at": e.expires_at.isoformat() if e.expires_at else None,
        }


visitor_service = VisitorService()
