"""The assistant engine (AI v2 stage 7): one turn is a Claude Code session with a feature skill, an AiRun of kind
`assistant`, the conversation kept per name, the person's authority through a chat token."""

import json

import pytest

import database
from models import AiRun, AiUsage
from services.ai import steps
from services.assistant import engine, sessions, skills
from tests.ai_helpers import _project, _runner, env  # noqa: F401


@pytest.fixture(autouse=True)
def _assistant(monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "assistant")


async def test_a_turn_runs_the_skill_and_records_a_run(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"])
    record = env["tmp"] / "prompts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_PROMPTS", str(record))
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_JSON", json.dumps({"text": "Short.", "title": "API"})
    )
    out = await engine.turn(
        pid,
        name="docs:p1",
        skill="docs-summarise",
        inputs={"page_id": "p1"},
        by="An Nguyen",
        feature="docs",
    )
    assert out.state == "finished" and out.data() == {"text": "Short.", "title": "API"}
    assert out.tokens_in == 200 and out.cost == 0.02 and out.member == "Docs AI"
    sent = json.loads(record.read_text().splitlines()[-1])
    assert "Use the skill `kanban-assistant:docs-summarise`" in sent["prompt"]
    assert "An Nguyen is asking." in sent["prompt"] and "page_id: p1" in sent["prompt"]
    args = sent["args"]
    assert args[args.index("--permission-mode") + 1] == "bypassPermissions"
    assert "--json-schema" in args and "--session-id" in args and "--agents" not in args
    assert args[args.index("--name") + 1] == "docs:p1"
    plugin_dirs = [args[i + 1] for i, a in enumerate(args) if a == "--plugin-dir"]
    assert any("assistant-skills" in d for d in plugin_dirs) and any(
        "board-plugin" in d for d in plugin_dirs
    )
    mcp = json.loads(args[args.index("--mcp-config") + 1])
    assert mcp["mcpServers"]["kanban"]["headers"]["Authorization"].startswith(
        "Bearer kbr_chat_"
    )
    async with database.async_session() as s:
        run = await s.get(AiRun, out.run_id)
        rows = await steps.read(s, out.run_id)
        usage = (await s.exec(__import__("sqlmodel").select(AiUsage))).all()
    assert (
        run.kind == "assistant" and run.target == "docs:p1" and run.state == "finished"
    )
    assert (
        run.trigger == "docs-summarise"
        and run.tokens_in == 200
        and json.loads(run.report)["title"] == "API"
    )
    assert [r["kind"] for r in rows][0] == "start" and rows[-1]["kind"] == "end"
    assert any(r["kind"] == "board" for r in rows)
    assert (
        len(usage) == 1
        and usage[0].feature == "docs"
        and usage[0].person == "An Nguyen"
    )


async def test_the_conversation_is_resumed_by_name(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"])
    record = env["tmp"] / "prompts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_PROMPTS", str(record))
    first = await engine.turn(
        pid,
        name="board:" + pid,
        skill="board-ask",
        inputs={"question": "What is open?"},
        by="An",
        schema=None,
    )
    assert first.text == "Here is the answer." and first.structured is None
    second = await engine.turn(
        pid,
        name="board:" + pid,
        skill="board-ask",
        inputs={"question": "And blocked?"},
        by="An",
        schema=None,
    )
    assert second.session_id == first.session_id
    args = json.loads(record.read_text().splitlines()[-1])["args"]
    assert "--resume" in args and args[args.index("--resume") + 1] == first.session_id
    assert "--json-schema" not in args
    fresh = await engine.turn(
        pid,
        name="board:" + pid,
        skill="board-ask",
        inputs={"question": "New"},
        by="An",
        schema=None,
        fresh=True,
    )
    assert fresh.session_id != first.session_id
    assert await sessions.lookup("board:" + pid, None) == fresh.session_id


async def test_a_silent_turn_is_stopped_and_fails(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"])
    monkeypatch.setenv("FAKE_CLAUDE_ASSISTANT_WAIT", "20")
    out = await engine.turn(
        pid,
        name="idea:i1",
        skill="idea-ask",
        inputs={"question": "?"},
        by="An",
        timeout_s=0.5,
    )
    assert out.state == "failed" and "said nothing" in out.error
    async with database.async_session() as s:
        assert (await s.get(AiRun, out.run_id)).state == "failed"


async def test_files_are_saved_for_the_turn_and_an_unknown_project_is_refused(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"])
    out = await engine.turn(
        pid,
        name="sketch:s1",
        skill="sketch-ask",
        inputs={"text": "What is this?"},
        by="An",
        files=[("drawing.png", b"\x89PNG")],
    )
    assert (
        out.state == "finished" and out.files and out.files[0].endswith("drawing.png")
    )
    with pytest.raises(engine.AssistError) as exc:
        await engine.turn(
            "nope", name="board:nope", skill="board-ask", inputs={}, by="An"
        )
    assert exc.value.code == "not_found"


def test_every_skill_has_a_file_and_json_skills_have_a_schema():
    names = skills.names()
    assert {
        "docs-check",
        "docs-ask",
        "docs-write",
        "board-ask",
        "idea-triage",
        "editor-write",
        "sketch-ask",
    } <= set(names)
    for n in names:
        text = skills.text_of(n)
        assert text.startswith(f"---\nname: {n}\n") and "description:" in text
        if "Answer with JSON" in text:
            assert skills.schema_for(n) is not None, n
    assert skills.schema_for("board-ask") is None


async def test_a_oneshot_answer_writes_nothing_to_the_board(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    await _runner(c, pid, env["repo"])
    record = env["tmp"] / "prompts.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_PROMPTS", str(record))
    monkeypatch.setenv(
        "FAKE_CLAUDE_ASSISTANT_JSON",
        json.dumps(
            {
                "cause": "Too small.",
                "statements": ["ALTER TABLE project ADD COLUMN x TEXT"],
            }
        ),
    )
    out = await engine.oneshot(
        "db-fix", {"stop": {"table": "project", "column": "name"}}
    )
    assert (
        out.state == "finished"
        and out.data()["cause"] == "Too small."
        and out.run_id == ""
    )
    sent = json.loads(record.read_text().splitlines()[-1])
    assert (
        "kanban-assistant:db-fix" in sent["prompt"]
        and '"table": "project"' in sent["prompt"]
    )
    args = sent["args"]
    assert (
        json.loads(args[args.index("--mcp-config") + 1]) == {"mcpServers": {}}
        and "--json-schema" in args
    )
    async with database.async_session() as s:
        assert (await s.exec(__import__("sqlmodel").select(AiRun))).all() == []
        assert (await s.exec(__import__("sqlmodel").select(AiUsage))).all() == []
