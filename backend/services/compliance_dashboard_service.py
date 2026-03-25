"""Phase 3E: Compliance Dashboard & Privacy Scorecard Service.

Runs structured compliance assessments against GDPR, CCPA, BIPA, and
internal privacy frameworks.  Each assessment evaluates five categories:

  1. Data Retention   — Are retention policies configured and auto-purge active?
  2. Consent          — Are privacy configs set for visitor-facing cameras?
  3. Access Control   — Are tiered video-access controls configured?
  4. Redaction        — Is auto-redaction enabled for video exports?
  5. Audit Trail      — Are video accesses being logged consistently?

Scores (0-100 per category) are persisted as ComplianceAssessment rows and
surfaced via a scorecard API for the frontend dashboard.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models.models import Camera, Zone, AuditLog
from backend.models.phase2b_models import DataRetentionPolicy, PrivacyRequest
from backend.models.phase3_models import (
    ComplianceAssessment,
    SilhouetteConfig,
    VideoAccessLog,
)

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Category weights per framework (must sum to 1.0)
# ---------------------------------------------------------------------------

_FRAMEWORK_WEIGHTS: Dict[str, Dict[str, float]] = {
    "gdpr": {
        "data_retention": 0.25,
        "consent": 0.20,
        "access_control": 0.20,
        "redaction": 0.20,
        "audit_trail": 0.15,
    },
    "ccpa": {
        "data_retention": 0.20,
        "consent": 0.25,
        "access_control": 0.15,
        "redaction": 0.25,
        "audit_trail": 0.15,
    },
    "bipa": {
        "data_retention": 0.15,
        "consent": 0.30,
        "access_control": 0.20,
        "redaction": 0.25,
        "audit_trail": 0.10,
    },
    "internal": {
        "data_retention": 0.20,
        "consent": 0.20,
        "access_control": 0.20,
        "redaction": 0.20,
        "audit_trail": 0.20,
    },
}

# Severity thresholds
_SEVERITY_THRESHOLDS = {
    "critical": 40,   # Score below 40 = critical issue
    "high": 60,       # Score below 60 = high
    "medium": 80,     # Score below 80 = medium
}


class ComplianceDashboardService:
    """Compliance scoring, PIA generation, and erasure-request tracking."""

    FRAMEWORKS = ["gdpr", "ccpa", "bipa", "internal"]

    # ------------------------------------------------------------------
    # Internal scoring helpers
    # ------------------------------------------------------------------

    async def _score_data_retention(
        self, db: AsyncSession, scope: str, scope_id: Optional[uuid.UUID],
    ) -> tuple[float, List[Dict]]:
        """Score data retention category (0-100).

        Checks:
        - At least one active retention policy exists.
        - Auto-purge is enabled.
        - Last purge was recent (within 7 days).
        - Key data types have policies (video, events, access_logs, detections).
        """
        issues: List[Dict] = []

        stmt = select(DataRetentionPolicy).where(DataRetentionPolicy.is_active == True)
        result = await db.execute(stmt)
        policies = result.scalars().all()

        if not policies:
            issues.append({
                "category": "data_retention",
                "severity": "critical",
                "description": "No active data retention policies configured",
                "recommendation": "Configure retention policies for all data types (video, events, access_logs, detections)",
            })
            return 0.0, issues

        score = 30.0  # Base points for having at least one policy

        # Check essential data types
        essential_types = {"video", "events", "access_logs", "detections"}
        covered_types = {p.data_type.lower() for p in policies if p.data_type}
        missing_types = essential_types - covered_types
        type_coverage = len(essential_types - missing_types) / len(essential_types)
        score += type_coverage * 25.0  # Up to 25 points for type coverage

        if missing_types:
            issues.append({
                "category": "data_retention",
                "severity": "high",
                "description": f"Missing retention policies for: {', '.join(sorted(missing_types))}",
                "recommendation": f"Add retention policies for {', '.join(sorted(missing_types))}",
            })

        # Check auto-purge enabled
        auto_purge_count = sum(1 for p in policies if p.auto_purge)
        if auto_purge_count == len(policies):
            score += 20.0  # All have auto-purge
        elif auto_purge_count > 0:
            score += 10.0  # Partial
            issues.append({
                "category": "data_retention",
                "severity": "medium",
                "description": f"{len(policies) - auto_purge_count} retention policies have auto-purge disabled",
                "recommendation": "Enable auto-purge on all retention policies to ensure regulatory compliance",
            })
        else:
            issues.append({
                "category": "data_retention",
                "severity": "critical",
                "description": "Auto-purge is disabled on all retention policies",
                "recommendation": "Enable auto-purge to automatically remove data past retention period",
            })

        # Check recent purge activity
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        recent_purge = any(
            p.last_purge_at and p.last_purge_at.replace(tzinfo=timezone.utc if p.last_purge_at.tzinfo is None else p.last_purge_at.tzinfo) >= cutoff
            for p in policies
        )
        if recent_purge:
            score += 15.0
        else:
            issues.append({
                "category": "data_retention",
                "severity": "medium",
                "description": "No data purge activity in the last 7 days",
                "recommendation": "Verify that the retention purge scheduler is running correctly",
            })

        # Check reasonable retention periods (not excessively long)
        excessively_long = [p for p in policies if p.retention_days and p.retention_days > 365]
        if not excessively_long:
            score += 10.0
        else:
            issues.append({
                "category": "data_retention",
                "severity": "medium",
                "description": f"{len(excessively_long)} policies retain data for over 1 year",
                "recommendation": "Review whether extended retention periods are legally justified",
            })

        return min(100.0, score), issues

    async def _score_consent(
        self, db: AsyncSession, scope: str, scope_id: Optional[uuid.UUID],
    ) -> tuple[float, List[Dict]]:
        """Score consent/privacy configuration.

        Checks if cameras/zones have SilhouetteConfig records, especially
        visitor-facing ones.
        """
        issues: List[Dict] = []

        # Count total active cameras
        cam_result = await db.execute(select(func.count(Camera.id)).where(Camera.is_active == True))
        total_cameras = cam_result.scalar() or 0

        if total_cameras == 0:
            return 100.0, []  # No cameras, no consent issues

        # Count cameras with privacy configs
        config_result = await db.execute(
            select(func.count(SilhouetteConfig.id)).where(SilhouetteConfig.is_active == True)
        )
        total_configs = config_result.scalar() or 0

        # Count zone-level configs
        zone_config_result = await db.execute(
            select(func.count(SilhouetteConfig.id)).where(
                and_(SilhouetteConfig.zone_id.isnot(None), SilhouetteConfig.is_active == True)
            )
        )
        zone_configs = zone_config_result.scalar() or 0

        # Count camera-level configs
        camera_config_result = await db.execute(
            select(func.count(SilhouetteConfig.id)).where(
                and_(SilhouetteConfig.camera_id.isnot(None), SilhouetteConfig.is_active == True)
            )
        )
        camera_configs = camera_config_result.scalar() or 0

        # Approximate coverage — camera-level configs are direct; zone configs
        # cover multiple cameras.  Count cameras with zones that have configs.
        covered_via_zone = 0
        if zone_configs > 0:
            configured_zone_ids_stmt = select(SilhouetteConfig.zone_id).where(
                and_(SilhouetteConfig.zone_id.isnot(None), SilhouetteConfig.is_active == True)
            )
            cz_result = await db.execute(configured_zone_ids_stmt)
            configured_zone_ids = [row[0] for row in cz_result.fetchall()]
            if configured_zone_ids:
                covered_stmt = select(func.count(Camera.id)).where(
                    Camera.zone_id.in_(configured_zone_ids)
                )
                covered_result = await db.execute(covered_stmt)
                covered_via_zone = covered_result.scalar() or 0

        covered_cameras = min(total_cameras, camera_configs + covered_via_zone)
        coverage_ratio = covered_cameras / total_cameras if total_cameras > 0 else 0

        score = coverage_ratio * 70.0  # Up to 70 points for coverage

        if coverage_ratio < 0.5:
            issues.append({
                "category": "consent",
                "severity": "critical",
                "description": f"Only {covered_cameras}/{total_cameras} cameras have privacy configurations",
                "recommendation": "Configure silhouette/privacy settings for all cameras, especially visitor-facing ones",
            })
        elif coverage_ratio < 1.0:
            issues.append({
                "category": "consent",
                "severity": "high",
                "description": f"{total_cameras - covered_cameras} cameras lack privacy configurations",
                "recommendation": "Extend privacy configurations to remaining uncovered cameras",
            })

        # Bonus points for configs that enable privacy-protective modes
        if total_configs > 0:
            privacy_modes_stmt = select(
                func.count(SilhouetteConfig.id)
            ).where(
                and_(
                    SilhouetteConfig.is_active == True,
                    SilhouetteConfig.mode.in_(["silhouette_only", "blurred_faces"]),
                )
            )
            privacy_result = await db.execute(privacy_modes_stmt)
            privacy_mode_count = privacy_result.scalar() or 0
            privacy_ratio = privacy_mode_count / total_configs
            score += privacy_ratio * 30.0
        else:
            issues.append({
                "category": "consent",
                "severity": "high",
                "description": "No silhouette or blur modes enabled on any cameras",
                "recommendation": "Enable silhouette_only or blurred_faces mode for public/visitor areas",
            })

        return min(100.0, score), issues

    async def _score_access_control(
        self, db: AsyncSession, scope: str, scope_id: Optional[uuid.UUID],
    ) -> tuple[float, List[Dict]]:
        """Score tiered access control configuration."""
        issues: List[Dict] = []

        config_result = await db.execute(
            select(SilhouetteConfig).where(SilhouetteConfig.is_active == True)
        )
        configs = config_result.scalars().all()

        if not configs:
            issues.append({
                "category": "access_control",
                "severity": "critical",
                "description": "No tiered access control configurations exist",
                "recommendation": "Configure role-based video access tiers for all zones",
            })
            return 0.0, issues

        score = 30.0  # Base for having configs

        # Check that tier roles are properly configured
        well_configured = 0
        for cfg in configs:
            t1 = cfg.tier1_access_roles or []
            t2 = cfg.tier2_access_roles or []
            t3 = cfg.tier3_access_roles or []
            has_tiers = bool(t1) and bool(t2) and bool(t3)
            # Full video (tier 3) should not include viewer role
            viewer_in_t3 = "viewer" in [r.lower() for r in t3]
            if has_tiers and not viewer_in_t3:
                well_configured += 1

        tier_ratio = well_configured / len(configs) if configs else 0
        score += tier_ratio * 40.0

        if tier_ratio < 0.5:
            issues.append({
                "category": "access_control",
                "severity": "high",
                "description": f"Only {well_configured}/{len(configs)} configs have proper tier-role separation",
                "recommendation": "Ensure all zones have distinct tier1/tier2/tier3 role assignments",
            })

        # Check that tier 3 (full video) access requires justification — we check
        # via VideoAccessLog whether tier-3 accesses have reasons
        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        t3_total_stmt = select(func.count(VideoAccessLog.id)).where(
            and_(VideoAccessLog.access_tier == 3, VideoAccessLog.accessed_at >= cutoff)
        )
        t3_result = await db.execute(t3_total_stmt)
        t3_total = t3_result.scalar() or 0

        if t3_total > 0:
            t3_with_reason_stmt = select(func.count(VideoAccessLog.id)).where(
                and_(
                    VideoAccessLog.access_tier == 3,
                    VideoAccessLog.accessed_at >= cutoff,
                    VideoAccessLog.reason.isnot(None),
                    VideoAccessLog.reason != "",
                )
            )
            t3_reason_result = await db.execute(t3_with_reason_stmt)
            t3_with_reason = t3_reason_result.scalar() or 0
            reason_ratio = t3_with_reason / t3_total
            score += reason_ratio * 30.0

            if reason_ratio < 0.8:
                issues.append({
                    "category": "access_control",
                    "severity": "medium",
                    "description": f"{t3_total - t3_with_reason}/{t3_total} tier-3 accesses lack justification",
                    "recommendation": "Require mandatory reason field for all full-video access requests",
                })
        else:
            score += 30.0  # No tier-3 accesses = no violation

        return min(100.0, score), issues

    async def _score_redaction(
        self, db: AsyncSession, scope: str, scope_id: Optional[uuid.UUID],
    ) -> tuple[float, List[Dict]]:
        """Score auto-redaction configuration."""
        issues: List[Dict] = []

        config_result = await db.execute(
            select(SilhouetteConfig).where(SilhouetteConfig.is_active == True)
        )
        configs = config_result.scalars().all()

        if not configs:
            issues.append({
                "category": "redaction",
                "severity": "critical",
                "description": "No redaction configurations exist",
                "recommendation": "Configure auto-redaction settings for all cameras/zones",
            })
            return 0.0, issues

        score = 20.0  # Base for having any config

        # Check auto-redact on export
        auto_redact_count = sum(1 for c in configs if c.auto_redact_on_export)
        redact_ratio = auto_redact_count / len(configs)
        score += redact_ratio * 30.0

        if redact_ratio < 1.0:
            issues.append({
                "category": "redaction",
                "severity": "high",
                "description": f"{len(configs) - auto_redact_count}/{len(configs)} configs have auto-redact disabled for exports",
                "recommendation": "Enable auto_redact_on_export on all configurations",
            })

        # Check face redaction
        face_redact_count = sum(1 for c in configs if c.redact_faces)
        face_ratio = face_redact_count / len(configs)
        score += face_ratio * 25.0

        if face_ratio < 1.0:
            issues.append({
                "category": "redaction",
                "severity": "high",
                "description": f"{len(configs) - face_redact_count}/{len(configs)} configs have face redaction disabled",
                "recommendation": "Enable face redaction for all exports to protect individual identity",
            })

        # Check plate redaction
        plate_redact_count = sum(1 for c in configs if c.redact_plates)
        plate_ratio = plate_redact_count / len(configs)
        score += plate_ratio * 25.0

        if plate_ratio < 0.8:
            issues.append({
                "category": "redaction",
                "severity": "medium",
                "description": f"License plate redaction not enabled on {len(configs) - plate_redact_count} configs",
                "recommendation": "Enable plate redaction for parking and perimeter cameras",
            })

        return min(100.0, score), issues

    async def _score_audit_trail(
        self, db: AsyncSession, scope: str, scope_id: Optional[uuid.UUID],
    ) -> tuple[float, List[Dict]]:
        """Score audit trail completeness."""
        issues: List[Dict] = []
        now = datetime.now(timezone.utc)
        cutoff_30d = now - timedelta(days=30)
        cutoff_7d = now - timedelta(days=7)

        # Count video access logs in last 30 days
        log_count_stmt = select(func.count(VideoAccessLog.id)).where(
            VideoAccessLog.accessed_at >= cutoff_30d
        )
        log_result = await db.execute(log_count_stmt)
        log_count_30d = log_result.scalar() or 0

        # Count recent logs (last 7 days) — if system is active there should be some
        recent_stmt = select(func.count(VideoAccessLog.id)).where(
            VideoAccessLog.accessed_at >= cutoff_7d
        )
        recent_result = await db.execute(recent_stmt)
        recent_count = recent_result.scalar() or 0

        # Check if any cameras are active
        active_cam_result = await db.execute(
            select(func.count(Camera.id)).where(Camera.is_active == True)
        )
        active_cameras = active_cam_result.scalar() or 0

        if active_cameras == 0:
            return 100.0, []  # No active cameras, nothing to audit

        score = 0.0

        # Points for having audit logs at all
        if log_count_30d > 0:
            score += 30.0
        else:
            issues.append({
                "category": "audit_trail",
                "severity": "critical",
                "description": "No video access logs recorded in the last 30 days",
                "recommendation": "Ensure video access logging is enabled and SilhouetteService.log_video_access is called",
            })

        # Points for recent activity
        if recent_count > 0:
            score += 20.0
        elif log_count_30d > 0:
            issues.append({
                "category": "audit_trail",
                "severity": "medium",
                "description": "No video access logs in the last 7 days despite active cameras",
                "recommendation": "Verify that video access logging middleware is functioning",
            })

        # Points for coverage — distinct cameras with logs vs total active cameras
        covered_stmt = select(func.count(func.distinct(VideoAccessLog.camera_id))).where(
            VideoAccessLog.accessed_at >= cutoff_30d
        )
        covered_result = await db.execute(covered_stmt)
        covered_cameras = covered_result.scalar() or 0
        camera_coverage = covered_cameras / active_cameras if active_cameras > 0 else 0
        score += camera_coverage * 25.0

        if camera_coverage < 0.5:
            issues.append({
                "category": "audit_trail",
                "severity": "high",
                "description": f"Only {covered_cameras}/{active_cameras} cameras have access audit logs",
                "recommendation": "Ensure access logging covers all cameras, not just a subset",
            })

        # Points for tier-3 accesses all being logged with reasons
        t3_stmt = select(func.count(VideoAccessLog.id)).where(
            and_(VideoAccessLog.access_tier == 3, VideoAccessLog.accessed_at >= cutoff_30d)
        )
        t3_result = await db.execute(t3_stmt)
        t3_count = t3_result.scalar() or 0

        if t3_count > 0:
            t3_reason_stmt = select(func.count(VideoAccessLog.id)).where(
                and_(
                    VideoAccessLog.access_tier == 3,
                    VideoAccessLog.accessed_at >= cutoff_30d,
                    VideoAccessLog.reason.isnot(None),
                )
            )
            t3_reason_result = await db.execute(t3_reason_stmt)
            t3_with_reason = t3_reason_result.scalar() or 0
            reason_pct = t3_with_reason / t3_count
            score += reason_pct * 25.0

            if reason_pct < 1.0:
                issues.append({
                    "category": "audit_trail",
                    "severity": "high",
                    "description": f"{t3_count - t3_with_reason} tier-3 accesses lack documented reasons",
                    "recommendation": "Enforce mandatory justification for all full-video access",
                })
        else:
            score += 25.0  # No tier-3 accesses — no issue

        return min(100.0, score), issues

    def _severity_for_score(self, score: float) -> str:
        """Map a category score to an issue severity."""
        if score < _SEVERITY_THRESHOLDS["critical"]:
            return "critical"
        if score < _SEVERITY_THRESHOLDS["high"]:
            return "high"
        if score < _SEVERITY_THRESHOLDS["medium"]:
            return "medium"
        return "low"

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def assess_compliance(
        self,
        db: AsyncSession,
        framework: str = "gdpr",
        scope: str = "global",
        scope_id: Optional[uuid.UUID] = None,
    ) -> Dict[str, Any]:
        """Run a full compliance assessment and persist the result."""
        if framework not in self.FRAMEWORKS:
            framework = "internal"

        weights = _FRAMEWORK_WEIGHTS[framework]

        # Score each category
        retention_score, retention_issues = await self._score_data_retention(db, scope, scope_id)
        consent_score, consent_issues = await self._score_consent(db, scope, scope_id)
        access_score, access_issues = await self._score_access_control(db, scope, scope_id)
        redaction_score, redaction_issues = await self._score_redaction(db, scope, scope_id)
        audit_score, audit_issues = await self._score_audit_trail(db, scope, scope_id)

        category_scores = {
            "data_retention": round(retention_score, 1),
            "consent": round(consent_score, 1),
            "access_control": round(access_score, 1),
            "redaction": round(redaction_score, 1),
            "audit_trail": round(audit_score, 1),
        }

        overall = sum(
            category_scores[cat] * weights[cat]
            for cat in category_scores
        )
        overall = round(overall, 1)

        all_issues = retention_issues + consent_issues + access_issues + redaction_issues + audit_issues
        critical_count = sum(1 for i in all_issues if i.get("severity") == "critical")

        # Generate recommendations
        recommendations: List[str] = []
        for cat, scr in sorted(category_scores.items(), key=lambda x: x[1]):
            if scr < 60:
                recommendations.append(f"Priority: Improve {cat.replace('_', ' ')} (current score: {scr})")
            elif scr < 80:
                recommendations.append(f"Review {cat.replace('_', ' ')} controls (score: {scr})")

        # Mark previous assessments for this framework as outdated
        await db.execute(
            update(ComplianceAssessment)
            .where(
                and_(
                    ComplianceAssessment.assessment_type == framework,
                    ComplianceAssessment.scope == scope,
                    ComplianceAssessment.status == "current",
                )
            )
            .values(status="outdated")
        )

        # Persist new assessment
        assessment = ComplianceAssessment(
            assessment_type=framework,
            scope=scope,
            scope_id=scope_id,
            overall_score=overall,
            data_retention_score=retention_score,
            consent_score=consent_score,
            access_control_score=access_score,
            redaction_score=redaction_score,
            audit_trail_score=audit_score,
            issues=all_issues,
            issue_count=len(all_issues),
            critical_issues=critical_count,
            status="current",
            next_assessment_at=datetime.now(timezone.utc) + timedelta(days=7),
        )
        db.add(assessment)
        await db.flush()

        logger.info(
            "compliance_assessment_completed",
            framework=framework,
            overall_score=overall,
            issues=len(all_issues),
            critical=critical_count,
        )

        return {
            "id": str(assessment.id),
            "framework": framework,
            "scope": scope,
            "overall_score": overall,
            "category_scores": category_scores,
            "issues": all_issues,
            "issue_count": len(all_issues),
            "critical_issues": critical_count,
            "recommendations": recommendations,
            "assessed_at": assessment.assessed_at.isoformat() if assessment.assessed_at else datetime.now(timezone.utc).isoformat(),
            "next_assessment_at": assessment.next_assessment_at.isoformat() if assessment.next_assessment_at else None,
        }

    async def get_scorecard(
        self, db: AsyncSession, framework: str = "gdpr",
    ) -> Dict[str, Any]:
        """Get the latest compliance scorecard for a framework."""
        stmt = (
            select(ComplianceAssessment)
            .where(
                and_(
                    ComplianceAssessment.assessment_type == framework,
                    ComplianceAssessment.status == "current",
                )
            )
            .order_by(ComplianceAssessment.assessed_at.desc())
            .limit(1)
        )
        result = await db.execute(stmt)
        row = result.scalars().first()

        if row is None:
            return {
                "framework": framework,
                "status": "no_assessment",
                "overall_score": None,
                "message": "No compliance assessment has been run for this framework yet",
            }

        return {
            "id": str(row.id),
            "framework": row.assessment_type,
            "scope": row.scope,
            "overall_score": row.overall_score,
            "category_scores": {
                "data_retention": row.data_retention_score,
                "consent": row.consent_score,
                "access_control": row.access_control_score,
                "redaction": row.redaction_score,
                "audit_trail": row.audit_trail_score,
            },
            "issues": row.issues or [],
            "issue_count": row.issue_count,
            "critical_issues": row.critical_issues,
            "status": row.status,
            "assessed_at": row.assessed_at.isoformat() if row.assessed_at else None,
            "next_assessment_at": row.next_assessment_at.isoformat() if row.next_assessment_at else None,
        }

    async def get_compliance_history(
        self, db: AsyncSession, framework: str = "gdpr", limit: int = 12,
    ) -> List[Dict[str, Any]]:
        """Get compliance score history for trend charts."""
        stmt = (
            select(ComplianceAssessment)
            .where(ComplianceAssessment.assessment_type == framework)
            .order_by(ComplianceAssessment.assessed_at.desc())
            .limit(limit)
        )
        result = await db.execute(stmt)
        rows = result.scalars().all()

        return [
            {
                "id": str(r.id),
                "overall_score": r.overall_score,
                "data_retention_score": r.data_retention_score,
                "consent_score": r.consent_score,
                "access_control_score": r.access_control_score,
                "redaction_score": r.redaction_score,
                "audit_trail_score": r.audit_trail_score,
                "issue_count": r.issue_count,
                "critical_issues": r.critical_issues,
                "assessed_at": r.assessed_at.isoformat() if r.assessed_at else None,
            }
            for r in rows
        ]

    async def get_issues(
        self, db: AsyncSession, severity: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Get all open compliance issues from the latest assessments."""
        # Get latest assessment per framework
        all_issues: List[Dict[str, Any]] = []

        for fw in self.FRAMEWORKS:
            stmt = (
                select(ComplianceAssessment)
                .where(
                    and_(
                        ComplianceAssessment.assessment_type == fw,
                        ComplianceAssessment.status == "current",
                    )
                )
                .order_by(ComplianceAssessment.assessed_at.desc())
                .limit(1)
            )
            result = await db.execute(stmt)
            row = result.scalars().first()
            if row is None or not row.issues:
                continue

            for issue in row.issues:
                issue_entry = {
                    "framework": fw,
                    "assessment_id": str(row.id),
                    "assessed_at": row.assessed_at.isoformat() if row.assessed_at else None,
                    **issue,
                }
                if severity is None or issue.get("severity") == severity:
                    all_issues.append(issue_entry)

        # Sort by severity: critical first
        severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        all_issues.sort(key=lambda x: severity_order.get(x.get("severity", "low"), 4))

        return all_issues

    async def generate_pia(
        self,
        db: AsyncSession,
        camera_id: Optional[uuid.UUID] = None,
        zone_id: Optional[uuid.UUID] = None,
    ) -> Dict[str, Any]:
        """Generate a Privacy Impact Assessment for a camera or zone.

        Analyzes what data is collected, retention duration, who has access,
        what redaction is applied, and compliance gaps.
        """
        target_label = "system-wide"
        camera_info = None
        zone_info = None

        # Gather camera details
        if camera_id:
            cam_result = await db.execute(select(Camera).where(Camera.id == camera_id))
            camera_info = cam_result.scalars().first()
            if camera_info:
                target_label = f"Camera: {camera_info.name}"
                if camera_info.zone_id and zone_id is None:
                    zone_id = camera_info.zone_id

        # Gather zone details
        if zone_id:
            zone_result = await db.execute(select(Zone).where(Zone.id == zone_id))
            zone_info = zone_result.scalars().first()
            if zone_info:
                target_label = f"Zone: {zone_info.name}" if not camera_info else f"{target_label} (Zone: {zone_info.name})"

        # Data collected
        data_types_collected = ["video_feed", "object_detections", "movement_tracking"]
        if zone_info and zone_info.zone_type in ("entry", "exit", "restricted"):
            data_types_collected.append("access_control_events")

        # Retention policies for collected data types
        ret_stmt = select(DataRetentionPolicy).where(DataRetentionPolicy.is_active == True)
        ret_result = await db.execute(ret_stmt)
        retention_policies = ret_result.scalars().all()
        retention_map = {p.data_type: p.retention_days for p in retention_policies}

        # Privacy config
        config_row = None
        if camera_id:
            cfg_stmt = select(SilhouetteConfig).where(
                and_(SilhouetteConfig.camera_id == camera_id, SilhouetteConfig.is_active == True)
            )
            cfg_result = await db.execute(cfg_stmt)
            config_row = cfg_result.scalars().first()
        if config_row is None and zone_id:
            cfg_stmt = select(SilhouetteConfig).where(
                and_(SilhouetteConfig.zone_id == zone_id, SilhouetteConfig.is_active == True)
            )
            cfg_result = await db.execute(cfg_stmt)
            config_row = cfg_result.scalars().first()

        # Access analysis — who accessed this camera in last 90 days
        access_stats = {"tier1": 0, "tier2": 0, "tier3": 0, "total": 0}
        if camera_id:
            cutoff = datetime.now(timezone.utc) - timedelta(days=90)
            for tier in (1, 2, 3):
                tier_stmt = select(func.count(VideoAccessLog.id)).where(
                    and_(
                        VideoAccessLog.camera_id == camera_id,
                        VideoAccessLog.access_tier == tier,
                        VideoAccessLog.accessed_at >= cutoff,
                    )
                )
                tier_result = await db.execute(tier_stmt)
                count = tier_result.scalar() or 0
                access_stats[f"tier{tier}"] = count
                access_stats["total"] += count

        # Build risks
        risks: List[Dict] = []
        mitigations: List[Dict] = []

        if config_row is None:
            risks.append({
                "risk": "No privacy configuration",
                "severity": "high",
                "description": "No silhouette or redaction config exists for this scope",
            })
            mitigations.append({
                "mitigation": "Configure privacy settings",
                "priority": "high",
                "action": "Set up SilhouetteConfig with appropriate mode and tier roles",
            })
        else:
            if config_row.mode == "full_video":
                risks.append({
                    "risk": "Full video mode active",
                    "severity": "medium",
                    "description": "Raw video is displayed without privacy protection",
                })
                mitigations.append({
                    "mitigation": "Consider enabling silhouette or blur mode",
                    "priority": "medium",
                    "action": "Switch mode to silhouette_only or blurred_faces",
                })

            if not config_row.auto_redact_on_export:
                risks.append({
                    "risk": "Auto-redaction disabled on export",
                    "severity": "high",
                    "description": "Exported video may contain unredacted PII",
                })
                mitigations.append({
                    "mitigation": "Enable auto-redact on export",
                    "priority": "high",
                    "action": "Set auto_redact_on_export = True",
                })

            if not config_row.blur_faces and not config_row.redact_faces:
                risks.append({
                    "risk": "Face redaction not enabled",
                    "severity": "high",
                    "description": "Faces are visible in both live view and exports",
                })

        if not retention_map:
            risks.append({
                "risk": "No data retention policies",
                "severity": "critical",
                "description": "Data may be retained indefinitely without legal basis",
            })
            mitigations.append({
                "mitigation": "Define retention policies",
                "priority": "critical",
                "action": "Create DataRetentionPolicy records for video, events, access_logs",
            })

        if access_stats["tier3"] > 0:
            risks.append({
                "risk": "Full-video access occurred",
                "severity": "low",
                "description": f"{access_stats['tier3']} tier-3 access events in last 90 days",
            })

        # Data flows
        data_flows = {
            "collection_point": target_label,
            "data_types": data_types_collected,
            "processing": "On-premise AI inference (YOLO, behavioral analysis)",
            "storage": "PostgreSQL database + local video storage",
            "retention": retention_map,
            "access_roles": {
                "tier1_silhouette": config_row.tier1_access_roles if config_row else ["viewer"],
                "tier2_blurred": config_row.tier2_access_roles if config_row else ["operator", "analyst"],
                "tier3_full": config_row.tier3_access_roles if config_row else ["admin"],
            },
            "redaction_applied": {
                "faces": config_row.redact_faces if config_row else False,
                "plates": config_row.redact_plates if config_row else False,
                "documents": config_row.redact_documents if config_row else False,
                "auto_on_export": config_row.auto_redact_on_export if config_row else False,
            },
        }

        return {
            "target": target_label,
            "camera_id": str(camera_id) if camera_id else None,
            "zone_id": str(zone_id) if zone_id else None,
            "assessment": {
                "data_collected": data_types_collected,
                "retention_summary": retention_map,
                "access_statistics": access_stats,
                "privacy_mode": config_row.mode if config_row else "unconfigured",
                "generated_at": datetime.now(timezone.utc).isoformat(),
            },
            "data_flows": data_flows,
            "risks": risks,
            "mitigations": mitigations,
            "risk_count": len(risks),
            "high_risk_count": sum(1 for r in risks if r.get("severity") in ("critical", "high")),
        }

    async def check_erasure_status(self, db: AsyncSession) -> Dict[str, Any]:
        """Check status of pending privacy/erasure requests (GDPR Art. 17)."""
        now = datetime.now(timezone.utc)
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

        # Pending requests
        pending_stmt = select(func.count(PrivacyRequest.id)).where(
            PrivacyRequest.status == "pending"
        )
        pending_result = await db.execute(pending_stmt)
        pending_count = pending_result.scalar() or 0

        # Overdue — pending for more than 30 days (GDPR requires response within 1 month)
        overdue_cutoff = now - timedelta(days=30)
        overdue_stmt = select(func.count(PrivacyRequest.id)).where(
            and_(
                PrivacyRequest.status == "pending",
                PrivacyRequest.created_at <= overdue_cutoff,
            )
        )
        overdue_result = await db.execute(overdue_stmt)
        overdue_count = overdue_result.scalar() or 0

        # Completed this month
        completed_stmt = select(func.count(PrivacyRequest.id)).where(
            and_(
                PrivacyRequest.status == "completed",
                PrivacyRequest.completed_at >= month_start,
            )
        )
        completed_result = await db.execute(completed_stmt)
        completed_this_month = completed_result.scalar() or 0

        # Average processing time for completed requests
        avg_stmt = select(
            func.avg(
                func.extract("epoch", PrivacyRequest.completed_at - PrivacyRequest.created_at)
            )
        ).where(
            and_(
                PrivacyRequest.status == "completed",
                PrivacyRequest.completed_at.isnot(None),
            )
        )
        avg_result = await db.execute(avg_stmt)
        avg_seconds = avg_result.scalar()
        avg_processing_days = round(avg_seconds / 86400.0, 1) if avg_seconds else None

        # Breakdown by type
        type_breakdown_stmt = (
            select(PrivacyRequest.request_type, func.count(PrivacyRequest.id))
            .where(PrivacyRequest.status == "pending")
            .group_by(PrivacyRequest.request_type)
        )
        type_result = await db.execute(type_breakdown_stmt)
        type_breakdown = {row[0]: row[1] for row in type_result.fetchall()}

        logger.info(
            "erasure_status_checked",
            pending=pending_count,
            overdue=overdue_count,
            completed_this_month=completed_this_month,
        )

        return {
            "pending_count": pending_count,
            "overdue_count": overdue_count,
            "completed_this_month": completed_this_month,
            "avg_processing_days": avg_processing_days,
            "type_breakdown": type_breakdown,
            "compliance_status": "compliant" if overdue_count == 0 else "non_compliant",
            "checked_at": now.isoformat(),
        }

    async def get_data_flow_map(self, db: AsyncSession) -> Dict[str, Any]:
        """Map where detection data is processed and stored.

        Provides an overview of data flows for compliance documentation
        and data protection impact assessments.
        """
        # Count active cameras by zone type
        zone_camera_stmt = (
            select(Zone.zone_type, func.count(Camera.id))
            .outerjoin(Camera, Camera.zone_id == Zone.id)
            .where(Camera.is_active == True)
            .group_by(Zone.zone_type)
        )
        zc_result = await db.execute(zone_camera_stmt)
        cameras_by_zone_type = {row[0]: row[1] for row in zc_result.fetchall()}

        # Count unzoned cameras
        unzoned_stmt = select(func.count(Camera.id)).where(
            and_(Camera.is_active == True, Camera.zone_id.is_(None))
        )
        unzoned_result = await db.execute(unzoned_stmt)
        unzoned_count = unzoned_result.scalar() or 0
        if unzoned_count > 0:
            cameras_by_zone_type["unzoned"] = unzoned_count

        # Check for external integrations via IntegrationConnector
        external_integrations: List[Dict] = []
        try:
            from backend.models.phase2b_models import IntegrationConnector
            int_stmt = select(IntegrationConnector).where(IntegrationConnector.is_active == True)
            int_result = await db.execute(int_stmt)
            connectors = int_result.scalars().all()
            for conn in connectors:
                external_integrations.append({
                    "name": conn.name,
                    "type": conn.connector_type,
                    "direction": conn.direction,
                    "last_sync": conn.last_sync_at.isoformat() if conn.last_sync_at else None,
                })
        except Exception:
            pass  # IntegrationConnector may not be available in all deployments

        # Privacy config coverage
        config_count_stmt = select(func.count(SilhouetteConfig.id)).where(
            SilhouetteConfig.is_active == True
        )
        cfg_count_result = await db.execute(config_count_stmt)
        privacy_config_count = cfg_count_result.scalar() or 0

        # Retention policies summary
        ret_stmt = select(DataRetentionPolicy).where(DataRetentionPolicy.is_active == True)
        ret_result = await db.execute(ret_stmt)
        retention_policies = ret_result.scalars().all()
        retention_summary = [
            {
                "data_type": p.data_type,
                "retention_days": p.retention_days,
                "auto_purge": p.auto_purge,
            }
            for p in retention_policies
        ]

        return {
            "processing_locations": [
                {
                    "name": "On-premise inference server",
                    "type": "primary",
                    "processing": ["YOLO object detection", "behavioral analysis", "entity tracking"],
                    "data_types": ["video frames", "detection metadata", "tracking data"],
                },
            ],
            "storage_locations": [
                {
                    "name": "PostgreSQL database",
                    "type": "primary",
                    "data_types": ["events", "alerts", "access_logs", "detection_metadata", "compliance_assessments"],
                    "encrypted": True,
                },
                {
                    "name": "Local video storage",
                    "type": "primary",
                    "data_types": ["video_recordings", "event_snapshots", "evidence_packages"],
                    "encrypted": False,
                },
            ],
            "cameras_by_zone_type": cameras_by_zone_type,
            "privacy_configs_active": privacy_config_count,
            "retention_policies": retention_summary,
            "external_integrations": external_integrations,
            "cross_border_flows": [],  # Empty unless multi-site with different jurisdictions
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }


# Module-level singleton
compliance_dashboard_service = ComplianceDashboardService()
