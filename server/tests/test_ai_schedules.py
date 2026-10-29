"""AI schedules (design/screens/ai-schedules.md, issue #153): planned slots and time zones, editor checks, a scheduled
run that passes its checks and moves to Review, AI review with a fix round, retries and auto-pause, catch-up and the
backup AI, the double-start guard and a ticket closed before its run. Runs use the fake Claude CLI; reviews use a
fake model."""

import asyncio
import sys
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from models import AiSchedule, AiScheduleRun
from services.ai import llm
from services.ai import schedules as svc
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401
from tests.test_ai_assist import FakeLLM

H = {"X-Actor": "An Nguyen"}
PASS = f'"{sys.executable}" -c "print(\'3 passed\')"'
FAIL = f'"{sys.executable}" -c "import sys; print(\'1 failed\'); sys.exit(1)"'


@pytest.fixture
def fake(monkeypatch):
    f = FakeLLM()
    monkeypatch.setattr(llm, "complete", f)
    monkeypatch.setattr(svc, "RT", svc._Runtime())
    svc.RT.reviews = {}
    svc.RT.events = svc.collections.deque(maxlen=200)
    return f


def _soon(minutes=3, tz="Asia/Ho_Chi_Minh") -> tuple[str, datetime]:
    at = (datetime.now(UTC) + timedelta(minutes=minutes)).replace(
        second=0, microsecond=0
    )
    return at.astimezone(ZoneInfo(tz)).strftime("%Y-%m-%dT%H:%M"), at


async def _setup(env):
    c = env["c"]
    pid, an = await _project(c)
    dev = await _runner(c, pid, env["repo"])
    rev = await _runner(c, pid, env["repo"], name="Reviewer")
    tid = await _ticket(c, pid, title="Return 409 on duplicate member names")
    return c, pid, dev, rev, tid


def _body(tid, member_id, run_at, **extra):
    return {
        "ticket_id": tid,
        "member_id": member_id,
        "kind": "once",
        "run_at": run_at,
        "tz": "Asia/Ho_Chi_Minh",
        "checks": {
            "criteria": True,
            "summary": True,
            "tests": {"on": True, "command": PASS},
        },
        **extra,
    }


async def _drive(c, sid, at, timeout=20.0):
    """Tick the schedule loop (as if at `at`) until the latest slot of `sid` ends."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        await svc.tick(now=at)
        d = (await c.get(f"/ai/schedules/{sid}")).json()
        if d["runs"] and d["runs"][0]["state"] in svc.ENDED:
            return d
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"slot never ended: {d['runs'][:1]}")
        await asyncio.sleep(0.1)


def test_slots_follow_the_time_zone_and_the_end_rule():
    s = AiSchedule(
        project_id="p",
        ticket_id="KAN-1",
        member_id="m",
        kind="repeat",
        days="[0,1,2,3,4]",
        time="02:00",
        tz="Asia/Ho_Chi_Minh",
    )
    # Thu Oct 29 2026 00:00 UTC is 07:00 in Ho Chi Minh: the next run is Fri 02:00 local = Thu 19:00 UTC
    after = datetime(2026, 10, 29, 0, 0, tzinfo=UTC)
    got = svc.slots(s, after, 5)
    assert got[0] == datetime(2026, 10, 29, 19, 0, tzinfo=UTC)
    assert [g.astimezone(ZoneInfo(s.tz)).weekday() for g in got] == [4, 0, 1, 2, 3]
    s.ends, s.ends_after, s.runs_count = "after", 3, 1
    assert len(svc.slots(s, after, 5)) == 2
    s.ends, s.ends_on = "on_date", "2026-11-02"
    assert [g.astimezone(ZoneInfo(s.tz)).day for g in svc.slots(s, after, 5)] == [30, 2]
    assert svc.when_label(s) == "Weekdays at 02:00" and svc.tz_label(s.tz) == "UTC+7"
    s.days = "[0,2]"
    assert svc.when_label(s) == "Every Mon, Wed at 02:00"


async def test_editor_checks_and_summary(env, fake):
    c, pid, dev, rev, tid = await _setup(env)
    run_at, _ = _soon()
    body = _body(
        tid,
        dev["id"],
        run_at,
        review={"on": True, "reviewer_id": dev["id"], "fix_rounds": 2},
    )
    p = (
        await c.post(f"/projects/{pid}/ai/schedules/preview", json=body, headers=H)
    ).json()
    assert any(
        x["level"] == "error" and "cannot review its own work" in x["text"]
        for x in p["checks"]
    )
    # Past time names the next free time
    past = (
        (datetime.now(UTC) - timedelta(hours=2))
        .astimezone(ZoneInfo("Asia/Ho_Chi_Minh"))
        .strftime("%Y-%m-%dT%H:%M")
    )
    p = (
        await c.post(
            f"/projects/{pid}/ai/schedules/preview",
            json=_body(tid, dev["id"], past),
            headers=H,
        )
    ).json()
    assert any(
        "That time has passed. Next free time:" in x["text"] for x in p["checks"]
    )
    r = await c.post(
        f"/projects/{pid}/ai/schedules", json=_body(tid, dev["id"], past), headers=H
    )
    assert (
        r.status_code == 422 and r.json()["code"] == "invalid" and r.json()["problems"]
    )
    # A repeat schedule: summary in plain words, next 5 runs, checks
    rep = {
        **_body(tid, dev["id"], None),
        "kind": "repeat",
        "days": [0, 1, 2, 3, 4],
        "time": "02:00",
        "review": {"on": True, "reviewer_id": rev["id"], "fix_rounds": 2},
        "checks": {
            **body["checks"],
            "ai_checks": ["Duplicate names are rejected whatever the letter case"],
        },
    }
    p = (
        await c.post(f"/projects/{pid}/ai/schedules/preview", json=rep, headers=H)
    ).json()
    assert p["summary"].startswith(
        "Every weekday at 02:00 (UTC+7), Claude Code · Backend works on KAN-1."
    )
    assert (
        "3 checks and 1 review point pass" in p["summary"]
        and "Reviewer then checks it, up to 2 fix rounds." in p["summary"]
    )
    assert len(p["next_runs"]) == 5 and not [
        x for x in p["checks"] if x["level"] == "error"
    ]
    assert any(x["text"].startswith("Runner online now") for x in p["checks"])
    # A viewer cannot schedule
    viewer = (
        await c.post(f"/projects/{pid}/members", json={"name": "Vy", "role": "viewer"})
    ).json()
    assert viewer["role"] == "viewer"
    p = (
        await c.post(
            f"/projects/{pid}/ai/schedules/preview", json=rep, headers={"X-Actor": "Vy"}
        )
    ).json()
    assert any(
        "You cannot schedule Claude Code · Backend" in x["text"] for x in p["checks"]
    )


async def test_scheduled_run_passes_checks_and_moves_to_review(env, fake):
    c, pid, dev, rev, tid = await _setup(env)
    run_at, at = _soon()
    r = await c.post(
        f"/projects/{pid}/ai/schedules", json=_body(tid, dev["id"], run_at), headers=H
    )
    assert r.status_code == 201, r.text
    s = r.json()
    assert (
        s["when"].startswith("Once · ")
        and s["next_run_at"] == at.isoformat()
        and s["created_by"] == "An Nguyen"
    )
    lst = (await c.get(f"/projects/{pid}/ai/schedules")).json()
    assert lst["next24h"] == 1 and lst["counts"]["upcoming"] == 1
    cards = (await c.get(f"/projects/{pid}/ai/schedules/cards")).json()
    assert cards[0]["ticket_id"] == tid and cards[0]["state"] == "soon"
    await svc.tick(now=at - timedelta(minutes=1))  # not due yet
    assert not (await c.get(f"/ai/schedules/{s['id']}")).json()["runs"]
    d = await _drive(c, s["id"], at + timedelta(seconds=5))
    slot = d["runs"][0]
    assert slot["state"] == "passed", slot
    assert {x["key"]: x["ok"] for x in slot["results"]} == {
        "criteria": True,
        "tests": True,
        "summary": True,
    }
    assert (
        "3 passed" in next(x for x in slot["results"] if x["key"] == "tests")["detail"]
    )
    run = (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]
    assert (
        run["trigger"] == "schedule"
        and run["startedBy" if "startedBy" in run else "started_by"] == "An Nguyen"
    )
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["status"] == "review"
    texts = [e.get("to") for e in t["activity_log"] if e.get("field") == "ai_schedule"]
    assert any("created a schedule for KAN-1" in x for x in texts)
    assert any(
        "started a scheduled run on KAN-1 (schedule by An Nguyen)" in x for x in texts
    )
    assert any("moved KAN-1 to Review" in x for x in texts)
    assert d["state"] == "ended" and d["stats"]["passed"] == 1
    assert not d["ticket_changed"]  # its own run changed the ticket
    ev = (await c.get(f"/projects/{pid}/ai/schedules/events")).json()
    assert [e["event"] for e in ev] == ["started", "finished"] and ev[0]["to"] == [
        "An Nguyen"
    ]
    # The same slot never starts twice
    async with env["maker"]() as session:
        from sqlmodel import select

        rows = (await session.exec(select(AiScheduleRun))).all()
    assert len(rows) == 1


async def test_review_sends_it_back_once_then_passes(env, fake):
    c, pid, dev, rev, tid = await _setup(env)
    run_at, at = _soon()
    body = _body(
        tid,
        dev["id"],
        run_at,
        review={"on": True, "reviewer_id": rev["id"], "fix_rounds": 2},
        checks={
            "criteria": True,
            "summary": True,
            "ai_checks": ["Duplicate names are rejected whatever the letter case"],
        },
    )
    s = (await c.post(f"/projects/{pid}/ai/schedules", json=body, headers=H)).json()
    fake.queue = [
        '{"verdict": "changes", "notes": "Case is not handled.", "checks": [{"text": "x", "pass": false}], "fixes": ["Compare names case-insensitively"]}',
        '{"verdict": "pass", "notes": "Looks good. One note: the error message names the member but not the project.", "checks": [{"text": "x", "pass": true}]}',
    ]
    d = await _drive(c, s["id"], at + timedelta(seconds=5), timeout=30)
    slot = d["runs"][0]
    assert slot["state"] == "passed", slot
    assert slot["fix_round"] == 1 and len(slot["run_ids"]) == 2
    assert slot["review"]["verdict"] == "pass" and slot["review"]["rounds"] == 2
    assert slot["review"]["reviewer_name"] == "Reviewer" and slot["note"].startswith(
        "Review passed in round 2"
    )
    ai = next(x for x in slot["results"] if x["kind"] == "ai")
    assert ai["ok"] and ai["detail"].startswith("Judged by Reviewer: pass")
    assert (
        "Case is not handled." not in fake.prompts[0]
        and "Machine checks" in fake.prompts[0]
    )
    runs_ = (await c.get(f"/tickets/{tid}/ai/runs")).json()
    assert "Compare names case-insensitively" in runs_[0]["instruction"]
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "review"
    assert d["stats"]["review_rounds"] == 2


async def test_failed_tests_retry_then_three_failures_pause(env, fake):
    c, pid, dev, rev, tid = await _setup(env)
    body = {
        **_body(tid, dev["id"], None),
        "kind": "repeat",
        "days": [0, 1, 2, 3, 4, 5, 6],
        "time": "02:00",
        "checks": {
            "criteria": False,
            "summary": False,
            "tests": {"on": True, "command": FAIL},
        },
        "limits": {"stop_after_min": 45, "retries": 1},
    }
    s = (await c.post(f"/projects/{pid}/ai/schedules", json=body, headers=H)).json()
    for i in range(3):
        r = await c.post(f"/ai/schedules/{s['id']}/run-now", headers=H)
        assert r.status_code == 200, r.text
        d = await _drive(c, s["id"], datetime.now(UTC), timeout=30)
        slot = d["runs"][0]
        assert slot["state"] == "failed", slot
        assert slot["note"] == "Tests failed. Retried, failed again."
        assert slot["attempts"] == 2
        if i < 2:
            assert d["state"] == "active" and d["failures_in_row"] == i + 1
    assert d["state"] == "paused" and d["paused_reason"].startswith(
        "Failed 3 runs in a row"
    )
    r = await c.post(f"/ai/schedules/{s['id']}/resume", headers=H)
    assert r.json()["state"] == "active" and r.json()["failures_in_row"] == 0


async def test_catch_up_backup_and_skips(env, fake):
    c, pid, dev, rev, tid = await _setup(env)
    other = await _runner(c, pid, env["repo"], name="Backup")
    run_at, at = _soon()
    s = (
        await c.post(
            f"/projects/{pid}/ai/schedules",
            json={**_body(tid, dev["id"], run_at), "catch_up_hours": 1},
            headers=H,
        )
    ).json()
    await c.post(f"/ai/members/{dev['id']}/pause", json={})
    await svc.tick(now=at + timedelta(seconds=5))
    slot = (await c.get(f"/ai/schedules/{s['id']}")).json()["runs"][0]
    assert slot["state"] == "waiting" and "Starts when it is back" in slot["note"]
    cards = (await c.get(f"/projects/{pid}/ai/schedules/cards")).json()
    assert cards[0]["label"] == "Missed, waiting for runner"
    # Past the catch-up time: skipped, and the owner is told
    await svc.tick(now=at + timedelta(hours=1, minutes=5))
    d = (await c.get(f"/ai/schedules/{s['id']}")).json()
    assert (
        d["runs"][0]["state"] == "skipped"
        and "for more than 1 hours" in d["runs"][0]["note"]
    )
    assert d["failures_in_row"] == 0
    ev = (await c.get(f"/projects/{pid}/ai/schedules/events")).json()
    assert (
        ev[-1]["text"].startswith("KAN-1 skipped:") and ev[-1]["action"] == "reschedule"
    )
    # With a backup AI the run goes ahead on it
    run_at, at = _soon(5)
    s2 = (
        await c.post(
            f"/projects/{pid}/ai/schedules",
            json={**_body(tid, dev["id"], run_at), "backup_member_id": other["id"]},
            headers=H,
        )
    ).json()
    d = await _drive(c, s2["id"], at + timedelta(seconds=5))
    assert d["runs"][0]["member_name"] == "Backup"
    assert d["runs"][0]["note"].startswith(
        "Ran on the backup AI, Backup. Finished · passed"
    )


async def test_closed_ticket_skips_and_owner_rules(env, fake):
    c, pid, dev, rev, tid = await _setup(env)
    run_at, at = _soon()
    s = (
        await c.post(
            f"/projects/{pid}/ai/schedules",
            json=_body(tid, dev["id"], run_at),
            headers=H,
        )
    ).json()
    # Only the creator or an admin changes it
    await c.post(f"/projects/{pid}/members", json={"name": "Binh", "role": "member"})
    r = await c.post(f"/ai/schedules/{s['id']}/pause", headers={"X-Actor": "Binh"})
    assert r.status_code == 403
    r = await c.patch(
        f"/ai/schedules/{s['id']}",
        json={"instruction": "Keep the change small."},
        headers=H,
    )
    assert r.status_code == 200 and r.json()["instruction"] == "Keep the change small."
    r = await c.patch(
        f"/tickets/{tid}", json={"status": "wont_do", "wont_do_reason": "Not needed"}
    )
    assert r.status_code == 200, r.text
    await svc.tick(now=at + timedelta(seconds=5))
    d = (await c.get(f"/ai/schedules/{s['id']}")).json()
    assert (
        d["runs"][0]["state"] == "skipped"
        and d["runs"][0]["note"] == "Skipped: KAN-1 is Won’t Do."
    )
    r = await c.delete(f"/ai/schedules/{s['id']}", headers=H)
    assert r.status_code == 204
    assert (await c.get(f"/ai/schedules/{s['id']}")).status_code == 404


async def test_week_view_marks_overlaps(env, fake):
    c, pid, dev, rev, tid = await _setup(env)
    t2 = await _ticket(c, pid, title="Add drag handle")
    base = {
        "kind": "repeat",
        "days": [0, 1, 2, 3, 4, 5, 6],
        "tz": "UTC",
        "checks": {"criteria": False},
    }
    await c.post(
        f"/projects/{pid}/ai/schedules",
        json={**base, "ticket_id": tid, "member_id": dev["id"], "time": "02:00"},
        headers=H,
    )
    p = (
        await c.post(
            f"/projects/{pid}/ai/schedules/preview",
            json={**base, "ticket_id": t2, "member_id": dev["id"], "time": "02:30"},
            headers=H,
        )
    ).json()
    assert any(
        "KAN-1 is scheduled for the same AI at 02:00" in x["text"] for x in p["checks"]
    )
    await c.patch(f"/ai/members/{dev['id']}", json={"max_parallel": 1})
    await c.post(
        f"/projects/{pid}/ai/schedules",
        json={**base, "ticket_id": t2, "member_id": dev["id"], "time": "02:30"},
        headers=H,
    )
    w = (await c.get(f"/projects/{pid}/ai/schedules/week")).json()
    runs_ = [i for i in w["items"] if i["kind"] == "run"]
    assert len(runs_) == 14 and any(i.get("overlap") for i in runs_)
    assert w["members"][0]["name"] == "Claude Code · Backend"
