"""The Timeline: a sequence diagram of the AI team built from runs, hand-offs, questions, approvals, Autopilot
decisions and pauses (design/screens/ai-team-timeline.md)."""

import json
from datetime import UTC, datetime, timedelta

from models import AiApproval, AiRun
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401


def _t(minutes_ago: float) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat()


async def _run(s, pid, tid, mid, start, end, **extra):
    r = AiRun(
        project_id=pid,
        ticket_id=tid,
        member_id=mid,
        queued_at=_t(start),
        started_at=_t(start),
        ended_at=_t(end) if end is not None else None,
        **extra,
    )
    s.add(r)
    await s.commit()
    await s.refresh(r)
    return r


async def _tl(c, pid, **params):
    r = await c.get(f"/projects/{pid}/ai/team/timeline", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def test_the_timeline_has_a_lifeline_per_participant_and_a_bar_per_run(env):
    c = env["c"]
    pid, _an = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    qa = await _runner(c, pid, env["repo"], name="QA", template="reviewer")
    tid = await _ticket(c, pid, "Export CSV")
    async with env["maker"]() as s:
        a = await _run(s, pid, tid, dev["id"], 30, 20, state="finished", number=1)
        # QA was woken by Dev (chain) and started two minutes after Dev ended
        await _run(
            s,
            pid,
            tid,
            qa["id"],
            18,
            None,
            state="running",
            number=1,
            trigger="handoff",
            chain=json.dumps([dev["id"]]),
        )
        assert a.id
    data = await _tl(c, pid, range="hour")
    kinds = [x["kind"] for x in data["lifelines"]]
    assert kinds[0] == "you" and kinds.count("ai") == 2
    assert {x["state"] for x in data["bars"]} == {"finished", "running"}
    [arrow] = [x for x in data["arrows"] if x["kind"] == "handoff"]
    assert arrow["from"] == dev["id"] and arrow["to"] == qa["id"]
    # the arrow starts where the sender ended and lands where the receiver started
    assert arrow["at"] < arrow["to_at"]
    assert data["following"] is True and len(data["density"]) == 60


async def test_a_question_waits_for_you_and_the_answer_comes_back(env):
    c = env["c"]
    pid, _an = await _project(c)
    ba = await _runner(c, pid, env["repo"], name="BA")
    tid = await _ticket(c, pid, "Spec")
    q = {"text": "Include archived?", "options": [], "asked_at": _t(41)}
    async with env["maker"]() as s:
        await _run(
            s, pid, tid, ba["id"], 50, None, state="needs_input", question=json.dumps(q)
        )
    data = await _tl(c, pid, range="today")
    [wait] = data["waits"]
    assert wait["kind"] == "question" and wait["to"] is None
    # the person assigned it (you to BA), then BA asks the person
    assert [x["kind"] for x in data["arrows"]] == ["assign", "ask"]
    assert data["arrows"][1]["to"] == "you"
    me = next(x for x in data["lifelines"] if x["id"] == ba["id"])
    assert me["state"] == "waiting"


async def test_autopilot_decisions_get_their_own_lifeline_and_arrow(env):
    c = env["c"]
    pid, _an = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    pm = await _runner(c, pid, env["repo"], name="PM")
    tid = await _ticket(c, pid, "Run tests")
    async with env["maker"]() as s:
        await _run(s, pid, tid, dev["id"], 30, None, state="running")
        s.add(
            AiApproval(
                project_id=pid,
                member_id=dev["id"],
                ticket_id=tid,
                action="run_command",
                summary="npm test",
                risk="low",
                status="approved",
                requested_at=_t(25),
                decided_at=_t(21),
                decided_by=pm["name"],
                decided_via="autopilot",
            )
        )
        await s.commit()
    r = await c.put(
        f"/projects/{pid}/ai/autopilot",
        json={
            "enabled": True,
            "accept_risks": True,
            "grace_min": 0,
            "delegate_id": pm["id"],
        },
    )
    assert r.status_code == 200, r.text
    data = await _tl(c, pid, range="hour")
    assert "autopilot" in [x["id"] for x in data["lifelines"]]
    auto = [x for x in data["arrows"] if x["kind"] == "auto"]
    assert (
        len(auto) == 1 and auto[0]["from"] == "autopilot" and auto[0]["to"] == dev["id"]
    )
    assert auto[0]["wait_s"] == 240
    assert data["autopilot"]["delegate"] == "PM"


async def test_scope_keeps_only_the_lifelines_of_one_ticket_and_pauses_are_listed(env):
    c = env["c"]
    pid, _an = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    qa = await _runner(c, pid, env["repo"], name="QA")
    t1, t2 = await _ticket(c, pid, "One"), await _ticket(c, pid, "Two")
    async with env["maker"]() as s:
        await _run(s, pid, t1, dev["id"], 30, 25, state="finished")
        await _run(s, pid, t2, qa["id"], 20, 15, state="finished")
    await c.post(f"/projects/{pid}/ai/pause-all", json={"reason": "Odd edits"})
    team = await _tl(c, pid, range="hour")
    scoped = await _tl(c, pid, range="hour", ticket_id=t1)
    assert {x["id"] for x in team["lifelines"] if x["kind"] == "ai"} == {
        dev["id"],
        qa["id"],
    }
    assert [x["id"] for x in scoped["lifelines"] if x["kind"] == "ai"] == [dev["id"]]
    assert [x["ticket_id"] for x in scoped["bars"]] == [t1]
    [pause] = team["pauses"]
    assert pause["reason"] == "Odd edits" and pause["to"] is None
    assert team["paused_all"] is True


async def test_a_run_stopped_by_the_pause_says_so_and_a_bad_time_is_refused(env):
    c = env["c"]
    pid, _an = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    tid = await _ticket(c, pid, "One")
    async with env["maker"]() as s:
        await _run(
            s,
            pid,
            tid,
            dev["id"],
            10,
            2,
            state="cancelled",
            ended_reason="Pause all AI by An Nguyen",
        )
    [bar] = (await _tl(c, pid, range="hour"))["bars"]
    assert bar["end_kind"] == "pause_all"
    r = await c.get(f"/projects/{pid}/ai/team/timeline", params={"since": "soon"})
    assert r.status_code == 422


async def test_report_backs_of_a_parents_children_group_into_one_arrow(env):
    c = env["c"]
    pid, _an = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    pm = await _runner(c, pid, env["repo"], name="PM")
    parent = await _ticket(c, pid, "Parent")
    kids = [await _ticket(c, pid, f"Child {i}", parent_id=parent) for i in range(3)]
    async with env["maker"]() as s:
        for i, kid in enumerate(kids):
            # Dev's run on a child ended; PM was woken to check it, five minutes apart
            await _run(s, pid, kid, dev["id"], 50 - i * 5, 48 - i * 5, state="finished")
            await _run(
                s,
                pid,
                kid,
                pm["id"],
                47 - i * 5,
                46 - i * 5,
                state="finished",
                trigger="report_back",
                chain=json.dumps([dev["id"]]),
                number=2,
            )
    data = await _tl(c, pid, range="hour")
    reports = [x for x in data["arrows"] if x["kind"] == "report"]
    assert len(reports) == 1
    assert reports[0]["count"] == 3 and reports[0]["parent_id"] == parent
    assert {i["ticket_id"] for i in reports[0]["items"]} == set(kids)
    assert data["truncated"] is False and data["grouped_harder"] is False


async def test_a_crowded_window_groups_harder_before_it_drops_anything(
    env, monkeypatch
):
    from services.ai import timeline

    monkeypatch.setattr(timeline, "MAX_ARROWS", 5)
    c = env["c"]
    pid, _an = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    tid = await _ticket(c, pid, "One")
    async with env["maker"]() as s:
        # eight assignments from the person, three minutes apart: too many for 5, but within ten minutes of each other
        for i in range(8):
            await _run(
                s,
                pid,
                tid,
                dev["id"],
                55 - i * 3,
                54 - i * 3,
                state="finished",
                number=i + 1,
            )
    data = await _tl(c, pid, range="hour")
    assigns = [x for x in data["arrows"] if x["kind"] == "assign"]
    assert data["grouped_harder"] is True and data["truncated"] is False
    assert sum(x["count"] for x in assigns) == 8 and len(assigns) <= 5
