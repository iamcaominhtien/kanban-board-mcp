"""Where an AI works and how its code is handed over (design/screens/ai-operations.md I, J, K; D4–D7), against real
git repositories in a temporary folder: one worktree per ticket beside the repo, its own port, the member's
configuration per run (nothing written into the repo), merging only when a person asks, a conflict rolled back."""

import asyncio
import json
import subprocess
from pathlib import Path

import pytest

from models import AiWorktree
from services.ai import run_config, worktrees
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401


def _git(cwd, *args):
    return subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=T", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )


@pytest.fixture
def repo(env):
    path = env["repo"]
    _git(path, "init", "-q", "-b", "main")
    _git(path, "add", "-A")
    _git(path, "commit", "-q", "-m", "first")
    return path


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


async def _on(c, pid, **extra):
    r = await c.patch(
        f"/projects/{pid}/ai/ops",
        json={"worktrees": {"on": True, "handover": "local", **extra}},
    )
    assert r.status_code == 200


async def _run_ticket(c, pid, member, title="Fix add()"):
    tid = await _ticket(c, pid, title)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": member["id"], "start": "now"}
    )
    return tid, await _wait(c, tid, ("finished", "failed"))


async def _wait_for(pred, timeout=10.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not await pred():
        assert asyncio.get_running_loop().time() < deadline, "timed out"
        await asyncio.sleep(0.1)


async def test_a_ticket_works_in_its_own_worktree_beside_the_repo_with_a_port(
    env, repo, monkeypatch, tmp_path
):
    c = env["c"]
    where = tmp_path / "cwd.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_CWD_RECORD", str(where))
    pid, _ = await _project(c)
    await _on(c, pid, base_port=5190)
    m = await _runner(c, pid, repo)
    tid, run = await _run_ticket(c, pid, m)
    assert run["state"] == "finished"
    seen = json.loads(where.read_text().splitlines()[-1])
    expected = str(Path(repo).parent / f"{Path(repo).name}.worktrees" / tid)
    assert Path(seen["cwd"]).resolve() == Path(expected).resolve()
    assert seen["port"] == "5190"
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()
    assert wt["branch"].startswith(f"ai/{tid}-fix-add")
    assert wt["base"] == "main"
    assert wt["live"]["exists"] is True
    # nothing the board wrote landed in the repository
    assert not (Path(repo) / ".claude").exists()
    listing = (await c.get(f"/projects/{pid}/ai/worktrees")).json()
    assert [w["ticket_id"] for w in listing["worktrees"]] == [tid]


async def test_the_same_ticket_keeps_its_worktree_and_another_gets_the_next_port(
    env, repo
):
    c = env["c"]
    pid, _ = await _project(c)
    await _on(c, pid, base_port=5300)
    m = await _runner(c, pid, repo)
    t1, _ = await _run_ticket(c, pid, m, "One")
    t2, _ = await _run_ticket(c, pid, m, "Two")
    ports = {
        w["ticket_id"]: w["port"]
        for w in (await c.get(f"/projects/{pid}/ai/worktrees")).json()["worktrees"]
    }
    assert ports == {t1: 5300, t2: 5301}


async def test_a_folder_that_is_not_a_repository_falls_back_to_the_shared_folder(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    where = tmp_path / "cwd.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_CWD_RECORD", str(where))
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, env["repo"])  # never git-initialised here
    tid, run = await _run_ticket(c, pid, m)
    assert run["state"] == "finished"
    assert (
        Path(json.loads(where.read_text().splitlines()[-1])["cwd"]).resolve()
        == Path(env["repo"]).resolve()
    )
    assert (await c.get(f"/tickets/{tid}/ai/worktree")).json() is None


async def test_a_person_moving_the_ticket_to_done_merges_and_removes_the_worktree(
    env, repo, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_COMMIT", "def add(a, b):\n    return a + b\n")
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, repo)
    tid, run = await _run_ticket(c, pid, m)
    assert run["state"] == "finished"
    assert "a - b" in Path(repo, "calc.py").read_text()  # not merged yet
    await c.patch(f"/tickets/{tid}", json={"status": "done"})

    async def merged():
        async with env["maker"]() as s:
            row = await s.get(AiWorktree, tid)
            return row is not None and row.state == "removed" and row.merged_at

    await _wait_for(merged)
    assert "a + b" in Path(repo, "calc.py").read_text()
    log = _git(repo, "log", "--oneline", "-3").stdout
    assert f"Merge {tid}" in log


async def test_a_conflict_is_rolled_back_and_becomes_a_needs_you_row(
    env, repo, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_COMMIT", "def add(a, b):\n    return a + b  # AI\n")
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, repo)
    tid, _ = await _run_ticket(c, pid, m)
    # main moves the same line meanwhile
    Path(repo, "calc.py").write_text("def add(a, b):\n    return b + a  # main\n")
    _git(repo, "commit", "-qam", "main moved")
    out = (await c.post(f"/tickets/{tid}/ai/merge")).json()
    assert out["merged"] is False
    assert out["conflict"] == ["calc.py"]
    # never left half-done: no merge in progress, main untouched
    assert not Path(repo, ".git", "MERGE_HEAD").exists()
    assert "b + a  # main" in Path(repo, "calc.py").read_text()
    flags = (await c.get(f"/tickets/{tid}/ai/ticket-flags")).json()
    assert flags[0]["kind"] == "merge_conflict" and flags[0]["open"]
    panel = (
        await c.get("/notifications", params={"view": "panel", "tab": "needs"})
    ).json()
    row = next(i for i in panel["items"] if i["kind"] == "merge_conflict")
    assert [a["id"] for a in row["actions"]][:2] == ["conflict:ai", "conflict:me"]
    r = await c.post(f"/tickets/{tid}/ai/conflict", json={"choice": "me"})
    assert r.status_code == 200
    assert not (await c.get(f"/tickets/{tid}/ai/ticket-flags")).json()[0]["open"]


async def test_handing_a_conflict_to_an_ai_starts_a_run_for_it(env, repo, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_COMMIT", "def add(a, b):\n    return a + b  # AI\n")
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, repo)
    tid, _ = await _run_ticket(c, pid, m)
    Path(repo, "calc.py").write_text("x = 1\n")
    _git(repo, "commit", "-qam", "main moved")
    await c.post(f"/tickets/{tid}/ai/merge")
    monkeypatch.delenv("FAKE_CLAUDE_COMMIT")
    r = (await c.post(f"/tickets/{tid}/ai/conflict", json={"choice": "ai"})).json()
    assert r["run_id"]
    nxt = await _wait(c, tid, ("finished",))
    assert "Resolve the merge conflict" in nxt["instruction"]
    assert "calc.py" in nxt["instruction"]


async def test_merging_is_refused_while_the_main_checkout_is_dirty(
    env, repo, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_COMMIT", "def add(a, b):\n    return a + b\n")
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, repo)
    tid, _ = await _run_ticket(c, pid, m)
    Path(repo, "notes.txt").write_text("mine, not committed")
    out = (await c.post(f"/tickets/{tid}/ai/merge")).json()
    assert out["merged"] is False
    assert "notes.txt" in out["refused"]


async def test_a_worktree_with_uncommitted_work_is_never_removed(env, repo):
    c = env["c"]
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, repo)
    tid, _ = await _run_ticket(c, pid, m)
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()
    Path(wt["path"], "scratch.txt").write_text("unsaved")
    r = await c.post(f"/tickets/{tid}/ai/worktree/remove", json={})
    assert r.status_code == 409
    assert "not committed" in r.json()["detail"]
    clean = (await c.post(f"/projects/{pid}/ai/worktrees/cleanup")).json()
    assert clean["removed"] == []


async def test_the_members_skills_travel_as_a_plugin_folder_not_into_the_repo(
    env, repo, monkeypatch, tmp_path
):
    c = env["c"]
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    await c.patch(f"/projects/{pid}/ai/ops", json={"per_run_config": True})
    m = await _runner(c, pid, repo)
    put = await c.patch(
        f"/ai/members/{m['id']}",
        json={
            "config": {
                "instructions": "Always run ruff.",
                "skills": [
                    {
                        "content": "---\nname: red-green\ndescription: TDD.\n---\nWrite the test first.",
                        "enabled": True,
                    }
                ],
            }
        },
    )
    assert put.status_code == 200, put.text
    tid, run = await _run_ticket(c, pid, m)
    assert run["state"] == "finished"
    args = [json.loads(x) for x in record.read_text().splitlines()][-1]
    folder = args[args.index("--plugin-dir") + 1]
    assert Path(folder, "skills", "red-green", "SKILL.md").is_file()
    assert json.loads(Path(folder, ".claude-plugin", "plugin.json").read_text())[
        "name"
    ].startswith("kanban-")
    system = args[args.index("--append-system-prompt") + 1]
    assert "Always run ruff." in system
    assert not (Path(repo) / ".claude").exists()
    assert not (Path(repo) / "CLAUDE.md").exists()


async def test_leaving_the_synced_folder_removes_only_what_the_board_wrote(env, repo):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, repo)
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={
            "config": {
                "instructions": "Board text.",
                "skills": [
                    {
                        "content": "---\nname: red-green\ndescription: TDD.\n---\nx",
                        "enabled": True,
                    }
                ],
            }
        },
    )
    assert r.status_code == 200, r.text
    tid, _ = await _run_ticket(c, pid, m)  # the old way: synced into the folder
    skill = Path(repo, ".claude", "skills", "red-green", "SKILL.md")
    assert skill.is_file()
    Path(repo, "CLAUDE.md").write_text(
        Path(repo, "CLAUDE.md").read_text() + "\nMy own line.\n"
    )
    listed = (await c.get(f"/ai/members/{m['id']}/config-migration")).json()
    assert any(f["path"].endswith("SKILL.md") for f in listed["files"])
    removed = (await c.post(f"/ai/members/{m['id']}/config-migration")).json()[
        "removed"
    ]
    assert not skill.exists()
    text = Path(repo, "CLAUDE.md").read_text()
    assert "My own line." in text
    assert "Board text." not in text
    assert "CLAUDE.md" in removed


def test_names_and_paths():
    assert worktrees.slug("Fix the CSV export, please!") == "fix-the-csv-export-please"
    assert worktrees.path_for("/code/kanban", "KAN-1") == "/code/kanban.worktrees/KAN-1"
    assert run_config.plugin_name("Dev An (TDD)") == "kanban-dev-an-tdd"
