"""The Board AI makes, changes, pauses, resumes and runs schedules as the person, by tier (design/screens/ai-schedules.md,
design/source/AiBoardWave3.dc.html "Schedules": read, create, edit, pause and run now are reversible; deleting asks)."""

import json
import sys

import pytest

from services.ai.assist import context as ctxb
from services.ai.assist import prompts, tiers
from services.ai.assist.drafts import _schedule_values
from tests.ai_helpers import _runner, _ticket, env  # noqa: F401
from tests.test_ai_assist import H, _answer, _setup, fake  # noqa: F401

PASS = f'"{sys.executable}" -c "print(\'3 passed\')"'
WEEKDAYS = {
    "kind": "repeat",
    "days": [0, 1, 2, 3, 4],
    "time": "02:00",
    "tz": "Asia/Ho_Chi_Minh",
    "checks": {"criteria": False, "summary": True},
}


def _block(*changes) -> str:
    return "```kanban-actions\n" + json.dumps({"changes": list(changes)}) + "\n```"


async def _chat(c, pid):
    return (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()


async def _schedules(c, pid) -> list[dict]:
    return (await c.get(f"/projects/{pid}/ai/schedules")).json()["items"]


def test_schedule_actions_have_their_tiers_and_delete_never_acts_alone():
    for op in (
        "schedule_create",
        "schedule_edit",
        "schedule_pause",
        "schedule_resume",
        "schedule_run",
    ):
        assert tiers.decide([{"op": op, "schedule": "sch_1"}])["act"] is True, op
    gone = tiers.decide([{"op": "schedule_delete", "schedule": "sch_1"}])
    assert gone["act"] is False and "cannot be moved out" in gone["reasons"][0]
    assert "schedule_delete" in tiers.LOCKED
    # four schedules at once is a bulk action, said in words
    four = tiers.decide(
        [{"op": "schedule_pause", "schedule": f"sch_{i}"} for i in range(4)]
    )
    assert four["act"] is False and "4 schedules at once" in four["reasons"][0]


def test_a_schedule_change_is_checked_against_the_board():
    tickets = {"KAN-1": {"status": "todo"}}
    members = {"builder": "m-b", "reviewer": "m-r"}
    good, problems = prompts.check_changes(
        [
            {
                "op": "schedule_create",
                "ticket": "kan-1",
                "member": "Builder",
                **WEEKDAYS,
                "review": {"on": True, "reviewer": "Reviewer", "fix_rounds": 1},
            },
            {"op": "schedule_pause", "schedule": "sch_9"},
        ],
        tickets,
        members,
    )
    assert not problems, problems
    create = good[0]
    assert create["ticket"] == "KAN-1" and create["fields"]["member_id"] == "m-b"
    assert create["fields"]["review"] == {
        "on": True,
        "fix_rounds": 1,
        "reviewer_id": "m-r",
    }
    assert good[1] == {"op": "schedule_pause", "schedule": "sch_9"}
    bad, problems = prompts.check_changes(
        [
            {"op": "schedule_create", "ticket": "KAN-1", "member": "Nobody"},
            {"op": "schedule_create", "ticket": "KAN-7", "member": "Builder"},
            {"op": "schedule_edit", "schedule": "sch_1"},
            {"op": "schedule_pause", "schedule": "the nightly one"},
        ],
        tickets,
        members,
    )
    assert bad == [] and len(problems) == 4, problems


async def test_the_board_ai_makes_a_schedule_and_undo_removes_it(env, fake):
    c, pid, an, m = await _setup(env, acts=True)
    dev = await _runner(c, pid, env["repo"], name="Builder")
    tid = await _ticket(c, pid, title="Nightly check")
    fake.queue.append(
        _block(
            {
                "op": "schedule_create",
                "ticket": tid,
                "member": "Builder",
                **WEEKDAYS,
            }
        )
    )
    msg = await _answer(
        c, (await _chat(c, pid))["id"], "Run Builder on it weekdays at 2"
    )
    assert msg["draft"]["status"] == "applied", msg["draft"]
    [s] = await _schedules(c, pid)
    assert s["ticket_id"] == tid and s["member_id"] == dev["id"]
    assert s["when"] == "Weekdays at 02:00" and s["created_by"] == H["X-Actor"]
    done = msg["draft"]["result"]["applied"][0]
    assert done["op"] == "schedule_create" and done["schedule"] == s["id"]
    r = await c.post(f"/ai/assist/drafts/{msg['draft']['id']}/undo", headers=H)
    assert r.status_code == 200, r.text
    assert await _schedules(c, pid) == []


async def test_the_board_ai_changes_pauses_and_resumes_one_and_each_undo_puts_it_back(
    env, fake
):
    c, pid, an, m = await _setup(env, acts=True)
    await _runner(c, pid, env["repo"], name="Builder")
    tid = await _ticket(c, pid, title="Nightly check")
    chat = (await _chat(c, pid))["id"]
    fake.queue.append(
        _block(
            {"op": "schedule_create", "ticket": tid, "member": "Builder", **WEEKDAYS}
        )
    )
    await _answer(c, chat, "Make it")
    [s] = await _schedules(c, pid)
    sid = s["id"]

    fake.queue.append(_block({"op": "schedule_edit", "schedule": sid, "time": "03:30"}))
    edit = await _answer(c, chat, "Move it to 03:30")
    assert edit["draft"]["status"] == "applied", edit["draft"]
    assert (await c.get(f"/ai/schedules/{sid}")).json()["time"] == "03:30"
    await c.post(f"/ai/assist/drafts/{edit['draft']['id']}/undo", headers=H)
    assert (await c.get(f"/ai/schedules/{sid}")).json()["time"] == "02:00"

    fake.queue.append(_block({"op": "schedule_pause", "schedule": sid}))
    pause = await _answer(c, chat, "Pause it")
    assert (await c.get(f"/ai/schedules/{sid}")).json()["state"] == "paused"
    await c.post(f"/ai/assist/drafts/{pause['draft']['id']}/undo", headers=H)
    assert (await c.get(f"/ai/schedules/{sid}")).json()["state"] == "active"

    fake.queue.append(_block({"op": "schedule_pause", "schedule": sid}))
    await _answer(c, chat, "Pause it again")
    fake.queue.append(_block({"op": "schedule_resume", "schedule": sid}))
    resume = await _answer(c, chat, "Resume it")
    assert (await c.get(f"/ai/schedules/{sid}")).json()["state"] == "active"
    await c.post(f"/ai/assist/drafts/{resume['draft']['id']}/undo", headers=H)
    assert (await c.get(f"/ai/schedules/{sid}")).json()["state"] == "paused"


async def test_a_change_the_board_refuses_says_why_and_deleting_asks_first(env, fake):
    c, pid, an, m = await _setup(env, acts=True)
    await _runner(c, pid, env["repo"], name="Builder")
    tid = await _ticket(c, pid, title="Nightly check")
    chat = (await _chat(c, pid))["id"]
    # tests on, no command: the editor's own words come back, and nothing is made
    fake.queue.append(
        _block(
            {
                "op": "schedule_create",
                "ticket": tid,
                "member": "Builder",
                **{**WEEKDAYS, "checks": {"tests": {"on": True, "command": ""}}},
            }
        )
    )
    msg = await _answer(c, chat, "Run the tests nightly")
    assert await _schedules(c, pid) == []
    assert "test command" in json.dumps(msg), msg
    # a good one, then delete: the draft waits for the person
    fake.queue.append(
        _block(
            {
                "op": "schedule_create",
                "ticket": tid,
                "member": "Builder",
                **{
                    **WEEKDAYS,
                    "checks": {"tests": {"on": True, "command": PASS}, "summary": True},
                },
            }
        )
    )
    await _answer(c, chat, "Run the tests nightly: " + PASS)
    [s] = await _schedules(c, pid)
    fake.queue.append(_block({"op": "schedule_delete", "schedule": s["id"]}))
    gone = await _answer(c, chat, "Delete it")
    assert gone["draft"]["status"] == "open", gone["draft"]
    assert len(await _schedules(c, pid)) == 1
    r = await c.post(
        f"/ai/assist/drafts/{gone['draft']['id']}/apply", json={}, headers=H
    )
    assert r.status_code == 200, r.text
    assert await _schedules(c, pid) == []


async def test_the_board_ai_sees_the_schedules_and_ai_runs_still_cannot_use_the_tool(
    env, fake
):
    from services.ai import guard
    from services.ai.context import RunContext

    c, pid, an, m = await _setup(env, acts=True)
    await _runner(c, pid, env["repo"], name="Builder")
    tid = await _ticket(c, pid, title="Nightly check")
    dev = next(
        x
        for x in (await c.get(f"/projects/{pid}/ai/members")).json()
        if x["name"] == "Builder"
    )
    made = await c.post(
        f"/projects/{pid}/ai/schedules",
        json={"ticket_id": tid, "member_id": dev["id"], **WEEKDAYS},
        headers=H,
    )
    assert made.status_code == 201, made.text
    async with env["maker"]() as session:
        lines = await ctxb.schedule_lines(session, pid)
    assert lines and made.json()["id"] in lines[0] and "Weekdays at 02:00" in lines[0]
    # MCP: the Board AI (a chat answer) may read, not write; a run of a ticket may do neither
    from kanban_mcp.tools.schedules import ai_schedules

    chat_ctx = RunContext(
        run_id="chat_1",
        member_id=m["id"],
        member_name="Reviewer",
        project_id=pid,
        ticket_id="",
        on_behalf_of="An Nguyen",
        mode="work",
    )
    run_ctx = RunContext(
        run_id="run_1",
        member_id=dev["id"],
        member_name="Builder",
        project_id=pid,
        ticket_id=tid,
        on_behalf_of="An Nguyen",
        mode="work",
    )
    tokens = guard.enter(chat_ctx)
    try:
        assert len(await ai_schedules("list", project_id=pid)) == 1
        with pytest.raises(ValueError, match="actions block"):
            await ai_schedules("pause", schedule_id=made.json()["id"])
    finally:
        guard.leave(tokens)
    tokens = guard.enter(run_ctx)
    try:
        with pytest.raises(ValueError, match="An AI run cannot"):
            await ai_schedules("list", project_id=pid)
    finally:
        guard.leave(tokens)


def test_schedule_values_round_trip_for_undo():
    from models import AiSchedule

    s = AiSchedule(
        project_id="p",
        ticket_id="KAN-1",
        member_id="m",
        time="02:00",
        days="[0,1]",
        checks='{"summary": true}',
    )
    assert _schedule_values(s, ["time", "days", "checks"]) == {
        "time": "02:00",
        "days": [0, 1],
        "checks": {"summary": True},
    }
