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


async def test_ticket_repo_overrides_project_repo(client: httpx.AsyncClient, repo_dir, tmp_path_factory):
    other = tmp_path_factory.mktemp("other")
    for args in (["init", "-b", "main"], ["config", "user.email", "t@e.com"], ["config", "user.name", "T"]):
        subprocess.run(["git", *args], cwd=other, check=True, capture_output=True)
    (other / "z.txt").write_text("z")
    subprocess.run(["git", "add", "."], cwd=other, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=other, check=True, capture_output=True)

    async with client as c:
        p = await _project_with_repo(c, repo_dir)
        t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()
        assert t["repo_path"] is None  # inherits from project

        # Invalid override is rejected
        bad = await c.patch(f"/tickets/{t['id']}", json={"repo_path": str(repo_dir / "nope")})
        assert bad.status_code in (400, 422)

        r = await c.patch(f"/tickets/{t['id']}", json={"repo_path": str(other)})
        assert r.status_code == 200 and r.json()["repo_path"] == str(other.resolve())
        await c.post(f"/tickets/{t['id']}/branches", json={"name": "only-in-other"})
        assert "only-in-other" in git_repo.list_local_branches(git_repo.open_repo(str(other)))
        assert "only-in-other" not in git_repo.list_local_branches(git_repo.open_repo(str(repo_dir)))

        # Clearing the override falls back to the project repo
        r = await c.patch(f"/tickets/{t['id']}", json={"repo_path": ""})
        assert r.json()["repo_path"] is None
        await c.post(f"/tickets/{t['id']}/branches", json={"name": "in-project"})
        assert "in-project" in git_repo.list_local_branches(git_repo.open_repo(str(repo_dir)))


async def test_branch_missing_from_repo_is_flagged(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        p = await _project_with_repo(c, repo_dir)
        t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()
        await c.post(f"/tickets/{t['id']}/branches", json={"name": "feature/x"})
        subprocess.run(["git", "branch", "-D", "feature/x"], cwd=repo_dir, check=True, capture_output=True)
        assert (await c.get(f"/tickets/{t['id']}/branches")).json()[0]["in_repo"] is False


async def test_project_worktree_settings(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        p = await _project_with_repo(c, repo_dir)
        r = await c.patch(
            f"/projects/{p['id']}",
            json={
                "worktree_template": "../worktrees/{project}/{ticket_id}-{branch}",
                "worktree_by_default": True,
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert data["worktree_template"] == "../worktrees/{project}/{ticket_id}-{branch}"
        assert data["worktree_by_default"] is True


async def test_create_branch_with_worktree(client: httpx.AsyncClient, repo_dir, tmp_path):
    async with client as c:
        p = await _project_with_repo(c, repo_dir)
        wt_base = tmp_path / "custom_worktrees"
        await c.patch(
            f"/projects/{p['id']}",
            json={"worktree_template": str(wt_base / "{branch}")},
        )
        t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()

        # Create branch with worktree
        r = await c.post(
            f"/tickets/{t['id']}/branches",
            json={"name": "feature/worktree-test", "create_worktree": True},
        )
        assert r.status_code == 201
        br = r.json()["branches"][0]
        assert br["worktree_path"] is not None
        assert (wt_base / "feature-worktree-test").exists()

        # Delete branch with remove_worktree=true
        del_r = await c.delete(
            f"/tickets/{t['id']}/branches/{br['id']}?remove_worktree=true"
        )
        assert del_r.status_code == 200
        assert not (wt_base / "feature-worktree-test").exists()


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


async def _ticket_with_repo(c, repo_dir):
    p = await _project_with_repo(c, repo_dir)
    return (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()


async def test_failed_worktree_rolls_back_branch(client: httpx.AsyncClient, repo_dir, tmp_path):
    taken = tmp_path / "taken"
    taken.mkdir()
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        r = await c.post(
            f"/tickets/{t['id']}/branches",
            json={"name": "feat/b", "create_worktree": True, "worktree_path": str(taken)},
        )
        assert r.status_code == 400
        assert "feat/b" not in git_repo.list_local_branches(git_repo.open_repo(str(repo_dir)))
        # retrying with a free path now works (no orphan branch blocking the name)
        ok = await c.post(
            f"/tickets/{t['id']}/branches",
            json={"name": "feat/b", "create_worktree": True, "worktree_path": str(tmp_path / "free")},
        )
        assert ok.status_code == 201 and (tmp_path / "free").is_dir()


async def test_worktree_requires_linked_repo(client: httpx.AsyncClient):
    async with client as c:
        p = (await c.post("/projects", json={"name": "G", "prefix": "GIT", "color": "#123456"})).json()
        t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()
        r = await c.post(
            f"/tickets/{t['id']}/branches",
            json={"name": "feat/c", "create_worktree": True, "worktree_path": "/tmp/nowhere-xyz"},
        )
        assert r.status_code == 400
        assert (await c.get(f"/tickets/{t['id']}/branches")).json() == []


async def test_worktree_removal_failure_is_not_hidden(client: httpx.AsyncClient, repo_dir, tmp_path):
    wt = tmp_path / "wt"
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        r = await c.post(
            f"/tickets/{t['id']}/branches",
            json={"name": "feat/d", "create_worktree": True, "worktree_path": str(wt)},
        )
        bid = r.json()["branches"][0]["id"]
        # make the worktree impossible to remove: a locked worktree refuses even --force once
        _git(repo_dir, "worktree", "lock", str(wt))
        res = await c.patch(f"/tickets/{t['id']}/branches/{bid}", json={"status": "merged", "remove_worktree": True})
        assert res.status_code == 400
        br = (await c.get(f"/tickets/{t['id']}/branches")).json()[0]
        assert br["worktree_path"] and br["status"] == "open"  # board unchanged
        _git(repo_dir, "worktree", "unlock", str(wt))


async def test_delete_branch_can_also_delete_git_branch(client: httpx.AsyncClient, repo_dir, tmp_path):
    repo = git_repo.open_repo(str(repo_dir))
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        r = await c.post(f"/tickets/{t['id']}/branches", json={"name": "feat/e"})
        bid = r.json()["branches"][0]["id"]
        # default: board record removed, git branch kept
        await c.post(f"/tickets/{t['id']}/branches", json={"name": "feat/keep"})
        keep_id = [b for b in (await c.get(f"/tickets/{t['id']}/branches")).json() if b["name"] == "feat/keep"][0]["id"]
        assert (await c.delete(f"/tickets/{t['id']}/branches/{keep_id}")).status_code == 200
        assert "feat/keep" in git_repo.list_local_branches(repo)

        # unmerged work: safe delete refuses and leaves the board record in place
        _git(repo_dir, "checkout", "-q", "feat/e")
        (repo_dir / "n.txt").write_text("n")
        _git(repo_dir, "add", ".")
        _git(repo_dir, "commit", "-qm", "unmerged")
        _git(repo_dir, "checkout", "-q", "main")
        res = await c.delete(f"/tickets/{t['id']}/branches/{bid}", params={"delete_git_branch": True})
        assert res.status_code == 400 and "not fully merged" in res.json()["detail"]
        assert len((await c.get(f"/tickets/{t['id']}/branches")).json()) == 1
        assert "feat/e" in git_repo.list_local_branches(repo)

        # force removes both
        res = await c.delete(
            f"/tickets/{t['id']}/branches/{bid}", params={"delete_git_branch": True, "force": True}
        )
        assert res.status_code == 200
        assert "feat/e" not in git_repo.list_local_branches(repo)
