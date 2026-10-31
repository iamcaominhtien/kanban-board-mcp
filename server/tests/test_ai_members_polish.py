"""AI members polish (docs/specs/ai-gaps.md, section 2): local "today", avatar colour and glyph, rate-limit retries,
model-retired detection, periodic runner re-detection and the profile data the UI shows."""

import asyncio
import os
import time
from datetime import UTC, datetime, timedelta

import pytest

from models import AiMember, AiRun
from services.ai import api_agent, budget, cli, members, runs
from tests.test_ai import (  # noqa: F401
    FAKE,
    FakeChat,
    _api_member,
    _project,
    _runner,
    _ticket,
    _wait,
    env,
)


@pytest.fixture
def auckland(monkeypatch):
    """The process runs in a time zone far from UTC, so a UTC "today" and a local one disagree."""
    monkeypatch.setenv("TZ", "Pacific/Auckland")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


# --------------------------------------------------------------------------- local today


def test_today_and_month_start_at_local_midnight(auckland):
    now = datetime.now().astimezone()
    assert budget.today_start().astimezone().hour == 0
    assert budget.today_start().astimezone().date() == now.date()
    assert budget.month_start().astimezone().day == 1
    label, start, end = budget.day_bounds(0)
    assert label == now.date().isoformat()
    assert end - start in (
        timedelta(hours=23),
        timedelta(hours=24),
        timedelta(hours=25),
    )
    assert (
        budget.day_bounds(1)[2] == start
    )  # days are back to back, whatever the DST shift
    # 14:00 UTC is already the next calendar day in Auckland (UTC+12/13)
    assert budget.local_day("2026-10-28T14:00:00+00:00") == "2026-10-29"
    assert budget.local_day(None) is None and budget.local_day("nonsense") is None


async def test_usage_days_and_today_follow_the_local_day(env, auckland):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid)
    tid = await _ticket(c, pid)
    just_after_midnight = budget.today_start() + timedelta(minutes=5)
    just_before_midnight = budget.today_start() - timedelta(minutes=5)
    async with env["maker"]() as s:
        for n, when in ((1, just_after_midnight), (2, just_before_midnight)):
            s.add(
                AiRun(
                    project_id=pid,
                    ticket_id=tid,
                    member_id=m["id"],
                    number=n,
                    state="finished",
                    metered=True,
                    cost_usd=1.0,
                    queued_at=when.isoformat(),
                    started_at=when.isoformat(),
                    ended_at=when.isoformat(),
                )
            )
        await s.commit()
    use = (await c.get(f"/ai/members/{m['id']}/usage")).json()
    today = datetime.now().astimezone().date()
    assert use["days"][-1]["date"] == today.isoformat()
    assert use["days"][-2]["date"] == (today - timedelta(days=1)).isoformat()
    # The run before local midnight belongs to yesterday, the one after it to today
    assert use["runs_today"] == 1 and use["days"][-1]["runs"] == 1
    assert use["days"][-2]["runs"] == 1
    project = (await c.get(f"/projects/{pid}/ai/usage", params={"range": "7d"})).json()
    by_day = {d["date"]: d["runs"] for d in project["days"] if d["runs"]}
    assert by_day == {today.isoformat(): 1, (today - timedelta(days=1)).isoformat(): 1}
    overview = (await c.get(f"/projects/{pid}/ai/overview")).json()
    assert overview["summary"]["runs_today"] == 1


# --------------------------------------------------------------------------- avatar


async def test_avatar_colour_and_glyph_default_by_provider_and_can_be_picked(env):
    c = env["c"]
    pid, _ = await _project(c)
    a = await _runner(c, pid, env["repo"])
    assert (a["glyph"], a["color"]) == ("asterisk", "#2E6F40")
    b = await _runner(
        c, pid, env["repo"], name="Picked", glyph="braces", color="#b0446e"
    )
    assert (b["glyph"], b["color"]) == ("braces", "#B0446E")
    r = await c.patch(
        f"/ai/members/{a['id']}", json={"glyph": "terminal", "color": "#2F6FB0"}
    )
    assert r.status_code == 200
    assert (r.json()["glyph"], r.json()["color"]) == ("terminal", "#2F6FB0")
    # The colour is the Member's own, so tickets and comments draw the same avatar
    people = (await c.get(f"/projects/{pid}/members")).json()
    assert {m["id"]: m["color"] for m in people}[a["id"]] == "#2F6FB0"
    bad = await c.patch(f"/ai/members/{a['id']}", json={"glyph": "skull"})
    assert bad.status_code == 422 and "glyph" in bad.json()["detail"]
    bad = await c.patch(f"/ai/members/{a['id']}", json={"color": "green"})
    assert bad.status_code == 422 and "colour" in bad.json()["detail"]


async def test_rename_checks_duplicates_and_keeps_the_member(env):
    c = env["c"]
    pid, _ = await _project(c)
    a = await _runner(c, pid, env["repo"])
    await _runner(c, pid, env["repo"], name="Other")
    r = await c.patch(f"/ai/members/{a['id']}", json={"name": "other "})
    assert r.status_code == 422 and "Another AI member" in r.json()["detail"]
    r = await c.patch(f"/ai/members/{a['id']}", json={"name": "Backend Builder"})
    assert r.status_code == 200 and r.json()["name"] == "Backend Builder"
    assert r.json()["id"] == a["id"]


# --------------------------------------------------------------------------- profile data


async def test_member_describes_last_call_approvals_and_the_running_ticket(
    env, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid, title="Add drag handle")
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    await _wait(c, tid, ("running",))
    d = (await c.get(f"/ai/members/{m['id']}")).json()
    assert d["running"][0]["ticket_title"] == "Add drag handle"
    assert d["running"][0]["ticket_status"] == "in-progress"
    # Developer template: these actions wait for a person
    assert {a["action"] for a in d["approvals"]} == {
        "change_assignee",
        "edit_docs",
    }
    assert d["last_call_at"] is None
    await c.post(f"/ai/runs/{d['running'][0]['run_id']}/cancel", json={})


async def test_status_lines_for_a_paused_and_a_key_invalid_member(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid)
    r = (await c.post(f"/ai/members/{m['id']}/pause", json={})).json()
    assert r["status"]["label"] == "Paused by user" and r["paused_at"]
    await c.post(f"/ai/members/{m['id']}/resume")
    async with env["maker"]() as s:
        row = await s.get(AiMember, m["id"])
        row.health, row.health_detail = "key_invalid", "401 Unauthorized — rejected"
        s.add(row)
        await s.commit()
    d = (await c.get(f"/ai/members/{m['id']}")).json()
    assert d["status"]["code"] == "key_invalid"
    assert d["status"]["detail"] == "401 from provider"


async def test_runner_says_where_local_runners_live(env):
    r = (await env["c"].get("/ai/runner")).json()
    assert r["local"] is True and r["host"] and r["app_version"]


async def test_detect_reports_latest_version_and_install_steps(env, monkeypatch):
    async def latest(provider):
        return "9.9.10"

    monkeypatch.setattr(members, "latest_cli_version", latest)
    monkeypatch.setenv("PATH", f"{FAKE.rsplit('/', 1)[0]}:/usr/bin")
    c = env["c"]
    r = (
        await c.post("/ai/detect", json={"provider": "claude-code", "cli_path": FAKE})
    ).json()
    assert r["found"] and r["version"].startswith("9.9.9")
    assert r["latest_version"] == "9.9.10" and r["up_to_date"] is False
    assert r["guide_url"].startswith("https://")
    ag = (await c.post("/ai/detect", json={"provider": "antigravity"})).json()
    assert ag["install_steps"] and "command line" in ag["install_steps"][2]


# --------------------------------------------------------------------------- model retired


@pytest.mark.parametrize(
    "provider,model,listed,retired",
    [
        ("gemini", "gemini-1.5-pro", ["models/gemini-2.5-pro"], True),
        ("gemini", "gemini-2.5-pro", ["models/gemini-2.5-pro"], False),
        ("custom", "llama-3", ["llama-3.1", "mistral"], True),
        ("custom", "mistral", ["mistral"], False),
        # An alias matches its dated ids
        ("anthropic", "claude-haiku-5-5", ["claude-haiku-5-5-20260101"], False),
    ],
)
async def test_model_retired_is_detected_for_every_api_provider(
    env, monkeypatch, provider, model, listed, retired
):
    c = env["c"]
    pid, _ = await _project(c)

    async def fake_key(provider_, key, base):
        return {"ok": True, "status": 200, "models": listed}

    monkeypatch.setattr(members, "test_key", fake_key)
    body = {
        "name": "M",
        "provider": provider,
        "api_key": "sk-test-1234567890",
        "model": model,
    }
    if provider == "custom":
        body["base_url"] = "https://llm.example.dev/v1"
    m = (await c.post(f"/projects/{pid}/ai/members", json=body)).json()
    r = (await c.post(f"/ai/members/{m['id']}/test", json={})).json()
    assert (r["health"] == "model_retired") is retired
    d = (await c.get(f"/ai/members/{m['id']}")).json()
    assert (d["status"]["code"] == "model_retired") is retired


def test_a_provider_that_names_the_model_in_a_400_or_404_means_retired():
    for status, body in (
        (404, '{"error": "models/gemini-1.5 is not found"}'),
        (
            400,
            '{"error": {"code": "model_not_found", "message": "The model x does not exist"}}',
        ),
    ):
        assert api_agent._classify(status, body).kind == "model"
    assert api_agent._classify(400, "bad json").kind == "bad_request"


# --------------------------------------------------------------------------- rate limits


async def _wait_state(c, tid, states, timeout=30.0):
    return await _wait(c, tid, states, timeout)


async def _wait_requeued(c, tid, times=1, timeout=30.0):
    """The run went back to the queue after a rate limit `times` times (a fresh assignment is queued too)."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        run = (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]
        n = sum(1 for s in run["steps"] if s["kind"] == "rate_limited")
        if run["state"] == "queued" and n >= times:
            return run
        assert asyncio.get_running_loop().time() < deadline, run["state"]
        runs.RT.wake.set()
        await asyncio.sleep(0.05)


async def test_a_rate_limited_api_run_requeues_and_retry_now_starts_it(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, config={"retries": 0})
    tid = await _ticket(c, pid)
    chats = [
        FakeChat([api_agent.ProviderError("rate", "429 from provider", 429, 40.0)]),
        FakeChat([api_agent.Reply(text="Done after the wait.", tokens_in=10)]),
    ]
    monkeypatch.setattr(api_agent, "make_chat", lambda *a, **k: chats.pop(0))
    await c.post(f"/tickets/{tid}/ai/assign", json={"member_id": m["id"]})
    run = await _wait_requeued(c, tid)
    d = (await c.get(f"/ai/members/{m['id']}")).json()
    assert d["status"]["code"] == "rate_limited" and d["retry_at"]
    assert d["queued"] == 1
    wait = datetime.fromisoformat(d["retry_at"]) - datetime.now(UTC)
    assert 30 < wait.total_seconds() <= 40
    board = (await c.get(f"/projects/{pid}/ai/board")).json()["runs"][0]
    assert "Rate-limited" in board["waiting_reason"]
    # The wait is not over, so it stays queued; Retry now skips it
    runs.RT.wake.set()
    r = await c.post(f"/ai/members/{m['id']}/retry-now")
    assert r.status_code == 200 and r.json()["status"]["code"] != "rate_limited"
    run = await _wait_state(c, tid, ("finished",))
    assert run["number"] == 1  # the same run, not a new one
    again = await c.post(f"/ai/members/{m['id']}/retry-now")
    assert again.status_code == 409


async def test_a_rate_limited_run_retries_by_itself_after_the_wait(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, config={"retries": 0})
    tid = await _ticket(c, pid)
    chats = [
        FakeChat([api_agent.ProviderError("rate", "429", 429, 5.0)]),
        FakeChat([api_agent.Reply(text="ok", tokens_in=1)]),
    ]
    monkeypatch.setattr(api_agent, "make_chat", lambda *a, **k: chats.pop(0))
    await c.post(f"/tickets/{tid}/ai/assign", json={"member_id": m["id"]})
    await _wait_requeued(c, tid)
    # Pretend the wait is over (on a slow machine it may already be: write both fields so the loop clears them)
    async with env["maker"]() as s:
        row = await s.get(AiMember, m["id"])
        row.health = "rate_limited"
        row.retry_at = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        s.add(row)
        await s.commit()
    run = await _wait_state(c, tid, ("finished",))
    assert run["state"] == "finished"
    d = (await c.get(f"/ai/members/{m['id']}")).json()
    assert d["status"]["code"] != "rate_limited" and d["retry_at"] is None


async def test_a_provider_that_keeps_refusing_fails_the_run_in_the_end(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _api_member(c, pid, config={"retries": 0})
    tid = await _ticket(c, pid)
    monkeypatch.setattr(
        api_agent,
        "make_chat",
        lambda *a, **k: FakeChat([api_agent.ProviderError("rate", "429", 429, 5.0)]),
    )
    await c.post(f"/tickets/{tid}/ai/assign", json={"member_id": m["id"]})
    for n in range(1, runs.MAX_RATE_REQUEUES + 1):
        await _wait_requeued(c, tid, n)
        await c.post(f"/ai/members/{m['id']}/retry-now")
    run = await _wait_state(c, tid, ("failed",))
    assert "429" in run["ended_reason"]
    assert (
        sum(1 for s in run["steps"] if s["kind"] == "rate_limited")
        == runs.MAX_RATE_REQUEUES
    )


async def test_a_rate_limited_cli_run_is_requeued_not_failed(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "rate_limit")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    run = await _wait_requeued(c, tid)
    assert any("retries in about 30 s" in s["text"] for s in run["steps"])
    d = (await c.get(f"/ai/members/{m['id']}")).json()
    assert d["status"]["code"] == "rate_limited"
    # No failure comment was posted for the ticket
    ticket = (await c.get(f"/tickets/{tid}")).json()
    assert not any("failed" in (x["text"] or "") for x in ticket["comments"])
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    await c.post(f"/ai/members/{m['id']}/retry-now")
    run = await _wait_state(c, tid, ("finished",))
    assert run["state"] == "finished"


def test_rate_limit_wait_reads_what_the_cli_says():
    assert cli.rate_limit_wait("everything fine") is None
    assert cli.rate_limit_wait("API Error: 429") == cli.RATE_WAIT_DEFAULT
    assert cli.rate_limit_wait("rate limited. Retry after 120 seconds") == 120
    reset = int(time.time()) + 600
    got = cli.rate_limit_wait(f"Claude usage limit reached|{reset}")
    assert got is not None and 590 < got <= 600
    assert cli.rate_limit_wait("429 usage limit|9999999999") == cli.RATE_WAIT_MAX


# --------------------------------------------------------------------------- periodic re-detection


async def test_health_check_heals_a_returned_runner_and_flags_a_vanished_one(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    # The CLI went missing while the board was running
    async with env["maker"]() as s:
        row = await s.get(AiMember, m["id"])
        good_path = row.cli_path
        row.cli_path = "/nope/claude"
        row.health, row.health_detail = "ok", None
        s.add(row)
        await s.commit()
    real_path = os.environ["PATH"]
    monkeypatch.setenv("PATH", "/nonexistent")
    monkeypatch.setattr(cli, "_SEARCH_DIRS", [])
    assert await members.health_check() == 1
    d = (await c.get(f"/ai/members/{m['id']}")).json()
    assert d["status"]["code"] == "runner_missing"
    # Work assigned meanwhile waits in the queue
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    await _wait_state(c, tid, ("queued",))
    for _ in range(50):  # the scheduler says why it waits on its next tick
        runs.RT.wake.set()
        await asyncio.sleep(0.05)
        run = (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]
        if run["waiting_reason"]:
            break
    assert "Runner not detected" in (run["waiting_reason"] or "")
    # It comes back (and signed in): the next check heals it and the run starts
    monkeypatch.setenv("PATH", real_path)
    async with env["maker"]() as s:
        row = await s.get(AiMember, m["id"])
        row.cli_path = good_path
        s.add(row)
        await s.commit()
    assert await members.health_check() == 1
    d = (await c.get(f"/ai/members/{m['id']}")).json()
    assert d["health"] == "ok" and d["cli_version"].startswith("9.9.9")
    run = await _wait_state(c, tid, ("finished", "failed"))
    assert run["state"] == "finished"


async def test_health_check_notices_a_sign_in_that_expired_and_came_back(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    async with env[
        "maker"
    ]() as s:  # last checked long ago, so the sign-in is looked at again
        row = await s.get(AiMember, m["id"])
        row.checked_at = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        s.add(row)
        await s.commit()
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "logged_out")
    assert await members.health_check() == 1
    assert (await c.get(f"/ai/members/{m['id']}")).json()["health"] == "not_logged_in"
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    assert await members.health_check() == 1
    assert (await c.get(f"/ai/members/{m['id']}")).json()["health"] == "ok"
    assert await members.health_check() == 0  # nothing changed, nothing to say


async def test_health_check_holds_no_write_lock_while_it_asks_the_cli(env, monkeypatch):
    """A slow `claude` check must not block other writers (a run posting its answer, a comment being saved)."""
    from sqlalchemy import text

    c = env["c"]
    pid, _ = await _project(c)
    a = await _runner(c, pid, env["repo"], name="A")
    b = await _runner(c, pid, env["repo"], name="B")
    async with env["maker"]() as s:
        for mid in (a["id"], b["id"]):
            profile = await s.get(AiMember, mid)
            profile.health, profile.checked_at = "not_logged_in", None
            s.add(profile)
        await s.commit()
    wrote = []

    async def slow(provider, cli_path):
        # while the "CLI" runs, another connection must be able to write at once
        engine = env["maker"].kw["bind"]
        async with engine.begin() as conn:
            await conn.execute(text("PRAGMA busy_timeout=300"))
            await conn.execute(text("UPDATE ticket SET title = title WHERE 0"))
        wrote.append(True)
        return {"found": True, "logged_in": True, "version": "1", "account": "x"}

    monkeypatch.setattr(members, "detect_local", slow)
    await members.health_check()
    assert len(wrote) == 2
