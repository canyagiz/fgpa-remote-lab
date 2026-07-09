from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user, require_admin
from app.models import Lab, Reservation, ReservationStatus, User
from app.schemas import LabAccessOut, LabCreate, LabOut
from app.services.weblab import WeblabSessionError, start_weblab_session

router = APIRouter(prefix="/labs", tags=["labs"])


def _to_out(lab: Lab, queue_count: int) -> LabOut:
    return LabOut(
        id=lab.id,
        name=lab.name,
        description=lab.description,
        status=lab.status,
        queue_count=queue_count,
        image_url=lab.image_url,
        keywords=lab.keywords,
        features=lab.features,
        is_public=lab.is_public,
    )


@router.get("", response_model=list[LabOut])
def list_labs(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    rows = db.execute(
        select(
            Lab,
            func.count(Reservation.id).filter(Reservation.status == ReservationStatus.pending).label(
                "queue_count"
            ),
        )
        .outerjoin(Reservation, Reservation.lab_id == Lab.id)
        .group_by(Lab.id)
        .order_by(Lab.id)
    ).all()

    return [_to_out(lab, queue_count or 0) for lab, queue_count in rows]


@router.post("", response_model=LabOut, status_code=201)
def create_lab(payload: LabCreate, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    # require_admin checks the role server-side - the old repo only hid the
    # "create lab" button in the UI and never verified this on the backend.
    lab = Lab(
        name=payload.name,
        description=payload.description,
        image_url=payload.image_url,
        backend_url=payload.backend_url,
        keywords=payload.keywords,
        features=payload.features,
        is_public=payload.is_public,
    )
    db.add(lab)
    db.commit()
    db.refresh(lab)
    return _to_out(lab, 0)


@router.get("/{lab_id}/access", response_model=LabAccessOut)
def access_lab(
    lab_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    lab = db.get(Lab, lab_id)
    if lab is None or lab.backend_url is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lab not found")

    reservation = db.scalar(
        select(Reservation).where(
            Reservation.lab_id == lab_id,
            Reservation.user_id == user.id,
            Reservation.status == ReservationStatus.active,
        )
    )
    if reservation is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You need an active reservation to access this lab",
        )

    if reservation.usage_start_time is not None:
        elapsed = (datetime.utcnow() - reservation.usage_start_time).total_seconds()
    else:
        elapsed = 0
    remaining = max(int(settings.session_duration_seconds - elapsed), 30)
    back_url = f"{str(request.base_url).rstrip('/')}/labs"

    try:
        session_url = start_weblab_session(lab, user, duration_seconds=remaining, back_url=back_url)
    except (httpx.HTTPError, WeblabSessionError) as err:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Could not start a session on the lab hardware: {err}"
        )

    return LabAccessOut(backend_url=session_url)
