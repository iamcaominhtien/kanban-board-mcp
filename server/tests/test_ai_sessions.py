"""One conversation per AI member and ticket: a later run resumes the member's last session on that ticket, a
new session starts when there is none or it is gone, the board tells an agent what the others did, the compaction
threshold reaches the CLI, and the per-ticket run limit only guards scheduled and AI-started runs."""

import asyncio
import json
from datetime import UTC, datetime

import pytest

from models import AiRun
from services.ai import budget, cli, runs
from services.ai.store import get_settings
from tests.test_ai_assist import _answer, _setup  # noqa: F401
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401


def _calls(record) -> list[list[str]]:
    return [json.loads(x) for x in record.read_text().splitlines()]


def _flag(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args else None


async def _run(c, tid, member_id):
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": member_id})
    return await _wait(c, tid, ("finished", "failed"))


async def _two_runs(c, tid, member_id):
    first = await _run(c, tid, member_id)
    assert first["state"] == "finished", first
    runs_before = len((await c.get(f"/tickets/{tid}/ai/runs")).json())
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": member_id})
    for _ in range(100):
        rows = (await c.get(f"/tickets/{tid}/ai/runs")).json()
        if len(rows) > runs_before and rows[0]["state"] in ("finished", "failed"):
            return first, rows[0]
        runs.RT.wake.set()
        await asyncio.sleep(0.1)
    raise AssertionError("second run did not end")


async def test_a_later_run_resumes_the_session_of_the_same_member_and_ticket(
    env, monkeypatch
):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    first, second = await _two_runs(c, tid, m["id"])
    calls = _calls(record)
    assert _flag(calls[0], "--session-id") == first["session_id"]
    assert _flag(calls[1], "--resume") == first["session_id"]
    assert second["session_id"] == first["session_id"]


async def test_another_member_or_ticket_starts_its_own_session(env, monkeypatch):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    pm = await _runner(c, pid, env["repo"], name="PM")
    t1, t2 = await _ticket(c, pid, "One"), await _ticket(c, pid, "Two")
    a = await _run(c, t1, dev["id"])
    b = await _run(c, t1, pm["id"])
    d = await _run(c, t2, dev["id"])
    assert len({a["session_id"], b["session_id"], d["session_id"]}) == 3
    assert all("--resume" not in call for call in _calls(record))


async def test_a_missing_session_file_starts_a_new_session(env, monkeypatch):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    first = await _run(c, tid, m["id"])
    for f in (env["tmp"] / "claude-config").rglob("*.jsonl"):
        f.unlink()  # the person cleaned ~/.claude
    assert not cli.session_exists(first["session_id"])
    runs_before = len((await c.get(f"/tickets/{tid}/ai/runs")).json())
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    second = None
    for _ in range(100):
        rows = (await c.get(f"/tickets/{tid}/ai/runs")).json()
        if len(rows) > runs_before and rows[0]["state"] == "finished":
            second = rows[0]
            break
        runs.RT.wake.set()
        await asyncio.sleep(0.1)
    assert second and second["session_id"] != first["session_id"]
    assert "--resume" not in _calls(record)[1]
    assert any("not found" in s["text"] for s in second["steps"])


async def test_a_session_the_cli_cannot_resume_is_replaced_by_a_new_one(
    env, monkeypatch
):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    first = await _run(c, tid, m["id"])
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "no_conversation")
    second_id = None
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    for _ in range(100):
        rows = (await c.get(f"/tickets/{tid}/ai/runs")).json()
        if rows[0]["id"] != first["id"] and rows[0]["state"] in ("finished", "failed"):
            second_id = rows[0]
            break
        runs.RT.wake.set()
        await asyncio.sleep(0.1)
    assert second_id and second_id["state"] == "finished", second_id
    assert second_id["session_id"] != first["session_id"]
    calls = _calls(record)
    assert _flag(calls[1], "--resume") == first["session_id"]  # tried first
    assert _flag(calls[2], "--session-id") == second_id["session_id"]  # then a new one
    assert any(st["kind"] == "fresh_session" for st in second_id["steps"])


async def test_a_member_is_told_what_the_others_did_since_its_last_run(
    env, monkeypatch
):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    pm = await _runner(c, pid, env["repo"], name="PM")
    tid = await _ticket(c, pid)
    await _run(c, tid, dev["id"])
    await _run(c, tid, pm["id"])
    pm_prompt = _flag(_calls(record)[1], "-p")
    assert "<activity" in pm_prompt and "by Dev" in pm_prompt
    assert "calc.py" in pm_prompt  # the files Dev changed
    dev_prompt = _flag(_calls(record)[0], "-p")
    assert "<activity" not in dev_prompt  # nobody else had worked on it yet


async def test_the_compaction_threshold_reaches_the_cli(env, monkeypatch):
    c = env["c"]
    seen = env["tmp"] / "compact.txt"
    monkeypatch.setenv("FAKE_CLAUDE_ENV_RECORD", str(seen))
    monkeypatch.delenv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", raising=False)
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    other = await _runner(
        c, pid, env["repo"], name="Careful", config={"compact_at_pct": 35}
    )
    tid = await _ticket(c, pid)
    await _run(c, tid, m["id"])
    await _run(c, tid, other["id"])
    assert seen.read_text().split() == ["60", "35"]
    bad = await c.patch(
        f"/ai/members/{m['id']}", json={"config": {"compact_at_pct": 5}}
    )
    assert bad.status_code == 422


def test_a_compaction_shows_up_as_a_step():
    line = json.dumps(
        {
            "type": "system",
            "subtype": "compact_boundary",
            "compact_metadata": {
                "trigger": "auto",
                "pre_tokens": 27932,
                "post_tokens": 723,
            },
        }
    )
    parsed = cli.parse_stream_line(line, "/tmp")
    assert parsed["steps"] == [
        {"kind": "compact", "text": "Long session compacted (27,932 → 723 tokens)"}
    ]


async def test_the_ticket_run_limit_only_guards_scheduled_and_ai_started_runs(env):
    c = env["c"]
    pid, _ = await _project(c)
    a = await _runner(c, pid, env["repo"], name="A")
    b = await _runner(c, pid, env["repo"], name="B")
    tid = await _ticket(c, pid)
    await c.patch(f"/projects/{pid}/ai/settings", json={"runs_per_ticket_per_day": 1})
    async with env["maker"]() as s:
        # earlier runs are written as finished rows: the scheduler must not pick anything up while the test counts
        for trigger, chain in (
            ("assign", "[]"),
            ("assign", "[]"),
            ("assign", "[]"),
            ("mention", json.dumps([a["id"]])),
        ):
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=a["id"] if chain == "[]" else b["id"],
                    mode="work",
                    trigger=trigger,
                    chain=chain,
                    state="finished",
                )
            )
        await s.commit()
        # three person runs are no problem; the one AI-started run used the limit of 1
        with pytest.raises(runs.RunError, match="scheduled or AI-started"):
            await runs.create_run(
                s,
                ticket_id=tid,
                member_id=b["id"],
                mode="work",
                trigger="mention",
                chain=[a["id"]],
            )
        # but a person can still start another run
        await runs.create_run(
            s, ticket_id=tid, member_id=b["id"], mode="work", trigger="assign"
        )


async def test_a_members_scheduled_runs_per_day_ignore_runs_a_person_starts(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], max_runs_per_day=1)
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        for trigger in ("assign", "mention", "schedule"):
            r = AiRun(
                project_id=pid,
                ticket_id=tid,
                member_id=m["id"],
                trigger=trigger,
                mode="ask",
                state="finished",
                started_at=datetime.now(UTC).isoformat(),
            )
            s.add(r)
        await s.commit()
        from models import AiMember

        profile = await s.get(AiMember, m["id"])
        settings = await get_settings(s, pid)
        assert await budget.runs_today(s, m["id"], kinds=("schedule",)) == 1
        assert await budget.blocked_detail(s, profile, settings, "person") is None
        hit = await budget.blocked_detail(s, profile, settings, "schedule")
        assert hit and "Scheduled runs per day used up (1 of 1)" in hit["reason"]


H = {"X-Actor": "An Nguyen"}


async def test_a_board_ai_chat_is_one_session_and_does_not_resend_the_history(
    env, monkeypatch
):
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    seen = env["tmp"] / "compact.txt"
    monkeypatch.setenv("FAKE_CLAUDE_ENV_RECORD", str(seen))
    monkeypatch.delenv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", raising=False)
    c, pid, an, m = await _setup(env)
    chat = (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()
    one = await _answer(c, chat["id"], "How many tickets are open?")
    two = await _answer(c, chat["id"], "And how many are done?")
    assert one["state"] == "done" and two["state"] == "done", (one, two)
    first, second = _calls(record)
    sid = _flag(first, "--session-id")
    assert sid and _flag(second, "--resume") == sid
    assert "Earlier in this chat" not in _flag(second, "-p")
    assert "And how many are done?" in _flag(second, "-p")
    assert seen.read_text().split() == ["60", "60"]
    # the CLI loses the conversation: the chat starts a new session and sends the history again
    for f in (env["tmp"] / "claude-config").rglob("*.jsonl"):
        f.unlink()
    three = await _answer(c, chat["id"], "Thanks")
    assert three["state"] == "done"
    third = _calls(record)[2]
    assert _flag(third, "--session-id") not in (None, sid)
    assert "Earlier in this chat" in _flag(third, "-p")
