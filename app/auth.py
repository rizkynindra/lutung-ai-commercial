"""Firebase (Google sign-in) ID-token verification. The browser is never trusted for identity."""
import os

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "")
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
