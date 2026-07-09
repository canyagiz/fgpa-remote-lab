from datetime import datetime, timezone

import httpx

from app.config import settings
from app.models import Lab, User

# Every CT300 hardware container bundles labdiscoverylib (LabsLand's
# WebLab-Deusto-compatible library) and exposes this session-creation REST
# endpoint under its fixed WEBLAB_BASE_URL ('/foo', same on all 4 labs).
# We call it with a plain HTTP request - this backend does not depend on
# or vendor labdiscoverylib/WebLab-Deusto itself, it just speaks the one
# REST call the container already answers.
#
# Without this handshake, redirecting a browser straight at the container's
# root hits its @requires_login guard, which - since no
# WEBLAB_UNAUTHORIZED_LINK is configured for our broker - falls back to the
# library's own generic docs page instead of the real experiment UI.
_SESSION_PATH = "/foo/ldl/sessions/"


class WeblabSessionError(RuntimeError):
    """The hardware container reachable but refused to start a session."""


def start_weblab_session(lab: Lab, user: User, duration_seconds: int, back_url: str) -> str:
    now = datetime.now(timezone.utc)
    response = httpx.post(
        f"{lab.backend_url}{_SESSION_PATH}",
        auth=(settings.weblab_username, settings.weblab_password),
        json={
            "request": {
                "locale": "en",
                "ldeReservationId": f"fgpa-remote-lab-{user.id}-{lab.id}-{int(now.timestamp())}",
                "user": {},
                "server": {},
                "backUrl": back_url,
            },
            "laboratory": {"name": lab.name},
            "user": {
                "username": user.username,
                "unique": f"user-{user.id}",
                "fullName": user.username,
            },
            "schedule": {
                "start": now.isoformat(),
                "length": duration_seconds,
            },
        },
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()
    if "url" not in data:
        raise WeblabSessionError(data.get("message", "Hardware container refused to start a session"))
    return data["url"]
