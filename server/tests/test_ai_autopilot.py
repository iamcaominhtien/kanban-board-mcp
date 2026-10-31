"""Autopilot: a delegate AI decides requests for the owner, within limits the board checks again."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import select

from models import AiApproval, AiAudit, AiProjectSettings, AiRun
from services.ai import autopilot, guard, permissions, runs
from tests.test_ai import (  # noqa: F401
    FAKE,
    _ctx,
    _runner,
    env,
)
from tests.test_ai_safety import _ask_assignee, _pending, _people

ON = {"enabled": True, "accept_risks": True, "grace_min": 0}


async def _setup(env, **cfg):
    """A project with the requesting AI, a delegate AI and Autopilot on; returns what the tests use."""
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    delegate = await _runner(c, pid, env["repo"], name="Mai PM")
    r = await c.put(
        f"/projects/{pid}/ai/autopilot",
        json={**ON, "delegate_id": delegate["id"], **cfg},
    )
    assert r.status_code == 200, r.text
    autopilot._shown.clear()
    autopilot._woke.clear()
    return ctx, pid, an, m, tid, delegate


async def _settings(env, pid):
    async with env["maker"]() as s:
        return await s.get(AiProjectSettings, pid)


async def _delegate_ctx(env, pid, delegate):
    """The context of the delegate's queued Autopilot run, as its token would resolve."""
    async with env["maker"]() as s:
        run = (
            await s.exec(
                select(AiRun).where(
                    AiRun.member_id == delegate["id"], AiRun.trigger == "autopilot"
                )
            )
        ).first()
        run.state, run.token_hash = "running", guard.token_hash("kbr_deleg")
        s.add(run)
        await s.commit()
    return await guard.context_for_token("kbr_deleg")


async def test_only_the_owner_sets_it_up_and_must_accept_the_risks(env):
    c = env["c"]
    ctx, pid, an, m, tid = await _ctx(env)
    delegate = await _runner(c, pid, env["repo"], name="Mai PM")
    people = await _people(c, pid)
    body = {"enabled": True, "delegate_id": delegate["id"]}
    r = await c.put(
        f"/projects/{pid}/ai/autopilot", json=body, headers={"X-Actor": "Hoa Mai"}
    )
    assert r.status_code == 403
    r = await c.put(
        f"/projects/{pid}/ai/autopilot", json=body, headers={"X-Actor": "Owen Lead"}
    )
    assert r.status_code == 422 and "Confirm" in r.json()["detail"]
    r = await c.put(
        f"/projects/{pid}/ai/autopilot",
        json={**body, "accept_risks": True},
        headers={"X-Actor": "Owen Lead"},
    )
    got = r.json()
    assert r.status_code == 200 and got["enabled"] is True
    assert got["delegate_name"] == "Mai PM" and got["enabled_by"] == "Owen Lead"
    assert got["max_risk"] == "medium" and got["full_rights"] is False
    # the delegate must be an AI of the project
    r = await c.put(
        f"/projects/{pid}/ai/autopilot",
        json={"delegate_id": people["Hoa Mai"]["id"]},
        headers={"X-Actor": "Owen Lead"},
    )
    assert r.status_code == 422 and "AI member" in r.json()["detail"]
    assert (await c.get(f"/projects/{pid}/ai/autopilot")).json()["enabled"] is True


async def test_a_waiting_request_wakes_the_delegate_once_with_the_text_fenced(env):
    c = env["c"]
    ctx, pid, an, m, tid, delegate = await _setup(env)
    await _ask_assignee(env, an, tid, ctx)
    [a] = await _pending(c, pid)
    s = await _settings(env, pid)
    assert await autopilot._wake(s, autopilot.config(s)) is True
    async with env["maker"]() as session:
        [run] = (
            await session.exec(select(AiRun).where(AiRun.trigger == "autopilot"))
        ).all()
    assert run.member_id == delegate["id"] and run.mode == "ask"
    assert (
        a["id"] in run.instruction
        and '<untrusted source="AI member request"' in run.instruction
    )
    # each request is shown once, and the delegate has a run already
    assert await autopilot._wake(s, autopilot.config(s)) is False
    # the delegate's run is not work passed between AIs
    now = (await c.get(f"/projects/{pid}/ai/team/now")).json()
    assert [h for h in now["handoffs"] if h["trigger"] == "autopilot"] == []


async def test_what_autopilot_may_not_decide_stays_for_a_person(env):
    ctx, pid, an, m, tid, delegate = await _setup(env, max_risk="low")
    await _ask_assignee(env, an, tid, ctx)  # changing the assignee is medium risk
    s = await _settings(env, pid)
    cfg = autopilot.config(s)
    async with env["maker"]() as session:
        assert await autopilot.pending_items(session, pid, cfg, datetime.now(UTC)) == []
        [a] = (await session.exec(select(AiApproval))).all()
        assert "medium" in await autopilot._may_decide(session, a, cfg)
        a.risk = "low"
        assert await autopilot._may_decide(session, a, cfg) is None
        a.action = "raise_cap"
        assert "budget" in await autopilot._may_decide(session, a, cfg)
        a.action, a.member_id = "change_assignee", delegate["id"]
        assert "own request" in await autopilot._may_decide(session, a, cfg)


async def test_the_grace_time_leaves_a_person_the_first_chance(env):
    ctx, pid, an, m, tid, delegate = await _setup(env, grace_min=10)
    await _ask_assignee(env, an, tid, ctx)
    s = await _settings(env, pid)
    cfg = autopilot.config(s)
    async with env["maker"]() as session:
        assert await autopilot.pending_items(session, pid, cfg, datetime.now(UTC)) == []
        later = datetime.now(UTC) + timedelta(minutes=11)
        assert len(await autopilot.pending_items(session, pid, cfg, later)) == 1


async def test_the_delegate_decides_and_it_is_marked_and_not_a_person_touch(env):
    c = env["c"]
    ctx, pid, an, m, tid, delegate = await _setup(env)
    await _ask_assignee(env, an, tid, ctx)
    [a] = await _pending(c, pid)
    s = await _settings(env, pid)
    await autopilot._wake(s, autopilot.config(s))
    dctx = await _delegate_ctx(env, pid, delegate)
    out = await autopilot.decide(dctx, a["id"], True, "Looks right for the ticket")
    assert out["decided"] == "approved"
    assert await _pending(c, pid) == []
    async with env["maker"]() as session:
        row = await session.get(AiApproval, a["id"])
        entries = (
            await session.exec(
                select(AiAudit).where(AiAudit.action == "autopilot_decision")
            )
        ).all()
    assert row.status == "approved" and row.decided_via == "autopilot"
    assert row.decided_by == "Mai PM"
    assert len(entries) == 1 and entries[0].result == "approved"
    assert (await c.get(f"/tickets/{tid}")).json()["assignee"] == an
    steps = (await c.get(f"/projects/{pid}/ai/team/stepped-in")).json()
    assert steps["totals"]["touches"] == 0
    assert (await c.get(f"/projects/{pid}/ai/autopilot")).json()["used_last_hour"] == 1


async def test_decide_is_refused_outside_an_autopilot_run_and_past_the_limit(env):
    c = env["c"]
    ctx, pid, an, m, tid, delegate = await _setup(env, per_hour_limit=1)
    await _ask_assignee(env, an, tid, ctx)
    [a] = await _pending(c, pid)
    # the requesting AI's own run is not the delegate's autopilot run
    with pytest.raises(autopilot.AutopilotError, match="Autopilot run"):
        await autopilot.decide(ctx, a["id"], True, None)
    s = await _settings(env, pid)
    await autopilot._wake(s, autopilot.config(s))
    dctx = await _delegate_ctx(env, pid, delegate)
    await autopilot.decide(dctx, a["id"], False, "Not needed")
    row = (
        await c.get(f"/projects/{pid}/ai/approvals", params={"status": "denied"})
    ).json()
    assert len(row) == 1
    await _ask_assignee(env, an, tid, ctx)
    [b] = await _pending(c, pid)
    with pytest.raises(autopilot.AutopilotError, match="limit"):
        await autopilot.decide(dctx, b["id"], True, None)


async def test_the_delegate_answers_a_question_for_the_owner(env, monkeypatch):
    ctx, pid, an, m, tid, delegate = await _setup(env)
    resumed = []

    async def fake_resume(run_id, token, note):
        resumed.append(run_id)

    monkeypatch.setattr(runs, "_resume_cli", fake_resume)
    async with env["maker"]() as session:
        asking = await session.get(AiRun, ctx.run_id)
        asking.state = "needs_input"
        asking.question = json.dumps(
            {
                "text": "Which database?",
                "asked_at": (datetime.now(UTC) - timedelta(minutes=5)).isoformat(),
            }
        )
        session.add(asking)
        await session.commit()
    s = await _settings(env, pid)
    assert await autopilot._wake(s, autopilot.config(s)) is True
    dctx = await _delegate_ctx(env, pid, delegate)
    out = await autopilot.answer(
        dctx, ctx.run_id, "SQLite; assumed, as the rest of the board."
    )
    assert out["answered"] is True
    async with env["maker"]() as session:
        q = json.loads((await session.get(AiRun, ctx.run_id)).question)
    assert q["answered_by"] == "Mai PM" and q["answered_via"] == "autopilot"
    # its own question is never its to answer
    with pytest.raises(autopilot.AutopilotError):
        await autopilot.answer(dctx, dctx.run_id, "x")


async def test_full_rights_widen_the_delegate_but_not_the_hard_locks(env):
    ctx, pid, an, m, tid, delegate = await _setup(env, full_rights=True)
    s = await _settings(env, pid)
    async with env["maker"]() as session:
        from models import AiMember

        profile = await session.get(AiMember, delegate["id"])
        other = await session.get(AiMember, m["id"])
    assert permissions.effective(profile, "change_assignee", s).mode == "allowed"
    assert permissions.effective(profile, "delete_tickets", s).mode == "approval"
    assert permissions.effective(profile, "delete_docs", s).mode == "approval"
    assert permissions.effective(profile, "manage_project", s).mode == "blocked"
    assert permissions.effective(other, "change_assignee", s).mode == "approval"
    assert permissions.check_status_move(profile, "todo", "done", full=True) is None
    assert permissions.check_status_move(profile, "todo", "done")


async def test_pause_all_and_switching_it_off_stop_the_wake(env, monkeypatch):
    c = env["c"]
    ctx, pid, an, m, tid, delegate = await _setup(env)
    woken = []

    async def spy(s, cfg):
        woken.append(s.project_id)
        return True

    monkeypatch.setattr(autopilot, "_wake", spy)
    await autopilot.tick()
    assert woken == [pid]
    autopilot._woke.clear()
    await c.post(f"/projects/{pid}/ai/pause-all", json={})
    await autopilot.tick()
    assert woken == [pid]
    await c.post(f"/projects/{pid}/ai/resume-all", json={})
    await c.put(f"/projects/{pid}/ai/autopilot", json={"enabled": False})
    await autopilot.tick()
    assert woken == [pid]
