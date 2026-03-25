"""Agentic Video Wall Service — living, adaptive video wall that auto-ranks
cameras by activity, detects attention gaps, and computes smart grid layouts.

Phase 3C: Agentic Security Operations.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select, func, and_, or_, case as sa_case
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.models import Camera, Event, Alert, AlertStatus, AlertSeverity
from backend.models.phase3_models import OperatorAttentionLog

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Scoring weights
# ---------------------------------------------------------------------------

_WEIGHT_ALERT = 3.0
_WEIGHT_DETECTION = 1.0
_WEIGHT_ACTIVE_TRACK = 0.5
_HIGH_SEVERITIES = {"critical", "high"}


class AgenticVideoWallService:
    """Provides real-time, activity-aware video wall layout decisions."""

    def __init__(self):
        self._camera_activity_scores: dict[str, float] = {}
        self._operator_viewing: dict[str, dict] = {}  # operator_id -> {camera_id, since}
        self._attention_alerts: list[dict] = []

    # ── Activity scoring ──────────────────────────────────────

    async def _score_cameras(self, db: AsyncSession, window_seconds: int = 60) -> dict[str, dict]:
        """Compute activity scores for every camera based on recent
        events and alerts within the given time window."""
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)

        # Count recent events per camera
        ev_q = (
            select(
                Event.camera_id,
                func.count(Event.id).label("event_count"),
            )
            .where(Event.timestamp >= cutoff)
            .group_by(Event.camera_id)
        )
        ev_result = await db.execute(ev_q)
        event_counts: dict[str, int] = {
            str(row.camera_id): row.event_count
            for row in ev_result.all()
        }

        # Count recent alerts per camera (by source_camera name — resolve to camera id)
        alert_q = (
            select(
                Alert.source_camera,
                func.count(Alert.id).label("alert_count"),
                func.sum(
                    sa_case(
                        (Alert.severity.in_([AlertSeverity.CRITICAL, AlertSeverity.HIGH]), 1),
                        else_=0,
                    )
                ).label("high_alert_count"),
            )
            .where(Alert.created_at >= cutoff)
            .group_by(Alert.source_camera)
        )
        alert_result = await db.execute(alert_q)
        alert_data: dict[str, dict] = {}
        for row in alert_result.all():
            if row.source_camera:
                alert_data[row.source_camera] = {
                    "alert_count": row.alert_count or 0,
                    "high_alert_count": row.high_alert_count or 0,
                }

        # Build camera-id-indexed lookup by name for alert mapping
        cam_q = select(Camera).where(Camera.is_active.is_(True))
        cam_result = await db.execute(cam_q)
        cameras = cam_result.scalars().all()

        scores: dict[str, dict] = {}
        for cam in cameras:
            cid = str(cam.id)
            det_count = event_counts.get(cid, 0)
            cam_alerts = alert_data.get(cam.name, {})
            a_count = cam_alerts.get("alert_count", 0)
            h_count = cam_alerts.get("high_alert_count", 0)

            # Composite score
            score = (
                a_count * _WEIGHT_ALERT
                + det_count * _WEIGHT_DETECTION
                + min(det_count, 10) * _WEIGHT_ACTIVE_TRACK
            )
            has_threat = h_count > 0

            scores[cid] = {
                "camera_id": cid,
                "camera_name": cam.name,
                "location": cam.location,
                "zone_id": str(cam.zone_id) if cam.zone_id else None,
                "activity_score": round(score, 2),
                "alert_count": a_count,
                "high_alert_count": h_count,
                "detection_count": det_count,
                "has_threat": has_threat,
            }
            self._camera_activity_scores[cid] = round(score, 2)

        return scores

    # ── Activity ranked layout ────────────────────────────────

    async def get_activity_ranked_layout(
        self,
        db: AsyncSession,
        grid_cols: int = 4,
        grid_rows: int = 3,
    ) -> dict:
        """Return a video wall grid layout with cameras ranked by current
        activity level.  Higher-activity cameras get larger tiles."""
        scores = await self._score_cameras(db)
        ranked = sorted(scores.values(), key=lambda x: x["activity_score"], reverse=True)

        total_cells = grid_cols * grid_rows
        cells: list[dict] = []

        for idx, cam_info in enumerate(ranked):
            if idx >= total_cells:
                break

            row = idx // grid_cols
            col = idx % grid_cols

            # First camera gets 2x2 if it has a threat and grid allows it
            if idx == 0 and cam_info["has_threat"] and grid_cols >= 2 and grid_rows >= 2:
                size = "2x2"
            elif idx < 4 and cam_info["activity_score"] > 5.0:
                size = "1x2" if col < grid_cols - 1 else "1x1"
            else:
                size = "1x1"

            cells.append({
                "camera_id": cam_info["camera_id"],
                "camera_name": cam_info["camera_name"],
                "position": {"row": row, "col": col},
                "size": size,
                "activity_score": cam_info["activity_score"],
                "active_alerts": cam_info["alert_count"],
                "has_threat": cam_info["has_threat"],
                "detection_count": cam_info["detection_count"],
            })

        logger.info("activity_ranked_layout", total_cameras=len(ranked),
                     cells_assigned=len(cells), grid=f"{grid_cols}x{grid_rows}")

        return {
            "grid_cols": grid_cols,
            "grid_rows": grid_rows,
            "total_cameras": len(ranked),
            "cells": cells,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    # ── Auto-focus cameras ────────────────────────────────────

    async def get_auto_focus_cameras(self, db: AsyncSession) -> list[dict]:
        """Get cameras that should be auto-focused due to active threats.
        Queries alerts with status NEW and severity >= HIGH from the
        last 5 minutes."""
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)

        q = (
            select(Alert)
            .where(
                and_(
                    Alert.status == AlertStatus.NEW,
                    Alert.severity.in_([AlertSeverity.CRITICAL, AlertSeverity.HIGH]),
                    Alert.created_at >= cutoff,
                )
            )
            .order_by(Alert.created_at.desc())
            .limit(20)
        )
        result = await db.execute(q)
        alerts = result.scalars().all()

        focus_cameras: list[dict] = []
        seen_cameras: set[str] = set()

        for alert in alerts:
            cam_name = alert.source_camera
            if not cam_name or cam_name in seen_cameras:
                continue
            seen_cameras.add(cam_name)

            # Resolve camera name to camera_id
            cam_res = await db.execute(
                select(Camera).where(Camera.name == cam_name).limit(1)
            )
            cam = cam_res.scalar_one_or_none()

            focus_cameras.append({
                "camera_id": str(cam.id) if cam else None,
                "camera_name": cam_name,
                "alert_id": str(alert.id),
                "severity": alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity),
                "threat_type": alert.threat_type,
                "since": alert.created_at.isoformat() if alert.created_at else None,
            })

        return focus_cameras

    # ── Smart grid layout ─────────────────────────────────────

    async def compute_smart_grid(
        self,
        db: AsyncSession,
        active_incidents: list[dict],
    ) -> dict:
        """Compute an intelligent grid layout based on the number of
        active incidents.

        0 incidents  -> standard even grid
        1 incident   -> primary focus + thumbnails
        2-4          -> split view with priority ranking
        5+           -> priority ranking with scroll
        """
        incident_count = len(active_incidents)
        scores = await self._score_cameras(db)
        ranked = sorted(scores.values(), key=lambda x: x["activity_score"], reverse=True)

        if incident_count == 0:
            layout_mode = "standard_grid"
            primary_camera = None
            secondary_cameras = [c["camera_id"] for c in ranked[:12]]
            cells = [
                {
                    "camera_id": c["camera_id"],
                    "camera_name": c["camera_name"],
                    "size": "1x1",
                    "activity_score": c["activity_score"],
                }
                for c in ranked[:12]
            ]

        elif incident_count == 1:
            layout_mode = "focused_primary"
            # Find camera associated with the incident
            inc = active_incidents[0]
            inc_cam_ids = inc.get("camera_ids", [])
            primary_camera = inc_cam_ids[0] if inc_cam_ids else (ranked[0]["camera_id"] if ranked else None)
            secondary_cameras = [
                c["camera_id"] for c in ranked
                if c["camera_id"] != primary_camera
            ][:8]

            cells = []
            if primary_camera:
                primary_info = scores.get(primary_camera, {})
                cells.append({
                    "camera_id": primary_camera,
                    "camera_name": primary_info.get("camera_name", ""),
                    "size": "2x2",
                    "activity_score": primary_info.get("activity_score", 0),
                    "is_primary": True,
                })
            for cid in secondary_cameras:
                info = scores.get(cid, {})
                cells.append({
                    "camera_id": cid,
                    "camera_name": info.get("camera_name", ""),
                    "size": "1x1",
                    "activity_score": info.get("activity_score", 0),
                    "is_primary": False,
                })

        elif incident_count <= 4:
            layout_mode = "split_view"
            primary_camera = None
            # Give each incident a primary camera
            incident_cameras = []
            for inc in active_incidents:
                inc_cam_ids = inc.get("camera_ids", [])
                if inc_cam_ids:
                    incident_cameras.append(inc_cam_ids[0])
            secondary_cameras = [
                c["camera_id"] for c in ranked
                if c["camera_id"] not in incident_cameras
            ][:6]

            cells = []
            for ic in incident_cameras:
                info = scores.get(ic, {})
                cells.append({
                    "camera_id": ic,
                    "camera_name": info.get("camera_name", ""),
                    "size": "2x1",
                    "activity_score": info.get("activity_score", 0),
                    "is_incident_camera": True,
                })
            for cid in secondary_cameras:
                info = scores.get(cid, {})
                cells.append({
                    "camera_id": cid,
                    "camera_name": info.get("camera_name", ""),
                    "size": "1x1",
                    "activity_score": info.get("activity_score", 0),
                    "is_incident_camera": False,
                })

        else:
            layout_mode = "priority_scroll"
            primary_camera = ranked[0]["camera_id"] if ranked else None
            secondary_cameras = [c["camera_id"] for c in ranked[1:]]
            cells = [
                {
                    "camera_id": c["camera_id"],
                    "camera_name": c["camera_name"],
                    "size": "1x1",
                    "activity_score": c["activity_score"],
                    "rank": idx,
                }
                for idx, c in enumerate(ranked)
            ]

        logger.info("smart_grid_computed", layout_mode=layout_mode,
                     incidents=incident_count, cells=len(cells))

        return {
            "layout_mode": layout_mode,
            "incident_count": incident_count,
            "cells": cells,
            "primary_camera": primary_camera,
            "secondary_cameras": secondary_cameras,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    # ── Operator attention tracking ───────────────────────────

    async def record_operator_view(
        self,
        db: AsyncSession,
        operator_id: str,
        camera_id: str,
    ):
        """Track which camera an operator is viewing.  Computes duration
        since their last recorded view and persists an OperatorAttentionLog."""
        now = datetime.now(timezone.utc)

        # Calculate duration if operator was previously viewing another camera
        previous = self._operator_viewing.get(operator_id)
        duration = 0.0
        if previous and previous.get("since"):
            try:
                prev_since = datetime.fromisoformat(previous["since"])
                duration = (now - prev_since).total_seconds()
            except (ValueError, TypeError):
                pass

            # Persist the previous viewing duration
            if previous.get("camera_id") and duration > 0:
                prev_log = OperatorAttentionLog(
                    operator_id=operator_id,
                    camera_id=previous["camera_id"],
                    viewed_at=prev_since,
                    duration_seconds=round(duration, 1),
                    interaction_type="view",
                )
                db.add(prev_log)

        # Update in-memory state
        self._operator_viewing[operator_id] = {
            "camera_id": camera_id,
            "since": now.isoformat(),
        }

        # Log the new view start
        log_entry = OperatorAttentionLog(
            operator_id=operator_id,
            camera_id=camera_id,
            viewed_at=now,
            duration_seconds=0.0,
            interaction_type="view",
        )
        db.add(log_entry)
        await db.commit()

        logger.debug("operator_view_recorded", operator=operator_id,
                      camera=camera_id)

    # ── Attention gap detection ───────────────────────────────

    async def check_attention_gaps(
        self,
        db: AsyncSession,
        max_unviewed_minutes: int = 10,
    ) -> list[dict]:
        """Find high-priority cameras that haven't been viewed by any
        operator recently.  Cross-references activity scores with the
        most recent attention log per camera."""
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_unviewed_minutes)
        now = datetime.now(timezone.utc)

        # Get all active cameras
        cam_res = await db.execute(
            select(Camera).where(Camera.is_active.is_(True))
        )
        all_cameras = cam_res.scalars().all()

        # Get last viewed time per camera
        last_view_q = (
            select(
                OperatorAttentionLog.camera_id,
                func.max(OperatorAttentionLog.viewed_at).label("last_viewed"),
            )
            .group_by(OperatorAttentionLog.camera_id)
        )
        lv_res = await db.execute(last_view_q)
        last_views: dict[str, datetime] = {
            str(row.camera_id): row.last_viewed
            for row in lv_res.all()
            if row.last_viewed
        }

        # Cross-reference with activity scores
        gaps: list[dict] = []
        for cam in all_cameras:
            cid = str(cam.id)
            last_viewed = last_views.get(cid)
            activity_score = self._camera_activity_scores.get(cid, 0)

            if last_viewed and last_viewed >= cutoff:
                continue  # Recently viewed — no gap

            minutes_unviewed = 0.0
            if last_viewed:
                minutes_unviewed = (now - last_viewed).total_seconds() / 60.0
            else:
                minutes_unviewed = float(max_unviewed_minutes) + 1  # Never viewed

            # Only flag cameras with meaningful activity
            if activity_score < 0.5 and minutes_unviewed < max_unviewed_minutes * 2:
                continue

            recommendation = "routine_check"
            if activity_score >= 10.0:
                recommendation = "immediate_attention_required"
            elif activity_score >= 5.0:
                recommendation = "priority_review"
            elif activity_score >= 1.0:
                recommendation = "check_when_available"

            gaps.append({
                "camera_id": cid,
                "camera_name": cam.name,
                "location": cam.location,
                "last_viewed_at": last_viewed.isoformat() if last_viewed else None,
                "minutes_unviewed": round(minutes_unviewed, 1),
                "activity_score": activity_score,
                "recommendation": recommendation,
            })

        # Sort by activity score descending (most urgent first)
        gaps.sort(key=lambda x: x["activity_score"], reverse=True)

        if gaps:
            logger.info("attention_gaps_detected", gap_count=len(gaps),
                         highest_score=gaps[0]["activity_score"] if gaps else 0)
        self._attention_alerts = gaps

        return gaps

    # ── Camera heat scores ────────────────────────────────────

    async def get_camera_heat_scores(self, db: AsyncSession) -> dict:
        """Score all cameras by current activity level for heat-map display."""
        scores = await self._score_cameras(db)

        # Compute ranks
        ranked_ids = sorted(scores.keys(), key=lambda k: scores[k]["activity_score"], reverse=True)

        result: dict[str, dict] = {}
        for rank, cid in enumerate(ranked_ids, start=1):
            info = scores[cid]
            needs_attention = (
                info["has_threat"]
                or info["activity_score"] >= 5.0
            )
            result[cid] = {
                "score": info["activity_score"],
                "alert_count": info["alert_count"],
                "detection_count": info["detection_count"],
                "rank": rank,
                "needs_attention": needs_attention,
                "camera_name": info["camera_name"],
                "location": info.get("location"),
            }

        return result


agentic_video_wall_service = AgenticVideoWallService()
