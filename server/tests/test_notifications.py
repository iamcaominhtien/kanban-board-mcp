"""The notification centre (design/screens/notifications.md, docs/specs/notifications.md): the event log and its ids,
rows per recipient with read and done, closing itself when the work is done elsewhere, grouping, retention and the
cursor, follow and mute, the locked In app switch, the day card, and the old digest gone."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import select

from models import (
    AiAccount,
    AiApproval,
    AiRun,
    Notification,
    NotifyEvent,
    Ticket,
)
from services import notifications as centre
from services.ai import runs, safety
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401

ME = {}
ADA = {"X-Actor": "Ada Admin"}


async def _run(env, pid, member_id, tid, **fields) -> str:
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=member_id,
            state=fields.pop("state", "running"),
            **fields,
        )
        s.add(run)
        await s.commit()
        return run.id


async def _set(env, model, key, **fields):
    async with env["maker"]() as s:
        row = await s.get(model, key)
        for k, v in fields.items():
            setattr(row, k, v)
        s.add(row)
        await s.commit()


async def _panel(c, tab, headers=None):
    return (
        await c.get(
            "/notifications", params={"view": "panel", "tab": tab}, headers=headers
        )
    ).json()


async def _setup(env):
    c = env["c"]
    pid, an = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    return c, pid, m, tid


# --------------------------------------------------------------------------- the log


async def test_the_log_has_increasing_ids_and_a_row_per_recipient(env):
    c, pid, m, tid = await _setup(env)
    first = await centre.emit(
        "ai_finished",
        project_id=pid,
        recipients=["user", "hoa mai", f"ai:{m['id']}"],
        title="Dev finished KAN-1",
        ticket_id=tid,
    )
    second = await centre.emit(
        "question",
        project_id=pid,
        recipients=["user"],
        title="BA asks",
        target_kind="run",
        target_id="run_x",
    )
    assert second > first > 0
    log = (await c.get("/notifications/log", params={"since": 0})).json()
    assert [e["id"] for e in log["events"]] == [first, second]
    assert log["events"][0]["recipients"] == ["user", "hoa mai", f"ai:{m['id']}"]
    assert (await c.get("/notifications/log", params={"since": first})).json()[
        "events"
    ][0]["id"] == second
    # each recipient has their own row; an AI member is a recipient too (no screen shows its list in v1)
    async with env["maker"]() as s:
        rows = (
            await s.exec(select(Notification).where(Notification.event_id == first))
        ).all()
    assert sorted(r.recipient for r in rows) == sorted(
        ["user", "hoa mai", f"ai:{m['id']}"]
    )
    mine = (await c.get("/notifications", params={"view": "page"})).json()
    assert {r["kind"] for r in mine["items"]} == {"ai_finished", "question"}
    hers = (
        await c.get(
            "/notifications", params={"view": "page"}, headers={"X-Actor": "Hoa Mai"}
        )
    ).json()
    assert [r["kind"] for r in hers["items"]] == ["ai_finished"]


async def test_read_is_per_recipient_and_reading_is_not_resolving(env):
    c, pid, m, tid = await _setup(env)
    await centre.emit(
        "question",
        project_id=pid,
        recipients=["user", "hoa mai"],
        title="BA asks",
        target_kind="run",
        target_id="run_q",
    )
    [row] = (await _panel(c, "needs"))["items"]
    assert (await c.get("/notifications/counts")).json()["needs"] == 1
    await c.post("/notifications/read", json={"ids": [row["id"]]})
    [after] = (await _panel(c, "needs"))["items"]
    assert after["read"] is True
    assert after["done"] is False
    # the red count is open work, not unread rows
    assert (await c.get("/notifications/counts")).json()["needs"] == 1
    [hers] = (await _panel(c, "needs", {"X-Actor": "Hoa Mai"}))["items"]
    assert hers["read"] is False


# --------------------------------------------------------------------------- it closes itself


async def test_a_question_closes_itself_when_answered_anywhere(env):
    c, pid, m, tid = await _setup(env)
    run_id = await _run(
        env,
        pid,
        m["id"],
        tid,
        state="needs_input",
        question=json.dumps({"text": "Archived too?", "to": "user"}),
    )
    await centre.on_run_question(run_id)
    [row] = (await _panel(c, "needs"))["items"]
    assert row["kind"] == "question"
    assert row["title"].endswith("asks a question")
    assert [a["id"] for a in row["actions"]] == ["answer", "open_ticket"]
    assert row["dismissable"] is False
    head = (await c.get("/notifications/counts")).json()["head"]
    # answered in AI Team by someone else: the row closes for everyone, with who and where
    await _set(
        env,
        AiRun,
        run_id,
        state="running",
        question=json.dumps(
            {
                "text": "Archived too?",
                "answered_at": "x",
                "answered_by": "Hoa Mai",
                "answered_via": "ai_team",
            }
        ),
    )
    assert await centre.reconcile() == 1
    [row] = (await _panel(c, "needs"))["items"]
    assert row["done"]
    assert row["done_text"] == "Hoa Mai answered in AI Team"
    assert (await c.get("/notifications/counts")).json()["needs"] == 0
    feed = (await c.get("/notifications/feed", params={"since": head})).json()
    assert row["id"] in feed["resolved"]
    log = (await c.get("/notifications/log", params={"since": head})).json()["events"]
    assert [e["op"] for e in log] == ["resolve"]
    assert log[0]["target_id"] == run_id


async def test_answering_yourself_says_you(env):
    c, pid, m, tid = await _setup(env)
    run_id = await _run(
        env,
        pid,
        m["id"],
        tid,
        state="needs_input",
        question=json.dumps({"text": "?", "to": "user"}),
    )
    await centre.on_run_question(run_id)
    await _set(
        env,
        AiRun,
        run_id,
        state="running",
        question=json.dumps({"answered_at": "x", "answered_by": "user"}),
    )
    await centre.reconcile()
    [row] = (await _panel(c, "needs"))["items"]
    assert row["done_text"] == "You answered in the ticket"


async def test_an_approval_closes_when_decided_and_owners_get_every_safety_event(
    env,
):
    c, pid, m, tid = await _setup(env)
    await c.post(
        f"/projects/{pid}/members", json={"name": "Ada Admin", "role": "admin"}
    )
    await c.post(f"/projects/{pid}/members", json={"name": "Hoa Mai", "role": "member"})
    async with env["maker"]() as s:
        a = AiApproval(
            project_id=pid, member_id=m["id"], ticket_id=tid, action="change_assignee"
        )
        s.add(a)
        await s.commit()
        aid = a.id
    await safety.notify(
        pid,
        "approval_requested",
        "Approval needed",
        "Dev wants to change an assignee",
        ref_kind="approval",
        ref_id=aid,
        member_id=m["id"],
    )
    assert len((await _panel(c, "needs"))["items"]) == 1
    assert len((await _panel(c, "needs", ADA))["items"]) == 1  # an admin
    assert (await _panel(c, "needs", {"X-Actor": "Hoa Mai"}))["items"] == []
    await _set(env, AiApproval, aid, status="approved", decided_by="Ada Admin")
    await centre.reconcile()
    [mine] = (await _panel(c, "needs"))["items"]
    [hers] = (await _panel(c, "needs", ADA))["items"]
    assert mine["done_text"] == "Ada Admin approved it"
    assert hers["done_text"] == "You approved it"


async def test_a_deleted_ticket_makes_the_row_say_so_and_offer_only_dismiss(env):
    c, pid, m, tid = await _setup(env)
    run_id = await _run(
        env, pid, m["id"], tid, state="needs_input", question=json.dumps({"text": "?"})
    )
    await centre.on_run_question(run_id)
    async with env["maker"]() as s:
        await s.delete(await s.get(Ticket, tid))
        await s.commit()
    await centre.reconcile()
    [row] = (await _panel(c, "needs"))["items"]
    assert row["gone"]
    assert row["gone_reason"].startswith(f"{tid} was deleted")
    assert [a["id"] for a in row["actions"]] == ["dismiss"]
    r = await c.post(f"/notifications/{row['id']}/dismiss")
    assert r.status_code == 200
    assert r.json()["done_text"] == "Dismissed by you"
    assert (await c.get("/notifications/counts")).json()["needs"] == 0


async def test_a_failed_run_is_retried_and_failures_of_one_ticket_are_one_row(env):
    c, pid, m, tid = await _setup(env)
    for n in (1, 2):
        rid = await _run(
            env, pid, m["id"], tid, state="failed", number=n, ended_reason=f"exit {n}"
        )
        await _set(env, AiRun, rid, ended_at=datetime.now(UTC).isoformat())
        await centre.on_run_ended(rid)
    [row] = (await _panel(c, "needs"))["items"]
    assert row["count"] == 2
    assert row["title"] == f"Run #2 on {tid} failed"
    assert [a["id"] for a in row["actions"]] == ["retry", "open_run_log"]
    await _run(env, pid, m["id"], tid, state="queued", number=3, trigger="retry")
    await centre.reconcile()
    [row] = (await _panel(c, "needs"))["items"]
    assert row["done_text"] == "You retried: run #3 started"


async def test_an_account_signing_out_is_one_row_and_closes_when_it_signs_in(env):
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
    await centre.reconcile()  # once per account, not per check
    [row] = (await _panel(c, "needs"))["items"]
    assert row["kind"] == "account_signed_out"
    assert row["title"] == "Work Claude is signed out"
    assert [a["id"] for a in row["actions"]] == ["sign_in"]
    await _set(env, AiAccount, acc_id, status="signed_in")
    await centre.reconcile()
    [row] = (await _panel(c, "needs"))["items"]
    assert row["done_text"] == "The account signed in again"


# --------------------------------------------------------------------------- grouping


async def test_eight_ai_finishing_at_once_are_one_row(env):
    c, pid, m, tid = await _setup(env)
    names = ["Rin", "Dev Gem", "Dev An", "QA Quy", "QA Quy", "Rin", "Dev An", "BA Bao"]
    for i, who in enumerate(names):
        await centre.emit(
            "ai_finished",
            project_id=pid,
            recipients=["user"],
            title=f"{who} finished AGT-{13 + i}",
            ticket_id=f"AGT-{13 + i}",
            actor=who,
        )
    items = (await _panel(c, "updates"))["items"]
    assert len(items) == 1
    row = items[0]
    assert row["title"] == "8 AI finished work"
    assert row["count"] == 8
    assert row["body"] == "Rin, Dev Gem, Dev An, QA Quy and 1 more · AGT-13 to AGT-20"
    assert len(row["items"]) == 8
    assert row["actions"][0]["label"] == "Show all 8"
    # never interrupts: no Needs you, a blue dot
    counts = (await c.get("/notifications/counts")).json()
    assert counts["needs"] == 0
    assert counts["updates_unread"] == 1


async def test_more_than_twenty_say_twenty_plus_and_another_project_is_its_own_row(env):
    c, pid, m, tid = await _setup(env)
    for i in range(23):
        await centre.emit(
            "ai_finished",
            project_id=pid,
            recipients=["user"],
            title="x",
            ticket_id=f"AGT-{i}",
            actor=f"AI {i}",
        )
    await centre.emit(
        "ai_finished", project_id="other", recipients=["user"], title="y", actor="Z"
    )
    rows = (await _panel(c, "updates"))["items"]
    assert sorted(r["title"] for r in rows) == ["20+ AI finished work", "y"]


async def test_a_group_closes_after_ten_minutes(env):
    c, pid, m, tid = await _setup(env)
    await centre.emit("ai_finished", project_id=pid, recipients=["user"], title="a")
    async with env["maker"]() as s:
        [row] = (await s.exec(select(Notification))).all()
        row.created_at = (datetime.now(UTC) - timedelta(minutes=11)).isoformat()
        s.add(row)
        await s.commit()
    await centre.emit("ai_finished", project_id=pid, recipients=["user"], title="b")
    assert len((await _panel(c, "updates"))["items"]) == 2


# --------------------------------------------------------------------------- snooze, clear


async def test_snooze_hides_and_brings_back_and_clearing_is_a_state(env):
    c, pid, m, tid = await _setup(env)
    await centre.emit(
        "blocked", project_id=pid, recipients=["user"], title="Blocked", ticket_id=tid
    )
    await centre.emit("page_published", project_id=pid, recipients=["user"], title="v2")
    [needs] = (await _panel(c, "needs"))["items"]
    until = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    r = await c.post(f"/notifications/{needs['id']}/snooze", json={"until": until})
    assert r.json()["snoozed"] is True
    assert (await _panel(c, "needs"))["items"] == []
    counts = (await c.get("/notifications/counts")).json()
    assert counts["needs"] == 0
    assert counts["snoozed"] == 1
    page = (
        await c.get("/notifications", params={"view": "page", "filter": "snoozed"})
    ).json()
    assert [r["id"] for r in page["items"]] == [needs["id"]]
    await c.post(f"/notifications/{needs['id']}/snooze", json={"until": None})
    assert len((await _panel(c, "needs"))["items"]) == 1
    # an open Needs you row is not cleared; an update is, and stays under Cleared
    assert (await c.post(f"/notifications/{needs['id']}/clear")).status_code == 409
    [upd] = (await _panel(c, "updates"))["items"]
    await c.post(f"/notifications/{upd['id']}/clear")
    assert (await _panel(c, "updates"))["items"] == []
    cleared = (
        await c.get("/notifications", params={"view": "page", "filter": "cleared"})
    ).json()
    assert [r["id"] for r in cleared["items"]] == [upd["id"]]


async def test_a_question_cannot_be_dismissed(env):
    c, pid, m, tid = await _setup(env)
    run_id = await _run(
        env, pid, m["id"], tid, state="needs_input", question=json.dumps({"text": "?"})
    )
    await centre.on_run_question(run_id)
    [row] = (await _panel(c, "needs"))["items"]
    assert (await c.post(f"/notifications/{row['id']}/dismiss")).status_code == 409


# --------------------------------------------------------------------------- settings, follow, mute


async def test_in_app_is_locked_on_for_needs_you_and_off_means_quiet(env):
    c, pid, m, tid = await _setup(env)
    s = (await c.get("/notifications/settings")).json()
    q = next(e for e in s["events"] if e["kind"] == "question")
    assert q["inapp"]
    assert q["inapp_locked"]
    assert q["desktop"]
    finished = next(e for e in s["events"] if e["kind"] == "ai_finished")
    assert not finished["inapp_locked"]
    assert not finished["desktop"]
    r = await c.patch(
        "/notifications/settings",
        json={"events": [{"kind": "question", "inapp": False}]},
    )
    assert r.status_code == 422
    assert "In app stays on" in r.json()["detail"]
    r = await c.patch(
        "/notifications/settings",
        json={
            "events": [{"kind": "ai_finished", "inapp": False}],
            "retention_days": 30,
        },
    )
    assert r.status_code == 200
    assert r.json()["retention_days"] == 30
    await centre.emit("ai_finished", project_id=pid, recipients=["user"], title="quiet")
    # quiet, not unrecorded: not in the panel, still on the page
    assert (await _panel(c, "updates"))["items"] == []
    page = (await c.get("/notifications", params={"view": "page"})).json()["items"]
    assert [r["title"] for r in page] == ["quiet"]
    assert page[0]["inapp"] is False


async def test_muting_a_ticket_quiets_updates_but_never_a_needs_you_row(env):
    c, pid, m, tid = await _setup(env)
    r = await c.put(
        "/notifications/follow",
        json={"scope": "ticket", "scope_id": tid, "level": "mute"},
    )
    assert r.json()["level"] == "mute"
    await centre.emit(
        "ai_finished", project_id=pid, recipients=["user"], title="done", ticket_id=tid
    )
    await centre.emit(
        "question",
        project_id=pid,
        recipients=["user"],
        title="asks",
        ticket_id=tid,
        target_kind="run",
        target_id="r1",
    )
    assert (await _panel(c, "updates"))["items"] == []
    assert len((await _panel(c, "needs"))["items"]) == 1
    muted = (await c.get("/notifications/settings")).json()["muted"]
    assert [x["label"] for x in muted] == [tid]
    await c.delete(f"/notifications/follow/{muted[0]['id']}")
    assert (await c.get("/notifications/settings")).json()["muted"] == []


async def test_following_a_ticket_brings_its_finished_runs(env):
    c, pid, m, tid = await _setup(env)
    await c.put(
        "/notifications/follow",
        json={"scope": "ticket", "scope_id": tid, "level": "follow"},
        headers={"X-Actor": "Hoa Mai"},
    )
    rid = await _run(env, pid, m["id"], tid, state="finished", summary="Fixed add().")
    await centre.on_run_ended(rid)
    [row] = (await _panel(c, "updates", {"X-Actor": "Hoa Mai"}))["items"]
    assert row["kind"] == "ai_finished"
    assert row["body"] == "Fixed add()."


async def test_the_docs_space_follow_is_one_case_of_following(env):
    c, pid, m, tid = await _setup(env)
    r = await c.put(f"/projects/{pid}/docs/follow", json={"on": True})
    assert r.json()["following"] is True
    state = (
        await c.get("/notifications/follow", params={"scope": "space", "scope_id": pid})
    ).json()
    assert state["level"] == "follow"
    await centre.on_page_published(
        {
            "id": "pg1",
            "project_id": pid,
            "title": "API",
            "version": 14,
            "updated_by": "Hoa Mai",
        },
        "Rate limits rewritten.",
    )
    [row] = (await _panel(c, "updates"))["items"]
    assert row["title"] == "Hoa Mai published v14 of API"
    # your own publish does not tell you
    await centre.on_page_published(
        {
            "id": "pg1",
            "project_id": pid,
            "title": "API",
            "version": 15,
            "updated_by": "user",
        }
    )
    assert (await _panel(c, "updates"))["items"][0]["count"] == 1


# --------------------------------------------------------------------------- feed, retention, day card


async def test_the_feed_starts_at_head_and_a_pruned_cursor_is_too_old(env):
    c, pid, m, tid = await _setup(env)
    await centre.emit("ai_finished", project_id=pid, recipients=["user"], title="old")
    first = (await c.get("/notifications/feed")).json()
    assert first["items"] == []  # no replay
    assert first["cursor_too_old"] is False
    head = first["head"]
    assert head > 0
    await centre.emit(
        "question",
        project_id=pid,
        recipients=["user"],
        title="?",
        target_kind="run",
        target_id="r",
    )
    feed = (await c.get("/notifications/feed", params={"since": head})).json()
    assert [r["kind"] for r in feed["items"]] == ["question"]
    assert feed["head"] > head
    # everything older than the retention goes, rows and log; an old cursor is told so
    async with env["maker"]() as s:
        for e in (await s.exec(select(NotifyEvent))).all():
            e.created_at = (datetime.now(UTC) - timedelta(days=100)).isoformat()
            s.add(e)
        for r in (await s.exec(select(Notification))).all():
            r.updated_at = (datetime.now(UTC) - timedelta(days=100)).isoformat()
            s.add(r)
        await s.commit()
    await centre.prune()
    old = (await c.get("/notifications/feed", params={"since": head})).json()
    assert old["cursor_too_old"] is True
    log = (await c.get("/notifications/log", params={"since": head})).json()
    assert log["cursor_too_old"] is True
    # the update is gone; the question still waits, so its row stays (retention never drops open work)
    kept = (await c.get("/notifications", params={"view": "page"})).json()["items"]
    assert [r["kind"] for r in kept] == ["question"]
    # ids are never reused after a prune
    new = await centre.emit(
        "ai_finished", project_id=pid, recipients=["user"], title="z"
    )
    assert new > feed["head"]


async def test_the_day_card_counts_the_day_and_says_a_quiet_day(env):
    c, pid, m, tid = await _setup(env)
    r = await c.post("/notifications/day-card")
    assert r.json()["written"] == 1
    card = (await c.get("/notifications/day-card")).json()["card"]
    assert card["kind"] == "day_card"
    assert card["title"] == "Today on your boards"
    assert card["data"]["quiet"] is True
    assert card["data"]["lines"][0]["text"].startswith("A quiet day")
    # with runs and something waiting
    now = datetime.now(UTC).isoformat()
    ok = await _run(env, pid, m["id"], tid, state="finished", number=1)
    bad = await _run(
        env, pid, m["id"], tid, state="failed", number=2, ended_reason="CLI exit 1"
    )
    for rid, cost in ((ok, 1.2), (bad, 0.64)):
        await _set(env, AiRun, rid, ended_at=now, cost_usd=cost)
    await centre.emit(
        "question",
        project_id=pid,
        recipients=["user"],
        title="BA asks",
        target_kind="run",
        target_id="rq",
        actor="BA Bao",
        ticket_id=tid,
    )
    await c.post("/notifications/day-card")
    data = (await c.get("/notifications/day-card")).json()["card"]["data"]
    assert (data["finished"], data["failed"], data["waiting"], data["spent"]) == (
        1,
        1,
        1,
        1.84,
    )
    texts = " ".join(line["text"] for line in data["lines"])
    assert "1 run failed" in texts
    assert "1 still wait for you" in texts
    # the card is the first row of the panel, not one of the rows
    panel = await _panel(c, "updates")
    assert panel["day_card"]["kind"] == "day_card"
    assert all(r["kind"] != "day_card" for r in panel["items"])


async def test_day_cards_are_written_once_at_the_card_time(env):
    c, pid, m, tid = await _setup(env)
    friday_17 = datetime(2026, 10, 30, 17, 0).astimezone()
    assert await centre.write_day_cards(friday_17.astimezone(UTC)) == 0
    friday_18 = datetime(2026, 10, 30, 18, 1).astimezone()
    assert await centre.write_day_cards(friday_18.astimezone(UTC)) == 1
    assert await centre.write_day_cards(friday_18.astimezone(UTC)) == 0
    saturday = datetime(2026, 10, 31, 18, 30).astimezone()
    assert await centre.write_day_cards(saturday.astimezone(UTC)) == 0  # weekdays only
    await c.patch(
        "/notifications/settings", json={"day_card": {"days": [5], "time": "18:15"}}
    )
    assert await centre.write_day_cards(saturday.astimezone(UTC)) == 1


async def test_the_old_digest_settings_are_gone(env):
    c, pid, m, tid = await _setup(env)
    s = (await c.get(f"/projects/{pid}/ai/settings")).json()
    assert "digest" not in s
    assert "notify" not in s
    assert not hasattr(safety, "release_digest")


@pytest.mark.parametrize("name", ["", "user", "You", " USER "])
def test_the_board_user_is_one_recipient(name):
    assert centre.person_key(name) == "user"


async def test_a_run_ending_writes_through_the_real_end(env):
    c, pid, m, tid = await _setup(env)
    rid = await _run(env, pid, m["id"], tid, state="running", number=1)
    await runs._end(rid, "failed", "The CLI exited with code 1 at step 12.")
    [row] = (await _panel(c, "needs"))["items"]
    assert row["kind"] == "run_failed"
    assert "code 1" in row["body"]


async def test_the_desktop_master_switch_keeps_the_per_kind_choices(env):
    c, pid, m, tid = await _setup(env)
    r = (await c.patch("/notifications/settings", json={"desktop_on": False})).json()
    assert r["desktop_on"] is False
    assert next(e for e in r["events"] if e["kind"] == "question")["desktop"] is True
    await centre.emit(
        "question",
        project_id=pid,
        recipients=["user"],
        title="?",
        target_kind="run",
        target_id="r",
    )
    [row] = (await _panel(c, "needs"))["items"]
    assert row["desktop"] is False
    assert row["inapp"] is True


async def test_pause_all_is_one_row_per_project_and_closes_on_resume(env):
    c, pid, m, tid = await _setup(env)
    other, _ = await _project_b(c)
    await safety.notify(pid, "auto_trip", "AI is paused", "user paused all AI.")
    await safety.notify(other, "auto_trip", "AI is paused", "user paused all AI.")
    rows = (await _panel(c, "needs"))["items"]
    assert sorted(r["project_id"] for r in rows) == sorted([pid, other])
    async with env["maker"]() as s:
        from models import AiProjectSettings

        for p_ in (pid, other):
            st = await s.get(AiProjectSettings, p_) or AiProjectSettings(project_id=p_)
            st.paused_all = (
                p_ == other
            )  # the first project resumed, the other is still paused
            s.add(st)
        await s.commit()
    await centre.reconcile()
    rows = {r["project_id"]: r for r in (await _panel(c, "needs"))["items"]}
    assert rows[pid]["done_text"] == "AI was resumed"
    assert not rows[other]["done"]


async def _project_b(c):
    p = (
        await c.post(
            "/projects",
            json={"name": "Mobile App", "prefix": "MOB", "color": "#3A6EA5"},
        )
    ).json()
    return p["id"], None


async def test_a_reply_closes_only_the_mention_of_who_replied(env):
    from models import DocsComment, DocsCommentThread, DocsPage

    c, pid, m, tid = await _setup(env)
    async with env["maker"]() as s:
        page = DocsPage(project_id=pid, title="API", slug="api")
        s.add(page)
        await s.flush()
        th = DocsCommentThread(page_id=page.id)
        s.add(th)
        await s.commit()
        thread_id = th.id
    for who in ("user", "hoa mai"):
        await centre.emit(
            "mention",
            project_id=pid,
            recipients=[who],
            title="Rin mentioned you",
            target_kind="thread",
            target_id=thread_id,
        )
    async with env["maker"]() as s:
        s.add(DocsComment(thread_id=thread_id, author="Hoa Mai", body="Done."))
        await s.commit()
    await centre.reconcile()
    [mine] = (await _panel(c, "needs"))["items"]
    [hers] = (await _panel(c, "needs", {"X-Actor": "Hoa Mai"}))["items"]
    assert not mine["done"]
    assert hers["done_text"] == "You replied"


async def test_an_ask_run_does_not_count_as_a_retry(env):
    c, pid, m, tid = await _setup(env)
    rid = await _run(env, pid, m["id"], tid, state="failed", number=1)
    await _set(env, AiRun, rid, ended_at=datetime.now(UTC).isoformat())
    await centre.on_run_ended(rid)
    await _run(env, pid, m["id"], tid, state="finished", number=2, mode="ask")
    await centre.reconcile()
    [row] = (await _panel(c, "needs"))["items"]
    assert not row["done"]


async def test_a_cursor_above_the_head_is_too_old(env):
    c, pid, m, tid = await _setup(env)
    await centre.emit("ai_finished", project_id=pid, recipients=["user"], title="a")
    feed = (await c.get("/notifications/feed", params={"since": 999})).json()
    assert feed["cursor_too_old"] is True
    assert feed["head"] >= 1


# --------------------------------------------------------------------------- the rest of the writers and readers


async def test_a_scheduled_slot_is_written_by_the_loop_and_points_at_its_run(env):
    from models import AiSchedule, AiScheduleRun

    c, pid, m, tid = await _setup(env)
    rid = await _run(env, pid, m["id"], tid, state="failed", number=1)
    async with env["maker"]() as s:
        sch = AiSchedule(project_id=pid, ticket_id=tid, member_id=m["id"])
        s.add(sch)
        await s.flush()
        srun = AiScheduleRun(
            schedule_id=sch.id,
            project_id=pid,
            ticket_id=tid,
            slot_at="2026-11-01T02:00:00+00:00",
            run_ids=json.dumps([rid]),
        )
        s.add(srun)
        await s.commit()
        srun_id = srun.id
    centre.enqueue(
        "run_failed",
        project_id=pid,
        names=["user"],
        title=f"{tid} scheduled run failed: checks failed",
        target_kind="schedule_run",
        target_id=srun_id,
        ticket_id=tid,
    )
    centre.enqueue(
        "schedule",
        project_id=pid,
        names=["Hoa Mai"],
        title=f"{tid} scheduled run passed",
        ticket_id=tid,
    )
    assert await centre.flush_pending() == 2
    [row] = (await _panel(c, "needs"))["items"]
    assert row["target_kind"] == "run"
    assert row["target_id"] == rid
    assert row["data"]["srun_id"] == srun_id
    [upd] = (await _panel(c, "updates", {"X-Actor": "Hoa Mai"}))["items"]
    assert upd["kind"] == "schedule"


async def test_comment_events_make_mentions_and_replies(env):
    c, pid, m, tid = await _setup(env)
    base = dict(
        project_id=pid,
        page_id=None,
        thread_id="th1",
        comment_id="cm1",
        actor="Tuan Vo",
        page_title="Login redesign",
        snippet="Agreed, let us keep the error in the field.",
    )
    await centre.on_comment_event(
        {
            **base,
            "kind": "reply",
            "mentioned": json.dumps(["Hoa Mai"]),
            "recipients": json.dumps(["Hoa Mai", "user"]),
        }
    )
    await centre.on_comment_event(
        {
            **base,
            "kind": "resolved",
            "mentioned": "[]",
            "recipients": json.dumps(["user"]),
        }
    )
    await centre.on_comment_event(
        {
            **base,
            "thread_id": None,
            "kind": "access_request",
            "mentioned": "[]",
            "recipients": json.dumps(["user"]),
        }
    )
    [hers] = (await _panel(c, "needs", {"X-Actor": "Hoa Mai"}))["items"]
    assert hers["kind"] == "mention"
    assert hers["title"] == "Tuan Vo mentioned you"
    mine = (await _panel(c, "updates"))["items"]
    assert sorted(r["kind"] for r in mine) == ["access_request", "comment"]
    comment = next(r for r in mine if r["kind"] == "comment")
    assert comment["count"] == 2  # the reply and the resolve, one row
    # a person's own event does not tell them
    await centre.on_comment_event(
        {
            **base,
            "actor": "Hoa Mai",
            "kind": "reply",
            "mentioned": "[]",
            "recipients": json.dumps(["Hoa Mai"]),
        }
    )
    assert len((await _panel(c, "updates", {"X-Actor": "Hoa Mai"}))["items"]) == 0


async def test_a_blocked_move_and_an_archived_run(env):
    c, pid, m, tid = await _setup(env)
    rid = await _run(env, pid, m["id"], tid, state="running", number=1)
    await centre.on_blocked_move(rid, "done")
    [row] = (await _panel(c, "needs"))["items"]
    assert row["kind"] == "blocked"
    assert row["title"].endswith(f"move {tid} to Done")
    assert [a["id"] for a in row["actions"]] == ["open_ticket", "change_permission"]
    assert row["dismissable"] is True
    gone = await _run(
        env, pid, m["id"], tid, state="cancelled", number=2, stop_code="archive"
    )
    await _set(env, AiRun, gone, ended_by="Hoa Mai")
    await centre.on_run_ended(gone)
    [upd] = (await _panel(c, "updates"))["items"]
    assert upd["kind"] == "run_cancelled"
    assert upd["title"] == f"{tid} was archived by Hoa Mai"
    # nothing for a run that does not exist
    await centre.on_run_ended("run_missing")
    await centre.on_blocked_move("run_missing", "done")
    await centre.on_run_question("run_missing")


async def test_filters_search_opened_and_clear_read(env):
    c, pid, m, tid = await _setup(env)
    await centre.emit(
        "ai_finished",
        project_id=pid,
        recipients=["user"],
        title=f"Dev finished {tid}",
        ticket_id=tid,
        member_id=m["id"],
    )
    await centre.emit(
        "schedule", project_id=pid, recipients=["user"], title="Nightly check"
    )
    await centre.emit(
        "comment", project_id="other", recipients=["user"], title="New reply"
    )
    page = lambda **p: c.get("/notifications", params={"view": "page", **p})  # noqa: E731
    assert [r["title"] for r in (await page(q="nightly")).json()["items"]] == [
        "Nightly check"
    ]
    assert [r["kind"] for r in (await page(family="ai")).json()["items"]] == [
        "ai_finished"
    ]
    assert [r["kind"] for r in (await page(family="schedules")).json()["items"]] == [
        "schedule"
    ]
    assert {r["kind"] for r in (await page(family="people")).json()["items"]} == {
        "schedule",
        "comment",
    }
    assert len((await page(project_id=pid)).json()["items"]) == 2
    assert [r["kind"] for r in (await page(kind="comment")).json()["items"]] == [
        "comment"
    ]
    assert len((await page(filter="unread")).json()["items"]) == 3
    assert (await c.get("/notifications", params={"filter": "nope"})).status_code == 422
    # opening the ticket reads its row (not done)
    r = await c.post(
        "/notifications/opened", json={"target_kind": "ticket", "target_id": tid}
    )
    assert r.json()["read"] == 1
    assert (await c.get("/notifications/counts")).json()["unread"] == 2
    await c.post("/notifications/read", json={"all": True, "tab": "updates"})
    assert (await c.post("/notifications/clear-read")).json()["cleared"] == 3
    assert (await _panel(c, "updates"))["items"] == []
    # put one back
    cleared = (await page(filter="cleared")).json()["items"]
    r = await c.post(f"/notifications/{cleared[0]['id']}/clear", json={"on": False})
    assert r.json()["cleared"] is False


async def test_errors_of_the_api(env):
    c, pid, m, tid = await _setup(env)
    assert (await c.post("/notifications/nt_x/dismiss")).status_code == 404
    assert (
        await c.post("/notifications/nt_x/snooze", json={"until": None})
    ).status_code == 404
    assert (await c.post("/notifications/nt_x/clear")).status_code == 404
    assert (await c.delete("/notifications/follow/nope")).status_code == 404
    bad = await c.put(
        "/notifications/follow",
        json={"scope": "planet", "scope_id": "x", "level": "mute"},
    )
    assert bad.status_code == 422
    bad = await c.put(
        "/notifications/follow",
        json={"scope": "kind", "scope_id": "nope", "level": "mute"},
    )
    assert bad.status_code == 422
    for body in (
        {"events": [{"kind": "nope"}]},
        {"retention_days": 0},
    ):
        assert (await c.patch("/notifications/settings", json=body)).status_code == 422
    await centre.emit("ai_finished", project_id=pid, recipients=["user"], title="u")
    [row] = (await _panel(c, "updates"))["items"]
    assert (await c.post(f"/notifications/{row['id']}/dismiss")).status_code == 409
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    r = await c.post(f"/notifications/{row['id']}/snooze", json={"until": past})
    assert r.status_code == 422


async def test_settings_parts_and_mutes_of_a_project_and_a_kind(env):
    c, pid, m, tid = await _setup(env)
    r = await c.patch(
        "/notifications/settings",
        json={
            "quiet": {"on": True, "start": "00:00", "end": "23:59"},
            "dnd": False,
            "sound": True,
            "day_card": {"on": False, "time": "17:30", "days": [4, 0]},
            "events": [{"kind": "ai_finished", "desktop": True}],
        },
    )
    s = r.json()
    assert s["quiet"] == {"on": True, "start": "00:00", "end": "23:59"}
    assert s["dnd"] is False
    assert s["sound"] is True
    assert s["day_card"] == {"on": False, "time": "17:30", "days": [0, 4]}
    assert next(e for e in s["events"] if e["kind"] == "ai_finished")["desktop"]
    feed = (await c.get("/notifications/feed", params={"since": 0})).json()
    assert feed["quiet"] is True
    assert feed["sound"] is True
    # a kind muted in one project, then the whole project
    await c.put(
        "/notifications/follow",
        json={
            "scope": "kind",
            "scope_id": "schedule",
            "level": "mute",
            "project_id": pid,
        },
    )
    await c.put(
        "/notifications/follow",
        json={"scope": "project", "scope_id": pid, "level": "mute", "minutes": 60},
    )
    labels = sorted(
        x["label"] for x in (await c.get("/notifications/settings")).json()["muted"]
    )
    assert labels == [
        "A scheduled run finished or was skipped, in Kanban Board",
        "Kanban Board",
    ]
    await centre.emit("schedule", project_id=pid, recipients=["user"], title="s")
    await centre.emit(
        "blocked",
        project_id=pid,
        recipients=["user"],
        title="b",
        target_kind="x",
        target_id="1",
    )
    assert (await _panel(c, "updates"))["items"] == []
    assert len((await _panel(c, "needs"))["items"]) == 1
    # forgetting a follow
    r = await c.put(
        "/notifications/follow",
        json={"scope": "project", "scope_id": pid, "level": None},
    )
    assert r.json()["level"] is None


async def test_the_raw_log_by_project_and_resolve_target(env):
    c, pid, m, tid = await _setup(env)
    await centre.emit(
        "question",
        project_id=pid,
        recipients=["user", "hoa mai"],
        title="?",
        target_kind="approval",
        target_id="apr_x",
    )
    await centre.emit("ai_finished", project_id="other", recipients=["user"], title="o")
    log = (await c.get("/notifications/log", params={"project_id": pid})).json()
    assert [e["kind"] for e in log["events"]] == ["question"]
    assert (
        await centre.resolve_target(
            "approval", "apr_x", "{who} approved it", by="Hoa Mai"
        )
        == 2
    )
    [row] = (await _panel(c, "needs"))["items"]
    assert row["done_text"] == "Hoa Mai approved it"
    day = (await c.get("/notifications/day-card", params={"preview": True})).json()
    assert day["card"] is None
    assert "finished" in day["preview"]


async def test_the_loop_starts_reconciles_and_stops(env):
    c, pid, m, tid = await _setup(env)
    import asyncio

    centre.start()
    try:
        centre.enqueue("ai_finished", project_id=pid, names=["user"], title="loop")
        for _ in range(40):
            await asyncio.sleep(0.1)
            if (await _panel(c, "updates"))["items"]:
                break
        assert [r["title"] for r in (await _panel(c, "updates"))["items"]] == ["loop"]
    finally:
        await centre.stop()
    assert centre._task is None
