from unittest.mock import patch

from app.services.weblab import WeblabSessionError
from tests.helpers import login, make_admin, register


def _create_lab(client, **overrides):
    register(client, "admin", "admin@example.com")
    login(client, "admin")
    make_admin("admin")
    payload = {
        "name": "Arty Z7",
        "description": "FPGA board",
        "backend_url": "http://10.30.70.23:5003",
        "is_public": True,
    }
    payload.update(overrides)
    return client.post("/api/labs", json=payload).json()["id"]


def test_list_labs_includes_new_metadata_fields(client):
    lab_id = _create_lab(client, keywords=["fpga", "xilinx"], features=["feature1"])

    labs = client.get("/api/labs").json()
    created = next(lab for lab in labs if lab["id"] == lab_id)
    assert "backend_url" not in created  # never exposed via the list endpoint
    assert created["is_public"] is True
    assert created["keywords"] == ["fpga", "xilinx"]
    assert created["features"] == ["feature1"]


def test_access_denied_without_active_reservation(client):
    lab_id = _create_lab(client)
    register(client, "user1", "user1@example.com")
    login(client, "user1")

    response = client.get(f"/api/labs/{lab_id}/access")
    assert response.status_code == 403


def test_access_granted_after_joining_free_queue(client):
    lab_id = _create_lab(client)
    register(client, "user1", "user1@example.com")
    login(client, "user1")

    client.post("/api/reservations/queue", json={"lab_id": lab_id})

    # The hardware container's own session-start API isn't reachable from
    # tests (and shouldn't be hit for real here) - only the reservation
    # gate (the part this endpoint is actually responsible for) is under
    # test; the HTTP handshake itself is exercised by start_weblab_session
    # in isolation, not through the real network.
    with patch(
        "app.routers.labs.start_weblab_session",
        return_value="http://10.30.70.23:5003/foo/callback/fake-session-id",
    ) as mock_start:
        response = client.get(f"/api/labs/{lab_id}/access")
    assert response.status_code == 200
    assert response.json()["backend_url"] == "http://10.30.70.23:5003/foo/callback/fake-session-id"
    mock_start.assert_called_once()


def test_access_returns_502_when_hardware_session_start_fails(client):
    lab_id = _create_lab(client)
    register(client, "user1", "user1@example.com")
    login(client, "user1")
    client.post("/api/reservations/queue", json={"lab_id": lab_id})

    with patch(
        "app.routers.labs.start_weblab_session",
        side_effect=WeblabSessionError("Hardware container refused to start a session"),
    ):
        response = client.get(f"/api/labs/{lab_id}/access")
    assert response.status_code == 502


def test_access_denied_while_only_pending_in_queue(client):
    lab_id = _create_lab(client)
    register(client, "user1", "user1@example.com")
    login(client, "user1")
    client.post("/api/reservations/queue", json={"lab_id": lab_id})

    register(client, "user2", "user2@example.com")
    login(client, "user2")
    client.post("/api/reservations/queue", json={"lab_id": lab_id})

    response = client.get(f"/api/labs/{lab_id}/access")
    assert response.status_code == 403
