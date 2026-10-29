import httpx
from httpx import ASGITransport

import version
from main import app


async def _get(path):
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        return await c.get(path)


def _tuple(v: str):
    return tuple(int(p) for p in v.split("."))


async def test_version_endpoint_reports_versions():
    r = await _get("/version")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"version", "latest", "min_supported_version"}
    assert body["version"] == version.APP_VERSION == body["latest"]


async def test_min_supported_is_not_newer_than_the_server():
    r = await _get("/version")
    body = r.json()
    assert _tuple(body["min_supported_version"]) <= _tuple(body["version"])


async def test_min_supported_version_can_be_overridden(monkeypatch):
    monkeypatch.setenv("KANBAN_MIN_UI_VERSION", "9.9.9")
    r = await _get("/version")
    assert r.json()["min_supported_version"] == "9.9.9"


def test_server_version_matches_the_desktop_and_ui_packages():
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    for package in ("desktop", "ui"):
        pkg = json.loads((root / package / "package.json").read_text())
        assert pkg["version"] == version.APP_VERSION, (
            f"{package}/package.json is out of sync with server/version.py"
        )
