"""Auto-trip rules (design/screens/ai-safety-cost.md, D6): failed runs, spend spike, repeated denials, loops and many
agents tripped, with thresholds an admin edits."""

from datetime import UTC, datetime, timedelta

from models import AiMember, AiProjectSettings, AiRun, Ticket
from services.ai import audit, autotrip
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401


def _ago(**kw) -> str:
    return (datetime.now(UTC) - timedelta(**kw)).isoformat()


async def _run(
    maker,
    pid,
    mid,
    tid,
    *,
    state="finished",
    cost=0.0,
    started=None,
    ended=None,
    number=1,
):
    async with maker() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=mid,
            number=number,
            state=state,
            cost_usd=cost,
            metered=True,
            started_at=started or _ago(minutes=1),
            ended_at=ended,
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
        return run.id


async def _profile(maker, mid) -> AiMember:
    async with maker() as s:
        return await s.get(AiMember, mid)


async def test_rules_table_and_threshold_edits(env):
    c = env["c"]
    pid, _ = await _project(c)
    rules = (await c.get(f"/projects/{pid}/ai/board")).json()["settings"]["auto_trip"]
    assert [r["label"] for r in rules] == [
        "Failed runs",
        "Spend spike",
        "Repeated denials",
        "Loop detected",
        "Many agents tripped",
    ]
    assert [r["on"] for r in rules] == [True, True, True, True, False]
    assert (
        rules[1]["when"] == "Spend 3× its 7-day norm for 15 min"
        and rules[2]["then"] == "Safe mode for agent"
    )
    r = await c.patch(
        f"/projects/{pid}/ai/settings",
        json={"auto_trip": [{"key": "failed_runs", "count": 2}]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["auto_trip"][0]["when"] == "2 failed runs in 10 min"
    r = await c.patch(
        f"/projects/{pid}/ai/settings",
        json={"auto_trip": [{"key": "spend_spike", "factor": 0.5}]},
    )
    assert r.status_code == 422


async def test_failed_runs_and_denials_and_spend_spike(env):
    c, maker = env["c"], env["maker"]
    pid, _ = await _project(c)
    a = await _runner(c, pid, env["repo"])
    await c.patch(f"/ai/members/{a['id']}", json={"provider": "anthropic"})
    b = await _runner(c, pid, env["repo"], name="Reviewer")
    tid = await _ticket(c, pid)
    await c.patch(
        f"/projects/{pid}/ai/settings",
        json={"auto_trip": [{"key": "failed_runs", "count": 2}]},
    )
    # Failed runs
    for n in (1, 2):
        await _run(
            maker, pid, b["id"], tid, state="failed", ended=_ago(minutes=1), number=n
        )
    await autotrip.on_run_failed(b["id"])
    prof = await _profile(maker, b["id"])
    assert prof.paused and prof.paused_reason.startswith(
        "Auto-paused: 2 failed runs in 10 minutes"
    )
    # Repeated denials put the agent in safe mode
    for _ in range(6):
        await audit.record(
            pid, "delete_tickets", "blocked", member_id=a["id"], target=tid
        )
    await autotrip.check()
    assert (await _profile(maker, a["id"])).safe_mode
    # Spend spike: $2 in 15 minutes against a 7-day norm of a few cents
    async with maker() as s:
        prof = await s.get(AiMember, a["id"])
        prof.connection = "api_key"
        s.add(prof)
        await s.commit()
    await _run(maker, pid, a["id"], tid, cost=0.30, started=_ago(days=3), number=5)
    await _run(maker, pid, a["id"], tid, cost=2.0, started=_ago(minutes=5), number=6)
    await autotrip.check()
    prof = await _profile(maker, a["id"])
    assert prof.paused and "7-day norm" in prof.paused_reason
    trips = (
        await c.get(f"/projects/{pid}/ai/audit", params={"actions": "auto_trip"})
    ).json()["entries"]
    assert {t["detail"]["rule"] for t in trips} == {
        "failed_runs",
        "denials",
        "spend_spike",
    }


async def test_loop_stops_the_run_and_holds_the_ticket_and_many_agents_pause_all(env):
    c, maker = env["c"], env["maker"]
    pid, _ = await _project(c)
    a = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    run_id = await _run(maker, pid, a["id"], tid, state="running")
    for _ in range(4):
        await audit.record(
            pid, "edit_fields", "allowed", member_id=a["id"], run_id=run_id, target=tid
        )
    await autotrip.check()
    async with maker() as s:
        run = await s.get(AiRun, run_id)
        ticket = await s.get(Ticket, tid)
    assert run.state == "cancelled" and run.ended_reason.startswith(
        "Loop detected: edit fields on KAN-1 4×"
    )
    assert ticket.pending
    # Many agents tripped (switched on): the third trip pauses all AI
    await c.patch(
        f"/projects/{pid}/ai/settings",
        json={"auto_trip": [{"key": "many_agents", "on": True, "count": 2}]},
    )
    b = await _runner(c, pid, env["repo"], name="Reviewer")
    for _ in range(6):
        await audit.record(
            pid, "delete_tickets", "denied", member_id=b["id"], target=tid
        )
    await autotrip.check()
    async with maker() as s:
        settings = await s.get(AiProjectSettings, pid)
    assert settings.paused_all and settings.paused_reason.startswith(
        "Auto-trip: 2 agents tripped"
    )
