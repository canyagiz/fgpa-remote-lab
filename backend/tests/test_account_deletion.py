"""Self-service account deletion from the profile page."""

from tests.helpers import login, register


def _user_row(username):
    from app.database import SessionLocal
    from app.models import User

    db = SessionLocal()
    try:
        return db.query(User).filter(User.username == username).first()
    finally:
        db.close()


def test_delete_own_account_with_correct_password(client):
    register(client, "alice", "alice@example.com")
    login(client, "alice")

    resp = client.request("DELETE", "/api/profile", json={"password": "Password123"})
    assert resp.status_code == 200, resp.text
    assert _user_row("alice") is None

    # session is cleared - a follow-up authed call is now unauthorized
    assert client.get("/api/auth/me").status_code == 401


def test_delete_requires_correct_password(client):
    register(client, "bob", "bob@example.com")
    login(client, "bob")

    resp = client.request("DELETE", "/api/profile", json={"password": "wrongpass"})
    assert resp.status_code == 401
    assert _user_row("bob") is not None  # still there


def test_delete_requires_authentication(client):
    client.cookies.clear()
    resp = client.request("DELETE", "/api/profile", json={"password": "whatever"})
    assert resp.status_code == 401


def test_delete_removes_reservation_history(client):
    # make a lab as admin, then use it as bob, then bob deletes himself
    register(client, "root", "root@example.com")
    login(client, "root")
    lab_id = client.post("/api/labs", json={"name": "Arty Z7", "description": "board"}).json()["id"]

    register(client, "bob", "bob@example.com")
    bob_id = login(client, "bob")
    client.post("/api/reservations/access-now", json={"lab_id": lab_id})

    from app.database import SessionLocal
    from app.models import Reservation

    db = SessionLocal()
    try:
        assert db.query(Reservation).filter(Reservation.user_id == bob_id).count() == 1
    finally:
        db.close()

    resp = client.request("DELETE", "/api/profile", json={"password": "Password123"})
    assert resp.status_code == 200, resp.text

    db = SessionLocal()
    try:
        # user gone AND their reservations gone (no FK violation, hard delete)
        assert db.query(Reservation).filter(Reservation.user_id == bob_id).count() == 0
    finally:
        db.close()
    assert _user_row("bob") is None


def test_delete_removes_a_filled_in_profile(client):
    """Regression test: a filled-in UserProfile used to make this 500 -
    SQLAlchemy tried to null out user_profiles.user_id before deleting the
    user, which fails since that column is NOT NULL (see
    models.py::User.profile's passive_deletes=True fix)."""
    register(client, "carol", "carol@example.com")
    login(client, "carol")
    resp = client.put("/api/profile", json={"full_name": "Carol Danvers", "is_public": True})
    assert resp.status_code == 200, resp.text

    resp = client.request("DELETE", "/api/profile", json={"password": "Password123"})
    assert resp.status_code == 200, resp.text
    assert _user_row("carol") is None

    from app.database import SessionLocal
    from app.models import UserProfile

    db = SessionLocal()
    try:
        assert db.query(UserProfile).filter(UserProfile.full_name == "Carol Danvers").first() is None
    finally:
        db.close()


def test_admin_delete_also_removes_a_filled_in_profile(client):
    """Same regression, via the admin panel's delete instead of self-delete."""
    register(client, "root", "root@example.com")
    login(client, "root")
    register(client, "dave", "dave@example.com")
    dave_id = login(client, "dave")
    client.put("/api/profile", json={"full_name": "Dave Lister", "is_public": True})

    login(client, "root")
    resp = client.delete(f"/api/admin/users/{dave_id}")
    assert resp.status_code == 200, resp.text
    assert _user_row("dave") is None
