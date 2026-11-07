"""AI v2 runs: a team's lead on a ticket against the fake CLI (mode v2): steps as rows with the subagent's own
rows, the final report, the comment and work log, lessons, a question and its answer, messages, cancel, hooks."""

import json

import pytest

import database
from models import AiRun, AiRunAgent, AiRunStep
from services.ai import guard, runs, steps
from tests.ai_helpers import _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture(autouse=True)
def _v2(monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "v2")


async def _steps(run_id: str) -> list[dict]:
    async with database.async_session() as s:
        return await steps.read(s, run_id, limit=500)


async def test_assigning_a_ticket_to_a_team_runs_its_lead_and_records_the_report(env):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    r = await c.patch(f"/tickets/{tid}", json={"assignee": team["id"]})
    assert r.status_code == 200, r.text
    run = await _wait(c, tid, ("finished",), timeout=30)
    assert run["state"] == "finished", run
    assert run["report"]["status"] == "done"
    assert run["report"]["branch"] == "ai/test"
    assert run["summary"].startswith("Fixed add()")
    assert run["session_name"] == tid
    assert run["steps_count"] >= 6
    rows = await _steps(run["id"])
    kinds = [s["kind"] for s in rows]
    assert kinds[0] == "start" and kinds[-1] == "end"
    assert "command" in kinds and "subagent" in kinds and "report" in kinds
    lead_cmd = next(
        s
        for s in rows
        if s["kind"] == "command"
        and s["agent_id"] is None
        and s["title"] == "Ran pytest -q"
    )
    assert lead_cmd["has_output"]
    assert lead_cmd["detail"]["tests"]["passed"] == 4
    sub = [s for s in rows if s["agent_id"] == "v2agent"]
    assert [s["kind"] for s in sub] == ["command", "text"]
    detail = (await c.get(f"/ai/runs/{run['id']}")).json()
    assert detail["agents"][0]["agent_type"] == "reviewer" and detail["agents"][0][
        "last_text"
    ].startswith("Looks good")
    out = (await c.get(f"/ai/runs/{run['id']}/steps/{lead_cmd['seq']}/output")).json()
    assert "4 passed" in out["output"]
    page = (await c.get(f"/ai/runs/{run['id']}/steps?agent=v2agent")).json()
    assert len(page) == 2
    # the report reached the ticket: a summary comment and a work log entry; the lesson was kept
    ticket = (await c.get(f"/tickets/{tid}")).json()
    last = ticket["comments"][-1]
    assert (
        last["author"] == team["name"]
        and "Fixed add()" in last["text"]
        and "ai/test" in last["text"]
    )
    log = ticket.get("work_log") or ticket.get("workLog") or []
    assert any("Run #1" in (e.get("note") or "") for e in log), log
    lessons = (await c.get(f"/projects/{pid}/ai/knowledge")).json()
    kept = [x for x in lessons.get("lessons", []) if "pytest -q" in x["text"]]
    assert kept and kept[0]["state"] == "kept"
    # the board chip and the overview see the run without steps
    board = (await c.get(f"/projects/{pid}/ai/board")).json()
    assert (
        board["tickets"][tid]["state"] == "finished"
        and "steps" not in board["tickets"][tid]
    )
    assert (await c.get(f"/projects/{pid}/ai/overview")).json()["runs"] == {
        "finished": 1
    }


async def test_a_second_turn_resumes_the_conversation(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.patch(f"/tickets/{tid}", json={"assignee": team["id"]})
    first = await _wait(c, tid, ("finished",), timeout=30)
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    r = await c.post(
        f"/tickets/{tid}/ai/run", json={"instruction": "Also add tests for sub()."}
    )
    assert r.status_code == 200, r.text
    second = r.json()
    assert second["id"] != first["id"] and second["number"] == 2
    done = await _wait(c, tid, ("finished",), timeout=30)
    assert done["id"] == second["id"]
    assert done["session_id"] == first["session_id"]
    args = json.loads(record.read_text().splitlines()[-1])
    assert (
        "--resume" in args and args[args.index("--resume") + 1] == first["session_id"]
    )
    assert (
        "--agents" in args
        and "--json-schema" in args
        and "--append-system-prompt-file" in args
    )
    assert args[args.index("--permission-mode") + 1] == "bypassPermissions"
    assert any(a.startswith("--plugin-dir") for a in args)
    agents = json.load(open(args[args.index("--agents") + 1]))
    assert set(agents) == {"dev", "reviewer", "qa"}
    rows = await _steps(second["id"])
    assert rows[0]["title"].startswith("Resumed")


async def test_a_question_parks_the_run_and_the_answer_resumes_it(env, monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "v2_ask")
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.patch(f"/tickets/{tid}", json={"assignee": team["id"]})
    run = await _wait(c, tid, ("needs_input",), timeout=30)
    assert run["question"]["text"].startswith("Which database")
    ticket = (await c.get(f"/tickets/{tid}")).json()
    assert ticket["pending"] and "asks:" in (ticket["pending_note"] or "")
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "v2")
    r = await c.post(f"/ai/runs/{run['id']}/answer", json={"text": "PostgreSQL"})
    assert r.status_code == 200, r.text
    done = await _wait(c, tid, ("finished",), timeout=30)
    assert done["id"] == run["id"] and done["answer"] == "PostgreSQL"
    assert done["report"]["summary"].startswith("Done with your answer")
    ticket = (await c.get(f"/tickets/{tid}")).json()
    assert not ticket["pending"]
    assert any("**Answer:** PostgreSQL" in cm["text"] for cm in ticket["comments"])


async def test_a_message_reaches_a_live_lead(env, monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1")
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.patch(f"/tickets/{tid}", json={"assignee": team["id"]})
    run = await _wait(c, tid, ("running",), timeout=20)
    # wait until the lead listens (the fake has emitted its steps)
    for _ in range(100):
        if any(s["kind"] == "subagent" for s in await _steps(run["id"])):
            break
        await __import__("asyncio").sleep(0.05)
    r = await c.post(
        f"/ai/runs/{run['id']}/message", json={"text": "Also bump the version."}
    )
    assert r.status_code == 200, r.text
    assert r.json()["delivered"] == "live"
    done = await _wait(c, tid, ("finished",), timeout=30)
    assert (
        "Heard: user says:" in done["summary"] and "bump the version" in done["summary"]
    )
    msgs = (await c.get(f"/ai/runs/{run['id']}/messages")).json()
    assert msgs and msgs[0]["direction"] == "in" and msgs[0]["delivered_at"]


async def test_cancel_stops_the_run_and_a_second_run_is_refused_while_one_goes(
    env, monkeypatch
):
    monkeypatch.setenv("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1")
    monkeypatch.setenv("FAKE_CLAUDE_WAIT", "30")
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.patch(f"/tickets/{tid}", json={"assignee": team["id"]})
    run = await _wait(c, tid, ("running",), timeout=20)
    conflict = await c.post(f"/tickets/{tid}/ai/run", json={"team_id": team["id"]})
    assert (
        conflict.status_code == 200
    )  # the lead hears the note instead of a second run
    r = await c.post(f"/ai/runs/{run['id']}/cancel")
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "cancelled"
    rows = await _steps(run["id"])
    assert rows[-1]["kind"] == "end" and "Cancelled" in rows[-1]["title"]
    assert run["id"] not in runs.RT.procs


async def test_hooks_record_subagents_and_plans(env):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    token = guard.new_token()
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=team["id"],
            state="running",
            started_by="An Nguyen",
            token_hash=guard.token_hash(token),
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
    headers = {"Authorization": f"Bearer {token}"}
    # a role's start and end come from the stream's task events, not from a hook: the hooks are ignored
    r = await c.post(
        "/ai/hooks",
        json={"hook_event_name": "SubagentStart", "agent_id": "a1", "agent_type": "qa"},
        headers=headers,
    )
    assert r.json() == {"ignored": "roles come from the stream"}
    r = await c.post(
        "/ai/hooks",
        json={
            "hook_event_name": "PostToolUse",
            "tool_name": "TaskCreate",
            "tool_input": {"subject": "Write the tests"},
        },
        headers=headers,
    )
    assert r.json() == {"ok": True}
    r = await c.post(
        "/ai/hooks",
        json={"hook_event_name": "SubagentStop", "agent_id": "a1", "agent_type": "qa"},
        headers=headers,
    )
    assert r.json() == {"ignored": "roles come from the stream"}
    assert (
        await c.post(
            "/ai/hooks",
            json={"hook_event_name": "Stop"},
            headers={"Authorization": "Bearer kbr_nope"},
        )
    ).json() == {"ignored": "run ended"}
    async with env["maker"]() as s:
        agents = (
            await s.exec(
                __import__("sqlmodel")
                .select(AiRunAgent)
                .where(AiRunAgent.run_id == run.id)
            )
        ).all()
        plans = (
            await s.exec(
                __import__("sqlmodel")
                .select(AiRunStep)
                .where(AiRunStep.run_id == run.id, AiRunStep.kind == "plan")
            )
        ).all()
    assert agents == []  # the hooks made no role row
    assert len(plans) == 1 and plans[0].title == "Write the tests"


async def test_the_lead_can_ask_through_the_tool_and_message_another_ticket(env):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    other = await _ticket(c, pid, title="The other one")
    token = guard.new_token()
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=team["id"],
            state="running",
            started_by="An Nguyen",
            token_hash=guard.token_hash(token),
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
    ctx = await guard.context_for_token(token)
    out = await runs.record_question(
        ctx, "Which colour?", ["Red", {"label": "Blue", "recommended": True}]
    )
    assert out["posted"] and "Stop now" in out["next"]
    async with env["maker"]() as s:
        assert json.loads((await s.get(AiRun, run.id)).question)["options"] == [
            "Red",
            "Blue",
        ]
    delivered = await runs.deliver_to_ticket(
        other, "FYI the API changed.", by=team["name"]
    )
    assert (
        delivered["delivered"] == "comment"
    )  # the other ticket has no team yet: the note is a comment
    ticket = (await c.get(f"/tickets/{other}")).json()
    assert ticket["comments"][-1]["text"] == "FYI the API changed."


async def test_a_subagents_task_events_land_on_the_row_the_stream_made(env):
    """The stream names a subagent by the lead's Agent call; its hooks carry Claude's own id. Both must end on one row."""
    from services.ai import steps as run_steps

    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    token = guard.new_token()
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=team["id"],
            state="running",
            started_by="An Nguyen",
            token_hash=guard.token_hash(token),
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
    await run_steps.append(
        run.id,
        [],
        agents=[
            {"id": "toolu_dev", "agent_type": "dev"},
            {"id": "toolu_rev", "agent_type": "reviewer"},
        ],
    )
    # what the parser makes of the stream's `task_started` / `task_updated` of the reviewer's task: both name the role by
    # Claude's own task id (`task_started` also carries the lead's Agent call)
    await run_steps.append(
        run.id,
        [],
        agents=[
            {"id": "toolu_rev", "claude_id": "claude-rev-1", "reopen": True},
            {"claude_id": "claude-rev-1", "ended": True},
        ],
    )
    async with env["maker"]() as s:
        agents = {
            a.id: a
            for a in (
                await s.exec(
                    __import__("sqlmodel")
                    .select(AiRunAgent)
                    .where(AiRunAgent.run_id == run.id)
                )
            ).all()
        }
    assert set(agents) == {"toolu_dev", "toolu_rev"}
    assert (
        agents["toolu_rev"].claude_id == "claude-rev-1" and agents["toolu_rev"].ended_at
    )
    assert agents["toolu_dev"].claude_id is None and not agents["toolu_dev"].ended_at


async def test_a_team_can_be_assigned_without_starting(env):
    """PATCH /tickets/{id}?start=false gives the ticket to the team; nothing runs until someone starts it."""
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    r = await c.patch(
        f"/tickets/{tid}", params={"start": "false"}, json={"assignee": team["id"]}
    )
    assert r.status_code == 200 and r.json()["assignee"] == team["id"]
    assert (await c.get(f"/tickets/{tid}/ai/runs")).json() == []
    # the person starts it later: the assigned team runs
    r = await c.post(f"/tickets/{tid}/ai/run", json={})
    assert r.status_code == 200, r.text
    assert r.json()["member_id"] == team["id"]
    await c.post(f"/ai/runs/{r.json()['id']}/cancel")
