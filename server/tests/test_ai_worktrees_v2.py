"""Where a team works and how its code is handed over (services/ai/worktrees.py, api/ai_code.py), against real git
repositories in a temporary folder: one worktree per ticket beside the repo with a port of its own, nothing written
into the repo, merging only when a person asks, a conflict rolled back, uncommitted work never removed."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from models import AiRun, AiWorktree
from services.ai import runs, worktrees
from tests.ai_helpers import _project, _runner, _ticket, _wait, env  # noqa: F401


def _git(cwd, *args):
    return subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=T", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )


@pytest.fixture
def repo(env):  # noqa: F811
    path = env["repo"]
    _git(path, "init", "-q", "-b", "main")
    _git(path, "add", "-A")
    _git(path, "commit", "-q", "-m", "first")
    return path


@pytest.fixture(autouse=True)
def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "v2")
    worktrees._DEFERRED.clear()


async def _on(c, pid, **extra):
    r = await c.patch(
        f"/projects/{pid}/ai/settings",
        json={"ops": {"worktrees": {"on": True, "handover": "local", **extra}}},
    )
    assert r.status_code == 200, r.text


async def _run_ticket(c, pid, team, title="Fix add()"):
    tid = await _ticket(c, pid, title)
    r = await c.patch(f"/tickets/{tid}", json={"assignee": team["id"]})
    assert r.status_code == 200, r.text
    return tid, await _wait(c, tid, ("finished", "failed"), timeout=30)


async def _until(pred, timeout=10.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not await pred():
        assert asyncio.get_running_loop().time() < deadline, "timed out"
        await asyncio.sleep(0.1)


async def _setup_ticket(env, repo, **wt):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    await _on(c, pid, **wt)
    team = await _runner(c, pid, repo)
    tid, run = await _run_ticket(c, pid, team)
    assert run["state"] == "finished", run
    return c, pid, team, tid


async def test_a_ticket_works_in_its_own_worktree_beside_the_repo_with_a_port(
    env, repo, monkeypatch, tmp_path
):  # noqa: F811
    c = env["c"]
    where = tmp_path / "cwd.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_CWD_RECORD", str(where))
    pid, _ = await _project(c)
    await _on(c, pid, base_port=5190)
    team = await _runner(c, pid, repo)
    tid, run = await _run_ticket(c, pid, team)
    assert run["state"] == "finished"
    seen = json.loads(where.read_text().splitlines()[-1])
    expected = Path(repo).parent / f"{Path(repo).name}.worktrees" / tid
    assert Path(seen["cwd"]).resolve() == expected.resolve()
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()
    assert wt["branch"].startswith(f"ai/{tid}-fix-add") and wt["base"] == "main"
    assert wt["state"] == "active" and wt["live"]["exists"] is True
    assert not (
        Path(repo) / ".claude"
    ).exists()  # nothing the board wrote landed in the repository
    listing = (await c.get(f"/projects/{pid}/ai/worktrees")).json()
    assert [w["ticket_id"] for w in listing["worktrees"]] == [tid]


async def test_the_cli_gets_the_worktrees_port_in_its_environment(
    env, repo, monkeypatch, tmp_path
):  # noqa: F811
    c = env["c"]
    where = tmp_path / "cwd.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_CWD_RECORD", str(where))
    pid, _ = await _project(c)
    await _on(c, pid, base_port=5190)
    team = await _runner(c, pid, repo)
    await _run_ticket(c, pid, team)
    assert json.loads(where.read_text().splitlines()[-1])["port"] == "5190"


async def test_the_same_ticket_keeps_its_worktree_and_another_gets_the_next_port(
    env, repo
):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    await _on(c, pid, base_port=5300)
    team = await _runner(c, pid, repo)
    t1, _ = await _run_ticket(c, pid, team, "One")
    t2, _ = await _run_ticket(c, pid, team, "Two")
    ports = {
        w["ticket_id"]: w["port"]
        for w in (await c.get(f"/projects/{pid}/ai/worktrees")).json()["worktrees"]
    }
    assert ports == {t1: 5300, t2: 5301}
    async with env["maker"]() as s:
        first = await s.get(AiWorktree, t1)
        again = await worktrees.ensure(
            s, await s.get(__import__("models").Ticket, t1), repo
        )
        assert again.path == first.path and again.port == 5300


async def test_a_folder_that_is_not_a_repository_falls_back_to_the_shared_folder(
    env, monkeypatch, tmp_path
):  # noqa: F811
    c = env["c"]
    where = tmp_path / "cwd.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_CWD_RECORD", str(where))
    pid, _ = await _project(c)
    await _on(c, pid)
    team = await _runner(c, pid, env["repo"])  # never git-initialised
    tid, run = await _run_ticket(c, pid, team)
    assert run["state"] == "finished"
    assert (
        Path(json.loads(where.read_text().splitlines()[-1])["cwd"]).resolve()
        == Path(env["repo"]).resolve()
    )
    assert (await c.get(f"/tickets/{tid}/ai/worktree")).json() is None


async def test_with_worktrees_off_the_team_keeps_its_own_folder(
    env, repo, monkeypatch, tmp_path
):  # noqa: F811
    c = env["c"]
    where = tmp_path / "cwd.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_CWD_RECORD", str(where))
    pid, _ = await _project(c)
    team = await _runner(c, pid, repo)
    tid, run = await _run_ticket(c, pid, team)
    assert run["state"] == "finished"
    assert (
        Path(json.loads(where.read_text().splitlines()[-1])["cwd"]).resolve()
        == Path(repo).resolve()
    )
    assert (await c.get(f"/tickets/{tid}/ai/worktree")).json() is None


async def test_a_repository_with_no_commit_stops_the_run_and_says_what_to_do(env):  # noqa: F811
    c = env["c"]
    _git(
        env["repo"], "init", "-q", "-b", "main"
    )  # no commit: the branch has nothing to start from
    pid, _ = await _project(c)
    await _on(c, pid)
    team = await _runner(c, pid, env["repo"])
    tid, run = await _run_ticket(c, pid, team)
    assert run["state"] == "failed"
    async with env["maker"]() as s:
        row = await s.get(AiRun, run["id"])
    assert (
        "no commit yet" in row.ended_reason
        and "git commit --allow-empty" in row.ended_reason
    )
    assert row.stop_code == "board_fault"


async def test_a_failing_prepare_command_fails_the_run_with_its_output(env, repo):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    await _on(
        c,
        pid,
        prepare=f'"{sys.executable}" -c "import sys; print(\'npm exploded\', file=sys.stderr); sys.exit(3)"',
    )
    team = await _runner(c, pid, repo)
    tid, run = await _run_ticket(c, pid, team)
    assert run["state"] == "failed"
    assert (
        "prepare command" in run["ended_reason"]
        and "npm exploded" in run["ended_reason"]
    )


async def test_a_worktree_made_again_runs_the_prepare_command_again(
    env, repo, tmp_path
):  # noqa: F811
    c = env["c"]
    count = tmp_path / "prepared.txt"
    pid, _ = await _project(c)
    await _on(
        c, pid, prepare=f"\"{sys.executable}\" -c \"open(r'{count}', 'a').write('x')\""
    )
    team = await _runner(c, pid, repo)
    tid, run = await _run_ticket(c, pid, team)
    assert run["state"] == "finished" and count.read_text() == "x"
    assert (await c.get(f"/tickets/{tid}/ai/worktree")).json()["prepared_at"]
    r = await c.post(f"/tickets/{tid}/ai/worktree/remove", json={})
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "removed" and r.json()["port"] is None
    assert not (Path(repo).parent / f"{Path(repo).name}.worktrees" / tid).exists()
    assert (await c.get(f"/tickets/{tid}/ai/worktree")).json() is None
    assert (await c.post(f"/tickets/{tid}/ai/run", json={})).status_code in (200, 201)
    await asyncio.sleep(0.3)
    await _wait(c, tid, ("finished", "failed"), timeout=30)
    assert count.read_text() == "xx"


async def test_a_person_moving_the_ticket_to_done_merges_and_removes_the_worktree(
    env, repo, monkeypatch
):  # noqa: F811
    monkeypatch.setenv("FAKE_CLAUDE_COMMIT", "def add(a, b):\n    return a + b\n")
    c, pid, team, tid = await _setup_ticket(env, repo)
    assert "a - b" in Path(repo, "calc.py").read_text()  # not merged yet
    await c.patch(f"/tickets/{tid}", json={"status": "done"})

    async def merged():
        async with env["maker"]() as s:
            row = await s.get(AiWorktree, tid)
            return row is not None and row.state == "removed" and row.merged_at

    await _until(merged)
    assert "a + b" in Path(repo, "calc.py").read_text()
    assert f"Merge {tid}" in _git(repo, "log", "--oneline", "-3").stdout


async def test_a_conflict_is_rolled_back_and_the_worktree_is_left_as_the_ai_made_it(
    env, repo, monkeypatch
):  # noqa: F811
    monkeypatch.setenv("FAKE_CLAUDE_COMMIT", "def add(a, b):\n    return a + b  # AI\n")
    c, pid, team, tid = await _setup_ticket(env, repo)
    Path(repo, "calc.py").write_text(
        "def add(a, b):\n    return b + a  # main\n"
    )  # main moves the same line
    _git(repo, "commit", "-qam", "main moved")
    out = (await c.post(f"/tickets/{tid}/ai/merge")).json()
    assert out["merged"] is False and out["conflict"] == ["calc.py"]
    assert not Path(repo, ".git", "MERGE_HEAD").exists()
    assert "b + a  # main" in Path(repo, "calc.py").read_text()
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()
    assert wt["state"] == "conflict" and wt["conflict_files"] == ["calc.py"]
    assert "a + b  # AI" in Path(wt["path"], "calc.py").read_text()
    panel = (
        await c.get("/notifications", params={"view": "panel", "tab": "needs"})
    ).json()
    assert any(
        i["kind"] == "merge_conflict" and tid in i["title"] for i in panel["items"]
    )


async def test_merging_is_refused_while_the_main_checkout_is_dirty_or_on_another_branch(
    env, repo, monkeypatch
):  # noqa: F811
    monkeypatch.setenv("FAKE_CLAUDE_COMMIT", "def add(a, b):\n    return a + b\n")
    c, pid, team, tid = await _setup_ticket(env, repo)
    Path(repo, "notes.txt").write_text("mine, not committed")
    out = (await c.post(f"/tickets/{tid}/ai/merge")).json()
    assert out["merged"] is False and "notes.txt" in out["refused"]
    Path(repo, "notes.txt").unlink()
    _git(repo, "checkout", "-q", "-b", "elsewhere")
    out = (await c.post(f"/tickets/{tid}/ai/merge")).json()
    assert (
        out["merged"] is False
        and "elsewhere" in out["refused"]
        and "main" in out["refused"]
    )
    _git(repo, "checkout", "-q", "main")
    assert (await c.post(f"/tickets/{tid}/ai/merge")).json() == {"merged": True}
    assert "a + b" in Path(repo, "calc.py").read_text()


async def test_merge_with_no_worktree_says_so(env):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid)
    out = (await c.post(f"/tickets/{tid}/ai/merge")).json()
    assert out["merged"] is False and "no worktree" in out["refused"]


async def test_a_worktree_with_uncommitted_work_is_never_removed_and_commit_now_saves_it(
    env, repo
):  # noqa: F811
    c, pid, team, tid = await _setup_ticket(env, repo)
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()
    Path(wt["path"], "feature.py").write_text("x = 1\n")
    live = (await c.get(f"/tickets/{tid}/ai/worktree")).json()["live"]
    assert live["uncommitted"] == ["feature.py"] and live["outputs"] == []
    r = await c.post(f"/tickets/{tid}/ai/worktree/remove", json={})
    assert r.status_code == 409 and "not committed" in r.json()["detail"]
    r = await c.patch(
        f"/tickets/{tid}", json={"status": "wont_do", "wont_do_reason": "dropped"}
    )
    assert r.status_code == 200, r.text
    clean = (await c.post(f"/projects/{pid}/ai/worktrees/cleanup")).json()
    assert clean["removed"] == [] and clean["kept"][0]["ticket_id"] == tid
    done = (await c.post(f"/tickets/{tid}/ai/worktree/commit")).json()
    assert done["committed"] is True and done["left"] == []
    assert _git(wt["path"], "status", "--porcelain").stdout == ""
    assert "committed by" in _git(wt["path"], "log", "-1", "--format=%s").stdout
    assert (await c.post(f"/tickets/{tid}/ai/worktree/commit")).json()[
        "committed"
    ] is False
    clean = (await c.post(f"/projects/{pid}/ai/worktrees/cleanup")).json()
    assert clean["removed"] == [tid]


async def test_cleanup_removes_only_finished_tickets_and_a_kept_worktree_stays(
    env, repo
):  # noqa: F811
    c, pid, team, tid = await _setup_ticket(env, repo)
    assert (await c.post(f"/projects/{pid}/ai/worktrees/cleanup")).json() == {
        "removed": [],
        "kept": [],
    }
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()
    r = await c.patch(
        f"/tickets/{tid}", json={"status": "wont_do", "wont_do_reason": "dropped"}
    )
    assert r.status_code == 200, r.text
    kept = await c.post(f"/tickets/{tid}/ai/worktree/keep")
    assert kept.status_code == 200 and kept.json()["state"] == "kept"
    assert (await c.post(f"/projects/{pid}/ai/worktrees/cleanup")).json() == {
        "removed": [],
        "kept": [],
    }
    assert Path(wt["path"]).is_dir()
    # a kept worktree is still used by the next run, with the same port
    again = (await c.get(f"/projects/{pid}/ai/worktrees")).json()["worktrees"]
    assert [w["port"] for w in again] == [wt["port"]]
    other = await _ticket(c, pid, "No tree")
    assert (await c.post(f"/tickets/{other}/ai/worktree/keep")).status_code == 404


async def test_the_handover_route_of_one_ticket_overrides_the_projects(env, repo):  # noqa: F811
    c, pid, team, tid = await _setup_ticket(env, repo)
    r = await c.patch(f"/tickets/{tid}/ai/handover", json={"route": "branch"})
    assert (
        r.status_code == 200
        and r.json()["route"] == "branch"
        and r.json()["handover"] == "branch"
    )
    r = await c.patch(f"/tickets/{tid}/ai/handover", json={"route": "auto"})
    assert (
        r.json()["handover"] is None and r.json()["route"] == "local"
    )  # the project's choice
    no = await _ticket(c, pid, "Other")
    assert (
        await c.patch(f"/tickets/{no}/ai/handover", json={"route": "pr"})
    ).status_code == 404


async def test_auto_route_is_local_without_a_remote_and_branch_for_another_host(
    env, repo
):  # noqa: F811
    assert await worktrees.guess_route(repo) == "local"
    _git(repo, "remote", "add", "origin", "https://gitlab.example.com/a/b.git")
    assert await worktrees.guess_route(repo) == "branch"


def test_only_a_github_host_is_github():
    assert worktrees.is_github("https://github.com/o/r.git")
    assert worktrees.is_github("git@github.com:o/r.git")
    assert worktrees.is_github("ssh://git@github.com/o/r.git")
    assert not worktrees.is_github("https://gitlab.com/github.com/r.git")
    assert not worktrees.is_github(
        "https://notgithub.com/o/r"
    ) and not worktrees.is_github(None)


async def test_review_with_a_branch_route_commits_leftovers_and_pushes_the_branch(
    env, repo, tmp_path, monkeypatch
):  # noqa: F811
    bare = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", str(bare))
    _git(repo, "remote", "add", "origin", str(bare))
    c, pid, team, tid = await _setup_ticket(env, repo, handover="branch")
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()
    Path(wt["path"], "late.py").write_text("y = 2\n")
    out = await worktrees.on_review(tid)
    assert out == {"route": "branch", "pushed": True}
    heads = _git(str(bare), "branch", "--list").stdout
    assert wt["branch"] in heads
    assert (
        "work in progress handed over for review"
        in _git(str(bare), "log", wt["branch"], "-1", "--format=%s").stdout
    )
    assert (
        Path(wt["path"], "late.py").exists()
        and _git(wt["path"], "status", "--porcelain").stdout == ""
    )


async def test_review_with_a_local_route_does_nothing_and_a_failed_push_is_reported(
    env, repo
):  # noqa: F811
    c, pid, team, tid = await _setup_ticket(env, repo)
    assert await worktrees.on_review(tid) == {"route": "local"}
    assert await worktrees.on_review("KAN-999") is None
    await c.patch(
        f"/tickets/{tid}/ai/handover", json={"route": "branch"}
    )  # no origin to push to
    out = await worktrees.on_review(tid)
    assert out["route"] == "branch" and out["error"].startswith("git push failed")


async def test_a_move_to_review_while_a_run_works_waits_for_the_run_to_stop(
    env, repo, monkeypatch
):  # noqa: F811
    c = env["c"]
    handed: list[str] = []

    async def on_review(ticket_id):
        handed.append(ticket_id)

    monkeypatch.setattr(worktrees, "on_review", on_review)
    pid, _ = await _project(c)
    team = await _runner(c, pid, repo)
    tid = await _ticket(c, pid, status="in-progress")
    async with env["maker"]() as s:
        s.add(
            AiRun(
                id="r1",
                project_id=pid,
                ticket_id=tid,
                member_id=team["id"],
                state="running",
            )
        )
        await s.commit()
    await c.patch(
        f"/tickets/{tid}", json={"status": "review"}
    )  # the AI moves its own ticket mid-run
    await asyncio.sleep(0.3)
    assert handed == []
    async with env["maker"]() as s:
        row = await s.get(AiRun, "r1")
        row.state = "finished"
        s.add(row)
        await s.commit()
    worktrees.after_run(tid)
    await _until(lambda: _true(handed))
    assert handed == [tid]
    worktrees.after_run(tid)  # once only
    await asyncio.sleep(0.2)
    assert handed == [tid]


async def test_a_person_moving_to_review_hands_over_at_once_and_an_ai_move_to_done_merges_nothing(
    env, repo, monkeypatch
):  # noqa: F811
    c = env["c"]
    seen: list[tuple] = []

    async def on_review(ticket_id):
        seen.append(("review", ticket_id))

    async def merge(ticket_id, *, by):
        seen.append(("merge", ticket_id))

    monkeypatch.setattr(worktrees, "on_review", on_review)
    monkeypatch.setattr(worktrees, "merge", merge)
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, status="in-progress")
    await c.patch(f"/tickets/{tid}", json={"status": "review"})
    await _until(lambda: _true(seen))
    worktrees.on_status(tid, "done", "review", by_ai=True)
    worktrees.on_status(tid, "done", "done", by_ai=False)  # no move
    worktrees.on_status(tid, "testing", "review", by_ai=False)  # not a hand-over column
    await asyncio.sleep(0.3)
    assert seen == [("review", tid)]
    await c.patch(f"/tickets/{tid}", json={"status": "done"})
    await _until(lambda: _count(seen, 2))
    assert seen[-1] == ("merge", tid)


async def _true(xs):
    return bool(xs)


async def _count(xs, n):
    return len(xs) >= n


async def test_the_run_ending_delivers_a_review_handover_that_waited_for_it(
    env, repo, monkeypatch
):  # noqa: F811
    c = env["c"]
    handed: list[str] = []

    async def on_review(ticket_id):
        handed.append(ticket_id)

    monkeypatch.setattr(worktrees, "on_review", on_review)
    pid, _ = await _project(c)
    team = await _runner(c, pid, repo)
    tid = await _ticket(c, pid, status="in-progress")
    async with env["maker"]() as s:
        s.add(
            AiRun(
                id="r2",
                project_id=pid,
                ticket_id=tid,
                member_id=team["id"],
                state="running",
            )
        )
        await s.commit()
    await c.patch(f"/tickets/{tid}", json={"status": "review"})
    await asyncio.sleep(0.3)
    await runs._end("r2", "finished", "done")
    await asyncio.sleep(1.0)
    assert handed == [tid]


# --- outputs, names and paths ----------------------------------------------------------------------------------


def test_names_and_paths():
    assert worktrees.slug("Fix the CSV export, please!") == "fix-the-csv-export-please"
    assert (
        worktrees.slug("Bất tài liệu học") == "bat-tai-lieu-hoc"
    )  # Vietnamese keeps its letters
    assert worktrees.slug("Đặt lịch hẹn") == "dat-lich-hen"
    assert worktrees.slug("!!!") == "work" and worktrees.slug("") == "work"
    assert len(worktrees.slug("word " * 30)) <= 32 and not worktrees.slug(
        "word " * 30
    ).endswith("-")
    assert worktrees.path_for("/code/kanban", "KAN-1") == "/code/kanban.worktrees/KAN-1"


def test_outputs_are_told_from_code():
    for rel in (
        "shot.png",
        "qa/step1.txt",
        "run.log",
        "out/evidence/a.txt",
        "test-results/x.json",
        "sub/video.mp4",
        "my_work/notes.md",
    ):
        assert worktrees.is_output(rel), rel
    for rel in (
        "src/app.py",
        "docs/diagram.png",
        "README.md",
        "src/logo.png",
        "script.sh",
    ):
        assert not worktrees.is_output(rel), rel
    lines = [
        "?? shot.png",
        "?? src/new.py",
        " M calc.py",
        "?? qa/a.txt",
        "A  staged.log",
    ]
    assert worktrees.outputs_in(lines) == ["shot.png", "qa/a.txt"]


async def test_outputs_a_run_leaves_are_tidied_at_its_end_and_never_committed(
    env, repo, monkeypatch
):  # noqa: F811
    monkeypatch.setenv(
        "FAKE_CLAUDE_LEAVE", json.dumps(["feature.py", "shot.png", "qa/step.txt"])
    )
    c, pid, team, tid = await _setup_ticket(env, repo)
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()

    async def told():
        log = (await c.get(f"/tickets/{tid}")).json().get("work_log") or []
        return any("output file" in (e.get("note") or "") for e in log)

    await _until(
        told
    )  # the end of the run tidied the worktree and said where the outputs went
    log = (await c.get(f"/tickets/{tid}")).json()["work_log"]
    note = next(e["note"] for e in log if "output file" in e["note"])
    if note.startswith(
        "Moved 2 output files"
    ):  # the Workspace is on: the ticket's folder has them
        assert (
            not Path(wt["path"], "shot.png").exists()
            and not Path(wt["path"], "qa").exists()
        )
        assert (await c.get(f"/tickets/{tid}/ai/worktree")).json()["live"][
            "outputs"
        ] == []
    else:  # the Workspace is off: they stay, and the note says why the worktree is not clean
        assert "still in the worktree" in note and Path(wt["path"], "shot.png").exists()
    # whichever it was, the code is committed on a person's request and the outputs never are
    done = (await c.post(f"/tickets/{tid}/ai/worktree/commit")).json()
    assert done["committed"] is True
    shown = _git(wt["path"], "show", "--name-only", "--format=", "HEAD").stdout.split()
    assert shown == ["feature.py"]
