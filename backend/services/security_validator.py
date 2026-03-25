"""
Startup security validator.
Checks for insecure defaults and logs CRITICAL warnings.
"""
import logging
import os
import secrets

logger = logging.getLogger(__name__)

_INSECURE_JWT_SECRETS = {
    "change-me-in-production-use-openssl-rand-hex-32",
    "changeme",
    "secret",
    "jwt-secret",
    "",
}

_INSECURE_PASSWORDS = {
    "changeme123",
    "password",
    "admin",
    "admin123",
    "",
}


def validate_security_config() -> dict:
    """
    Run security checks on environment configuration.
    Returns a dict of check results.
    """
    results = {}
    app_env = os.getenv("APP_ENV", "development")
    is_production = app_env.lower() in ("production", "prod", "staging")

    # 1. JWT Secret Key
    jwt_secret = os.getenv("JWT_SECRET_KEY", "")
    if jwt_secret.lower() in _INSECURE_JWT_SECRETS or len(jwt_secret) < 32:
        msg = (
            "JWT_SECRET_KEY is insecure or default! "
            "Generate a secure key with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
        if is_production:
            logger.critical("SECURITY: %s", msg)
        else:
            logger.warning("SECURITY: %s", msg)
        results["jwt_secret"] = "INSECURE"
    else:
        results["jwt_secret"] = "OK"

    # 2. Default Admin Password
    admin_password = os.getenv("DEFAULT_ADMIN_PASSWORD", "")
    if admin_password.lower() in _INSECURE_PASSWORDS:
        msg = (
            "DEFAULT_ADMIN_PASSWORD is insecure! "
            "Change it immediately in .env"
        )
        if is_production:
            logger.critical("SECURITY: %s", msg)
        else:
            logger.warning("SECURITY: %s", msg)
        results["admin_password"] = "INSECURE"
    else:
        results["admin_password"] = "OK"

    # 3. Dev auth bypass in production
    dev_bypass = os.getenv("ALLOW_DEV_AUTH_BYPASS", "false").lower() == "true"
    if dev_bypass and is_production:
        logger.critical(
            "SECURITY: ALLOW_DEV_AUTH_BYPASS is enabled in production! "
            "This allows unauthenticated admin access."
        )
        results["dev_auth_bypass"] = "CRITICAL"
    else:
        results["dev_auth_bypass"] = "OK"

    # 4. CORS origins
    cors_origins = os.getenv("CORS_ORIGINS", "")
    if is_production and ("localhost" in cors_origins or "*" in cors_origins):
        logger.warning(
            "SECURITY: CORS_ORIGINS contains localhost or wildcard in production. "
            "Restrict to production domains only."
        )
        results["cors_origins"] = "WARNING"
    else:
        results["cors_origins"] = "OK"

    # 5. Evidence HMAC key
    hmac_key = os.getenv("EVIDENCE_HMAC_KEY", "sentinel-evidence-integrity-key")
    if hmac_key == "sentinel-evidence-integrity-key":
        logger.warning(
            "SECURITY: EVIDENCE_HMAC_KEY is using default value. "
            "Generate a unique key for evidence integrity."
        )
        results["evidence_hmac"] = "DEFAULT"
    else:
        results["evidence_hmac"] = "OK"

    # 6. Debug mode
    if is_production and os.getenv("LOG_LEVEL", "").upper() == "DEBUG":
        logger.warning(
            "SECURITY: LOG_LEVEL is DEBUG in production. "
            "This may expose sensitive information in logs."
        )
        results["log_level"] = "WARNING"
    else:
        results["log_level"] = "OK"

    # Summary
    insecure_count = sum(
        1 for v in results.values() if v not in ("OK",)
    )
    if insecure_count > 0:
        logger.warning(
            "Security validation: %d issue(s) found out of %d checks",
            insecure_count,
            len(results),
        )
    else:
        logger.info("Security validation: All %d checks passed", len(results))

    return results
