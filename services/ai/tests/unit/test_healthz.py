from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz_ok() -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "erase-ai"}


def test_no_public_docs() -> None:
    # The service is private and exposes no schema browser.
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
