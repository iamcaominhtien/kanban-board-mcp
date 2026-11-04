"""Project knowledge (design/screens/ai-operations.md, H): the project's instructions and the kept lessons go into
every run's system prompt; an AI only proposes a lesson, a person keeps it."""

import asyncio
import json

import pytest

from models import AiLesson
from services.ai import knowledge
from tests.ai_helpers import FAKE, _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


def _system_of(record) -> str:
    last = [json.loads(x) for x in record.read_text().splitlines()][-1]
    return last[last.index("--append-system-prompt") + 1]


async def test_instructions_and_kept_lessons_reach_every_run_but_proposals_do_not(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    r = await c.put(
        f"/projects/{pid}/ai/knowledge/instructions",
        json={"instructions": "Tests run with npm test -- --run."},
    )
    assert r.status_code == 200
    assert r.json()["instructions_tokens"] > 0
    kept = (
        await c.post(
            f"/projects/{pid}/ai/lessons",
            json={"text": "Start the dev server in the background."},
        )
    ).json()
    assert kept["state"] == "kept"
    async with env["maker"]() as s:
        await knowledge.add_lesson(
            s, pid, "A proposal nobody kept.", by="model", state="proposed"
        )
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, tid, ("finished",))
    system = _system_of(record)
    assert "Tests run with npm test -- --run." in system
    assert "Start the dev server in the background." in system
    assert "A proposal nobody kept." not in system
    # the instructions come before the member's own persona
    page = (await c.get(f"/projects/{pid}/ai/knowledge")).json()
    lesson = next(x for x in page["lessons"] if x["id"] == kept["id"])
    assert lesson["uses"] == 1
    assert page["total_tokens"] == page["instructions_tokens"] + page["lessons_tokens"]


async def test_lessons_are_kept_edited_dropped_and_never_duplicated(env):
    c = env["c"]
    pid, _ = await _project(c)
    async with env["maker"]() as s:
        proposal = await knowledge.add_lesson(
            s,
            pid,
            "Use uv run alembic revision --autogenerate.",
            by="model",
            state="proposed",
        )
    edited = (
        await c.patch(
            f"/ai/lessons/{proposal.id}",
            json={
                "text": "Migrations: uv run alembic revision --autogenerate.",
                "state": "kept",
            },
        )
    ).json()
    assert edited["state"] == "kept"
    assert edited["text"].startswith("Migrations:")
    dup = await c.post(
        f"/projects/{pid}/ai/lessons",
        json={"text": "Migrations: uv run alembic revision --autogenerate."},
    )
    assert dup.status_code == 409
    assert (await c.delete(f"/ai/lessons/{proposal.id}")).status_code == 204
    page = (await c.get(f"/projects/{pid}/ai/knowledge")).json()
    assert page["lessons"] == []
    empty = await c.post(f"/projects/{pid}/ai/lessons", json={"text": "   "})
    assert empty.status_code == 422


async def test_instructions_keep_their_history(env):
    c = env["c"]
    pid, _ = await _project(c)
    await c.put(
        f"/projects/{pid}/ai/knowledge/instructions", json={"instructions": "v1"}
    )
    page = (
        await c.put(
            f"/projects/{pid}/ai/knowledge/instructions", json={"instructions": "v2"}
        )
    ).json()
    assert page["instructions"] == "v2"
    assert [h["text"] for h in page["history"]] == ["v1"]


async def test_lessons_over_the_cap_stay_out_of_the_prompt(env):
    c = env["c"]
    pid, _ = await _project(c)
    async with env["maker"]() as s:
        for i in range(40):
            await knowledge.add_lesson(s, pid, f"Lesson {i}: " + "word " * 60, by="An")
        block = await knowledge.prompt_block(s, pid)
    assert knowledge.estimate_tokens(block) <= knowledge.LESSON_TOKEN_CAP + 200


async def test_a_ticket_done_lets_a_light_model_propose_one_lesson_once(
    env, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv(
        "FAKE_CLAUDE_JSON_RESULT",
        json.dumps(
            {
                "lesson": "pytest needs -q here; the full output floods the log.",
                "why": "x",
            }
        ),
    )
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, tid, ("finished",))
    got = await knowledge.propose_from_ticket(tid)
    assert got is not None
    assert got.state == "proposed"
    assert "pytest needs -q" in got.text
    assert await knowledge.propose_from_ticket(tid) is None  # once per ticket
    page = (await c.get(f"/projects/{pid}/ai/knowledge")).json()
    assert [x["state"] for x in page["lessons"]] == ["proposed"]
    feed = (
        await c.get("/notifications", params={"view": "panel", "tab": "updates"})
    ).json()
    assert any(i["kind"] == "lesson" for i in feed["items"])


async def test_nothing_worth_keeping_proposes_nothing(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_JSON_RESULT", json.dumps({"lesson": "", "why": ""}))
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, tid, ("finished",))
    assert await knowledge.propose_from_ticket(tid) is None
    page = (await c.get(f"/projects/{pid}/ai/knowledge")).json()
    assert page["lessons"] == []


async def test_moving_a_ticket_to_done_starts_the_proposal_in_the_background(
    env, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv(
        "FAKE_CLAUDE_JSON_RESULT",
        json.dumps({"lesson": "Run ruff before handing over.", "why": "x"}),
    )
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, tid, ("finished",))
    await c.patch(f"/tickets/{tid}", json={"status": "done"})
    for _ in range(100):
        async with env["maker"]() as s:
            from sqlmodel import select

            rows = (
                await s.exec(select(AiLesson).where(AiLesson.source_ticket_id == tid))
            ).all()
        if rows:
            break
        await asyncio.sleep(0.1)
    assert rows and rows[0].text == "Run ruff before handing over."


def test_the_digest_keeps_commands_errors_and_words():
    records = [
        {
            "k": "event",
            "e": {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "I will run the tests"},
                        {
                            "type": "tool_use",
                            "name": "Bash",
                            "input": {"command": "npm test"},
                        },
                    ]
                },
            },
        },
        {
            "k": "event",
            "e": {
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "is_error": True,
                            "content": "watch mode never ends",
                        }
                    ]
                },
            },
        },
        {"k": "note", "text": "Stopped `npm run dev`"},
    ]
    text = knowledge.digest(records)
    assert "AI: I will run the tests" in text
    assert "tool Bash: npm test" in text
    assert "error: watch mode never ends" in text
    assert "[board] Stopped" in text
    assert knowledge.parse_proposal('{"lesson": "  a  b  "}') == "a b"
    assert knowledge.parse_proposal("nothing") is None


async def test_a_lesson_from_a_diagnosis_does_not_stop_the_ticket_end_lesson(
    env, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv(
        "FAKE_CLAUDE_JSON_RESULT",
        json.dumps({"lesson": "Run the linter before the tests.", "why": "x"}),
    )
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("finished",))
    # while it ran, the watchdog proposed a lesson from a diagnosis of the same ticket
    await knowledge.propose_from_diagnosis(
        run["id"], "Start dev servers in the background."
    )
    got = await knowledge.propose_from_ticket(tid)
    assert got is not None and "linter" in got.text
    assert await knowledge.propose_from_ticket(tid) is None


async def test_a_light_model_that_never_answers_is_stopped(env, monkeypatch, tmp_path):
    import psutil

    from models import AiMember

    pidfile = tmp_path / "haiku.pid"
    monkeypatch.setenv("FAKE_CLAUDE_JSON_HANG", str(pidfile))
    monkeypatch.setattr(knowledge, "LIGHT_MODEL_TIMEOUT_S", 1)
    profile = AiMember(id="m", project_id="p", provider="claude-code", cli_path=FAKE)
    assert await knowledge._ask_light_model("x", profile, None) is None
    child = int(pidfile.read_text())
    assert (
        not psutil.pid_exists(child)
        or psutil.Process(child).status() == psutil.STATUS_ZOMBIE
    )
