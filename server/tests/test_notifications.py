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
    assert after["read"] is True and after["done"] is False
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
    assert row["kind"] == "question" and row["title"].endswith("asks a question")
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
    assert row["done"] and row["done_text"] == "Hoa Mai answered in AI Team"
    assert (await c.get("/notifications/counts")).json()["needs"] == 0
    feed = (await c.get("/notifications/feed", params={"since": head})).json()
    assert row["id"] in feed["resolved"]
    log = (await c.get("/notifications/log", params={"since": head})).json()["events"]
    assert [e["op"] for e in log] == ["resolve"] and log[0]["target_id"] == run_id


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
    assert row["gone"] and row["gone_reason"].startswith(f"{tid} was deleted")
    assert [a["id"] for a in row["actions"]] == ["dismiss"]
    r = await c.post(f"/notifications/{row['id']}/dismiss")
    assert r.status_code == 200 and r.json()["done_text"] == "Dismissed by you"
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
    assert row["count"] == 2 and row["title"] == f"Run #2 on {tid} failed"
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
    assert (
        row["kind"] == "account_signed_out"
        and row["title"] == "Work Claude is signed out"
    )
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
    assert row["title"] == "8 AI finished work" and row["count"] == 8
    assert row["body"] == "Rin, Dev Gem, Dev An, QA Quy and 1 more · AGT-13 to AGT-20"
    assert len(row["items"]) == 8 and row["actions"][0]["label"] == "Show all 8"
    # never interrupts: no Needs you, a blue dot
    counts = (await c.get("/notifications/counts")).json()
    assert counts["needs"] == 0 and counts["updates_unread"] == 1


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
    assert counts["needs"] == 0 and counts["snoozed"] == 1
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
    assert q["inapp"] and q["inapp_locked"] and q["desktop"]
    finished = next(e for e in s["events"] if e["kind"] == "ai_finished")
    assert not finished["inapp_locked"] and not finished["desktop"]
    r = await c.patch(
        "/notifications/settings",
        json={"events": [{"kind": "question", "inapp": False}]},
    )
    assert r.status_code == 422 and "In app stays on" in r.json()["detail"]
    r = await c.patch(
        "/notifications/settings",
        json={
            "events": [{"kind": "ai_finished", "inapp": False}],
            "retention_days": 30,
        },
    )
    assert r.status_code == 200 and r.json()["retention_days"] == 30
    await centre.emit("ai_finished", project_id=pid, recipients=["user"], title="quiet")
    # quiet, not unrecorded: not in the panel, still on the page
    assert (await _panel(c, "updates"))["items"] == []
    page = (await c.get("/notifications", params={"view": "page"})).json()["items"]
    assert [r["title"] for r in page] == ["quiet"] and page[0]["inapp"] is False


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
    assert row["kind"] == "ai_finished" and row["body"] == "Fixed add()."


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
    assert first["items"] == [] and first["cursor_too_old"] is False  # no replay
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
    assert [r["kind"] for r in feed["items"]] == ["question"] and feed["head"] > head
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
    assert (await c.get("/notifications", params={"view": "page"})).json()[
        "items"
    ] == []
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
    assert card["kind"] == "day_card" and card["title"] == "Today on your boards"
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
    assert "1 run failed" in texts and "1 still wait for you" in texts
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
    await c.patch("/notifications/settings", json={"day_card": {"days": [5], "time": "18:15"}})
    assert await centre.write_day_cards(saturday.astimezone(UTC)) == 1


async def test_the_old_digest_settings_are_gone(env):
    c, pid, m, tid = await _setup(env)
    s = (await c.get(f"/projects/{pid}/ai/settings")).json()
    assert "digest" not in s and "notify" not in s
    assert not hasattr(safety, "release_digest")


@pytest.mark.parametrize("name", ["", "user", "You", " USER "])
def test_the_board_user_is_one_recipient(name):
    assert centre.person_key(name) == "user"


async def test_a_run_ending_writes_through_the_real_end(env):
    c, pid, m, tid = await _setup(env)
    rid = await _run(env, pid, m["id"], tid, state="running", number=1)
    await runs._end(rid, "failed", "The CLI exited with code 1 at step 12.")
    [row] = (await _panel(c, "needs"))["items"]
    assert row["kind"] == "run_failed" and "code 1" in row["body"]
