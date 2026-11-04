"""The board keeps its own transcript of every CLI run (design/screens/ai-operations.md, F and G): what it sent, what
the CLI printed, secrets masked, compressed at the end, searchable, pinned against the retention, exported."""

import asyncio
import gzip
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from models import AiRun, AiRunTranscript
from services.ai import history, runs, transcripts
from tests.ai_helpers import _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


async def _finished_run(env, monkeypatch, mode="finish"):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", mode)
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    r = await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    assert r.status_code == 200, r.text
    run = await _wait(c, tid, ("finished", "failed"))
    # the end path settles the transcript right after the run's state
    deadline = asyncio.get_running_loop().time() + 5
    while asyncio.get_running_loop().time() < deadline:
        async with __import__("database").async_session() as session:
            row = await session.get(AiRunTranscript, run["id"])
        if row is not None and row.ended_at:
            break
        await asyncio.sleep(0.05)
    return pid, m, tid, run


async def test_a_finished_run_leaves_a_compressed_transcript_with_secrets_masked(
    env, monkeypatch
):
    c = env["c"]
    _, _, _, run = await _finished_run(env, monkeypatch)
    async with __import__("database").async_session() as session:
        row = await session.get(AiRunTranscript, run["id"])
    assert row is not None
    assert row.path.endswith(".jsonl.gz")
    assert row.ended_at is not None
    assert row.events >= 5
    raw = gzip.open(row.path, "rt", encoding="utf-8").read()
    assert "sk-ant-secret123456" not in raw
    assert "kbr_" not in raw.replace("kbr_••••", "")
    first = json.loads(raw.splitlines()[0])
    assert first["k"] == "sent"
    assert first["prompt"]
    assert first["system"]
    assert "<recorded above>" in first["args"]

    body = (await c.get(f"/ai/runs/{run['id']}/transcript")).json()
    assert body["available"] is True
    kinds = [e["type"] for e in body["entries"]]
    assert kinds[0] == "sent"
    assert "init" in kinds
    assert "result" in kinds
    tool = next(
        e for e in body["entries"] if e["type"] == "tool" and e["name"] == "Bash"
    )
    assert "1 failed, 3 passed" in tool["output"]
    assert tool["is_error"] is False


async def test_skills_and_subagents_are_counted_from_the_stream(env, monkeypatch):
    c = env["c"]
    pid, m, _, run = await _finished_run(env, monkeypatch, mode="skill")
    steps = (await c.get(f"/ai/runs/{run['id']}")).json()["steps"]
    assert any(s["kind"] == "skill" and "tdd:red-green" in s["text"] for s in steps)
    assert any(s["kind"] == "subagent" and "Explore" in s["text"] for s in steps)
    usage = (await c.get("/ai/skills/usage", params={"project_id": pid})).json()
    by_name = {u["name"]: u for u in usage}
    assert by_name["tdd:red-green"]["plugin"] == "tdd"
    assert by_name["tdd:red-green"]["uses"] == 1
    assert by_name["Explore"]["kind"] == "subagent"
    hist = (await c.get("/ai/history", params={"skill": "tdd:red-green"})).json()
    assert [r["id"] for r in hist["runs"]] == [run["id"]]


async def test_history_searches_transcripts_and_filters(env, monkeypatch):
    c = env["c"]
    pid, m, tid, run = await _finished_run(env, monkeypatch)
    found = (
        await c.get("/ai/history", params={"q": "pytest", "project_id": pid})
    ).json()
    assert found["total"] == 1
    assert found["runs"][0]["id"] == run["id"]
    assert found["runs"][0]["snippet"]
    assert found["runs"][0]["ticket_title"] == "Fix add()"
    assert found["runs"][0]["transcript"]["events"] >= 5
    none = (await c.get("/ai/history", params={"q": "nothing-like-this-word"})).json()
    assert none["total"] == 0
    by_state = (await c.get("/ai/history", params={"state": "failed"})).json()
    assert by_state["total"] == 0
    by_member = (await c.get("/ai/history", params={"member_id": m["id"]})).json()
    assert by_member["total"] == 1
    # odd characters never break the search
    odd = await c.get("/ai/history", params={"q": 'a"b OR (c* NEAR'})
    assert odd.status_code == 200


async def test_pin_keeps_a_transcript_the_retention_removes(env, monkeypatch):
    c = env["c"]
    _, _, tid, run = await _finished_run(env, monkeypatch)
    later = datetime.now(UTC) + timedelta(days=200)
    pinned = (await c.post(f"/ai/runs/{run['id']}/pin", json={"on": True})).json()
    assert pinned["pinned"] is True
    assert await transcripts.prune(90, now=later) == 0
    await c.post(f"/ai/runs/{run['id']}/pin", json={"on": False})
    assert await transcripts.prune(90, now=later) == 1
    body = (await c.get(f"/ai/runs/{run['id']}/transcript")).json()
    assert body["available"] is False
    assert body["transcript"]["removed_at"]
    # the run itself, with its summary, is kept
    assert (await c.get(f"/ai/runs/{run['id']}")).json()["summary"]


async def test_export_as_markdown_and_json(env, monkeypatch):
    c = env["c"]
    _, _, tid, run = await _finished_run(env, monkeypatch)
    md = await c.get(f"/ai/runs/{run['id']}/export", params={"format": "md"})
    assert md.status_code == 200
    assert "attachment" in md.headers["content-disposition"]
    assert "## Transcript" in md.text
    assert "What the board sent" in md.text
    assert "**Tool Bash**" in md.text
    js = (await c.get(f"/ai/runs/{run['id']}/export", params={"format": "json"})).json()
    assert js["run"]["id"] == run["id"]
    assert js["entries"]


async def test_a_restarted_run_appends_to_the_same_transcript(
    env, monkeypatch, tmp_path
):
    # begin() twice for one run (a restart inside the run) keeps one file
    await transcripts.begin(
        "run_x", project_id="p", member_id="m", system="s1", prompt="p1"
    )
    transcripts.feed("run_x", '{"type":"system","subtype":"init","session_id":"a"}')
    transcripts.note("run_x", "restart", "Restarted by An")
    await transcripts.begin(
        "run_x", project_id="p", member_id="m", system="s1", prompt="p2"
    )
    records = [
        json.loads(x)
        for x in Path(transcripts._OPEN["run_x"].path).read_text().splitlines()
    ]
    assert [r["k"] for r in records] == ["sent", "event", "note", "sent"]
    transcripts._OPEN.pop("run_x").fh.close()


def test_fts_query_quotes_every_word():
    assert transcripts.fts_query('fix "the" add() OR') == '"fix" "the" "add" "OR"'
    assert transcripts.fts_query("   ") is None


def test_markdown_fences_never_break_on_backticks():
    md = history.to_markdown(
        {"number": 1, "ticket_id": "KAN-1", "state": "finished"},
        [
            {
                "type": "tool",
                "name": "Bash",
                "input": {"command": "echo ```"},
                "output": "```x```",
            }
        ],
    )
    assert "````" in md


async def test_an_event_whose_message_is_text_never_stops_the_runs_end(
    env, monkeypatch
):
    c = env["c"]
    hooked: list[str] = []
    monkeypatch.setattr(runs, "_after_odd_job", lambda run_id: hooked.append(run_id))
    monkeypatch.setenv("FAKE_CLAUDE_TEXT_MESSAGE", "some text")
    pid, _, tid, run = await _finished_run(env, monkeypatch)
    assert run["state"] == "finished"
    deadline = asyncio.get_running_loop().time() + 5
    while not hooked and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    # the rest of the end path ran: the hook after a finished run (an odd job's reviewer, the workflow)
    assert hooked == [run["id"]]
    async with __import__("database").async_session() as session:
        row = await session.get(AiRunTranscript, run["id"])
    assert row.ended_at is not None
    found = (
        await c.get("/ai/history", params={"q": "pytest", "project_id": pid})
    ).json()
    assert found["total"] == 1
    body = (await c.get(f"/ai/runs/{run['id']}/transcript")).json()
    assert body["available"] is True
    # and every reader skips such an event
    rec = {"k": "event", "e": {"type": "assistant", "message": "plain"}}
    assert transcripts._index_text([rec], None) == ""
    assert transcripts.snippet([rec], "plain") is None
    system = {"k": "event", "e": {"type": "system", "message": "text"}}
    user = {"k": "event", "e": {"type": "user", "message": "text"}}
    from services.ai import knowledge

    assert isinstance(
        knowledge.digest([rec, system, user]), str
    )  # the ticket-end lesson
    assert isinstance(history.timeline([rec, system, user]), list)
    # the skill counter of an open transcript reads it too
    await transcripts.begin(
        "run_text", project_id=pid, member_id="m", system="", prompt=""
    )
    transcripts.feed("run_text", json.dumps(rec["e"]))
    assert transcripts._OPEN.pop("run_text").skills == []


async def test_a_transcript_that_was_finished_is_never_reopened(env):
    async with __import__("database").async_session() as session:
        session.add(
            AiRunTranscript(
                run_id="run_done",
                project_id="p",
                member_id="m",
                path="/nowhere/run_done.jsonl.gz",
                started_at="2026-01-01T00:00:00",
                ended_at="2026-01-01T00:10:00",
            )
        )
        await session.commit()
    # a late start for a run that a cancel already ended
    await transcripts.begin(
        "run_done", project_id="p", member_id="m", system="s", prompt="p"
    )
    assert "run_done" not in transcripts._OPEN
    async with __import__("database").async_session() as session:
        row = await session.get(AiRunTranscript, "run_done")
    assert row.ended_at == "2026-01-01T00:10:00"
    assert row.path.endswith(".gz")


def test_mcp_server_env_values_never_reach_the_transcript():
    cfg = {
        "mcpServers": {
            "linear": {
                "command": "npx",
                "env": {
                    "LINEAR_API_KEY": "lin_api_abcdef123456",
                    "DATABASE_URL": "postgres://me:hunter2@db/app",
                },
            },
            "kanban": {"type": "http", "headers": {"Authorization": "Bearer kbr_x"}},
        }
    }
    out = transcripts._safe_args(["claude", "--mcp-config", json.dumps(cfg)])
    text = " ".join(out)
    assert "lin_api_abcdef123456" not in text
    assert "hunter2" not in text
    assert "kbr_x" not in text
    kept = json.loads(out[2])["mcpServers"]["linear"]["env"]
    assert sorted(kept) == ["DATABASE_URL", "LINEAR_API_KEY"]


async def test_a_search_inside_one_project_is_not_cut_by_other_projects_hits(env):
    async with __import__("database").async_session() as session:
        for i in range(5):
            await transcripts.index(
                session, AiRun(id=f"a{i}", project_id="A", summary="needle"), []
            )
        await transcripts.index(
            session, AiRun(id="b0", project_id="B", summary="needle"), []
        )
        await session.commit()
        assert await transcripts.search_ids(
            session, "needle", limit=3, project_id="B"
        ) == ["b0"]


async def test_an_index_that_fails_never_orphans_the_transcript(env, monkeypatch):
    async def broken(session, run, records):
        raise RuntimeError("the search index broke")

    monkeypatch.setattr(transcripts, "index", broken)
    _, _, _, run = await _finished_run(env, monkeypatch)
    maker = __import__("database").async_session

    async def recorded():
        async with maker() as session:
            return (await session.get(AiRunTranscript, run["id"])).ended_at

    deadline = asyncio.get_running_loop().time() + 5
    while not await recorded() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(
            0.05
        )  # the end path settles the transcript right after the state
    async with maker() as session:
        row = await session.get(AiRunTranscript, run["id"])
        assert row.path.endswith(".jsonl.gz") and Path(row.path).is_file()
        assert row.ended_at is not None and row.bytes > 0
        assert len(await transcripts.read(run["id"])) >= 5
        # a row left by the earlier crash names the plain file, of which only the .gz exists: still read
        row.path = row.path[: -len(".gz")]
        session.add(row)
        await session.commit()
    assert len(await transcripts.read(run["id"])) >= 5
