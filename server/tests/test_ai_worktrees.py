"""Where an AI works and how its code is handed over (design/screens/ai-operations.md I, J, K; D4–D7), against real
git repositories in a temporary folder: one worktree per ticket beside the repo, its own port, the member's
configuration per run (nothing written into the repo), merging only when a person asks, a conflict rolled back."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from models import AiRun, AiWorktree
from services.ai import failures, run_config, runs, worktrees
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


async def test_a_repository_with_no_commit_stops_the_run_at_once_and_says_what_to_do(
    env,
):
    c = env["c"]
    _git(
        env["repo"], "init", "-q", "-b", "main"
    )  # no commit: the branch has nothing to start from
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, env["repo"])
    tid, run = await _run_ticket(c, pid, m)
    assert run["state"] == "failed"
    async with env["maker"]() as s:
        row = await s.get(AiRun, run["id"])
    assert json.loads(row.retries or "[]") == []  # trying again cannot help
    diag = json.loads(row.diagnosis)
    assert diag["cause"] == "setup" and diag["board_fault"] is True
    assert (
        "no commit yet" in diag["what"] and "git commit --allow-empty" in diag["what"]
    )


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
    # the run's own folder (what it held is checked while runs work, below), removed when the run ends
    assert Path(folder).name == run["id"]
    await _wait_for(lambda: _gone([folder], run["id"]))
    assert run_config.plugin_name("Claude Code · Backend").startswith("kanban-")
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
    # Vietnamese titles keep their letters (was "b-t-i-li-u-h-c")
    assert worktrees.slug("Bất tài liệu học") == "bat-tai-lieu-hoc"
    assert worktrees.slug("Đặt lịch hẹn") == "dat-lich-hen"
    assert worktrees.slug("!!!") == "work"
    assert worktrees.path_for("/code/kanban", "KAN-1") == "/code/kanban.worktrees/KAN-1"
    assert run_config.plugin_name("Dev An (TDD)") == "kanban-dev-an-tdd"


def _py(code: str) -> str:
    return f'"{sys.executable}" -c "{code}"'


async def test_a_cancel_while_the_worktree_is_prepared_never_starts_the_cli(
    env, repo, monkeypatch, tmp_path
):
    c = env["c"]
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    await _on(c, pid, prepare=_py("import time; time.sleep(1.5)"))
    m = await _runner(c, pid, repo)
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("starting",))
    await asyncio.sleep(
        0.3
    )  # the prepare command is running: there is no process to stop yet
    await runs.cancel(run["id"], by="An")
    await asyncio.sleep(2.5)
    assert not record.exists()
    assert (await c.get(f"/ai/runs/{run['id']}")).json()["state"] == "cancelled"


async def test_a_run_that_failed_before_its_cli_started_starts_again_from_the_ticket(
    env, repo, monkeypatch, tmp_path
):
    c = env["c"]
    monkeypatch.setattr(failures, "NETWORK_DELAYS_S", (0, 0, 0))
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    marker = tmp_path / "prepared-once"
    pid, _ = await _project(c)
    # the prepare command fails the first time only
    await _on(
        c,
        pid,
        prepare=_py(
            f"import os, sys; p = r'{marker}'; ok = os.path.exists(p); open(p, 'w').close(); sys.exit(0 if ok else 1)"
        ),
    )
    m = await _runner(c, pid, repo)
    tid, run = await _run_ticket(c, pid, m)
    assert run["state"] == "finished"
    assert any(s["kind"] == "retry" for s in run["steps"])
    args = [json.loads(x) for x in record.read_text().splitlines()][-1]
    prompt = args[args.index("-p") + 1]
    assert "Fix add()" in prompt
    assert (
        "board tool failed" not in prompt
    )  # no "carry on from where you stopped": it never started
    assert any(ch["to"] == "in-progress" for ch in run["status_changes"])


async def test_a_worktree_made_again_runs_the_prepare_command_again(
    env, repo, tmp_path
):
    c = env["c"]
    count = tmp_path / "prepared.txt"
    pid, _ = await _project(c)
    await _on(c, pid, prepare=_py(f"open(r'{count}', 'a').write('x')"))
    m = await _runner(c, pid, repo)
    tid, _ = await _run_ticket(c, pid, m)
    assert count.read_text() == "x"
    r = await c.post(f"/tickets/{tid}/ai/worktree/remove", json={})
    assert r.status_code == 200, r.text
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await asyncio.sleep(0.3)
    await _wait(c, tid, ("finished", "failed"))
    assert count.read_text() == "xx"


async def test_a_move_to_review_mid_run_hands_over_when_the_run_stops(
    env, repo, monkeypatch
):
    c = env["c"]
    handed: list[str] = []

    async def on_review(ticket_id):
        handed.append(ticket_id)

    monkeypatch.setattr(worktrees, "on_review", on_review)
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, status="in-progress")
    async with env["maker"]() as s:
        s.add(
            AiRun(
                id="r1", project_id=pid, ticket_id=tid, member_id="m", state="running"
            )
        )
        await s.commit()
    # the AI moves its own ticket while its CLI is still writing
    await c.patch(f"/tickets/{tid}", json={"status": "review"})
    await asyncio.sleep(0.3)
    assert handed == []
    async with env["maker"]() as s:
        row = await s.get(AiRun, "r1")
        row.state = "finished"
        s.add(row)
        await s.commit()
    worktrees.after_run(tid)
    await _wait_for(lambda: _true(handed))
    assert handed == [tid]
    worktrees.after_run(tid)  # once only
    await asyncio.sleep(0.2)
    assert handed == [tid]


async def _true(xs):
    return bool(xs)


async def test_a_board_ai_move_to_review_pushes_nothing(env, repo, monkeypatch):
    from services import activity as act

    c = env["c"]
    handed: list[str] = []

    async def on_review(ticket_id):
        handed.append(ticket_id)

    monkeypatch.setattr(worktrees, "on_review", on_review)
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, status="in-progress")
    token = act.set_suggested("Board AI")
    try:
        worktrees.on_status(tid, "review", "in-progress", by_ai=False)
    finally:
        act.reset_suggested(token)
    await asyncio.sleep(0.2)
    assert handed == []
    worktrees.on_status(
        tid, "review", "in-progress", by_ai=False
    )  # a person's own move
    await _wait_for(lambda: _true(handed))


async def test_leaving_the_synced_folder_keeps_a_persons_own_json_settings(env, repo):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, repo)
    Path(repo, ".mcp.json").write_text(
        json.dumps({"mcpServers": {"mine": {"command": "my-server"}}})
    )
    Path(repo, ".claude").mkdir(exist_ok=True)
    Path(repo, ".claude", "settings.json").write_text(
        json.dumps(
            {"env": {"MY_FLAG": "1"}, "permissions": {"allow": ["Bash(make:*)"]}}
        )
    )
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={
            "config": {
                "mcp_servers": [
                    {
                        "name": "github",
                        "type": "stdio",
                        "command": "npx",
                        "args": ["gh"],
                    }
                ],
                "allow_rules": ["Read"],
            }
        },
    )
    assert r.status_code == 200, r.text
    w = await c.post(f"/ai/members/{m['id']}/config/write", json={})
    assert w.status_code == 200, w.text
    merged = json.loads(Path(repo, ".mcp.json").read_text())["mcpServers"]
    assert {"mine", "github", "kanban"} <= set(merged)
    listed = (await c.get(f"/ai/members/{m['id']}/config-migration")).json()
    assert all(f["block_only"] for f in listed["files"] if f["path"].endswith(".json"))
    removed = (await c.post(f"/ai/members/{m['id']}/config-migration")).json()[
        "removed"
    ]
    assert ".mcp.json" in removed
    assert json.loads(Path(repo, ".mcp.json").read_text()) == {
        "mcpServers": {"mine": {"command": "my-server"}}
    }
    settings = json.loads(Path(repo, ".claude", "settings.json").read_text())
    assert settings["env"] == {"MY_FLAG": "1"}
    assert settings["permissions"]["allow"] == ["Bash(make:*)"]


async def test_two_runs_of_one_member_each_have_their_own_plugin_folder(
    env, repo, monkeypatch, tmp_path
):
    c = env["c"]
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    await c.patch(f"/projects/{pid}/ai/ops", json={"per_run_config": True})
    m = await _runner(c, pid, repo)
    await c.patch(
        f"/ai/members/{m['id']}",
        json={
            "config": {
                "skills": [
                    {
                        "content": "---\nname: red-green\ndescription: TDD.\n---\nx",
                        "enabled": True,
                    }
                ]
            }
        },
    )
    t1, t2 = await _ticket(c, pid, "one"), await _ticket(c, pid, "two")
    for t in (t1, t2):
        await c.post(
            f"/tickets/{t}/ai/assign", json={"member_id": m["id"], "start": "now"}
        )
    r1 = await _wait(c, t1, ("running",))
    r2 = await _wait(c, t2, ("running",))
    folders = [
        a[a.index("--plugin-dir") + 1]
        for a in (json.loads(x) for x in record.read_text().splitlines())
    ]
    assert len(set(folders)) == 2
    assert all(Path(f, "skills", "red-green", "SKILL.md").is_file() for f in folders)
    assert json.loads(Path(folders[0], ".claude-plugin", "plugin.json").read_text())[
        "name"
    ].startswith("kanban-")
    await runs.cancel(r1["id"], by="t")
    # the other run's folder is untouched; the ended run's own folder is gone
    assert Path(folders[1] if r1["id"] in folders[0] else folders[0]).is_dir()
    await _wait_for(lambda: _gone(folders, r1["id"]))
    await runs.cancel(r2["id"], by="t")


async def _gone(folders, run_id):
    return not any(Path(f).exists() for f in folders if run_id in f)


def test_the_board_commits_as_itself_only_where_git_has_no_identity(
    tmp_path, monkeypatch
):
    import subprocess

    from services.ai import worktrees

    empty = tmp_path / "gitconfig"
    empty.write_text("")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for k in worktrees._BOARD_IDENTITY:
        monkeypatch.delenv(k, raising=False)
    bare, own = tmp_path / "bare", tmp_path / "own"
    for repo in (bare, own):
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(
        ["git", "-C", str(own), "config", "user.email", "an@example.com"], check=True
    )
    monkeypatch.setattr(worktrees, "_HAS_IDENTITY", {})
    assert worktrees._identity_env(str(bare))["GIT_COMMITTER_NAME"] == "Kanban Board"
    assert (
        worktrees._identity_env(str(own)) == {}
    )  # a person's own identity always wins
