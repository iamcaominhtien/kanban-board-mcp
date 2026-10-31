"""The `ai_team` MCP tool: reads of the AI team, `ask` (comment + run, the Docs branch), run and member control,
member creation limits, refusals inside an AI run, and the tool list size."""

import json

import pytest
from mcp.server.fastmcp.exceptions import ToolError

from kanban_mcp.operations import ai_team as ops
from kanban_mcp.tools.ai_team import AI_TEAM_OPS, ai_team
from main import mcp
from models import AiRun, AiProjectSettings
from services.ai import guard, runs
from services.ai.store import now_iso
from tests.test_ai import (  # noqa: F401  (fixtures and helpers)
    _api_member,
    _ctx,
    _project,
    _runner,
    _ticket,
    _wait,
    env,
)


async def call(tool_args: dict, tool: str = "ai_team"):
    out = await mcp.call_tool(tool, tool_args)
    if isinstance(out, tuple):
        structured = out[1]
        return structured["result"] if set(structured) == {"result"} else structured
    return json.loads(out[0].text)


async def team(**args):
    return await call(args)


async def _paused_runner(env, c, pid):
    """A runner that holds its runs queued, so a test sees them before the fake CLI finishes them."""
    m = await _runner(c, pid, env["repo"])
    await team(action="pause", member_id=m["id"], text="hold")
    return m


# --------------------------------------------------------------------------- reads


async def test_members_member_and_usage_numbers(env):
    c = env["c"]
    pid, _ = await _project(c)
    cli = await _runner(c, pid, env["repo"])
    api = await _api_member(c, pid, name="Reviewer", daily_budget=10, monthly_cap=100)
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        s.add(
            AiRun(
                project_id=pid,
                ticket_id=tid,
                member_id=api["id"],
                state="finished",
                metered=True,
                cost_usd=0.5,
                tokens_in=1000,
                tokens_out=200,
                started_at=now_iso(),
            )
        )
        await s.commit()
    rows = {m["name"]: m for m in await team(action="members", project_id=pid)}
    assert set(rows) == {"Claude Code · Backend", "Reviewer"}
    r = rows["Reviewer"]
    assert (r["provider"], r["connection"], r["status"], r["paused"]) == (
        "anthropic",
        "api_key",
        "online",
        False,
    )
    assert (
        r["spend_today"] == 0.5 and r["tokens_today"] == 1200 and r["runs_today"] == 1
    )
    assert r["running"] == 0 and r["queued"] == 0 and r["ceiling"] == "review"
    assert rows["Claude Code · Backend"]["status"] == "idle"
    assert "key" not in json.dumps(rows).lower().replace("api_key", "")

    detail = await team(action="member", member_id=api["id"])
    assert (
        detail["limits"]["daily_budget"] == 10
        and detail["limits"]["monthly_cap"] == 100
    )
    assert (
        len(detail["usage_14_days"]) == 14
        and detail["usage_14_days"][-1]["cost_usd"] == 0.5
    )
    assert detail["permissions"]["template"] == "developer"
    assert (
        "working_dir" not in detail
        and "cli_path" not in detail
        and "config" not in detail
    )

    u = await team(action="usage", project_id=pid)
    assert u["totals"]["month_spend"] == 0.5
    assert (
        u["by_member"][0]["name"] == "Reviewer" and u["by_member"][0]["cost_usd"] == 0.5
    )
    assert u["limits"]["agents"]
    with pytest.raises(ToolError, match="not found"):
        await team(action="members", project_id="nope")
    with pytest.raises(ToolError, match="not found"):
        await team(action="member", member_id=cli["id"] + "x")


async def test_runs_list_and_run_detail_with_steps(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    sent = await team(
        action="ask", member_id=m["id"], ticket_id=tid, text="What is this ticket?"
    )
    await _wait(c, tid, ("finished",))
    rows = await team(action="runs", ticket_id=tid)
    assert len(rows) == 1 and rows[0]["id"] == sent["run"]["id"]
    assert (
        rows[0]["state"] == "finished"
        and rows[0]["mode"] == "ask"
        and rows[0]["trigger"] == "ask"
    )
    assert rows[0]["member"] == m["name"] and rows[0]["started_by"] == "user"
    assert await team(action="runs", project_id=pid, active_only=True) == []
    assert len(await team(action="runs", member_id=m["id"], limit=1)) == 1
    detail = await team(action="run", run_id=rows[0]["id"], limit=3)
    assert detail["state"] == "finished" and detail["step_count"] >= 1
    assert len(detail["steps"]) <= 3 and {"kind", "text"} <= set(detail["steps"][0])
    assert "cost_usd" in detail and "status_changes" in detail
    with pytest.raises(ToolError, match="needs project_id, ticket_id or member_id"):
        await team(action="runs")
    with pytest.raises(ToolError, match="Run 'x' not found"):
        await team(action="run", run_id="x")


async def test_approvals_are_read_only_and_docs_jobs_list(env):
    c = env["c"]
    pid, _ = await _project(c)
    assert await team(action="approvals", project_id=pid) == []
    assert await team(action="docs_jobs", project_id=pid) == []
    assert "approve" not in AI_TEAM_OPS and "deny" not in AI_TEAM_OPS
    with pytest.raises(ToolError):
        await team(action="approve", run_id="x")


# --------------------------------------------------------------------------- ask


async def test_ask_posts_the_mention_comment_and_starts_an_ask_run(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _paused_runner(env, c, pid)
    tid = await _ticket(c, pid)
    out = await team(
        action="ask", member_id=m["id"], ticket_id=tid, text="Why is add() wrong?"
    )
    assert out["run"]["mode"] == "ask" and out["run"]["state"] == "queued"
    assert "paused" in out["note"]
    t = (await c.get(f"/tickets/{tid}")).json()
    comment = next(x for x in t["comments"] if x["id"] == out["comment_id"])
    assert comment["text"] == f"@[{m['name']}](member:{m['id']}) Why is add() wrong?"
    assert comment["asked_ai"] == m["id"] if "asked_ai" in comment else True
    assert t["assignee"] is None  # asking does not assign


async def test_ask_answers_in_a_comment_with_the_fake_runner(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await team(action="ask", member_id=m["id"], ticket_id=tid, text="Summarise it")
    run = await _wait(c, tid, ("finished",))
    assert run["mode"] == "ask" and run["reply_comment_id"]


async def test_ask_work_assigns_and_starts_a_work_run_and_one_agent_holds_a_ticket(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _paused_runner(env, c, pid)
    other = await _runner(c, pid, env["repo"], name="Second")
    tid = await _ticket(c, pid)
    out = await team(
        action="ask", member_id=m["id"], ticket_id=tid, text="Fix it", intent="work"
    )
    assert out["run"]["mode"] == "work" and out["run"]["trigger"] == "mention"
    assert (await c.get(f"/tickets/{tid}")).json()["assignee"] == m["id"]
    with pytest.raises(ToolError, match="held by another AI run"):
        await team(
            action="ask",
            member_id=other["id"],
            ticket_id=tid,
            text="Me too",
            intent="work",
        )
    # the refused call posted nothing and assigned nothing
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["assignee"] == m["id"] and len(t["comments"]) == 1


async def test_ask_notify_only_comments(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    out = await team(
        action="ask", member_id=m["id"], ticket_id=tid, text="FYI", intent="notify"
    )
    assert out["run"] is None and out["comment_id"]
    assert (await c.get(f"/tickets/{tid}/ai/runs")).json() == []


async def test_ask_refusals_kill_switch_inbox_unknown_and_missing_arguments(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    with pytest.raises(ToolError, match="needs ticket_id, or page_id"):
        await team(action="ask", member_id=m["id"], text="hi")
    with pytest.raises(ToolError, match="Write the text first"):
        await team(action="ask", member_id=m["id"], ticket_id=tid, text="  ")
    with pytest.raises(ToolError, match="Ticket 'NOPE-1' not found"):
        await team(action="ask", member_id=m["id"], ticket_id="NOPE-1", text="hi")
    with pytest.raises(ToolError, match="AI member 'zzz' not found"):
        await team(action="ask", member_id="zzz", ticket_id=tid, text="hi")
    with pytest.raises(ToolError, match="requires member_id, text"):
        await team(action="ask", ticket_id=tid)
    inbox = await team(
        action="create_member",
        project_id=pid,
        fields={"name": "Outside", "provider": "mcp-client"},
    )
    with pytest.raises(ToolError, match="inbox only"):
        await team(action="ask", member_id=inbox["id"], ticket_id=tid, text="hi")
    async with env["maker"]() as s:
        st = await s.get(AiProjectSettings, pid)
        if st is None:
            st = AiProjectSettings(project_id=pid)
        st.paused_all = True
        s.add(st)
        await s.commit()
    with pytest.raises(ToolError, match="kill switch"):
        await team(action="ask", member_id=m["id"], ticket_id=tid, text="hi")
    assert (await c.get(f"/tickets/{tid}")).json()["comments"] == []


async def test_ask_over_budget_member_queues_with_a_note(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, name="Cheap", daily_budget=0.001)
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        s.add(
            AiRun(
                project_id=pid,
                ticket_id=tid,
                member_id=m["id"],
                state="finished",
                metered=True,
                cost_usd=1.0,
                started_at=now_iso(),
            )
        )
        await s.commit()
    out = await team(action="ask", member_id=m["id"], ticket_id=tid, text="hi")
    assert out["run"]["state"] == "queued" and "over budget" in out["note"]


def _threads_with(monkeypatch, deliver):
    """`services.docs_ai.threads.deliver` is another slice's: patch it onto the real module, or onto a stand-in
    (with the no-op hooks docs_comments calls) while that module is not written yet."""
    import sys
    import types

    import services.docs_ai as pkg

    try:
        from services.docs_ai import threads as real
    except ImportError:
        real = types.ModuleType("services.docs_ai.threads")

        async def annotate(session, page, out):
            return None

        async def member_rows(session, project_id, members, enabled):
            return []

        real.annotate, real.member_rows = annotate, member_rows
        monkeypatch.setitem(sys.modules, "services.docs_ai.threads", real)
        monkeypatch.setattr(pkg, "threads", real, raising=False)
    monkeypatch.setattr(real, "deliver", deliver, raising=False)


async def test_ask_in_docs_thread_uses_threads_deliver(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    page = (
        await c.post(
            f"/projects/{pid}/docs/pages",
            json={"title": "Guide", "markdown": "# Guide\n\nHello."},
        )
    ).json()
    seen = []

    async def deliver(session, *, thread_id, comment_id, by, intent):
        seen.append((thread_id, comment_id, by, intent))
        return {"job_id": "dj_1"}

    _threads_with(monkeypatch, deliver)
    out = await team(
        action="ask", member_id=m["id"], page_id=page["id"], text="Is this current?"
    )
    assert out["delivered"] == {"job_id": "dj_1"}
    assert seen == [(out["thread_id"], out["comment_id"], "user", "ask")]
    body = (await c.get(f"/docs/pages/{page['id']}/comments")).json()
    thread = body["threads"][0]
    assert (
        thread["comments"][-1]["body"]
        == f"@[{m['name']}](member:{m['id']}) Is this current?"
    )
    # a reply goes in the same thread
    again = await team(
        action="ask",
        member_id=m["id"],
        page_id=page["id"],
        thread_id=out["thread_id"],
        text="And now?",
    )
    assert again["thread_id"] == out["thread_id"] and len(seen) == 2
    with pytest.raises(ToolError, match="'work' is for tickets"):
        await team(
            action="ask", member_id=m["id"], page_id=page["id"], text="x", intent="work"
        )
    with pytest.raises(ToolError, match="thread_id goes with page_id"):
        await team(
            action="ask", member_id=m["id"], ticket_id="K-1", thread_id="t", text="x"
        )


async def test_ask_in_docs_says_when_threads_deliver_is_missing(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    _threads_with(monkeypatch, None)
    monkeypatch.delattr("services.docs_ai.threads.deliver")
    with pytest.raises(ToolError, match="not available yet"):
        await team(action="ask", member_id=m["id"], page_id="p", text="x")


# --------------------------------------------------------------------------- runs and members


async def test_cancel_and_retry_a_run(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _paused_runner(env, c, pid)
    tid = await _ticket(c, pid)
    first = (await team(action="ask", member_id=m["id"], ticket_id=tid, text="one"))[
        "run"
    ]
    cancelled = await team(action="cancel", run_id=first["id"], text="not needed")
    assert cancelled["state"] == "cancelled"
    again = await team(action="retry", run_id=first["id"])
    assert again["number"] == first["number"] + 1 and again["state"] == "queued"
    with pytest.raises(ToolError, match="not found"):
        await team(action="cancel", run_id="nope")
    with pytest.raises(ToolError, match="not waiting for an answer"):
        await team(action="answer", run_id=again["id"], text="yes")
    with pytest.raises(ToolError, match="Write the text first"):
        await team(action="answer", run_id=again["id"], text=" ")


async def test_answer_resumes_a_run_waiting_for_input(env, monkeypatch):
    from services.ai.context import RunContext
    from tests.test_ai import _ask_gate

    c = env["c"]
    _ask_gate(env, monkeypatch)
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await team(
        action="ask", member_id=m["id"], ticket_id=tid, text="Fix", intent="work"
    )
    run = await _wait(c, tid, ("running",))
    ctx = RunContext(run["id"], m["id"], m["name"], pid, tid, "An Nguyen", "work")
    await runs.record_question(ctx, "Cursor or offset?", ["Cursor", "Offset"])
    waiting = await _wait(c, tid, ("needs_input",))
    assert (await team(action="run", run_id=waiting["id"]))["question"][
        "text"
    ] == "Cursor or offset?"
    assert (await team(action="runs", ticket_id=tid))[0][
        "question"
    ] == "Cursor or offset?"
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    out = await team(action="answer", run_id=waiting["id"], text="Cursor")
    assert out["id"] == waiting["id"]
    await _wait(c, tid, ("finished",))


async def test_pause_and_resume_a_member(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    paused = await team(action="pause", member_id=m["id"], text="lunch")
    assert paused["paused"] is True and paused["status"] == "paused"
    assert (await team(action="member", member_id=m["id"]))["paused_reason"] == "lunch"
    resumed = await team(action="resume", member_id=m["id"])
    assert resumed["paused"] is False and resumed["status"] == "idle"
    with pytest.raises(ToolError, match="not found"):
        await team(action="pause", member_id="zzz")


# --------------------------------------------------------------------------- creating and changing members


async def test_create_member_without_keys_bypass_folder_or_a_high_ceiling(env):
    c = env["c"]
    pid, _ = await _project(c)
    base = await _runner(c, pid, env["repo"])
    made = await team(
        action="create_member",
        project_id=pid,
        fields={
            "name": "Reviewer",
            "template": "reviewer",
            "persona": "Reviews diffs.",
            "max_parallel": 2,
        },
    )
    assert (
        made["name"] == "Reviewer"
        and made["connection"] == "local"
        and made["ceiling"] == "review"
    )
    assert made["template"] == "reviewer" and made["status"] in ("idle", "online")
    full = (await c.get(f"/ai/members/{made['id']}")).json()
    assert (
        full["working_dir"] == base["working_dir"]
    )  # copied from the existing member, never given
    assert full["config"]["permission_mode"] == "allowlist"
    assert "Bash(git diff:*)" in json.dumps(full["config"])
    # what only a person may set
    for bad in (
        "api_key",
        "confirm_bypass",
        "permission_mode",
        "working_dir",
        "permissions",
        "config",
        "key",
    ):
        with pytest.raises(ToolError, match="cannot be set over MCP"):
            await team(
                action="create_member", project_id=pid, fields={"name": "X", bad: "y"}
            )
    for ceiling in ("testing", "done"):
        with pytest.raises(ToolError, match="ceiling must be one of"):
            await team(
                action="create_member",
                project_id=pid,
                fields={"name": "X", "ceiling": ceiling},
            )
    with pytest.raises(ToolError, match="added by a person"):
        await team(
            action="create_member",
            project_id=pid,
            fields={"name": "X", "provider": "anthropic"},
        )
    with pytest.raises(ToolError, match="Unknown field"):
        await team(
            action="create_member",
            project_id=pid,
            fields={"name": "X", "colour": "red"},
        )
    with pytest.raises(ToolError, match="template must be one of"):
        await team(
            action="create_member",
            project_id=pid,
            fields={"name": "X", "template": "custom"},
        )
    with pytest.raises(ToolError, match="already"):
        await team(action="create_member", project_id=pid, fields={"name": "reviewer"})
    with pytest.raises(ToolError, match="name is required"):
        await team(action="create_member", project_id=pid, fields={})
    members = await team(action="members", project_id=pid)
    assert {x["name"] for x in members} == {base["name"], "Reviewer"}


async def test_update_member_stays_inside_the_same_limits(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    out = await team(
        action="update_member",
        member_id=m["id"],
        fields={
            "name": "Backend",
            "persona": "Owns the API.",
            "max_parallel": 3,
            "ceiling": "in-progress",
        },
    )
    assert out["name"] == "Backend" and out["ceiling"] == "in-progress"
    detail = await team(action="member", member_id=m["id"])
    assert (
        detail["persona"] == "Owns the API." and detail["limits"]["max_parallel"] == 3
    )
    with pytest.raises(ToolError, match="ceiling must be one of"):
        await team(
            action="update_member", member_id=m["id"], fields={"ceiling": "done"}
        )
    with pytest.raises(ToolError, match="cannot be set over MCP"):
        await team(
            action="update_member", member_id=m["id"], fields={"api_key": "sk-x"}
        )
    with pytest.raises(ToolError, match="cannot be set over MCP"):
        await team(
            action="update_member",
            member_id=m["id"],
            fields={"config": {"permission_mode": "bypass"}},
        )
    with pytest.raises(ToolError, match="Max parallel"):
        await team(
            action="update_member", member_id=m["id"], fields={"max_parallel": 99}
        )
    with pytest.raises(ToolError, match="fields is empty"):
        await team(action="update_member", member_id=m["id"], fields={})
    with pytest.raises(ToolError, match="provider"):
        await team(
            action="update_member", member_id=m["id"], fields={"provider": "openai"}
        )


# --------------------------------------------------------------------------- inside an AI run, argument checks


async def test_acts_are_refused_inside_an_ai_run_but_reads_work(env):
    ctx, pid, _, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        assert len(await ai_team("members", project_id=pid)) == 1
        assert (await ai_team("member", member_id=m["id"]))["id"] == m["id"]
        assert isinstance(await ai_team("runs", ticket_id=tid), list)
        assert (await ai_team("usage", project_id=pid))["totals"]
        for action, args in (
            ("ask", {"member_id": m["id"], "ticket_id": tid, "text": "hi"}),
            ("cancel", {"run_id": ctx.run_id}),
            ("retry", {"run_id": ctx.run_id}),
            ("answer", {"run_id": ctx.run_id, "text": "x"}),
            ("pause", {"member_id": m["id"]}),
            ("resume", {"member_id": m["id"]}),
            ("create_member", {"project_id": pid, "fields": {"name": "Sneaky"}}),
            ("update_member", {"member_id": m["id"], "fields": {"name": "Mine"}}),
        ):
            with pytest.raises(
                ValueError, match="cannot start AIs or change AI members"
            ):
                await ai_team(action, **args)
    finally:
        guard.leave(tokens)
    names = {x["name"] for x in await team(action="members", project_id=pid)}
    assert names == {m["name"]}


async def test_inside_a_run_the_project_is_the_runs_own_when_left_out(env):
    ctx, pid, _, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        assert [x["id"] for x in await ai_team("members")] == [m["id"]]
        assert (await ai_team("usage"))["totals"]
    finally:
        guard.leave(tokens)


def test_the_run_tool_schema_spells_out_the_report_fields():
    # a bare "object" gave Antigravity nothing to build and it sent nulls ("criteria.0 Input should be a valid dictionary")
    from mcp.server.fastmcp.utilities.func_metadata import func_metadata

    from kanban_mcp.tools.ai_run import ai_run

    props = func_metadata(ai_run).arg_model.model_json_schema()["properties"]
    item = next(b for b in props["criteria"]["anyOf"] if b.get("type") == "array")[
        "items"
    ]
    assert set(item["properties"]) == {"text", "met", "evidence"}
    assert item["required"] == ["text", "met"]
    tests = next(b for b in props["tests"]["anyOf"] if b.get("type") == "object")
    assert set(tests["properties"]) == {"passed", "failed"}


async def test_the_run_tool_ignores_a_ticket_id_a_model_adds(env):
    from kanban_mcp.tools.ai_run import ai_run

    ctx, pid, _, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        out = await ai_run("report", summary="Done", ticket_id=tid)
        assert out
    finally:
        guard.leave(tokens)


async def test_a_run_reads_only_its_own_project_and_honours_read_permission(env):
    c = env["c"]
    ctx, pid, _, m, tid = await _ctx(env)
    other = (
        await c.post(
            "/projects", json={"name": "Other", "prefix": "OTH", "color": "#2E6F40"}
        )
    ).json()["id"]
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="own project"):
            await ai_team("members", project_id=other)
        await c.patch(
            f"/ai/members/{m['id']}", json={"permissions": {"read": "blocked"}}
        )
        with pytest.raises(ValueError, match="Reading tickets is blocked"):
            await ai_team("members", project_id=pid)
    finally:
        guard.leave(tokens)


async def test_unknown_and_missing_arguments_are_explained(env):
    c = env["c"]
    pid, _ = await _project(c)
    with pytest.raises(ToolError, match="does not use: ticket_id"):
        await team(action="members", project_id=pid, ticket_id="X-1")
    with pytest.raises(ToolError, match="Missing: project_id"):
        await team(action="usage")
    with pytest.raises(ToolError):
        await team(action="usage", project_id=pid, range="year")
    with pytest.raises(ToolError):
        await team(action="members", project_id=pid, bogus=1)
    with pytest.raises(ToolError):
        await team(
            action="ask", member_id="m", text="x", ticket_id="K-1", intent="shout"
        )


async def test_the_tool_is_small_and_marked_write():
    tools = {t.name: t for t in await mcp.list_tools()}
    tool = tools["ai_team"]
    size = len(tool.description or "") + len(
        json.dumps(tool.inputSchema, separators=(",", ":"))
    )
    assert size < 3_200 and tool.annotations.readOnlyHint is False
    assert tool.annotations.destructiveHint is not True
    assert set(tool.inputSchema["properties"]["action"]["enum"]) == set(AI_TEAM_OPS)
    assert ops.PROVIDERS_OK == ("claude-code", "antigravity", "mcp-client")
