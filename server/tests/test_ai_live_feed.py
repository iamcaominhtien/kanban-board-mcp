"""AI Team › Flow › Live commentary (services/ai/live_feed.py): the sentences, their order, the cursor (nothing skipped,
nothing twice), secrets kept out, and a real run of the fake CLI showing up as lines."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from models import AiRun, AiTicketStep, AiTicketWorkflow
from services.ai import live_feed
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


@pytest.fixture(autouse=True)
def _route():
    """The route, also before main.py includes its router."""
    from api.ai_live_feed import router
    from main import app

    if not any(
        getattr(r, "path", "") == "/projects/{project_id}/ai/live-feed"
        for r in app.routes
    ):
        # ahead of the app's catch-all page route, where main.py puts it among the other routers
        before = list(app.router.routes)
        app.include_router(router)
        added = [r for r in app.router.routes if r not in before]
        app.router.routes[:] = added + before


# ------------------------------------------------------------------------------------------------- the sentences


def test_board_calls_read_as_plain_sentences():
    assert live_feed.board_sentence("board.manage_ticket.update(WX-21)") == (
        "Updated WX-21",
        "info",
    )
    assert live_feed.board_sentence("board.ai_run.report()") == (
        "Reported its work",
        "good",
    )
    assert live_feed.board_sentence("board.get_ticket(WX-3)")[0] == "Read WX-3"
    assert live_feed.board_sentence("board.ticket_items.comment.add(WX-3)")[0] == (
        "Commented on WX-3"
    )
    assert live_feed.board_sentence("board.list_tickets()")[0] == (
        "Looked over the board"
    )


def test_steps_read_as_friendly_lines_and_noise_is_skipped():
    s = live_feed.step_sentence
    assert s({"kind": "command", "text": "Ran npm test"}) == (
        "command",
        "Ran `npm test`",
        "info",
    )
    assert s({"kind": "edit", "text": "Edited src/search.js"})[1] == (
        "Edited src/search.js"
    )
    assert s({"kind": "read", "text": "Sent the ticket"})[1] == "Read the ticket"
    assert s({"kind": "say", "text": "Looking at the search box"})[1] == (
        "Said: Looking at the search box"
    )
    assert s({"kind": "question", "text": "Asked An: Which colour?"}) == (
        "question",
        "Asks: Which colour?",
        "warn",
    )
    long = s({"kind": "say", "text": "word " * 200})[1]
    assert len(long) <= live_feed.TEXT_MAX and long.endswith("…")
    for noise in ("system", "compact", "window", "context", "start", "end"):
        assert s({"kind": noise, "text": "anything"}) is None
    assert live_feed.result_sentence({"tests": {"passed": 12, "failed": 1}}) == (
        "12 passed, 1 failed",
        "bad",
    )
    assert live_feed.result_sentence({"tests": {"passed": 3, "failed": 0}}) == (
        "3 passed",
        "good",
    )
    assert live_feed.result_sentence({"exit_code": 0, "output": "ok"}) is None


def test_step_times_cross_midnight():
    base = datetime(2026, 11, 1, 23, 58, 30, tzinfo=UTC)
    times = live_feed.step_times(
        [{"at": "23:58:31"}, {"at": "23:59:59"}, {"at": "00:00:04"}, {"at": "bad"}],
        base,
    )
    assert times[0] == datetime(2026, 11, 1, 23, 58, 31, tzinfo=UTC)
    assert times[1].day == 1
    assert times[2] == datetime(2026, 11, 2, 0, 0, 4, tzinfo=UTC)
    assert times[3] == times[2]  # an unreadable time keeps the one before


def test_secrets_never_reach_the_feed():
    run = AiRun(
        id="run_x",
        project_id="p",
        ticket_id="KAN-1",
        member_id="m",
        state="running",
        queued_at=datetime.now(UTC).isoformat(),
        steps=json.dumps(
            [
                {
                    "at": "00:00:01",
                    "kind": "command",
                    "text": "Ran curl -H 'Authorization: Bearer\x20sk-ant\x2dapi03-abcdefghijklmnopqrstuvwxyz0123'",
                },
                {
                    "at": "00:00:02",
                    "kind": "say",
                    "text": "The key is sk-ant\x2dapi03-abcdefghijklmnopqrstuvwxyz0123",
                },
            ]
        ),
    )
    items = live_feed.run_items(run, live_feed._unknown("m"))
    blob = json.dumps([i.text for i in items])
    assert "abcdefghijklmnopqrstuvwxyz0123" not in blob
    assert any(i.kind == "say" for i in items)


# --------------------------------------------------------------------------------------------- order and the cursor


async def _add(env, *rows):
    async with env["maker"]() as s:
        for r in rows:
            s.add(r)
        await s.commit()


def _hms(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%H:%M:%S")


async def _feed(c, pid, after=None, limit=200):
    params = {"limit": limit, **({"after": after} if after else {})}
    r = await c.get(f"/projects/{pid}/ai/live-feed", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def test_feed_orders_lines_and_the_cursor_never_skips_or_repeats(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], name="Dev AI")
    tid = await _ticket(c, pid)
    now = datetime.now(UTC).replace(microsecond=0)
    t0 = now - timedelta(minutes=10)
    steps = [
        {
            "at": _hms(t0 + timedelta(seconds=1)),
            "kind": "read",
            "text": "Sent the ticket",
        },
        {
            "at": _hms(t0 + timedelta(seconds=2)),
            "kind": "edit",
            "text": "Edited calc.py",
        },
        {
            "at": _hms(t0 + timedelta(seconds=2)),
            "kind": "edit",
            "text": "Edited calc.py",
        },
        {
            "at": _hms(t0 + timedelta(seconds=3)),
            "kind": "command",
            "text": "Ran pytest -q",
            "tool_id": "t1",
            "exit_code": 1,
            "output": "12 passed, 1 failed",
            "tests": {"passed": 12, "failed": 1},
        },
        {
            "at": _hms(t0 + timedelta(seconds=9)),
            "kind": "board",
            "text": f"board.manage_ticket.update({tid})",
        },
        {
            "at": _hms(t0 + timedelta(seconds=10)),
            "kind": "window",
            "text": "context 40%",
        },
    ]
    run = AiRun(
        project_id=pid,
        ticket_id=tid,
        member_id=m["id"],
        state="finished",
        trigger="assign",
        queued_at=t0.isoformat(),
        started_at=(t0 + timedelta(milliseconds=500)).isoformat(),
        ended_at=(t0 + timedelta(seconds=20)).isoformat(),
        last_output_at=(t0 + timedelta(seconds=20)).isoformat(),
        summary="Fixed add() and its test.\nMore detail.",
        steps=json.dumps(steps),
    )
    await _add(env, run)

    first = await _feed(c, pid)
    texts = [i["text"] for i in first["items"]]
    assert texts == [
        "Queued",
        "Started work",
        "Read the ticket",
        "Edited calc.py",  # the same line twice in a row is shown once
        "Ran `pytest -q`",
        # told when the run moved past the command, at that time, right after the command
        "`pytest -q` — 12 passed, 1 failed",
        f"Updated {tid}",
        "Finished: Fixed add() and its test.",
    ]
    item = first["items"][0]
    assert item["member_id"] == m["id"] and item["member_name"] == "Dev AI"
    assert item["color"] and item["glyph"] and item["ticket_id"] == tid
    assert item["at"].startswith(t0.date().isoformat())
    tones = {i["text"]: i["tone"] for i in first["items"]}
    assert tones["`pytest -q` — 12 passed, 1 failed"] == "bad"
    assert tones["Finished: Fixed add() and its test."] == "good"
    ats = [i["at"] for i in first["items"]]
    assert ats == sorted(ats)
    assert len({i["id"] for i in first["items"]}) == len(first["items"])

    # nothing new: nothing comes back
    again = await _feed(c, pid, first["cursor"])
    assert again["items"] == []

    # a second run, and a line stamped a moment before the newest one seen (committed late): each comes once
    late = AiRun(
        project_id=pid,
        ticket_id=tid,
        member_id=m["id"],
        state="needs_input",
        mode="ask",
        trigger="mention",
        queued_at=(t0 + timedelta(seconds=15)).isoformat(),
        started_at=(t0 + timedelta(seconds=16)).isoformat(),
        last_output_at=now.isoformat(),
        steps=json.dumps(
            [
                {
                    "at": _hms(t0 + timedelta(seconds=17)),
                    "kind": "question",
                    "text": "Asked An: Keep the old name?",
                }
            ]
        ),
    )
    await _add(env, late)
    nxt = await _feed(c, pid, again["cursor"])
    assert [i["text"] for i in nxt["items"]] == [
        "Queued",
        "Started answering a question",
        "Asks: Keep the old name?",
    ]
    assert nxt["working"] == [m["id"]]
    assert (await _feed(c, pid, nxt["cursor"]))["items"] == []

    # a first load with a small limit shows the newest lines, and its cursor goes on from there
    page = await _feed(c, pid, None, limit=2)
    assert [i["text"] for i in page["items"]] == [
        "Asks: Keep the old name?",
        "Finished: Fixed add() and its test.",
    ]
    assert (await _feed(c, pid, page["cursor"], limit=2))["items"] == []


async def test_paging_with_a_cursor_delivers_every_line_once(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], name="Dev AI")
    tid = await _ticket(c, pid)
    first = await _feed(c, pid)
    assert first["items"] == []
    t0 = datetime.now(UTC).replace(microsecond=0) + timedelta(seconds=1)
    steps = [
        {
            "at": _hms(t0 + timedelta(seconds=i // 3)),
            "kind": "edit",
            "text": f"Edited f{i}.py",
        }
        for i in range(9)
    ]
    await _add(
        env,
        AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=m["id"],
            state="finished",
            trigger="workflow",  # the workflow's step says it started: no "Started work"
            queued_at=t0.isoformat(),
            ended_at=(t0 + timedelta(seconds=5)).isoformat(),
            steps=json.dumps(steps),
        ),
    )
    got, cur = [], first["cursor"]
    for _ in range(10):
        page = await _feed(c, pid, cur, limit=4)
        got += page["items"]
        cur = page["cursor"]
        if not page["items"]:
            break
    texts = [i["text"] for i in got]
    assert texts == ["Queued", *[f"Edited f{i}.py" for i in range(9)], "Finished"]
    assert len({i["id"] for i in got}) == len(got)


async def test_workflow_moves_and_the_board_speak_too(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], name="Reviewer AI")
    tid = await _ticket(c, pid)
    now = datetime.now(UTC).replace(microsecond=0)
    at = lambda s: (now - timedelta(minutes=5) + timedelta(seconds=s)).isoformat()  # noqa: E731
    await _add(
        env,
        AiTicketWorkflow(
            ticket_id=tid,
            project_id=pid,
            template_key="quick_fix",
            template_name="Quick fix",
            attached_by="the board (intake)",
            created_at=at(0),
            updated_at=at(0),
        ),
        AiTicketStep(
            ticket_id=tid,
            seq=0,
            idx=0,
            key="checks",
            label="Checks",
            kind="code",
            state="done",
            outcome="failed",
            note="pytest failed: `pytest -q`\nE assert",
            started_at=at(1),
            ended_at=at(2),
        ),
        AiTicketStep(
            ticket_id=tid,
            seq=1,
            idx=1,
            key="review",
            label="Review",
            kind="ai",
            role="reviewer",
            member_id=m["id"],
            state="done",
            outcome="changes",
            note="Add a test for []",
            started_at=at(3),
            ended_at=at(4),
        ),
        AiTicketStep(
            ticket_id=tid,
            seq=2,
            idx=2,
            key="done",
            label="Done",
            kind="person",
            state="done",
            outcome="board",
            started_at=at(5),
            ended_at=at(6),
        ),
    )
    items = (await _feed(c, pid))["items"]
    lines = [(i["member_name"], i["text"], i["tone"]) for i in items]
    assert lines == [
        ("Board", "Took the ticket in for the team: Quick fix", "info"),
        ("Board", "Running the checks", "info"),
        ("Board", "Checks failed: pytest failed: `pytest -q`", "bad"),
        ("Reviewer AI", "Started the Review step", "info"),
        ("Reviewer AI", "Asked for changes: Add a test for []", "warn"),
        (
            "Board",
            "Moved it to Done: the checks, the test-first rule and the review all passed",
            "good",
        ),
    ]
    assert items[0]["member_id"] is None and items[0]["glyph"] == "board"


async def test_unknown_project_and_a_bad_cursor(env):
    c = env["c"]
    assert (await c.get("/projects/nope/ai/live-feed")).status_code == 404
    pid, _ = await _project(c)
    r = await c.get(f"/projects/{pid}/ai/live-feed", params={"after": "not-a-cursor"})
    assert r.status_code == 200 and r.json()["items"] == []


# ---------------------------------------------------------------------------------------------- a real (fake) run


async def test_a_run_of_the_fake_cli_shows_up_as_lines(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    r = await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    assert r.status_code == 200, r.text
    await _wait(c, tid, ("finished", "failed"), timeout=30)
    items = (await _feed(c, pid))["items"]
    texts = [i["text"] for i in items]
    assert texts[0] == "Queued" and "Started work" in texts
    assert any(t.startswith(("Finished", "Failed")) for t in texts)
    assert all(i["member_id"] == m["id"] for i in items)
    assert len(items) > 3
