"""What a run tells the AI about the ticket: all of it when a conversation begins, only what changed when a later run
resumes it (new comments by id only), all of it again after a compaction or when the instructions changed, and the
comments an AI reads through `get_ticket` are treated as its prompt treats them."""

import json

from models import AiRun
from services.ai import cli, guard, runs
from services.ai.context import RunContext
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401
from tests.test_ai_sessions import _calls, _flag, _run

MARK = "DESCRIPTION-MARK-77"


def _prompt(call: list[str]) -> str:
    return call[call.index("-p") + 1]


async def _setup_ticket(c, env, monkeypatch):
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    monkeypatch.setattr(cli, "session_exists", lambda sid: True)
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid, description=f"Why it fails. {MARK}")
    return record, pid, m, tid


async def _next_run(c, tid, member_id, before):
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": member_id})
    for _ in range(150):
        rows = (await c.get(f"/tickets/{tid}/ai/runs")).json()
        if len(rows) > before and rows[0]["state"] in ("finished", "failed"):
            return rows[0]
        runs.RT.wake.set()
        await __import__("asyncio").sleep(0.1)
    raise AssertionError("run did not end")


async def test_a_resumed_run_gets_only_what_changed_since(env, monkeypatch):
    c = env["c"]
    record, pid, m, tid = await _setup_ticket(c, env, monkeypatch)
    first = await _run(c, tid, m["id"])
    assert first["state"] == "finished"
    cm = await c.post(
        f"/tickets/{tid}/comments",
        json={"text": "SECRET-COMMENT-TEXT please look", "author": "Hoa Mai"},
    )
    new_id = cm.json()["comments"][-1]["id"]
    second = await _next_run(c, tid, m["id"], 1)
    assert second["state"] == "finished", second
    calls = _calls(record)
    assert _flag(calls[1], "--resume") == first["session_id"]
    one, two = _prompt(calls[0]), _prompt(calls[1])
    assert MARK in one
    assert MARK not in two and "SECRET-COMMENT-TEXT" not in two
    # the first run moved the ticket to Review, which the second is told; nothing else changed
    assert "Changed since your last answer: status: To Do → Review." in two
    assert new_id in two and "Hoa Mai" in two
    assert len(two) < len(one) + 400  # a header and a stub, not the ticket again
    assert any(s["text"].startswith("Sent the ticket") for s in first["steps"])
    assert any(
        s["text"].startswith("Sent what changed") and "1 new comment" in s["text"]
        for s in second["steps"]
    )


async def test_an_edited_description_is_reported_and_a_changed_status_named(
    env, monkeypatch
):
    c = env["c"]
    record, pid, m, tid = await _setup_ticket(c, env, monkeypatch)
    await _run(c, tid, m["id"])
    await c.patch(
        f"/tickets/{tid}", json={"description": "New text.", "priority": "high"}
    )
    await _next_run(c, tid, m["id"], 1)
    two = _prompt(_calls(record)[1])
    assert "the description was edited" in two and "priority: medium → high" in two
    assert "New text." not in two  # the AI reads it with get_ticket


async def test_the_ticket_is_sent_in_full_again_after_a_compaction(env, monkeypatch):
    c = env["c"]
    record, pid, m, tid = await _setup_ticket(c, env, monkeypatch)
    first = await _run(c, tid, m["id"])
    async with env["maker"]() as s:
        run = await s.get(AiRun, first["id"])
        run.steps = json.dumps(
            [
                *json.loads(run.steps),
                {"kind": "compact", "text": "Long session compacted"},
            ]
        )
        s.add(run)
        await s.commit()
    await _next_run(c, tid, m["id"], 1)
    calls = _calls(record)
    assert MARK in _prompt(calls[1])
    assert _flag(calls[1], "--resume") == first["session_id"]


async def test_changed_instructions_start_a_new_conversation(env, monkeypatch):
    c = env["c"]
    record, pid, m, tid = await _setup_ticket(c, env, monkeypatch)
    first = await _run(c, tid, m["id"])
    r = await c.patch(f"/ai/members/{m['id']}", json={"persona": "Answer in French."})
    assert r.status_code == 200, r.text
    second = await _next_run(c, tid, m["id"], 1)
    calls = _calls(record)
    assert "--resume" not in calls[1]
    assert (
        _flag(calls[1], "--session-id") == second["session_id"] != first["session_id"]
    )
    assert MARK in _prompt(calls[1])
    assert any("instructions changed" in s["text"] for s in second["steps"])


async def test_an_ai_reads_comments_fenced_and_a_person_reads_them_as_they_are(
    env, monkeypatch
):
    from kanban_mcp.tools import get_ticket

    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    for text, who in (
        ("Mine api_key=sk-abcdefghijklmnop1234567890", "user"),
        ("From outside", "partner@vendor.io"),
    ):
        await c.post(f"/tickets/{tid}/comments", json={"text": text, "author": who})
    ids = [x["id"] for x in (await c.get(f"/tickets/{tid}")).json()["comments"]]
    person = await get_ticket(ticket_id=tid, view="comments")
    assert person["count"] == 2 and "From outside" in json.dumps(person)
    ctx = RunContext(
        run_id="r1",
        member_id=m["id"],
        member_name=m["name"],
        project_id=pid,
        ticket_id=tid,
        on_behalf_of="user",
        mode="ask",
    )
    tokens = guard.enter(ctx)
    try:
        ai = await get_ticket(ticket_id=tid, view="comments")
        one = await get_ticket(ticket_id=tid, view="comments", comment_ids=[ids[0]])
        full = await get_ticket(ticket_id=tid)
    finally:
        guard.leave(tokens)
    assert ai["count"] == 1 and "From outside" not in json.dumps(ai)
    assert "not shown" in ai["held_back"]
    assert "sk-abcdefghijklmnop" not in json.dumps(ai)
    assert one["count"] == 1 and one["comments"][0]["id"] == ids[0]
    assert "From outside" not in json.dumps(full["comments"])
    assert full["comments_held_back"] == 1


# --------------------------------------------------------------------------- one conversation for runs and chats

from services.docs_ai import sessions as shared  # noqa: E402
from tests.test_ai_assist import H, _answer, _setup, fake  # noqa: E402, F401


async def _scope_chat(c, tid):
    r = await c.post(f"/ai/scopes/ticket/{tid}/chat", json={}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_chat_about_the_ticket_continues_the_conversation_of_its_runs(
    env, fake, monkeypatch
):
    monkeypatch.setattr(shared, "session_exists", lambda sid: True)
    monkeypatch.setattr(cli, "session_exists", lambda sid: True)
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    c, pid, an, m = await _setup(env)
    tid = await _ticket(c, pid, description=MARK)
    first = await _run(c, tid, m["id"])
    assert first["state"] == "finished"
    chat = await _scope_chat(c, tid)
    await _answer(c, chat["id"], "what did you do?")
    used = fake.sessions[-1]
    assert used.id == first["session_id"] and used.resume is True
    assert (
        "An Nguyen is asking" in fake.prompts[-1]
    )  # one conversation, so it says who asks
    # and the next run goes on in the same conversation
    second = await _next_run(c, tid, m["id"], 1)
    assert second["session_id"] == first["session_id"]
    assert _flag(_calls(record)[-1], "--resume") == first["session_id"]


async def test_a_run_goes_on_in_the_conversation_a_chat_began(env, fake, monkeypatch):
    monkeypatch.setattr(shared, "session_exists", lambda sid: True)
    monkeypatch.setattr(cli, "session_exists", lambda sid: True)
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    c, pid, an, m = await _setup(env)
    tid = await _ticket(c, pid)
    chat = await _scope_chat(c, tid)
    await _answer(c, chat["id"], "hello")
    began = fake.sessions[-1]
    assert began.resume is False
    run = await _run(c, tid, m["id"])
    assert run["session_id"] == began.id
    assert _flag(_calls(record)[0], "--resume") == began.id


async def test_a_chat_does_not_wait_for_a_run_that_is_using_the_conversation(
    env, fake, monkeypatch
):
    monkeypatch.setattr(shared, "session_exists", lambda sid: True)
    monkeypatch.setattr(cli, "session_exists", lambda sid: True)
    c, pid, an, m = await _setup(env)
    tid = await _ticket(c, pid)
    chat = await _scope_chat(c, tid)
    await _answer(c, chat["id"], "hello")
    kept = fake.sessions[-1].id
    async with shared.exclusive(shared.ticket_scope(tid), m["id"]):
        msg = await _answer(c, chat["id"], "again, while a run is busy")
        assert msg["state"] == "done"
        # a run starts only when the conversation is free
        await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
        await __import__("asyncio").sleep(0.6)
        rows = (await c.get(f"/tickets/{tid}/ai/runs")).json()
        assert rows and rows[0]["state"] == "queued"
    await _wait(c, tid, ("finished", "failed"))
    row = await shared.lookup(shared.ticket_scope(tid), m["id"])
    assert (
        row is not None and kept
    )  # the shared conversation is still the one remembered


def test_the_stream_tells_what_the_conversation_holds_and_the_models_window():
    line = json.dumps(
        {
            "type": "assistant",
            "message": {
                "usage": {
                    "input_tokens": 2,
                    "cache_creation_input_tokens": 1000,
                    "cache_read_input_tokens": 20000,
                    "output_tokens": 50,
                },
                "content": [],
            },
        }
    )
    assert cli.parse_stream_line(line, "/w")["context_used"] == 21002
    end = json.dumps(
        {
            "type": "result",
            "subtype": "success",
            "result": "ok",
            "usage": {},
            "modelUsage": {"claude-haiku-5-5": {"contextWindow": 1000000}},
        }
    )
    assert cli.parse_stream_line(end, "/w")["context_window"] == 1_000_000
    assert cli.parse_stream_line('{"type":"system"}', "/w")["context_used"] is None


async def test_a_finished_run_keeps_what_its_conversation_held(env, monkeypatch):
    c = env["c"]
    record, pid, m, tid = await _setup_ticket(c, env, monkeypatch)
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=m["id"],
            context_used=21002,
            context_window=1_000_000,
        )
        s.add(run)
        await s.commit()
        out = runs.to_dict(run)
    assert out["context_used"] == 21002 and out["context_window"] == 1_000_000


async def test_a_runs_steps_never_carry_an_object_as_their_detail(env, monkeypatch):
    """The run page prints a step's `detail` as text: an object there blanks the whole page."""
    c = env["c"]
    record, pid, m, tid = await _setup_ticket(c, env, monkeypatch)
    await _run(c, tid, m["id"])
    run = await _next_run(c, tid, m["id"], 1)
    assert any(s["text"].startswith("Sent") for s in run["steps"])
    assert all(isinstance(s.get("detail"), (str, type(None))) for s in run["steps"])
    assert any("context" in s for s in run["steps"])


def test_a_step_from_the_first_version_is_still_understood():
    sent = {"ticket": {"title": "t"}, "system": "abc"}
    assert runs._step_context({"kind": "read", "context": sent}) == sent
    assert runs._step_context({"kind": "read", "detail": {"context": sent}}) == sent
    assert runs._step_context({"kind": "read", "detail": "text"}) is None
    assert runs._step_context({"kind": "read", "detail": {"pages": []}}) is None


async def test_a_cli_run_is_given_no_turn_limit(env, monkeypatch):
    c = env["c"]
    record, pid, m, tid = await _setup_ticket(c, env, monkeypatch)
    await _run(c, tid, m["id"])
    assert "--max-turns" not in _calls(record)[0]


async def test_a_cli_chat_is_given_no_turn_limit(env):
    from services.ai.assist import chat_tools
    from tests.test_ai_chat_tools import _chat_parts

    chat, profile, member, pid = await _chat_parts(env, max_turns=7)
    tools, token = await chat_tools.build(chat, profile, member)
    guard.revoke_chat_token(token)
    assert tools.max_turns is None


async def test_a_mention_of_a_cli_member_is_not_held_back_by_depth_repeats_or_cooldown(
    env, monkeypatch
):
    from services.ai import mentions

    c = env["c"]
    pid, _ = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    pm = await _runner(c, pid, env["repo"], name="PM")
    tid = await _ticket(c, pid)
    await c.patch(f"/projects/{pid}/ai/settings", json={"max_chain_depth": 1})
    ctx = RunContext(
        run_id="r",
        member_id=dev["id"],
        member_name="Dev",
        project_id=pid,
        ticket_id=tid,
        on_behalf_of="user",
        mode="work",
        chain=[pm["id"], dev["id"]],  # deeper than the limit, and PM is in it already
    )
    await mentions.from_ai_comment(
        ctx, tid, {"id": "c1", "text": f"@[PM](member:{pm['id']}) please look"}
    )
    rows = (await c.get(f"/tickets/{tid}/ai/runs")).json()
    assert any(r["trigger"] == "mention" for r in rows), rows
