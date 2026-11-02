"""#270: a sound that can be chosen, and a Needs you that stays unanswered reminds once after the time the person set."""

from datetime import UTC, datetime, timedelta

import pytest

from models import Notification
from services import notifications as centre
from tests.test_notifications import _panel, _run, _set, _setup
from tests.test_ai import env  # noqa: F401


async def _no_quiet_hours(c) -> None:
    await c.patch("/notifications/settings", json={"quiet": {"on": False}})


def _ago(minutes: float) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes)).isoformat()


# --------------------------------------------------------------------------- the settings


async def test_sound_is_on_by_default_with_a_chime_and_a_reminder_after_15_minutes(env):
    c, *_ = await _setup(env)
    s = (await c.get("/notifications/settings")).json()
    assert s["sound"] is True
    assert s["sound_name"] == "chime"
    assert s["remind_after_min"] == 15
    feed = (await c.get("/notifications/feed")).json()
    assert feed["head"] >= 0
    feed = (await c.get("/notifications/feed", params={"since": feed["head"]})).json()
    assert feed["sound"] is True
    assert feed["sound_name"] == "chime"


async def test_the_sound_and_the_reminder_are_chosen_in_settings(env):
    c, *_ = await _setup(env)
    r = await c.patch(
        "/notifications/settings", json={"sound_name": "bell", "remind_after_min": 30}
    )
    assert r.status_code == 200
    assert r.json()["sound_name"] == "bell"
    assert r.json()["remind_after_min"] == 30
    off = await c.patch(
        "/notifications/settings", json={"sound": False, "remind_after_min": 0}
    )
    assert off.json()["sound"] is False
    assert off.json()["remind_after_min"] == 0
    # the name is kept while the sound is off, so switching it on again brings the same one back
    assert off.json()["sound_name"] == "bell"
    feed = (await c.get("/notifications/feed", params={"since": 0})).json()
    assert feed["sound"] is False
    assert feed["sound_name"] == "bell"


@pytest.mark.parametrize(
    "body",
    [{"sound_name": "airhorn"}, {"remind_after_min": -1}, {"remind_after_min": 5000}],
)
async def test_an_unknown_sound_or_a_silly_reminder_time_is_refused(env, body):
    c, *_ = await _setup(env)
    assert (await c.patch("/notifications/settings", json=body)).status_code == 422


# --------------------------------------------------------------------------- the reminder


async def _needs_row(env, c, pid, tid, *, kind="blocked", **extra):
    await centre.emit(
        kind,
        project_id=pid,
        recipients=["user"],
        title="Dev An is blocked",
        body="Needs a permission",
        ticket_id=tid,
        **extra,
    )
    [row] = (await _panel(c, "needs"))["items"]
    return row


async def test_an_unanswered_needs_you_reminds_once_after_the_set_time(env):
    c, pid, m, tid = await _setup(env)
    await _no_quiet_hours(c)
    await c.patch("/notifications/settings", json={"remind_after_min": 10})
    row = await _needs_row(env, c, pid, tid)
    head = (await c.get("/notifications/feed")).json()["head"]

    assert await centre.remind_unanswered() == 0  # just arrived
    await _set(env, Notification, row["id"], updated_at=_ago(9))
    assert await centre.remind_unanswered() == 0  # 9 minutes is not 10
    await _set(env, Notification, row["id"], updated_at=_ago(11))
    assert await centre.remind_unanswered() == 1

    feed = (await c.get("/notifications/feed", params={"since": head})).json()
    [back] = feed["items"]
    assert back["id"] == row["id"]
    assert back["reminded"] is True
    assert back["read"] is False
    assert back["last_event_id"] > row["last_event_id"]
    # the same request, not one more thing: still one row, still counted once, same words
    [only] = (await _panel(c, "needs"))["items"]
    assert only["count"] == 1
    assert only["title"] == row["title"]

    # once: it does not remind again however long it stays unanswered
    await _set(env, Notification, row["id"], updated_at=_ago(120))
    assert await centre.remind_unanswered() == 0


async def test_a_new_event_on_the_row_may_remind_again_when_it_too_goes_unanswered(env):
    c, pid, m, tid = await _setup(env)
    await _no_quiet_hours(c)
    row = await _needs_row(env, c, pid, tid)
    await _set(env, Notification, row["id"], updated_at=_ago(20))
    assert await centre.remind_unanswered() == 1
    await centre.emit(
        "blocked",
        project_id=pid,
        recipients=["user"],
        title="Dev An is blocked again",
        ticket_id=tid,
    )
    [again] = (await _panel(c, "needs"))["items"]
    assert again["reminded"] is False
    await _set(env, Notification, row["id"], updated_at=_ago(20))
    assert await centre.remind_unanswered() == 1


async def test_nothing_reminds_when_reminders_are_off_or_the_row_is_answered_read_or_snoozed(
    env,
):
    c, pid, m, tid = await _setup(env)
    await _no_quiet_hours(c)
    row = await _needs_row(env, c, pid, tid)
    await _set(env, Notification, row["id"], updated_at=_ago(60))

    await c.patch("/notifications/settings", json={"remind_after_min": 0})
    assert await centre.remind_unanswered() == 0
    await c.patch("/notifications/settings", json={"remind_after_min": 15})

    await c.post("/notifications/read", json={"ids": [row["id"]]})
    assert await centre.remind_unanswered() == 0  # read: the person has seen it
    await _set(env, Notification, row["id"], read_at=None)

    until = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    await c.post(f"/notifications/{row['id']}/snooze", json={"until": until})
    await _set(env, Notification, row["id"], updated_at=_ago(60))
    assert await centre.remind_unanswered() == 0  # snoozed
    await _set(env, Notification, row["id"], snoozed_until=None)

    await _set(env, Notification, row["id"], done_at=_ago(1))
    assert await centre.remind_unanswered() == 0  # answered


async def test_information_never_reminds(env):
    c, pid, m, tid = await _setup(env)
    await _no_quiet_hours(c)
    await centre.emit(
        "ai_finished", project_id=pid, recipients=["user"], title="Dev finished KAN-1"
    )
    [row] = (await _panel(c, "updates"))["items"]
    await _set(env, Notification, row["id"], updated_at=_ago(600))
    assert await centre.remind_unanswered() == 0


async def test_quiet_hours_hold_the_reminder_until_they_end(env):
    c, pid, m, tid = await _setup(env)
    row = await _needs_row(env, c, pid, tid)
    await _set(env, Notification, row["id"], updated_at=_ago(60))
    # quiet hours around the clock: the reminder waits
    await c.patch(
        "/notifications/settings",
        json={"quiet": {"on": True, "start": "00:00", "end": "23:59"}},
    )
    assert await centre.remind_unanswered() == 0
    await c.patch("/notifications/settings", json={"quiet": {"on": False}})
    assert await centre.remind_unanswered() == 1


async def test_an_unanswered_question_from_an_ai_reminds_once_at_the_set_time(env):
    """The run records its own 15-min level, but the notification of the first reminder is the person's setting."""
    c, pid, m, tid = await _setup(env)
    await _no_quiet_hours(c)
    await c.patch("/notifications/settings", json={"remind_after_min": 5})
    run_id = await _run(env, pid, m["id"], tid, state="needs_input")
    await centre.emit(
        "question",
        project_id=pid,
        recipients=["user"],
        title="Dev An asks a question",
        body="Cursor or offset?",
        target_kind="run",
        target_id=run_id,
        ticket_id=tid,
    )
    [row] = (await _panel(c, "needs"))["items"]
    await _set(env, Notification, row["id"], updated_at=_ago(6))
    assert await centre.remind_unanswered() == 1
    [back] = (await _panel(c, "needs"))["items"]
    assert back["reminded"] is True
    assert back["count"] == 1
