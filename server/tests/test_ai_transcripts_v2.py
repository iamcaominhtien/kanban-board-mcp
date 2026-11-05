"""The board's own copy of every CLI run (services/ai/transcripts.py): what it sent, what the CLI printed, secrets
masked, compressed when the run ends, the skills and subagents counted, and the search document written at the end."""

import asyncio
import gzip
import json
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlmodel import select

import database
from models import AiRun, AiRunTranscript, AiSkillUse
from services.ai import transcripts
from tests.ai_helpers import _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "v2")
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))
    transcripts._OPEN.clear()


async def _run_row(env, state="running", **extra):  # noqa: F811
    c = env["c"]
    if "pid" not in env:
        env["pid"], _ = await _project(c)
        env["team"] = (await _runner(c, env["pid"], env["repo"]))["id"]
    async with env["maker"]() as s:
        run = AiRun(project_id=env["pid"], member_id=env["team"], state=state, **extra)
        s.add(run)
        await s.commit()
        await s.refresh(run)
        return run


async def _begin(env, run, **extra):  # noqa: F811
    await transcripts.begin(
        run.id,
        project_id=run.project_id,
        member_id=run.member_id,
        system=extra.pop("system", "You are the lead."),
        prompt=extra.pop("prompt", "Fix add()"),
        **extra,
    )


def _assistant(*blocks):
    return json.dumps({"type": "assistant", "message": {"content": list(blocks)}})


async def _row(run_id):
    async with database.async_session() as s:
        return await s.get(AiRunTranscript, run_id)


async def test_a_run_is_written_line_by_line_then_compressed_and_read_back(env):  # noqa: F811
    run = await _run_row(env)
    await _begin(env, run, session_id="sess1", started_at="2026-03-15T10:00:00+00:00")
    row = await _row(run.id)
    assert row.path.endswith("2026-03/" + run.id + ".jsonl") and row.ended_at is None
    transcripts.feed(run.id, _assistant({"type": "text", "text": "Working on it"}))
    transcripts.feed(run.id, "plain stderr-like line")
    transcripts.feed(run.id, "   ")
    transcripts.note(run.id, "message", "An Nguyen wrote: hurry", by="An Nguyen")
    live = await transcripts.read(run.id)
    assert [r["k"] for r in live] == ["sent", "event", "text", "note"]
    assert live[0]["prompt"] == "Fix add()" and live[0]["session_id"] == "sess1"
    assert live[3]["kind"] == "message" and live[3]["by"] == "An Nguyen"

    await transcripts.finish(run.id)
    row = await _row(run.id)
    assert row.path.endswith(".jsonl.gz") and row.ended_at and row.events == 4
    assert row.bytes == Path(row.path).stat().st_size > 0
    assert not Path(row.path[:-3]).exists()  # the plain file is gone
    with gzip.open(row.path, "rt", encoding="utf-8") as fh:
        assert len(fh.read().splitlines()) == 4
    again = await transcripts.read(run.id)
    assert [r["k"] for r in again] == ["sent", "event", "text", "note"]
    assert run.id not in transcripts._OPEN


async def test_secrets_are_masked_in_every_part_and_long_text_is_cut(env):  # noqa: F811
    run = await _run_row(env)
    secret = "sk-ant-" + "abcdefgh12345678"
    token = "kbr_" + "Zz9Yy8Xx7Ww6"
    mcp = json.dumps(
        {
            "mcpServers": {
                "board": {
                    "url": "http://x",
                    "headers": {"Authorization": f"Bearer {token}"},
                    "env": {"DB": "postgres://u:pw@h/db"},
                }
            }
        }
    )
    await _begin(
        env,
        run,
        system=f"key {secret}",
        prompt="do it",
        note=f"note with {secret}",
        args=[
            "-p",
            "the whole prompt",
            "--model",
            "haiku",
            "--mcp-config",
            mcp,
            "--append-system-prompt",
            f"x {secret}",
        ],
    )
    transcripts.feed(run.id, _assistant({"type": "text", "text": f"I saw {secret}"}))
    transcripts.feed(run.id, f"raw {token}")
    transcripts.note(run.id, "diagnosis", f"saw {secret}")
    transcripts.feed(
        run.id, _assistant({"type": "text", "text": "y" * (transcripts.MAX_TEXT + 500)})
    )
    await transcripts.finish(run.id)
    with gzip.open((await _row(run.id)).path, "rt", encoding="utf-8") as fh:
        raw = fh.read()
    assert secret not in raw and token not in raw and "postgres://u:pw" not in raw
    sent = json.loads(raw.splitlines()[0])
    args = sent["args"]
    assert args[args.index("-p") + 1] == "<recorded above>"
    assert args[args.index("--append-system-prompt") + 1] == "<recorded above>"
    assert args[args.index("--model") + 1] == "haiku"
    cfg = json.loads(args[args.index("--mcp-config") + 1])["mcpServers"]["board"]
    assert cfg["env"] == {"DB": "••••••••"} and cfg["headers"] == {
        "Authorization": "••••••••"
    }
    assert "500 more characters not kept" in raw


async def test_begin_after_a_restart_appends_and_after_the_end_does_nothing(env):  # noqa: F811
    run = await _run_row(env)
    await _begin(env, run, prompt="first")
    transcripts.feed(run.id, _assistant({"type": "text", "text": "one"}))
    # a restart inside the run: the open file keeps growing and says it resumed
    await _begin(env, run, prompt="second", resume=True)
    recs = await transcripts.read(run.id)
    assert [r["k"] for r in recs] == ["sent", "event", "sent"]
    assert recs[2]["resume"] is True and recs[2]["prompt"] == "second"
    await transcripts.finish(run.id)
    before = (await _row(run.id)).events
    # a late start for a run that ended must not reopen the compressed transcript
    await _begin(env, run, prompt="late")
    assert run.id not in transcripts._OPEN
    assert (await _row(run.id)).events == before == 3
    assert len(await transcripts.read(run.id)) == 3


async def test_feed_and_note_for_a_run_that_was_never_opened_are_ignored(env):  # noqa: F811
    transcripts.feed("run_nope", "{}")
    transcripts.note("run_nope", "x", "y")
    assert await transcripts.read("run_nope") is None
    await transcripts.finish("run_nope")  # nothing to settle: no error


async def test_skills_and_subagents_used_are_recorded_when_the_run_ends(env):  # noqa: F811
    run = await _run_row(env)
    await _begin(env, run)
    transcripts.feed(
        run.id,
        _assistant(
            {"type": "tool_use", "name": "Skill", "input": {"skill": "tdd:red-green"}}
        ),
    )
    transcripts.feed(
        run.id,
        _assistant(
            {"type": "tool_use", "name": "Task", "input": {"subagent_type": "reviewer"}}
        ),
    )
    transcripts.feed(
        run.id, _assistant({"type": "tool_use", "name": "Agent", "input": {}})
    )
    transcripts.feed(
        run.id,
        _assistant({"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}),
    )
    transcripts.feed(
        run.id, json.dumps({"type": "assistant", "message": "plain text, not a dict"})
    )
    await transcripts.finish(run.id)
    async with database.async_session() as s:
        uses = (
            await s.exec(select(AiSkillUse).where(AiSkillUse.run_id == run.id))
        ).all()
    got = sorted((u.kind, u.name, u.plugin) for u in uses)
    assert got == [
        ("skill", "tdd:red-green", "tdd"),
        ("subagent", "general-purpose", None),
        ("subagent", "reviewer", None),
    ]
    assert {u.member_id for u in uses} == {run.member_id}


async def test_the_search_document_holds_what_the_run_said_and_ran(env):  # noqa: F811
    run = await _run_row(
        env,
        summary="Fixed the adder",
        question=json.dumps({"text": "Which rounding mode?"}),
        files=json.dumps([{"path": "calc.py"}]),
    )
    await _begin(env, run)
    transcripts.feed(
        run.id,
        _assistant(
            {"type": "text", "text": "Investigating the subtraction bug"},
            {"type": "tool_use", "name": "Bash", "input": {"command": "pytest -q"}},
        ),
    )
    transcripts.feed(
        run.id,
        json.dumps(
            {
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "is_error": True,
                            "content": [
                                {"type": "text", "text": "AssertionError boom"}
                            ],
                        }
                    ]
                },
            }
        ),
    )
    transcripts.note(run.id, "restart", "restarted after crash")
    await transcripts.finish(run.id)
    async with database.async_session() as s:
        row = (await s.connection()).execute(
            text("SELECT body FROM ai_run_fts WHERE run_id = :r"), {"r": run.id}
        )
        body = (await row).scalar_one()
    for piece in (
        "Fixed the adder",
        "Which rounding mode?",
        "calc.py",
        "subtraction bug",
        "pytest -q",
        "AssertionError boom",
        "restarted after crash",
    ):
        assert piece in body, piece


def test_content_of_and_blocks_of_skip_events_without_content():
    ev = {"message": {"content": [{"type": "text", "text": "a"}, "stray", 3]}}
    assert transcripts.content_of(ev) == ev["message"]["content"]
    assert transcripts.blocks_of(ev) == [{"type": "text", "text": "a"}]
    assert transcripts.content_of({"message": {"content": "just text"}}) == "just text"
    assert transcripts.blocks_of({"message": {"content": "just text"}}) == []
    for odd in (None, "x", {}, {"message": "x"}, {"message": {"content": 5}}):
        assert transcripts.content_of(odd) is None and transcripts.blocks_of(odd) == []


async def test_a_deleted_transcript_reads_as_none(env):  # noqa: F811
    run = await _run_row(env)
    await _begin(env, run)
    await transcripts.finish(run.id)
    async with database.async_session() as s:
        row = await s.get(AiRunTranscript, run.id)
        row.deleted_at = "2026-01-01T00:00:00+00:00"
        s.add(row)
        await s.commit()
    assert await transcripts.read(run.id) is None


async def test_a_full_v2_run_leaves_a_masked_compressed_transcript(env):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    assert (
        await c.patch(f"/tickets/{tid}", json={"assignee": team["id"]})
    ).status_code == 200
    run = await _wait(c, tid, ("finished",), timeout=30)
    deadline = asyncio.get_running_loop().time() + 5
    row = None
    while asyncio.get_running_loop().time() < deadline:
        row = await _row(run["id"])
        if row is not None and row.ended_at:
            break
        await asyncio.sleep(0.05)
    assert row is not None and row.ended_at and row.path.endswith(".jsonl.gz")
    recs = await transcripts.read(run["id"])
    assert recs[0]["k"] == "sent" and recs[0]["prompt"] and recs[0]["system"]
    assert any(r["k"] == "event" and r["e"].get("type") == "result" for r in recs)
    assert len(recs) == row.events and row.events >= 5
    raw = gzip.open(row.path, "rt", encoding="utf-8").read()
    assert "kbr_" not in raw.replace("kbr_••••", "")
