import subprocess
from collections.abc import AsyncGenerator

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from main import app
from services import git_repo

test_engine = create_async_engine(
    "sqlite+aiosqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
test_async_session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db():
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    app.dependency_overrides[get_session] = override_get_session
    yield
    app.dependency_overrides.pop(get_session, None)
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def repo_dir(tmp_path):
    def git(*args):
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-b", "main")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "Tester")
    (tmp_path / "a.txt").write_text("a")
    git("add", ".")
    git("commit", "-m", "init")
    return tmp_path


async def _project_with_repo(c: httpx.AsyncClient, repo_dir) -> dict:
    p = (await c.post("/projects", json={"name": "G", "prefix": "GIT", "color": "#123456"})).json()
    r = await c.patch(f"/projects/{p['id']}", json={"repo_path": str(repo_dir)})
    assert r.status_code == 200
    assert r.json()["repo_path"] == str(repo_dir.resolve())
    return p


async def test_link_rejects_non_repo(client: httpx.AsyncClient, tmp_path):
    async with client as c:
        p = (await c.post("/projects", json={"name": "G", "prefix": "GIT", "color": "#123456"})).json()
        r = await c.patch(f"/projects/{p['id']}", json={"repo_path": str(tmp_path)})
        assert r.status_code == 400


async def test_create_branch_creates_real_git_branch(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        p = await _project_with_repo(c, repo_dir)
        t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()
        r = await c.post(f"/tickets/{t['id']}/branches", json={"name": "feature/x", "branch_from": "main"})
        assert r.status_code == 201
        br = r.json()["branches"][0]
        assert br["commit_hash"] and br["ahead_count"] == 0 and br["behind_count"] == 0
        assert "feature/x" in git_repo.list_local_branches(git_repo.open_repo(str(repo_dir)))

        # Duplicate and invalid names are rejected
        assert (await c.post(f"/tickets/{t['id']}/branches", json={"name": "feature/x"})).status_code == 400
        assert (await c.post(f"/tickets/{t['id']}/branches", json={"name": "bad name..x"})).status_code == 400
        assert (await c.post(f"/tickets/{t['id']}/branches", json={"name": "y", "branch_from": "nope"})).status_code == 400


async def test_list_branches_reports_live_ahead_behind(client: httpx.AsyncClient, repo_dir):
    def git(*args):
        subprocess.run(["git", *args], cwd=repo_dir, check=True, capture_output=True)

    async with client as c:
        p = await _project_with_repo(c, repo_dir)
        t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()
        await c.post(f"/tickets/{t['id']}/branches", json={"name": "feature/x"})

        git("checkout", "feature/x")
        (repo_dir / "b.txt").write_text("b")
        git("add", ".")
        git("commit", "-m", "on branch")
        git("checkout", "main")
        (repo_dir / "c.txt").write_text("c")
        git("add", ".")
        git("commit", "-m", "on main")

        br = (await c.get(f"/tickets/{t['id']}/branches")).json()[0]
        assert br["ahead_count"] == 1
        assert br["behind_count"] == 1


async def test_branches_without_repo_stay_db_only(client: httpx.AsyncClient):
    async with client as c:
        p = (await c.post("/projects", json={"name": "G", "prefix": "GIT", "color": "#123456"})).json()
        t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()
        r = await c.post(f"/tickets/{t['id']}/branches", json={"name": "feature/x", "ahead_count": 3})
        assert r.status_code == 201
        assert r.json()["branches"][0]["ahead_count"] == 3
