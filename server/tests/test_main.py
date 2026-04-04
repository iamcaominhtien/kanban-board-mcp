import httpx
from httpx import ASGITransport

from main import app


async def test_health_returns_ok() -> None:
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_mcp_endpoint_is_reachable() -> None:
    """GET /mcp must not return 404 — a protocol response or 405 is acceptable."""
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/mcp")

    assert response.status_code != 404, (
        f"/mcp returned 404 — mount path misconfigured. Got: {response.status_code}"
    )
