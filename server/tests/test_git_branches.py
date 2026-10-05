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


async def _branch(c, t, name):
    r = await c.post(f"/tickets/{t['id']}/branches", json={"name": name})
    assert r.status_code == 201
    return [b for b in r.json()["branches"] if b["name"] == name][0]["id"]


def _commit_on(repo_dir, branch, fname):
    _git(repo_dir, "checkout", "-q", branch)
    (repo_dir / fname).write_text(fname)
    _git(repo_dir, "add", ".")
    _git(repo_dir, "commit", "-qm", fname)
    _git(repo_dir, "checkout", "-q", "main")


async def test_mark_merged_is_verified_against_git(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        bid = await _branch(c, t, "feat/m")
        _commit_on(repo_dir, "feat/m", "m.txt")
        # not merged in git yet -> refused, board unchanged
        r = await c.patch(f"/tickets/{t['id']}/branches/{bid}", json={"status": "merged"})
        assert r.status_code == 400 and "not in 'main'" in r.json()["detail"]
        assert (await c.get(f"/tickets/{t['id']}/branches")).json()[0]["status"] == "open"
        # merge in git, then marking merged is accepted
        _git(repo_dir, "merge", "-q", "--no-ff", "feat/m", "-m", "merge")
        r = await c.patch(f"/tickets/{t['id']}/branches/{bid}", json={"status": "merged"})
        assert r.status_code == 200 and r.json()["branches"][0]["status"] == "merged"


async def test_rename_branch_renames_in_git(client: httpx.AsyncClient, repo_dir):
    repo = git_repo.open_repo(str(repo_dir))
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        bid = await _branch(c, t, "feat/old")
        await _branch(c, t, "feat/taken")
        # name collision is refused and nothing changes
        r = await c.patch(f"/tickets/{t['id']}/branches/{bid}", json={"name": "feat/taken"})
        assert r.status_code == 400
        r = await c.patch(f"/tickets/{t['id']}/branches/{bid}", json={"name": "feat/new"})
        assert r.status_code == 200
        names = git_repo.list_local_branches(repo)
        assert "feat/new" in names and "feat/old" not in names
        assert [b["name"] for b in (await c.get(f"/tickets/{t['id']}/branches")).json()][0] == "feat/new"


async def test_checkout_branch(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        bid = await _branch(c, t, "feat/co")
        branches = (await c.get(f"/tickets/{t['id']}/branches")).json()
        assert branches[0]["is_current"] is False

        # dirty working tree -> refused, HEAD stays on main
        (repo_dir / "a.txt").write_text("changed")
        r = await c.post(f"/tickets/{t['id']}/branches/{bid}/checkout")
        assert r.status_code == 400 and "uncommitted" in r.json()["detail"]
        assert _git(repo_dir, "branch", "--show-current").strip() == "main"

        _git(repo_dir, "checkout", "--", "a.txt")
        r = await c.post(f"/tickets/{t['id']}/branches/{bid}/checkout")
        assert r.status_code == 200
        assert _git(repo_dir, "branch", "--show-current").strip() == "feat/co"
        assert (await c.get(f"/tickets/{t['id']}/branches")).json()[0]["is_current"] is True


def _commit(repo_dir, fname, branch=None):
    if branch:
        _git(repo_dir, "checkout", "-q", branch)
    (repo_dir / fname).write_text(fname)
    _git(repo_dir, "add", ".")
    _git(repo_dir, "commit", "-qm", f"add {fname}")


def _assert_no_lane_overlap(commits):
    """No commit may sit on a lane that another edge is still running through."""
    row = {c["hash"]: i for i, c in enumerate(commits)}
    for i, c in enumerate(commits):
        for idx, ph in enumerate(c["parents"]):
            if ph not in row:
                continue
            lane = c["lane"] if idx == 0 else commits[row[ph]]["lane"]
            if lane == 0:
                continue
            for r in range(i + 1, row[ph]):
                assert commits[r]["lane"] != lane, (
                    f"{commits[r]['subject']} overlaps edge {c['subject']} -> {commits[row[ph]]['subject']}"
                )


async def test_graph_without_repo_is_not_linked(client: httpx.AsyncClient):
    async with client as c:
        p = (await c.post("/projects", json={"name": "G", "prefix": "GIT", "color": "#123456"})).json()
        t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()
        g = (await c.get(f"/tickets/{t['id']}/graph")).json()
        assert g["linked"] is False and g["commits"] == []


async def test_graph_shows_real_history_with_multiple_merges_and_branches(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        for name in ("feat/a", "feat/b", "feat/c"):
            await _branch(c, t, name)
        # feat/a: 2 commits, stays open
        _commit(repo_dir, "a1.txt", "feat/a")
        _commit(repo_dir, "a2.txt")
        # feat/b: merged into main (branch kept), then main moves on
        _commit(repo_dir, "b1.txt", "feat/b")
        _git(repo_dir, "checkout", "-q", "main")
        _git(repo_dir, "merge", "-q", "--no-ff", "feat/b", "-m", "merge b")
        _commit(repo_dir, "m1.txt")
        # feat/c: merged then branch deleted from git
        _commit(repo_dir, "c1.txt", "feat/c")
        _git(repo_dir, "checkout", "-q", "main")
        _git(repo_dir, "merge", "-q", "--no-ff", "feat/c", "-m", "merge c")
        _git(repo_dir, "branch", "-D", "feat/c")

        g = (await c.get(f"/tickets/{t['id']}/graph")).json()
        assert g["linked"] is True and g["base"] == "main"
        by_subject = {x["subject"]: x for x in g["commits"]}
        # mainline commits sit on lane 0, side work on lanes >= 1
        for s in ("init", "merge b", "add m1.txt", "merge c"):
            assert by_subject[s]["lane"] == 0, s
        for s in ("add a1.txt", "add a2.txt", "add b1.txt", "add c1.txt"):
            assert by_subject[s]["lane"] >= 1, s
        # both merges are real two-parent commits
        assert len(by_subject["merge b"]["parents"]) == 2 and len(by_subject["merge c"]["parents"]) == 2
        # open branch commits are attributed to feat/a; merged work is no longer 'exclusive'
        assert by_subject["add a2.txt"]["ticket_branches"] == ["feat/a"]
        assert by_subject["add b1.txt"]["ticket_branches"] == []
        # tips carry their ref labels, HEAD on main
        assert any(r["name"] == "feat/a" for r in by_subject["add a2.txt"]["refs"])
        assert any(r["name"] == "HEAD" for r in by_subject["merge c"]["refs"])
        assert g["lane_count"] >= 2
        _assert_no_lane_overlap(g["commits"])


async def test_graph_window_reaches_back_to_branch_fork(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        await _branch(c, t, "feat/old")
        _commit(repo_dir, "o1.txt", "feat/old")
        _git(repo_dir, "checkout", "-q", "main")
        for i in range(30):
            _commit(repo_dir, f"main{i}.txt")
        g = (await c.get(f"/tickets/{t['id']}/graph", params={"limit": 5})).json()
        subjects = [x["subject"] for x in g["commits"]]
        # window grew past limit=5 so the branch and its fork point are both present
        assert "add o1.txt" in subjects and "init" in subjects
        assert len(g["commits"]) >= 32


async def test_graph_limit_truncates_when_branch_forked_recently(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        for i in range(12):
            _commit(repo_dir, f"main{i}.txt")
        await _branch(c, t, "feat/new")  # forks at the current tip
        _commit(repo_dir, "n1.txt", "feat/new")
        _git(repo_dir, "checkout", "-q", "main")
        g = (await c.get(f"/tickets/{t['id']}/graph", params={"limit": 5})).json()
        assert len(g["commits"]) == 5 and g["truncated"] is True


async def test_commit_detail_message_and_file_changes(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        # root commit: a.txt added
        root = _git(repo_dir, "rev-parse", "HEAD").strip()
        d = (await c.get(f"/tickets/{t['id']}/commits/{root}")).json()
        assert d["subject"] == "init" and d["body"] == "" and d["parents"] == []
        assert [(f["status"], f["path"]) for f in d["files"]] == [("A", "a.txt")]

        # modify + add + delete + rename + binary in one multi-line commit
        (repo_dir / "a.txt").write_text("a\nline2\nline3\n")
        (repo_dir / "new.txt").write_text("n1\nn2\n")
        (repo_dir / "gone.txt").write_text("x")
        _git(repo_dir, "add", ".")
        _git(repo_dir, "commit", "-qm", "seed")
        _git(repo_dir, "rm", "-q", "gone.txt")
        _git(repo_dir, "mv", "new.txt", "renamed.txt")
        (repo_dir / "img.bin").write_bytes(b"\x00\x01\x02\x03")
        _git(repo_dir, "add", ".")
        _git(repo_dir, "commit", "-q", "-m", "Big change", "-m", "Body paragraph one.\n\nSecond paragraph.")
        sha = _git(repo_dir, "rev-parse", "HEAD").strip()
        d = (await c.get(f"/tickets/{t['id']}/commits/{sha[:10]}")).json()  # short hash works
        assert d["hash"] == sha and d["subject"] == "Big change"
        assert d["body"] == "Body paragraph one.\n\nSecond paragraph."
        assert d["author"] == "Tester" and d["author_email"] == "t@example.com"
        by = {f["path"]: f for f in d["files"]}
        assert by["gone.txt"]["status"] == "D"
        assert by["renamed.txt"]["status"] == "R" and by["renamed.txt"]["old_path"] == "new.txt"
        assert by["img.bin"]["binary"] is True and by["img.bin"]["additions"] == 0
        assert d["file_count"] == 3 and d["files_truncated"] is False

        # the earlier 'seed' commit reports line counts
        seed = _git(repo_dir, "rev-parse", "HEAD~1").strip()
        s = (await c.get(f"/tickets/{t['id']}/commits/{seed}")).json()
        a = {f["path"]: f for f in s["files"]}
        # "a" (no trailing newline) became "a\nline2\nline3\n": git counts +3 -1
        assert a["a.txt"]["status"] == "M" and a["a.txt"]["additions"] == 3 and a["a.txt"]["deletions"] == 1
        assert a["new.txt"]["additions"] == 2 and a["gone.txt"]["additions"] == 1
        assert s["additions"] == 6 and s["deletions"] == 1


async def test_commit_detail_merge_uses_first_parent_and_validates_input(client: httpx.AsyncClient, repo_dir):
    async with client as c:
        t = await _ticket_with_repo(c, repo_dir)
        await _branch(c, t, "feat/mm")
        _commit(repo_dir, "side.txt", "feat/mm")
        _git(repo_dir, "checkout", "-q", "main")
        _git(repo_dir, "merge", "-q", "--no-ff", "feat/mm", "-m", "merge side")
        sha = _git(repo_dir, "rev-parse", "HEAD").strip()
        d = (await c.get(f"/tickets/{t['id']}/commits/{sha}")).json()
        assert len(d["parents"]) == 2
        assert [(f["status"], f["path"]) for f in d["files"]] == [("A", "side.txt")]

        assert (await c.get(f"/tickets/{t['id']}/commits/not-a-hash")).status_code == 400
        assert (await c.get(f"/tickets/{t['id']}/commits/{'0' * 40}")).status_code == 400
        assert (await c.get(f"/tickets/{t['id']}/commits/--output=x")).status_code in (400, 404)


async def test_commit_detail_requires_linked_repo(client: httpx.AsyncClient):
    async with client as c:
        p = (await c.post("/projects", json={"name": "G", "prefix": "GIT", "color": "#123456"})).json()
        t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "x"})).json()
        assert (await c.get(f"/tickets/{t['id']}/commits/abcdef1")).status_code == 400
