"""AI Team, Flow by scope (design/screens/ai-story-flow.md G to J, R3): the team map, the Timeline and Health for the
whole project, one Story (the PM as the hub, the clusters) and one ticket, read from the runs the board keeps."""

import json
from datetime import UTC, datetime, timedelta

from models import AiDecision, AiRun, Story
from services.ai import flow_view, health
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401


def _t(minutes_ago: float) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat()


def _run(pid, tid, rid, member, minutes_ago, *, trigger="assign", state="finished"):
    return AiRun(
        id=rid,
        project_id=pid,
        ticket_id=tid,
        member_id=member,
        number=1,
        trigger=trigger,
        started_by="An Nguyen",
        state=state,
        mode="work",
        queued_at=_t(minutes_ago),
        started_at=_t(minutes_ago - 0.5),
        ended_at=None if state in ("queued", "running") else _t(minutes_ago - 5),
    )


async def _story_row(env, sid, pid, **fields):
    """The Story row of a story ticket (made with the ticket, or here when it is not), with these fields."""
    async with env["maker"]() as s:
        row = await s.get(Story, sid) or Story(ticket_id=sid, project_id=pid)
        for k, v in fields.items():
            setattr(row, k, v)
        s.add(row)
        await s.commit()


async def _add(env, *rows):
    async with env["maker"]() as s:
        for r in rows:
            s.add(r)
        await s.commit()


async def _seed(env):
    """A Story with two tickets (Designer then Dev on one, Dev then Reviewer on the other, the PM planning on the
    Story), and a ticket in no Story that only the Tester worked on."""
    c = env["c"]
    pid, _ = await _project(c)
    m = {}
    for role in ("pm", "designer", "dev", "reviewer", "tester"):
        extra = {"template": "reviewer"} if role == "reviewer" else {}
        m[role] = (await _runner(c, pid, env["repo"], name=role.title(), **extra))["id"]
    story = await _ticket(c, pid, title="Weather app", status="backlog", type="story")
    a = await _ticket(c, pid, title="Search a city", status="backlog", parent_id=story)
    b = await _ticket(c, pid, title="Seven-day list", status="backlog", parent_id=story)
    other = await _ticket(c, pid, title="Fix scroll jump", status="backlog")
    await _story_row(
        env,
        story,
        pid,
        state="in_progress",
        pm_id=m["pm"],
        # the plan puts b before a
        plan=json.dumps({"version": 1, "items": [{"ticket_id": b}, {"ticket_id": a}]}),
    )
    await _add(
        env,
        _run(pid, story, "pm1", m["pm"], 200),
        _run(pid, a, "a1", m["designer"], 180),
        _run(pid, a, "a2", m["dev"], 160, trigger="handoff"),
        _run(pid, b, "b1", m["dev"], 140),
        _run(pid, b, "b2", m["reviewer"], 120, trigger="handoff"),
        _run(pid, other, "o1", m["tester"], 100),
    )
    # a2 and b2 were handed on by the AI before them
    async with env["maker"]() as s:
        for rid, sender in (("a2", m["designer"]), ("b2", m["dev"])):
            r = await s.get(AiRun, rid)
            r.chain = json.dumps([sender])
            s.add(r)
        await s.commit()
    return c, pid, m, story, a, b, other


async def test_the_project_map_has_a_cluster_per_story_and_one_for_the_rest(env):
    c, pid, m, story, a, b, other = await _seed(env)
    data = (await c.get(f"/projects/{pid}/ai/team/flow")).json()
    # today's answer is still there
    assert data["range"] == "7d" and data["tickets"] == 4
    assert {n["id"] for n in data["nodes"]} == set(m.values())
    assert all(isinstance(n["tickets"], int) for n in data["nodes"])
    assert data["scope"] == {"level": "project", "story": None, "ticket": None}
    assert data["folded"] == {"count": 0, "edges": []}

    first, rest = data["clusters"]
    assert first["story_id"] == story and first["title"] == "Weather app"
    assert first["state"] == "in_progress"
    assert (first["done"], first["total"]) == (0, 2)
    assert first["tickets"] == 3 and first["ticket_ids"] == sorted([story, a, b])
    # a person assigned three of them, two AIs handed one on
    assert first["handoffs"] == 5
    assert {(e["from"], e["to"], e["kind"]) for e in first["edges"]} == {
        ("you", m["pm"], "flow"),
        ("you", m["designer"], "flow"),
        ("you", m["dev"], "flow"),
        (m["designer"], m["dev"], "flow"),
        (m["dev"], m["reviewer"], "flow"),
    }
    assert rest["story_id"] is None and rest["title"] == "Not in a Story"
    assert rest["ticket_ids"] == [other] and rest["handoffs"] == 1
    assert rest["edges"] == [
        {"from": "you", "to": m["tester"], "kind": "flow", "count": 1}
    ]
    assert next(p for p in data["picker"] if p["id"] == a)["story_id"] == story


async def test_one_story_puts_the_pm_at_the_centre(env):
    c, pid, m, story, a, b, other = await _seed(env)
    data = (
        await c.get(f"/projects/{pid}/ai/team/flow", params={"story": story})
    ).json()
    assert data["scope"]["level"] == "story"
    assert data["scope"]["story"] == {
        "id": story,
        "title": "Weather app",
        "state": "in_progress",
    }
    assert data["range"] == "all"  # a Story opens on its whole life
    nodes = {n["id"]: n for n in data["nodes"]}
    assert data["nodes"][0]["id"] == m["pm"] and data["nodes"][0]["hub"]
    assert m["tester"] not in nodes  # it never held a ticket of the Story
    assert nodes[m["dev"]]["tickets"] == sorted([a, b])
    assert nodes[m["dev"]]["ticket_count"] == 2
    assert nodes[m["pm"]]["tickets"] == sorted([story, a, b])
    assert nodes[m["dev"]]["live_ticket"] is None
    plan = {e["to"]: e for e in data["edges"] if e["kind"] == "plan"}
    assert set(plan) == {m["designer"], m["dev"], m["reviewer"]}
    assert all(e["from"] == m["pm"] for e in plan.values())
    assert plan[m["dev"]]["count"] == 2 and plan[m["designer"]]["count"] == 1
    assert (
        data["tickets"] == 2
    )  # its two tickets; the Story's own (the PM planning it) is not one of them
    assert [x["story_id"] for x in data["clusters"]] == [story]

    # a range picked by hand stays
    r = await c.get(
        f"/projects/{pid}/ai/team/flow", params={"story": story, "range": "today"}
    )
    assert r.json()["range"] == "today"


async def test_one_ticket_and_an_unknown_scope(env):
    c, pid, m, story, a, b, other = await _seed(env)
    data = (await c.get(f"/projects/{pid}/ai/team/flow", params={"ticket": a})).json()
    assert data["scope"] == {
        "level": "ticket",
        "story": {"id": story, "title": "Weather app", "state": "in_progress"},
        "ticket": {"id": a, "title": "Search a city"},
    }
    assert [n["id"] for n in data["nodes"]] == [m["designer"], m["dev"]]
    assert [(e["from"], e["to"]) for e in data["edges"]] == [
        ("you", m["designer"]),
        (m["designer"], m["dev"]),
    ]
    assert data["clusters"] == []
    for params in ({"story": "NOPE-1"}, {"ticket": "NOPE-1"}):
        r = await c.get(f"/projects/{pid}/ai/team/flow", params=params)
        assert r.status_code == 404

    j = (await c.get(f"/projects/{pid}/ai/team/flow/{a}")).json()
    assert j["story"] == {"id": story, "title": "Weather app"}
    assert j["workflow"] is None  # not on a workflow
    j = (await c.get(f"/projects/{pid}/ai/team/flow/{other}")).json()
    assert j["story"] is None


def test_a_busy_map_folds_its_smallest_arrows():
    def e(i, count, kind="flow", live=False):
        return {
            "from": f"a{i}",
            "to": f"b{i}",
            "kind": kind,
            "count": count,
            "live": live,
        }

    edges = [e(i, 20 - i) for i in range(14)]
    edges.append(e(98, 1, kind="sent back"))  # what goes back is never folded
    edges.append(e(99, 1, live=True))  # nor what moves now
    kept, folded = flow_view.fold(edges)
    assert len(kept) == flow_view.MAP_EDGES
    assert {x["from"] for x in kept} >= {"a98", "a99", "a0"}
    assert [x["from"] for x in folded["edges"]] == ["a10", "a11", "a12", "a13"]
    assert folded["count"] == sum(20 - i for i in range(10, 14))
    small = [e(i, 1) for i in range(5)]
    assert flow_view.fold(small) == (small, {"count": 0, "edges": []})


async def test_the_timeline_inside_a_story(env):
    c, pid, m, story, a, b, other = await _seed(env)
    await _add(
        env,
        AiDecision(
            project_id=pid,
            ticket_id=a,
            story_id=story,
            member_id=m["pm"],
            kind="approve_design",
            title=f"Approved the design of {a}",
            at=_t(170),
        ),
        AiDecision(
            project_id=pid,
            ticket_id=other,
            member_id=m["pm"],
            kind="retry",
            title="Retried",
            at=_t(90),
        ),
    )
    r = await c.get(f"/projects/{pid}/ai/team/timeline", params={"story": story})
    assert r.status_code == 200, r.text
    tl = r.json()
    assert tl["range"] == "all" and tl["scope"]["kind"] == "story"
    # the Story itself first (the PM's row), then its tickets in the plan's order
    assert [x["ticket_id"] for x in tl["rows"]] == [story, b, a]
    assert tl["rows"][0]["kind"] == "story" and tl["rows"][0]["member_id"] == m["pm"]
    assert {x["ticket_id"] for x in tl["bars"]} == {story, a, b}
    assert all(x["member_id"] for x in tl["bars"])
    assert [(x["kind"], x["ticket_id"]) for x in tl["decisions"]] == [
        ("approve_design", a)
    ]
    ais = [x["id"] for x in tl["lifelines"] if x["kind"] == "ai"]
    assert ais[0] == m["pm"] and m["tester"] not in ais

    # the whole team still reads every decision in the window
    tl = (
        await c.get(f"/projects/{pid}/ai/team/timeline", params={"range": "7d"})
    ).json()
    assert len(tl["decisions"]) == 2 and tl["rows"] == []
    r = await c.get(f"/projects/{pid}/ai/team/timeline", params={"story": "NOPE-1"})
    assert r.status_code == 404


async def test_health_lists_autonomy_by_story(env):
    c, pid, m, story, a, b, other = await _seed(env)
    data = (await c.get(f"/projects/{pid}/ai/team/health")).json()
    row = next(s for s in data["stories"] if s["id"] == story)
    assert row == {
        "id": story,
        "title": "Weather app",
        "state": "in_progress",
        "tickets_done": 0,
        "tickets_total": 2,
        "touches": {"needed": 0, "avoidable": 0, "by_rule": 0},
        "reasons": [],
    }


def test_autonomy_by_story_counts_needed_and_avoidable_touches():
    now = datetime.now(UTC)
    a = now - timedelta(days=7)

    class T:
        def __init__(self, id, type="task", parent_id=None, status="todo", title=""):
            self.id, self.type, self.parent_id = id, type, parent_id
            self.status, self.title = status, title or id

    tickets = {
        "S": T("S", type="story", title="Weather app"),
        "A": T("A", parent_id="S", status="done"),
        "B": T("B", parent_id="S"),
        "C": T("C", parent_id="S", status="wont_do"),
        "D": T("D", type="story", title="Old"),
        "X": T("X"),
    }

    def touch(tid, mark, what="Answered a question", why="The Designer asked."):
        return {
            "at": (now - timedelta(hours=1)).isoformat(),
            "ticket_id": tid,
            "mark": mark,
            "what": what,
            "why": why,
        }

    d = health.Data(
        project_id="p",
        ais={},
        templates={},
        personas={},
        project_name="",
        runs=[],
        tickets=tickets,  # type: ignore[arg-type]
        touches=[
            touch("A", "needed"),
            touch("B", "avoidable", what="Re-ran by hand", why=""),
            touch("S", "by_rule", what="Approved"),
            touch("X", "needed"),  # in no Story
        ],
        approvals=[],
        blocked=[],
        threads=[],
        pages={},
    )
    rows = {"D": Story(ticket_id="D", project_id="p", state="dropped")}
    out = health.by_story(d, rows, a, now)
    assert [s["id"] for s in out] == ["S"]  # a dropped Story nobody touched is left out
    s = out[0]
    assert (s["tickets_done"], s["tickets_total"]) == (1, 2)
    assert s["touches"] == {"needed": 1, "avoidable": 1, "by_rule": 1}
    assert s["reasons"] == [
        "Needed: Answered a question on A. The Designer asked.",
        "Avoidable: Re-ran by hand on B",
    ]
