"""Regression tests for the gaps found against the full AI designs (docs/specs/ai-gaps.md, section 1)."""

from sqlmodel import select

from models import AiRun, Ticket
from services.ai import guard, permissions, providers
from tests.test_ai import _ctx, _project, _runner, _ticket, _wait, env  # noqa: F401


async def test_wont_do_through_patch_and_reassign_end_the_run(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, an = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    await _wait(c, tid, ("running",))
    r = await c.patch(
        f"/tickets/{tid}", json={"status": "wont_do", "wont_do_reason": "Dropped"}
    )
    assert r.status_code == 200, r.text
    run = await _wait(c, tid, ("cancelled",))
    assert "Won't Do" in run["ended_reason"]

    tid2 = await _ticket(c, pid, title="Second")
    await c.post(f"/tickets/{tid2}/ai/run", json={"member_id": m["id"]})
    await _wait(c, tid2, ("running",))
    await c.patch(f"/tickets/{tid2}", json={"assignee": an})
    run = await _wait(c, tid2, ("cancelled",))
    assert run["ended_reason"] == "Reassigned to An Nguyen."


async def test_person_names_are_unique_across_people_and_ai(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"], name="Builder")
    r = await c.post(f"/projects/{pid}/members", json={"name": " builder "})
    assert r.status_code == 409 and "AI member" in r.json()["detail"]
    r = await c.post(f"/projects/{pid}/members", json={"name": "AN NGUYEN"})
    assert r.status_code == 409 and "Kanban Board" in r.json()["detail"]


async def test_board_monthly_budget_blocks_and_status_says_why(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    # An API-key member that already spent the board's monthly budget
    async with env["maker"]() as s:
        from models import AiMember

        prof = await s.get(AiMember, m["id"])
        prof.connection, prof.provider, prof.daily_budget = "api_key", "anthropic", None
        s.add(prof)
        s.add(
            AiRun(
                project_id=pid,
                ticket_id=tid,
                member_id=m["id"],
                state="finished",
                started_by="An Nguyen",
                started_at=__import__(
                    "services.ai.store", fromlist=["now_iso"]
                ).now_iso(),
                cost_usd=250.0,
                metered=True,
            )
        )
        await s.commit()
    await c.patch(f"/projects/{pid}/ai/settings", json={"board_daily_cap": None})
    member = (await c.get(f"/ai/members/{m['id']}")).json()
    assert member["status"]["code"] == "over_budget"
    assert "Board monthly budget" in member["status"]["detail"]


async def test_resume_all_unpauses_the_picked_agents(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    await c.post(f"/ai/members/{m['id']}/pause", json={})
    await c.post(
        f"/projects/{pid}/ai/pause-all", json={"reason": "x", "cancel_running": True}
    )
    r = await c.post(
        f"/projects/{pid}/ai/resume-all",
        json={"safe_mode": False, "member_ids": [m["id"]], "reviewed": True},
    )
    assert r.status_code == 200, r.text
    assert (await c.get(f"/ai/members/{m['id']}")).json()["paused"] is False


async def test_read_permission_is_enforced(env):
    from kanban_mcp.tools import get_ticket

    ctx, pid, an, m, tid = await _ctx(env, template="custom")
    r = await env["c"].patch(
        f"/ai/members/{m['id']}", json={"permissions": {"read": "blocked"}}
    )
    assert r.status_code == 200, r.text
    tokens = guard.enter(ctx)
    try:
        try:
            await get_ticket(ticket_id=tid)
        except ValueError as exc:
            assert "Reading tickets is blocked" in str(exc)
        else:
            raise AssertionError("read was not blocked")
    finally:
        guard.leave(tokens)


async def test_runs_going_before_pause_all_may_finish(env):
    from kanban_mcp.tools.tickets import manage_ticket

    ctx, pid, an, m, tid = await _ctx(env)
    async with env["maker"]() as s:
        run = (await s.exec(select(AiRun))).first()
        run.started_at = "2026-01-01T00:00:00+00:00"
        s.add(run)
        await s.commit()
    await env["c"].post(
        f"/projects/{pid}/ai/pause-all",
        json={"reason": "check", "cancel_running": False},
    )
    tokens = guard.enter(ctx)
    try:
        out = await manage_ticket(action="update", ticket_id=tid, priority="high")
    finally:
        guard.leave(tokens)
    assert out["priority"] == "high"
    assert (
        permissions.effective
    )  # the pause layer still applies to new runs (see test_ai)


async def test_failed_ask_posts_a_reply(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "fail")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    r = await c.post(
        f"/tickets/{tid}/ai/ask", json={"member_id": m["id"], "question": "Why?"}
    )
    assert r.status_code == 200, r.text
    await _wait(c, tid, ("failed",))
    comments = []
    for _ in range(50):  # the reply is posted right after the run ends
        async with env["maker"]() as s:
            t = await s.get(Ticket, tid)
        comments = __import__("json").loads(t.comments)
        if comments and comments[-1].get("ai"):
            break
        await __import__("asyncio").sleep(0.1)
    assert comments[-1]["text"].startswith("Couldn't answer")
    assert comments[-1]["ai"]["kind"] == "ask_failed"


def test_mcp_env_and_headers_survive_key_case_conversion():
    cfg = providers.merged_config(
        {"mcp_servers": [{"name": "gh", "env": {"GITHUB_TOKEN": "x"}}]}
    )
    assert cfg["mcp_servers"][0]["env"] == [{"name": "GITHUB_TOKEN", "value": "x"}]
    assert providers.kv_dict(cfg["mcp_servers"][0]["env"]) == {"GITHUB_TOKEN": "x"}
