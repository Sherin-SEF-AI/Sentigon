"""SSO / Identity Integration Service — SAML 2.0, OAuth2/OIDC, LDAP/AD, MFA, API Keys."""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional dependency: pyotp (TOTP-based MFA)
# ---------------------------------------------------------------------------
try:
    import pyotp

    _HAS_PYOTP = True
except ImportError:
    pyotp = None  # type: ignore[assignment]
    _HAS_PYOTP = False
    logger.warning("pyotp not installed — TOTP MFA features will be unavailable")


# ═══════════════════════════════════════════════════════════════════════════
# Dataclasses
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class SSOProvider:
    """Configuration for a single SSO / identity provider."""

    provider_id: str
    name: str
    provider_type: str  # "saml" | "oauth2" | "ldap"
    enabled: bool = True

    # SAML
    metadata_url: Optional[str] = None

    # OAuth2 / OIDC
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    authorize_url: Optional[str] = None
    token_url: Optional[str] = None
    userinfo_url: Optional[str] = None
    scopes: List[str] = field(default_factory=lambda: ["openid", "profile", "email"])

    # Shared
    attribute_mapping: Dict[str, str] = field(default_factory=lambda: {
        "email": "email",
        "name": "name",
        "groups": "groups",
    })


@dataclass
class MFASetup:
    """Multi-factor authentication setup state for a user."""

    user_id: str
    secret: str
    provisioning_uri: str
    backup_codes: List[str] = field(default_factory=list)
    is_enabled: bool = False


@dataclass
class APIKey:
    """Represents a hashed API key record."""

    key_id: str
    user_id: str
    name: str
    key_hash: str
    prefix: str
    scopes: List[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: Optional[datetime] = None
    last_used: Optional[datetime] = None
    is_active: bool = True


@dataclass
class LDAPConfig:
    """LDAP / Active Directory connection parameters."""

    server: str = ""
    port: int = 389
    use_ssl: bool = False
    bind_dn: str = ""
    bind_password: str = ""
    base_dn: str = ""
    user_filter: str = "(uid={username})"
    group_filter: str = "(objectClass=groupOfNames)"
    attribute_mapping: Dict[str, str] = field(default_factory=lambda: {
        "email": "mail",
        "name": "cn",
        "groups": "memberOf",
    })


# ═══════════════════════════════════════════════════════════════════════════
# Service
# ═══════════════════════════════════════════════════════════════════════════

class SSOService:
    """Unified SSO, MFA, and API-key management service."""

    def __init__(self) -> None:
        # In-memory stores (swap for DB-backed persistence in production)
        self._providers: Dict[str, SSOProvider] = {}
        self._mfa_setups: Dict[str, MFASetup] = {}
        self._api_keys: Dict[str, APIKey] = {}        # key_id -> APIKey
        self._api_key_hashes: Dict[str, str] = {}     # key_hash -> key_id
        self._refresh_tokens: Dict[str, Dict[str, Any]] = {}  # refresh_token -> payload

        # LDAP config from environment
        self._ldap_config = LDAPConfig(
            server=os.getenv("LDAP_SERVER", ""),
            port=int(os.getenv("LDAP_PORT", "389")),
            use_ssl=os.getenv("LDAP_USE_SSL", "false").lower() == "true",
            bind_dn=os.getenv("LDAP_BIND_DN", ""),
            bind_password=os.getenv("LDAP_BIND_PASSWORD", ""),
            base_dn=os.getenv("LDAP_BASE_DN", ""),
            user_filter=os.getenv("LDAP_USER_FILTER", "(uid={username})"),
            group_filter=os.getenv("LDAP_GROUP_FILTER", "(objectClass=groupOfNames)"),
        )

        logger.info("SSOService initialised")

    # ── Provider Management ───────────────────────────────────────────────

    def add_provider(self, provider: SSOProvider) -> SSOProvider:
        """Register an SSO provider."""
        self._providers[provider.provider_id] = provider
        logger.info("SSO provider added: %s (%s)", provider.name, provider.provider_type)
        return provider

    def get_providers(self) -> List[SSOProvider]:
        """Return all registered providers."""
        return list(self._providers.values())

    def get_provider(self, provider_id: str) -> Optional[SSOProvider]:
        """Return a single provider or ``None``."""
        return self._providers.get(provider_id)

    def remove_provider(self, provider_id: str) -> bool:
        """Remove a provider. Returns ``True`` if it existed."""
        removed = self._providers.pop(provider_id, None)
        if removed:
            logger.info("SSO provider removed: %s", provider_id)
        return removed is not None

    # ── OAuth2 / OIDC ─────────────────────────────────────────────────────

    def get_authorize_url(
        self,
        provider_id: str,
        redirect_uri: str,
        state: Optional[str] = None,
    ) -> Dict[str, str]:
        """Build the OAuth2 authorization URL for the given provider."""
        provider = self._providers.get(provider_id)
        if not provider or provider.provider_type != "oauth2":
            raise ValueError(f"OAuth2 provider not found: {provider_id}")
        if not provider.authorize_url:
            raise ValueError(f"Provider {provider_id} has no authorize_url configured")

        params = {
            "client_id": provider.client_id or "",
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(provider.scopes),
            "state": state or secrets.token_urlsafe(32),
        }

        query = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"{provider.authorize_url}?{query}"

        return {"authorize_url": url, "state": params["state"]}

    async def handle_oauth_callback(
        self,
        provider_id: str,
        code: str,
        redirect_uri: str,
    ) -> Dict[str, Any]:
        """Exchange an authorization code for tokens and fetch user info.

        In production this would make real HTTP calls to the IdP.  The stub
        returns a simulated token set so the rest of the pipeline can be
        tested end-to-end.
        """
        provider = self._providers.get(provider_id)
        if not provider or provider.provider_type != "oauth2":
            raise ValueError(f"OAuth2 provider not found: {provider_id}")

        # --- Simulated token exchange ---
        access_token = secrets.token_urlsafe(48)
        refresh_token = secrets.token_urlsafe(48)
        id_token = secrets.token_urlsafe(64)

        self._refresh_tokens[refresh_token] = {
            "provider_id": provider_id,
            "access_token": access_token,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        user_info = {
            "sub": str(uuid.uuid4()),
            "email": f"user-{code[:8]}@{provider.name.lower().replace(' ', '')}.example",
            "name": f"OAuth User ({provider.name})",
            "groups": [],
        }

        logger.info(
            "OAuth2 callback handled for provider %s — user %s",
            provider_id,
            user_info["email"],
        )

        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "id_token": id_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "user_info": user_info,
        }

    # ── LDAP / Active Directory ───────────────────────────────────────────

    async def authenticate_ldap(
        self,
        username: str,
        password: str,
    ) -> Dict[str, Any]:
        """Authenticate a user against the configured LDAP directory.

        This is a stub that validates the configuration is present and returns
        a simulated result.  In production, replace with ``ldap3`` calls.
        """
        cfg = self._ldap_config
        if not cfg.server:
            raise ValueError("LDAP server not configured")

        logger.info(
            "LDAP auth attempt — user=%s server=%s:%d ssl=%s",
            username,
            cfg.server,
            cfg.port,
            cfg.use_ssl,
        )

        # Simulated successful bind
        return {
            "authenticated": True,
            "user": {
                "username": username,
                "email": f"{username}@ldap.local",
                "name": username.title(),
                "groups": ["Domain Users"],
                "dn": f"uid={username},{cfg.base_dn}",
            },
        }

    async def sync_ldap_users(self) -> Dict[str, Any]:
        """Synchronise users from the LDAP directory.

        Stub — returns a summary.  Replace with real ``ldap3`` search in
        production.
        """
        cfg = self._ldap_config
        if not cfg.server:
            raise ValueError("LDAP server not configured")

        logger.info("LDAP user sync started — base_dn=%s", cfg.base_dn)

        return {
            "synced_at": datetime.now(timezone.utc).isoformat(),
            "users_found": 0,
            "users_created": 0,
            "users_updated": 0,
            "users_disabled": 0,
            "server": cfg.server,
            "base_dn": cfg.base_dn,
        }

    # ── MFA / TOTP ────────────────────────────────────────────────────────

    def setup_mfa(self, user_id: str) -> MFASetup:
        """Generate a new TOTP secret and backup codes for *user_id*."""
        if not _HAS_PYOTP:
            raise RuntimeError("pyotp is required for MFA — install it with: pip install pyotp")

        secret = pyotp.random_base32()
        provisioning_uri = pyotp.totp.TOTP(secret).provisioning_uri(
            name=user_id,
            issuer_name="SentinelAI Physical SecOps",
        )
        backup_codes = [secrets.token_hex(4).upper() for _ in range(10)]

        setup = MFASetup(
            user_id=user_id,
            secret=secret,
            provisioning_uri=provisioning_uri,
            backup_codes=backup_codes,
            is_enabled=False,
        )
        self._mfa_setups[user_id] = setup
        logger.info("MFA setup created for user %s", user_id)
        return setup

    def verify_mfa(self, user_id: str, code: str) -> Dict[str, Any]:
        """Verify the first TOTP code to confirm MFA enrolment."""
        setup = self._mfa_setups.get(user_id)
        if not setup:
            raise ValueError(f"No pending MFA setup for user {user_id}")
        if not _HAS_PYOTP:
            raise RuntimeError("pyotp is required for MFA verification")

        totp = pyotp.TOTP(setup.secret)
        if totp.verify(code, valid_window=1):
            setup.is_enabled = True
            logger.info("MFA verified and enabled for user %s", user_id)
            return {"verified": True, "mfa_enabled": True}

        return {"verified": False, "mfa_enabled": False}

    def validate_mfa(self, user_id: str, code: str) -> Dict[str, Any]:
        """Validate a TOTP code (or backup code) during login."""
        setup = self._mfa_setups.get(user_id)
        if not setup or not setup.is_enabled:
            raise ValueError(f"MFA is not enabled for user {user_id}")
        if not _HAS_PYOTP:
            raise RuntimeError("pyotp is required for MFA validation")

        # Try TOTP first
        totp = pyotp.TOTP(setup.secret)
        if totp.verify(code, valid_window=1):
            return {"valid": True, "method": "totp"}

        # Try backup code
        upper_code = code.upper()
        if upper_code in setup.backup_codes:
            setup.backup_codes.remove(upper_code)
            logger.info(
                "Backup code consumed for user %s — %d remaining",
                user_id,
                len(setup.backup_codes),
            )
            return {"valid": True, "method": "backup_code", "remaining_backup_codes": len(setup.backup_codes)}

        return {"valid": False}

    def disable_mfa(self, user_id: str) -> Dict[str, Any]:
        """Disable MFA for the given user."""
        setup = self._mfa_setups.pop(user_id, None)
        if not setup:
            raise ValueError(f"No MFA setup found for user {user_id}")

        logger.info("MFA disabled for user %s", user_id)
        return {"mfa_disabled": True, "user_id": user_id}

    # ── API Key Management ────────────────────────────────────────────────

    def create_api_key(
        self,
        user_id: str,
        name: str,
        scopes: Optional[List[str]] = None,
        expires_days: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Create a new API key.  The raw key is returned **only once**."""
        raw_key = secrets.token_urlsafe(48)
        prefix = raw_key[:8]
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        key_id = str(uuid.uuid4())

        expires_at = None
        if expires_days and expires_days > 0:
            expires_at = datetime.now(timezone.utc) + timedelta(days=expires_days)

        api_key = APIKey(
            key_id=key_id,
            user_id=user_id,
            name=name,
            key_hash=key_hash,
            prefix=prefix,
            scopes=scopes or [],
            expires_at=expires_at,
        )

        self._api_keys[key_id] = api_key
        self._api_key_hashes[key_hash] = key_id

        logger.info("API key created — id=%s user=%s name=%s", key_id, user_id, name)

        return {
            "key_id": key_id,
            "key": raw_key,  # Only time the raw key is exposed
            "prefix": prefix,
            "name": name,
            "scopes": api_key.scopes,
            "created_at": api_key.created_at.isoformat(),
            "expires_at": api_key.expires_at.isoformat() if api_key.expires_at else None,
        }

    def validate_api_key(self, key: str) -> Dict[str, Any]:
        """Validate a raw API key and return its metadata."""
        key_hash = hashlib.sha256(key.encode()).hexdigest()
        key_id = self._api_key_hashes.get(key_hash)
        if not key_id:
            return {"valid": False, "reason": "key_not_found"}

        api_key = self._api_keys.get(key_id)
        if not api_key:
            return {"valid": False, "reason": "key_not_found"}

        if not api_key.is_active:
            return {"valid": False, "reason": "key_revoked"}

        if api_key.expires_at and datetime.now(timezone.utc) > api_key.expires_at:
            return {"valid": False, "reason": "key_expired"}

        api_key.last_used = datetime.now(timezone.utc)

        return {
            "valid": True,
            "key_id": api_key.key_id,
            "user_id": api_key.user_id,
            "name": api_key.name,
            "scopes": api_key.scopes,
        }

    def revoke_api_key(self, key_id: str) -> Dict[str, Any]:
        """Revoke an API key by its ID."""
        api_key = self._api_keys.get(key_id)
        if not api_key:
            raise ValueError(f"API key not found: {key_id}")

        api_key.is_active = False
        logger.info("API key revoked — id=%s user=%s", key_id, api_key.user_id)

        return {"revoked": True, "key_id": key_id}

    def get_user_api_keys(self, user_id: str) -> List[Dict[str, Any]]:
        """List all API keys belonging to a user (without exposing hashes)."""
        return [
            {
                "key_id": k.key_id,
                "name": k.name,
                "prefix": k.prefix,
                "scopes": k.scopes,
                "created_at": k.created_at.isoformat(),
                "expires_at": k.expires_at.isoformat() if k.expires_at else None,
                "last_used": k.last_used.isoformat() if k.last_used else None,
                "is_active": k.is_active,
            }
            for k in self._api_keys.values()
            if k.user_id == user_id
        ]

    # ── Token Refresh ─────────────────────────────────────────────────────

    async def refresh_access_token(self, refresh_token: str) -> Dict[str, Any]:
        """Exchange a refresh token for a new access token.

        Stub implementation — replace with real IdP call or JWT logic in
        production.
        """
        payload = self._refresh_tokens.get(refresh_token)
        if not payload:
            raise ValueError("Invalid or expired refresh token")

        new_access_token = secrets.token_urlsafe(48)
        new_refresh_token = secrets.token_urlsafe(48)

        # Rotate
        del self._refresh_tokens[refresh_token]
        self._refresh_tokens[new_refresh_token] = {
            "provider_id": payload.get("provider_id"),
            "access_token": new_access_token,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        return {
            "access_token": new_access_token,
            "refresh_token": new_refresh_token,
            "token_type": "Bearer",
            "expires_in": 3600,
        }


# ═══════════════════════════════════════════════════════════════════════════
# Singleton
# ═══════════════════════════════════════════════════════════════════════════

sso_service = SSOService()
