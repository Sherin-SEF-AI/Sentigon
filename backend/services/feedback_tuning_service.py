"""Phase 3B: Feedback-Driven Model Tuning Service.

Operator one-click feedback on alerts drives per-camera false-positive profiles,
adaptive confidence thresholds, and automatic suppression of chronically
noisy camera+signature combinations.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select, func, and_, or_, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Alert, Camera
from backend.models.phase3_models import AlertFeedback, FalsePositiveProfile

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Tuning constants
# ---------------------------------------------------------------------------

_DEFAULT_THRESHOLD = 0.35
_AUTO_SUPPRESS_TP_RATE = 0.20       # suppress when < 20 % true positives
_AUTO_SUPPRESS_MIN_SAMPLES = 10     # ... but only after enough samples
_TOP_FP_LIMIT = 10                  # top false-positive sources in reports


class FeedbackTuningService:
    """Continuous model tuning driven by operator feedback."""

    # ------------------------------------------------------------------
    # Record feedback
    # ------------------------------------------------------------------

    async def record_feedback(
        self,
        db: AsyncSession,
        alert_id: str,
        operator_id: str,
        is_true_positive: bool,
        fp_reason: Optional[str] = None,
        fp_notes: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Record one-click operator feedback on an alert.

        1. Fetch the alert to extract camera_id and signature (threat_type).
        2. Create an AlertFeedback row.
        3. Upsert the FalsePositiveProfile for that camera + signature.
        4. Recalculate tp_rate and adjusted_threshold.
        5. Auto-suppress if tp_rate < 0.20 and sample size > 10.
        """
        alert_uuid = uuid.UUID(alert_id)
        operator_uuid = uuid.UUID(operator_id)

        # --- Fetch alert ---
        alert_result = await db.execute(
            select(Alert).where(Alert.id == alert_uuid)
        )
        alert = alert_result.scalar_one_or_none()
        if not alert:
            logger.warning("feedback.alert_not_found", alert_id=alert_id)
            return {
                "feedback_id": None,
                "profile_updated": False,
                "threshold_adjusted": False,
                "auto_suppressed": False,
                "error": "alert_not_found",
            }

        # Resolve camera_id (may be stored as string name in source_camera)
        camera_id = await self._resolve_camera_id(db, alert)
        signature_name = alert.threat_type or "unknown"

        # --- 1. Create feedback row ---
        feedback = AlertFeedback(
            alert_id=alert_uuid,
            operator_id=operator_uuid,
            camera_id=camera_id,
            signature_name=signature_name,
            is_true_positive=is_true_positive,
            fp_reason=fp_reason if not is_true_positive else None,
            fp_notes=fp_notes if not is_true_positive else None,
            original_confidence=alert.confidence,
            severity=alert.severity.value if alert.severity else None,
        )
        db.add(feedback)
        await db.flush()
        feedback_id = str(feedback.id)

        # --- 2-3. Upsert FalsePositiveProfile ---
        profile_updated = False
        threshold_adjusted = False
        auto_suppressed = False

        if camera_id:
            profile = await self._get_or_create_profile(db, camera_id, signature_name)

            # Update counters
            profile.total_alerts += 1
            if is_true_positive:
                profile.true_positives += 1
            else:
                profile.false_positives += 1
                # Track FP reason distribution
                reasons = profile.fp_reasons or {}
                reason_key = fp_reason or "unspecified"
                reasons[reason_key] = reasons.get(reason_key, 0) + 1
                profile.fp_reasons = reasons

            # Recalculate tp_rate
            if profile.total_alerts > 0:
                profile.tp_rate = round(
                    profile.true_positives / profile.total_alerts, 4
                )
            else:
                profile.tp_rate = 0.5

            profile.last_feedback_at = datetime.now(timezone.utc)

            # --- 4. Adjust threshold based on tp_rate ---
            old_threshold = profile.adjusted_threshold
            profile.adjusted_threshold = self._compute_threshold(
                profile.tp_rate, profile.original_threshold
            )
            threshold_adjusted = abs(profile.adjusted_threshold - old_threshold) > 0.001

            # --- 5. Auto-suppress if chronically noisy ---
            if (
                profile.tp_rate < _AUTO_SUPPRESS_TP_RATE
                and profile.total_alerts >= _AUTO_SUPPRESS_MIN_SAMPLES
            ):
                profile.suppressed = True
                auto_suppressed = True
                logger.warning(
                    "feedback.auto_suppressed",
                    camera_id=str(camera_id),
                    signature=signature_name,
                    tp_rate=profile.tp_rate,
                    total=profile.total_alerts,
                )
            else:
                # Lift suppression if tp_rate recovers above threshold
                if profile.suppressed and profile.tp_rate >= _AUTO_SUPPRESS_TP_RATE:
                    profile.suppressed = False
                    logger.info(
                        "feedback.suppression_lifted",
                        camera_id=str(camera_id),
                        signature=signature_name,
                        tp_rate=profile.tp_rate,
                    )

            profile_updated = True

        await db.commit()

        logger.info(
            "feedback.recorded",
            feedback_id=feedback_id,
            alert_id=alert_id,
            is_tp=is_true_positive,
            signature=signature_name,
            profile_updated=profile_updated,
            threshold_adjusted=threshold_adjusted,
            auto_suppressed=auto_suppressed,
        )

        return {
            "feedback_id": feedback_id,
            "profile_updated": profile_updated,
            "threshold_adjusted": threshold_adjusted,
            "auto_suppressed": auto_suppressed,
        }

    # ------------------------------------------------------------------
    # Camera FP profile lookup
    # ------------------------------------------------------------------

    async def get_camera_fp_profile(
        self,
        db: AsyncSession,
        camera_id: str,
    ) -> List[Dict[str, Any]]:
        """Get all FP profiles for a camera, showing which signatures are problematic."""
        cam_uuid = uuid.UUID(camera_id)
        result = await db.execute(
            select(FalsePositiveProfile)
            .where(FalsePositiveProfile.camera_id == cam_uuid)
            .order_by(FalsePositiveProfile.tp_rate.asc())
        )
        profiles = result.scalars().all()

        return [
            {
                "profile_id": str(p.id),
                "camera_id": str(p.camera_id),
                "signature_name": p.signature_name,
                "total_alerts": p.total_alerts,
                "true_positives": p.true_positives,
                "false_positives": p.false_positives,
                "tp_rate": round(p.tp_rate, 4),
                "fp_reasons": p.fp_reasons or {},
                "original_threshold": p.original_threshold,
                "adjusted_threshold": p.adjusted_threshold,
                "suppressed": p.suppressed,
                "last_feedback_at": p.last_feedback_at.isoformat() if p.last_feedback_at else None,
            }
            for p in profiles
        ]

    # ------------------------------------------------------------------
    # Adjusted threshold lookup
    # ------------------------------------------------------------------

    async def get_adjusted_threshold(
        self,
        db: AsyncSession,
        camera_id: str,
        signature_name: str,
    ) -> float:
        """Return the auto-adjusted confidence threshold for a camera+signature.

        Thresholds increase as FP rate climbs:
            tp_rate > 0.8  -> original threshold (no change)
            tp_rate 0.5-0.8 -> threshold + 0.10
            tp_rate 0.2-0.5 -> threshold + 0.25
            tp_rate < 0.2  -> threshold + 0.40 (or suppress entirely)

        Returns the default threshold if no profile exists.
        """
        cam_uuid = uuid.UUID(camera_id)
        result = await db.execute(
            select(FalsePositiveProfile).where(
                and_(
                    FalsePositiveProfile.camera_id == cam_uuid,
                    FalsePositiveProfile.signature_name == signature_name,
                )
            )
        )
        profile = result.scalar_one_or_none()

        if not profile:
            return _DEFAULT_THRESHOLD

        return profile.adjusted_threshold

    # ------------------------------------------------------------------
    # Suppression check
    # ------------------------------------------------------------------

    async def should_suppress(
        self,
        db: AsyncSession,
        camera_id: str,
        signature_name: str,
    ) -> bool:
        """Check whether detections for this camera+signature should be suppressed."""
        cam_uuid = uuid.UUID(camera_id)
        result = await db.execute(
            select(FalsePositiveProfile.suppressed).where(
                and_(
                    FalsePositiveProfile.camera_id == cam_uuid,
                    FalsePositiveProfile.signature_name == signature_name,
                )
            )
        )
        row = result.scalar_one_or_none()
        return bool(row) if row is not None else False

    # ------------------------------------------------------------------
    # Weekly FP report
    # ------------------------------------------------------------------

    async def generate_fp_report(
        self,
        db: AsyncSession,
        days: int = 7,
    ) -> Dict[str, Any]:
        """Generate a false-positive report covering the last *days* days.

        - Top 10 FP sources (camera + signature combos, ranked by FP count).
        - Trending improvements (signatures with improving tp_rate).
        - Remaining problem areas.
        - Overall system tp_rate.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        # -- Aggregate feedback stats in the period --
        total_fb_result = await db.execute(
            select(func.count(AlertFeedback.id)).where(
                AlertFeedback.created_at >= cutoff
            )
        )
        total_feedback = total_fb_result.scalar() or 0

        tp_count_result = await db.execute(
            select(func.count(AlertFeedback.id)).where(
                and_(
                    AlertFeedback.created_at >= cutoff,
                    AlertFeedback.is_true_positive.is_(True),
                )
            )
        )
        tp_count = tp_count_result.scalar() or 0
        fp_count = total_feedback - tp_count
        overall_tp_rate = round(tp_count / total_feedback, 4) if total_feedback > 0 else 0.0

        # -- Top 10 FP sources by false_positives descending --
        top_fp_result = await db.execute(
            select(FalsePositiveProfile)
            .where(FalsePositiveProfile.false_positives > 0)
            .order_by(FalsePositiveProfile.false_positives.desc())
            .limit(_TOP_FP_LIMIT)
        )
        top_fp_profiles = top_fp_result.scalars().all()

        top_fp_sources = [
            {
                "camera_id": str(p.camera_id),
                "signature_name": p.signature_name,
                "false_positives": p.false_positives,
                "total_alerts": p.total_alerts,
                "tp_rate": round(p.tp_rate, 4),
                "top_reasons": dict(
                    sorted(
                        (p.fp_reasons or {}).items(),
                        key=lambda x: x[1],
                        reverse=True,
                    )[:3]
                ),
                "suppressed": p.suppressed,
                "adjusted_threshold": p.adjusted_threshold,
            }
            for p in top_fp_profiles
        ]

        # -- Trending improvements: profiles whose tp_rate improved recently --
        # Heuristic: profiles with recent feedback and tp_rate > 0.6 that were
        # previously below that (indicated by adjusted_threshold still elevated).
        improving_result = await db.execute(
            select(FalsePositiveProfile).where(
                and_(
                    FalsePositiveProfile.tp_rate >= 0.6,
                    FalsePositiveProfile.adjusted_threshold > FalsePositiveProfile.original_threshold,
                    FalsePositiveProfile.last_feedback_at >= cutoff,
                    FalsePositiveProfile.total_alerts >= 5,
                )
            ).order_by(FalsePositiveProfile.tp_rate.desc()).limit(10)
        )
        improving_profiles = improving_result.scalars().all()

        trending_improvements = [
            {
                "camera_id": str(p.camera_id),
                "signature_name": p.signature_name,
                "tp_rate": round(p.tp_rate, 4),
                "total_alerts": p.total_alerts,
                "adjusted_threshold": p.adjusted_threshold,
            }
            for p in improving_profiles
        ]

        # -- Problem areas: low tp_rate and not yet suppressed --
        problem_result = await db.execute(
            select(FalsePositiveProfile).where(
                and_(
                    FalsePositiveProfile.tp_rate < 0.5,
                    FalsePositiveProfile.suppressed.is_(False),
                    FalsePositiveProfile.total_alerts >= 3,
                )
            ).order_by(FalsePositiveProfile.tp_rate.asc()).limit(10)
        )
        problem_profiles = problem_result.scalars().all()

        problem_areas = [
            {
                "camera_id": str(p.camera_id),
                "signature_name": p.signature_name,
                "tp_rate": round(p.tp_rate, 4),
                "false_positives": p.false_positives,
                "total_alerts": p.total_alerts,
                "top_reason": max(
                    (p.fp_reasons or {"unknown": 0}).items(),
                    key=lambda x: x[1],
                )[0] if p.fp_reasons else "unknown",
            }
            for p in problem_profiles
        ]

        # -- Suppressed count --
        suppressed_result = await db.execute(
            select(func.count(FalsePositiveProfile.id)).where(
                FalsePositiveProfile.suppressed.is_(True)
            )
        )
        suppressed_count = suppressed_result.scalar() or 0

        report = {
            "period_days": days,
            "total_feedback": total_feedback,
            "true_positives": tp_count,
            "false_positives": fp_count,
            "overall_tp_rate": overall_tp_rate,
            "top_fp_sources": top_fp_sources,
            "trending_improvements": trending_improvements,
            "problem_areas": problem_areas,
            "suppressed_signatures": suppressed_count,
        }

        logger.info(
            "fp_report.generated",
            period_days=days,
            total_feedback=total_feedback,
            overall_tp_rate=overall_tp_rate,
            suppressed=suppressed_count,
        )

        return report

    # ------------------------------------------------------------------
    # Reset profile
    # ------------------------------------------------------------------

    async def reset_profile(
        self,
        db: AsyncSession,
        camera_id: str,
        signature_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Reset FP profile(s) for a camera. Used when camera is repositioned.

        If signature_name is provided, reset only that specific profile.
        Otherwise, reset all profiles for the camera.
        """
        cam_uuid = uuid.UUID(camera_id)
        conditions = [FalsePositiveProfile.camera_id == cam_uuid]
        if signature_name:
            conditions.append(FalsePositiveProfile.signature_name == signature_name)

        # Fetch matching profiles
        result = await db.execute(
            select(FalsePositiveProfile).where(and_(*conditions))
        )
        profiles = result.scalars().all()

        reset_count = 0
        for profile in profiles:
            profile.total_alerts = 0
            profile.true_positives = 0
            profile.false_positives = 0
            profile.tp_rate = 0.5
            profile.fp_reasons = {}
            profile.adjusted_threshold = profile.original_threshold
            profile.suppressed = False
            profile.last_feedback_at = None
            reset_count += 1

        await db.commit()

        logger.info(
            "fp_profile.reset",
            camera_id=camera_id,
            signature=signature_name or "all",
            reset_count=reset_count,
        )

        return {
            "camera_id": camera_id,
            "signature_name": signature_name or "all",
            "profiles_reset": reset_count,
        }

    # ------------------------------------------------------------------
    # Load thresholds for detection engine
    # ------------------------------------------------------------------

    async def apply_thresholds_to_engine(
        self,
        db: AsyncSession,
    ) -> Dict[tuple, float]:
        """Load all adjusted thresholds into a dict for fast lookup.

        Returns a dict mapping (camera_id_str, signature_name) to the
        adjusted_threshold value.  Suppressed profiles are included
        with threshold = 1.0 (effectively suppressed since no detection
        will exceed 1.0 confidence).
        """
        result = await db.execute(
            select(FalsePositiveProfile).where(
                or_(
                    FalsePositiveProfile.adjusted_threshold != FalsePositiveProfile.original_threshold,
                    FalsePositiveProfile.suppressed.is_(True),
                )
            )
        )
        profiles = result.scalars().all()

        threshold_map: Dict[tuple, float] = {}
        for p in profiles:
            key = (str(p.camera_id), p.signature_name)
            if p.suppressed:
                threshold_map[key] = 1.0  # effectively suppress
            else:
                threshold_map[key] = p.adjusted_threshold

        logger.info(
            "thresholds.loaded",
            profile_count=len(threshold_map),
            suppressed=[k for k, v in threshold_map.items() if v >= 1.0],
        )

        return threshold_map

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_threshold(tp_rate: float, original_threshold: float) -> float:
        """Compute the adjusted confidence threshold from tp_rate.

        tp_rate > 0.8  -> original (accurate signature)
        tp_rate 0.5-0.8 -> +0.10  (some noise)
        tp_rate 0.2-0.5 -> +0.25  (noisy)
        tp_rate < 0.2  -> +0.40  (very noisy, near suppression)

        Clamped to a maximum of 0.95.
        """
        if tp_rate > 0.8:
            adjusted = original_threshold
        elif tp_rate > 0.5:
            adjusted = original_threshold + 0.10
        elif tp_rate > 0.2:
            adjusted = original_threshold + 0.25
        else:
            adjusted = original_threshold + 0.40

        return round(min(adjusted, 0.95), 4)

    @staticmethod
    async def _resolve_camera_id(
        db: AsyncSession,
        alert: Alert,
    ) -> Optional[uuid.UUID]:
        """Resolve the camera UUID from an alert.

        The Alert model stores source_camera as a string (the camera name).
        Look up the Camera row to get the actual UUID.  Falls back to the
        Event's camera_id if available.
        """
        # Try via the linked Event first
        if alert.event_id:
            from backend.models.models import Event

            evt_result = await db.execute(
                select(Event.camera_id).where(Event.id == alert.event_id)
            )
            cam_id = evt_result.scalar_one_or_none()
            if cam_id:
                return cam_id

        # Fallback: look up Camera by name
        if alert.source_camera:
            cam_result = await db.execute(
                select(Camera.id).where(Camera.name == alert.source_camera).limit(1)
            )
            cam_id = cam_result.scalar_one_or_none()
            if cam_id:
                return cam_id

        return None

    @staticmethod
    async def _get_or_create_profile(
        db: AsyncSession,
        camera_id: uuid.UUID,
        signature_name: str,
    ) -> FalsePositiveProfile:
        """Fetch the existing FP profile or create a new one."""
        result = await db.execute(
            select(FalsePositiveProfile).where(
                and_(
                    FalsePositiveProfile.camera_id == camera_id,
                    FalsePositiveProfile.signature_name == signature_name,
                )
            )
        )
        profile = result.scalar_one_or_none()

        if not profile:
            profile = FalsePositiveProfile(
                camera_id=camera_id,
                signature_name=signature_name,
                total_alerts=0,
                true_positives=0,
                false_positives=0,
                tp_rate=0.5,
                fp_reasons={},
                original_threshold=_DEFAULT_THRESHOLD,
                adjusted_threshold=_DEFAULT_THRESHOLD,
                suppressed=False,
            )
            db.add(profile)
            await db.flush()

        return profile


# Module-level singleton
feedback_tuning_service = FeedbackTuningService()
