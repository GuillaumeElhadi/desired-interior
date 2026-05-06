import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


# Test-only route that triggers the unhandled exception handler.
@app.get("/_test_crash")
async def _test_crash() -> None:
    raise RuntimeError("deliberate test crash")


@pytest.mark.asyncio
async def test_unhandled_exception_returns_structured_json() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/_test_crash")
    assert response.status_code == 500
    data = response.json()
    assert data["error"] == "internal_server_error"
    assert "request_id" in data
    assert "message" in data


@pytest.mark.asyncio
async def test_response_includes_request_id_header() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health")
    assert "x-request-id" in response.headers


@pytest.mark.asyncio
async def test_logs_endpoint_accepts_entries() -> None:
    payload = {
        "entries": [
            {
                "level": "error",
                "message": "test error from frontend",
                "correlation_id": "abc-123",
                "timestamp": "2024-01-01T00:00:00Z",
                "context": {"component": "App"},
            }
        ]
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/logs", json=payload)
    assert response.status_code == 204


@pytest.mark.asyncio
async def test_logs_endpoint_rejects_invalid_level() -> None:
    payload = {
        "entries": [
            {
                "level": "INVALID",
                "message": "bad level",
                "correlation_id": "abc-123",
                "timestamp": "2024-01-01T00:00:00Z",
                "context": {},
            }
        ]
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/logs", json=payload)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_logs_endpoint_accepts_all_levels() -> None:
    payload = {
        "entries": [
            {
                "level": level,
                "message": f"test {level}",
                "correlation_id": "abc-123",
                "timestamp": "2024-01-01T00:00:00Z",
                "context": {},
            }
            for level in ("debug", "info", "warn", "error")
        ]
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/logs", json=payload)
    assert response.status_code == 204
