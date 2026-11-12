"""Golden vectors for `services/ai/schedules.py` (`crates/kb-ai-run/src/schedules/`).

`pure`: `zone`, `_hm`, `tz_label`, `in_words`, `slots` (every kind of recurrence, time zones with and without summer
time, both clock changes of 2026, month ends, a leap day, the end rules, one-off runs written with and without an
offset), `_advance`, `_fmt_day`, `when_label`, `_deadline`, `_instruction`, `limits_of`, `_short`, `run_to_dict`,
`_report_of`, `_apply`.

With a database, built here with the Python models and written as the rows the models dump (the Rust test puts the
same rows into its own database), and with the module's clock stopped at `now`: `role_of`, `availability`, `assess`
and `preview` over tables of data, `summary_text`, `to_dict`, `list_for`, `history`, `detail`, `week`, `for_tickets`,
and `create`, `update`, `set_paused`, `delete` step by step (what is stored or refused, the ticket's Activity).

`stories`: the loop, one `tick(now)` at a time, on rows only (each story starts with no schedule, slot or run but its
own: the loop looks at all there are) (the runs a slot starts stay queued: no CLI is started,
and a story moves a run on by changing its row, which is all the loop reads): a slot that starts on time, late, on the
backup team, waits, asks, is skipped; a run that finishes, fails and is started again, is cancelled, is lost, waits too
long in the queue, needs input, goes over its limit; three failures in a row; a slot that was already opened; run now
and the answers to a waiting slot. After every step: the schedules, the slots, the runs, the tickets' Activity, the
schedule's feed and the notifications that were written.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_schedules.py
Writes `ai_schedules.json` next to this file.
"""

import asyncio
import json
import os
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

work = os.path.realpath(tempfile.mkdtemp(prefix="gen-ai-schedules-"))
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude-config"
os.environ["KANBAN_AI_ROOTS"] = work
os.environ["KANBAN_AI_ACCOUNTS_HOME"] = f"{work}/accounts"
os.environ["KANBAN_AI_RUNS_DIR"] = f"{work}/ai-runs"
os.environ["HOME"] = f"{work}/home"
os.environ["PATH"] = f"{work}/bin:/usr/bin:/bin"
sys.path.insert(0, os.getcwd())
os.makedirs(f"{work}/home", exist_ok=True)

from sqlalchemy import delete as sql_delete  # noqa: E402
from sqlmodel import col, select  # noqa: E402

import database  # noqa: E402
from models import (  # noqa: E402
    AiProjectSettings,
    AiRun,
    AiSchedule,
    AiScheduleRun,
    AiTeam,
    Member,
    NotifyEvent,
    Project,
    Ticket,
)
from services import notifications  # noqa: E402
from services.ai import schedules  # noqa: E402

OUT = Path(__file__).with_name("ai_schedules.json")
NOW = datetime(2026, 3, 6, 10, 0, 0, tzinfo=UTC)  # a Friday, two days before the clocks change in New York
STAMP = "2025-01-01T00:00:00+00:00"
out: dict = {"now": NOW.isoformat()}
CLOCK = {"now": NOW}


class Frozen(datetime):
    """`datetime` with `now()` stopped (what the Rust tests do with `clock::set_now`)."""

    @classmethod
    def now(cls, tz=None):
        return CLOCK["now"].astimezone(tz) if tz else CLOCK["now"].replace(tzinfo=None)


schedules.datetime = Frozen


def at(text: str) -> datetime:
    return datetime.fromisoformat(text).astimezone(UTC)


def ago(**kw) -> str:
    return (NOW - timedelta(**kw)).isoformat()


def row_dict(row):
    return json.loads(row.model_dump_json())


def attempt(call):
    """What a call gave: its value, the `ScheduleError` it raised, or the kind of any other exception."""
    try:
        return {"ok": call()}
    except schedules.ScheduleError as exc:
        return {"error": [exc.code, str(exc), exc.extra]}
    except Exception as exc:  # noqa: BLE001
        return {"raises": type(exc).__name__}


async def attempt_async(coro):
    try:
        return {"ok": await coro}
    except schedules.ScheduleError as exc:
        return {"error": [exc.code, str(exc), exc.extra]}
    except Exception as exc:  # noqa: BLE001
        return {"raises": type(exc).__name__}


BASE = dict(id="sch_pure", project_id="p", ticket_id="KAN-1", member_id="m-dev", created_by="An Nguyen", created_at=STAMP, updated_at=STAMP)


def sched(**kw) -> AiSchedule:
    return AiSchedule(**{**BASE, **kw})


def iso_list(times):
    return [t.isoformat() for t in times]


# ---------------------------------------------------------------------------------------------------------------------
# pure
# ---------------------------------------------------------------------------------------------------------------------
pure: dict = {"base": row_dict(sched())}
ZONE_NAMES = [None, "", "UTC", "Etc/UTC", "GMT", "Asia/Ho_Chi_Minh", "Asia/Saigon", "Europe/Berlin", "America/New_York", "US/Pacific", "EST", "Etc/GMT+5", "Etc/GMT-14",
              "Asia/Kolkata", "Asia/Calcutta", "Australia/Lord_Howe", "Mars/Olympus", "europe/berlin", "Europe/berlin", " UTC", "UTC ", "Europe", "Berlin", "+07:00", "utc",
              "Europe/Berlin/", "/Europe/Berlin", "../Europe/Berlin", "Asia/Hồ_Chí_Minh", "Zulu", "PST8PDT", "America/Argentina/Buenos_Aires", "America/Indiana/Knox"]
pure["zone"] = [{"name": n, "out": attempt(lambda n=n: str(schedules.zone(n)))} for n in ZONE_NAMES]
HMS = [None, "", "02:00", "2:0", "00:00", "23:59", "24:00", "12:60", "-1:30", "1:-1", "0230", "02", "02:", ":30", "02:30:45", "02:30:xx", " 02 : 30 ", "+2:+30", "1_0:3_0",
       "٠٢:٣٠", "02h30", "02.30", "2:30pm", "aa:bb", "1e1:00", "0x2:00", "2.0:00", "02:00\n", "99999999999999999999:00"]
pure["hm"] = [{"value": v, "out": attempt(lambda v=v: list(schedules._hm(v)))} for v in HMS]
LABEL_ZONES = ["UTC", "Asia/Ho_Chi_Minh", "Asia/Kolkata", "Asia/Kathmandu", "Europe/Berlin", "Europe/London", "Europe/Dublin", "America/New_York", "America/St_Johns",
               "America/Sao_Paulo", "Australia/Lord_Howe", "Pacific/Chatham", "Pacific/Kiritimati", "Etc/GMT+12", "Pacific/Marquesas", "Africa/Monrovia", "Nowhere/None"]
INSTANTS = ["2026-01-15T12:00:00+00:00", "2026-07-15T12:00:00+00:00", "1901-06-01T00:00:00+00:00", "1970-01-01T00:00:00+00:00"]
pure["tz_label"] = [{"name": z, "at": i, "out": attempt(lambda z=z, i=i: schedules.tz_label(z, at(i)))} for z in LABEL_ZONES for i in INSTANTS]
pure["tz_label_now"] = {z: schedules.tz_label(z) for z in LABEL_ZONES[:-1]}
DELTAS = [0, 1, 29, 59, 60, 61, 119, 120, 3599, 3600, 3601, 3660, 7199, 7200, 86399, 86400, 86401, 90000, 172799, 172800, 259199, 259200, 259201, 864000, 31536000,
          0.4, 0.999999, 59.999999, 3599.5, 86399.999999]
pure["in_words"] = [
    {"at": (NOW + timedelta(seconds=sign * d)).isoformat(), "out": schedules.in_words(NOW + timedelta(seconds=sign * d), NOW)} for d in DELTAS for sign in (1, -1)
]
pure["in_words_now"] = {(NOW + timedelta(minutes=m)).isoformat(): schedules.in_words(NOW + timedelta(minutes=m)) for m in (-90, 0, 45, 4000)}

SLOTS: list = []


def slot_case(kw, after, n=5):
    s = sched(**kw)
    SLOTS.append({"s": kw, "after": after, "n": n, "out": attempt(lambda: iso_list(schedules.slots(s, at(after), n)))})


EVERY = json.dumps(list(range(7)))
TIMES = ["00:00", "00:30", "01:30", "02:00", "02:30", "03:00", "12:00", "23:59"]
# zones whose clocks change, with a moment shortly before each change of 2026
CHANGES = {
    "America/New_York": ["2026-03-06T10:00:00+00:00", "2026-10-30T10:00:00+00:00"],
    "America/Los_Angeles": ["2026-03-06T10:00:00+00:00", "2026-10-30T10:00:00+00:00"],
    "America/St_Johns": ["2026-03-06T10:00:00+00:00", "2026-10-30T10:00:00+00:00"],
    "America/Havana": ["2026-03-06T10:00:00+00:00", "2026-10-30T10:00:00+00:00"],
    "Europe/Berlin": ["2026-03-27T10:00:00+00:00", "2026-10-23T10:00:00+00:00"],
    "Europe/London": ["2026-03-27T10:00:00+00:00", "2026-10-23T10:00:00+00:00"],
    "Europe/Dublin": ["2026-03-27T10:00:00+00:00", "2026-10-23T10:00:00+00:00"],
    "Europe/Lisbon": ["2026-03-27T10:00:00+00:00", "2026-10-23T10:00:00+00:00"],
    # (its rules changed in 2026: the server reads the system's time zone database, as zoneinfo does)
    "Europe/Chisinau": ["2026-03-27T10:00:00+00:00", "2026-10-23T10:00:00+00:00"],
    "Asia/Beirut": ["2026-03-27T10:00:00+00:00", "2026-10-23T10:00:00+00:00"],
    "Australia/Sydney": ["2026-04-03T10:00:00+00:00", "2026-10-02T10:00:00+00:00"],
    "Australia/Lord_Howe": ["2026-04-03T10:00:00+00:00", "2026-10-02T10:00:00+00:00"],
    "Pacific/Auckland": ["2026-04-03T10:00:00+00:00", "2026-09-25T10:00:00+00:00"],
    "Pacific/Chatham": ["2026-04-03T10:00:00+00:00", "2026-09-25T10:00:00+00:00"],
    "America/Santiago": ["2026-04-03T10:00:00+00:00", "2026-09-04T10:00:00+00:00"],
    "Antarctica/Troll": ["2026-03-27T10:00:00+00:00", "2026-10-23T10:00:00+00:00"],
}
for tz, afters in CHANGES.items():
    for after in afters:
        for time in TIMES:
            slot_case({"tz": tz, "time": time, "days": EVERY}, after)
# zones without a change, and the calendar: month ends, the end of February with and without a leap day, the new year
STEADY = ["UTC", "Asia/Ho_Chi_Minh", "Asia/Kolkata", "Asia/Kathmandu", "America/Sao_Paulo", "Pacific/Kiritimati", "Etc/GMT+12", "Asia/Tehran", "Europe/Berlin", "America/New_York"]
CALENDAR = ["2026-01-30T23:30:00+00:00", "2026-02-27T12:00:00+00:00", "2028-02-27T12:00:00+00:00", "2026-12-30T12:00:00+00:00", "2027-12-31T23:59:59.999999+00:00", "2026-04-29T16:59:59+00:00"]
for tz in STEADY:
    for after in CALENDAR:
        for time, days in (("00:00", [0, 1, 2, 3, 4]), ("23:59", [6]), ("17:00", [0, 2, 4]), ("09:15", [5, 6])):
            slot_case({"tz": tz, "time": time, "days": json.dumps(days)}, after)
# exactly at, just before and just after a planned start
for after in ("2026-03-09T01:59:59.999999+00:00", "2026-03-09T02:00:00+00:00", "2026-03-09T02:00:00.000001+00:00", "2026-03-09T09:00:00+07:00", "2026-03-08T19:00:00-07:00"):
    slot_case({"tz": "UTC", "time": "02:00", "days": EVERY}, after, 2)
    slot_case({"tz": "Asia/Ho_Chi_Minh", "time": "09:00", "days": EVERY}, after, 2)
# how many, and how far ahead the plan looks (400 days)
for n in (0, 1, 2, 10, 50, 60):
    slot_case({"tz": "Europe/Berlin", "time": "02:30", "days": "[6]"}, "2026-03-06T10:00:00+00:00", n)
    slot_case({"tz": "America/New_York", "time": "01:30", "days": EVERY}, "2026-10-30T10:00:00+00:00", n)
# the end rules
for runs_count in (0, 1, 2, 3, 5):
    for ends_after in (None, 0, 1, 3):
        for n in (1, 5):
            slot_case({"tz": "Asia/Ho_Chi_Minh", "time": "22:00", "days": "[0, 2]", "ends": "after", "ends_after": ends_after, "runs_count": runs_count}, "2026-03-06T10:00:00+00:00", n)
for ends_on in (None, "", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-09", "2026-03-31", "2027-01-01", "2026-3-9", "soon"):
    for tz in ("UTC", "Pacific/Kiritimati", "Etc/GMT+12"):
        slot_case({"tz": tz, "time": "11:00", "days": EVERY, "ends": "on_date", "ends_on": ends_on}, "2026-03-06T10:00:00+00:00", 5)
slot_case({"tz": "UTC", "time": "11:00", "days": EVERY, "ends": "never", "ends_after": 1, "ends_on": "2026-03-01", "runs_count": 9}, "2026-03-06T10:00:00+00:00")
slot_case({"tz": "UTC", "time": "11:00", "days": EVERY, "ends": "other", "ends_after": 1, "ends_on": "2026-03-01"}, "2026-03-06T10:00:00+00:00")
# a one-off run
RUN_ATS = [None, "", "2026-03-08T02:30", "2026-03-08T02:30:00", "2026-03-08 02:30", "2026-03-08T02:30:15.250000", "2026-03-08T02:30:00+00:00", "2026-03-08T02:30:00Z",
           "2026-03-08T02:30:00-05:00", "2026-03-08T02:30+07:00", "2026-03-08", "20260308T0230", "2026-11-01T01:30", "2026-10-25T02:30", "2026-03-29T02:30", "2026-03-06T10:00:00",
           "2026-03-06T10:00:01", "2026-03-06T09:59:59", "next week", "2026-02-30T10:00", "2026-03-08T24:00", "2026-03-08T02:30:00+25:00", "2026-W11-1T08:00"]
for run_at in RUN_ATS:
    for tz in ("UTC", "America/New_York", "Europe/Berlin", "Asia/Ho_Chi_Minh"):
        slot_case({"kind": "once", "run_at": run_at, "tz": tz}, "2026-03-06T10:00:00+00:00")
slot_case({"kind": "once", "run_at": "2026-03-08T02:30", "tz": "UTC", "runs_count": 1}, "2026-03-06T10:00:00+00:00")
slot_case({"kind": "once", "run_at": "2026-03-08T02:30", "tz": "Mars/Olympus"}, "2026-03-06T10:00:00+00:00")
slot_case({"kind": "once", "run_at": "2026-03-08T02:30+00:00", "tz": "Mars/Olympus"}, "2026-03-06T10:00:00+00:00")
slot_case({"kind": "once", "run_at": "2026-03-08T02:30", "tz": "UTC", "days": "[]", "time": "nope"}, "2026-03-06T10:00:00+00:00")
# what should not be there
for kw in (
    {"days": "[]"}, {"days": ""}, {"days": "not json"}, {"days": '["1", 2.0, true]'}, {"days": "[7, 8, -1]"}, {"days": '["mon"]'}, {"days": "[1.9]"}, {"days": "[null]"},
    {"days": '{"3": 1}'}, {"days": '"135"'}, {"days": "5"}, {"days": "[[1]]"}, {"time": "25:00"}, {"time": ""}, {"time": "2:5"}, {"tz": "Mars/Olympus"}, {"tz": ""},
    {"kind": "weekly"}, {"kind": ""}, {"days": "[]", "tz": "Mars/Olympus", "time": "x"}, {"days": "[1]", "tz": "Mars/Olympus", "time": "x"}, {"days": "[1]", "time": "x"},
):
    slot_case({"days": EVERY, **kw}, "2026-03-06T10:00:00+00:00")
pure["slots"] = SLOTS

ADVANCE = []
for kw, after, end in (
    ({"tz": "UTC", "time": "11:00", "days": EVERY}, "2026-03-06T10:00:00+00:00", True),
    ({"tz": "UTC", "time": "11:00", "days": "[]"}, "2026-03-06T10:00:00+00:00", True),
    ({"tz": "UTC", "time": "11:00", "days": "[]"}, "2026-03-06T10:00:00+00:00", False),
    ({"tz": "UTC", "time": "11:00", "days": "[]", "state": "paused"}, "2026-03-06T10:00:00+00:00", True),
    ({"tz": "UTC", "time": "11:00", "days": "[]", "state": "ended", "next_run_at": "2026-01-01T00:00:00+00:00"}, "2026-03-06T10:00:00+00:00", True),
    ({"kind": "once", "run_at": "2026-03-08T02:30:15.5", "tz": "America/New_York"}, "2026-03-06T10:00:00+00:00", True),
    ({"kind": "once", "run_at": "2026-03-08T02:30", "tz": "America/New_York", "runs_count": 1}, "2026-03-06T10:00:00+00:00", False),
    ({"kind": "once", "run_at": "2026-03-08T02:30", "tz": "America/New_York", "runs_count": 1}, "2026-03-06T10:00:00+00:00", True),
    ({"tz": "UTC", "time": "11:00", "days": EVERY, "ends": "after", "ends_after": 2, "runs_count": 2}, "2026-03-06T10:00:00+00:00", True),
    ({"tz": "Nowhere", "time": "11:00", "days": EVERY}, "2026-03-06T10:00:00+00:00", True),
):
    s = sched(**kw)
    got = attempt(lambda: schedules._advance(s, at(after), end=end))
    ADVANCE.append({"s": kw, "after": after, "end": end, "out": got, "next_run_at": s.next_run_at, "state": s.state})
pure["advance"] = ADVANCE

WHEN = []
for kw in (
    {"days": "[0, 1, 2, 3, 4]"}, {"days": "[4, 3, 2, 1, 0, 0]"}, {"days": EVERY}, {"days": "[5, 6]"}, {"days": "[6, 5]"}, {"days": "[0]"}, {"days": "[0, 2, 4]", "time": "22:00"},
    {"days": "[6, 0]", "time": "7:5"}, {"days": "[]"}, {"days": '["2", 4.0]'}, {"days": "[-1]"}, {"days": "[-7, 6]"}, {"days": "[7]"}, {"days": "[-8]"}, {"days": '["x"]'},
    {"kind": "once"}, {"kind": "once", "run_at": "2026-10-30T23:30", "tz": "Asia/Ho_Chi_Minh"}, {"kind": "once", "run_at": "2026-10-30T23:30:00+00:00", "tz": "Asia/Ho_Chi_Minh"},
    {"kind": "once", "run_at": "2026-03-08T02:30", "tz": "America/New_York"}, {"kind": "once", "run_at": "2026-01-01T00:00", "tz": "Pacific/Kiritimati"},
    {"kind": "once", "run_at": "bad"}, {"kind": "once", "run_at": "2026-03-08T02:30", "tz": "Nowhere"}, {"kind": "other", "days": "[1]"},
):
    s = sched(**kw)
    WHEN.append({"s": kw, "out": attempt(lambda: schedules.when_label(s))})
pure["when_label"] = WHEN
pure["fmt_day"] = [
    {"at": i, "tz": z, "out": attempt(lambda i=i, z=z: schedules._fmt_day(at(i), z))}
    for i in ("2026-10-30T16:30:00+00:00", "2026-01-01T00:00:00+00:00", "2026-12-31T23:59:59+00:00", "2028-02-29T12:00:00+00:00", "2026-05-09T10:00:00+00:00")
    for z in ("UTC", "Asia/Ho_Chi_Minh", "America/Los_Angeles", "Pacific/Kiritimati", "Nowhere")
]

DEADLINES = []
for kw in (
    {}, {"catch_up_hours": 0}, {"catch_up_hours": 0.5}, {"catch_up_hours": 24}, {"catch_up_hours": 1.3333333}, {"catch_up_hours": 0.000001}, {"catch_up_hours": -1},
    {"window_end": "06:00"}, {"window_end": "02:00"}, {"window_end": "02:30"}, {"window_end": "23:59", "tz": "Asia/Ho_Chi_Minh"}, {"window_end": "00:00", "tz": "Asia/Ho_Chi_Minh"},
    {"window_end": "02:30", "tz": "America/New_York"}, {"window_end": "01:30", "tz": "America/New_York"}, {"window_end": "03:00", "tz": "Europe/Berlin"},
    {"window_end": "02:30", "tz": "Europe/Berlin"}, {"window_end": "", "catch_up_hours": 3}, {"window_end": "25:00"}, {"window_end": "06:00", "tz": "Nowhere"},
):
    for slot in ("2026-03-08T06:30:00+00:00", "2026-03-08T07:00:00+00:00", "2026-03-07T07:30:00+00:00", "2026-11-01T05:30:00+00:00", "2026-11-01T06:30:00+00:00",
                 "2026-10-25T00:30:00+00:00", "2026-10-25T01:30:00+00:00", "2026-03-29T00:59:59.5+00:00", "2026-06-15T23:59:00+00:00"):
        s = sched(**kw)
        DEADLINES.append({"s": kw, "slot": slot, "out": attempt(lambda: schedules._deadline(s, at(slot)).isoformat())})
pure["deadline"] = DEADLINES
pure["instruction"] = [
    {"s": kw, "extra": extra, "out": schedules._instruction(sched(**kw), extra)}
    for kw in ({}, {"instruction": "  Run the nightly checks.\n"}, {"instruction": " \n\t", "created_by": "Đỗ An"})
    for extra in ("", "The last attempt failed: exit 1. Try again.")
]
pure["limits_of"] = [
    {"limits": text, "out": schedules.limits_of(sched(limits=text)), "keys": list(schedules.limits_of(sched(limits=text)))}
    for text in ("{}", "", "not json", "[]", "null", '{"stop_after_min": 90}', '{"max_cost": 2.5, "retries": 0}', '{"extra": true, "retries": "2", "stop_after_min": null}')
]
SHORTS = ["", "one line", "  spread \n over\tlines  ", "x" * 159, "x" * 160, "x" * 161, "word " * 50, ("y" * 158) + " z tail", "é" * 300, "Traceback (most recent call last):\n  File x\nValueError: no"]
pure["short"] = [{"text": t, "limit": n, "out": schedules._short(t, n)} for t in SHORTS for n in (160, 200, 10)]
SRUNS = [
    AiScheduleRun(id="sr_1", schedule_id="sch_pure", project_id="p", ticket_id="KAN-1", slot_at="2026-03-06T02:00:00+00:00", created_at=STAMP, updated_at=STAMP),
    AiScheduleRun(id="sr_2", schedule_id="sch_pure", project_id="p", ticket_id="KAN-1", slot_at="2026-03-05T02:00:00+00:00", state="passed", catch_up=True, member_id="m-dev",
                  run_ids=json.dumps(["r1", "r2"]), attempts=2, note="Finished.", started_at=STAMP, ended_at=STAMP, duration_s=125, cost_usd=0.123456, created_at=STAMP, updated_at=STAMP),
    AiScheduleRun(id="sr_3", schedule_id="sch_pure", project_id="p", ticket_id="KAN-1", slot_at="2026-03-04T02:00:00+00:00", state="failed", member_id="m-gone", run_ids="not json",
                  cost_usd=0.00005, created_at=STAMP, updated_at=STAMP),
    AiScheduleRun(id="sr_4", schedule_id="sch_pure", project_id="p", ticket_id="KAN-1", slot_at="2026-03-03T02:00:00+00:00", state="skipped", member_id="", run_ids="",
                  cost_usd=2.00015, created_at=STAMP, updated_at=STAMP),
]
NAMES = {"m-dev": "Dev Team", "": "Nobody"}
pure["run_to_dict"] = [
    {"row": row_dict(r), "names": names, "out": schedules.run_to_dict(r, names), "keys": list(schedules.run_to_dict(r, names))} for r in SRUNS for names in (NAMES, None, {})
]
REPORT_RUNS = [
    None,
    AiRun(id="rep_1", project_id="p", member_id="m", state="finished", report=json.dumps({"status": "partial", "summary": "  Did half.  ", "open_items": ["a", 2, "x" * 400] + ["more"] * 9, "branch": "ai/x", "pr_url": "https://x/1"})),
    AiRun(id="rep_2", project_id="p", member_id="m", state="finished", summary="  From the run.  ", report="{}"),
    AiRun(id="rep_3", project_id="p", member_id="m", state="finished", summary=None, report=""),
    AiRun(id="rep_4", project_id="p", member_id="m", state="finished", summary="", report=json.dumps({"open_items": ["only this"]})),
    AiRun(id="rep_5", project_id="p", member_id="m", state="failed", summary="Failed.", report=json.dumps({"summary": "x"})),
    AiRun(id="rep_6", project_id="p", member_id="m", state="finished", summary="s" * 2500, report="not json"),
    AiRun(id="rep_7", project_id="p", member_id="m", state="finished", report=json.dumps({"summary": 12, "status": "", "open_items": [], "branch": 3})),
    AiRun(id="rep_8", project_id="p", member_id="m", state="finished", report="[]", summary="A list was stored."),
]
pure["report_of"] = [{"run": r and row_dict(r), "out": schedules._report_of(r)} for r in REPORT_RUNS]

APPLIES = [
    {},
    {"ticket_id": "KAN-2", "member_id": "m-qa", "backup_member_id": "m-dev", "kind": "once", "run_at": "2026-03-08T02:30", "days": [0, 2], "time": "22:00", "tz": "Asia/Ho_Chi_Minh",
     "ends": "after", "ends_after": 3, "ends_on": "2026-04-01", "window_end": "06:00", "limits": {"stop_after_min": 90, "retries": 2, "max_cost": 1.5}, "catch_up": "ask",
     "catch_up_hours": 4, "notify": ["failed"], "notify_people": ["Binh", "Đỗ An"], "instruction": "Check the nightly build."},
    {"backup_member_id": "", "window_end": "", "ends_on": "", "run_at": ""},
    {"backup_member_id": None, "window_end": None, "ends_on": None, "run_at": None, "ends_after": None},
    {"days": None, "limits": None, "notify": None, "notify_people": None},
    {"days": [], "limits": {}, "notify": [], "notify_people": []},
    {"days": ["1", 2.0, True], "limits": {"z": 1, "a": [1, {"b": None}]}},
    {"catch_up_hours": 0.5, "ends_after": 0},
    {"catch_up_hours": 2, "ends_after": 3.0},
    {"id": "sch_other", "project_id": "p-other", "state": "ended", "created_by": "Mallory", "runs_count": 9, "next_run_at": "x", "ticket_id": "KAN-3"},
    {"instruction": "", "tz": "", "time": "", "kind": "", "ends": "", "catch_up": "", "ticket_id": "", "member_id": ""},
]
APPLIED = []
for data in APPLIES:
    s = sched()
    schedules._apply(s, data)
    APPLIED.append({"data": data, "out": row_dict(s)})
pure["apply"] = APPLIED
pure["constants"] = {
    "DAY_NAMES": schedules.DAY_NAMES,
    "DEFAULT_LIMITS": schedules.DEFAULT_LIMITS,
    "NOTIFY_EVENTS": list(schedules.NOTIFY_EVENTS),
    "OPEN": list(schedules.OPEN),
    "ENDED": list(schedules.ENDED),
    "LATE_AFTER_S": schedules.LATE_AFTER_S,
    "BUSY_MAX_WAIT_MIN": schedules.BUSY_MAX_WAIT_MIN,
    "AUTO_PAUSE_AFTER": schedules.AUTO_PAUSE_AFTER,
    "TICK_S": schedules.TICK_S,
    "FIELDS": list(schedules.FIELDS),
    "JSON_FIELDS": list(schedules.JSON_FIELDS),
}
out["pure"] = pure

# ---------------------------------------------------------------------------------------------------------------------
# a project with teams in every state
# ---------------------------------------------------------------------------------------------------------------------
P = "p-sch"
TABLES = {Project: "project", Member: "member", AiTeam: "ai_team", AiProjectSettings: "ai_project_settings", Ticket: "ticket", AiRun: "ai_run", AiSchedule: "ai_schedule",
          AiScheduleRun: "ai_schedule_run"}


async def put(rows):
    async with database.async_session() as session:
        for r in rows:
            session.add(r)
        await session.commit()
        for r in rows:
            await session.refresh(r)
    dumped: dict = {}
    for r in rows:
        dumped.setdefault(TABLES[type(r)], []).append(row_dict(r))
    return dumped


def team(team_id, name, project=P, kind="ai", **kw):
    return [
        Member(id=team_id, project_id=project, name=name, color="#2E6F40", kind=kind, created_at=STAMP),
        AiTeam(id=team_id, project_id=project, created_at=STAMP, updated_at=STAMP, **kw),
    ]


def a_schedule(sid, ticket, member, **kw):
    kw.setdefault("created_by", "An Nguyen")
    return AiSchedule(id=sid, project_id=kw.pop("project_id", P), ticket_id=ticket, member_id=member, created_at=STAMP, updated_at=STAMP, **kw)


def a_slot(i, sid, ticket, slot_at, state, **kw):
    return AiScheduleRun(id=f"sl_{i:02d}", schedule_id=sid, project_id=kw.pop("project_id", P), ticket_id=ticket, slot_at=slot_at, state=state, created_at=STAMP, updated_at=STAMP, **kw)


def board_rows():
    rows: list = [
        Project(id=P, name="Schedules", prefix="SCH", color="#2E6F40"),
        Project(id="p-sch-other", name="Other", prefix="SCO", color="#2E6F40"),
        Project(id="p-sch-off", name="Paused", prefix="SCP", color="#2E6F40"),
        Project(id="p-sch-empty", name="Empty", prefix="SCE", color="#2E6F40"),
        AiProjectSettings(project_id=P, updated_at=STAMP),
        AiProjectSettings(project_id="p-sch-off", paused_all=True, paused_reason="Stopped by An", updated_at=STAMP),
        Member(id="s-an", project_id=P, name="An Nguyen", color="#3B82F6", role="admin", created_at=STAMP),
        Member(id="s-binh", project_id=P, name="Binh", color="#3B82F6", created_at=STAMP),
        Member(id="s-vy", project_id=P, name="Vy", color="#3B82F6", role="viewer", created_at=STAMP),
        Member(id="s-bot", project_id=P, name="Bot Vy", color="#3B82F6", role="viewer", kind="ai_removed", created_at=STAMP),
        Member(id="o-an", project_id="p-sch-other", name="An Nguyen", color="#3B82F6", role="viewer", created_at=STAMP),
    ]
    rows += team("s-dev", "Dev Team", max_parallel=2)
    rows += team("s-qa", "QA Team")
    rows += team("s-paused", "Paused Team", paused=True, paused_reason="lunch")
    rows += team("s-inbox", "Inbox Team", connection="inbox")
    rows += team("s-out", "Signed-out Team", health="not_logged_in")
    rows += team("s-key", "Key Team", health="key_invalid")
    rows += team("s-run", "Closed Team", health="runner_missing")
    rows += team("s-old", "Retired Team", health="model_retired")
    rows += team("s-busy", "Busy Team", max_parallel=1)
    rows += team("s-capped", "Capped Team", max_runs_per_day=1)
    rows += team("s-cloud", "Cloud Team", connection="cloud")
    rows += team("s-gone", "Gone Team", kind="ai_removed")
    rows += [Member(id="s-half", project_id=P, name="No Profile", color="#2E6F40", kind="ai", created_at=STAMP)]
    rows += team("o-team", "Other Team", project="p-sch-other")
    rows += team("off-team", "Off Team", project="p-sch-off")
    rows += [
        Ticket(id="SCH-1", project_id=P, title="Nightly checks", status="todo", created_at=STAMP, updated_at="2026-03-01T00:00:00+00:00"),
        Ticket(id="SCH-2", project_id=P, title="Already done", status="done", created_at=STAMP, updated_at=STAMP),
        Ticket(id="SCH-3", project_id=P, title="Dropped", status="wont_do", created_at=STAMP, updated_at=STAMP),
        Ticket(id="SCH-4", project_id=P, title="Weekly report", status="in_progress", created_at=STAMP, updated_at=STAMP,
               acceptance_criteria=json.dumps([{"text": "It is sent"}, {"done": True}])),
        Ticket(id="SCH-5", project_id=P, title="Busy one", status="review", created_at=STAMP, updated_at=STAMP),
        Ticket(id="SCH-6", project_id=P, title="Busy two", status="todo", created_at=STAMP, updated_at=STAMP),
        Ticket(id="SCO-1", project_id="p-sch-other", title="Elsewhere", status="todo", created_at=STAMP, updated_at=STAMP),
        Ticket(id="SCP-1", project_id="p-sch-off", title="While paused", status="todo", created_at=STAMP, updated_at=STAMP),
        # the busy team works on one ticket and has two more runs waiting; the capped team has run its one scheduled run
        AiRun(id="sb_1", project_id=P, member_id="s-busy", ticket_id="SCH-5", number=1, state="running", queued_at=ago(hours=1), started_at=ago(hours=1)),
        AiRun(id="sb_2", project_id=P, member_id="s-busy", ticket_id="SCH-6", number=1, state="queued", queued_at=ago(minutes=30)),
        AiRun(id="sb_3", project_id=P, member_id="s-busy", ticket_id="SCH-4", number=1, state="queued", queued_at=ago(minutes=20)),
        AiRun(id="sb_4", project_id=P, member_id="s-dev", ticket_id="SCH-4", number=2, state="starting", queued_at=ago(minutes=10), started_at=ago(minutes=10)),
        AiRun(id="sb_5", project_id=P, member_id="s-capped", ticket_id="SCH-4", number=3, state="finished", trigger="schedule", queued_at="2099-01-01T00:00:00+00:00",
              started_at="2099-01-01T00:00:00+00:00", report=json.dumps({"status": "partial", "summary": "Half of it.", "open_items": ["the rest"], "branch": "ai/sch-4"})),
        AiRun(id="sb_6", project_id=P, member_id="s-dev", ticket_id="SCH-1", number=1, state="finished", queued_at=ago(days=1), started_at=ago(days=1), summary="All checks ran.", cost_usd=0.5),
        AiRun(id="sb_7", project_id=P, member_id="s-dev", ticket_id="SCH-1", number=2, state="failed", queued_at=ago(days=2), started_at=ago(days=2), ended_reason="exit 1", cost_usd=0.25),
    ]
    rows += [
        # the schedules of the project
        a_schedule("sch_night", "SCH-1", "s-dev", time="02:00", tz="Asia/Ho_Chi_Minh", next_run_at="2026-03-06T19:00:00+00:00", runs_count=4, ticket_seen_at="2026-02-01T00:00:00+00:00",
                   backup_member_id="s-qa", ends="after", ends_after=30, limits=json.dumps({"stop_after_min": 60}), notify_people=json.dumps(["Binh"]), instruction="Run the nightly checks."),
        a_schedule("sch_week", "SCH-4", "s-dev", days="[0]", time="09:00", tz="Europe/Berlin", next_run_at="2026-03-09T08:00:00+00:00", ends="on_date", ends_on="2026-06-30",
                   ticket_seen_at=STAMP, catch_up="skip"),
        a_schedule("sch_soon", "SCH-4", "s-qa", days="[4]", time="10:30", next_run_at="2026-03-06T10:30:00+00:00"),
        a_schedule("sch_clash", "SCH-5", "s-dev", time="19:30", tz="UTC", days="[0, 1, 2, 3, 4, 5, 6]", next_run_at="2026-03-06T19:30:00+00:00"),
        a_schedule("sch_once", "SCH-6", "s-run", kind="once", run_at="2026-03-07T02:30", tz="Asia/Ho_Chi_Minh", next_run_at="2026-03-06T19:30:00+00:00", created_by="Binh", catch_up="ask"),
        a_schedule("sch_local", "SCH-6", "s-run", time="02:00", next_run_at="2026-03-07T02:00:00+00:00", catch_up_hours=6.5),
        a_schedule("sch_paused", "SCH-5", "s-qa", state="paused", paused_reason="Paused by Binh", next_run_at="2026-03-07T02:00:00+00:00", created_by="Binh"),
        a_schedule("sch_ended", "SCH-2", "s-dev", state="ended", kind="once", run_at="2026-02-01T08:00", runs_count=1),
        a_schedule("sch_wait", "SCH-1", "s-paused", time="09:00", next_run_at="2026-03-07T09:00:00+00:00", window_end="11:00"),
        a_schedule("sch_ask", "SCH-3", "s-out", time="09:00", next_run_at="2026-03-09T09:00:00+00:00", catch_up="ask"),
        a_schedule("sch_lost", "SCH-9", "s-gone", time="09:00", next_run_at=None),
        a_schedule("sch_far", "SCO-1", "o-team", project_id="p-sch-other", time="19:10", next_run_at="2026-03-06T19:10:00+00:00"),
        a_schedule("sch_off", "SCP-1", "off-team", project_id="p-sch-off", time="19:10", next_run_at="2026-03-06T19:10:00+00:00"),
    ]
    rows += [
        # their slots so far
        a_slot(1, "sch_night", "SCH-1", "2026-03-05T19:00:00+00:00", "passed", member_id="s-dev", run_ids=json.dumps(["sb_6"]), attempts=1, note="Finished. All checks ran.",
               started_at="2026-03-05T19:00:05+00:00", ended_at="2026-03-05T19:10:05+00:00", duration_s=600, cost_usd=0.5),
        a_slot(2, "sch_night", "SCH-1", "2026-03-04T19:00:00+00:00", "failed", member_id="s-dev", run_ids=json.dumps(["sb_7", "sb_7"]), attempts=2, note="Run failed: exit 1. Retried, failed again.",
               started_at="2026-03-04T19:00:05+00:00", ended_at="2026-03-04T19:03:25+00:00", duration_s=200, cost_usd=0.25),
        a_slot(3, "sch_night", "SCH-1", "2026-03-03T19:00:00+00:00", "skipped", note="Skipped: Dev Team is paused. An Nguyen was told."),
        a_slot(4, "sch_night", "SCH-1", "2026-03-02T19:00:00+00:00", "partly", member_id="s-qa", run_ids=json.dumps(["sb_5"]), attempts=1, catch_up=True,
               note="Started 03:10 when it was back. Ran on the backup team, QA Team. The lead reported partial. Half of it.", started_at="2026-03-02T20:10:00+00:00",
               ended_at="2026-03-02T20:40:00+00:00", duration_s=1800, cost_usd=0.0),
        a_slot(5, "sch_night", "SCH-1", "2026-03-01T19:00:00+00:00", "cancelled", member_id="s-dev", run_ids=json.dumps(["sb_gone"]), attempts=1, note="Run cancelled by Binh."),
        a_slot(6, "sch_local", "SCH-6", "2026-03-06T02:00:00+00:00", "skipped", member_id="s-run", note="Skipped: Closed Team: the desktop app is closed. An Nguyen was told."),
        a_slot(7, "sch_local", "SCH-6", "2026-03-05T02:00:00+00:00", "passed", member_id="s-run", catch_up=True, note="Started 04:00 when it was back. Finished.", duration_s=30),
        a_slot(8, "sch_local", "SCH-6", "2026-03-04T02:00:00+00:00", "skipped", member_id="s-run", note="The app was offline."),
        a_slot(9, "sch_local", "SCH-6", "2026-03-03T02:00:00+00:00", "skipped", member_id="s-run", note=None),
        a_slot(10, "sch_wait", "SCH-1", "2026-03-06T09:00:00+00:00", "waiting", note="Waiting: Paused Team is paused. Starts when it is back, until 11:00. Then it is skipped."),
        a_slot(11, "sch_ask", "SCH-3", "2026-03-06T09:00:00+00:00", "ask", note="Signed-out Team is signed out. Run it late?"),
        a_slot(12, "sch_week", "SCH-4", "2026-03-02T08:00:00+00:00", "running", member_id="s-dev", run_ids=json.dumps(["sb_4"]), attempts=1, started_at="2026-03-02T08:00:01+00:00"),
        a_slot(13, "sch_far", "SCO-1", "2026-03-05T19:10:00+00:00", "passed", project_id="p-sch-other", member_id="o-team"),
    ]
    return rows


ASSESS = [
    ("An Nguyen", {}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-dev"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa"}),
    ("Binh", {"ticket_id": "SCH-1", "member_id": "s-qa"}),
    ("Vy", {"ticket_id": "SCH-1", "member_id": "s-qa"}),
    ("user", {"ticket_id": "SCH-1", "member_id": "s-qa"}),
    ("", {"ticket_id": "SCH-1", "member_id": "s-qa"}),
    ("A stranger", {"ticket_id": "SCH-1", "member_id": "s-qa"}),
    ("Bot Vy", {"ticket_id": "SCH-1", "member_id": "s-qa"}),
    ("Vy", {"member_id": "s-qa"}),
    ("An Nguyen", {"ticket_id": "SCH-2", "member_id": "s-qa"}),
    ("An Nguyen", {"ticket_id": "SCH-3", "member_id": "s-qa"}),
    ("An Nguyen", {"ticket_id": "SCO-1", "member_id": "s-qa"}),
    ("An Nguyen", {"ticket_id": "SCH-404", "member_id": "s-qa"}),
    ("An Nguyen", {"ticket_id": None, "member_id": None}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "o-team"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-gone"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-an"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-half"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-nobody"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-inbox"}),
    ("Vy", {"ticket_id": "SCH-1", "member_id": "s-inbox"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-paused"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-paused", "backup_member_id": "s-qa"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-paused", "catch_up": "skip"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-out"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-key"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-run", "catch_up_hours": 6.5}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-run", "catch_up": "ask"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-old"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-busy"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-capped"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-cloud"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-dev", "time": "19:20", "tz": "UTC"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-dev", "time": "02:59", "tz": "Asia/Ho_Chi_Minh", "days": [4, 5]}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-dev", "time": "03:00", "tz": "Asia/Ho_Chi_Minh"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-dev", "time": "14:30", "tz": "America/New_York", "days": [4]}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "backup_member_id": "s-qa"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "backup_member_id": "s-dev"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "backup_member_id": "s-inbox"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "backup_member_id": "o-team"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "backup_member_id": "s-half"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "backup_member_id": "s-gone"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "backup_member_id": ""}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "limits": {"stop_after_min": 4}}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "limits": {"stop_after_min": 5, "retries": 3}}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "limits": {"stop_after_min": 600, "retries": 4}}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "limits": {"stop_after_min": 601, "retries": -1}}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "limits": {"stop_after_min": None, "retries": None}}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "limits": {"stop_after_min": "90", "retries": "2"}}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "limits": {"stop_after_min": 59.9, "retries": 0.9}}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "limits": {"stop_after_min": "soon"}}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "catch_up": "later"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "catch_up": None}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "catch_up_hours": 0}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "catch_up_hours": 24}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "catch_up_hours": 24.5}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "catch_up_hours": -2}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "catch_up_hours": None}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "tz": "Mars/Olympus"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "tz": None}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "tz": ""}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "time": "25:00"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "time": None}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "time": "9"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "days": []}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "days": None, "time": "bad"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "days": [], "ends": "after"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "ends": "after", "ends_after": 0}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "ends": "after", "ends_after": -1}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "ends": "after", "ends_after": 2}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "ends": "on_date"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "ends": "on_date", "ends_on": ""}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "ends": "on_date", "ends_on": "2026-04-01"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "ends": "on_date", "ends_on": "2026-03-01"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "window_end": "06:00"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "window_end": "6"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "window_end": "06:00", "time": "x", "ends": "on_date"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "weekly"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": None}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "weekly", "window_end": "nope"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "soon"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-06T10:00:30+00:00"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-06T10:01:00+00:00"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-06T10:01:00.000001+00:00"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-06T10:00:00+00:00"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-06T09:59:00+00:00"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-01T23:30", "tz": "Asia/Ho_Chi_Minh"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-01T08:00", "tz": "Asia/Ho_Chi_Minh"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2025-11-02T01:30:00-05:00", "tz": "America/New_York"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2025-03-09T03:30", "tz": "America/New_York"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-07T02:30", "tz": "Asia/Ho_Chi_Minh"}),
    ("An Nguyen", {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-07T02:30", "tz": "Nowhere"}),
    ("An Nguyen", {"ticket_id": "SCH-6", "member_id": "s-run", "kind": "once", "run_at": "2026-03-07T02:30"}),
    ("An Nguyen", {"ticket_id": "SCH-6", "member_id": "s-run", "catch_up": "skip"}),
    ("An Nguyen", {"ticket_id": "SCH-6", "member_id": "s-run", "catch_up_hours": None}),
]
PREVIEWS = [
    ("An Nguyen", None, {}),
    ("An Nguyen", None, {"ticket_id": "SCH-1", "member_id": "s-qa"}),
    ("An Nguyen", None, {"ticket_id": "SCH-1", "member_id": "s-qa", "backup_member_id": "s-dev", "days": [5, 6], "time": "23:45", "tz": "America/New_York", "ends": "after", "ends_after": 3}),
    ("An Nguyen", None, {"ticket_id": "SCH-1", "member_id": "s-qa", "days": [0, 1, 2, 3, 4, 5, 6], "tz": "Asia/Kolkata", "ends": "on_date", "ends_on": "2026-03-08"}),
    ("An Nguyen", None, {"ticket_id": "SCH-1", "member_id": "s-qa", "days": [2], "time": "02:30", "tz": "Europe/Berlin"}),
    ("An Nguyen", None, {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-08T02:30", "tz": "America/New_York"}),
    ("An Nguyen", None, {"ticket_id": "SCH-1", "member_id": "s-qa", "kind": "once", "run_at": "2026-03-01T08:00"}),
    ("An Nguyen", None, {"ticket_id": "SCH-1", "member_id": "s-qa", "time": "25:00"}),
    ("An Nguyen", None, {"ticket_id": "SCH-1", "member_id": "s-qa", "ends": "after"}),
    ("An Nguyen", None, {"ticket_id": "SCH-1", "member_id": "", "days": [0]}),
    ("An Nguyen", None, {"ticket_id": None, "member_id": "s-qa", "days": [0]}),
    ("An Nguyen", None, {"ticket_id": "SCH-2", "member_id": "s-gone", "limits": {"retries": 9}}),
    ("Vy", None, {"ticket_id": "SCH-1", "member_id": "s-dev"}),
    ("Binh", "sch_night", {}),
    ("Binh", "sch_night", {"time": "19:30", "tz": "UTC", "backup_member_id": None}),
    ("Binh", "sch_once", {"run_at": "2026-03-09T08:00"}),
    ("Binh", "sch_ended", {}),
    ("Binh", "sch_nope", {"ticket_id": "SCH-1", "member_id": "s-qa"}),
    ("Binh", "", {"ticket_id": "SCH-1", "member_id": "s-qa", "days": [6]}),
    ("An Nguyen", "sch_far", {}),
]


async def board():
    res: dict = {"rows": await put(board_rows())}
    async with database.async_session() as session:
        res["role_of"] = [
            {"project_id": project, "person": person, "out": await schedules.role_of(session, project, person)}
            for project in (P, "p-sch-other", "p-nope")
            for person in ("", "user", "An Nguyen", "Binh", "Vy", "vy", "Bot Vy", "Dev Team", "A stranger")
        ]
        res["availability"] = [
            {"member_id": m, "project_id": project, "out": list(await schedules.availability(session, m, project))}
            for project, members in (
                (P, [None, "", "s-dev", "s-qa", "s-paused", "s-inbox", "s-out", "s-key", "s-run", "s-old", "s-busy", "s-capped", "s-cloud", "s-gone", "s-half", "s-an", "s-nobody", "o-team"]),
                ("p-sch-off", ["off-team", "s-dev", "s-paused"]),
                ("p-sch-fresh", ["s-dev"]),
            )
            for m in members
        ]
        checks = []
        for by, data in ASSESS:
            s = AiSchedule(project_id=P, ticket_id="", member_id="", created_by=by, id="sch_new")
            got = None
            try:
                schedules._apply(s, data)
                got = {"ok": await schedules.assess(session, s, by, now=NOW)}
            except schedules.ScheduleError as exc:
                got = {"error": [exc.code, str(exc), exc.extra]}
            except Exception as exc:  # noqa: BLE001
                got = {"raises": type(exc).__name__}
            checks.append({"by": by, "data": data, "out": got})
        res["assess"] = checks
        stored = (await session.exec(select(AiSchedule).order_by(col(AiSchedule.id)))).all()
        res["assess_stored"] = [{"id": s.id, "out": await attempt_async(schedules.assess(session, s, s.created_by))} for s in stored]
        res["preview"] = [
            {"by": by, "schedule_id": sid, "data": data, "out": await attempt_async(schedules.preview(session, P, data, by, sid))} for by, sid, data in PREVIEWS
        ]
        res["summary_text"] = [{"id": s.id, "out": await attempt_async(schedules.summary_text(session, s))} for s in stored]
        dicts = []
        for s in stored:
            got = await schedules.to_dict(session, s)
            dicts.append({"id": s.id, "out": got, "keys": list(got)})
        res["to_dict"] = dicts
        last = await session.get(AiScheduleRun, "sl_03")
        res["to_dict_last"] = await schedules.to_dict(session, stored[0], last=last)
        res["list_for"] = [
            {"project_id": project, "ticket_id": ticket, "out": await schedules.list_for(session, project, ticket_id=ticket)}
            for project, ticket in ((P, None), (P, "SCH-1"), (P, "SCH-4"), (P, "SCH-404"), (P, ""), ("p-sch-other", None), ("p-sch-off", None), ("p-sch-empty", None))
        ]
        res["history"] = [
            {"project_id": project, "schedule_id": sid, "limit": limit, "out": await schedules.history(session, project, schedule_id=sid, limit=limit)}
            for project, sid, limit in ((P, None, 50), (P, None, 3), (P, "sch_night", 50), (P, "sch_local", 2), (P, "sch_nope", 50), (P, "", 50), ("p-sch-other", None, 50), ("p-sch-empty", None, 50))
        ]
        details = []
        for s in stored:
            got = await attempt_async(schedules.detail(session, s.id))
            details.append({"id": s.id, "out": got, "keys": list(got.get("ok") or {})})
        details.append({"id": "sch_nope", "out": await attempt_async(schedules.detail(session, "sch_nope")), "keys": []})
        res["detail"] = details
        weeks = []
        for project, start, days in (
            (P, "2026-03-06T00:00:00+00:00", 7), (P, "2026-03-02T00:00:00+00:00", 7), (P, "2026-03-06T10:00:00+00:00", 1), (P, "2026-03-01T00:00:00+00:00", 31),
            (P, "2026-03-27T00:00:00+00:00", 3), ("p-sch-other", "2026-03-06T00:00:00+00:00", 7), ("p-sch-off", "2026-03-06T00:00:00+00:00", 2), ("p-sch-empty", "2026-03-06T00:00:00+00:00", 7),
        ):
            got = await schedules.week(session, project, at(start), days)
            got["members"] = sorted(got["members"], key=lambda m: m["id"])  # (Python lists them in the order of a set)
            weeks.append({"project_id": project, "start": start, "days": days, "out": got})
        res["week"] = weeks
        res["for_tickets"] = {project: await schedules.for_tickets(session, project) for project in (P, "p-sch-other", "p-sch-off", "p-sch-empty")}
    return res


# ---------------------------------------------------------------------------------------------------------------------
# what both the editing steps and the stories look at afterwards
# ---------------------------------------------------------------------------------------------------------------------
SEEN = {"events": 0, "notes": 0}


async def snapshot(project_id):
    """The schedules, slots and runs of a project, the Activity its tickets got from schedules, and what was told
    since the last look (the feed, the notifications)."""
    await notifications.flush_pending()
    async with database.async_session() as session:
        scheds = (await session.exec(select(AiSchedule).where(AiSchedule.project_id == project_id).order_by(col(AiSchedule.id)))).all()
        slots = (await session.exec(select(AiScheduleRun).where(AiScheduleRun.project_id == project_id).order_by(col(AiScheduleRun.schedule_id), col(AiScheduleRun.slot_at)))).all()
        runs = (await session.exec(select(AiRun).where(AiRun.project_id == project_id).order_by(col(AiRun.ticket_id), col(AiRun.number)))).all()
        tickets = (await session.exec(select(Ticket).where(Ticket.project_id == project_id).order_by(col(Ticket.id)))).all()
        notes = (await session.exec(select(NotifyEvent).where(NotifyEvent.project_id == project_id, col(NotifyEvent.id) > SEEN["notes"]).order_by(col(NotifyEvent.id)))).all()
    run_name = {r.id: f"{r.ticket_id}#{r.number}" for r in runs}
    slot_name = {s.id: f"{s.schedule_id}@{s.slot_at}" for s in slots}

    def named(value):
        if isinstance(value, str):
            return run_name.get(value) or slot_name.get(value) or value
        if isinstance(value, list):
            return [named(v) for v in value]
        if isinstance(value, dict):
            return {k: named(v) for k, v in value.items()}
        return value

    feed = [e for e in schedules.events_since(project_id, SEEN["events"])]
    if feed:
        SEEN["events"] = feed[-1]["id"]
    if notes:
        SEEN["notes"] = notes[-1].id
    return {
        "schedules": [
            {"id": s.id, "state": s.state, "paused_reason": s.paused_reason, "failures_in_row": s.failures_in_row, "runs_count": s.runs_count, "next_run_at": s.next_run_at,
             "ticket_seen_at": s.ticket_seen_at}
            for s in scheds
        ],
        "slots": [
            {"slot": slot_name[r.id], "state": r.state, "catch_up": r.catch_up, "member_id": r.member_id, "runs": named(json.loads(r.run_ids)), "attempts": r.attempts, "note": r.note,
             "started": r.started_at is not None, "ended": r.ended_at is not None, "cost_usd": r.cost_usd}
            for r in slots
        ],
        "runs": [
            {"run": run_name[r.id], "member_id": r.member_id, "state": r.state, "kind": r.kind, "trigger": r.trigger, "started_by": r.started_by, "instruction": r.instruction,
             "session_id": r.session_id, "ended_by": r.ended_by, "ended_reason": r.ended_reason, "stop_code": r.stop_code}
            for r in runs
        ],
        "activity": {t.id: [{"actor": e.get("actor"), "to": e.get("to")} for e in json.loads(t.activity_log or "[]") if e.get("field") == "ai_schedule"] for t in tickets},
        "feed": [named({k: v for k, v in e.items() if k not in ("id", "at")}) for e in feed],
        "notifications": [
            {"kind": n.kind, "needs": n.needs, "title": n.title, "body": n.body, "target_kind": n.target_kind, "target_id": named(n.target_id), "ticket_id": n.ticket_id,
             "member_id": n.member_id, "data": named(json.loads(n.data or "{}")), "recipients": json.loads(n.recipients or "[]")}
            for n in notes
        ],
    }


# ---------------------------------------------------------------------------------------------------------------------
# create, change, pause, delete
# ---------------------------------------------------------------------------------------------------------------------
EDITS = [
    {"call": "create", "by": "An Nguyen", "data": {"ticket_id": "ED-1", "member_id": "e-dev"}},
    {"call": "create", "by": "Binh", "data": {"ticket_id": "ED-1", "member_id": "e-dev", "backup_member_id": "e-qa", "kind": "once", "run_at": "2026-03-08T02:30", "tz": "America/New_York",
                                              "notify": ["failed"], "notify_people": ["An Nguyen"], "limits": {"retries": 0}, "instruction": "Once only."}},
    {"call": "create", "by": "Binh", "data": {"ticket_id": "ED-1", "member_id": "e-dev", "days": [5, 6], "time": "07:05", "tz": "Asia/Ho_Chi_Minh", "ends": "after", "ends_after": 2,
                                              "window_end": "", "catch_up": "ask", "catch_up_hours": 12}},
    {"call": "create", "by": "Vy", "data": {"ticket_id": "ED-1", "member_id": "e-dev"}},
    {"call": "create", "by": "An Nguyen", "data": {"ticket_id": "ED-2", "member_id": "e-dev", "time": "25:00", "limits": {"retries": 7}}},
    {"call": "create", "by": "An Nguyen", "data": {"ticket_id": "ED-1", "member_id": "e-dev", "days": []}},
    {"call": "create", "by": "An Nguyen", "data": {}},
    {"call": "create", "by": "An Nguyen", "data": {"ticket_id": "ED-1", "member_id": "e-dev", "kind": "once", "run_at": "2026-03-01T08:00"}},
    {"call": "create", "by": "An Nguyen", "data": {"ticket_id": "ED-1", "member_id": "e-dev", "ends": "on_date", "ends_on": "2026-03-01"}},
    {"call": "create", "by": "An Nguyen", "data": {"ticket_id": "ED-1", "member_id": "e-dev", "tz": None}},
    {"call": "create", "by": "An Nguyen", "data": {"ticket_id": "ED-1", "member_id": "e-qa", "kind": "once", "run_at": "2026-03-09T08:00", "time": None, "ends": None, "instruction": None,
                                                   "backup_member_id": None}},
    {"call": "create", "by": "An Nguyen", "data": {"ticket_id": "ED-1", "member_id": "e-dev", "kind": None, "catch_up": None, "catch_up_hours": None}},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"time": "23:15", "tz": "Europe/Berlin", "days": [0, 3]}},
    {"call": "update", "id": 0, "by": "Binh", "data": {"time": "23:16"}},
    {"call": "update", "id": 0, "by": "Vy", "data": {"time": "23:17"}},
    {"call": "update", "id": 0, "by": "user", "data": {"instruction": "By the board's own user."}},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"ticket_id": "ED-2"}},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"ticket_id": None}},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"ticket_id": "ED-1", "member_id": "e-qa"}},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"time": "bad"}},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"days": []}},
    {"call": "update", "id": "sch_nope", "by": "An Nguyen", "data": {"time": "01:00"}},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"tz": None}},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"instruction": None}},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"time": None}},
    {"call": "set_paused", "id": 0, "by": "Binh", "paused": True, "reason": None},
    {"call": "set_paused", "id": 0, "by": "An Nguyen", "paused": True, "reason": None},
    {"call": "update", "id": 0, "by": "An Nguyen", "data": {"time": "06:00"}},
    {"call": "set_paused", "id": 0, "by": "An Nguyen", "paused": True, "reason": "Holiday"},
    {"call": "set_paused", "id": 0, "by": "An Nguyen", "paused": False, "reason": None},
    {"call": "set_paused", "id": 2, "by": "Binh", "paused": True, "reason": ""},
    {"call": "set_paused", "id": 2, "by": "user", "paused": False, "reason": "ignored"},
    {"call": "set_paused", "id": "sch_nope", "by": "user", "paused": False, "reason": None},
    # a one-off whose time is past ends when it is edited into nothing, and wakes again when it is given a time
    {"call": "update", "id": 1, "by": "Binh", "data": {"notify_people": []}},
    {"call": "end", "id": 1},
    {"call": "set_paused", "id": 1, "by": "Binh", "paused": False, "reason": None},
    {"call": "update", "id": 1, "by": "Binh", "data": {"run_at": "2026-03-10T08:00:00+07:00"}},
    {"call": "delete", "id": 1, "by": "An Nguyen"},
    {"call": "delete", "id": 1, "by": "An Nguyen"},
    {"call": "delete", "id": 2, "by": "Vy"},
    {"call": "delete", "id": 2, "by": "Binh"},
    {"call": "get_or_404", "id": 0},
    {"call": "get_or_404", "id": 2},
]


async def editing():
    PE = "p-edit-sch"
    rows = [
        Project(id=PE, name="Editing", prefix="ED", color="#2E6F40"),
        AiProjectSettings(project_id=PE, updated_at=STAMP),
        Member(id="e-an", project_id=PE, name="An Nguyen", color="#3B82F6", role="admin", created_at=STAMP),
        Member(id="e-binh", project_id=PE, name="Binh", color="#3B82F6", created_at=STAMP),
        Member(id="e-vy", project_id=PE, name="Vy", color="#3B82F6", role="viewer", created_at=STAMP),
        *team("e-dev", "Edit Team", project=PE),
        *team("e-qa", "Edit QA", project=PE),
        Ticket(id="ED-1", project_id=PE, title="Edited", status="todo", created_at=STAMP, updated_at="2026-03-05T00:00:00+00:00"),
        Ticket(id="ED-2", project_id=PE, title="Other", status="todo", created_at=STAMP, updated_at=STAMP),
    ]
    res: dict = {"rows": await put(rows)}
    await snapshot(PE)
    made: list[str] = []
    steps = []
    for step in EDITS:
        sid = step.get("id")
        sid = made[sid] if isinstance(sid, int) else sid
        async with database.async_session() as session:
            try:
                if step["call"] == "create":
                    s = await schedules.create(session, PE, step["data"], step["by"])
                    made.append(s.id)
                    got = {"ok": row_dict(s)}
                elif step["call"] == "update":
                    got = {"ok": row_dict(await schedules.update(session, sid, step["data"], step["by"]))}
                elif step["call"] == "set_paused":
                    got = {"ok": row_dict(await schedules.set_paused(session, sid, step["paused"], step["by"], step["reason"]))}
                elif step["call"] == "delete":
                    got = {"ok": await schedules.delete(session, sid, step["by"])}
                elif step["call"] == "get_or_404":
                    got = {"ok": row_dict(await schedules.get_or_404(session, sid))}
                else:  # the story's own hand: the schedule has ended
                    s = await session.get(AiSchedule, sid)
                    s.state, s.next_run_at = "ended", None
                    session.add(s)
                    await session.commit()
                    got = {"ok": None}
            except schedules.ScheduleError as exc:
                got = {"error": [exc.code, str(exc), exc.extra]}
            except Exception as exc:  # noqa: BLE001
                got = {"raises": type(exc).__name__}
        steps.append({**step, "out": got, "after": await snapshot(PE)})
    res["steps"] = steps
    return res


# ---------------------------------------------------------------------------------------------------------------------
# the loop, one tick at a time
# ---------------------------------------------------------------------------------------------------------------------
T0 = "2026-03-06T10:00:00+00:00"


def later(**kw) -> str:
    return (NOW + timedelta(**kw)).isoformat()


def due(sid, ticket, member, **kw):
    """A schedule whose next start is T0 (every day at 10:00 UTC unless the story says otherwise)."""
    kw.setdefault("time", "10:00")
    kw.setdefault("days", "[0, 1, 2, 3, 4, 5, 6]")
    kw.setdefault("next_run_at", T0)
    return a_schedule(sid, ticket, member, **kw)


STORY_KEYS: list = []


def story_rows(key, schedules_, *, teams=("dev",), tickets=("1",), extra=(), foreign=()):
    pid = f"p-st-{key}"
    STORY_KEYS.append(key)
    rows: list = [
        Project(id=pid, name=f"Story {key}", prefix=f"ST{len(STORY_KEYS):02d}", color="#2E6F40"),
        AiProjectSettings(project_id=pid, updated_at=STAMP),
        Member(id=f"{key}-an", project_id=pid, name="An Nguyen", color="#3B82F6", role="admin", created_at=STAMP),
        Member(id=f"{key}-binh", project_id=pid, name="Binh", color="#3B82F6", created_at=STAMP),
    ]
    for t in teams:
        rows += team(f"{key}-{t}", f"{t.title()} Team", project=pid)
    for t in tickets:
        rows.append(Ticket(id=f"{key.upper()}-{t}", project_id=pid, title=f"Ticket {t}", status="todo", created_at=STAMP, updated_at=STAMP))
    for s in schedules_:
        s.project_id = pid
        rows.append(s)
    for r in extra:
        r.project_id = pid
        rows.append(r)
    rows += list(foreign)  # rows of another project
    return pid, rows


def tick(when):
    return {"op": "tick", "now": when}


def run_set(run, **fields):
    return {"op": "run", "run": run, "set": fields}


STORIES: list = []


def story(key, title, schedules_, steps, **kw):
    STORIES.append((key, title, schedules_, steps, kw))


FINE_REPORT = json.dumps({"status": "done", "summary": "Fixed  add()\nand added tests.", "branch": "ai/a-1"})
story("ontime", "a slot starts on time, the run finishes, the next day it starts again",
      [due("st_ontime", "ONTIME-1", "ontime-dev", limits=json.dumps({"stop_after_min": 30}), instruction="  Run the checks.  ")],
      [tick(T0), tick(later(seconds=20)), run_set("ONTIME-1#1", state="running", started_at=later(seconds=30)), tick(later(minutes=5)),
       run_set("ONTIME-1#1", state="finished", ended_at=later(minutes=9), summary="Fixed add().", report=FINE_REPORT, cost_usd=0.25), tick(later(minutes=10)), tick(later(minutes=11)),
       tick(later(days=1, seconds=10)), run_set("ONTIME-1#2", state="finished", report=json.dumps({"status": "partial", "summary": "Half."}), cost_usd=0.5), tick(later(days=1, minutes=3)),
       tick(later(days=2)), run_set("ONTIME-1#3", state="finished", report="", summary=None), tick(later(days=2, minutes=1))])
story("late", "a slot that was missed starts late, inside its catch-up time",
      [due("st_late", "LATE-1", "late-dev", tz="Asia/Ho_Chi_Minh", time="17:00")],
      [tick(later(minutes=5)), run_set("LATE-1#1", state="finished", summary="Done late."), tick(later(minutes=6))])
story("later", "a slot five minutes and a moment late is a catch-up", [due("st_later", "LATER-1", "later-dev", tz="Asia/Ho_Chi_Minh", time="17:00")],
      [tick(later(minutes=5, seconds=1)), run_set("LATER-1#1", state="finished", summary="Done late."), tick(later(minutes=9))])
story("missed", "a slot missed for longer than its catch-up time is skipped", [due("st_missed", "MISSED-1", "missed-dev")], [tick(later(hours=2, seconds=1)), tick(later(hours=3))])
story("edge", "exactly at the end of the catch-up time it still starts", [due("st_edge", "EDGE-1", "edge-dev", catch_up_hours=0.5)], [tick(later(minutes=30))])
story("window", "the allowed window ends the wait instead of the catch-up hours",
      [due("st_window", "WINDOW-1", "window-dev", window_end="10:20", catch_up_hours=6), due("st_window2", "WINDOW-2", "window-dev", window_end="09:00", catch_up_hours=0.1)],
      [tick(later(minutes=21))], tickets=("1", "2"))
story("paused", "the team is paused: the slot waits, starts when the team is back",
      [due("st_paused", "PAUSED-1", "paused-dev", tz="Asia/Ho_Chi_Minh", time="17:00")],
      [{"op": "team", "id": "paused-dev", "set": {"paused": True}}, tick(T0), tick(later(minutes=1)), {"op": "team", "id": "paused-dev", "set": {"paused": False}}, tick(later(minutes=40)),
       run_set("PAUSED-1#1", state="finished", summary="Back."), tick(later(minutes=50))])
story("gaveup", "the team stays away longer than the catch-up time: the slot is skipped and people are told",
      [due("st_gaveup", "GAVEUP-1", "gaveup-dev", notify_people=json.dumps(["Binh"]))],
      [{"op": "team", "id": "gaveup-dev", "set": {"health": "runner_missing"}}, tick(T0), tick(later(hours=2)), tick(later(hours=2, seconds=1)), tick(later(hours=3))])
story("skiprule", "with the rule skip a team that cannot start is not waited for",
      [due("st_skiprule", "SKIPRULE-1", "skiprule-dev", catch_up="skip", notify=json.dumps(["finished"]))],
      [{"op": "team", "id": "skiprule-dev", "set": {"health": "not_logged_in"}}, tick(T0)])
story("askrule", "with the rule ask a slot waits for a person, who skips it; the next one is run late by a person",
      [due("st_askrule", "ASKRULE-1", "askrule-dev", catch_up="ask")],
      [{"op": "team", "id": "askrule-dev", "set": {"paused": True}}, tick(T0), tick(later(minutes=1)),
       {"op": "slot_action", "slot": f"st_askrule@{T0}", "action": "start", "by": "An Nguyen"},
       {"op": "slot_action", "slot": f"st_askrule@{T0}", "action": "dance", "by": "An Nguyen"},
       {"op": "slot_action", "slot": f"st_askrule@{T0}", "action": "skip", "by": "Binh"},
       {"op": "slot_action", "slot": f"st_askrule@{T0}", "action": "skip", "by": "An Nguyen"},
       {"op": "slot_action", "slot": f"st_askrule@{T0}", "action": "start", "by": "An Nguyen"},
       {"op": "slot_action", "slot": "sl_nope", "action": "skip", "by": "An Nguyen"},
       {"op": "team", "id": "askrule-dev", "set": {"paused": False}},
       tick(later(days=1, minutes=6)), tick(later(days=1, minutes=7)),
       {"op": "slot_action", "slot": f"st_askrule@{later(days=1)}", "action": "start", "by": "An Nguyen"},
       run_set("ASKRULE-1#1", state="finished", summary="Late but done."), tick(later(days=1, minutes=20))])
story("backup", "the team cannot start and the backup team runs the slot; a person can send it to a third team",
      [due("st_backup", "BACKUP-1", "backup-dev", backup_member_id="backup-qa"), due("st_backup2", "BACKUP-2", "backup-dev", backup_member_id="backup-qa", catch_up="ask")],
      [{"op": "team", "id": "backup-dev", "set": {"paused": True}}, tick(later(minutes=6)), {"op": "team", "id": "backup-qa", "set": {"paused": True}}, tick(later(days=1)),
       {"op": "slot_action", "slot": f"st_backup2@{later(days=1)}", "action": "use_member", "by": "An Nguyen", "member_id": "backup-ops"},
       {"op": "slot_action", "slot": f"st_backup@{later(days=1)}", "action": "use_member", "by": "An Nguyen", "member_id": "backup-qa"}],
      teams=("dev", "qa", "ops"), tickets=("1", "2"))
story("closed", "a ticket that is closed, or gone, takes its slot with it",
      [due("st_done", "CLOSED-1", "closed-dev"), due("st_wont", "CLOSED-2", "closed-dev"), due("st_gone", "CLOSED-9", "closed-dev"), due("st_held", "CLOSED-3", "closed-dev", state="active")],
      [{"op": "ticket", "id": "CLOSED-1", "set": {"status": "done"}}, {"op": "ticket", "id": "CLOSED-2", "set": {"status": "wont_do"}}, tick(T0),
       {"op": "set_paused", "id": "st_held", "paused": True, "by": "An Nguyen"}, tick(later(days=1))],
      tickets=("1", "2", "3"))
story("pausedslot", "a slot that waits when its schedule is paused does not start behind the person's back",
      [due("st_pausedslot", "PAUSEDSLOT-1", "pausedslot-dev")],
      [{"op": "team", "id": "pausedslot-dev", "set": {"paused": True}}, tick(T0), {"op": "set_paused", "id": "st_pausedslot", "paused": True, "by": "An Nguyen"},
       {"op": "team", "id": "pausedslot-dev", "set": {"paused": False}}, tick(later(minutes=1)), {"op": "run_now", "id": "st_pausedslot", "by": "An Nguyen"}])
story("viewer", "the person who made the schedule may no longer assign the team: it is paused",
      [due("st_viewer", "VIEWER-1", "viewer-dev", created_by="Binh")],
      [{"op": "member", "id": "viewer-binh", "set": {"role": "viewer"}}, tick(T0), tick(later(days=1))])
story("conflict", "the ticket already has a run going: the slot waits for it",
      [due("st_conflict", "CONFLICT-1", "conflict-dev")],
      [tick(T0), run_set("CONFLICT-1#1", state="finished"), tick(later(minutes=1)), run_set("CONFLICT-1#2", state="finished", summary="After the other."), tick(later(minutes=2))],
      extra=[AiRun(id="st_conflict_r1", project_id="", member_id="conflict-dev", ticket_id="CONFLICT-1", number=1, state="running", queued_at=ago(minutes=5), started_at=ago(minutes=5))])
story("removed", "the team was removed: the run cannot be made and the slot is skipped",
      [due("st_removed", "REMOVED-1", "removed-dev", catch_up="run"), due("st_removed2", "REMOVED-2", "removed-dev", backup_member_id="removed-qa")],
      [{"op": "member", "id": "removed-dev", "set": {"kind": "ai_removed"}}, tick(T0)], teams=("dev", "qa"), tickets=("1", "2"))
story("retry", "a run that fails is started again once; the second failure ends the slot",
      [due("st_retry", "RETRY-1", "retry-dev")],
      [tick(T0), run_set("RETRY-1#1", state="failed", ended_reason="The CLI ended with exit code 1.", session_id="sess-retry", ended_at=later(minutes=2)), tick(later(minutes=3)),
       tick(later(minutes=4)), run_set("RETRY-1#2", state="timed_out", ended_reason=None), tick(later(minutes=5)), tick(later(minutes=6))])
story("noretry", "with no retries three failed slots in a row pause the schedule",
      [due("st_noretry", "NORETRY-1", "noretry-dev", limits=json.dumps({"retries": 0}), notify_people=json.dumps(["Binh", "An Nguyen"]))],
      [tick(T0), run_set("NORETRY-1#1", state="failed", ended_reason="exit 1"), tick(later(minutes=1)),
       tick(later(days=1)), run_set("NORETRY-1#2", state="failed", ended_reason=""), tick(later(days=1, minutes=1)),
       tick(later(days=2)), run_set("NORETRY-1#3", state="timed_out", ended_reason="No output for 30 minutes."), tick(later(days=2, minutes=1)), tick(later(days=3)),
       {"op": "set_paused", "id": "st_noretry", "paused": False, "by": "An Nguyen"}, tick(later(days=4)), run_set("NORETRY-1#4", state="finished", summary="Fine again."),
       tick(later(days=4, minutes=1))])
story("retrypaused", "a failed run is not started again behind a paused schedule, nor after the board closed past its time",
      [due("st_rp", "RETRYPAUSED-1", "retrypaused-dev", limits=json.dumps({"retries": 3})), due("st_rb", "RETRYPAUSED-2", "retrypaused-qa", limits=json.dumps({"retries": 3}), catch_up_hours=1),
       due("st_rc", "RETRYPAUSED-3", "retrypaused-ops", limits=json.dumps({"retries": "2"}), catch_up_hours=1)],
      [tick(T0), run_set("RETRYPAUSED-1#1", state="failed", ended_reason="exit 1"), run_set("RETRYPAUSED-2#1", state="failed", ended_reason="The board closed.", ended_by="board"),
       run_set("RETRYPAUSED-3#1", state="failed", ended_reason="The board closed.", ended_by="board", session_id="sess-rc"),
       {"op": "set_paused", "id": "st_rp", "paused": True, "by": "An Nguyen"}, tick(later(minutes=59)),
       run_set("RETRYPAUSED-3#2", state="failed", ended_reason="The board closed.", ended_by="board"), tick(later(hours=1, seconds=1))],
      teams=("dev", "qa", "ops"), tickets=("1", "2", "3"))
story("cancelled", "a person cancels the run: the slot is cancelled; a run the schedule cancelled is left alone; a lost run fails the slot",
      [due("st_c1", "CANCELLED-1", "cancelled-dev"), due("st_c2", "CANCELLED-2", "cancelled-qa"), due("st_c3", "CANCELLED-3", "cancelled-ops"), due("st_c4", "CANCELLED-4", "cancelled-sec")],
      [tick(T0), run_set("CANCELLED-1#1", state="cancelled", ended_by="Binh"), run_set("CANCELLED-2#1", state="cancelled", ended_by=None), run_set("CANCELLED-3#1", state="cancelled", ended_by="schedule"),
       {"op": "lose_run", "run": "CANCELLED-4#1"}, tick(later(minutes=1))],
      teams=("dev", "qa", "ops", "sec"), tickets=("1", "2", "3", "4"))
story("queue", "a run that finds no free run for half an hour is cancelled and its slot skipped",
      [due("st_queue", "QUEUE-1", "queue-dev")],
      [tick(T0), {"op": "run", "run": "QUEUE-1#1", "set": {"queued_at": later(seconds=0)}}, tick(later(minutes=30)), tick(later(minutes=30, seconds=1)), tick(later(minutes=31))])
story("asks", "a run that needs input is told once; it is not held to the time limit while it waits",
      [due("st_asks", "ASKS-1", "asks-dev", limits=json.dumps({"stop_after_min": 5}))],
      [tick(T0), run_set("ASKS-1#1", state="needs_input", started_at=T0), tick(later(minutes=1)), tick(later(minutes=2)), tick(later(hours=3)),
       run_set("ASKS-1#1", state="finished", report=json.dumps({"status": "question", "summary": ""})), tick(later(hours=4))])
story("overtime", "a run over its time limit: the tick stops there (the cancel call is refused), and every tick after it",
      [due("st_over", "OVERTIME-1", "overtime-dev", limits=json.dumps({"stop_after_min": 5})), due("st_over2", "OVERTIME-2", "overtime-qa")],
      [tick(T0), run_set("OVERTIME-1#1", state="running", started_at=T0), run_set("OVERTIME-2#1", state="finished", summary="Never looked at."), tick(later(minutes=5)),
       tick(later(minutes=5, seconds=1)), tick(later(minutes=6))],
      teams=("dev", "qa"), tickets=("1", "2"))
story("overcost", "a metered run over its cost limit: the same refusal",
      [due("st_cost", "OVERCOST-1", "overcost-dev", limits=json.dumps({"max_cost": "1.50"}))],
      [tick(T0), run_set("OVERCOST-1#1", state="running", started_at=T0, cost_usd=1.5), tick(later(minutes=1)), run_set("OVERCOST-1#1", metered=True, cost_usd=1.49), tick(later(minutes=2)),
       run_set("OVERCOST-1#1", cost_usd=1.5), tick(later(minutes=3))])
story("again", "a slot that was already opened (the board restarted) is not opened twice",
      [due("st_again", "AGAIN-1", "again-dev", runs_count=3)],
      [tick(T0), tick(later(days=1))],
      extra=[AiScheduleRun(id="sl_again", schedule_id="st_again", project_id="", ticket_id="AGAIN-1", slot_at=T0, state="passed", created_at=STAMP, updated_at=STAMP)])
story("once", "a one-off schedule ends when its slot is over",
      [a_schedule("st_once1", "ONCE-1", "once-dev", kind="once", run_at="2026-03-06T17:00", tz="Asia/Ho_Chi_Minh", next_run_at=T0)],
      [tick(T0), tick(later(minutes=1)), run_set("ONCE-1#1", state="finished", summary="Once."), tick(later(minutes=2)), tick(later(days=1))])
story("lastrun", "a schedule that ends after two runs", [due("st_last", "LASTRUN-1", "lastrun-dev", ends="after", ends_after=2, runs_count=1)],
      [tick(T0), run_set("LASTRUN-1#1", state="failed", ended_reason="exit 1"), tick(later(minutes=1)), run_set("LASTRUN-1#2", state="failed", ended_reason="exit 1"), tick(later(minutes=2)),
       tick(later(days=2))])
story("runnow", "run now: a slot outside the plan; one at a time; a team that cannot start says why",
      [due("st_rn", "RUNNOW-1", "runnow-dev", next_run_at=later(days=3), created_by="Binh"), due("st_rn2", "RUNNOW-2", "runnow-qa", next_run_at=later(days=3)),
       due("st_rn3", "RUNNOW-3", "runnow-ops", next_run_at=later(days=3))],
      [{"op": "run_now", "id": "st_rn", "by": "Vy"}, {"op": "run_now", "id": "st_rn", "by": "Binh"}, {"op": "run_now", "id": "st_rn", "by": "An Nguyen"},
       {"op": "run_now", "id": "st_nope", "by": "An Nguyen"}, {"op": "team", "id": "runnow-qa", "set": {"paused": True}}, {"op": "run_now", "id": "st_rn2", "by": "An Nguyen"},
       {"op": "run_now", "id": "st_rn3", "by": "An Nguyen"}, tick(later(minutes=1)), run_set("RUNNOW-1#1", state="finished", summary="By hand."), tick(later(minutes=2))],
      teams=("dev", "qa", "ops"), tickets=("1", "2", "3"),
      extra=[AiRun(id="st_runnow_r1", project_id="", member_id="runnow-ops", ticket_id="RUNNOW-3", number=1, state="needs_input", queued_at=ago(minutes=5), started_at=ago(minutes=5)),
             Member(id="runnow-vy", project_id="", name="Vy", color="#3B82F6", role="viewer", created_at=STAMP)])
story("quiet", "a schedule that tells nobody still keeps its slots and the ticket's Activity",
      [due("st_quiet", "QUIET-1", "quiet-dev", notify="[]"), due("st_quiet2", "QUIET-2", "quiet-qa", notify=json.dumps(["needs_input"]), notify_people=json.dumps(["Binh"]))],
      [tick(T0), run_set("QUIET-1#1", state="failed", ended_reason="exit 1"), run_set("QUIET-2#1", state="needs_input"), tick(later(minutes=1)), tick(later(hours=3))],
      teams=("dev", "qa"), tickets=("1", "2"))
story("foreign", "the team is of another project: the run is refused, the slot skipped; by hand the refusal is the answer",
      [due("st_foreign", "FOREIGN-1", "elsewhere-team"), due("st_foreign2", "FOREIGN-2", "elsewhere-team", next_run_at=later(days=3))],
      [tick(T0), {"op": "run_now", "id": "st_foreign2", "by": "An Nguyen"}, tick(later(minutes=1))], tickets=("1", "2"),
      foreign=[Project(id="p-st-elsewhere", name="Elsewhere", prefix="STELSE", color="#2E6F40"), *team("elsewhere-team", "Far Team", project="p-st-elsewhere")])
story("norestart", "a failed run cannot be started again (its team was removed): the slot fails",
      [due("st_norestart", "NORESTART-1", "norestart-dev")],
      [tick(T0), run_set("NORESTART-1#1", state="failed", ended_reason="exit 1"), {"op": "member", "id": "norestart-dev", "set": {"kind": "ai_removed"}}, tick(later(minutes=1)),
       tick(later(minutes=2))])
story("badzone", "a schedule whose time zone is not one stops the tick", [due("st_badzone", "BADZONE-1", "badzone-dev", tz="Mars/Olympus")], [tick(T0)])


async def stories():
    done = []
    for key, title, schedules_, steps, kw in STORIES:
        pid, rows = story_rows(key, schedules_, **kw)
        schedules.RT = schedules._Runtime()
        SEEN["events"] = 0
        # the loop looks at every schedule and slot there is: each story starts with none but its own
        async with database.async_session() as session:
            for model in (AiSchedule, AiScheduleRun, AiRun):
                await session.exec(sql_delete(model))
            await session.commit()
        dumped = await put(rows)
        CLOCK["now"] = NOW
        await snapshot(pid)
        log = []
        for step in steps:
            got = None
            async with database.async_session() as session:
                runs = (await session.exec(select(AiRun).where(AiRun.project_id == pid))).all()
                slots = (await session.exec(select(AiScheduleRun).where(AiScheduleRun.project_id == pid))).all()
                run_by = {f"{r.ticket_id}#{r.number}": r for r in runs}
                slot_by = {f"{s.schedule_id}@{s.slot_at}": s for s in slots}
                try:
                    if step["op"] == "tick":
                        CLOCK["now"] = at(step["now"])
                        got = {"ok": await schedules.tick(at(step["now"]))}
                    elif step["op"] == "run":
                        r = run_by[step["run"]]
                        for k, v in step["set"].items():
                            setattr(r, k, v)
                        session.add(r)
                        await session.commit()
                    elif step["op"] == "lose_run":
                        await session.delete(run_by[step["run"]])
                        await session.commit()
                    elif step["op"] in ("team", "member", "ticket"):
                        row = await session.get({"team": AiTeam, "member": Member, "ticket": Ticket}[step["op"]], step["id"])
                        for k, v in step["set"].items():
                            setattr(row, k, v)
                        session.add(row)
                        await session.commit()
                    elif step["op"] == "set_paused":
                        s = await schedules.set_paused(session, step["id"], step["paused"], step["by"])
                        got = {"ok": s.state}
                    elif step["op"] == "run_now":
                        srun = await schedules.run_now(session, step["id"], step["by"])
                        got = {"ok": srun.state}
                    elif step["op"] == "slot_action":
                        srun = slot_by.get(step["slot"])
                        srun = await schedules.slot_action(session, srun.id if srun else step["slot"], step["action"], step["by"], step.get("member_id"))
                        got = {"ok": srun.state}
                except schedules.ScheduleError as exc:
                    got = {"error": [exc.code, str(exc), exc.extra]}
                except Exception as exc:  # noqa: BLE001
                    got = {"raises": [type(exc).__name__, str(exc)]}
            log.append({**step, "out": got, "after": await snapshot(pid)})
        done.append({"key": key, "title": title, "project_id": pid, "rows": dumped, "steps": log})
    CLOCK["now"] = NOW
    return done


async def main():
    await database.init_db()
    out["board"] = await board()
    out["editing"] = await editing()
    out["stories"] = await stories()
    text = json.dumps(out, ensure_ascii=False, indent=1)
    OUT.write_text(text + "\n", encoding="utf-8")
    print(f"{OUT.name}: {len(text.encode()) // 1024} KB")
    print("  slots:", len(SLOTS), "cases;", sum("error" in c["out"] for c in SLOTS), "refused,", sum("raises" in c["out"] for c in SLOTS), "raised")
    print("  assess:", len(out["board"]["assess"]), "raised:", [c["data"] for c in out["board"]["assess"] if "raises" in c["out"]])
    print("  editing:", [(s["call"], "ok" if "ok" in s["out"] else s["out"]) for s in out["editing"]["steps"] if "ok" not in s["out"]])
    for st in out["stories"]:
        outs = [s["out"] for s in st["steps"] if s["out"] and "ok" not in s["out"]]
        slots = [(s["slot"].split("@")[0], s["state"], s["note"]) for s in st["steps"][-1]["after"]["slots"]]
        print(f"  {st['key']}: {slots} {outs if outs else ''}")


asyncio.run(main())
