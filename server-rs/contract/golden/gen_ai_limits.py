"""Golden vectors for the limits of the AI team base (`crates/kb-ai`): `quota` (reading the stream, holds, keys) and
`budget` (the day and month boundaries in many time zones, DST included, with the clock frozen).

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_limits.py
Writes `ai_limits.json` next to this file.
"""

import json
import os
import sys
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

work = tempfile.mkdtemp(prefix="gen-ai-limits-")
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude"
os.environ["HOME"] = f"{work}/home"
sys.path.insert(0, os.getcwd())

from models import AiAccountState, AiRun, AiTeam  # noqa: E402
from services.ai import budget, quota  # noqa: E402

OUT = Path(__file__).with_name("ai_limits.json")
out: dict = {}


def row_dict(row):
    return json.loads(row.model_dump_json())


# --------------------------------------------------------------------------------------------------------------
# quota
# --------------------------------------------------------------------------------------------------------------
def event(status="allowed", resets=None, kind="five_hour", five=0.4, seven=0.1, five_resets=1900000000, seven_resets=1900100000):
    return {
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": status,
            "resetsAt": resets,
            "rateLimitType": kind,
            "unifiedWindows": {
                "five_hour": {"utilization": five, "resetsAt": five_resets, "status": "allowed"},
                "seven_day": {"utilization": seven, "resetsAt": seven_resets, "status": status},
            },
        },
    }


events = [
    event("rejected", 1900000000, "seven_day", 0.5, 1.0),
    event("allowed", None),
    event("allowed_warning", 1700000000.9, "five_hour", 0.85, 0.9),
    event("rejected", "1900000000", "five_hour"),
    event("rejected", " 1900000000 ", "five_hour"),
    event("rejected", "x", "five_hour"),
    event("rejected", True, "five_hour"),
    event("rejected", -1, "five_hour"),
    event("rejected", 0, "five_hour"),
    event("rejected", 253402300799, "five_hour"),
    event("rejected", 253402300800, "five_hour"),
    event("rejected", 10**20, "five_hour"),
    event("rejected", -62135596800, "five_hour"),
    event("rejected", -62135596801, "five_hour"),
    event("rejected", 1900000000, None),
    event("rejected", 1900000000, "overage"),
    event(five=None, seven="x"),
    event(five_resets=None, seven_resets="y"),
    event(five=1, seven=0),
    {"type": "rate_limit_event"},
    {"type": "rate_limit_event", "rate_limit_info": None},
    {"type": "rate_limit_event", "rate_limit_info": {}},
    {"type": "rate_limit_event", "rate_limit_info": {"resetsAt": "x"}},
    {"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {"five_hour": "bad", "weird": {"utilization": 0.2}}}},
    {"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": None, "status": 3}},
    {"type": "assistant"},
    {"type": "rate_limit_event2"},
    {},
    [],
    "nope",
    None,
    3,
]
out["parse_event"] = [{"event": e, "out": quota.parse_event(e)} for e in events]

teams = {
    "none": None,
    "plain": AiTeam(id="t", project_id="p"),
    "account": AiTeam(id="t", project_id="p", account_id="acct_team"),
    "empty_account": AiTeam(id="t", project_id="p", account_id=""),
}
runs = {
    "none": None,
    "plain": AiRun(id="r", project_id="p", member_id="t"),
    "account": AiRun(id="r", project_id="p", member_id="t", account_id="acct_run"),
    "empty_account": AiRun(id="r", project_id="p", member_id="t", account_id=""),
}
out["key_for"] = [{"team": t, "run": r, "out": quota.key_for(teams[t], runs[r])} for t in teams for r in runs]

now = datetime(2026, 11, 12, 10, 0, 0, tzinfo=UTC)
held_cases = []
for held_until in [None, "", "garbage", (now + timedelta(seconds=600)).isoformat(), (now - timedelta(seconds=600)).isoformat(),
                   now.isoformat(), (now + timedelta(microseconds=1)).isoformat(), "2026-11-12T10:00:00", "2026-11-12T17:00:00+07:00",
                   "2026-11-12T16:59:59+07:00", "2026-11-12T10:00:01Z"]:
    row = AiAccountState(key="a", held_until=held_until)
    try:
        res = quota.held(row, now)
    except TypeError:
        res = "TypeError"
    held_cases.append({"held_until": held_until, "now": now.isoformat(), "out": res})
held_cases.append({"row": None, "out": quota.held(None, now)})
out["held"] = held_cases

hold_cases = []
for before_until, before_reason, until, window in [
    (None, None, "2026-11-12T12:00:00+00:00", "five_hour"),
    (None, None, "2026-11-12T12:00:00+00:00", "seven_day"),
    (None, None, "2026-11-12T12:00:00+00:00", None),
    (None, None, "2026-11-12T12:00:00+00:00", "overage"),
    ("2026-11-12T13:00:00+00:00", "old", "2026-11-12T12:00:00+00:00", "five_hour"),
    ("2026-11-12T11:00:00+00:00", "old", "2026-11-12T12:00:00+00:00", "seven_day"),
    ("2026-11-12T12:00:00+00:00", "old", "2026-11-12T12:00:00+00:00", "seven_day"),
    ("", "old", "2026-11-12T12:00:00+00:00", "seven_day"),
]:
    row = AiAccountState(key="a", held_until=before_until, held_reason=before_reason)
    quota.hold(row, until, window)
    hold_cases.append({"held_until": before_until, "held_reason": before_reason, "until": until, "window": window,
                       "after_until": row.held_until, "after_reason": row.held_reason})
out["hold"] = hold_cases

out["consts"] = {"LOCAL": quota.LOCAL, "DEFAULT_PARALLEL": quota.DEFAULT_PARALLEL, "NEAR": quota.NEAR}

# --------------------------------------------------------------------------------------------------------------
# budget with a frozen clock, in many zones
# --------------------------------------------------------------------------------------------------------------
REAL = datetime


class Fake(REAL):
    frozen = None  # an aware UTC datetime

    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return cls.fromtimestamp(cls.frozen.timestamp())  # naive, local
        return cls.frozen.astimezone(tz)


budget.datetime = Fake

ZONES = [
    "UTC", "Asia/Ho_Chi_Minh", "America/New_York", "Europe/London", "Europe/Berlin", "Australia/Lord_Howe", "America/Sao_Paulo",
    "Asia/Kolkata", "Pacific/Auckland", "Pacific/Kiritimati", "America/St_Johns", "Pacific/Apia", "America/Havana", "Asia/Tehran",
    "Africa/Cairo", "America/Los_Angeles", "Asia/Kathmandu", "Africa/Casablanca", "America/Santiago", "Asia/Beirut",
]
INSTANTS = [
    "2026-01-01T00:00:00+00:00", "2026-01-01T12:30:15.123456+00:00", "2026-03-08T06:59:59+00:00", "2026-03-08T07:00:00+00:00",
    "2026-03-08T10:00:00+00:00", "2026-03-29T00:59:59+00:00", "2026-03-29T01:00:00+00:00", "2026-03-29T12:00:00+00:00",
    "2026-04-05T15:00:00+00:00", "2026-10-04T14:30:00+00:00", "2026-10-25T00:30:00+00:00", "2026-10-25T01:00:00+00:00",
    "2026-10-25T01:30:00+00:00", "2026-10-25T02:00:00+00:00", "2026-11-01T05:30:00+00:00", "2026-11-01T06:30:00+00:00",
    "2026-11-01T09:00:00+00:00", "2026-11-12T10:00:00+00:00", "2026-11-12T23:59:59.999999+00:00", "2026-11-30T17:00:00+00:00",
    "2026-12-31T23:30:00+00:00", "2027-01-01T00:00:00+00:00", "2026-02-28T20:00:00+00:00", "2028-02-29T08:00:00+00:00",
    "2018-11-04T02:59:59+00:00", "2018-11-04T03:00:00+00:00", "2018-11-04T15:00:00+00:00", "2011-12-29T12:00:00+00:00",
    "2011-12-31T12:00:00+00:00", "2011-12-30T09:00:00+00:00", "2023-04-27T22:30:00+00:00", "2023-04-28T12:00:00+00:00",
    "2022-03-21T20:30:00+00:00", "2022-03-22T10:00:00+00:00", "2026-09-05T03:30:00+00:00", "2026-04-04T14:00:00+00:00",
    "2026-04-05T02:30:00+00:00", "2026-04-05T12:00:00+00:00", "2026-04-04T16:30:00+00:00",
]
ISO_DAYS = [None, "", "not a date", "2026-01-02T12:00:00", "2026-01-02T12:00:00+00:00", "2026-01-02T23:30:00+00:00",
            "2026-06-30T17:00:00+00:00", "2026-06-30T17:00:00Z", "2026-03-08T07:30:00+00:00", "2026-10-25T00:30:00+00:00",
            "2026-11-01T06:30:00-05:00", "2026-01-02", "2026-01-02 08:00", "2026-01-02T12:00:00.5+07:00"]
AT_ARGS = [
    datetime(2026, 5, 17, 23, 30, tzinfo=UTC), datetime(2026, 1, 1, 0, 0, tzinfo=UTC),
    datetime(2026, 12, 31, 23, 59, 59, tzinfo=UTC), datetime(2026, 3, 8, 7, 30, tzinfo=UTC),
]
zone_out = []
for zone in ZONES:
    os.environ["TZ"] = zone
    time.tzset()
    cases = []
    for inst in INSTANTS:
        Fake.frozen = REAL.fromisoformat(inst)
        c = {
            "now": inst,
            "today_start": budget.today_start().isoformat(),
            "day_key": budget.day_key(),
            "month_start": budget.month_start().isoformat(),
            "bounds": [],
        }
        for n in (0, 1, 2, 7, 31):
            key, start, end = budget.day_bounds(n)
            c["bounds"].append({"days_ago": n, "key": key, "start": start.isoformat(), "end": end.isoformat()})
        cases.append(c)
    Fake.frozen = REAL.fromisoformat("2026-11-12T10:00:00+00:00")
    ats = [{"at": a.isoformat(), "day_key": budget.day_key(a), "month_start": budget.month_start(a).isoformat()} for a in AT_ARGS]
    days = [{"iso": v, "out": budget.local_day(v)} for v in ISO_DAYS]
    hhmm = [{"when": v, "out": quota._local(v)} for v in
            [None, "", "bad", "2026-11-12T10:00:00+00:00", "2026-07-12T10:00:00+00:00", "2026-03-08T07:30:00+00:00", "2026-11-12T10:00:00",
             "2026-11-12T23:59:59.5-05:00"]]
    zone_out.append({"zone": zone, "cases": cases, "ats": ats, "local_day": days, "local_hhmm": hhmm})
out["zones"] = zone_out

# run kinds
out["run_kind"] = [{"trigger": t, "out": budget.run_kind(AiRun(id="r", project_id="p", member_id="m", trigger=t))}
                   for t in ["schedule", "assign", "message", "", "run_button", "ci_red", "SCHEDULE"]]

OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
