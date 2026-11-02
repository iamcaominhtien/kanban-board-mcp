"""Story (design/screens/ai-story-flow.md B–F; services/stories.py), against the fake CLI playing the PM: a Story is
made as a Draft or handed to the PM, the PM writes a plan, a person or the PM approves it, the children run as soon
as what they wait for is done, the PM reviews the Story and closes it; a Story is never moved by hand."""

import asyncio

import pytest
from sqlmodel import select

from models import AiRun
from tests.test_ai import _project, _ticket, env  # noqa: F401
from tests.test_ai_manager import _ops, _settle, _story, _wf
from tests.test_ai_workflow import _team, _until


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


async def _pm_running(env, sid, pm):
    for _ in range(300):
        async with env["maker"]() as s:
            going = (
                await s.exec(
                    select(AiRun).where(
                        AiRun.ticket_id == sid,
                        AiRun.member_id == pm,
                        AiRun.state == "running",
                    )
                )
            ).first()
        if going:
            return going
        await asyncio.sleep(0.1)
    raise AssertionError("The PM never started")


async def _new(c, pid, **body):
    r = await c.post(
        f"/projects/{pid}/stories",
        json={
            "title": "Weather app",
            "goal": "See the weather of a city",
            "criteria": ["Today", "Seven days"],
            **body,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_draft_story_sits_in_backlog_and_never_moves_by_hand(env):
    c = env["c"]
    pid, _ = await _project(c)
    story = await _new(c, pid, hand=False)
    assert story["state"] == "draft" and story["plan"] is None
    assert [x["text"] for x in story["criteria"]] == ["Today", "Seven days"]
    ticket = (await c.get(f"/tickets/{story['id']}")).json()
    assert ticket["type"] == "story" and ticket["status"] == "backlog"
    r = await c.patch(f"/tickets/{story['id']}", json={"status": "in-progress"})
    assert r.status_code in (400, 409, 422) and "Story" in r.text
    # a ticket cannot become a Story by changing its type, nor hold a Story
    other = await _ticket(c, pid)
    r = await c.patch(f"/tickets/{other}", json={"type": "story"})
    assert r.status_code in (400, 409, 422)
    listed = (await c.get(f"/projects/{pid}/stories")).json()
    assert [s["id"] for s in listed] == [story["id"]]
    # handing it over needs a PM
    r = await c.post(f"/stories/{story['id']}/hand", json={})
    assert r.status_code == 409 and "no PM" in r.text


async def test_the_pm_plans_the_person_approves_the_children_run_by_the_plan_and_the_pm_closes_it(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    gate = tmp_path / "plan.gate"
    monkeypatch.setenv("FAKE_CLAUDE_PLAN_GATE", str(gate))
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("dev", "reviewer", "pm"))
    await _ops(
        c,
        pid,
        tdd={"required": False},
        autonomy={"done": "after_review"},
        workflow_default="quick_fix",
    )
    # the fake PM reads its plan when it starts: the keys the test is about to create
    monkeypatch.setenv(
        "FAKE_CLAUDE_PLAN",
        "PLAN: KAN-2 | after: none | covers: 1\nPLAN: KAN-3 | after: KAN-2 | covers: 2\nPLAN: KAN-4 | after: none | covers:",
    )
    story = await _new(c, pid, approve="person")
    sid = story["id"]
    assert sid == "KAN-1"
    assert story["state"] == "planning" and story["pm"]["id"] == team["pm"]
    assert (await c.get(f"/tickets/{sid}")).json()["status"] == "todo"
    await _pm_running(env, sid, team["pm"])
    a = await _ticket(c, pid, title="Search a city", status="backlog", parent_id=sid)
    b = await _ticket(c, pid, title="Seven days", status="backlog", parent_id=sid)
    d = await _ticket(c, pid, title="Units", status="backlog", parent_id=sid)
    assert (a, b, d) == ("KAN-2", "KAN-3", "KAN-4")
    gate.write_text("go")
    story = await _story(c, sid, lambda v: v["plan_waiting"])
    assert story["state"] == "planning" and story["plan"]["version"] == 1
    assert [(i["ticket_id"], i["after"]) for i in story["plan"]["items"]] == [
        (a, []),
        (b, [a]),
        (d, []),
    ]
    assert story["criteria"][0]["ticket_id"] == a
    # the wait is the ticket's own Blocked by
    assert (await c.get(f"/tickets/{b}")).json()["blocked_by"] == [a]
    needs = (await c.get("/notifications?box=needs")).json()
    rows = needs["items"] if isinstance(needs, dict) else needs
    assert [r for r in rows if r["kind"] == "story_plan" and r.get("ticket_id") == sid]
    await _settle()
    for k in (a, b, d):
        assert (
            await c.get(f"/tickets/{k}/ai/workflow")
        ).json() is None  # nothing runs before the approval
    r = await c.post(f"/stories/{sid}/plan/approve")
    assert r.status_code == 200 and r.json()["state"] == "in_progress"
    assert (await c.get(f"/tickets/{sid}")).json()["status"] == "in-progress"
    # what waits for nothing starts at once; b waits for a
    assert await _wf(c, a) is not None and await _wf(c, d) is not None
    first = await _wf(c, a)
    if first["state"] != "done":
        assert (await c.get(f"/tickets/{b}/ai/workflow")).json() is None
    for k in (a, b, d):
        await _until(c, k, lambda v: v["state"] == "done", timeout=90)
    done = await _story(c, sid, lambda v: v["state"] == "done", timeout=60)
    assert done["progress"] == {"done": 3, "total": 3, "building": 0, "waiting": 0}
    assert (
        done["closed_at"]
        and (await c.get(f"/tickets/{sid}")).json()["status"] == "done"
    )


async def test_when_the_pm_approves_its_own_plan_it_is_a_decision_the_person_can_override(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    gate = tmp_path / "plan.gate"
    monkeypatch.setenv("FAKE_CLAUDE_PLAN_GATE", str(gate))
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("dev", "reviewer", "pm"))
    await _ops(c, pid, tdd={"required": False}, workflow_default="quick_fix")
    story = await _new(c, pid, approve="pm", hand=False)
    sid = story["id"]
    await c.post(
        f"/stories/{sid}/pause"
    )  # paused: nothing starts, so nothing is built on the PM's approval
    await c.post(f"/stories/{sid}/hand", json={})
    await _pm_running(env, sid, team["pm"])
    a = await _ticket(c, pid, title="Search", status="backlog", parent_id=sid)
    gate.write_text("go")
    story = await _story(c, sid, lambda v: v["state"] == "in_progress")
    assert story["plan"]["approved_by"] == "Pm AI" and not story["plan_waiting"]
    full = (await c.get(f"/stories/{sid}")).json()
    d = next(x for x in full["decisions"] if x["kind"] == "approve_plan")
    assert d["can_override"]
    assert (await c.get(f"/tickets/{a}/ai/workflow")).json() is None
    r = await c.post(f"/ai/decisions/{d['id']}/override", json={})
    assert r.status_code == 200, r.text
    story = (await c.get(f"/stories/{sid}")).json()
    assert (
        story["state"] == "planning"
        and story["plan_waiting"]
        and story["approve"] == "person"
    )
    # the person approves and resumes it: now it runs
    await c.post(f"/stories/{sid}/plan/approve")
    await c.post(f"/stories/{sid}/resume")
    assert await _wf(c, a) is not None


async def test_a_rejected_plan_sends_its_tickets_to_the_recycle_bin_and_the_story_back_to_draft(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    gate = tmp_path / "plan.gate"
    monkeypatch.setenv("FAKE_CLAUDE_PLAN_GATE", str(gate))
    pid, _ = await _project(c)
    team = await _team(c, pid, env["repo"], roles=("dev", "pm"))
    sid = (await _new(c, pid, approve="person"))["id"]
    await _pm_running(env, sid, team["pm"])
    a = await _ticket(c, pid, title="Search", status="backlog", parent_id=sid)
    gate.write_text("go")
    await _story(c, sid, lambda v: v["plan_waiting"])
    r = await c.post(f"/stories/{sid}/plan/reject", json={"note": "too big"})
    assert r.status_code == 200 and r.json()["state"] == "draft"
    t = (await c.get(f"/tickets/{a}")).json()
    assert t["status"] == "wont_do" and "too big" in t["wont_do_reason"]
    assert (await c.get(f"/tickets/{sid}")).json()["status"] == "backlog"
    assert (await c.post(f"/stories/{sid}/plan/approve")).status_code == 409


async def test_a_plan_with_no_tickets_leaves_the_story_a_draft_that_says_why(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    gate = tmp_path / "plan.gate"
    gate.write_text("go")
    monkeypatch.setenv("FAKE_CLAUDE_PLAN_GATE", str(gate))
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("pm",))
    sid = (await _new(c, pid))["id"]
    story = await _story(c, sid, lambda v: v["state"] == "draft")
    assert story["blocked"]["kind"] == "plan" and "no plan" in story["blocked"]["text"]


async def test_make_this_a_story_keeps_the_children_in_order_and_runs_them(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("dev", "reviewer", "pm"))
    await _ops(c, pid, tdd={"required": False}, workflow_default="quick_fix")
    parent = await _ticket(c, pid, title="Weather app", status="backlog")
    kids = [
        await _ticket(c, pid, title=t, status="backlog", parent_id=parent)
        for t in ("One", "Two")
    ]
    r = await c.post(f"/tickets/{parent}/make-story")
    assert r.status_code == 200, r.text
    story = r.json()
    assert story["state"] == "in_progress"
    assert [i["ticket_id"] for i in story["plan"]["items"]] == kids
    assert (await c.post(f"/tickets/{parent}/make-story")).status_code == 409
    assert (
        await c.post(f"/tickets/{kids[0]}/make-story")
    ).status_code == 409  # never a Story in a Story
    assert await _wf(c, kids[0]) is not None


async def test_pause_drop_and_reopen(env):
    c = env["c"]
    pid, _ = await _project(c)
    sid = (await _new(c, pid, hand=False))["id"]
    assert (await c.post(f"/stories/{sid}/pause")).json()["paused"]
    assert not (await c.post(f"/stories/{sid}/resume")).json()["paused"]
    dropped = (await c.post(f"/stories/{sid}/drop")).json()
    assert dropped["state"] == "dropped"
    assert (await c.get(f"/tickets/{sid}")).json()["status"] == "wont_do"
    assert (await c.post(f"/stories/{sid}/drop")).status_code == 409
    assert (await c.post(f"/stories/{sid}/reopen")).json()["state"] == "draft"
    out = (
        await c.patch(f"/stories/{sid}", json={"budget_tokens": 5000, "approve": "pm"})
    ).json()
    assert out["tokens"]["budget"] == 5000 and out["approve"] == "pm"
    assert (await c.get("/stories/NOPE-1")).status_code == 404


async def test_the_default_plan_approval_follows_the_project(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _ops(c, pid, autonomy={"approve": "pm"})
    assert (await _new(c, pid, hand=False))["approve"] == "pm"
    await _ops(c, pid, autonomy={"approve": "person"})
    assert (await _new(c, pid, hand=False))["approve"] == "person"
