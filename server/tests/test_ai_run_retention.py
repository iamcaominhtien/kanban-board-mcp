"""OPS-7: run history retention. Keep forever by default; with N days set, the sweep trims finished runs older than
that: their transcript, steps and prompt go, the run row (number, cost, status, summary, links) stays. Never one that
is not finished, never one of this budget month, never one another record still works from."""

import json
from datetime import UTC, datetime, timedelta, timezone

from sqlmodel import select

from models import (
    AiApproval,
    AiAudit,
    AiProjectSettings,
    AiRun,
    AiRunTranscript,
    AiTicketStep,
)
from services.ai import run_retention
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401

NOW = datetime(2026, 12, 31, 12, 0, tzinfo=UTC)


def _ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat()


async def _run(
    env, pid, tid, mid, *, state="finished", days: float = 200, **extra
) -> str:
    async with env["maker"]() as s:
        n = len((await s.exec(select(AiRun).where(AiRun.ticket_id == tid))).all())
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=mid,
            number=n + 1,
            state=state,
            queued_at=_ago(days),
            started_at=_ago(days),
            ended_at=_ago(days) if state in run_retention.FINISHED else None,
            **extra,
        )
        s.add(run)
        await s.commit()
        return run.id


async def _ids(env, pid) -> set[str]:
    """The runs of the project that still have their details."""
    async with env["maker"]() as s:
        return {
            r.id
            for r in (await s.exec(select(AiRun).where(AiRun.project_id == pid))).all()
            if not r.details_removed_at
        }


async def _setup(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    return c, pid, m["id"], tid


async def test_keep_forever_is_the_default_and_nothing_goes(env):
    c, pid, mid, tid = await _setup(env)
    old = await _run(env, pid, tid, mid, days=900)
    s = (await c.get(f"/projects/{pid}/ai/settings")).json()
    assert s.get("run_retention_days") is None
    assert await run_retention.sweep(NOW) == 0
    assert old in await _ids(env, pid)
    preview = (await c.get(f"/projects/{pid}/ai/history/retention")).json()
    assert preview["days"] is None and preview["would_remove"] == 0


async def test_only_finished_old_unlinked_runs_go(env, tmp_path):
    c, pid, mid, tid = await _setup(env)
    gone = await _run(env, pid, tid, mid, days=200)
    failed = await _run(env, pid, tid, mid, state="failed", days=120)
    recent = await _run(env, pid, tid, mid, days=10)
    # 1 Dec, 10:48 UTC: older than 30 days, yet this (local) month in any zone from UTC-10 east
    this_month = await _run(env, pid, tid, mid, days=30.05)
    paused = await _run(env, pid, tid, mid, days=200, paused=True)
    queued = await _run(env, pid, tid, mid, state="queued", days=200)
    waiting = await _run(env, pid, tid, mid, state="needs_input", days=200, mode="ask")
    stepped = await _run(env, pid, tid, mid, days=200)
    approved = await _run(env, pid, tid, mid, days=200)
    pinned = await _run(env, pid, tid, mid, days=200)
    audited = await _run(env, pid, tid, mid, days=200)
    transcript = tmp_path / "t.jsonl"
    transcript.write_text("{}\n")
    async with env["maker"]() as s:
        s.add(AiTicketStep(ticket_id=tid, key="dev", label="Dev", run_id=stepped))
        s.add(
            AiApproval(
                project_id=pid,
                run_id=approved,
                member_id=mid,
                ticket_id=tid,
                action="git_push",
            )
        )
        s.add(AiRunTranscript(run_id=pinned, project_id=pid, path="x", pinned=True))
        s.add(AiRunTranscript(run_id=gone, project_id=pid, path=str(transcript)))
        s.add(AiAudit(project_id=pid, run_id=audited, action="run_started", seq=99999))
        await s.commit()

    r = await c.patch(f"/projects/{pid}/ai/settings", json={"run_retention_days": 7})
    assert r.status_code == 422, "only the offered choices"
    r = await c.patch(f"/projects/{pid}/ai/settings", json={"run_retention_days": 30})
    assert r.status_code == 200 and r.json()["run_retention_days"] == 30

    async with env["maker"]() as s:
        p = await run_retention.plan(s, pid, 30, NOW)
    assert set(p["remove"]) == {gone, failed, audited}
    assert p["kept_linked"] == 3 and p["kept_month"] == 1

    assert await run_retention.sweep(NOW) == 3
    assert await run_retention.sweep(NOW) == 0, "a trimmed run is not trimmed again"
    left = await _ids(env, pid)
    assert {gone, failed, audited}.isdisjoint(left)
    assert {
        recent,
        this_month,
        paused,
        queued,
        waiting,
        stepped,
        approved,
        pinned,
    } <= left
    async with env["maker"]() as s:
        # the records that named a removed run stay
        assert (
            await s.exec(select(AiAudit).where(AiAudit.run_id == audited))
        ).first() is not None
        # the transcript row stays and says when the file went
        tr = await s.get(AiRunTranscript, gone)
        assert tr is not None and tr.deleted_at and tr.bytes == 0
        # every run row stays, with its number and cost
        assert (
            len((await s.exec(select(AiRun).where(AiRun.project_id == pid))).all())
            == 11
        )
    assert not transcript.exists()


async def test_the_preview_says_what_would_go_and_removes_nothing(env):
    c, pid, mid, tid = await _setup(env)
    old = await _run(env, pid, tid, mid, days=400)
    r = await c.get(f"/projects/{pid}/ai/history/retention", params={"days": 90})
    body = r.json()
    assert body["days"] == 90 and body["would_remove"] == 1 and body["oldest"]
    assert old in await _ids(env, pid)
    bad = await c.get(f"/projects/{pid}/ai/history/retention", params={"days": 5})
    assert bad.status_code == 422


async def test_keep_forever_again_stops_the_sweep(env):
    c, pid, mid, tid = await _setup(env)
    old = await _run(env, pid, tid, mid, days=400)
    await c.patch(f"/projects/{pid}/ai/settings", json={"run_retention_days": 90})
    r = await c.patch(f"/projects/{pid}/ai/settings", json={"run_retention_days": 0})
    assert r.json()["run_retention_days"] is None
    async with env["maker"]() as s:
        row = await s.get(AiProjectSettings, pid)
        assert row.run_retention_days is None
    assert await run_retention.sweep(NOW) == 0
    assert old in await _ids(env, pid)


async def test_a_trimmed_run_keeps_its_cost_number_and_links(env):
    c, pid, mid, tid = await _setup(env)
    steps = json.dumps([{"at": _ago(200), "kind": "tool", "text": "ls"}])
    old = await _run(
        env,
        pid,
        tid,
        mid,
        days=200,
        cost_usd=1.25,
        metered=True,
        tokens_in=100,
        tokens_out=50,
        summary="Fixed the login",
        instruction="please fix the login",
        steps=steps,
        diagnosis=json.dumps({"cause": "x"}),
    )
    await c.patch(f"/projects/{pid}/ai/settings", json={"run_retention_days": 30})
    assert await run_retention.sweep(NOW) == 1
    async with env["maker"]() as s:
        run = await s.get(AiRun, old)
    assert run is not None and run.details_removed_at == NOW.isoformat()
    assert run.cost_usd == 1.25 and run.tokens_in == 100 and run.number == 1
    assert run.state == "finished" and run.summary == "Fixed the login"
    assert run.steps == "[]" and run.instruction == "" and run.diagnosis is None
    # the API still finds the run and says its details went
    body = (await c.get(f"/ai/runs/{old}/transcript")).json()
    assert body["run"]["details_removed_at"] == NOW.isoformat()
    assert body["run"]["cost_usd"] == 1.25
    # the next run on the ticket keeps counting from it
    nxt = await _run(env, pid, tid, mid, days=1)
    async with env["maker"]() as s:
        assert (await s.get(AiRun, nxt)).number == 2


async def test_this_budget_month_follows_local_time(env, monkeypatch):
    """In a UTC+ zone the budget month starts before midnight UTC on the 1st: a run started then counts toward this
    month's spend, so it stays."""
    import time

    c, pid, mid, tid = await _setup(env)
    monkeypatch.setenv("TZ", "Asia/Ho_Chi_Minh")  # UTC+7
    time.tzset()
    try:
        now = datetime(2026, 12, 31, 12, 0, tzinfo=UTC)
        # 30 Nov 20:00 UTC = 1 Dec 03:00 local: this budget month, yet before 1 Dec in UTC
        local_month = datetime(2026, 11, 30, 20, 0, tzinfo=UTC)
        # 30 Nov 16:00 UTC = 30 Nov 23:00 local: last month
        last_month = datetime(2026, 11, 30, 16, 0, tzinfo=UTC)
        ids = []
        for at in (local_month, last_month):
            async with env["maker"]() as s:
                run = AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=mid,
                    number=len(ids) + 1,
                    state="finished",
                    queued_at=at.isoformat(),
                    started_at=at.isoformat(),
                    ended_at=(at + timedelta(minutes=5)).isoformat(),
                )
                s.add(run)
                await s.commit()
                ids.append(run.id)
        assert run_retention.budget.month_start(now) == datetime(
            2026, 12, 1, tzinfo=timezone(timedelta(hours=7))
        )
        async with env["maker"]() as s:
            p = await run_retention.plan(s, pid, 30, now)
        assert p["remove"] == [ids[1]] and p["kept_month"] == 1
    finally:
        monkeypatch.undo()
        time.tzset()
