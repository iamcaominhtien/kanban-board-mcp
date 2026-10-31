"""The AI Team view, Now tab: a card per AI, what waits for a person, recent hand-offs and the totals of the range."""

import json
from datetime import UTC, datetime, timedelta

from sqlmodel import select

from models import AiMember, AiRun, DocsAiProposal, DocsPage
from tests.test_ai import (  # noqa: F401
    _ctx,
    _runner,
    _ticket,
    env,
)


async def _now(c, pid, **params):
    r = await c.get(f"/projects/{pid}/ai/team/now", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _card(data, member_id):
    return next(m for m in data["members"] if m["id"] == member_id)


async def _add_run(env, **fields):
    async with env["maker"]() as s:
        run = AiRun(**fields)
        s.add(run)
        await s.commit()
        await s.refresh(run)
        return run.id


async def test_a_running_ai_is_working_on_its_ticket_and_an_idle_one_is_idle(env):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    bao = await _runner(c, pid, env["repo"], name="BA Bao")
    data = await _now(c, pid)
    card = _card(data, pm["id"])
    assert card["state"] == "working" and card["current"]["ticket_id"] == tid
    assert card["current"]["ticket_title"] == "Fix add()"
    assert _card(data, bao["id"])["state"] == "idle"
    assert data["counts"] == {"working": 1, "idle": 1}
    assert data["totals"]["running"] == 1 and data["needs_you"] == []
    assert data["totals"]["touches"] == 0


async def test_a_question_makes_the_ai_wait_for_you_and_heads_the_list(env):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    async with env["maker"]() as s:
        run = (await s.exec(select(AiRun).where(AiRun.member_id == pm["id"]))).one()
        run.state = "needs_input"
        run.question = json.dumps(
            {
                "text": "Include archived tickets?",
                "options": [],
                "asked_at": (datetime.now(UTC) - timedelta(minutes=41)).isoformat(),
            }
        )
        s.add(run)
        await s.commit()
    data = await _now(c, pid)
    assert _card(data, pm["id"])["state"] == "waiting"
    (item,) = data["needs_you"]
    assert item["kind"] == "question" and item["text"] == "Include archived tickets?"
    assert item["ticket_id"] == tid and 40 * 60 <= item["waiting_s"] <= 42 * 60


async def test_an_offline_member_is_an_item_with_its_waiting_tickets(env):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    bao = await _runner(c, pid, env["repo"], name="BA Bao")
    waiting = await _ticket(c, pid, "Brief")
    await c.patch(f"/tickets/{waiting}", json={"assignee": bao["id"]})
    async with env["maker"]() as s:
        profile = await s.get(AiMember, bao["id"])
        profile.health = "not_logged_in"
        s.add(profile)
        await s.commit()
    data = await _now(c, pid)
    assert _card(data, bao["id"])["state"] == "offline"
    (item,) = [i for i in data["needs_you"] if i["kind"] == "offline"]
    assert item["member_name"] == "BA Bao" and item["tickets_waiting"] == [waiting]


async def test_hand_offs_say_who_passed_what_and_how(env):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    bao = await _runner(c, pid, env["repo"], name="BA Bao")
    other = await _ticket(c, pid, "Brief")
    for trigger, sender, target in (
        ("handoff", pm["id"], bao["id"]),
        ("report_back", bao["id"], pm["id"]),
    ):
        await _add_run(
            env,
            project_id=pid,
            ticket_id=other,
            member_id=target,
            state="finished",
            trigger=trigger,
            chain=json.dumps([sender]),
            started_by="An Nguyen",
            ended_at=datetime.now(UTC).isoformat(),
        )
    data = await _now(c, pid)
    kinds = {(h["kind"], h["from"]["name"], h["to"]["name"]) for h in data["handoffs"]}
    assert ("hand-off", pm["name"], "BA Bao") in kinds
    assert ("report back", "BA Bao", pm["name"]) in kinds


async def test_a_person_starting_an_ai_is_an_assignment_from_that_person(env):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    data = await _now(c, pid)
    (h,) = data["handoffs"]
    assert h["kind"] == "assigned" and h["from"]["name"] == "An Nguyen"
    assert h["to"]["id"] == pm["id"]


async def test_the_range_decides_which_runs_are_counted(env):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    await _add_run(
        env,
        project_id=pid,
        ticket_id=tid,
        member_id=pm["id"],
        state="finished",
        queued_at=(datetime.now(UTC) - timedelta(days=3)).isoformat(),
        ended_at=(datetime.now(UTC) - timedelta(days=3)).isoformat(),
    )
    today = await _now(c, pid)
    week = await _now(c, pid, range="7d")
    assert today["totals"]["runs"] == 1 and week["totals"]["runs"] == 2
    # runs so far at seven even steps of the window: the old one counts from day 4 on, the new one at the end
    assert week["range"] == "7d"
    assert _card(week, pm["id"])["spark"] == [0, 0, 0, 0, 1, 1, 2]
    bad = await c.get(f"/projects/{pid}/ai/team/now", params={"range": "year"})
    assert bad.status_code == 422


async def test_a_local_runner_shows_tokens_never_zero_dollars(env):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    await _add_run(
        env,
        project_id=pid,
        ticket_id=tid,
        member_id=pm["id"],
        state="finished",
        tokens_in=250_000,
        tokens_cached=225_000,
        tokens_out=1_000,
        ended_at=datetime.now(UTC).isoformat(),
    )
    usage = _card(await _now(c, pid), pm["id"])["usage"]
    assert usage["metered"] is False and usage["tokens"] == 251_000
    assert (
        usage["tokens_cached"] == 225_000 and usage["tokens_kind"] == "new_and_cached"
    )


async def test_docs_proposals_are_listed_once_with_their_page(env):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    async with env["maker"]() as s:
        page = DocsPage(project_id=pid, title="UX design", slug="ux-design", version=3)
        s.add(page)
        await s.commit()
        await s.refresh(page)
        s.add(
            DocsAiProposal(
                project_id=pid,
                page_id=page.id,
                member_id=pm["id"],
                ticket_id=tid,
                summary="Two changes",
                changes=json.dumps(
                    [{"n": 1, "status": "pending"}, {"n": 2, "status": "pending"}]
                ),
            )
        )
        await s.commit()
    data = await _now(c, pid)
    (item,) = data["needs_you"]
    assert item["kind"] == "docs_proposal" and item["changes"] == 2
    assert item["page_title"] == "UX design" and item["page_version"] == 3


async def test_a_question_to_a_person_is_a_hand_off_to_them(env):
    c = env["c"]
    _, pid, _, pm, tid = await _ctx(env)
    async with env["maker"]() as s:
        run = (await s.exec(select(AiRun).where(AiRun.member_id == pm["id"]))).one()
        run.question = json.dumps({"text": "Which format?", "asked_at": run.queued_at})
        s.add(run)
        await s.commit()
    data = await _now(c, pid)
    asked = [h for h in data["handoffs"] if h["kind"] == "asked you"]
    assert len(asked) == 1
    assert asked[0]["from"]["id"] == pm["id"] and asked[0]["to"]["kind"] == "person"
