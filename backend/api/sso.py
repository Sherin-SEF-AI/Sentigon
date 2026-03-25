"""SSO & Identity API — SAML, OAuth2/OIDC, LDAP, MFA, and API-key endpoints."""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.sso_service import sso_service, SSOProvider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sso", tags=["SSO & Identity"])


# ═══════════════════════════════════════════════════════════════════════════
# Request / response models
# ═══════════════════════════════════════════════════════════════════════════

class ProviderRequest(BaseModel):
    provider_id: Optional[str] = None
    name: str
    provider_type: str = Field(..., description="saml | oauth2 | ldap")
    enabled: bool = True
    metadata_url: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    authorize_url: Optional[str] = None
    token_url: Optional[str] = None
    userinfo_url: Optional[str] = None
    scopes: List[str] = Field(default_factory=lambda: ["openid", "profile", "email"])
    attribute_mapping: Dict[str, str] = Field(default_factory=lambda: {
        "email": "email",
        "name": "name",
        "groups": "groups",
    })


class OAuthCallbackRequest(BaseModel):
    code: str
    redirect_uri: str


class LDAPLoginRequest(BaseModel):
    username: str
    password: str


class MFASetupRequest(BaseModel):
    user_id: str


class MFACodeRequest(BaseModel):
    user_id: str
    code: str


class TokenRefreshRequest(BaseModel):
    refresh_token: str


class APIKeyCreateRequest(BaseModel):
    user_id: str
    name: str
    scopes: List[str] = Field(default_factory=list)
    expires_days: Optional[int] = None


# ═══════════════════════════════════════════════════════════════════════════
# Provider management
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/providers")
async def list_providers():
    """List all registered SSO providers."""
    providers = sso_service.get_providers()
    return {
        "providers": [
            {
                "provider_id": p.provider_id,
                "name": p.name,
                "provider_type": p.provider_type,
                "enabled": p.enabled,
                "metadata_url": p.metadata_url,
                "authorize_url": p.authorize_url,
                "scopes": p.scopes,
            }
            for p in providers
        ],
        "total": len(providers),
    }


@router.post("/providers")
async def add_provider(body: ProviderRequest):
    """Add a new SSO provider."""
    import uuid

    provider_id = body.provider_id or str(uuid.uuid4())

    provider = SSOProvider(
        provider_id=provider_id,
        name=body.name,
        provider_type=body.provider_type,
        enabled=body.enabled,
        metadata_url=body.metadata_url,
        client_id=body.client_id,
        client_secret=body.client_secret,
        authorize_url=body.authorize_url,
        token_url=body.token_url,
        userinfo_url=body.userinfo_url,
        scopes=body.scopes,
        attribute_mapping=body.attribute_mapping,
    )

    sso_service.add_provider(provider)

    return {
        "provider_id": provider.provider_id,
        "name": provider.name,
        "provider_type": provider.provider_type,
        "status": "created",
    }


@router.delete("/providers/{provider_id}")
async def remove_provider(provider_id: str):
    """Remove an SSO provider."""
    removed = sso_service.remove_provider(provider_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Provider not found")
    return {"provider_id": provider_id, "status": "removed"}


# ═══════════════════════════════════════════════════════════════════════════
# OAuth2 / OIDC
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/oauth2/{provider_id}/authorize")
async def get_oauth2_authorize_url(
    provider_id: str,
    redirect_uri: str = Query(..., description="OAuth2 redirect URI"),
    state: Optional[str] = Query(None, description="CSRF state parameter"),
):
    """Generate the OAuth2 authorization URL for the given provider."""
    try:
        result = sso_service.get_authorize_url(provider_id, redirect_uri, state)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/oauth2/{provider_id}/callback")
async def handle_oauth2_callback(provider_id: str, body: OAuthCallbackRequest):
    """Exchange an authorization code for tokens."""
    try:
        result = await sso_service.handle_oauth_callback(
            provider_id, body.code, body.redirect_uri,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ═══════════════════════════════════════════════════════════════════════════
# LDAP / Active Directory
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/ldap/login")
async def ldap_login(body: LDAPLoginRequest):
    """Authenticate a user via LDAP."""
    try:
        result = await sso_service.authenticate_ldap(body.username, body.password)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/ldap/sync")
async def ldap_sync():
    """Synchronise users from the LDAP directory."""
    try:
        result = await sso_service.sync_ldap_users()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ═══════════════════════════════════════════════════════════════════════════
# MFA / TOTP
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/mfa/setup")
async def mfa_setup(body: MFASetupRequest):
    """Generate a new MFA secret and QR provisioning URI for a user."""
    try:
        setup = sso_service.setup_mfa(body.user_id)
        return {
            "user_id": setup.user_id,
            "provisioning_uri": setup.provisioning_uri,
            "backup_codes": setup.backup_codes,
            "is_enabled": setup.is_enabled,
        }
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc))


@router.post("/mfa/verify")
async def mfa_verify(body: MFACodeRequest):
    """Verify the initial TOTP code to complete MFA enrolment."""
    try:
        result = sso_service.verify_mfa(body.user_id, body.code)
        return result
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/mfa/validate")
async def mfa_validate(body: MFACodeRequest):
    """Validate a TOTP or backup code during login."""
    try:
        result = sso_service.validate_mfa(body.user_id, body.code)
        return result
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/mfa/disable")
async def mfa_disable(body: MFASetupRequest):
    """Disable MFA for a user."""
    try:
        result = sso_service.disable_mfa(body.user_id)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ═══════════════════════════════════════════════════════════════════════════
# Token refresh
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/token/refresh")
async def token_refresh(body: TokenRefreshRequest):
    """Exchange a refresh token for a new access token."""
    try:
        result = await sso_service.refresh_access_token(body.refresh_token)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc))


# ═══════════════════════════════════════════════════════════════════════════
# API Key management
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/api-keys")
async def create_api_key(body: APIKeyCreateRequest):
    """Create a new API key. The raw key is returned only in this response."""
    result = sso_service.create_api_key(
        user_id=body.user_id,
        name=body.name,
        scopes=body.scopes,
        expires_days=body.expires_days,
    )
    return result


@router.get("/api-keys/{user_id}")
async def list_api_keys(user_id: str):
    """List all API keys for a user."""
    keys = sso_service.get_user_api_keys(user_id)
    return {"user_id": user_id, "api_keys": keys, "total": len(keys)}


@router.delete("/api-keys/{key_id}")
async def revoke_api_key(key_id: str):
    """Revoke an API key."""
    try:
        result = sso_service.revoke_api_key(key_id)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
