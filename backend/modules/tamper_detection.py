"""Scene change and camera tamper detection.

Combines structural similarity (SSIM) with Gemini 3 Flash vision
analysis to detect camera tampering (covered, spray-painted, redirected)
and scene modifications (objects added/removed, furniture moved).
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from sqlalchemy import select

from backend.config import settings
from backend.database import async_session
from backend.models.advanced_models import CameraBaseline
from backend.modules.gemini_client import compare_frames_flash
from backend.services.vector_store import vector_store

logger = logging.getLogger(__name__)

# Base directory for persisted baseline frames
_BASELINES_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data",
    "baselines",
)


class TamperDetection:
    """Camera tamper and scene change detection using SSIM + Gemini 3 Flash.

    Workflow:
        1. A *baseline* frame is captured for each camera during setup or
           on an operator-triggered refresh.
        2. Periodic checks compare the live frame to the baseline using
           SSIM (structural similarity index).
        3. If SSIM drops below the threshold (default 0.6), Gemini 3 Flash
           is called to classify the change as tamper / scene modification /
           normal activity / lighting change.
        4. Alerts are created for confirmed tampering or scene modifications.
    """

    TAMPER_PROMPT = (
        "Compare these two images of the same camera view. "
        "The first is the baseline, the second is current.\n"
        "Has the camera been physically tampered with (covered, spray-painted, "
        "redirected, obstructed)?\n"
        "Or has the scene been modified (objects added/removed, furniture moved, "
        "graffiti added)?\n"
        "Or is this just normal activity (people, vehicles, lighting changes)?"
    )

    TAMPER_SCHEMA: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "tamper_detected": {"type": "boolean"},
            "tamper_type": {
                "type": "string",
                "enum": [
                    "camera_tamper",
                    "scene_modification",
                    "normal_activity",
                    "lighting_change",
                ],
            },
            "confidence": {"type": "number"},
            "description": {"type": "string"},
            "severity": {
                "type": "string",
                "enum": ["none", "low", "medium", "high", "critical"],
            },
        },
        "required": [
            "tamper_detected",
            "tamper_type",
            "confidence",
            "description",
            "severity",
        ],
    }

    # Severity mapping for automatic alert creation
    _ALERT_SEVERITY_MAP = {
        "camera_tamper": "critical",
        "scene_modification": "medium",
        "lighting_change": "low",
        "normal_activity": "none",
    }

    # ── Baseline management ───────────────────────────────────────

    async def capture_baseline(
        self,
        camera_id: str,
        frame_bytes: bytes,
    ) -> str:
        """Save a baseline frame for a camera.

        Persists the JPEG to ``data/baselines/{camera_id}_{timestamp}.jpg``
        and creates (or updates) a :class:`CameraBaseline` record.

        Args:
            camera_id: UUID (as string) of the camera.
            frame_bytes: JPEG-encoded baseline image.

        Returns:
            Absolute file path of the saved baseline image.
        """
        try:
            os.makedirs(_BASELINES_DIR, exist_ok=True)

            ts_slug = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            filename = f"{camera_id}_{ts_slug}.jpg"
            filepath = os.path.join(_BASELINES_DIR, filename)

            with open(filepath, "wb") as f:
                f.write(frame_bytes)

            # Deactivate previous baselines for this camera, then insert new one
            async with async_session() as session:
                result = await session.execute(
                    select(CameraBaseline).where(
                        CameraBaseline.camera_id == uuid.UUID(camera_id),
                        CameraBaseline.active == True,  # noqa: E712
                    )
                )
                existing = result.scalars().all()
                for baseline in existing:
                    baseline.active = False

                new_baseline = CameraBaseline(
                    camera_id=uuid.UUID(camera_id),
                    baseline_frame_path=filepath,
                    ssim_threshold=0.6,
                    active=True,
                )
                session.add(new_baseline)
                await session.commit()

            logger.info(
                "tamper.baseline.captured camera=%s path=%s",
                camera_id,
                filepath,
            )
            return filepath

        except Exception as exc:
            logger.error("tamper.baseline.error camera=%s err=%s", camera_id, exc)
            return ""

    # ── Tamper check ──────────────────────────────────────────────

    async def check_tamper(
        self,
        camera_id: str,
        current_frame_bytes: bytes,
    ) -> dict:
        """Compare current frame against baseline using SSIM + Gemini.

        Steps:
            1. Load the active baseline for the camera from the database.
            2. Compute SSIM between baseline and current frame.
            3. If SSIM is below the threshold, call Gemini 3 Flash to
               classify the change.
            4. Create an alert if tampering or scene modification is
               confirmed.

        Args:
            camera_id: UUID (as string) of the camera.
            current_frame_bytes: JPEG-encoded current frame.

        Returns:
            Dict with keys ``ssim``, ``tamper_detected``, ``tamper_type``,
            ``confidence``, ``description``, ``severity``, and ``alert_id``
            (if an alert was created).
        """
        result: Dict[str, Any] = {
            "camera_id": camera_id,
            "ssim": 1.0,
            "tamper_detected": False,
            "tamper_type": "normal_activity",
            "confidence": 0.0,
            "description": "",
            "severity": "none",
            "alert_id": None,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

        try:
            # 1. Load active baseline
            baseline_path, ssim_threshold = await self._load_baseline(camera_id)
            if not baseline_path or not os.path.exists(baseline_path):
                logger.warning(
                    "tamper.check.skip camera=%s — no active baseline found",
                    camera_id,
                )
                result["description"] = "No baseline available for this camera"
                return result

            with open(baseline_path, "rb") as f:
                baseline_bytes = f.read()

            # 2. Compute SSIM
            ssim_value = self._compute_ssim(baseline_bytes, current_frame_bytes)
            result["ssim"] = round(ssim_value, 4)

            logger.info(
                "tamper.ssim camera=%s ssim=%.4f threshold=%.2f",
                camera_id,
                ssim_value,
                ssim_threshold,
            )

            # If SSIM is above threshold, no further analysis needed
            if ssim_value >= ssim_threshold:
                result["description"] = "Scene unchanged — SSIM within normal range"
                return result

            # 3. SSIM below threshold — send both frames to Gemini
            gemini_result = await compare_frames_flash(
                frame_a_bytes=baseline_bytes,
                frame_b_bytes=current_frame_bytes,
                prompt=self.TAMPER_PROMPT,
                json_schema=self.TAMPER_SCHEMA,
            )

            if not gemini_result or "tamper_detected" not in gemini_result:
                logger.warning(
                    "tamper.gemini.empty camera=%s — Gemini returned no classification",
                    camera_id,
                )
                result["description"] = "SSIM low but Gemini analysis inconclusive"
                result["tamper_detected"] = True
                result["tamper_type"] = "camera_tamper"
                result["severity"] = "high"
                result["confidence"] = 0.5
                return result

            # Merge Gemini classification into result
            result["tamper_detected"] = gemini_result.get("tamper_detected", False)
            result["tamper_type"] = gemini_result.get("tamper_type", "normal_activity")
            result["confidence"] = gemini_result.get("confidence", 0.0)
            result["description"] = gemini_result.get("description", "")
            result["severity"] = gemini_result.get("severity", "none")

            # 4. Create alert if warranted
            if result["tamper_detected"] and result["tamper_type"] in (
                "camera_tamper",
                "scene_modification",
            ):
                alert_id = await self._create_tamper_alert(camera_id, result)
                result["alert_id"] = alert_id

            logger.info(
                "tamper.check.done camera=%s tamper=%s type=%s severity=%s conf=%.2f",
                camera_id,
                result["tamper_detected"],
                result["tamper_type"],
                result["severity"],
                result["confidence"],
            )
            return result

        except Exception as exc:
            logger.error("tamper.check.error camera=%s err=%s", camera_id, exc)
            result["description"] = f"Error during tamper check: {exc}"
            return result

    # ── List baselines ────────────────────────────────────────────

    async def get_baselines(self) -> list:
        """Get all camera baselines (active and inactive).

        Returns:
            List of dicts with ``id``, ``camera_id``, ``baseline_frame_path``,
            ``captured_at``, ``ssim_threshold``, and ``active``.
        """
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(CameraBaseline).order_by(CameraBaseline.captured_at.desc())
                )
                baselines = result.scalars().all()

                return [
                    {
                        "id": str(b.id),
                        "camera_id": str(b.camera_id),
                        "baseline_frame_path": b.baseline_frame_path,
                        "captured_at": b.captured_at.isoformat() if b.captured_at else None,
                        "ssim_threshold": b.ssim_threshold,
                        "active": b.active,
                    }
                    for b in baselines
                ]

        except Exception as exc:
            logger.error("tamper.baselines.error err=%s", exc)
            return []

    # ── Private helpers ───────────────────────────────────────────

    async def _load_baseline(self, camera_id: str) -> tuple:
        """Load the active baseline path and SSIM threshold from the DB.

        Returns:
            Tuple of ``(baseline_frame_path, ssim_threshold)`` or
            ``("", 0.6)`` if none found.
        """
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(CameraBaseline).where(
                        CameraBaseline.camera_id == uuid.UUID(camera_id),
                        CameraBaseline.active == True,  # noqa: E712
                    ).order_by(CameraBaseline.captured_at.desc()).limit(1)
                )
                baseline = result.scalar_one_or_none()
                if baseline:
                    return baseline.baseline_frame_path, baseline.ssim_threshold
                return "", 0.6
        except Exception as exc:
            logger.error("tamper._load_baseline.error camera=%s err=%s", camera_id, exc)
            return "", 0.6

    @staticmethod
    def _compute_ssim(
        image_a_bytes: bytes,
        image_b_bytes: bytes,
    ) -> float:
        """Compute SSIM between two JPEG-encoded images.

        Both images are converted to grayscale and resized to a common
        resolution (640x480) before comparison to ensure consistent
        scoring regardless of source resolution.

        Returns:
            SSIM value in [0.0, 1.0].  A value of 1.0 means identical.
        """
        try:
            target_size = (640, 480)

            arr_a = np.frombuffer(image_a_bytes, dtype=np.uint8)
            img_a = cv2.imdecode(arr_a, cv2.IMREAD_GRAYSCALE)
            if img_a is None:
                logger.warning("tamper.ssim — failed to decode baseline image")
                return 1.0

            arr_b = np.frombuffer(image_b_bytes, dtype=np.uint8)
            img_b = cv2.imdecode(arr_b, cv2.IMREAD_GRAYSCALE)
            if img_b is None:
                logger.warning("tamper.ssim — failed to decode current image")
                return 1.0

            img_a = cv2.resize(img_a, target_size)
            img_b = cv2.resize(img_b, target_size)

            # Compute SSIM using OpenCV's quality module if available,
            # otherwise fall back to a manual implementation.
            try:
                from skimage.metrics import structural_similarity
                score, _ = structural_similarity(img_a, img_b, full=True)
                return float(score)
            except ImportError:
                # Manual SSIM (simplified Wang et al. 2004)
                C1 = (0.01 * 255) ** 2
                C2 = (0.03 * 255) ** 2

                img_a_f = img_a.astype(np.float64)
                img_b_f = img_b.astype(np.float64)

                mu1 = cv2.GaussianBlur(img_a_f, (11, 11), 1.5)
                mu2 = cv2.GaussianBlur(img_b_f, (11, 11), 1.5)

                mu1_sq = mu1 ** 2
                mu2_sq = mu2 ** 2
                mu1_mu2 = mu1 * mu2

                sigma1_sq = cv2.GaussianBlur(img_a_f ** 2, (11, 11), 1.5) - mu1_sq
                sigma2_sq = cv2.GaussianBlur(img_b_f ** 2, (11, 11), 1.5) - mu2_sq
                sigma12 = cv2.GaussianBlur(img_a_f * img_b_f, (11, 11), 1.5) - mu1_mu2

                numerator = (2 * mu1_mu2 + C1) * (2 * sigma12 + C2)
                denominator = (mu1_sq + mu2_sq + C1) * (sigma1_sq + sigma2_sq + C2)

                ssim_map = numerator / denominator
                return float(np.mean(ssim_map))

        except Exception as exc:
            logger.error("tamper.ssim.error err=%s", exc)
            return 1.0  # Assume no change on error to avoid false positives

    @staticmethod
    async def _create_tamper_alert(camera_id: str, check_result: dict) -> Optional[str]:
        """Create an alert for confirmed tampering or scene modification.

        Uses the :class:`AlertManager` singleton to benefit from
        deduplication and subscriber notifications.

        Returns:
            The alert ID string, or ``None`` if alert creation was
            suppressed (e.g. by deduplication).
        """
        try:
            from backend.services.alert_manager import alert_manager

            tamper_type = check_result.get("tamper_type", "camera_tamper")
            severity = TamperDetection._ALERT_SEVERITY_MAP.get(tamper_type, "medium")

            if tamper_type == "camera_tamper":
                title = f"Camera Tamper Detected — {camera_id[:8]}"
            else:
                title = f"Scene Modification Detected — {camera_id[:8]}"

            alert_data = await alert_manager.create_alert(
                title=title,
                description=check_result.get("description", ""),
                severity=severity,
                threat_type=tamper_type,
                source_camera=camera_id,
                confidence=check_result.get("confidence", 0.0),
                metadata={
                    "ssim": check_result.get("ssim"),
                    "tamper_type": tamper_type,
                    "gemini_description": check_result.get("description", ""),
                },
            )

            if alert_data:
                logger.info(
                    "tamper.alert.created id=%s severity=%s camera=%s",
                    alert_data["id"],
                    severity,
                    camera_id,
                )
                return alert_data["id"]
            return None

        except Exception as exc:
            logger.error("tamper.alert.error camera=%s err=%s", camera_id, exc)
            return None


# Singleton
tamper_detection = TamperDetection()
