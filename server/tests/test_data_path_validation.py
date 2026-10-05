"""POST /settings/data-path must only accept folders inside the user's home directory."""
import httpx
import pytest
from httpx import ASGITransport

from main import app


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr("pathlib.Path.home", classmethod(lambda cls: home))
    return home


async def _post(client, path):
    async with client as c:
        return await c.post("/settings/data-path", json={"path": path})


async def test_rejects_a_folder_outside_home(client, fake_home, tmp_path):
    r = await _post(client, str(tmp_path / "elsewhere"))
    assert r.status_code == 400
    assert "home directory" in r.json()["detail"]


async def test_rejects_dot_dot_escape(client, fake_home):
    r = await _post(client, str(fake_home / "data" / ".." / ".." / "escaped"))
    assert r.status_code == 400


async def test_rejects_a_sibling_whose_name_starts_with_the_home_name(client, fake_home):
    r = await _post(client, str(fake_home) + "-other/data")
    assert r.status_code == 400


async def test_rejects_a_symlink_that_points_outside_home(client, fake_home, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (fake_home / "link").symlink_to(outside)
    r = await _post(client, str(fake_home / "link" / "data"))
    assert r.status_code == 400


async def test_rejects_an_empty_path(client, fake_home):
    assert (await _post(client, "   ")).status_code == 400
