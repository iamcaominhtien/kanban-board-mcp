"""Needs approval run state (design/screens/ai-safety-cost.md): a tool call that needs approval waits for the
person's decision; approved, the board applies it and the AI is told not to repeat it; denied, it is told why."""

import asyncio

import pytest

from services.ai import guard, runs
from tests.test_ai import _ctx, env  # noqa: F401


async def _waiting(run_id: str) -> dict:
    for _ in range(200):
        if run_id in runs.RT.waiting_approval:
            return runs.RT.waiting_approval[run_id]
        await asyncio.sleep(0.02)
    raise AssertionError("the call never waited")


@pytest.mark.parametrize("decision", ["approve", "deny"])
async def test_the_call_waits_for_the_decision(env, monkeypatch, decision):
    from kanban_mcp.tools.tickets import manage_ticket

    monkeypatch.setattr(guard, "APPROVAL_WAIT_S", 20)
    monkeypatch.setattr(guard, "APPROVAL_POLL_S", 0.02)
    ctx, pid, an, m, tid = await _ctx(env)
    c = env["c"]

    async def call():
        tokens = guard.enter(ctx)
        try:
            await manage_ticket(action="update", ticket_id=tid, assignee=an)
        finally:
            guard.leave(tokens)

    task = asyncio.create_task(call())
    waiting = await _waiting(ctx.run_id)
    assert waiting["summary"]
    run = (await c.get(f"/ai/runs/{ctx.run_id}")).json()
    assert run["waiting_approval"]["approval_id"] == waiting["approval_id"]
    r = await c.post(
        f"/ai/approvals/{waiting['approval_id']}/{decision}",
        json={"note": "Not this sprint"} if decision == "deny" else {},
        headers={"X-Actor": "An Nguyen"},
    )
    assert r.status_code == 200, r.text
    with pytest.raises(ValueError) as err:
        await asyncio.wait_for(task, 5)
    t = (await c.get(f"/tickets/{tid}")).json()
    if decision == "approve":
        assert str(err.value).startswith("APPROVED_AND_APPLIED: An Nguyen approved")
        assert t["assignee"] == an
    else:
        assert str(err.value).startswith("DENIED: An Nguyen denied")
        assert t["assignee"] != an
    assert ctx.run_id not in runs.RT.waiting_approval


async def test_a_cli_run_hears_a_person_edit_on_its_next_board_call(env):
    from kanban_mcp.tools import get_ticket

    ctx, pid, an, m, tid = await _ctx(env)
    assert await runs.note_person_edit(tid, by="An Nguyen", what="the description") == 1
    tokens = guard.enter(ctx)
    try:
        first = await get_ticket(ticket_id=tid)
        again = await get_ticket(ticket_id=tid)
    finally:
        guard.leave(tokens)
    assert first["board_notice"].startswith(
        "An Nguyen edited the ticket while you were working."
    )
    assert "board_notice" not in again  # delivered once


async def test_asking_again_for_the_same_change_does_not_list_it_twice(env):
    from kanban_mcp.tools.tickets import manage_ticket

    ctx, pid, an, m, tid = await _ctx(env)
    c = env["c"]

    async def ask(**fields):
        tokens = guard.enter(ctx)
        try:
            with pytest.raises(ValueError, match="NEEDS_APPROVAL"):
                await manage_ticket(
                    action="update", ticket_id=tid, assignee=an, **fields
                )
        finally:
            guard.leave(tokens)

    async def pending():
        r = await c.get(f"/projects/{pid}/ai/approvals?status=pending")
        return r.json()

    await ask()
    await ask()  # the person had closed the card and the AI is asked again (APPROVAL_WAIT_S is 0 in tests)
    assert len(await pending()) == 1
    await ask(priority="critical")  # a different change is a different request
    assert len(await pending()) == 2
