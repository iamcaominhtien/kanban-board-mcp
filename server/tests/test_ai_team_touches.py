"""The AI Team view, You stepped in: every touch by a person, marked by rule, needed or avoidable."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import select

from models import AiRun
from services.ai import guard
from tests.test_ai import _ctx, _runner, _ticket, env  # noqa: F401


async def _steps(c, pid, **params):
    r = await c.get(f"/projects/{pid}/ai/team/stepped-in", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def _ask_assignee(env, an, tid, ctx):
    from kanban_mcp.tools.tickets import manage_ticket

    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="NEEDS_APPROVAL"):
            await manage_ticket(action="update", ticket_id=tid, assignee=an)
    finally:
        guard.leave(tokens)


async def _pending(c, pid):
    return (
        await c.get(f"/projects/{pid}/ai/approvals", params={"status": "pending"})
    ).json()


async def test_an_approval_is_a_touch_the_rule_asked_for(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    await _ask_assignee(env, an, tid, ctx)
    [a] = await _pending(c, pid)
    r = await c.post(f"/ai/approvals/{a['id']}/approve", json={})
    assert r.status_code == 200, r.text
    data = await _steps(c, pid)
    [t] = [i for i in data["items"] if i["kind"] == "approval"]
    assert t["who"] == "user" and t["what"] == "Approved" and t["mark"] == "by_rule"
    assert t["ticket_id"] == tid and t["member_name"] == m["name"] and t["via"] is None
    assert data["totals"]["by_rule"] == 1 and data["kinds"][0]["key"] == "approval"


async def test_a_decision_made_by_a_tool_for_the_person_is_marked_via_mcp(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    await _ask_assignee(env, an, tid, ctx)
    [a] = await _pending(c, pid)
    await c.post(
        f"/ai/approvals/{a['id']}/approve",
        json={},
        headers={"X-Origin": "mcp"},
    )
    data = await _steps(c, pid)
    assert data["totals"]["via_mcp"] == 1
    assert [i["via"] for i in data["items"]] == ["mcp"]
    assert len((await _steps(c, pid, via="mcp"))["items"]) == 1
    assert (await _steps(c, pid, mark="needed"))["items"] == []


async def test_the_same_answer_to_the_same_question_again_and_again_is_avoidable(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    now = datetime.now(UTC)
    for i in range(3):
        async with env["maker"]() as s:
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=m["id"],
                    state="finished",
                    answer="staging",
                    question=json.dumps(
                        {
                            "text": "Which environment?",
                            "answered_at": (
                                now - timedelta(minutes=30 - i)
                            ).isoformat(),
                            "answered_by": "Hoa Mai",
                        }
                    ),
                    ended_at=now.isoformat(),
                )
            )
            await s.commit()
    items = (await _steps(c, pid))["items"]
    answers = sorted((i for i in items if i["kind"] == "answer"), key=lambda i: i["at"])
    assert [i["mark"] for i in answers] == ["needed", "needed", "avoidable"]
    assert "3rd time" in answers[-1]["why"]


async def test_re_running_after_a_limit_is_avoidable_and_a_first_start_is_needed(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    now = datetime.now(UTC)
    async with env["maker"]() as s:
        old = (await s.exec(select(AiRun))).first()
        old.state = "timed_out"
        old.ended_reason = "Timed out after 30 min"
        old.ended_at = (now - timedelta(hours=1)).isoformat()
        old.queued_at = (now - timedelta(hours=2)).isoformat()
        s.add(old)
        s.add(
            AiRun(
                project_id=pid,
                ticket_id=tid,
                member_id=m["id"],
                state="finished",
                trigger="retry",
                started_by="Hoa Mai",
                started_via="mcp",
                number=2,
                queued_at=(now - timedelta(minutes=50)).isoformat(),
                ended_at=now.isoformat(),
            )
        )
        await s.commit()
    [t] = [i for i in (await _steps(c, pid))["items"] if i["kind"] == "run"]
    assert (
        t["mark"] == "avoidable" and t["via"] == "mcp" and t["what"] == "Re-ran by hand"
    )


async def test_docs_edits_always_approved_are_avoidable_with_always_allow(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    from kanban_mcp.tools.docs import docs_write

    await c.patch(f"/projects/{pid}/ai/settings", json={"docs_edits_ask": True})
    for i in range(3):
        tokens = guard.enter(ctx)
        try:
            with pytest.raises(ValueError, match="NEEDS_APPROVAL"):
                await docs_write(action="create", project_id=pid, title=f"Page {i}")
        finally:
            guard.leave(tokens)
        [a] = await _pending(c, pid)
        await c.post(f"/ai/approvals/{a['id']}/approve", json={})
    data = await _steps(c, pid)
    marks = [i["mark"] for i in data["items"] if i["kind"] == "approval"]
    assert marks == ["avoidable"] * 3
    assert "Always allow" in data["items"][0]["why"]


async def test_per_10_runs_and_ranges(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    await _ask_assignee(env, an, tid, ctx)
    [a] = await _pending(c, pid)
    await c.post(f"/ai/approvals/{a['id']}/approve", json={})
    data = await _steps(c, pid, range="30d")
    row = next(r for r in data["per_ai"] if r["id"] == m["id"])
    assert row["runs"] == 1 and row["touches"] == 1 and row["per_10_runs"] == 10.0
    assert (
        await c.get(f"/projects/{pid}/ai/team/stepped-in", params={"range": "x"})
    ).status_code == 422
