"""Talking to the AI team and handing work over with nothing lost (issue #272), against the fake CLI: every workflow
step leaves a fixed-form handoff note on the ticket and the next role reads it first; a person takes a ticket back
mid-run and gives it back; an outside agent's branch and page become the team's input in one call; the ticket says
who holds it; and an outside agent drives a whole Story over MCP: gives the goal, follows it with board_wait,
answers the PM's question and approves the plan."""

import asyncio
import json

import pytest
from sqlmodel import select

from kanban_mcp.tools.knowledge import board_wait
from models import AiRun
from services.ai import handoff, runs, workflow
from services.ai.context import RunContext
from tests.ai_helpers import _project, _ticket, _wait, env  # noqa: F401
from tests.test_ai_manager import _ops, _story
from tests.test_ai_workflow import _at_done, _team, _until
from tests.test_mcp_ai_team import call, team


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


@pytest.fixture
def prompts(tmp_path, monkeypatch):
    """Each workflow step's prompt as the fake CLI got it, and a handoff note at the end of what it says."""
    path = tmp_path / "prompts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_HANDOFF", "1")
    monkeypatch.setenv("FAKE_CLAUDE_PROMPTS", str(path))

    def read() -> list[dict]:
        return (
            [json.loads(x) for x in path.read_text().splitlines()]
            if path.exists()
            else []
        )

    return read


def _notes(ticket: dict) -> list[dict]:
    return [c["handoff"] for c in ticket["comments"] if c.get("handoff")]


async def _template(c, pid, key, steps):
    r = await c.put(
        f"/projects/{pid}/ai/workflows/{key}",
        json={"name": key.upper(), "steps": steps},
    )
    assert r.status_code == 200, r.text


BA_DEV_QA = [
    {"key": "shape", "label": "Shape", "kind": "ai", "role": "ba"},
    {"key": "build", "label": "Build", "kind": "ai", "role": "dev"},
    {"key": "test", "label": "Test", "kind": "ai", "role": "qa"},
    {"key": "done", "label": "Done", "kind": "person"},
]


# --------------------------------------------------------------------------- the note itself


def test_a_note_is_read_from_the_end_of_a_final_message():
    text = (
        "Built it.\n\nHANDOFF\nDone: the parser and its tests.\nWhere: branch `feat/parse`, src/parse.py\n"
        "Left: Nothing.\nCheck: an empty file, which I did not try\nand a BOM.\nVERDICT: PASS"
    )
    note = handoff.parse(text)
    assert note == {
        "done": "the parser and its tests.",
        "where": "branch `feat/parse`, src/parse.py",
        "left": "Nothing.",
        "check": "an empty file, which I did not try and a BOM.",
    }
    assert (
        handoff.parse("**Handoff note**\n- **Done:** x\n- **Left:** y")["left"] == "y"
    )
    assert handoff.parse("No note here. Done: nothing") is None
    assert handoff.clean({"done": " ", "where": None}) is None


def test_without_a_note_the_board_says_what_it_knows_and_that_the_rest_was_not_said():
    run = AiRun(
        project_id="p",
        ticket_id="KAN-1",
        member_id="m",
        report=json.dumps({"summary": "Fixed add()."}),
        files=json.dumps([{"path": "calc.py"}]),
    )
    note, complete = handoff.of_run(run, "Fixed add(); tests pass.")
    assert not complete
    assert note["done"] == "Fixed add()." and "`calc.py`" in note["where"]
    assert note["left"] == note["check"] == handoff.NOT_SAID
    run.report = json.dumps({"summary": "x", "handoff": {"done": "A", "where": "B"}})
    note, complete = handoff.of_run(run, "")
    assert complete and note["done"] == "A" and note["left"] == handoff.NOT_SAID


def test_a_run_taken_back_mid_way_is_told_by_its_work_not_its_errors():
    run = AiRun(
        project_id="p",
        ticket_id="KAN-1",
        member_id="m",
        number=2,
        steps=json.dumps(
            [
                {"kind": "start", "text": "Read the ticket"},
                {"kind": "read", "text": "Read weather.py"},
                {"kind": "command", "text": "Ran git branch -a"},
                {
                    "kind": "command",
                    "text": "Ran python3 - <<'EOF'\np='weather.py'\n" + "x" * 200,
                },
                {
                    "kind": "error",
                    "text": "<tool_use_error>Error: No such tool available: Bash",
                },
                {"kind": "skill", "text": "Used the skill kanban-board:role-dev"},
                {"kind": "end", "text": "Cancelled"},
            ]
        ),
    )
    note = handoff.from_progress(run, None, by="An Nguyen")
    assert note["done"] == "Read weather.py; Ran git branch -a; Ran python3 - <<'EOF'"
    assert note["left"].startswith(
        "The rest of the task: An Nguyen took the ticket back while run #2"
    )


def test_the_form_is_the_same_in_the_skill_and_over_mcp():
    from kanban_mcp.team_guide import TEAM_GUIDE
    from services import shared_skills

    assert handoff.FORM in shared_skills.guides()["evidence-and-handover"]
    assert handoff.FORM in shared_skills.skill_files()["evidence-and-handover"]
    assert handoff.FORM in TEAM_GUIDE
    for words in ("hand_over", "take_back", "tell", "board_wait(since=head"):
        assert words in TEAM_GUIDE


# --------------------------------------------------------------------------- a three-step workflow


async def test_ba_dev_qa_each_leave_a_note_and_the_next_step_reads_it_first(
    env, monkeypatch, prompts
):
    c = env["c"]
    monkeypatch.setattr(workflow, "_has_evidence", _yes)
    pid, _ = await _project(c)
    team_ids = await _team(c, pid, env["repo"], roles=("ba", "dev", "qa"))
    await _template(c, pid, "bdq", BA_DEV_QA)
    tid = await _ticket(c, pid, acceptance_criteria=["It adds"])
    r = await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "bdq"})
    assert r.status_code == 200, r.text
    await _until(c, tid, _at_done)
    ticket = (await c.get(f"/tickets/{tid}")).json()
    notes = _notes(ticket)
    assert [(n["step"], n["to"], n["complete"]) for n in notes] == [
        ("Shape", "Dev", True),
        ("Build", "QA", True),
        ("Test", "you", True),
    ]
    assert notes[0]["done"] == "Shape is done by the fake."
    assert notes[1]["where"] == "notes/build.md" and notes[2]["left"] == "Nothing."
    # each note is a comment a person reads, and the run's report keeps it
    note_comments = [c for c in ticket["comments"] if c.get("handoff")]
    assert note_comments[0]["text"].startswith("**Handoff note · Shape · Ba AI → Dev**")
    assert "- **Check:** the Shape part first." in note_comments[0]["text"]
    async with env["maker"]() as s:
        rows = (await s.exec(select(AiRun).where(AiRun.ticket_id == tid))).all()
    assert all(json.loads(r.report)["handoff"]["done"] for r in rows)
    by_step = {p["step"]: p["prompt"] for p in prompts()}
    assert set(by_step) == {"Shape", "Build", "Test"}
    assert "Read this first" not in by_step["Shape"]
    for step, before in (("Build", "Shape"), ("Test", "Build")):
        text = by_step[step]
        first = text.index("Read this first: the handoff note")
        # right after the line that names the step, before anything else it is told
        assert first < text.index("While you work, keep the ticket's work log")
        task = text[text.index(f"You are doing the step “{step}”") :]
        assert task.split("\n\n")[1].startswith("Read this first: the handoff note")
        assert f"left at “{before}”" in text[first : first + 200]
        assert f"- Done: {before} is done by the fake." in text
        assert f"- Check: the {before} part first." in text
        assert "The previous step's note:" not in text
    for p in by_step.values():
        assert handoff.FORM in p and "HANDOFF" in p
    assert ticket["assignee"] == team_ids["qa"]


async def _yes(*_a, **_k):
    return True


# --------------------------------------------------------------------------- take it back, give it back


async def test_a_person_takes_a_ticket_back_mid_run_and_gives_it_back(
    env, monkeypatch, prompts
):
    c = env["c"]
    pid, an = await _project(c)
    team_ids = await _team(c, pid, env["repo"], roles=("dev",))
    await _template(
        c,
        pid,
        "build",
        [
            {"key": "build", "label": "Build", "kind": "ai", "role": "dev"},
            {"key": "done", "label": "Done", "kind": "person"},
        ],
    )
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "ticks")
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/workflow", json={"template_key": "build"})
    run = await _wait(c, tid, ("running",))
    held = (await c.get(f"/tickets/{tid}/ai/holder")).json()
    assert held["kind"] == "ai" and held["member_id"] == team_ids["dev"]
    assert held["text"] == "Dev AI is working on it · Build"
    r = await c.post(
        f"/tickets/{tid}/ai/take-over",
        json={"member_id": an, "text": "I will try another library."},
        headers={"X-Actor": "An Nguyen"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["assignee"] == an
    assert (
        body["holder"]["kind"] == "person" and body["holder"]["state"] == "taken_back"
    )
    assert body["holder"]["text"] == "An Nguyen took it back from the AI team · Build"
    stopped = await _wait(c, tid, ("cancelled",))
    assert stopped["id"] == run["id"]
    view = (await c.get(f"/tickets/{tid}/ai/workflow")).json()
    assert view["state"] == "stopped" and view["stop_reason"] == "taken_back"
    await asyncio.sleep(0.5)  # the run's end moves nothing on a workflow taken back
    assert (await c.get(f"/tickets/{tid}/ai/workflow")).json()["state"] == "stopped"
    note = _notes((await c.get(f"/tickets/{tid}")).json())[-1]
    assert (
        note["from"] == "Dev AI" and note["to"] == "An Nguyen" and not note["complete"]
    )
    assert "took the ticket back" in note["left"] and "another library" in note["left"]

    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    r = await c.post(
        f"/tickets/{tid}/ai/hand-over",
        json={
            "done": "Swapped the library for decimal.",
            "where": "calc.py",
            "left": "The tests for negative numbers.",
            "check": "Rounding of halves.",
        },
        headers={"X-Actor": "An Nguyen"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["route"] == "resumed" and r.json()["step"] == "Build"
    await _until(c, tid, _at_done)
    build = [p["prompt"] for p in prompts() if p["step"] == "Build"][-1]
    task = build[build.index("You are doing the step “Build”") :]
    assert task.split("\n\n")[1].startswith(
        "Read this first: the handoff note An Nguyen left when handing the ticket over"
    )
    assert "- Left: The tests for negative numbers." in build
    view = (await c.get(f"/tickets/{tid}/ai/workflow")).json()
    builds = [s for s in view["steps"] if s["key"] == "build"]
    # given back is not a second try: same attempt, and the Dev is not moved up to Opus
    assert builds[-1]["state"] == "done" and builds[-1]["attempt"] == 1
    async with env["maker"]() as s:
        last = (
            await s.exec(
                select(AiRun)
                .where(AiRun.ticket_id == tid)
                .order_by(AiRun.number.desc())
            )
        ).first()
    assert last.number == 2 and "haiku" in last.model, last.model
    held = (await c.get(f"/tickets/{tid}/ai/holder")).json()
    assert held["kind"] == "waiting" and held["text"] == "Waits for a person: Done"


async def test_without_a_workflow_the_ai_that_had_it_takes_it_again_from_the_note(
    env, monkeypatch
):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, an = await _project(c)
    dev = (await _team(c, pid, env["repo"], roles=("dev",)))["dev"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "ticks")
    tid = await _ticket(c, pid)
    await team(action="ask", member_id=dev, ticket_id=tid, text="Fix", intent="work")
    await _wait(c, tid, ("running",))
    out = await team(action="take_back", ticket_id=tid, text="Wrong approach")
    assert out["cancelled_runs"] == 1 and not out["workflow_paused"]
    note = _notes((await c.get(f"/tickets/{tid}")).json())[-1]
    # no X-Actor: the board's own user; the note never says "user took it back"
    assert (
        "user" not in note["left"] and "a person took the ticket back" in note["left"]
    )
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    with pytest.raises(Exception, match="needs its note"):
        await team(action="hand_over", ticket_id=tid)
    out = await team(
        action="hand_over",
        ticket_id=tid,
        fields={"done": "Found the cause: a minus.", "left": "The fix."},
    )
    assert out["route"] == "member" and out["member"] == "Dev AI"
    await _wait(c, tid, ("finished",))
    args = [json.loads(x) for x in record.read_text().splitlines()][-1]
    prompt = args[args.index("-p") + 1]
    assert "Read this first: the handoff note" in prompt
    assert "- Done: Found the cause: a minus." in prompt


# --------------------------------------------------------------------------- an outside agent's work


async def test_an_outside_agents_branch_and_page_become_the_teams_input_in_one_call(
    env, monkeypatch, prompts
):
    c = env["c"]
    monkeypatch.setattr(workflow, "_has_evidence", _yes)
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("ba", "dev", "qa"))
    await _template(c, pid, "bdq", BA_DEV_QA)
    page = (
        await c.post(
            f"/projects/{pid}/docs/pages",
            json={"title": "Parser notes", "markdown": "# Parser notes\n"},
        )
    ).json()
    tid = await _ticket(c, pid)
    out = await call(
        {
            "action": "hand_over",
            "ticket_id": tid,
            "workflow": "bdq",
            "fields": {
                "done": "A first parser, without tests.",
                "left": "The criteria and the tests.",
                "check": "The spec on the page.",
                "branch": "feat/outside-parser",
                "pages": [page["id"]],
            },
        }
    )
    assert out["route"] == "workflow"
    assert "branch `feat/outside-parser`" in out["note"]["where"]
    assert "Parser notes" in out["note"]["where"]
    ticket = await call({"ticket_id": tid}, tool="get_ticket")
    assert [b["name"] for b in ticket["branches"]] == ["feat/outside-parser"]
    assert [d["page_id"] for d in ticket["docs"]] == [page["id"]]
    assert ticket["held_by"]["kind"] in ("ai", "waiting")
    await _until(c, tid, _at_done)
    shape = next(p["prompt"] for p in prompts() if p["step"] == "Shape")
    assert shape.index("Read this first: the handoff note") < shape.index(
        "While you work"
    )
    assert "feat/outside-parser" in shape and "The criteria and the tests." in shape


# --------------------------------------------------------------------------- talking while it works


async def test_a_message_over_mcp_reaches_the_running_ai_and_changes_what_it_says(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    gate = tmp_path / "gate"
    monkeypatch.setenv("FAKE_CLAUDE_GATE", str(gate))
    pid, _ = await _project(c)
    await c.patch(f"/projects/{pid}/ai/ops", json={"live_messages": True})
    dev = (await _team(c, pid, env["repo"], roles=("dev",)))["dev"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "wait_question")
    tid = await _ticket(c, pid)
    await team(action="ask", member_id=dev, ticket_id=tid, text="Fix", intent="work")
    run = await _wait(c, tid, ("running",))
    out = await team(action="tell", run_id=run["id"], text="Use the cursor.")
    assert out["delivered"] == "input"
    gate.write_text("go")
    done = await _wait(c, tid, ("finished",))
    assert "Got it: Use the cursor." in (done["summary"] or "")
    with pytest.raises(Exception, match="already ended"):
        await team(action="tell", run_id=run["id"], text="Too late")


# --------------------------------------------------------------------------- a scripted session as an outside agent


async def test_an_outside_agent_gives_a_goal_follows_it_answers_a_question_and_approves_the_plan(
    env, monkeypatch, tmp_path
):
    """Done when (#272): a scripted session over MCP only, as the guide tells it (ai_team(guide) §7)."""
    c = env["c"]
    gate = tmp_path / "plan.gate"
    monkeypatch.setenv("FAKE_CLAUDE_PLAN_GATE", str(gate))
    monkeypatch.setenv("FAKE_CLAUDE_PLAN_AFTER_ANSWER", "1")
    pid, _ = await _project(c)
    await _team(c, pid, env["repo"], roles=("dev", "reviewer", "pm"))
    await _ops(
        c,
        pid,
        tdd={"required": False},
        autonomy={"done": "after_review"},
        workflow_default="quick_fix",
    )
    monkeypatch.setenv(
        "FAKE_CLAUDE_PLAN",
        "PLAN: KAN-2 | after: none | covers: 1\nPLAN: KAN-3 | after: KAN-2 | covers: 2",
    )
    # 1-2. look, then give the goal
    assert "## 7. A session, step by step" in (await team(action="guide"))["guide"]
    members = await team(action="members", project_id=pid)
    assert {m["role"] for m in members} == {"dev", "reviewer", "pm"}
    head = (await board_wait())["head"]
    story = await team(
        action="give_story",
        project_id=pid,
        text="A web page where I see the weather of a city",
        fields={
            "title": "Weather app",
            "criteria": ["Today", "Seven days"],
            "approve": "person",
        },
    )
    sid = story["id"]
    assert story["state"] == "planning"
    # the PM works: it makes the tickets and asks the person one question (its tool calls, played by the test)
    pm_run = await _running(env, sid)
    a = await _ticket(c, pid, title="Search a city", status="backlog", parent_id=sid)
    b = await _ticket(c, pid, title="Seven days", status="backlog", parent_id=sid)
    ctx = RunContext(pm_run.id, pm_run.member_id, "Pm AI", pid, sid, "user", "work")
    await runs.record_question(ctx, "Celsius or Fahrenheit?", ["Celsius", "Fahrenheit"])
    gate.write_text("go")

    # 3-5. follow it with board_wait until a run asks
    async def follow(until):
        nonlocal head
        for _ in range(60):
            page = await board_wait(since=head, timeout_s=5, project_id=pid)
            if page["events"]:
                head = max(e["id"] for e in page["events"])
            got = await until()
            if got:
                return got
            runs.RT.wake.set()
        raise AssertionError("the board never got there")

    async def asking():
        rows = await team(action="runs", project_id=pid, active_only=True)
        return next((r for r in rows if r["state"] == "needs_input"), None)

    waiting = await follow(asking)
    assert waiting["question"] == "Celsius or Fahrenheit?"
    held = (await call({"ticket_id": sid}, tool="get_ticket"))["held_by"]
    assert held["kind"] == "waiting" and "answer" in held["text"]
    await team(action="answer", run_id=waiting["id"], text="Celsius")

    async def plan_waits():
        view = await team(action="story", story_id=sid)
        return view if view.get("plan_waiting") else None

    view = await follow(plan_waits)
    assert [i["ticket_id"] for i in view["plan"]] == [a, b]
    approved = await team(action="approve_plan", story_id=sid)
    assert approved["state"] == "in_progress"
    done = await _story(c, sid, lambda v: v["state"] == "done", timeout=120)
    assert done["progress"]["done"] == 2


async def _running(env, sid):
    for _ in range(300):
        async with env["maker"]() as s:
            row = (
                await s.exec(
                    select(AiRun).where(
                        AiRun.ticket_id == sid, AiRun.state == "running"
                    )
                )
            ).first()
        if row:
            return row
        await asyncio.sleep(0.1)
    raise AssertionError("The PM never started")
