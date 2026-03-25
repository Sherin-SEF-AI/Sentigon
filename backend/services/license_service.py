"""License management service with tier-based feature gating."""
import hashlib
import json
import time
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

LICENSE_TIERS = {
    "basic": {
        "name": "Basic",
        "max_cameras": 16,
        "max_sites": 1,
        "max_users": 3,
        "features": ["alerts", "cameras", "zones", "search", "reports"],
        "sso_enabled": False,
        "multi_tenant": False,
        "white_label": False,
        "siem_enabled": False,
        "api_rate_limit": 100,  # per minute
    },
    "professional": {
        "name": "Professional",
        "max_cameras": 64,
        "max_sites": 5,
        "max_users": 20,
        "features": [
            "alerts", "cameras", "zones", "search", "reports",
            "forensics", "analytics", "behavioral", "lpr", "siem",
        ],
        "sso_enabled": True,
        "multi_tenant": False,
        "white_label": False,
        "siem_enabled": True,
        "api_rate_limit": 500,
    },
    "enterprise": {
        "name": "Enterprise",
        "max_cameras": -1,  # unlimited
        "max_sites": -1,
        "max_users": -1,
        "features": ["*"],  # all features
        "sso_enabled": True,
        "multi_tenant": True,
        "white_label": True,
        "siem_enabled": True,
        "api_rate_limit": -1,  # unlimited
    },
}


class LicenseService:
    def __init__(self):
        self._current_tier = "enterprise"  # Default to enterprise for dev
        self._license_key: Optional[str] = None
        self._expires_at: Optional[datetime] = None

    @property
    def tier(self) -> str:
        return self._current_tier

    @property
    def tier_config(self) -> dict:
        return LICENSE_TIERS.get(self._current_tier, LICENSE_TIERS["basic"])

    def is_feature_enabled(self, feature: str) -> bool:
        config = self.tier_config
        if "*" in config["features"]:
            return True
        return feature in config["features"]

    def check_limit(self, resource: str, current_count: int) -> dict:
        config = self.tier_config
        limit_key = f"max_{resource}"
        limit = config.get(limit_key, -1)
        if limit == -1:
            return {"allowed": True, "limit": "unlimited", "current": current_count}
        return {
            "allowed": current_count < limit,
            "limit": limit,
            "current": current_count,
            "remaining": max(0, limit - current_count),
        }

    def get_license_info(self) -> dict:
        config = self.tier_config
        return {
            "tier": self._current_tier,
            "tier_name": config["name"],
            "license_key": (
                self._license_key[:8] + "..." if self._license_key else None
            ),
            "expires_at": (
                self._expires_at.isoformat() if self._expires_at else None
            ),
            "limits": {
                "cameras": config["max_cameras"],
                "sites": config["max_sites"],
                "users": config["max_users"],
            },
            "features": config["features"],
            "sso_enabled": config["sso_enabled"],
            "multi_tenant": config["multi_tenant"],
            "white_label": config["white_label"],
        }

    def activate_license(self, license_key: str) -> dict:
        """Activate a license key. In production, validates against a license server."""
        self._license_key = license_key
        if license_key.startswith("ENT-"):
            self._current_tier = "enterprise"
        elif license_key.startswith("PRO-"):
            self._current_tier = "professional"
        else:
            self._current_tier = "basic"
        self._expires_at = datetime.now(timezone.utc) + timedelta(days=365)
        logger.info(
            "license.activated",
            tier=self._current_tier,
            expires_at=self._expires_at.isoformat(),
        )
        return self.get_license_info()

    def set_tier(self, tier: str) -> bool:
        """Directly set the license tier (admin/dev use only)."""
        if tier not in LICENSE_TIERS:
            return False
        self._current_tier = tier
        logger.info("license.tier_set", tier=tier)
        return True

    def get_all_tiers(self) -> dict:
        """Return metadata for all available tiers."""
        return {
            tier: {
                "name": cfg["name"],
                "max_cameras": cfg["max_cameras"],
                "max_sites": cfg["max_sites"],
                "max_users": cfg["max_users"],
                "sso_enabled": cfg["sso_enabled"],
                "multi_tenant": cfg["multi_tenant"],
                "white_label": cfg["white_label"],
                "siem_enabled": cfg["siem_enabled"],
                "api_rate_limit": cfg["api_rate_limit"],
                "features": cfg["features"],
            }
            for tier, cfg in LICENSE_TIERS.items()
        }


license_service = LicenseService()
