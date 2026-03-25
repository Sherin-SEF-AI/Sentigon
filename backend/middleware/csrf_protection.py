"""
CSRF protection middleware using double-submit cookie pattern.
Sets a CSRF token cookie on GET requests and validates
the X-CSRF-Token header on mutation requests.
"""
import secrets
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response, JSONResponse

logger = logging.getLogger(__name__)

# Endpoints exempt from CSRF protection
EXEMPT_PATHS = {
    "/api/auth/login",
    "/api/auth/register",
    "/health",
    "/health/live",
    "/health/ready",
    "/health/deep",
    "/metrics",
    "/api/status",
    "/docs",
    "/openapi.json",
    "/redoc",
}

EXEMPT_PREFIXES = (
    "/ws",        # WebSocket upgrades
    "/api/onvif",  # Machine-to-machine
    "/api/pacs/badge-read",  # Hardware callbacks
    "/api/alarms/contact-id",  # Alarm panel callbacks
    "/api/iot/",  # IoT sensor data
)

MUTATION_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
CSRF_COOKIE_NAME = "sentinel_csrf"
CSRF_HEADER_NAME = "x-csrf-token"
TOKEN_LENGTH = 32


class CSRFProtectionMiddleware(BaseHTTPMiddleware):
    """Double-submit cookie CSRF protection."""

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path

        # Skip exempt paths
        if path in EXEMPT_PATHS or path.startswith(EXEMPT_PREFIXES):
            return await call_next(request)

        # Skip WebSocket upgrade requests
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await call_next(request)

        # For GET/HEAD/OPTIONS – set CSRF cookie if not present
        if request.method not in MUTATION_METHODS:
            response = await call_next(request)
            if CSRF_COOKIE_NAME not in request.cookies:
                token = secrets.token_hex(TOKEN_LENGTH)
                response.set_cookie(
                    CSRF_COOKIE_NAME,
                    token,
                    httponly=False,  # Must be readable by JS
                    samesite="strict",
                    secure=request.url.scheme == "https",
                    max_age=86400,
                )
            return response

        # For mutation methods – validate CSRF token
        cookie_token = request.cookies.get(CSRF_COOKIE_NAME)
        header_token = request.headers.get(CSRF_HEADER_NAME)

        if not cookie_token or not header_token:
            logger.warning(
                "CSRF token missing: cookie=%s header=%s path=%s",
                bool(cookie_token),
                bool(header_token),
                path,
            )
            return JSONResponse(
                {"detail": "CSRF token missing"},
                status_code=403,
            )

        if not secrets.compare_digest(cookie_token, header_token):
            logger.warning("CSRF token mismatch on %s", path)
            return JSONResponse(
                {"detail": "CSRF token invalid"},
                status_code=403,
            )

        return await call_next(request)
