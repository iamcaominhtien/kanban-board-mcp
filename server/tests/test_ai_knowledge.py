"""Project knowledge (design/screens/ai-operations.md, H): the project's instructions and the kept lessons go into
every run's system prompt; an AI only proposes a lesson, a person keeps it."""

import json

import pytest

from services.ai import knowledge
from tests.ai_helpers import FAKE, _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


def _system_of(record) -> str:
    last = [json.loads(x) for x in record.read_text().splitlines()][-1]
    return last[last.index("--append-system-prompt") + 1]


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


async def test_a_light_model_that_never_answers_is_stopped(env, monkeypatch, tmp_path):
    import psutil

    from models import AiTeam

    pidfile = tmp_path / "haiku.pid"
    monkeypatch.setenv("FAKE_CLAUDE_JSON_HANG", str(pidfile))
    monkeypatch.setattr(knowledge, "LIGHT_MODEL_TIMEOUT_S", 1)
    profile = AiTeam(id="m", project_id="p", provider="claude-code", cli_path=FAKE)
    assert await knowledge._ask_light_model("x", profile, None) is None
    child = int(pidfile.read_text())
    assert (
        not psutil.pid_exists(child)
        or psutil.Process(child).status() == psutil.STATUS_ZOMBIE
    )
