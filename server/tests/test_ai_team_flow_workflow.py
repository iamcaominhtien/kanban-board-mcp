"""AI Team, Flow on a workflow: the board starts every step's run, so the Team map, One ticket and the Timeline read
who held the ticket before from the step rows (Triage, BA, Designer, Dev, Checks, QA, Reviewer, with send-backs)."""

from datetime import UTC, datetime, timedelta

from models import AiRun, AiTicketStep
from services.ai import flow
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401

BOARD = "the board (intake)"


def _t(minutes_ago: float) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat()


def _step(
    tid,
    seq,
    label,
    role,
    state,
    *,
    kind="ai",
    member=None,
    run=None,
    attempt=1,
    note_in=None,
    outcome=None,
):
    return AiTicketStep(
        ticket_id=tid,
        seq=seq,
        idx=seq,
        key=label.lower(),
        label=label,
        kind=kind,
        role=role,
        state=state,
        attempt=attempt,
        member_id=member,
        run_id=run,
        note_in=note_in,
        outcome=outcome,
    )


def _run(
    tid,
    rid,
    member,
    minutes_ago,
    *,
    trigger="workflow",
    started_by=BOARD,
    state="finished",
    pid="p",
):
    return AiRun(
        id=rid,
        project_id=pid,
        ticket_id=tid,
        member_id=member,
        number=1,
        trigger=trigger,
        started_by=started_by,
        state=state,
        mode="work",
        queued_at=_t(minutes_ago),
        started_at=_t(minutes_ago - 0.5),
        ended_at=None if state in ("queued", "running") else _t(minutes_ago - 5),
    )


def _story(tid, m, pid="p", last_state="running"):
    """Triage, BA, Design skipped, Dev, the Checks fail, Dev again, QA, Reviewer asks for changes, Dev, QA, Reviewer
    working now. `m` maps a role to its member id."""
    runs = [
        _run(tid, f"{tid}-t1", m["triage"], 120, pid=pid),
        _run(tid, f"{tid}-b1", m["ba"], 110, pid=pid),
        _run(tid, f"{tid}-d1", m["dev"], 100, pid=pid),
        _run(tid, f"{tid}-d2", m["dev"], 90, pid=pid),
        _run(tid, f"{tid}-q1", m["qa"], 80, pid=pid),
        _run(tid, f"{tid}-r1", m["reviewer"], 70, pid=pid),
        _run(tid, f"{tid}-d3", m["dev"], 60, pid=pid),
        _run(tid, f"{tid}-q2", m["qa"], 50, pid=pid),
        _run(tid, f"{tid}-r2", m["reviewer"], 40, pid=pid, state=last_state),
    ]
    steps = [
        _step(tid, 0, "Triage", "triage", "done", member=m["triage"], run=f"{tid}-t1"),
        _step(tid, 1, "Spec", "ba", "done", member=m["ba"], run=f"{tid}-b1"),
        _step(tid, 2, "Design", "designer", "skipped"),
        _step(tid, 3, "Build", "dev", "done", member=m["dev"], run=f"{tid}-d1"),
        _step(tid, 4, "Checks", None, "done", kind="code", outcome="failed"),
        _step(tid, 5, "Test", "qa", "superseded"),
        _step(tid, 6, "Review", "reviewer", "superseded"),
        # the Checks sent it back: a new attempt of Build and fresh rows after it
        _step(
            tid,
            7,
            "Build",
            "dev",
            "done",
            member=m["dev"],
            run=f"{tid}-d2",
            attempt=2,
            note_in="Sent back by Checks: The checks failed.",
        ),
        _step(tid, 8, "Checks", None, "done", kind="code", outcome="pass"),
        _step(tid, 9, "Test", "qa", "done", member=m["qa"], run=f"{tid}-q1"),
        _step(
            tid,
            10,
            "Review",
            "reviewer",
            "done",
            member=m["reviewer"],
            run=f"{tid}-r1",
            outcome="changes",
        ),
        _step(
            tid,
            11,
            "Build",
            "dev",
            "done",
            member=m["dev"],
            run=f"{tid}-d3",
            attempt=3,
            note_in="Sent back by Reviewer: rename the helper.",
        ),
        _step(tid, 12, "Checks", None, "done", kind="code", outcome="pass"),
        _step(tid, 13, "Test", "qa", "done", member=m["qa"], run=f"{tid}-q2"),
        _step(
            tid,
            14,
            "Review",
            "reviewer",
            "active",
            member=m["reviewer"],
            run=f"{tid}-r2",
        ),
    ]
    return runs, steps


ROLES = ("triage", "ba", "designer", "dev", "qa", "reviewer")


def test_workflow_hand_offs_come_from_the_step_rows():
    m = {r: r for r in ROLES}
    runs, steps = _story("KAN-1", m)
    ais = {r: object() for r in ROLES}
    evs = flow.events(runs, ais, {"reviewer": "reviewer"}, steps=steps)
    got = [
        (
            e["from"],
            e["to"],
            e["kind"],
            e["returned"],
            e["sent_back"],
            e["via"],
            e["skipped"],
        )
        for e in evs
    ]
    assert got == [
        # the board taking the ticket in is no hand-off from a person
        ("triage", "ba", "hand-off", False, False, None, []),
        ("ba", "dev", "hand-off", False, False, None, ["Design"]),
        # the Checks failed the Dev's work: back to the Dev, always sent back
        ("dev", "dev", "hand-off", False, True, "checks", None),
        # through the Checks (no member) straight to QA
        ("dev", "qa", "hand-off", False, False, None, []),
        ("qa", "reviewer", "hand-off", False, False, None, []),
        # the Reviewer's first request for changes is review round 1: returned, normal
        ("reviewer", "dev", "hand-off", True, False, None, None),
        ("dev", "qa", "hand-off", False, False, None, []),
        ("qa", "reviewer", "hand-off", False, False, None, []),
    ]
    # a failed check is a fact, not two AIs going round
    assert flow.ping_pong(evs) == {}


def test_a_person_sending_back_and_the_pm_on_a_workflow():
    tid = "KAN-2"
    runs = [
        _run(tid, "d1", "designer", 100, started_by="An Nguyen"),
        _run(tid, "d2", "designer", 80, started_by="An Nguyen"),
        _run(tid, "v1", "dev", 70, started_by="An Nguyen", state="failed"),
        _run(tid, "pm", "pm", 60, trigger="manager", started_by="the board (manager)"),
        _run(tid, "v2", "dev", 50, started_by="An Nguyen"),
        _run(tid, "v3", "dev", 40, started_by="An Nguyen"),
    ]
    steps = [
        _step(tid, 0, "Design", "designer", "done", member="designer", run="d1"),
        _step(
            tid, 1, "Approve design", None, "done", kind="person", outcome="sent_back"
        ),
        _step(
            tid,
            2,
            "Design",
            "designer",
            "done",
            member="designer",
            run="d2",
            attempt=2,
            note_in="Sent back by An Nguyen: bigger buttons",
        ),
        _step(
            tid, 3, "Approve design", None, "done", kind="person", outcome="approved"
        ),
        _step(
            tid,
            4,
            "Build",
            "dev",
            "superseded",
            member="dev",
            run="v1",
            outcome="retried_by_pm",
        ),
        _step(
            tid,
            5,
            "Build",
            "dev",
            "done",
            member="dev",
            run="v2",
            attempt=2,
            note_in="Use the other API.",
        ),
        # the board's own retry of the same step by the same AI is no hand-off
        _step(tid, 6, "Build", "dev", "done", member="dev", run="v3", attempt=3),
    ]
    ais = {r: object() for r in ("designer", "dev", "pm")}
    evs = flow.events(runs, ais, {}, steps=steps)
    assert [(e["from"], e["to"], e["kind"], e["returned"]) for e in evs] == [
        ("An Nguyen", "designer", "assigned", False),  # a person attached the workflow
        (
            "An Nguyen",
            "designer",
            "assigned",
            True,
        ),  # and sent the design back (round 1)
        ("designer", "dev", "hand-off", False),  # past the person's approval
        ("dev", "pm", "hand-off", False),  # the failed step went to the PM
        ("pm", "dev", "hand-off", False),  # the PM passed it back
    ]
    assert [e["from_ai"] for e in evs] == [False, False, True, True, True]


async def _seed(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = {}
    for role in ROLES:
        extra = {"template": "reviewer"} if role == "reviewer" else {}
        m[role] = (await _runner(c, pid, env["repo"], name=role.title(), **extra))["id"]
    tid = await _ticket(c, pid)
    runs, steps = _story(tid, m, pid=pid)
    async with env["maker"]() as s:
        for x in [*runs, *steps]:
            s.add(x)
        await s.commit()
    return c, pid, tid, m


async def test_the_team_map_draws_a_workflow(env):
    c, pid, _tid, m = await _seed(env)
    data = (await c.get(f"/projects/{pid}/ai/team/flow")).json()
    edges = {(e["from"], e["to"], e["kind"]): e for e in data["edges"]}
    assert set(edges) == {
        (m["triage"], m["ba"], "flow"),
        (m["ba"], m["dev"], "skip"),
        (m["dev"], m["dev"], "sent back"),
        (m["dev"], m["qa"], "flow"),
        (m["qa"], m["reviewer"], "flow"),
        (m["reviewer"], m["dev"], "returned"),
    }
    assert not any(
        "you" in (e["from"], e["to"]) for e in data["edges"]
    )  # no edge for the board's own moves
    assert edges[(m["ba"], m["dev"], "skip")]["skipped"] == ["Design"]
    assert edges[(m["dev"], m["dev"], "sent back")]["via"] == "checks"
    assert edges[(m["dev"], m["qa"], "flow")]["count"] == 2
    # the Reviewer works on what QA handed on: that edge moves, and only that one
    assert [k for k, e in edges.items() if e["live"]] == [
        (m["qa"], m["reviewer"], "flow")
    ]
    assert data["stats"]["handoffs"] == 8
    assert data["stats"]["sent_back"] == 1 and data["stats"]["returned"] == 1
    assert {k["kind"] for k in data["stats"]["kinds"]} == {"hand-off"}


async def test_one_ticket_and_the_timeline_follow_the_workflow(env):
    c, pid, tid, m = await _seed(env)
    j = (await c.get(f"/projects/{pid}/ai/team/flow/{tid}")).json()
    assert [lane["id"] for lane in j["lanes"]] == [
        m[r] for r in ("triage", "ba", "dev", "qa", "reviewer")
    ]
    arrows = [(a["from"], a["to"], a["kind"]) for a in j["arrows"]]
    assert ("you", m["triage"], "assigned") not in arrows
    assert (m["ba"], m["dev"], "skip") in arrows
    assert (m["dev"], m["dev"], "sent back") in arrows
    assert (m["reviewer"], m["dev"], "returned") in arrows
    skip = next(a for a in j["arrows"] if a["kind"] == "skip")
    assert skip["skipped"] == ["Design"]
    assert [b["step"] for b in j["bars"]][:3] == ["Triage", "Spec", "Build"]
    assert j["strip"]["sent_back"] == 1 and j["strip"]["returned"] == 1
    start = next(t for t in j["touches"] if t["mark"] == "start")
    assert start["details"].startswith("The board took the ticket in")

    r = await c.get(
        f"/projects/{pid}/ai/team/timeline", params={"range": "24h", "ticket_id": tid}
    )
    tl = r.json()
    ais = [lf["id"] for lf in tl["lifelines"] if lf["kind"] == "ai"]
    assert ais == [
        m[r] for r in ("triage", "ba", "dev", "qa", "reviewer")
    ]  # the step order
    kinds = [(a["from"], a["to"], a["kind"]) for a in tl["arrows"]]
    assert (m["ba"], m["dev"], "skip") in kinds
    assert (m["dev"], m["dev"], "sent_back") in kinds
    assert (m["reviewer"], m["dev"], "returned") in kinds
    assert not any(a["from"] == "you" for a in tl["arrows"])
    back = next(a for a in tl["arrows"] if a["kind"] == "sent_back")
    assert back["via"] == "checks"
