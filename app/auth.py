"""Firebase ID-token verification. The browser is never trusted for identity."""
import json
import os
from pathlib import Path

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

# Public web config. Env vars override it so a server can point at another Firebase project.
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
    path = Path(__file__).with_name("firebase_web.json")
    try:
        file_cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        file_cfg = {}
    if not isinstance(file_cfg, dict):
        file_cfg = {}
    out = {}
    for key, env_name in _WEB_KEYS.items():
        value = os.getenv(env_name) or file_cfg.get(key) or ""
        if value:
            out[key] = value
    return out


PROJECT_ID = web_config().get("projectId", "")
# Dev-only bypass: token "dev:<subject>:<email>". Refused unless LUTUNG_ENV=development.
DEV_AUTH = os.getenv("LUTUNG_ENV") == "development" and os.getenv("LUTUNG_DEV_AUTH") == "1"

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
        return {"provider": "dev", "subject": sub, "email": email, "name": email}
    if not PROJECT_ID:
        raise AuthError("auth not configured")
    try:
        # Checks signature, expiry and audience.
        claims = id_token.verify_firebase_token(token, _transport, audience=PROJECT_ID)
    except Exception as e:
        raise AuthError("invalid token") from e
    if claims.get("iss") != f"https://securetoken.google.com/{PROJECT_ID}" or not claims.get("sub"):
        raise AuthError("invalid token")
    return {"provider": "firebase", "subject": claims["sub"], "email": claims.get("email"),
            "name": claims.get("name")}
