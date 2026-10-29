"""AI members and AI work on tickets: members API, permissions, the run lifecycle (against a fake CLI), the guard,
approvals, mentions, the kill switch, the API-key agent loop, audit and revert."""

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from database import get_session
from main import app
from models import AiApproval, AiAudit, AiRun, Ticket
from services.ai import api_agent, audit, guard, permissions, runs, safety, secrets
from services.ai.context import RunContext
from tests.fast_db import fresh_db_file

FAKE = str(Path(__file__).parent / "fixtures" / "fake_claude.py")


@pytest.fixture
async def env(tmp_path, monkeypatch):
    engine = create_async_engine(fresh_db_file(tmp_path / "ai.db"))
    maker = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", maker)

    async def override():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_session] = override
    monkeypatch.setenv("KANBAN_AI_KEY_FILE", str(tmp_path / "ai.key"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setattr(runs, "RT", runs._Runtime())
    monkeypatch.setattr(api_agent, "BACKOFF_SCALE", 0.0)
    # the daily digest goes out at 09:00 on the real clock; tests that want it set the hour themselves
    monkeypatch.setattr(safety, "DIGEST_HOUR", 24)
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "calc.py").write_text("def add(a, b):\n    return a - b\n")
    await runs.start_scheduler()
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield {"c": c, "repo": str(repo), "tmp": tmp_path, "maker": maker}
    await runs.stop_scheduler()
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


async def _project(c):
    p = (
        await c.post(
            "/projects",
            json={"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"},
        )
    ).json()
    an = (
        await c.post(f"/projects/{p['id']}/members", json={"name": "An Nguyen"})
    ).json()
    return p["id"], an["id"]


async def _runner(c, pid, repo, name="Claude Code · Backend", **extra):
    body = {
        "name": name,
        "provider": "claude-code",
        "working_dir": repo,
        "cli_path": FAKE,
        "model": "haiku",
        **extra,
    }
    r = await c.post(f"/projects/{pid}/ai/members", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def _ticket(c, pid, title="Fix add()", status="todo", **extra):
    r = await c.post(
        f"/projects/{pid}/tickets", json={"title": title, "status": status, **extra}
    )
    return r.json()["id"]


async def _wait(c, ticket_id, states, timeout=15.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        runs_ = (await c.get(f"/tickets/{ticket_id}/ai/runs")).json()
        if runs_ and runs_[0]["state"] in states:
            return runs_[0]
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(
                f"run never reached {states}: {runs_[0]['state'] if runs_ else None}"
            )
        runs.RT.wake.set()
        await asyncio.sleep(0.1)


def _ask_gate(env, monkeypatch) -> None:
    """In wait_question mode the fake CLI waits until the test has asked its question, not a fixed time."""
    gate = env["tmp"] / "asked"
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "wait_question")
    monkeypatch.setenv("FAKE_CLAUDE_GATE", str(gate))
    original = runs.record_question

    async def record(*args, **kwargs):
        out = await original(*args, **kwargs)
        gate.touch()
        return out

    monkeypatch.setattr(runs, "record_question", record)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        state = Path(f"/proc/{pid}/stat").read_text().split()[2]
        return state != "Z"
    except OSError:
        return True


# --------------------------------------------------------------------------- permissions


def test_templates_overrides_are_stricter_only_and_delete_is_locked():
    assert permissions.validate_overrides("developer", {"edit_docs": "blocked"}) == {
        "edit_docs": "blocked"
    }
    with pytest.raises(ValueError, match="only make the template stricter"):
        permissions.validate_overrides("developer", {"change_assignee": "allowed"})
    with pytest.raises(ValueError, match="at most 'approval'"):
        permissions.validate_overrides("custom", {"delete_tickets": "allowed"})
    assert (
        permissions.validate_overrides("custom", {"change_assignee": "allowed"}) == {}
    )


def test_effective_mode_is_the_most_restrictive_layer():
    class M:
        template = "developer"
        permissions = json.dumps({"comment": "approval"})
        ceiling = "review"

    class S:
        safe_mode = False
        paused_all = False

    assert permissions.effective(M, "edit_fields", S).mode == "allowed"
    assert permissions.effective(M, "comment", S).mode == "approval"
    S.safe_mode = True
    assert permissions.effective(M, "edit_fields", S).mode == "blocked"
    assert permissions.effective(M, "read", S).mode == "allowed"
    S.safe_mode, S.paused_all = False, True
    assert permissions.effective(M, "read", S).mode == "blocked"
    assert permissions.effective(M, "manage_project", S).mode == "blocked"


def test_status_ceiling():
    class M:
        ceiling = "review"

    assert permissions.check_status_move(M, "todo", "review") is None
    assert "above the status ceiling" in permissions.check_status_move(
        M, "review", "done"
    )
    assert permissions.check_status_move(M, "todo", "wont_do")
    M.ceiling = "none"
    assert "may not change" in permissions.check_status_move(M, "todo", "in-progress")


def test_redaction_masks_keys_tokens_and_env_values():
    text = "key sk-ant\x2dapi03-abcdefghijkl Bearer abcdefghijklmnop API_TOKEN=hunter2 gh\x70_abcdefghijklmnop1234"
    out = secrets.redact(text)
    assert (
        "abcdefghijkl" not in out
        and "hunter2" not in out
        and "gh\x70_abcdefghijklmnop1234" not in out
    )
    assert secrets.redact_obj({"api_key": "x", "n": ["sk-ant\x2d123456789012"]}) == {
        "api_key": "••••••••",
        "n": ["sk-••••"],
    }


# --------------------------------------------------------------------------- members


async def test_create_list_and_names_unique_across_people_and_ai(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    assert (
        m["kind"] == "ai" and m["status"]["code"] == "idle" and m["ceiling"] == "review"
    )
    assert m["is_board_ai"] is True
    r = await c.post(
        f"/projects/{pid}/ai/members",
        json={"name": " an nguyen ", "provider": "claude-code"},
    )
    assert r.status_code == 422 and "already a member" in r.json()["detail"]
    chk = (
        await c.get(
            f"/projects/{pid}/ai/check-name", params={"name": "claude code · backend"}
        )
    ).json()
    assert chk["conflict"] == "ai" and chk["suggestion"] == "claude code · backend 2"
    members = (await c.get(f"/projects/{pid}/members")).json()
    assert {x["kind"] for x in members} == {"human", "ai"}
    # People cannot remove an AI member through the people endpoint
    r = await c.delete(f"/projects/{pid}/members/{m['id']}")
    assert r.status_code == 400


async def test_api_key_member_key_is_encrypted_and_never_returned(env):
    c = env["c"]
    pid, _ = await _project(c)
    r = await c.post(
        f"/projects/{pid}/ai/members",
        json={
            "name": "Reviewer (Claude API)",
            "provider": "anthropic",
            "api_key": "sk-ant\x2dapi03-SECRET\x56ALUE3f9a",
            "daily_budget": 5,
            "monthly_cap": 120,
        },
    )
    assert r.status_code == 201
    assert "SECRET\x56ALUE" not in r.text and r.json()["key_last4"] == "3f9a"
    from models import AiMember

    async with env["maker"]() as s:
        row = await s.get(AiMember, r.json()["id"])
        assert (
            "SECRET\x56ALUE" not in row.key_enc
            and secrets.decrypt(row.key_enc) == "sk-ant\x2dapi03-SECRET\x56ALUE3f9a"
        )
    bad = await c.post(
        f"/projects/{pid}/ai/members",
        json={
            "name": "X",
            "provider": "anthropic",
            "api_key": "k",
            "daily_budget": 5,
            "monthly_cap": 4,
        },
    )
    assert (
        bad.status_code == 422 and "at least the daily budget" in bad.json()["detail"]
    )
    done = await c.post(
        f"/projects/{pid}/ai/members",
        json={"name": "Y", "provider": "claude-code", "ceiling": "done"},
    )
    assert done.status_code == 422 and "extra confirmation" in done.json()["detail"]


async def test_test_connection_detects_cli_and_login(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    r = (await c.post(f"/ai/members/{m['id']}/test", json={"full": True})).json()
    assert r["ok"] and "pong" in r["message"] and r["version"].startswith("9.9.9")
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "logged_out")
    r = (await c.post(f"/ai/members/{m['id']}/test", json={"full": True})).json()
    assert not r["ok"] and r["health"] == "not_logged_in"
    m2 = (await c.get(f"/ai/members/{m['id']}")).json()
    assert m2["status"]["code"] == "not_logged_in"
    await c.patch(f"/ai/members/{m['id']}", json={"cli_path": "/nope/claude"})
    monkeypatch.setenv("PATH", "/nonexistent")
    monkeypatch.setattr("services.ai.cli._SEARCH_DIRS", [])
    r = (await c.post(f"/ai/members/{m['id']}/test", json={"full": False})).json()
    assert r["health"] == "runner_missing"


# --------------------------------------------------------------------------- run lifecycle (fake CLI)


async def test_assign_runs_to_review_with_summary_and_attribution(env, monkeypatch):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    r = await c.post(
        f"/tickets/{tid}/ai/assign",
        json={"member_id": m["id"], "start": "now"},
        headers={"X-Actor": "An Nguyen"},
    )
    assert r.status_code == 200 and r.json()["run"]["state"] == "queued"
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    assert run["status_changes"] == [
        {"from": "todo", "to": "in-progress", "at": run["status_changes"][0]["at"]},
        {"from": "in-progress", "to": "review", "at": run["status_changes"][1]["at"]},
    ]
    assert [f["path"] for f in run["files"]] == ["calc.py"]
    assert any(
        "sk-ant\x2dsecret" not in s["text"] and "pytest" in s["text"]
        for s in run["steps"]
    )
    assert not any("sk-ant\x2dsecret123456" in s["text"] for s in run["steps"])
    ticket = (await c.get(f"/tickets/{tid}")).json()
    assert ticket["status"] == "review"
    summary = ticket["comments"][-1]
    assert (
        summary["author"] == "Claude Code · Backend"
        and summary["ai"]["kind"] == "summary"
    )
    moves = [e for e in ticket["activity_log"] if e["field"] == "status"]
    assert all(
        e["actor"] == "Claude Code · Backend" and e["on_behalf_of"] == "An Nguyen"
        for e in moves
    )
    args = json.loads(record.read_text().splitlines()[0])
    assert (
        "--permission-mode" in args
        and args[args.index("--permission-mode") + 1] == "dontAsk"
    )
    assert (
        "--dangerously-skip-permissions" not in args and "--strict-mcp-config" in args
    )
    mcp = json.loads(args[args.index("--mcp-config") + 1])
    assert mcp["mcpServers"]["kanban"]["headers"]["Authorization"].startswith(
        "Bearer kbr_"
    )
    async with env["maker"]() as s:
        row = await s.get(AiRun, run["id"])
        assert row.token_hash is None  # the token dies with the run


async def test_one_holder_per_ticket_even_under_concurrent_requests(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    a = await _runner(c, pid, env["repo"])
    b = await _runner(c, pid, env["repo"], name="Second AI")
    tid = await _ticket(c, pid)
    results = await asyncio.gather(
        *[
            c.post(f"/tickets/{tid}/ai/run", json={"member_id": who["id"]})
            for who in (a, b, a, b)
        ]
    )
    codes = sorted(r.status_code for r in results)
    assert codes.count(200) == 1 and all(code == 409 for code in codes if code != 200)
    run = await _wait(c, tid, ("running",))
    r = await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": b["id"], "start": "now"}
    )
    assert r.status_code == 409 and "held" in r.json()["detail"]
    # Ask runs do not take the hold
    r = await c.post(
        f"/tickets/{tid}/ai/ask", json={"member_id": b["id"], "question": "Why?"}
    )
    assert r.status_code == 200
    await c.post(f"/ai/runs/{run['id']}/cancel", json={})


async def test_cancel_kills_the_whole_process_tree_and_returns_the_status(
    env, monkeypatch
):
    c = env["c"]
    pidfile = env["tmp"] / "child.pid"
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "spawn")
    monkeypatch.setenv("FAKE_CLAUDE_PIDFILE", str(pidfile))
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("running",))
    for _ in range(50):
        if pidfile.exists() and pidfile.read_text():
            break
        await asyncio.sleep(0.1)
    child = int(pidfile.read_text())
    async with env["maker"]() as s:
        cli_pid = (await s.get(AiRun, run["id"])).pid
    assert _alive(child) and _alive(cli_pid)
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "in-progress"
    r = await c.post(f"/ai/runs/{run['id']}/cancel", json={"reason": "Not needed"})
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    for _ in range(40):
        if not _alive(child) and not _alive(cli_pid):
            break
        await asyncio.sleep(0.1)
    assert not _alive(child), "grandchild process leaked"
    assert not _alive(cli_pid), "CLI process leaked"
    assert (await c.get(f"/tickets/{tid}")).json()[
        "status"
    ] == "todo"  # cancel returns the status
    again = await c.post(f"/ai/runs/{run['id']}/cancel", json={})
    assert again.status_code == 409
    retry = (await c.post(f"/ai/runs/{run['id']}/retry")).json()
    assert (
        retry["number"] == 2
        and retry["state"] == "queued"
        and retry["trigger"] == "retry"
    )
    await c.post(f"/ai/runs/{retry['id']}/cancel", json={})


async def test_failure_and_idle_timeout(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "fail")
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("failed",))
    assert "Something broke" in run["ended_reason"]
    for _ in range(30):
        comments = (await c.get(f"/tickets/{tid}")).json()["comments"]
        if comments:
            break
        await asyncio.sleep(0.1)
    assert comments[-1]["ai"]["kind"] == "failed"
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    from models import AiMember

    async with env["maker"]() as s:
        p = await s.get(AiMember, m["id"])
        cfg = json.loads(p.config)
        cfg["idle_timeout_min"] = (
            0.02  # ~1 s, set directly: the API keeps at least 1 minute
        )
        p.config = json.dumps(cfg)
        s.add(p)
        await s.commit()
    tid2 = await _ticket(c, pid, title="Slow")
    await c.post(
        f"/tickets/{tid2}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid2, ("timed_out",), timeout=20)
    assert "No output" in run["ended_reason"]


async def test_needs_input_sets_pending_and_the_answer_resumes_the_session(
    env, monkeypatch
):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    _ask_gate(env, monkeypatch)
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign",
        json={"member_id": m["id"], "start": "now"},
        headers={"X-Actor": "An Nguyen"},
    )
    run = await _wait(c, tid, ("running",))
    ctx = RunContext(
        run_id=run["id"],
        member_id=m["id"],
        member_name=m["name"],
        project_id=pid,
        ticket_id=tid,
        on_behalf_of="An Nguyen",
        mode="work",
    )
    await runs.record_question(ctx, "Cursor or offset?", ["Cursor", "Offset"])
    run = await _wait(c, tid, ("needs_input",))
    assert (
        run["question"]["text"] == "Cursor or offset?"
        and run["question"]["to"] == "An Nguyen"
    )
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["pending"] and "asks: Cursor or offset?" in t["pending_note"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    r = await c.post(
        f"/ai/runs/{run['id']}/answer",
        json={"text": "Cursor"},
        headers={"X-Actor": "An Nguyen"},
    )
    assert r.status_code == 200
    run2 = await _wait(c, tid, ("finished",))
    assert run2["id"] == run["id"]  # the same run continues
    lines = [json.loads(x) for x in record.read_text().splitlines()]
    assert (
        "--resume" in lines[-1]
        and lines[-1][lines[-1].index("--resume") + 1] == run["session_id"]
    )
    t = (await c.get(f"/tickets/{tid}")).json()
    assert not t["pending"] and t["status"] == "review"
    assert any(cm["text"].startswith("**Answer:** Cursor") for cm in t["comments"])


async def test_runs_wait_for_slots_pause_and_daily_limit(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], max_parallel=1, max_runs_per_day=2)
    t1, t2 = await _ticket(c, pid, "A"), await _ticket(c, pid, "B")
    await c.post(
        f"/tickets/{t1}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await c.post(
        f"/tickets/{t2}/ai/assign", json={"member_id": m["id"], "start": "queue"}
    )
    await _wait(c, t1, ("running",))
    await runs.tick()
    board = {
        r["ticket_id"]: r
        for r in (await c.get(f"/projects/{pid}/ai/board")).json()["runs"]
    }
    assert board[t2]["state"] == "queued" and "free slot" in board[t2]["waiting_reason"]
    assert board[t2]["queue_position"] == 1
    await c.post(f"/ai/members/{m['id']}/pause", json={"cancel_current": True})
    await _wait(c, t1, ("cancelled",))
    await runs.tick()
    assert (await c.get(f"/tickets/{t2}/ai/runs")).json()[0]["state"] == "queued"
    await c.post(f"/ai/members/{m['id']}/resume")
    await _wait(c, t2, ("running",))
    for r in (await c.get(f"/projects/{pid}/ai/runs", params={"active": True})).json():
        await c.post(f"/ai/runs/{r['id']}/cancel", json={})


# --------------------------------------------------------------------------- guard (what an AI run may do)


async def _ctx(env, *, ceiling="review", template="developer", mode="work"):
    c = env["c"]
    pid, an = await _project(c)
    m = await _runner(c, pid, env["repo"], ceiling=ceiling, template=template)
    tid = await _ticket(c, pid)
    await c.patch(f"/tickets/{tid}", json={"assignee": m["id"]})
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=m["id"],
            state="running",
            started_by="An Nguyen",
            mode=mode,
            token_hash=guard.token_hash("kbr_test"),
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
    ctx = await guard.context_for_token("kbr_test")
    return ctx, pid, an, m, tid


async def test_guard_allows_blocks_and_parks_for_approval(env):
    from kanban_mcp.tools.tickets import manage_ticket

    ctx, pid, an, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        out = await manage_ticket(action="update", ticket_id=tid, priority="high")
        assert out["priority"] == "high"
        with pytest.raises(ValueError, match="status_ceiling"):
            await manage_ticket(action="update", ticket_id=tid, status="done")
        with pytest.raises(ValueError, match="NEEDS_APPROVAL"):
            await manage_ticket(action="update", ticket_id=tid, assignee=an)
        with pytest.raises(ValueError, match="BLOCKED"):
            await manage_ticket(action="delete", ticket_id=tid)
    finally:
        guard.leave(tokens)
    c = env["c"]
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["status"] == "todo" and t["assignee"] == m["id"]
    assert t["comments"][-1]["ai"]["kind"] == "move_blocked"
    edit = [e for e in t["activity_log"] if e["field"] == "priority"][0]
    assert edit["actor"] == m["name"] and edit["on_behalf_of"] == "An Nguyen"
    approvals = (
        await c.get(f"/projects/{pid}/ai/approvals", params={"status": "pending"})
    ).json()
    assert len(approvals) == 1 and approvals[0]["action"] == "change_assignee"
    assert approvals[0]["params"] == {"ticket_id": tid, "assignee": an}
    r = await c.post(
        f"/ai/approvals/{approvals[0]['id']}/approve",
        json={},
        headers={"X-Actor": "An Nguyen"},
    )
    assert r.json()["status"] == "approved"
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["assignee"] == an
    audit_ = (await c.get(f"/projects/{pid}/ai/audit")).json()
    assert {"allowed", "blocked", "needs_approval", "approved"} <= set(audit_["counts"])
    assert (await c.get(f"/projects/{pid}/ai/audit/verify")).json()["ok"]


async def test_ask_runs_cannot_write_and_ended_tokens_are_dead(env):
    from kanban_mcp.tools.items import ticket_items

    ctx, pid, an, m, tid = await _ctx(env, mode="ask")
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="Ask runs only read"):
            await ticket_items(
                ticket_id=tid, item="comment", action="add", text="hi", author="x"
            )
    finally:
        guard.leave(tokens)
    async with env["maker"]() as s:
        run = (await s.exec(select(AiRun))).first()
        run.state = "cancelled"
        s.add(run)
        await s.commit()
    with pytest.raises(guard.AiActionError, match="has ended"):
        await guard.context_for_token("kbr_test")


async def test_scope_blocks_other_tickets_and_comments_are_attributed(env):
    from kanban_mcp.tools.items import ticket_items
    from kanban_mcp.tools.tickets import manage_ticket

    ctx, pid, an, m, tid = await _ctx(env)
    other = await _ticket(env["c"], pid, title="Not mine")
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="outside this AI member's scope"):
            await manage_ticket(action="update", ticket_id=other, priority="low")
        out = await ticket_items(
            ticket_id=tid,
            item="comment",
            action="add",
            text="Progress",
            author="Claude",
        )
    finally:
        guard.leave(tokens)
    comment = out["comments"][-1]
    assert comment["author"] == m["name"]  # the AI cannot pose as someone else
    t = (await env["c"].get(f"/tickets/{tid}")).json()
    assert t["comments"][-1]["ai"]["run_id"] == ctx.run_id


async def test_deny_posts_the_reason_and_approvals_expire(env):
    from kanban_mcp.tools.tickets import manage_ticket

    ctx, pid, an, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        for _ in range(2):
            with pytest.raises(ValueError, match="NEEDS_APPROVAL"):
                await manage_ticket(action="update", ticket_id=tid, assignee=an)
    finally:
        guard.leave(tokens)
    c = env["c"]
    pending = (
        await c.get(f"/projects/{pid}/ai/approvals", params={"status": "pending"})
    ).json()
    r = await c.post(
        f"/ai/approvals/{pending[0]['id']}/deny", json={"note": "Wrong target"}
    )
    assert r.json()["status"] == "denied"
    assert (
        "Wrong target"
        in (await c.get(f"/tickets/{tid}")).json()["comments"][-1]["text"]
    )
    assert (
        await c.post(f"/ai/approvals/{pending[0]['id']}/approve", json={})
    ).status_code == 409
    async with env["maker"]() as s:
        a = await s.get(AiApproval, pending[1]["id"])
        a.expires_at = "2000-01-01T00:00:00+00:00"
        s.add(a)
        await s.commit()
    left = (
        await c.get(f"/projects/{pid}/ai/approvals", params={"status": "pending"})
    ).json()
    assert left == []


# --------------------------------------------------------------------------- mentions


async def test_mention_meanings_and_ai_chain_limit(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, an = await _project(c)
    a = await _runner(c, pid, env["repo"])
    b = await _runner(c, pid, env["repo"], name="Reviewer")
    tid = await _ticket(c, pid)
    pill = f"@[{a['name']}](member:{a['id']})"
    await c.post(
        f"/tickets/{tid}/comments",
        json={"text": f"{pill} fyi", "author": "An Nguyen", "ai_intent": "notify"},
    )
    assert (await c.get(f"/tickets/{tid}/ai/runs")).json() == []
    await c.post(
        f"/tickets/{tid}/comments",
        json={"text": f"{pill} why?", "author": "An Nguyen", "ai_intent": "ask"},
    )
    runs_ = (await c.get(f"/tickets/{tid}/ai/runs")).json()
    assert runs_[0]["mode"] == "ask" and runs_[0]["instruction"] == f"@{a['name']} why?"
    await c.post(
        f"/tickets/{tid}/comments",
        json={"text": f"{pill} please fix", "author": "An Nguyen", "ai_intent": "work"},
    )
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["assignee"] == a["id"]
    assert (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]["mode"] == "work"
    # AI → AI: the chain stops at the max depth, and a member already in it is not woken again
    ctx = RunContext(
        run_id="run_x",
        member_id=b["id"],
        member_name=b["name"],
        project_id=pid,
        ticket_id=tid,
        on_behalf_of="An Nguyen",
        mode="work",
        chain=[a["id"]],
    )
    from services.ai import mentions

    await mentions.from_ai_comment(
        ctx, tid, {"id": "c1", "text": f"{pill} can you check?"}
    )
    note = (await c.get(f"/tickets/{tid}")).json()["comments"][-1]
    assert note["author"] == "Board" and "already in it" in note["text"]
    for r in (await c.get(f"/projects/{pid}/ai/runs", params={"active": True})).json():
        await c.post(f"/ai/runs/{r['id']}/cancel", json={})


# --------------------------------------------------------------------------- kill switch


async def test_pause_all_cancels_holds_and_resume_needs_review(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], max_parallel=1)
    t1, t2 = await _ticket(c, pid, "A"), await _ticket(c, pid, "B")
    await c.post(
        f"/tickets/{t1}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, t1, ("running",))
    await c.post(
        f"/tickets/{t2}/ai/assign", json={"member_id": m["id"], "start": "queue"}
    )
    r = (
        await c.post(
            f"/projects/{pid}/ai/pause-all", json={"reason": "Unexpected changes"}
        )
    ).json()
    assert (r["cancelled"], r["held"]) == (1, 1)
    await _wait(c, t1, ("cancelled",))
    await runs.tick()
    assert (await c.get(f"/tickets/{t2}/ai/runs")).json()[0]["state"] == "queued"
    pill = f"@[{m['name']}](member:{m['id']})"
    await c.post(
        f"/tickets/{t1}/comments", json={"text": f"{pill} hi", "author": "An Nguyen"}
    )
    assert (
        "AI is paused" in (await c.get(f"/tickets/{t1}")).json()["comments"][-1]["text"]
    )
    assert (await c.post(f"/projects/{pid}/ai/resume-all", json={})).status_code == 422
    r = await c.post(
        f"/projects/{pid}/ai/resume-all", json={"reviewed": True, "safe_mode": True}
    )
    assert r.status_code == 200
    s = (await c.get(f"/projects/{pid}/ai/overview")).json()["settings"]
    assert s["paused_all"] is False and s["safe_mode"] is True
    await _wait(c, t2, ("running",))
    for r in (await c.get(f"/projects/{pid}/ai/runs", params={"active": True})).json():
        await c.post(f"/ai/runs/{r['id']}/cancel", json={})


async def test_remove_with_work_in_flight(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, an = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, tid, ("running",))
    impact = (await c.get(f"/ai/members/{m['id']}/removal-impact")).json()
    assert len(impact["open_tickets"]) == 1 and len(impact["active_runs"]) == 1
    r = await c.post(
        f"/ai/members/{m['id']}/remove",
        json={"tickets": "reassign", "reassign_to": an, "runs": "cancel"},
    )
    assert r.json()["removed"] is True
    assert (await c.get(f"/tickets/{tid}")).json()["assignee"] == an
    assert (await c.get(f"/projects/{pid}/ai/members")).json() == []
    await _wait(c, tid, ("cancelled",))


# --------------------------------------------------------------------------- API-key agent loop (fake provider)


class FakeChat:
    """Scripted model: each call returns the next reply."""

    def __init__(self, script):
        self.script = list(script)
        self.results = []

    def start(self, system, user, tools):
        self.system, self.user, self.tools = system, user, tools

    async def call(self, max_tokens):
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    def add_results(self, results):
        self.results.extend(results)

    def add_user(self, text):
        pass


async def _api_member(c, pid, **extra):
    r = await c.post(
        f"/projects/{pid}/ai/members",
        json={
            "name": "Reviewer (Claude API)",
            "provider": "anthropic",
            "api_key": "sk-ant\x2dapi03-zzzzzzzzzzzz3f9a",
            "model": "claude-haiku-5-5",
            "daily_budget": 5,
            **extra,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_api_agent_loop_runs_board_tools_through_the_guard(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid)
    tid = await _ticket(c, pid)
    fake = FakeChat(
        [
            api_agent.Reply(
                tool_calls=[
                    {
                        "id": "1",
                        "name": "update_ticket",
                        "input": {"ticket_id": tid, "estimate": 3},
                    }
                ],
                tokens_in=1000,
                tokens_out=50,
            ),
            api_agent.Reply(
                tool_calls=[
                    {
                        "id": "2",
                        "name": "update_ticket",
                        "input": {"ticket_id": tid, "status": "done"},
                    }
                ],
                tokens_in=1200,
                tokens_out=40,
            ),
            api_agent.Reply(
                text="Estimated at 3 points.", tokens_in=1300, tokens_out=30
            ),
        ]
    )
    monkeypatch.setattr(api_agent, "make_chat", lambda *a, **k: fake)
    await c.post(
        f"/tickets/{tid}/ai/assign",
        json={"member_id": m["id"], "start": "now"},
        headers={"X-Actor": "An Nguyen"},
    )
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    assert run["tokens_in"] == 3500 and run["cost_usd"] > 0 and run["metered"]
    assert fake.results[1][1].startswith("ERROR: BLOCKED (status_ceiling)")
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["estimate"] == 3 and t["status"] == "review"
    assert "SECRET\x56ALUE" not in json.dumps(run) and "zzzzzzzz" not in json.dumps(run)
    assert "untrusted" in fake.system


async def test_api_agent_stops_on_invalid_key_rate_limits_and_step_limit(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, config={"max_steps": 2, "retries": 1})
    t1 = await _ticket(c, pid, "A")
    monkeypatch.setattr(
        api_agent,
        "make_chat",
        lambda *a, **k: FakeChat([api_agent.ProviderError("auth", "401")]),
    )
    await c.post(
        f"/tickets/{t1}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, t1, ("failed",))
    member = (await c.get(f"/ai/members/{m['id']}")).json()
    assert member["status"]["code"] == "key_invalid"
    # A new key clears the state; rate limits are retried, then a run stops at its step limit
    await c.patch(f"/ai/members/{m['id']}", json={"api_key": "sk-ant\x2dnew-key-1234"})
    loop_reply = api_agent.Reply(
        tool_calls=[{"id": "x", "name": "get_ticket", "input": {}}]
    )
    monkeypatch.setattr(
        api_agent,
        "make_chat",
        lambda *a, **k: FakeChat(
            [api_agent.ProviderError("rate", "429"), loop_reply, loop_reply]
        ),
    )
    t2 = await _ticket(c, pid, "B")
    await c.post(
        f"/tickets/{t2}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, t2, ("failed",))
    assert "step limit" in run["ended_reason"]
    assert any(s["kind"] == "retry" for s in run["steps"])


async def test_budget_stops_new_runs(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, daily_budget=0.0001)
    tid = await _ticket(c, pid)
    monkeypatch.setattr(
        api_agent,
        "make_chat",
        lambda *a, **k: FakeChat(
            [api_agent.Reply(text="done", tokens_in=100000, tokens_out=1000)]
        ),
    )
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, tid, ("finished",))
    t2 = await _ticket(c, pid, "B")
    await c.post(
        f"/tickets/{t2}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await runs.tick()
    board = {
        r["ticket_id"]: r
        for r in (await c.get(f"/projects/{pid}/ai/board")).json()["runs"]
    }
    assert (
        board[t2]["state"] == "queued" and "Over budget" in board[t2]["waiting_reason"]
    )
    assert (await c.get(f"/ai/members/{m['id']}")).json()["status"][
        "code"
    ] == "over_budget"


# --------------------------------------------------------------------------- audit and revert


async def test_audit_chain_detects_tampering_and_revert_skips_conflicts(env):
    from kanban_mcp.tools.tickets import manage_ticket

    ctx, pid, an, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        await manage_ticket(action="update", ticket_id=tid, estimate=2)
        await manage_ticket(action="update", ticket_id=tid, priority="critical")
    finally:
        guard.leave(tokens)
    c = env["c"]
    await c.patch(f"/tickets/{tid}", json={"estimate": 5})  # a person changes it again
    preview = (await c.get(f"/ai/runs/{ctx.run_id}/revert-preview")).json()
    assert {(p["field"], p["conflict"]) for p in preview} == {
        ("estimate", True),
        ("priority", False),
    }
    result = (await c.post(f"/ai/runs/{ctx.run_id}/revert")).json()
    assert sorted(r["result"] for r in result) == ["reverted", "skipped"]
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["estimate"] == 5 and t["priority"] == "medium"
    assert (await c.get(f"/projects/{pid}/ai/audit/verify")).json()["ok"]
    async with env["maker"]() as s:
        row = (await s.exec(select(AiAudit).where(AiAudit.result == "allowed"))).first()
        row.detail = json.dumps({"tampered": True})
        s.add(row)
        await s.commit()
    v = (await c.get(f"/projects/{pid}/ai/audit/verify")).json()
    assert v["ok"] is False and v["broken_at"] == row.id
    csv_ = (await c.get(f"/projects/{pid}/ai/audit/export")).text
    assert "time,ai,on_behalf_of" in csv_


async def test_deleting_a_ticket_cancels_its_run(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("running",))
    assert (await c.delete(f"/tickets/{tid}")).status_code == 204
    async with env["maker"]() as s:
        row = await s.get(AiRun, run["id"])
        assert row.state == "cancelled" and "deleted" in row.ended_reason
        assert await s.get(Ticket, tid) is None


async def test_audit_record_is_append_only_chain():
    assert (
        audit._digest(
            "",
            AiAudit(
                project_id="p",
                action="a",
                result="info",
                seq=1,
                detail="{}",
                created_at="t",
            ),
        )
        != ""
    )


def test_fake_cli_is_executable():
    assert os.access(FAKE, os.X_OK) and sys.executable


async def test_a_long_question_still_sets_pending_and_waits(env, monkeypatch):
    """Regression: a question longer than a Pending note (240 chars) used to fail the run."""
    c = env["c"]
    _ask_gate(env, monkeypatch)
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign",
        json={"member_id": m["id"], "start": "now"},
        headers={"X-Actor": "An Nguyen"},
    )
    run = await _wait(c, tid, ("running",))
    ctx = RunContext(
        run_id=run["id"],
        member_id=m["id"],
        member_name=m["name"],
        project_id=pid,
        ticket_id=tid,
        on_behalf_of="An Nguyen",
        mode="work",
    )
    await runs.record_question(ctx, "Should we round? " * 40, ["Yes", "No"])
    run = await _wait(c, tid, ("needs_input", "failed"))
    assert run["state"] == "needs_input"
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["pending"] and len(t["pending_note"]) <= 240
    await c.post(f"/ai/runs/{run['id']}/cancel", json={})


async def test_a_mention_acts_for_the_person_sending_it(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    pill = f"@[{m['name']}](member:{m['id']})"
    await c.post(
        f"/tickets/{tid}/comments",
        json={"text": f"{pill} why?", "author": "user", "ai_intent": "ask"},
        headers={"X-Actor": "Hoa Mai"},
    )
    run = (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]
    assert run["started_by"] == "Hoa Mai"
    await c.post(f"/ai/runs/{run['id']}/cancel", json={})
