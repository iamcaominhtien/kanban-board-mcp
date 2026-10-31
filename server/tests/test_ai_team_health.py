"""The AI Team view, Health: five measures, a row per AI, what to fix, and the hand-off rounds behind Quality."""

import json
from datetime import UTC, datetime, timedelta

from sqlmodel import select

from models import AiAudit, AiMember, AiRun
from services.ai import flow
from tests.test_ai import _ctx, _runner, _ticket, env  # noqa: F401


async def _health(c, pid, **params):
    r = await c.get(f"/projects/{pid}/ai/team/health", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def _runs(env, pid, tid, mid, n, *, state="finished", minutes_ago=60, **extra):
    now = datetime.now(UTC)
    async with env["maker"]() as s:
        for i in range(n):
            q = now - timedelta(minutes=minutes_ago - i)
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=mid,
                    state=state,
                    number=100 + i,
                    queued_at=q.isoformat(),
                    started_at=q.isoformat(),
                    ended_at=(q + timedelta(minutes=5)).isoformat(),
                    **extra,
                )
            )
        await s.commit()


async def test_with_too_few_runs_there_is_no_verdict_and_no_suggestions(env):
    c = env["c"]
    _, pid, _, m, tid = await _ctx(env)
    await _runs(env, pid, tid, m["id"], 3)
    data = await _health(c, pid)
    assert data["can_judge"] is False and data["state"] == "unknown"
    assert all(v["verdict"] is None for v in data["measures"].values())
    assert data["suggestions"] == []


async def test_reliability_counts_runs_that_finished_ok_and_says_why_the_rest_did_not(
    env,
):
    c = env["c"]
    _, pid, _, m, tid = await _ctx(env)
    await _runs(env, pid, tid, m["id"], 11)
    await _runs(env, pid, tid, m["id"], 1, state="timed_out", minutes_ago=30)
    await _runs(
        env,
        pid,
        tid,
        m["id"],
        1,
        state="failed",
        minutes_ago=20,
        ended_reason="Rate limit reached",
    )
    data = await _health(c, pid)
    rel = data["measures"]["reliability"]
    assert rel["ok"] == 11 and rel["total"] == 13 and rel["verdict"] == "watch"
    assert {x["label"]: x["count"] for x in data["not_ok"]} == {
        "Timed out": 1,
        "Rate limit": 1,
    }
    row = next(r for r in data["per_ai"] if r["id"] == m["id"])
    assert row["runs"] >= 13 and row["ok_share"] is not None


async def test_a_refusal_again_and_again_is_a_fix_with_its_evidence(env):
    c = env["c"]
    _, pid, _, m, tid = await _ctx(env)
    await _runs(env, pid, tid, m["id"], 10)
    async with env["maker"]() as s:
        for i in range(4):
            s.add(
                AiAudit(
                    seq=900 + i,
                    project_id=pid,
                    member_id=m["id"],
                    member_name=m["name"],
                    action="edit_docs",
                    result="blocked",
                    target=tid,
                    detail="{}",
                    created_at=datetime.now(UTC).isoformat(),
                    hash=f"h{i}",
                )
            )
        await s.commit()
    data = await _health(c, pid)
    [s1] = [s for s in data["suggestions"] if s["key"].startswith("refused:")]
    assert s1["severity"] == "fix" and "Edit docs" in s1["title"]
    assert s1["evidence"].startswith("4 refusals") and s1["target"]["id"] == m["id"]
    assert next(r for r in data["per_ai"] if r["id"] == m["id"])["status"] == "fix"
    # dismissing hides it for good and changes nothing else
    r = await c.post(f"/projects/{pid}/ai/team/health/dismiss", json={"key": s1["key"]})
    assert r.status_code == 200 and s1["key"] in r.json()["dismissed"]
    assert not [
        s for s in (await _health(c, pid))["suggestions"] if s["key"] == s1["key"]
    ]


async def test_work_that_goes_back_to_an_ai_after_a_reviewer_is_returned_then_sent_back(
    env,
):
    c = env["c"]
    _, pid, _, dev, tid = await _ctx(env)
    rev = await _runner(c, pid, env["repo"], name="Reviewer Rin", template="reviewer")
    now = datetime.now(UTC)
    chain = [
        (dev["id"], "assign", [], "An Nguyen"),
        (rev["id"], "handoff", [dev["id"]], "An Nguyen"),
        (dev["id"], "handoff", [rev["id"]], "An Nguyen"),  # round 1: normal
        (rev["id"], "handoff", [dev["id"]], "An Nguyen"),
        (dev["id"], "handoff", [rev["id"]], "An Nguyen"),  # round 2: sent back
        (dev["id"], "report_back", [rev["id"]], "An Nguyen"),  # never counted
    ]
    async with env["maker"]() as s:
        for i, (member, trigger, ch, by) in enumerate(chain):
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=member,
                    trigger=trigger,
                    chain=json.dumps(ch),
                    started_by=by,
                    state="finished",
                    number=50 + i,
                    queued_at=(now - timedelta(minutes=30 - i)).isoformat(),
                )
            )
        await s.commit()
        runs = (await s.exec(select(AiRun))).all()
        templates = {p.id: p.template for p in (await s.exec(select(AiMember))).all()}
    evs = flow.events(runs, {dev["id"]: object(), rev["id"]: object()}, templates)
    marks = [
        (e["kind"], e["returned"], e["sent_back"])
        for e in evs
        if e["trigger"] != "assign"
    ]
    assert marks[0] == ("hand-off", False, False)  # first time the reviewer holds it
    assert ("hand-off", True, False) in marks and (
        "hand-off",
        False,
        True,
    ) not in marks[:2]
    assert sum(1 for m in marks if m[2]) == 1
    assert ("report back", False, False) in marks


async def test_range_is_validated(env):
    c = env["c"]
    _, pid, _, m, tid = await _ctx(env)
    assert (
        await c.get(f"/projects/{pid}/ai/team/health", params={"range": "year"})
    ).status_code == 422


async def test_the_team_map_counts_hand_offs_by_pair_and_kind(env):
    c = env["c"]
    _, pid, _, dev, tid = await _ctx(env)
    rev = await _runner(c, pid, env["repo"], name="Reviewer Rin", template="reviewer")
    now = datetime.now(UTC)
    rows = [
        (dev["id"], "assign", [], 40),
        (rev["id"], "handoff", [dev["id"]], 30),
        (dev["id"], "handoff", [rev["id"]], 20),  # returned (round 1)
        (rev["id"], "handoff", [dev["id"]], 10),
        (dev["id"], "handoff", [rev["id"]], 5),  # sent back
        (dev["id"], "report_back", [rev["id"]], 2),
    ]
    async with env["maker"]() as s:
        for i, (member, trig, ch, ago) in enumerate(rows):
            q = now - timedelta(minutes=ago)
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=member,
                    trigger=trig,
                    chain=json.dumps(ch),
                    started_by="An Nguyen",
                    state="finished",
                    number=70 + i,
                    queued_at=q.isoformat(),
                    started_at=(q + timedelta(seconds=90)).isoformat(),
                    ended_at=(q + timedelta(minutes=3)).isoformat(),
                )
            )
        await s.commit()
    data = (await c.get(f"/projects/{pid}/ai/team/flow")).json()
    assert data["stats"]["sent_back"] == 1 and data["stats"]["returned"] == 1
    assert {k["kind"]: k["count"] for k in data["stats"]["kinds"]}["report back"] == 1
    kinds = {(e["from"], e["to"], e["kind"]): e["count"] for e in data["edges"]}
    assert kinds[(dev["id"], rev["id"], "flow")] >= 1
    assert any(k[2] == "sent back" for k in kinds) and any(
        k[2] == "report back" for k in kinds
    )
    assert [p["id"] for p in data["picker"]] == [tid]


async def test_a_ticket_journey_has_lanes_bars_arrows_and_the_split_of_time(env):
    c = env["c"]
    _, pid, an, dev, tid = await _ctx(env)
    r = await c.get(f"/projects/{pid}/ai/team/flow/{tid}")
    assert r.status_code == 200
    j = r.json()
    assert j["ticket"]["id"] == tid and [ln["id"] for ln in j["lanes"]] == [dev["id"]]
    assert len(j["bars"]) == 1 and j["running"] is True
    assert j["strip"]["runs"] == 1 and j["touches"][0]["what"] == "Started it"
    assert (await c.get(f"/projects/{pid}/ai/team/flow/NOPE-1")).status_code == 404


async def _finished(env, pid, tid, mid, **extra):
    now = datetime.now(UTC)
    async with env["maker"]() as s:
        s.add(
            AiRun(
                project_id=pid,
                ticket_id=tid,
                member_id=mid,
                state="finished",
                number=200,
                queued_at=(now - timedelta(minutes=30)).isoformat(),
                started_at=(now - timedelta(minutes=29)).isoformat(),
                ended_at=(now - timedelta(minutes=20)).isoformat(),
                **extra,
            )
        )
        await s.commit()


async def test_a_ticket_is_completed_only_with_a_deliverable_or_a_person_accepting_it(
    env,
):
    from services.ai import health

    c = env["c"]
    _, pid, _, m, tid = await _ctx(env)
    # the run that _ctx made is still running; the ticket has no finished work run yet
    other = await _ticket(c, pid, "No deliverable")
    await _finished(env, pid, other, m["id"])  # finished, but nothing was delivered
    delivered = await _ticket(c, pid, "Has files")
    await _finished(env, pid, delivered, m["id"], files=json.dumps([{"path": "a.py"}]))
    async with env["maker"]() as s:
        d = await health.load(s, pid, datetime.now(UTC) - timedelta(days=1))
    done = {
        x.ticket_id: x
        for x in health.completed(
            d, datetime.now(UTC) - timedelta(days=1), datetime.now(UTC)
        )
    }
    assert other not in done and delivered in done
    assert done[delivered].deliverable["kind"] == "files"
    # a person moving it to Done counts as accepting it, even with no files
    await c.patch(f"/tickets/{other}", json={"status": "done"})
    async with env["maker"]() as s:
        d = await health.load(s, pid, datetime.now(UTC) - timedelta(days=1))
    done = {
        x.ticket_id: x
        for x in health.completed(
            d, datetime.now(UTC) - timedelta(days=1), datetime.now(UTC)
        )
    }
    assert other in done and done[other].deliverable["kind"] is None


async def test_the_map_orders_the_team_as_it_usually_works_and_marks_a_skipped_step(
    env,
):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    ba = await _runner(c, pid, env["repo"], name="BA Bao")
    dev = await _runner(c, pid, env["repo"], name="Dev An")
    now = datetime.now(UTC)
    steps = []  # PM -> BA -> Dev on three tickets, then PM -> Dev on a fourth (skips BA)
    tickets = [await _ticket(c, pid, f"T{i}") for i in range(4)]
    for t in tickets[:3]:
        steps += [
            (t, pm["id"], "assign", []),
            (t, ba["id"], "handoff", [pm["id"]]),
            (t, dev["id"], "handoff", [ba["id"]]),
        ]
    steps += [
        (tickets[3], pm["id"], "assign", []),
        (tickets[3], dev["id"], "handoff", [pm["id"]]),
    ]
    async with env["maker"]() as s:
        for i, (t, mid, trig, ch) in enumerate(steps):
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=t,
                    member_id=mid,
                    trigger=trig,
                    chain=json.dumps(ch),
                    started_by="An Nguyen",
                    state="finished",
                    number=300 + i,
                    queued_at=(now - timedelta(minutes=90 - i)).isoformat(),
                )
            )
        await s.commit()
    data = (await c.get(f"/projects/{pid}/ai/team/flow")).json()
    names = [n["name"] for n in data["nodes"]]
    assert names.index("BA Bao") < names.index("Dev An")
    skips = [e for e in data["edges"] if e["kind"] == "skip"]
    assert (
        len(skips) == 1 and skips[0]["skipped"] == ["BA Bao"] and skips[0]["count"] == 1
    )


async def test_a_repeated_question_comes_with_the_text_to_add_to_the_instructions(env):
    c = env["c"]
    _, pid, _, m, tid = await _ctx(env)
    await _runs(env, pid, tid, m["id"], 10)
    now = datetime.now(UTC)
    async with env["maker"]() as s:
        for i in range(3):
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=m["id"],
                    state="finished",
                    answer="staging",
                    number=400 + i,
                    queued_at=(now - timedelta(minutes=40 - i)).isoformat(),
                    question=json.dumps(
                        {
                            "text": "Which environment?",
                            "asked_at": (now - timedelta(minutes=40 - i)).isoformat(),
                            "answered_at": (
                                now - timedelta(minutes=35 - i)
                            ).isoformat(),
                            "answered_by": "Hoa Mai",
                        }
                    ),
                    ended_at=now.isoformat(),
                )
            )
        await s.commit()
    data = await _health(c, pid)
    [s1] = [s for s in data["suggestions"] if s["key"].startswith("repeat:")]
    assert s1["draft"]["member_id"] == m["id"] and s1["draft"]["limit"] == 1000
    assert (
        "Which environment?" in s1["draft"]["text"] and "staging" in s1["draft"]["text"]
    )


async def test_a_docs_deliverable_shows_versions_and_review_threads(env):
    from models import DocsCommentThread, DocsPage, DocsVersion

    c = env["c"]
    _, pid, _, dev, tid = await _ctx(env)
    now = datetime.now(UTC)
    async with env["maker"]() as s:
        run = (await s.exec(select(AiRun))).first()
        run.queued_at = (now - timedelta(minutes=50)).isoformat()
        s.add(run)
        page = DocsPage(
            project_id=pid, title="UX design", slug="ux", version=2, status="published"
        )
        s.add(page)
        await s.commit()
        await s.refresh(page)
        for v in (1, 2):
            s.add(
                DocsVersion(
                    page_id=page.id,
                    version=v,
                    title="UX design",
                    author=dev["name"],
                    created_at=(now - timedelta(minutes=40 - v)).isoformat(),
                )
            )
        for state, anchor in (
            ("resolved", "attached"),
            ("open", "attached"),
            ("open", "orphaned"),
        ):
            s.add(
                DocsCommentThread(
                    page_id=page.id,
                    status=state,
                    anchor_state=anchor,
                    created_by="Reviewer Rin",
                    created_at=(now - timedelta(minutes=30)).isoformat(),
                )
            )
        await s.commit()
    j = (await c.get(f"/projects/{pid}/ai/team/flow/{tid}")).json()
    [doc] = j["docs"]
    assert doc["title"] == "UX design" and [v["version"] for v in doc["versions"]] == [
        1,
        2,
    ]
    assert (
        doc["counts"] == {"resolved": 1, "open": 1, "orphaned": 1}
        and doc["needs_person"] == 2
    )
    assert j["strip"]["deliverable"]["kind"] == "docs"


async def test_a_parent_ticket_rolls_up_its_children_and_says_what_blocks_the_rest(env):
    c = env["c"]
    ctx, pid, _, pm, parent = await _ctx(env)
    dev = await _runner(c, pid, env["repo"], name="Dev An")
    design = await _ticket(c, pid, "Design", parent_id=parent)
    build = await _ticket(c, pid, "Build", parent_id=parent)
    now = datetime.now(UTC)
    async with env["maker"]() as s:
        from models import Ticket

        row = await s.get(Ticket, build)
        row.blocked_by = json.dumps([design])
        s.add(row)
        s.add(
            AiRun(
                project_id=pid,
                ticket_id=design,
                member_id=dev["id"],
                state="needs_input",
                question=json.dumps(
                    {
                        "text": "Which layout?",
                        "asked_at": (now - timedelta(minutes=5)).isoformat(),
                    }
                ),
                queued_at=(now - timedelta(minutes=20)).isoformat(),
                started_at=(now - timedelta(minutes=19)).isoformat(),
                number=1,
            )
        )
        await s.commit()
    j = (await c.get(f"/projects/{pid}/ai/team/flow/{parent}")).json()
    rows = {r["id"]: r for r in j["parent"]["children"]}
    assert (
        rows[design]["state"] == "waiting_you" and rows[design]["held_by"] == "Dev An"
    )
    assert rows[build]["state"] == "blocked" and rows[build]["blockers"] == [design]
    assert (
        j["parent"]["alert"]["child"] == build
        and design in j["parent"]["alert"]["text"]
    )
    assert (
        j["parent"]["tiles"]["children"] == 2 and j["parent"]["tiles"]["blocked"] == 1
    )
