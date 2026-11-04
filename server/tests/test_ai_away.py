"""AI Team, Now, While you were away (services/ai/away.py): how far each Story moved, what finished, each time a
person was needed, the decisions taken for them, the cost and what failed, counted from what the board keeps."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from models import AiDecision, AiRun, Story, Ticket
from services.ai import away
from tests.ai_helpers import _project, _runner, _ticket, env  # noqa: F401


@pytest.fixture(autouse=True)
def _the_board_does_not_drive_the_seeded_story(monkeypatch):
    """The seed writes a Story under way by hand: the manager's tick must not start its tickets meanwhile."""
    from services import stories

    async def _no_tick(project_id):
        return None

    monkeypatch.setattr(stories, "tick", _no_tick)


def _t(minutes_ago: float) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat()


async def _add(env, *rows):
    async with env["maker"]() as s:
        for r in rows:
            s.add(r)
        await s.commit()


async def _seed(env):
    """Away for two hours: the Story went from In progress to Review and one of its tickets was built and moved to
    Done; another failed and was tried again, then asked a question that still waits; the PM decided once."""
    c = env["c"]
    pid, _ = await _project(c)
    dev = (await _runner(c, pid, env["repo"], name="Dev"))["id"]
    pm = (await _runner(c, pid, env["repo"], name="PM"))["id"]
    story = await _ticket(c, pid, title="Weather app", status="backlog", type="story")
    a = await _ticket(c, pid, title="Search a city", status="backlog", parent_id=story)
    b = await _ticket(c, pid, title="Seven-day list", status="backlog", parent_id=story)
    other = await _ticket(c, pid, title="Fix scroll jump", status="backlog")
    async with env["maker"]() as s:
        row = await s.get(Story, story) or Story(ticket_id=story, project_id=pid)
        row.state = "review"
        row.pm_id = pm
        row.created_at = _t(600)
        row.history = json.dumps(
            [
                {"at": _t(500), "state": "planning", "by": "An"},
                {"at": _t(400), "state": "in_progress", "by": "PM"},
                {"at": _t(30), "state": "review", "by": "PM"},
            ]
        )
        s.add(row)
        for tid in (a, b):
            t = await s.get(Ticket, tid)
            t.created_at = _t(450)
            if tid == a:
                t.status = "done"
                t.activity_log = json.dumps(
                    [
                        {
                            "field": "status",
                            "from": "todo",
                            "to": "done",
                            "at": _t(60),
                            "actor": "An",
                        }
                    ]
                )
            s.add(t)
        await s.commit()
    await _add(
        env,
        AiRun(
            id="a1",
            project_id=pid,
            ticket_id=a,
            member_id=dev,
            number=1,
            trigger="assign",
            state="finished",
            queued_at=_t(100),
            started_at=_t(99),
            ended_at=_t(80),
            cost_usd=1.5,
            metered=True,
            tokens_in=1000,
            tokens_out=500,
            files=json.dumps(["search.ts"]),
        ),
        AiRun(
            id="b1",
            project_id=pid,
            ticket_id=b,
            member_id=dev,
            number=1,
            trigger="assign",
            state="failed",
            ended_reason="Tests timed out\nmore",
            queued_at=_t(70),
            started_at=_t(69),
            ended_at=_t(60),
            tokens_in=200,
        ),
        AiRun(
            id="b2",
            project_id=pid,
            ticket_id=b,
            member_id=dev,
            number=2,
            trigger="retry",
            state="needs_input",
            queued_at=_t(50),
            started_at=_t(49),
            question=json.dumps({"text": "Which sender address?", "asked_at": _t(40)}),
        ),
        AiRun(
            id="o1",
            project_id=pid,
            ticket_id=other,
            member_id=dev,
            number=1,
            trigger="assign",
            state="finished",
            queued_at=_t(300),  # before you left: not counted
            started_at=_t(299),
            ended_at=_t(290),
            cost_usd=9.0,
            metered=True,
        ),
        AiDecision(
            project_id=pid,
            ticket_id=a,
            story_id=story,
            member_id=pm,
            kind="retry",
            title=f"Retried {b}",
            at=_t(55),
        ),
        AiDecision(
            project_id=pid,
            ticket_id=a,
            member_id=pm,
            kind="answer",
            title="Answered before you left",
            at=_t(200),
        ),
    )
    return c, pid, dev, pm, story, a, b


async def test_what_happened_while_you_were_away(env):
    c, pid, dev, pm, story, a, b = await _seed(env)
    r = await c.get(f"/projects/{pid}/ai/away", params={"since": _t(120)})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ran"] is True and out["paused_all"] is False
    assert out["stories"] == [
        {
            "id": story,
            "title": "Weather app",
            "from": {"state": "in_progress", "done": 0, "total": 2},
            "to": {"state": "review", "done": 1, "total": 2},
            "runs": 3,
        }
    ]
    assert [(f["ticket_id"], f["title"], f["story_id"]) for f in out["finished"]] == [
        (a, "Search a city", story)
    ]
    assert [
        (n["kind"], n["ticket_id"], n["text"], n["open"]) for n in out["needed"]
    ] == [("question", b, "Which sender address?", True)]
    assert out["needed"][0]["story_id"] == story
    assert out["decided"] == {"count": 1, "overridable": 0}
    assert out["spent"]["usd"] == 1.5 and out["spent"]["tokens"] == 1700
    assert out["spent"]["by_story"] == [
        {"story_id": story, "title": "Weather app", "usd": 1.5, "tokens": 1700}
    ]
    assert out["failed"] == [
        {
            "run_id": "b1",
            "ticket_id": b,
            "member_id": dev,
            "at": out["failed"][0]["at"],
            "text": "Tests timed out",
            "retried": True,
            "retry_state": "needs_input",
        }
    ]
    assert out["waiting"] == 1  # the question is on the Now tab's Needs you list


async def test_nothing_happened_and_a_bad_time(env):
    c, pid, *_ = await _seed(env)
    out = (await c.get(f"/projects/{pid}/ai/away", params={"since": _t(-1)})).json()
    assert out["ran"] is False
    assert out["stories"] == out["finished"] == out["needed"] == out["failed"] == []
    assert out["decided"] == {"count": 0, "overridable": 0}
    assert out["spent"]["usd"] == 0 and out["spent"]["by_story"] == []
    # the question still waits: that is the present, not what happened
    assert out["waiting"] == 1
    assert (
        await c.get(f"/projects/{pid}/ai/away", params={"since": "yesterday"})
    ).status_code == 422
    assert (await c.get(f"/projects/{pid}/ai/away")).status_code == 422
    assert (
        await c.get("/projects/nope/ai/away", params={"since": _t(10)})
    ).status_code == 404


def test_a_status_and_a_story_state_at_a_time():
    now = datetime.now(UTC)
    t = Ticket(
        id="KAN-1",
        project_id="p",
        title="x",
        status="done",
        created_at=(now - timedelta(hours=5)).isoformat(),
        activity_log=json.dumps(
            [
                {
                    "field": "status",
                    "from": "todo",
                    "to": "in-progress",
                    "at": (now - timedelta(hours=3)).isoformat(),
                },
                {
                    "field": "title",
                    "from": "a",
                    "to": "b",
                    "at": (now - timedelta(hours=2)).isoformat(),
                },
                {
                    "field": "status",
                    "from": "in-progress",
                    "to": "done",
                    "at": (now - timedelta(hours=1)).isoformat(),
                },
            ]
        ),
    )
    assert away.status_at(t, now - timedelta(hours=6)) is None  # not made yet
    assert away.status_at(t, now - timedelta(hours=4)) == "todo"
    assert away.status_at(t, now - timedelta(hours=2)) == "in-progress"
    assert away.status_at(t, now) == "done"
    row = Story(
        ticket_id="KAN-1",
        project_id="p",
        created_at=(now - timedelta(hours=5)).isoformat(),
        history=json.dumps(
            [{"at": (now - timedelta(hours=2)).isoformat(), "state": "planning"}]
        ),
    )
    assert away.story_state_at(row, now - timedelta(hours=3)) == "draft"
    assert away.story_state_at(row, now) == "planning"
    assert away.story_state_at(None, now) is None
