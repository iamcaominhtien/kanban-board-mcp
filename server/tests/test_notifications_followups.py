"""Notification centre follow-ups from the review of PR #251: a snooze that runs out brings its row back, what was
already waiting at the upgrade gets its row, a signed-out account closes only on a confirmed sign-in, and a skipped
schedule slot is information, not a failed run."""

import json
from datetime import UTC, datetime, timedelta

from sqlmodel import select

from models import (
    AiAccount,
    AiApproval,
    AiNotification,
    AiSchedule,
    Notification,
    Ticket,
)
from services import notifications as centre
from services.ai import runs, schedules
from tests.test_notifications import _panel, _run, _set, _setup
from tests.ai_helpers import env  # noqa: F401


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


# --------------------------------------------------------------------------- the second review of PR #251


async def _rows(env, *rows: Notification) -> None:
    async with env["maker"]() as s:
        s.add_all(rows)
        await s.commit()


def _row(recipient="user", **fields) -> Notification:
    kind = fields.pop("kind", "ai_finished")
    return Notification(
        recipient=recipient,
        event_id=fields.pop("event_id", 1),
        last_event_id=fields.pop("last_event_id", 1),
        kind=kind,
        needs=centre.is_needs(kind),
        group_key=fields.pop("group_key", f"{kind}:x"),
        **fields,
    )


def _ago(**delta) -> str:
    return (datetime.now(UTC) - timedelta(**delta)).isoformat()


async def test_an_old_open_needs_row_behind_thousands_of_updates_is_still_listed(env):
    c, pid, m, tid = await _setup(env)
    old = _ago(days=40)
    await _rows(
        env,
        _row(kind="blocked", title="Still waiting", created_at=old, updated_at=old),
        *(_row(title=f"u{i}", updated_at=_ago(minutes=i)) for i in range(2005)),
    )
    page = (
        await c.get("/notifications", params={"view": "page", "filter": "needs"})
    ).json()
    assert [r["title"] for r in page["items"]] == ["Still waiting"]
    assert page["total"] == 1
    every = (await c.get("/notifications", params={"view": "page", "limit": 5})).json()
    assert every["total"] == 2006
    assert len(every["items"]) == 5
    counts = (await c.get("/notifications/counts")).json()
    assert counts["needs"] == 1
    assert counts["oldest_needs_at"] == old
    assert counts["updates_unread"] == 2005
    assert counts["unread"] == 2006


async def test_counts_leave_out_snoozed_quiet_cleared_done_and_old_rows(env):
    c, pid, m, tid = await _setup(env)
    later = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    await _rows(
        env,
        _row(kind="question", title="open", created_at=_ago(hours=3)),
        _row(kind="question", title="open, read", read_at=_ago(minutes=1)),
        _row(kind="question", title="snoozed", snoozed_until=later),
        _row(kind="question", title="snooze ran out", snoozed_until=_ago(minutes=1)),
        _row(kind="question", title="done", done_at=_ago(minutes=1)),
        _row(title="update"),
        _row(title="read update", read_at=_ago(minutes=1)),
        _row(title="quiet update", inapp=False),
        _row(title="cleared update", cleared_at=_ago(minutes=1)),
        _row(title="old update", updated_at=_ago(days=31)),
        _row(title="snoozed update", snoozed_until=later),
        _row("hoa mai", kind="question", title="hers"),
    )
    counts = (await c.get("/notifications/counts")).json()
    assert counts["needs"] == 3  # open, open read, snooze ran out
    assert counts["needs_unread"] == 2
    assert counts["updates_unread"] == 1
    assert (
        counts["updates"] == 3
    )  # update, read, snoozed (quiet, cleared and old left out)
    assert counts["snoozed"] == 2
    assert counts["oldest_needs_at"] is not None
    # the page's filters agree with the bell
    page = (
        await c.get("/notifications", params={"view": "page", "filter": "needs"})
    ).json()
    assert page["total"] == 3
    snoozed = (
        await c.get("/notifications", params={"view": "page", "filter": "snoozed"})
    ).json()
    assert sorted(r["title"] for r in snoozed["items"]) == [
        "snoozed",
        "snoozed update",
    ]
    # the panel's Needs you tab: open rows, the longest waiting first; then today's done row
    needs = (await _panel(c, "needs"))["items"]
    assert needs[0]["title"] == "open"
    assert needs[-1]["title"] == "done"
    assert "snoozed" not in [r["title"] for r in needs]


async def test_reconcile_checks_rows_that_cannot_close_by_themselves_in_bulk(
    env, monkeypatch
):
    c, pid, m, tid = await _setup(env)
    await _rows(
        env,
        *(
            _row(
                kind="blocked",
                ticket_id=tid,
                target_kind="ticket",
                target_id=tid,
                group_key=f"blocked:ticket:{i}",
                title=f"b{i}",
            )
            for i in range(30)
        ),
        _row(kind="offline", target_kind="member", target_id=m["id"], title="off"),
    )
    checked = []
    real = centre._why_closed

    async def spy(session, r):
        checked.append(r.kind)
        return await real(session, r)

    monkeypatch.setattr(centre, "_why_closed", spy)
    assert await centre.reconcile() == 0
    assert (
        checked == []
    )  # nothing can close them but Dismiss, or their ticket going away
    async with env["maker"]() as s:
        await s.delete(await s.get(Ticket, tid))
        await s.commit()
    await centre.reconcile()
    page = (await c.get("/notifications", params={"view": "page"})).json()["items"]
    gone = [r for r in page if r["gone"]]
    assert len(gone) == 30
    assert gone[0]["gone_reason"].startswith(f"{tid} was deleted")
    assert not next(r for r in page if r["title"] == "off")["gone"]
    # a row marked gone is not loaded again
    async with env["maker"]() as s:
        assert len(await centre._open_needs_groups(s)) == 1


async def test_dismissing_your_mention_leaves_the_others_mentions_open(env):
    c, pid, m, tid = await _setup(env)
    for key in ("user", "hoa mai"):
        await centre.emit(
            "mention",
            project_id=pid,
            recipients=[key],
            title="Lan mentioned you",
            target_kind="thread",
            target_id="th_1",
            actor="Lan",
        )
    [mine] = (await _panel(c, "needs"))["items"]
    r = await c.post(f"/notifications/{mine['id']}/dismiss")
    assert r.json()["done_text"] == "Dismissed by you"
    [hers] = (await _panel(c, "needs", {"X-Actor": "Hoa Mai"}))["items"]
    assert hers["done"] is False
    # shared work still closes for everyone it was addressed to
    await centre.emit(
        "run_failed",
        project_id=pid,
        recipients=["user", "hoa mai"],
        title="KAN-1 failed",
        target_kind="run",
        target_id="run_f",
        ticket_id=tid,
    )
    failed = next(
        r for r in (await _panel(c, "needs"))["items"] if r["kind"] == "run_failed"
    )
    await c.post(f"/notifications/{failed['id']}/dismiss")
    hers = next(
        r
        for r in (await _panel(c, "needs", {"X-Actor": "Hoa Mai"}))["items"]
        if r["kind"] == "run_failed"
    )
    assert hers["done_text"] == "Dismissed by user"


async def test_a_reassigned_question_closes_for_the_person_it_was_taken_from(env):
    c, pid, m, tid = await _setup(env)
    await c.post(f"/projects/{pid}/members", json={"name": "Hoa Mai"})
    lan = (await c.post(f"/projects/{pid}/members", json={"name": "Lan"})).json()
    run_id = await _run(
        env,
        pid,
        m["id"],
        tid,
        state="needs_input",
        started_by="user",
        question=json.dumps({"text": "Cursor or offset?", "to": "Hoa Mai"}),
    )
    await centre.on_run_question(run_id)
    hoa = {"X-Actor": "Hoa Mai"}
    assert len((await _panel(c, "needs", hoa))["items"]) == 1
    await runs.reassign_question(run_id, by="user", to_member_id=lan["id"])
    [hers] = (await _panel(c, "needs", hoa))["items"]
    assert hers["done"] is True
    assert hers["done_text"] == "Passed to Lan"
    [lans] = (await _panel(c, "needs", {"X-Actor": "Lan"}))["items"]
    assert lans["done"] is False
    [mine] = (await _panel(c, "needs"))["items"]  # the person the run acts for keeps it
    assert mine["done"] is False


async def test_sum_up_today_neither_replaces_nor_repeats_the_scheduled_card(env):
    c, pid, m, tid = await _setup(env)
    friday_17 = datetime(2026, 10, 30, 17, 0).astimezone().astimezone(UTC)
    friday_18 = datetime(2026, 10, 30, 18, 1).astimezone().astimezone(UTC)
    assert await centre.write_day_cards(friday_17, force_for="user") == 1
    assert (
        await centre.write_day_cards(friday_18) == 1
    )  # the scheduled card still comes
    assert await centre.write_day_cards(friday_18 + timedelta(minutes=1)) == 0
    assert (
        await centre.write_day_cards(
            friday_18 + timedelta(minutes=30), force_for="user"
        )
        == 1
    )
    # a card asked for after the card time does not bring the scheduled one back
    assert await centre.write_day_cards(friday_18 + timedelta(minutes=31)) == 0
    assert await centre.write_day_cards(friday_18 + timedelta(hours=2)) == 0
    async with env["maker"]() as s:
        cards = (
            await s.exec(
                select(Notification)
                .where(Notification.kind == "day_card")
                .order_by(Notification.event_id)
            )
        ).all()
    assert len(cards) == 3
    scheduled = cards[1]
    assert ":now:" not in scheduled.target_id
    # the scheduled card counts the whole day, not only the time since "Sum up today"
    midnight = datetime(2026, 10, 30).astimezone().astimezone(UTC)
    assert json.loads(scheduled.data)["since"] == midnight.isoformat()


async def test_retention_is_for_owners_and_admins_and_the_log_shows_your_own_events(
    env,
):
    c, pid, m, tid = await _setup(env)
    await c.post(
        f"/projects/{pid}/members", json={"name": "Ada Admin", "role": "admin"}
    )
    await c.post(f"/projects/{pid}/members", json={"name": "Hoa Mai"})
    hoa, ada = {"X-Actor": "Hoa Mai"}, {"X-Actor": "Ada Admin"}
    r = await c.patch(
        "/notifications/settings", json={"retention_days": 7}, headers=hoa
    )
    assert r.status_code == 403
    assert (await c.get("/notifications/settings", headers=hoa)).json()[
        "retention_editable"
    ] is False
    assert (await c.get("/notifications/settings")).json()["retention_days"] == 90
    # her own settings still save
    r = await c.patch("/notifications/settings", json={"sound": True}, headers=hoa)
    assert r.status_code == 200
    r = await c.patch(
        "/notifications/settings", json={"retention_days": 30}, headers=ada
    )
    assert r.status_code == 200
    assert r.json()["retention_editable"] is True
    ai = f"ai:{m['id']}"
    told_her = await centre.emit(
        "ai_finished", project_id="other", recipients=["hoa mai"], title="hers"
    )
    told_ai = await centre.emit(
        "ai_finished", project_id="other", recipients=[ai], title="the AI's"
    )
    in_project = await centre.emit(
        "question", project_id=pid, recipients=["user"], title="the project's"
    )
    elsewhere = await centre.emit(
        "question", project_id="other", recipients=["user"], title="elsewhere"
    )

    async def ids(headers=None, **params):
        log = await c.get("/notifications/log", params=params, headers=headers)
        return [e["id"] for e in log.json()["events"]]

    assert await ids() == [told_her, told_ai, in_project, elsewhere]
    assert await ids(hoa) == [told_her]
    assert await ids(ada) == [in_project]  # every event of the project she administers
    assert await ids({"X-Actor": ai}) == [told_ai]


def test_the_downgrade_keeps_followed_spaces_and_drops_muted_ones(tmp_path):
    import sqlite3

    from alembic import command
    from alembic.config import Config

    import database

    db_file = tmp_path / "k.db"
    cfg = Config(str(database._ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", f"sqlite+aiosqlite:///{db_file}")
    command.upgrade(cfg, "a1b2c3d4e5f7")
    conn = sqlite3.connect(db_file)
    try:
        for i, level in enumerate(("follow", "everything", "mute")):
            conn.execute(
                "INSERT INTO notify_follow (id, recipient, scope, scope_id, level, label, created_at) "
                "VALUES (?, ?, 'space', 'p1', ?, '', '2026-11-01')",
                (f"f{i}", f"person {level}", level),
            )
        conn.commit()
    finally:
        conn.close()
    command.downgrade(cfg, "fd73ce3d5800")
    conn = sqlite3.connect(db_file)
    try:
        followers = sorted(
            r[0] for r in conn.execute("SELECT follower FROM docs_follow")
        )
    finally:
        conn.close()
    assert followers == ["person everything", "person follow"]


async def test_mark_all_read_reads_only_what_the_page_lists(env):
    c, pid, m, tid = await _setup(env)
    await _rows(
        env,
        _row(title="here", project_id=pid),
        _row(kind="question", title="here, needs", project_id=pid),
        _row(title="elsewhere", project_id="other"),
        _row(kind="schedule", title="a schedule", project_id="other"),
    )

    async def unread():
        page = await c.get(
            "/notifications", params={"view": "page", "filter": "unread"}
        )
        return sorted(r["title"] for r in page.json()["items"])

    r = await c.post(
        "/notifications/read",
        json={"all": True, "project_id": pid, "filter": "needs"},
    )
    assert r.json()["read"] == 1
    assert await unread() == ["a schedule", "elsewhere", "here"]
    r = await c.post("/notifications/read", json={"all": True, "kind": ["schedule"]})
    assert r.json()["read"] == 1
    r = await c.post("/notifications/read", json={"all": True, "q": "else"})
    assert r.json()["read"] == 1
    assert await unread() == ["here"]
    bad = await c.post("/notifications/read", json={"all": True, "filter": "nope"})
    assert bad.status_code == 422
    r = await c.post("/notifications/read", json={"all": True})
    assert r.json()["read"] == 1
    assert await unread() == []
