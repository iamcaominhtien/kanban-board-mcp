"""AI cost: budgets and limits (tokens, cap per run, board limits), the cap policies, alerts, the usage dashboard
with its forecast and CSV, and the limits table (design/screens/ai-safety-cost.md, C)."""

import json
from datetime import UTC, datetime, timedelta

from sqlmodel import select

from models import AiGrant, AiMember, AiRun, AiUsage
from services.ai import api_agent, budget, runs, safety
from tests.test_ai import (  # noqa: F401
    FakeChat,
    _api_member,
    _project,
    _runner,
    _ticket,
    _wait,
    env,
)


def _reply(tin=1000, tout=100, **kw):
    return api_agent.Reply(text="done", tokens_in=tin, tokens_out=tout, **kw)


async def _run_api(c, monkeypatch, pid, m, tid, replies):
    monkeypatch.setattr(api_agent, "make_chat", lambda *a, **k: FakeChat(replies))
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )


async def _blocked_reason(c, pid, tid):
    await runs.tick()
    board = {
        x["ticket_id"]: x
        for x in (await c.get(f"/projects/{pid}/ai/board")).json()["runs"]
    }
    return board[tid]


# --------------------------------------------------------------------------- edit budget


async def test_edit_budget_fields_validate_and_are_audited(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, monthly_cap=100)
    body = {
        "daily_budget": 5,
        "monthly_cap": 4,
        "tokens_per_day": 300000,
        "cap_per_run": 0.5,
        "warn_at": [50, 80],
        "max_parallel": 1,
        "config": {"at_cap": "ask"},
    }
    r = await c.patch(f"/ai/members/{m['id']}", json=body)
    assert r.status_code == 422 and "at least the daily budget" in r.json()["detail"]
    r = await c.patch(f"/ai/members/{m['id']}", json={**body, "monthly_cap": 100})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["tokens_per_day"] == 300000 and got["cap_per_run"] == 0.5
    assert got["warn_at"] == [50, 80] and got["config"]["at_cap"] == "ask"
    assert (
        await c.patch(f"/ai/members/{m['id']}", json={"warn_at": [60]})
    ).status_code == 422
    assert (
        await c.patch(f"/ai/members/{m['id']}", json={"config": {"at_cap": "explode"}})
    ).status_code == 422
    assert (
        await c.patch(f"/ai/members/{m['id']}", json={"tokens_per_day": 10})
    ).status_code == 422
    entries = (
        await c.get(f"/projects/{pid}/ai/audit", params={"actions": "member_updated"})
    ).json()
    assert any(
        "tokens_per_day" in (e["detail"].get("changes") or {})
        for e in entries["entries"]
    )


# --------------------------------------------------------------------------- enforcement


async def test_tokens_per_day_and_cap_per_run_stop_work(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, tokens_per_day=1500, cap_per_run=0.0001)
    t1, t2 = await _ticket(c, pid, "A"), await _ticket(c, pid, "B")
    call = {"input": {"ticket_id": t1, "estimate": 2}}
    await _run_api(
        c,
        monkeypatch,
        pid,
        m,
        t1,
        [
            api_agent.Reply(
                tool_calls=[{"id": "1", "name": "update_ticket", **call}],
                tokens_in=2000,
                tokens_out=100,
            ),
            _reply(),
        ],
    )
    run = await _wait(c, t1, ("failed",))
    assert "cap per run reached" in run["ended_reason"]
    await c.post(
        f"/tickets/{t2}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    waiting = await _blocked_reason(c, pid, t2)
    assert (
        waiting["state"] == "queued"
        and "Tokens per day used up" in waiting["waiting_reason"]
    )
    use = (await c.get(f"/projects/{pid}/ai/usage")).json()["limits"]
    row = next(a for a in use["agents"] if a["member_id"] == m["id"])
    assert row["tokens"]["used"] == 2100 and row["tokens"]["full"] is True


async def test_board_runs_per_day_and_parallel_limits(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    a = await _runner(c, pid, env["repo"], name="A", max_parallel=2)
    b = await _runner(c, pid, env["repo"], name="B", max_parallel=2)
    t1, t2 = await _ticket(c, pid, "1"), await _ticket(c, pid, "2")
    r = await c.patch(f"/projects/{pid}/ai/settings", json={"board_max_parallel": 1})
    assert r.json()["board_max_parallel"] == 1
    await c.post(f"/tickets/{t1}/ai/run", json={"member_id": a["id"]})
    await _wait(c, t1, ("running",))
    await c.post(f"/tickets/{t2}/ai/run", json={"member_id": b["id"]})
    waiting = await _blocked_reason(c, pid, t2)
    assert "free slot on the board" in waiting["waiting_reason"]
    # runs per day on the board
    await c.patch(
        f"/projects/{pid}/ai/settings",
        json={"board_max_parallel": 4, "board_runs_per_day": 1},
    )
    await runs.cancel((await c.get(f"/tickets/{t1}/ai/runs")).json()[0]["id"], by="t")
    waiting = await _blocked_reason(c, pid, t2)
    assert "Board runs per day used up" in waiting["waiting_reason"]
    lim = (await c.get(f"/projects/{pid}/ai/usage")).json()["limits"]["board"]
    assert lim["runs"]["cap"] == 1 and lim["runs"]["full"] is True
    bad = await c.patch(
        f"/projects/{pid}/ai/settings",
        json={"board_daily_cap": 20, "board_monthly_budget": 10},
    )
    assert bad.status_code == 422


async def test_at_the_cap_ask_an_owner_creates_a_raise_cap_approval(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, daily_budget=0.0001, config={"at_cap": "ask"})
    t1, t2 = await _ticket(c, pid, "A"), await _ticket(c, pid, "B")
    await _run_api(c, monkeypatch, pid, m, t1, [_reply(100000, 1000)])
    await _wait(c, t1, ("finished",))
    await c.post(
        f"/tickets/{t2}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    waiting = await _blocked_reason(c, pid, t2)
    assert "waiting for an owner to raise the cap" in waiting["waiting_reason"]
    pending = (
        await c.get(f"/projects/{pid}/ai/approvals", params={"status": "pending"})
    ).json()
    [a] = [x for x in pending if x["action"] == "raise_cap"]
    assert a["risk"] == "medium" and "$2.00" in a["summary"]
    # asking again does not pile up a second request
    await runs.tick()
    again = (
        await c.get(f"/projects/{pid}/ai/approvals", params={"status": "pending"})
    ).json()
    assert len([x for x in again if x["action"] == "raise_cap"]) == 1
    monkeypatch.setattr(
        api_agent, "make_chat", lambda *a, **k: FakeChat([_reply(10, 1)])
    )
    r = await c.post(f"/ai/approvals/{a['id']}/approve", json={})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    async with env["maker"]() as s:
        g = (await s.exec(select(AiGrant).where(AiGrant.kind == "cap_raise"))).first()
        assert g.amount == 2.0 and g.member_id == m["id"] and g.day == budget.day_key()
    await _wait(c, t2, ("finished", "running"))
    assert (await c.get(f"/ai/members/{m['id']}")).json()["status"]["code"] != "paused"


async def test_alerts_fire_once_per_threshold_a_day(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, daily_budget=5, warn_at=[50, 80, 100])
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        s.add(
            AiRun(
                project_id=pid,
                ticket_id=tid,
                member_id=m["id"],
                state="finished",
                metered=True,
                cost_usd=4.2,
                started_at=datetime.now(UTC).isoformat(),
            )
        )
        await s.commit()
    await safety.check_budget_alerts(m["id"])
    await safety.check_budget_alerts(m["id"])
    alerts = (await c.get(f"/projects/{pid}/ai/alerts")).json()
    assert sorted(a["data"]["percent"] for a in alerts) == [50, 80]
    async with env["maker"]() as s:
        s.add(
            AiUsage(
                project_id=pid,
                feature="chat",
                member_id=m["id"],
                cost=1.0,
                metered=True,
            )
        )
        await s.commit()
    await safety.check_budget_alerts(m["id"])
    alerts = (await c.get(f"/projects/{pid}/ai/alerts")).json()
    assert sorted(a["data"]["percent"] for a in alerts) == [50, 80, 100]
    # budget alerts are non-urgent: held for the daily digest, not toasted
    assert (await c.get(f"/projects/{pid}/ai/notifications")).json()["items"] == []
    await c.patch(f"/projects/{pid}/ai/settings", json={"digest": "off"})
    assert (await c.get(f"/ai/members/{m['id']}")).json()["status"][
        "code"
    ] == "over_budget"


async def test_digest_releases_held_notifications_once(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    await safety.notify(pid, "budget", "80%", "Reviewer used $4 of $5")
    await safety.notify(pid, "blocked", "Blocked", "x")
    assert (await c.get(f"/projects/{pid}/ai/notifications")).json()["items"] == []

    class Noon(datetime):
        @classmethod
        def now(cls, tz=None):
            return (
                datetime(2026, 10, 28, 10, 0).astimezone()
                if tz is None
                else datetime(2026, 10, 28, 10, 0, tzinfo=tz)
            )

    monkeypatch.setattr(safety, "datetime", Noon)
    assert await safety.release_digest(pid) == 2
    assert await safety.release_digest(pid) == 0
    items = (await c.get(f"/projects/{pid}/ai/notifications")).json()["items"]
    assert [i["event"] for i in items] == ["digest"] and "2" not in items[0]["title"]
    assert "budget at 80% or cap reached" in items[0]["body"].lower()


# --------------------------------------------------------------------------- usage dashboard


async def _seed_runs(env, pid, m, days_back, cost, n=1, tokens=1000):
    async with env["maker"]() as s:
        tid = await _ticket(env["c"], pid, f"Seed {days_back}")
        for i in range(n):
            when = (
                datetime.now(UTC) - timedelta(days=days_back, minutes=i)
            ).isoformat()
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=m["id"],
                    number=i + 1,
                    state="finished",
                    metered=m.get("connection") == "api_key",
                    cost_usd=cost,
                    tokens_in=tokens,
                    tokens_out=100,
                    started_at=when,
                    queued_at=when,
                    ended_at=when,
                )
            )
        await s.commit()
    return tid


async def test_usage_dashboard_ranges_forecast_stack_and_csv(env):
    c = env["c"]
    pid, _ = await _project(c)
    api = await _api_member(c, pid, monthly_cap=100)
    local = await _runner(c, pid, env["repo"])
    await c.patch(
        f"/projects/{pid}/ai/settings",
        json={"board_daily_cap": 15, "board_monthly_budget": 200},
    )
    t_today = await _seed_runs(env, pid, api, 0, 1.5, n=2)
    await _seed_runs(env, pid, api, 3, 2.0)
    await _seed_runs(env, pid, local, 1, 0.0, n=3)
    month = (await c.get(f"/projects/{pid}/ai/usage")).json()
    assert month["range"]["key"] == "month"
    tiles = month["tiles"]
    assert tiles["today"] == 3.0 and tiles["runs"] >= 3
    assert tiles["local_runs"] == 3 and tiles["api_runs"] >= 3
    assert (
        tiles["forecast_within"] is True and tiles["forecast"] >= tiles["month_spend"]
    )
    today_row = next(
        d for d in month["days"] if not d["forecast"] and d["cost_usd"] == 3.0
    )
    assert today_row["by_agent"][0]["member_id"] == api["id"]
    assert month["series"][0]["name"] == api["name"]
    one = (await c.get(f"/projects/{pid}/ai/usage", params={"range": "today"})).json()
    assert len(one["days"]) == 1 and one["tiles"]["spend"] == 3.0
    week = (await c.get(f"/projects/{pid}/ai/usage", params={"range": "7d"})).json()
    assert len([d for d in week["days"] if not d["forecast"]]) == 7
    ranged = (
        await c.get(
            f"/projects/{pid}/ai/usage",
            params={"range": "custom", "since": "2000-01-01", "until": "2000-01-03"},
        )
    ).json()
    assert ranged["tiles"]["runs"] == 0 and len(ranged["days"]) == 3
    agent = next(a for a in month["agents"] if a["member_id"] == api["id"])
    assert agent["pct_of_cap"] is not None and agent["monthly_cap"] == 100
    assert (
        next(a for a in month["agents"] if a["member_id"] == local["id"])["metered"]
        is False
    )
    assert (
        month["top_runs"][0]["cost_usd"] == 2.0
        or month["top_runs"][0]["cost_usd"] == 1.5
    )
    assert month["tickets"][0]["title"].startswith("Seed")
    assert month["prices"]["rows"][0]["model"] and month["prices"]["updated"]
    csv = (await c.get(f"/projects/{pid}/ai/usage/export", params={"range": "7d"})).text
    assert csv.splitlines()[0] == "section,key,runs,tokens,seconds,cost_usd"
    assert "not metered" in csv and t_today in csv


async def test_limits_table_has_a_row_for_the_board_and_each_agent(env):
    c = env["c"]
    pid, _ = await _project(c)
    api = await _api_member(
        c, pid, monthly_cap=100, tokens_per_day=200000, cap_per_run=0.3
    )
    local = await _runner(c, pid, env["repo"], max_runs_per_day=15)
    lim = (await c.get(f"/projects/{pid}/ai/usage")).json()["limits"]
    assert lim["board"]["name"] == "All AI in this board"
    assert lim["board"]["daily"]["cap"] == 15 and lim["board"]["parallel"]["cap"] == 4
    assert (
        lim["board"]["tokens"]["cap"] == 1_000_000 and lim["board"]["runs"]["cap"] == 60
    )
    a = next(x for x in lim["agents"] if x["member_id"] == api["id"])
    assert a["metered"] and a["tokens"]["cap"] == 200000 and a["cap_per_run"] == 0.3
    assert a["at_cap"] == "pause" and a["daily"]["cap"] == 5
    b = next(x for x in lim["agents"] if x["member_id"] == local["id"])
    assert not b["metered"] and b["runs"]["cap"] == 15 and b["per_run_minutes"] == 30
    assert json.dumps(lim)


async def test_keys_and_tokens_report_rotation_and_last_use(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid)
    keys = (await c.get(f"/projects/{pid}/ai/keys")).json()
    row = keys["members"][0]
    assert (
        row["key_last4"] == "3f9a"
        and row["key_age_days"] == 0
        and not row["rotate_due"]
    )
    async with env["maker"]() as s:
        p = await s.get(AiMember, m["id"])
        p.key_rotated_at = (datetime.now(UTC) - timedelta(days=95)).isoformat()
        s.add(p)
        await s.commit()
    keys = (await c.get(f"/projects/{pid}/ai/keys")).json()
    assert keys["members"][0]["rotate_due"] is True
    assert await safety.check_key_reminders(pid) == 1
    assert await safety.check_key_reminders(pid) == 0
    r = await c.patch(
        f"/ai/members/{m['id']}", json={"api_key": "sk-ant\x2dapi03-yyyyyyyyyyyy1234"}
    )
    assert r.json()["key_rotated_at"] and r.json()["key_last4"] == "1234"
