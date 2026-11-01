"""Notification centre follow-ups from the review of PR #251: a snooze that runs out brings its row back, what was
already waiting at the upgrade gets its row, a signed-out account closes only on a confirmed sign-in, and a skipped
schedule slot is information, not a failed run."""

import json
from datetime import UTC, datetime, timedelta

from sqlmodel import select

from models import AiAccount, AiApproval, AiNotification, AiSchedule, Notification
from services import notifications as centre
from services.ai import schedules
from tests.test_notifications import _panel, _run, _set, _setup
from tests.test_ai import env  # noqa: F401


async def test_a_snooze_that_runs_out_brings_the_row_back_unread_with_a_new_event(env):
    c, pid, m, tid = await _setup(env)
    await centre.emit(
        "blocked", project_id=pid, recipients=["user"], title="Blocked", ticket_id=tid
    )
    [row] = (await _panel(c, "needs"))["items"]
    await c.post("/notifications/read", json={"ids": [row["id"]]})
    until = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    await c.post(f"/notifications/{row['id']}/snooze", json={"until": until})
    head = (await c.get("/notifications/feed")).json()["head"]
    assert await centre.wake_snoozed() is None  # not due yet
    await _set(
        env,
        Notification,
        row["id"],
        snoozed_until=(datetime.now(UTC) - timedelta(seconds=1)).isoformat(),
    )
    woke = await centre.wake_snoozed()
    assert woke > head
    feed = (await c.get("/notifications/feed", params={"since": head})).json()
    [back] = feed["items"]
    assert back["id"] == row["id"]
    assert back["snoozed"] is False
    assert back["read"] is False
    assert len((await _panel(c, "needs"))["items"]) == 1
    assert await centre.wake_snoozed() is None  # once


async def test_a_signed_out_account_stays_open_while_its_cli_is_missing(env):
    c, pid, m, tid = await _setup(env)
    async with env["maker"]() as s:
        acc = AiAccount(
            name="Work Claude",
            cli="claude",
            folder="/tmp/x",
            status="needs_sign_in",
            signed_out_at=datetime.now(UTC).isoformat(),
        )
        s.add(acc)
        await s.commit()
        acc_id = acc.id
    await centre.reconcile()
    await _set(env, AiAccount, acc_id, status="cli_missing")
    await centre.reconcile()
    [row] = (await _panel(c, "needs"))["items"]
    assert row["done"] is False
    await _set(env, AiAccount, acc_id, status="signed_in")
    await centre.reconcile()
    [row] = (await _panel(c, "needs"))["items"]
    assert row["done_text"] == "The account signed in again"


async def test_what_was_waiting_at_the_upgrade_gets_its_row_once(env):
    c, pid, m, tid = await _setup(env)
    run_id = await _run(
        env,
        pid,
        m["id"],
        tid,
        state="needs_input",
        question=json.dumps({"text": "Cursor or offset?", "to": "user"}),
    )
    async with env["maker"]() as s:
        a = AiApproval(
            project_id=pid,
            member_id=m["id"],
            ticket_id=tid,
            action="change_assignee",
            summary="Assign it to Tester.",
        )
        s.add(a)
        await s.commit()
        # the safety record the old app wrote when the approval was asked, before the centre existed
        s.add(
            AiNotification(
                project_id=pid,
                event="approval_requested",
                title="Dev wants to change an assignee",
                body="Assign it to Tester.",
                ref_kind="approval",
                ref_id=a.id,
                member_id=m["id"],
            )
        )
        acc = AiAccount(
            name="Old Claude", cli="claude", folder="/tmp/y", status="needs_sign_in"
        )
        s.add(acc)
        await s.commit()
        approval_id = a.id
    assert await centre.backfill_waiting() == 3
    await centre.reconcile()  # notes the signed-out account
    rows = (await _panel(c, "needs"))["items"]
    by_kind = {r["kind"]: r for r in rows}
    assert set(by_kind) == {"question", "approval", "account_signed_out"}
    assert by_kind["approval"]["target_id"] == approval_id
    assert by_kind["question"]["target_id"] == run_id
    assert (
        await centre.backfill_waiting() == 0
    )  # only the first start after the upgrade
    assert len((await _panel(c, "needs"))["items"]) == 3


async def test_a_skipped_schedule_slot_is_information_not_a_failed_run(env):
    c, pid, m, tid = await _setup(env)
    s = AiSchedule(
        id="sch_x",
        project_id=pid,
        ticket_id=tid,
        member_id=m["id"],
        created_by="user",
        notify=json.dumps(["failed"]),
    )
    schedules._notify(
        s, "failed", f"{tid} skipped: the schedule is paused", skipped=True
    )
    schedules._notify(s, "failed", f"{tid} scheduled run failed: boom")
    await centre.flush_pending()
    async with env["maker"]() as session:
        rows = (await session.exec(select(Notification))).all()
    kinds = sorted((r.kind, r.needs) for r in rows)
    assert kinds == [("run_failed", True), ("schedule", False)]
    skipped = next(r for r in rows if r.kind == "schedule")
    assert json.loads(skipped.data)["event"] == "skipped"


async def test_a_question_reminder_brings_the_row_back_without_counting_as_one_more(
    env,
):
    c, pid, m, tid = await _setup(env)
    run_id = await _run(
        env,
        pid,
        m["id"],
        tid,
        state="needs_input",
        question=json.dumps({"text": "Cursor or offset?", "to": "user"}),
    )
    await centre.on_run_question(run_id)
    [row] = (await _panel(c, "needs"))["items"]
    await c.post("/notifications/read", json={"ids": [row["id"]]})
    head = (await c.get("/notifications/feed")).json()["head"]
    await centre.on_run_question(run_id, reminder=True)
    [back] = (await c.get("/notifications/feed", params={"since": head})).json()[
        "items"
    ]
    assert back["id"] == row["id"]
    assert back["count"] == 1
    assert back["read"] is False
    assert back["title"] == row["title"]
