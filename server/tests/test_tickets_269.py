"""Issue #269: every ticket feature usable by an AI, and the Workspace kept apart from the worktree.

What an outside agent had to guess in a full ticket life over MCP (criteria on create, attaching a file, which
work-log role a reviewer takes, what a good ticket is), what a PM said that was not true (files "in the Workspace" that
was never made), and why: no run was told where the Workspace is, a Claude Code run could not write there, and a QA's
screenshots left in the worktree were committed into the branch at the hand-over or kept it from being cleaned."""

import asyncio
import json
import subprocess
from pathlib import Path

import pytest

from kanban_mcp import operations as ops
from kanban_mcp.instructions import build_instructions
from kanban_mcp.tools import docs_read, ticket_items
from models import AiWorktree
from services import shared_skills, ticket_guide
from services.ai import board_skills, cli, worktrees
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401
from tests.test_ai_worktrees import _on, _runs_dir, repo  # noqa: F401


async def _workspace_root(c, root: Path, **extra) -> None:
    r = await c.patch("/workspace/settings", json={"root_path": str(root), **extra})
    assert r.status_code == 200, r.text


@pytest.fixture(autouse=True)
def _uploads_in_a_temp_folder(monkeypatch, tmp_path):
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))


# --- the ticket guide -------------------------------------------------------------------------------------------


def test_the_ticket_guide_is_a_board_skill_and_the_same_text_over_mcp():
    assert ticket_guide.NAME in [n for n, _d, _b in shared_skills.SKILLS]
    skill = (
        Path(board_skills.plugin_dir()) / "skills" / ticket_guide.NAME / "SKILL.md"
    ).read_text()
    out = asyncio.run(docs_read(action="ticket_guide"))
    assert skill.endswith(out["guide"]) and out["guide"] == ticket_guide.GUIDE
    assert (
        asyncio.run(docs_read(action="guides"))[ticket_guide.NAME] == ticket_guide.GUIDE
    )
    # what the issue asks the guide to cover
    for must in (
        "Acceptance criteria",
        "sub-ticket",
        "block",
        "work log",
        "ten seconds",
        "item='attachment'",
        "Workspace",
        "worktree",
        "Never claim without checking",
    ):
        assert must in ticket_guide.GUIDE, must
    # each ready-made role has its line, in the guide's table too
    from services.ai import packs

    for p in packs.BUILTIN:
        assert p["key"] in ticket_guide.ON_TICKET, p["key"]
        assert ticket_guide.ON_TICKET[p["key"]] in ticket_guide.GUIDE


def test_every_run_and_outside_agent_gets_the_never_claim_rule():
    rule = next(r for r in shared_skills.CORE_RULES if r.startswith("Never claim"))
    assert rule in build_instructions(False)
    assert "docs_read(ticket_guide)" in build_instructions(False)
    assert (
        len(build_instructions(True)) < 10_000
    )  # Claude Code keeps only the first 10,000 characters


def test_a_role_line_says_what_the_role_leaves_and_where_the_guide_is():
    assert "work log" in ticket_guide.role_line("dev")
    assert "kanban-board:working-with-tickets" in ticket_guide.role_line("qa")
    assert "docs_read(action='ticket_guide')" in ticket_guide.role_line(
        "qa", skill=False
    )
    assert "exact place" in ticket_guide.role_line("pm")
    assert ticket_guide.role_line(None) is None


# --- an outside agent's ticket life -----------------------------------------------------------------------------


async def test_criteria_come_with_the_ticket_on_create(env):
    pid, _ = await _project(env["c"])
    t = await ops.create_ticket(
        project_id=pid,
        title="Reminders every hour",
        acceptance_criteria=["A reminder at 9:00", "None after the goal is met"],
    )
    assert [a["text"] for a in t["acceptance_criteria"]] == [
        "A reminder at 9:00",
        "None after the goal is met",
    ]
    assert not any(a["done"] for a in t["acceptance_criteria"])
    with pytest.raises(ValueError, match="At most 50"):
        await ops.create_ticket(
            project_id=pid, title="x", acceptance_criteria=["c"] * 51
        )


async def test_an_outside_agent_attaches_a_file_by_its_absolute_path(env, tmp_path):
    pid, _ = await _project(env["c"])
    tid = (await ops.create_ticket(project_id=pid, title="Attach"))["id"]
    shot = tmp_path / "shots" / "reminder.png"
    shot.parent.mkdir()
    shot.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    out = await ticket_items(
        ticket_id=tid, item="attachment", path=str(shot), text="The reminder"
    )
    assert out["attached"]["url"].startswith("/uploads/")
    assert out["attached"]["markdown"] == f"![reminder.png]({out['attached']['url']})"
    last = out["comments"][-1]["text"]
    assert last.startswith("The reminder") and out["attached"]["url"] in last
    # a picture named by its absolute path in a comment is attached too (it stayed a broken local path before)
    log = tmp_path / "run.log"
    log.write_text("2 passed")
    out = await ticket_items(
        ticket_id=tid,
        item="comment",
        author="Claude",
        text=f"Done.\n\n![shot]({shot})\n\n[log]({log})",
    )
    text = out["comments"][-1]["text"]
    assert (
        str(shot) not in text and str(log) not in text and text.count("/uploads/") == 2
    )
    # a test case's proof as well; a relative path says what to write instead
    t = await ticket_items(ticket_id=tid, item="test_case", title="TC")
    with pytest.raises(ValueError, match="absolute path"):
        await ticket_items(
            ticket_id=tid,
            item="test_case",
            item_id="TC-1",
            proof="![x](shots/reminder.png)",
        )
    t = await ticket_items(
        ticket_id=tid,
        item="test_case",
        item_id="TC-1",
        status="pass",
        proof=f"![x]({shot})",
    )
    assert "/uploads/" in t["test_cases"][0]["proof"]


async def test_attaching_never_copies_keys_or_dot_folders(env, tmp_path):
    pid, _ = await _project(env["c"])
    tid = (await ops.create_ticket(project_id=pid, title="Attach"))["id"]
    secret = tmp_path / ".ssh" / "notes.txt"
    secret.parent.mkdir()
    secret.write_text("x")
    with pytest.raises(ValueError, match="never attached"):
        await ticket_items(ticket_id=tid, item="attachment", path=str(secret))
    with pytest.raises(ValueError, match="no such file"):
        await ticket_items(
            ticket_id=tid, item="attachment", path=str(tmp_path / "gone.png")
        )
    with pytest.raises(ValueError, match="not a type"):
        (tmp_path / "a.exe").write_text("x")
        await ticket_items(
            ticket_id=tid, item="attachment", path=str(tmp_path / "a.exe")
        )


async def test_a_reviewer_finds_its_work_log_role_in_the_schema():
    from kanban_mcp.tools import items

    import inspect

    role = inspect.signature(items.ticket_items).parameters["role"].annotation
    assert "reviewer" in str(role.__metadata__[0].description)


# --- what get_ticket says about the Workspace and the worktree --------------------------------------------------


async def test_get_ticket_says_whether_the_workspace_exists_and_what_is_in_it(
    env, tmp_path
):
    c = env["c"]
    await _workspace_root(c, tmp_path / "ws")
    pid, _ = await _project(c)
    tid = (await ops.create_ticket(project_id=pid, title="QA"))["id"]
    t = await ops.get_ticket(tid)
    # the PM read `workspace_path` and told a person the files were there: the folder had never been made
    assert "workspace_path" not in t
    assert t["workspace"]["exists"] is False and "Not created" in t["workspace"]["note"]
    assert not (tmp_path / "ws" / tid).exists()  # reading never creates it
    await ops.get_ticket_workspace_path(tid)
    (tmp_path / "ws" / tid / "report.html").write_text("<p>ok</p>")
    t = await ops.get_ticket(tid)
    assert t["workspace"]["exists"] is True
    assert (
        t["workspace"]["files"] == ["report.html"] and t["workspace"]["file_count"] == 1
    )
    assert t["workspace_path"] == str(tmp_path / "ws" / tid)
    await _workspace_root(c, tmp_path / "ws", enabled=False)
    assert "workspace" not in await ops.get_ticket(tid)


# --- the worktree: outputs go to the Workspace, never into the branch -------------------------------------------


@pytest.mark.parametrize(
    "rel, output",
    [
        ("qa/evidence/TC-1.png", True),
        ("screenshots/home.png", True),
        ("test-results/run.json", True),
        ("ba_work/sample.xlsx", True),
        ("report.html", True),
        ("debug.log", True),
        ("src/assets/logo.png", False),
        ("src/reminder.py", False),
        ("tests/test_reminder.py", False),
    ],
)
def test_what_counts_as_an_output(rel, output):
    assert worktrees.is_output(rel) is output


async def test_a_runs_outputs_go_to_the_workspace_and_the_work_log_says_where(
    env, repo, monkeypatch, tmp_path
):
    c = env["c"]
    await _workspace_root(c, tmp_path / "ws")
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    monkeypatch.setenv(
        "FAKE_CLAUDE_LEAVE",
        json.dumps(["qa/evidence/TC-1.png", "report.html", "src/new_helper.py"]),
    )
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, repo)
    tid = await _ticket(c, pid, "Check the reminders")
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished"
    ws = tmp_path / "ws" / tid

    async def moved():
        return any(ws.glob("from-worktree/*/qa/evidence/TC-1.png"))

    for _ in range(100):
        if await moved():
            break
        await asyncio.sleep(0.05)
    assert await moved()
    # the run was told where the Workspace is, and Claude Code may write there
    args = json.loads(record.read_text().splitlines()[-1])
    system = args[args.index("--append-system-prompt") + 1]
    assert str(ws) in system and "worktree" in system
    assert args[args.index("--add-dir") + 1] == str(ws)
    # the code it left is still in the worktree, for the Dev to commit; the outputs are not
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()
    assert Path(wt["path"], "src/new_helper.py").exists()
    assert (
        not Path(wt["path"], "qa").exists()
        and not Path(wt["path"], "report.html").exists()
    )
    assert wt["live"]["outputs"] == []
    t = await ops.get_ticket(tid)
    note = t["work_log"][-1]["note"]
    assert "Moved 2 output files" in note and str(ws) in note
    assert t["worktree"]["uncommitted"] == ["src/new_helper.py"]
    assert "not removed until a person" in t["worktree"]["note"]


async def test_a_hand_over_never_commits_outputs_even_with_the_workspace_off(
    env, repo, tmp_path
):
    c = env["c"]
    await _workspace_root(c, tmp_path / "ws", enabled=False)
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, repo)
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, tid, ("finished", "failed"))
    wt = (await c.get(f"/tickets/{tid}/ai/worktree")).json()
    Path(wt["path"], "shots").mkdir()
    Path(wt["path"], "shots", "home.png").write_text("png")
    Path(wt["path"], "calc.py").write_text("def add(a, b):\n    return a + b\n")
    r = (await c.post(f"/tickets/{tid}/ai/worktree/commit")).json()
    assert r["committed"] is True and r["left"] == ["shots/home.png"]
    files = subprocess.run(
        ["git", "show", "--name-only", "--format=", "HEAD"],
        cwd=wt["path"],
        capture_output=True,
        text=True,
    ).stdout.split()
    assert files == ["calc.py"]
    # with the Workspace on, a person moves them there in one click
    await _workspace_root(c, tmp_path / "ws", enabled=True)
    r = (await c.post(f"/tickets/{tid}/ai/worktree/outputs")).json()
    assert r["moved"] == ["shots/home.png"]
    assert Path(r["to"], "shots", "home.png").exists()
    assert (
        await c.post(f"/tickets/{tid}/ai/worktree/remove", json={})
    ).status_code == 200


async def test_a_run_waiting_for_an_answer_keeps_its_files(env, repo, tmp_path):
    c = env["c"]
    await _workspace_root(c, tmp_path / "ws")
    pid, _ = await _project(c)
    await _on(c, pid)
    m = await _runner(c, pid, repo)
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("finished", "failed"))
    async with env["maker"]() as s:
        from models import AiRun

        row = await s.get(AiRun, run["id"])
        row.state = "needs_input"
        s.add(row)
        await s.commit()
        tree = await s.get(AiWorktree, tid)
    Path(tree.path, "debug.log").write_text("x")
    assert await worktrees.tidy_after_run(tid, run["id"]) is None
    assert Path(tree.path, "debug.log").exists()


# --- Claude Code may write in the Workspace ---------------------------------------------------------------------


def test_claude_args_pass_the_extra_folders():
    args = cli.claude_args(
        "claude",
        prompt="p",
        system="s",
        model=None,
        mcp_config={},
        allowed=[],
        denied=[],
        max_turns=None,
        session_id="x",
        resume=False,
        add_dirs=["/ws/KAN-1"],
    )
    assert args[args.index("--add-dir") + 1] == "/ws/KAN-1"


# --- Workspace screen and API -----------------------------------------------------------------------------------


async def test_open_folder_without_a_file_manager_leaves_no_folder(
    env, tmp_path, monkeypatch
):
    import shutil

    c = env["c"]
    await _workspace_root(c, tmp_path / "ws")
    pid, _ = await _project(c)
    tid = await _ticket(c, pid)
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    r = await c.post(f"/tickets/{tid}/workspace/open")
    assert r.status_code == 400 or r.status_code == 409 or r.status_code == 422
    assert not (tmp_path / "ws" / tid).exists()


async def test_a_workspace_moves_to_another_ticket_of_the_project(env, tmp_path):
    c = env["c"]
    await _workspace_root(c, tmp_path / "ws")
    pid, _ = await _project(c)
    a = await _ticket(c, pid, "Split me")
    b = await _ticket(c, pid, "The half that got the files")
    assert (
        await c.post(f"/tickets/{a}/workspace/move", json={"to_ticket_id": b})
    ).status_code == 400
    await c.post(f"/tickets/{a}/workspace/init")
    (tmp_path / "ws" / a / "notes.md").write_text("x")
    r = await c.post(f"/tickets/{a}/workspace/move", json={"to_ticket_id": b.lower()})
    assert r.status_code == 200, r.text
    assert r.json()["result"] == "moved" and r.json()["to"] == b
    assert (tmp_path / "ws" / b / "notes.md").exists() and not (
        tmp_path / "ws" / a
    ).exists()
    log = (await c.get(f"/tickets/{b}")).json()["activity_log"]
    assert any(e["field"] == "workspace" and a in str(e["to"]) for e in log)
    assert (
        await c.post(f"/tickets/{b}/workspace/move", json={"to_ticket_id": b})
    ).status_code == 400
    other = (
        await c.post(
            "/projects", json={"name": "O", "prefix": "OTH", "color": "#123456"}
        )
    ).json()
    x = await _ticket(c, other["id"])
    assert (
        await c.post(f"/tickets/{b}/workspace/move", json={"to_ticket_id": x})
    ).status_code == 400
