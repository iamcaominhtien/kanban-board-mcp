"""The account's usage window and slots (services/ai/quota.py) and the run limits (services/ai/budget.py), as the
v2 run pipeline uses them: a rate_limit_event in the stream holds the account, a held account queues the next run."""

from datetime import UTC, datetime, timedelta

import pytest

from models import AiAccountState, AiProjectSettings, AiRun, AiTeam
from services.ai import budget, quota
from tests.ai_helpers import _project, _runner, _ticket, _wait, env  # noqa: F401


def _event(status="allowed", resets=None, kind="five_hour", five=0.4, seven=0.1):
    return {
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": status,
            "resetsAt": resets,
            "rateLimitType": kind,
            "unifiedWindows": {
                "five_hour": {
                    "utilization": five,
                    "resetsAt": 1900000000,
                    "status": "allowed",
                },
                "seven_day": {
                    "utilization": seven,
                    "resetsAt": 1900100000,
                    "status": status,
                },
            },
        },
    }


def _in(seconds: float) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat()


# --- quota: reading the stream ---------------------------------------------------------------------------------


def test_parse_event_reads_the_windows_and_ignores_other_events():
    out = quota.parse_event(_event("rejected", 1900000000, "seven_day", 0.5, 1.0))
    assert out["status"] == "rejected" and out["type"] == "seven_day"
    assert out["resets_at"].startswith("2030-03-17")
    assert out["five_hour"]["used"] == 0.5 and out["seven_day"]["used"] == 1.0
    assert out["seven_day"]["status"] == "rejected"
    assert quota.parse_event({"type": "assistant"}) is None
    assert quota.parse_event("nope") is None
    bad = quota.parse_event(
        {"type": "rate_limit_event", "rate_limit_info": {"resetsAt": "x"}}
    )
    assert bad["resets_at"] is None


def test_key_for_picks_the_override_then_the_account_then_the_local_login():
    team = AiTeam(id="t", project_id="p", account_id="acct_team")
    assert quota.key_for(team) == "acct_team"
    assert (
        quota.key_for(team, AiRun(project_id="p", member_id="t", account_id="acct_run"))
        == "acct_run"
    )
    assert quota.key_for(team, AiRun(project_id="p", member_id="t")) == "acct_team"
    assert quota.key_for(AiTeam(id="t", project_id="p")) == "local"
    assert (
        quota.key_for(AiTeam(id="t", project_id="p", provider="codex")) == "local:codex"
    )
    assert quota.key_for(None) == "local"


async def test_record_keeps_the_latest_reading_and_a_rejected_window_holds(env):  # noqa: F811
    row = await quota.record(
        "local", quota.parse_event(_event("allowed", None, five=0.65))
    )
    assert row.five_hour_used == 0.65 and row.held_until is None
    reset = _in(3600)
    ts = int(datetime.fromisoformat(reset).timestamp())
    row = await quota.record(
        "local", quota.parse_event(_event("rejected", ts, "seven_day", 0.7, 1.0))
    )
    assert row.seven_day_used == 1.0 and row.seven_day_status == "rejected"
    assert row.held_reason == "The weekly window is used up"
    assert quota.held(row) == row.held_until and row.held_until.startswith(reset[:16])
    # a later, shorter hold never shortens the one in force
    short = int((datetime.now(UTC) + timedelta(seconds=60)).timestamp())
    row = await quota.record(
        "local", quota.parse_event(_event("rejected", short, "five_hour"))
    )
    assert (
        row.held_until.startswith(reset[:16])
        and row.held_reason == "The 5-hour window is used up"
    )


def test_held_is_the_reset_time_only_while_it_lies_ahead():
    future, past = _in(600), _in(-600)
    assert quota.held(None) is None
    assert quota.held(AiAccountState(key="a")) is None
    assert quota.held(AiAccountState(key="a", held_until=future)) == future
    assert quota.held(AiAccountState(key="a", held_until=past)) is None
    assert quota.held(AiAccountState(key="a", held_until="garbage")) is None


async def test_release_expired_clears_only_the_holds_that_ended(env):  # noqa: F811
    async with env["maker"]() as s:
        s.add(AiAccountState(key="old", held_until=_in(-60), held_reason="x"))
        s.add(AiAccountState(key="new", held_until=_in(600), held_reason="y"))
        s.add(AiAccountState(key="none"))
        await s.commit()
    async with env["maker"]() as s:
        assert await quota.release_expired(s) == ["old"]
    async with env["maker"]() as s:
        old, new = (
            await s.get(AiAccountState, "old"),
            await s.get(AiAccountState, "new"),
        )
        assert old.held_until is None and old.held_reason is None
        assert new.held_until and new.held_reason == "y"


# --- quota: what makes a queued run wait -----------------------------------------------------------------------


async def _team_and_run(env, state="queued", **team_extra):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"], **team_extra)
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        run = AiRun(project_id=pid, ticket_id=tid, member_id=team["id"], state=state)
        s.add(run)
        await s.commit()
        await s.refresh(run)
        profile = await s.get(AiTeam, team["id"])
        return pid, profile, run


async def test_blocking_says_why_a_held_account_waits_and_not_when_free(env):  # noqa: F811
    _, profile, run = await _team_and_run(env)
    async with env["maker"]() as s:
        assert await quota.blocking(s, run, profile) is None
        assert (
            await s.get(AiAccountState, "local") is None
        )  # a check does not create the row
        s.add(
            AiAccountState(
                key="local",
                held_until=_in(900),
                held_reason="The weekly window is used up",
            )
        )
        await s.commit()
    async with env["maker"]() as s:
        why = await quota.blocking(s, run, profile)
    assert why.startswith(
        "Waiting for the next window: The weekly window is used up, reopens "
    )


async def test_blocking_counts_the_runs_going_on_the_same_account(env):  # noqa: F811
    pid, profile, run = await _team_and_run(env)
    async with env["maker"]() as s:
        for state in ("running", "starting", "finished"):
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=run.ticket_id,
                    member_id=profile.id,
                    state=state,
                )
            )
        s.add(AiAccountState(key="local", max_parallel=2))
        await s.commit()
    async with env["maker"]() as s:
        assert [r.state for r in await quota.running_on(s, "local")] == [
            "running",
            "starting",
        ]
        assert (
            await quota.blocking(s, run, profile)
            == "Waiting for a free slot on the account (2 of 2 in use)"
        )
        row = await s.get(AiAccountState, "local")
        row.max_parallel = 3
        s.add(row)
        await s.commit()
    async with env["maker"]() as s:
        assert await quota.blocking(s, run, profile) is None


async def test_a_weekly_limit_in_a_run_holds_the_account_and_the_next_run_waits(
    env, monkeypatch
):  # noqa: F811
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "window")
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    first = await _ticket(c, pid, "First")
    assert (await c.post(f"/tickets/{first}/ai/run", json={})).status_code in (200, 201)
    await _wait(c, first, ("failed", "finished"), timeout=30)
    async with env["maker"]() as s:
        row = await s.get(AiAccountState, "local")
    assert row is not None and quota.held(row)
    assert row.seven_day_used == 1.0 and row.seven_day_status == "rejected"
    # the next run of the same account is not started: it waits, and says for which window
    second = await _ticket(c, pid, "Second")
    assert (await c.post(f"/tickets/{second}/ai/run", json={})).status_code in (
        200,
        201,
    )
    run = await _wait(c, second, ("queued",), timeout=10)
    import asyncio

    await asyncio.sleep(0.5)
    run = (await c.get(f"/tickets/{second}/ai/runs")).json()[0]
    assert run["state"] == "queued"
    assert (run.get("waiting_reason") or "").startswith("Waiting for the next window")
    assert team["id"]


# --- budget: dates ---------------------------------------------------------------------------------------------


def test_the_day_and_month_start_at_local_midnight_and_the_first():
    today, month = budget.today_start(), budget.month_start()
    local_today, local_month = today.astimezone(), month.astimezone()
    assert (local_today.hour, local_today.minute, local_today.second) == (0, 0, 0)
    assert (local_month.day, local_month.hour) == (1, 0)
    assert today.tzinfo is not None and month <= today <= datetime.now(UTC)
    assert budget.day_key() == local_today.date().isoformat()
    key, start, end = budget.day_bounds(0)
    assert (
        key == budget.day_key()
        and start == today
        and end - start
        in (
            timedelta(hours=23),
            timedelta(hours=24),
            timedelta(hours=25),
        )
    )
    assert budget.day_bounds(1)[2] == start
    assert budget.local_day("not a date") is None and budget.local_day(None) is None
    assert budget.local_day(datetime.now(UTC).isoformat()) == budget.day_key()
    naive = budget.local_day(
        "2026-01-02T12:00:00"
    )  # a stored time without a zone is UTC
    assert naive in ("2026-01-02", "2026-01-03")


# --- budget: run limits ----------------------------------------------------------------------------------------


async def _schedule_runs(env, pid, team_id, n, trigger="schedule"):  # noqa: F811
    async with env["maker"]() as s:
        for _ in range(n):
            s.add(
                AiRun(
                    project_id=pid,
                    member_id=team_id,
                    state="finished",
                    trigger=trigger,
                    started_at=datetime.now(UTC).isoformat(),
                )
            )
        # one from before today never counts
        s.add(
            AiRun(
                project_id=pid,
                member_id=team_id,
                state="finished",
                trigger="schedule",
                started_at=(budget.today_start() - timedelta(hours=2)).isoformat(),
            )
        )
        await s.commit()


async def test_a_team_stops_scheduled_runs_at_its_runs_per_day_and_people_are_never_held(
    env,
):  # noqa: F811
    pid, profile, _ = await _team_and_run(env, max_runs_per_day=2)
    await _schedule_runs(env, pid, profile.id, 1)
    async with env["maker"]() as s:
        settings = AiProjectSettings(project_id=pid)
        assert await budget.runs_today(s, profile.id, kinds=("schedule",)) == 1
        assert await budget.blocked(s, profile, settings, "schedule") is None
    await _schedule_runs(env, pid, profile.id, 1)
    async with env["maker"]() as s:
        label, reason = await budget.blocked(s, profile, settings, "schedule")
        assert label == "Runs per day used up" and "(2 of 2)" in reason
        hit = await budget.blocked_detail(s, profile, settings, "schedule")
        assert (hit["scope"], hit["kind"]) == ("agent", "runs")
        # a run a person starts, and a check without a run kind, are not held by a run limit
        assert await budget.blocked(s, profile, settings, "person") is None
        assert await budget.blocked(s, profile, settings) is None


async def test_runs_today_counts_messages_as_automatic_unless_only_schedules_are_asked(
    env,
):  # noqa: F811
    pid, profile, _ = await _team_and_run(env)
    await _schedule_runs(env, pid, profile.id, 2)
    await _schedule_runs(env, pid, profile.id, 3, trigger="message")
    await _schedule_runs(env, pid, profile.id, 4, trigger="assign")
    async with env["maker"]() as s:
        assert await budget.runs_today(s, profile.id) == 5
        assert (
            await budget.runs_today(s, None, project_id=pid, kinds=("schedule",)) == 2
        )
        assert await budget.runs_today(s, "someone-else") == 0
    assert (
        budget.run_kind(AiRun(project_id=pid, member_id="x", trigger="schedule"))
        == "schedule"
    )
    assert (
        budget.run_kind(AiRun(project_id=pid, member_id="x", trigger="assign"))
        == "person"
    )


async def test_a_team_on_its_own_login_is_not_held_by_the_boards_runs_per_day(env):  # noqa: F811
    pid, profile, _ = await _team_and_run(env)
    await _schedule_runs(env, pid, profile.id, 3)
    async with env["maker"]() as s:
        settings = AiProjectSettings(project_id=pid, board_runs_per_day=1)
        assert await budget.blocked(s, profile, settings, "schedule") is None
        # a metered (API key) team is held by it
        profile.connection = "api_key"
        label, reason = await budget.blocked(s, profile, settings, "schedule")
        assert label == "Runs per day used up" and "Board" in reason


async def test_spend_and_tokens_add_up_metered_runs_of_today_only(env):  # noqa: F811
    pid, profile, _ = await _team_and_run(env)
    now = datetime.now(UTC)
    async with env["maker"]() as s:
        for cost, metered, when in (
            (1.5, True, now),
            (2.0, False, now),
            (4.0, True, budget.today_start() - timedelta(hours=1)),
        ):
            s.add(
                AiRun(
                    project_id=pid,
                    member_id=profile.id,
                    state="finished",
                    cost_usd=cost,
                    metered=metered,
                    tokens_in=100,
                    tokens_out=20,
                    started_at=when.isoformat(),
                )
            )
        await s.commit()
    async with env["maker"]() as s:
        today = budget.today_start()
        assert await budget.spent(s, today, member_id=profile.id) == pytest.approx(1.5)
        assert await budget.spent(s, today, project_id=pid) == pytest.approx(1.5)
        assert await budget.spent(
            s, today - timedelta(days=1), member_id=profile.id
        ) == pytest.approx(5.5)
        assert await budget.tokens_since(s, today, member_id=profile.id) == 120
        assert await budget.tokens_since(s, today, project_id="other") == 0
