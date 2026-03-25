"""Context Profiles — Environment-aware threat detection tuning.

Defines 8 environment profiles (bank, hospital, school, etc.) that adjust
threat signature sensitivity, severity boosting, and suppression based on
the deployment context.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class EnvironmentProfile:
    """Defines how threat detection behaves in a specific environment type."""
    name: str
    display_name: str
    description: str
    # Threat categories that get boosted severity (+1 level)
    boosted_categories: List[str] = field(default_factory=list)
    # Threat categories that get suppressed (reduced severity by 1 level)
    suppressed_categories: List[str] = field(default_factory=list)
    # Override confidence thresholds per category (lower = more sensitive)
    sensitivity_overrides: Dict[str, float] = field(default_factory=dict)
    # Default severity boost for all detections: -1, 0, or +1
    default_severity_boost: int = 0
    # Specific threat signatures to enable/disable
    enabled_signatures: List[str] = field(default_factory=list)
    disabled_signatures: List[str] = field(default_factory=list)


# ── 8 Environment Profiles ──────────────────────────────────────

ENVIRONMENT_PROFILES: Dict[str, EnvironmentProfile] = {
    "bank": EnvironmentProfile(
        name="bank",
        display_name="Bank / Financial Institution",
        description="High-security financial environment. Heightened sensitivity to robbery, weapons, and insider threats.",
        boosted_categories=["violence", "theft", "insider_threat", "micro_behavior"],
        suppressed_categories=["animal_threat", "social_unrest", "parking"],
        sensitivity_overrides={
            "violence": 0.25,
            "theft": 0.25,
            "insider_threat": 0.30,
            "micro_behavior": 0.30,
        },
        default_severity_boost=0,
    ),
    "hospital": EnvironmentProfile(
        name="hospital",
        display_name="Hospital / Medical Facility",
        description="Medical environment. Prioritize medical emergencies, biohazard, and patient safety.",
        boosted_categories=["safety", "medical_biohazard", "child_safety", "compliance"],
        suppressed_categories=["parking", "social_unrest", "retail_commercial"],
        sensitivity_overrides={
            "safety": 0.20,
            "medical_biohazard": 0.20,
            "child_safety": 0.25,
        },
        default_severity_boost=0,
    ),
    "school": EnvironmentProfile(
        name="school",
        display_name="School / Educational Facility",
        description="Child-focused environment. Maximum sensitivity to active shooter, child safety, and weapons.",
        boosted_categories=["active_shooter", "child_safety", "violence", "intrusion", "micro_behavior"],
        suppressed_categories=["retail_commercial", "parking", "vehicle"],
        sensitivity_overrides={
            "active_shooter": 0.15,
            "child_safety": 0.15,
            "violence": 0.20,
            "intrusion": 0.25,
        },
        default_severity_boost=1,
    ),
    "park": EnvironmentProfile(
        name="park",
        display_name="Park / Open Space",
        description="Outdoor public space. Focus on crowd safety, animal threats, and person-down events.",
        boosted_categories=["animal_threat", "safety", "occupancy", "child_safety"],
        suppressed_categories=["cyber_physical", "insider_threat", "infrastructure", "compliance"],
        sensitivity_overrides={
            "animal_threat": 0.30,
            "safety": 0.30,
        },
        default_severity_boost=0,
    ),
    "warehouse": EnvironmentProfile(
        name="warehouse",
        display_name="Warehouse / Industrial",
        description="Industrial environment. Focus on safety compliance, infrastructure, and theft prevention.",
        boosted_categories=["compliance", "infrastructure", "safety", "theft"],
        suppressed_categories=["child_safety", "retail_commercial", "social_unrest"],
        sensitivity_overrides={
            "compliance": 0.25,
            "infrastructure": 0.25,
            "safety": 0.25,
        },
        default_severity_boost=0,
    ),
    "retail": EnvironmentProfile(
        name="retail",
        display_name="Retail Store / Mall",
        description="Retail environment. Heightened shoplifting, organized retail crime, and crowd detection.",
        boosted_categories=["retail_commercial", "theft", "occupancy"],
        suppressed_categories=["cyber_physical", "insider_threat", "terrorism"],
        sensitivity_overrides={
            "retail_commercial": 0.25,
            "theft": 0.25,
            "occupancy": 0.30,
        },
        default_severity_boost=0,
    ),
    "airport": EnvironmentProfile(
        name="airport",
        display_name="Airport / Transportation Hub",
        description="High-security transit environment. Maximum sensitivity to terrorism, suspicious packages, and intrusion.",
        boosted_categories=["terrorism", "intrusion", "suspicious", "escape_evasion", "micro_behavior"],
        suppressed_categories=["animal_threat", "retail_commercial", "parking"],
        sensitivity_overrides={
            "terrorism": 0.15,
            "intrusion": 0.20,
            "suspicious": 0.20,
            "micro_behavior": 0.25,
        },
        default_severity_boost=1,
    ),
    "residential": EnvironmentProfile(
        name="residential",
        display_name="Residential / Apartment Complex",
        description="Residential environment. Focus on intrusion, vehicle anomalies, and package theft.",
        boosted_categories=["intrusion", "vehicle", "theft", "parking"],
        suppressed_categories=["compliance", "retail_commercial", "cyber_physical", "terrorism"],
        sensitivity_overrides={
            "intrusion": 0.25,
            "vehicle": 0.30,
            "theft": 0.25,
        },
        default_severity_boost=0,
    ),
}

# Severity levels in order
_SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"]


class ContextProfileService:
    """Manages active environment profile and provides severity adjustments."""

    def __init__(self):
        self._active_profile: Optional[str] = None

    @property
    def active_profile(self) -> Optional[EnvironmentProfile]:
        if self._active_profile and self._active_profile in ENVIRONMENT_PROFILES:
            return ENVIRONMENT_PROFILES[self._active_profile]
        return None

    @property
    def active_profile_name(self) -> Optional[str]:
        return self._active_profile

    def set_active_profile(self, profile_name: Optional[str]) -> Optional[str]:
        """Set the active environment profile. Returns previous profile name."""
        previous = self._active_profile
        if profile_name is None:
            self._active_profile = None
            logger.info("Context profile cleared (was: %s)", previous)
        elif profile_name in ENVIRONMENT_PROFILES:
            self._active_profile = profile_name
            logger.info("Context profile set: %s (was: %s)", profile_name, previous)
        else:
            raise ValueError(
                f"Unknown profile '{profile_name}'. "
                f"Available: {list(ENVIRONMENT_PROFILES.keys())}"
            )
        return previous

    def adjust_severity(self, category: str, base_severity: str) -> str:
        """Adjust a threat's severity based on the active profile.

        Returns the modified severity string.
        """
        profile = self.active_profile
        if not profile:
            return base_severity

        idx = _SEVERITY_ORDER.index(base_severity) if base_severity in _SEVERITY_ORDER else 2

        # Apply default boost
        idx += profile.default_severity_boost

        # Category-specific boost/suppress
        if category in profile.boosted_categories:
            idx += 1
        elif category in profile.suppressed_categories:
            idx -= 1

        # Clamp to valid range
        idx = max(0, min(idx, len(_SEVERITY_ORDER) - 1))
        return _SEVERITY_ORDER[idx]

    def get_sensitivity_threshold(self, category: str) -> float:
        """Get confidence threshold for a category (lower = more sensitive).

        Default is 0.40. Profiles can lower this for boosted categories.
        """
        profile = self.active_profile
        if not profile:
            return 0.40
        return profile.sensitivity_overrides.get(category, 0.40)

    def is_signature_disabled(self, signature_name: str) -> bool:
        """Check if a specific signature is disabled by the active profile."""
        profile = self.active_profile
        if not profile:
            return False
        if profile.disabled_signatures and signature_name in profile.disabled_signatures:
            return True
        return False

    def get_profile_info(self, profile_name: str) -> Optional[Dict[str, Any]]:
        """Get profile details as a serializable dict."""
        profile = ENVIRONMENT_PROFILES.get(profile_name)
        if not profile:
            return None
        return {
            "name": profile.name,
            "display_name": profile.display_name,
            "description": profile.description,
            "boosted_categories": profile.boosted_categories,
            "suppressed_categories": profile.suppressed_categories,
            "sensitivity_overrides": profile.sensitivity_overrides,
            "default_severity_boost": profile.default_severity_boost,
        }

    def get_all_profiles(self) -> List[Dict[str, Any]]:
        """Get all available profiles as serializable list."""
        return [
            self.get_profile_info(name)
            for name in ENVIRONMENT_PROFILES
        ]

    def get_status(self) -> Dict[str, Any]:
        """Get current profile status."""
        return {
            "active_profile": self._active_profile,
            "profile_info": self.get_profile_info(self._active_profile) if self._active_profile else None,
            "available_profiles": list(ENVIRONMENT_PROFILES.keys()),
        }


# Singleton
context_profile_service = ContextProfileService()
