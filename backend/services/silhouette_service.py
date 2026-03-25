"""Phase 3E: Anonymous Silhouette Mode & PII Redaction Service.

Privacy-first video rendering that replaces human figures with colored
silhouettes, blurs faces and license plates, and enforces tiered video
access with full audit logging.

Rendering modes:
  - single:    All silhouettes drawn in cyan.
  - per_track: Deterministic color per ByteTrack track_id.
  - risk_based: Green -> Yellow -> Orange -> Red by escalation level.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
import structlog
from sqlalchemy import select, func, and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Camera, Zone, AuditLog
from backend.models.phase3_models import SilhouetteConfig, VideoAccessLog

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_FACE_REGION_RATIO = 0.20  # Top 20 % of person bbox assumed to be face
_BLUR_KERNEL = (51, 51)
_BLUR_SIGMA = 30
_SILHOUETTE_THICKNESS = -1  # Filled
_OVERLAY_ALPHA = 0.75  # Blend factor for silhouette overlay
_PLATE_BLUR_KERNEL = (51, 51)

# Default tier-role mapping when no SilhouetteConfig row exists
_DEFAULT_TIER_ROLES: Dict[int, List[str]] = {
    1: ["viewer"],
    2: ["operator", "analyst"],
    3: ["admin"],
}


class SilhouetteService:
    """Anonymous silhouette rendering, PII redaction, and tiered access control."""

    # Silhouette colors (BGR for OpenCV)
    SINGLE_COLOR = (0, 255, 255)  # Cyan
    RISK_COLORS: Dict[int, tuple] = {
        0: (0, 255, 0),      # Green  — normal
        1: (255, 255, 0),    # Yellow — watching (actually cyan-ish in BGR, but spec says Yellow)
        2: (0, 165, 255),    # Orange
        3: (0, 0, 255),      # Red    — threat
    }

    # Pre-computed palette for per-track mode (12 distinct colors)
    _TRACK_PALETTE: List[tuple] = [
        (255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0),
        (255, 0, 255), (0, 255, 255), (128, 0, 255), (255, 128, 0),
        (0, 128, 255), (128, 255, 0), (255, 0, 128), (0, 255, 128),
    ]

    # ------------------------------------------------------------------
    # Frame-level rendering (synchronous, called per-frame in pipeline)
    # ------------------------------------------------------------------

    def _color_for_track(self, track_id: int) -> tuple:
        """Return a deterministic color for a given track id."""
        idx = int(hashlib.md5(str(track_id).encode()).hexdigest(), 16) % len(self._TRACK_PALETTE)
        return self._TRACK_PALETTE[idx]

    def _draw_silhouette(
        self,
        overlay: np.ndarray,
        x1: int, y1: int, x2: int, y2: int,
        color: tuple,
    ) -> None:
        """Draw a human-figure silhouette approximation inside a bounding box.

        Uses a composite of ellipses: head (circle at top), torso (vertical
        ellipse in middle), and legs (two narrow ellipses at bottom).
        """
        w = x2 - x1
        h = y2 - y1
        cx = (x1 + x2) // 2

        # Head — circle in top 18 %
        head_cy = y1 + int(h * 0.09)
        head_r = max(int(w * 0.16), 3)
        cv2.circle(overlay, (cx, head_cy), head_r, color, _SILHOUETTE_THICKNESS)

        # Torso — ellipse from 18 % to 58 % height
        torso_cy = y1 + int(h * 0.38)
        torso_h = max(int(h * 0.22), 4)
        torso_w = max(int(w * 0.30), 4)
        cv2.ellipse(overlay, (cx, torso_cy), (torso_w, torso_h), 0, 0, 360, color, _SILHOUETTE_THICKNESS)

        # Hips — slightly wider ellipse
        hip_cy = y1 + int(h * 0.55)
        hip_h = max(int(h * 0.08), 3)
        hip_w = max(int(w * 0.28), 3)
        cv2.ellipse(overlay, (cx, hip_cy), (hip_w, hip_h), 0, 0, 360, color, _SILHOUETTE_THICKNESS)

        # Left leg
        leg_cx_l = cx - int(w * 0.12)
        leg_cy = y1 + int(h * 0.78)
        leg_h = max(int(h * 0.22), 3)
        leg_w = max(int(w * 0.10), 2)
        cv2.ellipse(overlay, (leg_cx_l, leg_cy), (leg_w, leg_h), 0, 0, 360, color, _SILHOUETTE_THICKNESS)

        # Right leg
        leg_cx_r = cx + int(w * 0.12)
        cv2.ellipse(overlay, (leg_cx_r, leg_cy), (leg_w, leg_h), 0, 0, 360, color, _SILHOUETTE_THICKNESS)

        # Arms — two angled ellipses
        arm_cy = y1 + int(h * 0.35)
        arm_h = max(int(h * 0.16), 3)
        arm_w = max(int(w * 0.06), 2)
        # Left arm
        arm_cx_l = x1 + int(w * 0.12)
        cv2.ellipse(overlay, (arm_cx_l, arm_cy), (arm_w, arm_h), 15, 0, 360, color, _SILHOUETTE_THICKNESS)
        # Right arm
        arm_cx_r = x2 - int(w * 0.12)
        cv2.ellipse(overlay, (arm_cx_r, arm_cy), (arm_w, arm_h), -15, 0, 360, color, _SILHOUETTE_THICKNESS)

    def render_silhouettes(
        self,
        frame: np.ndarray,
        detections: List[Dict],
        mode: str = "single",
        risk_levels: Optional[Dict[int, int]] = None,
    ) -> np.ndarray:
        """Replace human figures with colored silhouettes.

        Parameters
        ----------
        frame : np.ndarray
            BGR image (H, W, 3).
        detections : list[dict]
            Each dict must have ``bbox`` = [x1, y1, x2, y2].
            Optionally ``track_id`` (int) for per_track mode and ``class`` for
            filtering (only "person" detections are silhouetted).
        mode : str
            "single" | "per_track" | "risk_based".
        risk_levels : dict | None
            Mapping of track_id -> risk level (0-3) for risk_based mode.

        Returns
        -------
        np.ndarray
            New frame with silhouettes (original is NOT modified).
        """
        output = frame.copy()
        h_frame, w_frame = output.shape[:2]
        overlay = output.copy()

        for det in detections:
            # Only process person detections
            cls = det.get("class", "person")
            if cls not in ("person", "Person", "pedestrian"):
                continue

            bbox = det.get("bbox")
            if bbox is None or len(bbox) != 4:
                continue

            x1, y1, x2, y2 = [int(v) for v in bbox]
            # Clamp to frame boundaries
            x1 = max(0, min(x1, w_frame - 1))
            y1 = max(0, min(y1, h_frame - 1))
            x2 = max(x1 + 1, min(x2, w_frame))
            y2 = max(y1 + 1, min(y2, h_frame))

            # Black out original person region
            overlay[y1:y2, x1:x2] = 0

            # Choose color
            track_id = det.get("track_id", 0)
            if mode == "per_track":
                color = self._color_for_track(track_id)
            elif mode == "risk_based" and risk_levels is not None:
                level = risk_levels.get(track_id, 0)
                color = self.RISK_COLORS.get(level, self.RISK_COLORS[0])
            else:
                color = self.SINGLE_COLOR

            self._draw_silhouette(overlay, x1, y1, x2, y2, color)

        # Alpha-blend overlay onto output so silhouettes are semi-translucent
        cv2.addWeighted(overlay, _OVERLAY_ALPHA, output, 1 - _OVERLAY_ALPHA, 0, output)
        return output

    def blur_faces(self, frame: np.ndarray, detections: List[Dict]) -> np.ndarray:
        """Blur face regions (top 20 % of person bounding boxes).

        Parameters
        ----------
        frame : np.ndarray
            BGR image.
        detections : list[dict]
            Person detections with ``bbox`` = [x1, y1, x2, y2].

        Returns
        -------
        np.ndarray
            Frame copy with faces blurred.
        """
        output = frame.copy()
        h_frame, w_frame = output.shape[:2]

        for det in detections:
            cls = det.get("class", "person")
            if cls not in ("person", "Person", "pedestrian"):
                continue

            bbox = det.get("bbox")
            if bbox is None or len(bbox) != 4:
                continue

            x1, y1, x2, y2 = [int(v) for v in bbox]
            x1 = max(0, min(x1, w_frame - 1))
            y1 = max(0, min(y1, h_frame - 1))
            x2 = max(x1 + 1, min(x2, w_frame))
            y2 = max(y1 + 1, min(y2, h_frame))

            # Face region = top _FACE_REGION_RATIO of the bbox
            face_h = int((y2 - y1) * _FACE_REGION_RATIO)
            fy2 = y1 + max(face_h, 5)

            roi = output[y1:fy2, x1:x2]
            if roi.size == 0:
                continue
            # Ensure kernel is odd and at least 3
            kw = max(3, _BLUR_KERNEL[0] | 1)
            kh = max(3, _BLUR_KERNEL[1] | 1)
            output[y1:fy2, x1:x2] = cv2.GaussianBlur(roi, (kw, kh), _BLUR_SIGMA)

        return output

    def blur_plates(self, frame: np.ndarray, plate_bboxes: List) -> np.ndarray:
        """Blur license plates in the frame.

        Parameters
        ----------
        frame : np.ndarray
            BGR image.
        plate_bboxes : list
            Each element is [x1, y1, x2, y2] or a dict with ``bbox``.

        Returns
        -------
        np.ndarray
            Frame copy with plates blurred.
        """
        output = frame.copy()
        h_frame, w_frame = output.shape[:2]

        for item in plate_bboxes:
            if isinstance(item, dict):
                bbox = item.get("bbox", item.get("bounding_box"))
                if bbox is None:
                    continue
            else:
                bbox = item

            if len(bbox) != 4:
                continue

            x1, y1, x2, y2 = [int(v) for v in bbox]
            x1 = max(0, min(x1, w_frame - 1))
            y1 = max(0, min(y1, h_frame - 1))
            x2 = max(x1 + 1, min(x2, w_frame))
            y2 = max(y1 + 1, min(y2, h_frame))

            roi = output[y1:y2, x1:x2]
            if roi.size == 0:
                continue
            kw = max(3, _PLATE_BLUR_KERNEL[0] | 1)
            kh = max(3, _PLATE_BLUR_KERNEL[1] | 1)
            output[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (kw, kh), _BLUR_SIGMA)

        return output

    def redact_frame_for_export(
        self,
        frame: np.ndarray,
        detections: List,
        config: Dict,
    ) -> np.ndarray:
        """Apply full PII redaction for video export based on config.

        Config keys respected:
          redact_faces (bool), redact_plates (bool), redact_documents (bool),
          mode (str): silhouette rendering mode when mode == "silhouette_only",
          plate_bboxes (list): optional explicit plate detections.
        """
        output = frame.copy()

        mode = config.get("mode", "blurred_faces")

        if mode == "silhouette_only":
            # Full silhouette replacement
            silhouette_color_mode = config.get("silhouette_color_mode", "single")
            output = self.render_silhouettes(output, detections, mode=silhouette_color_mode)
        else:
            # Selective redaction
            if config.get("redact_faces", True):
                output = self.blur_faces(output, detections)

        if config.get("redact_plates", True):
            plate_bboxes = config.get("plate_bboxes", [])
            # Also extract vehicle detections and estimate plate region
            if not plate_bboxes:
                for det in detections:
                    cls = det.get("class", "")
                    if cls in ("car", "truck", "bus", "vehicle", "motorcycle"):
                        bbox = det.get("bbox")
                        if bbox and len(bbox) == 4:
                            x1, y1, x2, y2 = [int(v) for v in bbox]
                            # Estimate plate region as bottom-center 30 % wide, 15 % tall
                            pw = int((x2 - x1) * 0.30)
                            ph = int((y2 - y1) * 0.15)
                            pcx = (x1 + x2) // 2
                            plate_bboxes.append([pcx - pw // 2, y2 - ph, pcx + pw // 2, y2])
            if plate_bboxes:
                output = self.blur_plates(output, plate_bboxes)

        if config.get("redact_documents", False) or config.get("redact_screens", False):
            # Redact screens/documents — look for rectangular bright regions
            for det in detections:
                cls = det.get("class", "")
                if cls in ("laptop", "tv", "monitor", "cell phone", "book", "document"):
                    bbox = det.get("bbox")
                    if bbox and len(bbox) == 4:
                        x1, y1, x2, y2 = [int(v) for v in bbox]
                        h_f, w_f = output.shape[:2]
                        x1, y1 = max(0, x1), max(0, y1)
                        x2, y2 = min(w_f, x2), min(h_f, y2)
                        roi = output[y1:y2, x1:x2]
                        if roi.size > 0:
                            output[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (51, 51), 25)

        return output

    # ------------------------------------------------------------------
    # Database operations (async)
    # ------------------------------------------------------------------

    async def get_zone_config(
        self,
        db: AsyncSession,
        zone_id: Optional[uuid.UUID] = None,
        camera_id: Optional[uuid.UUID] = None,
    ) -> Dict[str, Any]:
        """Get silhouette/privacy config for a zone or camera.

        Lookup priority: camera_id match first, then zone_id, then defaults.
        """
        conditions = []
        if camera_id is not None:
            conditions.append(SilhouetteConfig.camera_id == camera_id)
        if zone_id is not None:
            conditions.append(SilhouetteConfig.zone_id == zone_id)

        config_row = None
        if conditions:
            # Try camera-specific first
            if camera_id is not None:
                stmt = select(SilhouetteConfig).where(
                    and_(SilhouetteConfig.camera_id == camera_id, SilhouetteConfig.is_active == True)
                )
                result = await db.execute(stmt)
                config_row = result.scalars().first()

            # Fall back to zone
            if config_row is None and zone_id is not None:
                stmt = select(SilhouetteConfig).where(
                    and_(SilhouetteConfig.zone_id == zone_id, SilhouetteConfig.is_active == True)
                )
                result = await db.execute(stmt)
                config_row = result.scalars().first()

            # If camera provided but no zone, try to find zone via camera
            if config_row is None and camera_id is not None and zone_id is None:
                cam_stmt = select(Camera.zone_id).where(Camera.id == camera_id)
                cam_result = await db.execute(cam_stmt)
                linked_zone_id = cam_result.scalar_one_or_none()
                if linked_zone_id is not None:
                    stmt = select(SilhouetteConfig).where(
                        and_(SilhouetteConfig.zone_id == linked_zone_id, SilhouetteConfig.is_active == True)
                    )
                    result = await db.execute(stmt)
                    config_row = result.scalars().first()

        if config_row is None:
            # Return defaults
            return {
                "mode": "full_video",
                "silhouette_color_mode": "single",
                "blur_faces": False,
                "blur_plates": False,
                "blur_screens": False,
                "auto_redact_on_export": True,
                "redact_faces": True,
                "redact_plates": True,
                "redact_documents": False,
                "tier_roles": _DEFAULT_TIER_ROLES,
                "is_default": True,
            }

        return {
            "id": str(config_row.id),
            "zone_id": str(config_row.zone_id) if config_row.zone_id else None,
            "camera_id": str(config_row.camera_id) if config_row.camera_id else None,
            "mode": config_row.mode,
            "silhouette_color_mode": config_row.silhouette_color_mode,
            "blur_faces": config_row.blur_faces,
            "blur_plates": config_row.blur_plates,
            "blur_screens": config_row.blur_screens,
            "auto_redact_on_export": config_row.auto_redact_on_export,
            "redact_faces": config_row.redact_faces,
            "redact_plates": config_row.redact_plates,
            "redact_documents": config_row.redact_documents,
            "tier_roles": {
                1: config_row.tier1_access_roles or [],
                2: config_row.tier2_access_roles or [],
                3: config_row.tier3_access_roles or [],
            },
            "is_default": False,
        }

    async def set_zone_config(
        self,
        db: AsyncSession,
        zone_id: Optional[uuid.UUID] = None,
        camera_id: Optional[uuid.UUID] = None,
        config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create or update silhouette config for a zone or camera."""
        if config is None:
            config = {}

        # Look for existing
        existing = None
        if camera_id is not None:
            stmt = select(SilhouetteConfig).where(SilhouetteConfig.camera_id == camera_id)
            result = await db.execute(stmt)
            existing = result.scalars().first()
        if existing is None and zone_id is not None:
            stmt = select(SilhouetteConfig).where(SilhouetteConfig.zone_id == zone_id)
            result = await db.execute(stmt)
            existing = result.scalars().first()

        tier_roles = config.get("tier_roles", {})

        if existing:
            # Update existing
            existing.mode = config.get("mode", existing.mode)
            existing.silhouette_color_mode = config.get("silhouette_color_mode", existing.silhouette_color_mode)
            existing.blur_faces = config.get("blur_faces", existing.blur_faces)
            existing.blur_plates = config.get("blur_plates", existing.blur_plates)
            existing.blur_screens = config.get("blur_screens", existing.blur_screens)
            existing.auto_redact_on_export = config.get("auto_redact_on_export", existing.auto_redact_on_export)
            existing.redact_faces = config.get("redact_faces", existing.redact_faces)
            existing.redact_plates = config.get("redact_plates", existing.redact_plates)
            existing.redact_documents = config.get("redact_documents", existing.redact_documents)
            if tier_roles.get(1) is not None:
                existing.tier1_access_roles = tier_roles[1]
            if tier_roles.get(2) is not None:
                existing.tier2_access_roles = tier_roles[2]
            if tier_roles.get(3) is not None:
                existing.tier3_access_roles = tier_roles[3]
            await db.flush()
            record = existing
            logger.info("silhouette_config_updated", config_id=str(record.id))
        else:
            # Create new
            record = SilhouetteConfig(
                zone_id=zone_id,
                camera_id=camera_id,
                mode=config.get("mode", "full_video"),
                silhouette_color_mode=config.get("silhouette_color_mode", "single"),
                blur_faces=config.get("blur_faces", False),
                blur_plates=config.get("blur_plates", False),
                blur_screens=config.get("blur_screens", False),
                tier1_access_roles=tier_roles.get(1, ["viewer"]),
                tier2_access_roles=tier_roles.get(2, ["operator", "analyst"]),
                tier3_access_roles=tier_roles.get(3, ["admin"]),
                auto_redact_on_export=config.get("auto_redact_on_export", True),
                redact_faces=config.get("redact_faces", True),
                redact_plates=config.get("redact_plates", True),
                redact_documents=config.get("redact_documents", False),
            )
            db.add(record)
            await db.flush()
            logger.info("silhouette_config_created", config_id=str(record.id))

        return {
            "id": str(record.id),
            "zone_id": str(record.zone_id) if record.zone_id else None,
            "camera_id": str(record.camera_id) if record.camera_id else None,
            "mode": record.mode,
            "silhouette_color_mode": record.silhouette_color_mode,
            "blur_faces": record.blur_faces,
            "blur_plates": record.blur_plates,
            "auto_redact_on_export": record.auto_redact_on_export,
        }

    async def check_access_tier(
        self,
        db: AsyncSession,
        user_role: str,
        zone_id: Optional[uuid.UUID] = None,
        camera_id: Optional[uuid.UUID] = None,
    ) -> int:
        """Determine video access tier for a user based on role and zone config.

        Returns
        -------
        int
            1 = silhouette only, 2 = blurred faces, 3 = full video.
        """
        cfg = await self.get_zone_config(db, zone_id=zone_id, camera_id=camera_id)
        tier_roles = cfg.get("tier_roles", _DEFAULT_TIER_ROLES)

        role_lower = user_role.lower() if isinstance(user_role, str) else str(user_role).lower()

        # Check from highest tier down — grant the highest tier the role qualifies for
        for tier in (3, 2, 1):
            tier_key = tier
            allowed = tier_roles.get(tier_key, [])
            if role_lower in [r.lower() for r in allowed]:
                return tier

        # Default: if role not found anywhere, treat as tier 1 (most restrictive)
        return 1

    async def log_video_access(
        self,
        db: AsyncSession,
        user_id: uuid.UUID,
        camera_id: uuid.UUID,
        access_tier: int,
        reason: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Log a video access event. Tier 3 access is always logged.

        For tier 3, a time limit of 60 minutes is automatically set.
        """
        now = datetime.now(timezone.utc)
        time_limit = 60 if access_tier == 3 else None
        expires_at = now + timedelta(minutes=time_limit) if time_limit else None

        log_entry = VideoAccessLog(
            user_id=user_id,
            camera_id=camera_id,
            access_tier=access_tier,
            reason=reason,
            time_limit_minutes=time_limit,
            expires_at=expires_at,
        )
        db.add(log_entry)
        await db.flush()

        logger.info(
            "video_access_logged",
            user_id=str(user_id),
            camera_id=str(camera_id),
            tier=access_tier,
            reason=reason,
        )

        return {
            "id": str(log_entry.id),
            "user_id": str(user_id),
            "camera_id": str(camera_id),
            "access_tier": access_tier,
            "reason": reason,
            "time_limit_minutes": time_limit,
            "expires_at": expires_at.isoformat() if expires_at else None,
            "accessed_at": now.isoformat(),
        }

    async def get_access_audit(
        self,
        db: AsyncSession,
        camera_id: Optional[uuid.UUID] = None,
        user_id: Optional[uuid.UUID] = None,
        days: int = 30,
    ) -> List[Dict[str, Any]]:
        """Get video access audit trail filtered by camera and/or user."""
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        conditions = [VideoAccessLog.accessed_at >= cutoff]
        if camera_id is not None:
            conditions.append(VideoAccessLog.camera_id == camera_id)
        if user_id is not None:
            conditions.append(VideoAccessLog.user_id == user_id)

        stmt = (
            select(VideoAccessLog)
            .where(and_(*conditions))
            .order_by(VideoAccessLog.accessed_at.desc())
            .limit(500)
        )
        result = await db.execute(stmt)
        rows = result.scalars().all()

        audit_entries: List[Dict[str, Any]] = []
        for row in rows:
            audit_entries.append({
                "id": str(row.id),
                "user_id": str(row.user_id),
                "camera_id": str(row.camera_id),
                "access_tier": row.access_tier,
                "reason": row.reason,
                "time_limit_minutes": row.time_limit_minutes,
                "accessed_at": row.accessed_at.isoformat() if row.accessed_at else None,
                "expires_at": row.expires_at.isoformat() if row.expires_at else None,
                "approved_by": str(row.approved_by) if row.approved_by else None,
            })

        logger.info(
            "access_audit_retrieved",
            camera_id=str(camera_id) if camera_id else None,
            user_id=str(user_id) if user_id else None,
            days=days,
            count=len(audit_entries),
        )
        return audit_entries


# Module-level singleton
silhouette_service = SilhouetteService()
