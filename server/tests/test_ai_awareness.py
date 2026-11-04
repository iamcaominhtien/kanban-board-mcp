"""Every AI knows where it is and who else is on the work (services/ai/awareness.py): the scope card in its prompt, the
team it can look up, and contacting a teammate, whose answer comes back to the run that asked."""

import asyncio
import json

import pytest
from sqlmodel import select

import database
from models import AiRun, Ticket
from services.ai import awareness
from services.ai.context import RunContext
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401
from tests.test_ai_sessions import _calls, _flag


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


def _ctx(run: AiRun, name: str, chain=None) -> RunContext:
    return RunContext(
        run_id=run.id,
        member_id=run.member_id,
        member_name=name,
        project_id=run.project_id,
        ticket_id=run.ticket_id,
        on_behalf_of="An Nguyen",
        mode="work",
        chain=chain or [],
    )


async def _run_row(run_id: str) -> AiRun:
    async with database.async_session() as s:
        return await s.get(AiRun, run_id)


async def _team(c, env):
    pid, _ = await _project(c)
    dev = await _runner(c, pid, env["repo"], name="Dev")
    ba = await _runner(c, pid, env["repo"], name="BA")
    return pid, dev, ba


async def test_a_run_is_told_where_it_is_and_who_else_is_on_the_work(env, monkeypatch):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, dev, ba = await _team(c, env)
    tid = await _ticket(c, pid, title="Compare the tools")
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": ba["id"]})
    await _wait(c, tid, ("finished", "failed"))
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": dev["id"]})
    await _wait(c, tid, ("finished", "failed"))
    system = _flag(_calls(record)[-1], "--append-system-prompt")
    assert "Where you are and who else is on it" in system
    assert f"your conversation on {tid}" in system
    assert "- Dev — you: " in system
    assert f"- BA: free; worked on {tid}" in system
    assert "ai_run(action='contact'" in system
    assert "never ask a teammate to do it for you" in system


async def test_a_contact_starts_a_short_run_and_the_answer_comes_back(env, monkeypatch):
    c = env["c"]
    pid, dev, ba = await _team(c, env)
    tid = await _ticket(c, pid, title="Compare the tools")
    other = await _ticket(c, pid, title="Storage")
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": dev["id"]})
    asker = await _wait(
        c, tid, ("finished", "failed")
    )  # its run has ended: the answer goes on its ticket
    out = await awareness.contact(
        _ctx(await _run_row(asker["id"]), "Dev"),
        "ba",
        other,
        "Did you review the table?",
    )
    assert out["delivered"] == "run" and out["member"] == "BA"
    async with database.async_session() as s:
        run = (await s.exec(select(AiRun).where(AiRun.trigger == "contact"))).one()
    assert run.ticket_id == other and run.member_id == ba["id"] and run.mode == "ask"
    assert "Did you review the table?" in run.instruction
    assert json.loads(run.chain) == [dev["id"]]
    await _wait(c, other, ("finished", "failed"))
    for _ in range(100):
        async with database.async_session() as s:
            comments = json.loads((await s.get(Ticket, tid)).comments or "[]")
        if any((x.get("text") or "").startswith("For Dev: BA") for x in comments):
            break
        await asyncio.sleep(0.05)
    else:
        raise AssertionError("the answer never came back")


async def test_a_contact_reaches_a_teammate_working_on_the_ticket_as_a_message(
    env, monkeypatch
):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    c = env["c"]
    pid, dev, ba = await _team(c, env)
    tid = await _ticket(c, pid, title="Compare the tools")
    other = await _ticket(c, pid, title="Storage")
    await c.post(f"/tickets/{other}/ai/run", json={"member_id": ba["id"]})
    busy = await _wait(c, other, ("running",))
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": dev["id"]})
    asker = await _wait(c, tid, ("running",))
    out = await awareness.contact(
        _ctx(await _run_row(asker["id"]), "Dev"),
        "BA",
        other,
        "Which repo did you pick?",
    )
    assert out["delivered"] == "message" and out["run_number"] == busy["number"]
    async with database.async_session() as s:
        n = len((await s.exec(select(AiRun).where(AiRun.ticket_id == other))).all())
    assert n == 1  # no second run
    team = await awareness.team_for_run(_ctx(await _run_row(asker["id"]), "Dev"), other)
    ba_row = next(a for a in team["team"] if a["name"] == "BA")
    assert ba_row["now"][0]["ticket_id"] == other and ba_row["here"] is True
    await c.post(f"/ai/runs/{busy['id']}/cancel", json={})
    await c.post(f"/ai/runs/{asker['id']}/cancel", json={})


async def test_a_contact_refuses_itself_unknown_names_and_long_chains(env):
    c = env["c"]
    pid, dev, ba = await _team(c, env)
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": dev["id"]})
    row = await _run_row((await _wait(c, tid, ("finished", "failed")))["id"])
    with pytest.raises(ValueError, match="That is you"):
        await awareness.contact(_ctx(row, "Dev"), "Dev", None, "hi")
    with pytest.raises(ValueError, match="No AI teammate named"):
        await awareness.contact(_ctx(row, "Dev"), "Nobody", None, "hi")
    with pytest.raises(ValueError, match="AIs deep"):
        await awareness.contact(
            _ctx(row, "Dev", chain=["a", "b", "c"]), "BA", None, "hi"
        )
