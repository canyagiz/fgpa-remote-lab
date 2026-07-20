from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User, UserRole


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Resolve identity strictly from the server-side session cookie.

    This is the direct fix for the old repo's model where every request
    carried a client-supplied `userId` field with no server-side check.
    """
    user_id = request.session.get("user_id")
    session_token = request.session.get("session_token")
    if user_id is None or session_token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    user = db.get(User, user_id)
    if user is None:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    # Single active session per account: logging in from another device
    # overwrites user.active_session_token (see routers/auth.py), which
    # makes every other browser's cookie mismatch here on its very next
    # request - it gets logged out rather than continuing to run side by
    # side with the new session.
    if user.active_session_token != session_token:
        request.session.clear()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your account was signed in from another device. Please log in again.",
        )

    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != UserRole.admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin privileges required")
    return user
