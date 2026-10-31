"""Firebase ID-token verification. The browser is never trusted for identity."""
import os

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

_WEB_KEYS = {
    "apiKey": "FIREBASE_API_KEY",
    "authDomain": "FIREBASE_AUTH_DOMAIN",
    "projectId": "FIREBASE_PROJECT_ID",
    "storageBucket": "FIREBASE_STORAGE_BUCKET",
    "messagingSenderId": "FIREBASE_MESSAGING_SENDER_ID",
    "appId": "FIREBASE_APP_ID",
    "measurementId": "FIREBASE_MEASUREMENT_ID",
}


def web_config():
    """Return the public Firebase web config supplied by the server environment."""
    return {
        key: value
        for key, env_name in _WEB_KEYS.items()
        if (value := os.getenv(env_name, ""))
    }


PROJECT_ID = web_config().get("projectId", "")
# Dev-only bypass: token "dev:<subject>:<email>". Refused unless LUTUNG_ENV=development.
DEV_AUTH = os.getenv("LUTUNG_ENV") == "development" and os.getenv("LUTUNG_DEV_AUTH") == "1"


def admin_emails():
    """Verified Google addresses that skip the one-trial playground cap. Read per call so tests can override."""
    return {part.strip().lower() for part in os.getenv("LUTUNG_ADMIN_EMAILS", "").split(",") if part.strip()}


def is_admin(ident):
    """True only for an allowlisted address that Firebase has verified via Google sign-in."""
    email = (ident.get("email") or "").strip().lower()
    if not email or email not in admin_emails():
        return False
    if ident.get("provider") == "dev":
        return DEV_AUTH
    return bool(ident.get("email_verified")) and ident.get("sign_in_provider") == "google.com"

# ponytail: cert fetch per verification (~100 ms); add a cached session if sign-in traffic grows.
_transport = google_requests.Request()


class AuthError(Exception):
    pass


def verify(authorization_header):
    """Return {'provider','subject','email','name'} or raise AuthError."""
    if not authorization_header or not authorization_header.startswith("Bearer "):
        raise AuthError("missing token")
    token = authorization_header[7:].strip()
    if DEV_AUTH and token.startswith("dev:"):
        _, sub, email = (token.split(":", 2) + ["", ""])[:3]
        if not sub:
            raise AuthError("bad dev token")
        return {"provider": "dev", "subject": sub, "email": email, "name": email,
                "email_verified": True, "sign_in_provider": "dev"}
    if not PROJECT_ID:
        raise AuthError("auth not configured")
    try:
        # Checks signature, expiry and audience.
        claims = id_token.verify_firebase_token(token, _transport, audience=PROJECT_ID)
    except Exception as e:
        raise AuthError("invalid token") from e
    if claims.get("iss") != f"https://securetoken.google.com/{PROJECT_ID}" or not claims.get("sub"):
        raise AuthError("invalid token")
    firebase_claims = claims.get("firebase") or {}
    return {"provider": "firebase", "subject": claims["sub"], "email": claims.get("email"),
            "name": claims.get("name"), "email_verified": bool(claims.get("email_verified")),
            "sign_in_provider": firebase_claims.get("sign_in_provider") or ""}
