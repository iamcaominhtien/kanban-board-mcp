"""Golden vectors for `services/ai/touches.py`, `health.py`, `session_history.py` and `compact.py`
(`crates/kb-ai-run/src/{touches,health,session_history,compact}`).

`pure`: `touches.is_person`, `_clip`, `since_of`, `carry_answer`, `answers_of`, `draft_lesson`; `health.verdict_of`,
`_median`, `_secs`, `_reason`, `_sentence`, `_ticket_times`, `_reopens_after`, `_first_finish`, `measures`;
`session_history.to_dict`, `_fallback`.

With a database, built here with the Python models and written as the rows the models dump (the Rust test puts the
same rows into its own database), and with the modules' clock stopped at `now`: `touches.collect` over the whole range
and for every key, `stepped_in` with every filter, `health.health` for both ranges and for projects in other shapes,
`set_mark` and `make_lesson` step by step (what is answered or refused, and the mark's row), `record_edit`,
`record_signin` and `record_pause` (the audit entries they write), the rows, the prompt block, the closed sessions and
the digest of `session_history`, `start_over` with an assistant that answers, fails or is absent, and `compact_ticket`
with a team that works, one with no conversation and one whose CLI (a script written here) compacts.

Paths: this run's temporary folder is written `<ROOT>`.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_review.py
Writes `ai_review.json` next to this file.
"""

import asyncio
import json
import os
import stat
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

work = os.path.realpath(tempfile.mkdtemp(prefix="gen-ai-review-"))
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

from sqlmodel import col, select  # noqa: E402

import database  # noqa: E402
from models import (  # noqa: E402
    AiAccount,
    AiAudit,
    AiLesson,
    AiProjectSettings,
    AiRun,
    AiRunMessage,
    AiRunStep,
    AiSessionHistory,
    AiTeam,
    AiTouchMark,
    Member,
    Project,
    Ticket,
)
from services.ai import compact, health, session_history, touches  # noqa: E402
from services.ai.runs import RunError  # noqa: E402

OUT = Path(__file__).with_name("ai_review.json")
NOW = datetime(2026, 3, 15, 12, 0, 0, tzinfo=UTC)
STAMP = "2025-01-01T00:00:00+00:00"
out: dict = {"now": NOW.isoformat()}


class Frozen(datetime):
    """`datetime` with `now()` stopped at NOW (what the Rust tests do with `clock::set_now`)."""

    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


touches.datetime = Frozen
health.datetime = Frozen


def ago(**kw) -> str:
    return (NOW - timedelta(**kw)).isoformat()


def norm(value):
    if isinstance(value, str):
        return value.replace(work, "<ROOT>")
    if isinstance(value, list):
        return [norm(v) for v in value]
    if isinstance(value, dict):
        return {norm(k): norm(v) for k, v in value.items()}
    return value


def row_dict(row):
    return norm(json.loads(row.model_dump_json()))


# ---------------------------------------------------------------------------------------------------------------------
# pure
# ---------------------------------------------------------------------------------------------------------------------
pure: dict = {}
AI = {"Dev Team", "QA Team", "Old Team"}
NAMES = [None, "", "  ", "An Nguyen", " An Nguyen ", "board", "Board", "SYSTEM", "schedule", "Scheduler", "runner", "auto",
         "GitHub", "api", "API ", "Dev Team", "dev team", " Dev Team", "QA Team", "user", "Đội trưởng", "ΣΑΣ", "İ", "\x1c"]
pure["is_person"] = [{"name": n, "with_ai": touches.is_person(n, AI), "without": touches.is_person(n)} for n in NAMES]
TEXTS = [None, "", "one", "  two   words \n here ", "x" * 159, "x" * 160, "x" * 161, "é" * 200, "a b " * 60, "tab\tand\x1cseparators", "…" * 170]
pure["clip"] = [{"text": t, "n": n, "out": touches._clip(t, n)} for t in TEXTS for n in (160, 110, 140, 1, 0)]
pure["since_of"] = [{"range": r, "out": touches.since_of(r, NOW).isoformat()} for r in ["24h", "7d", "30d", "90d", "", "1y", "7D"]]
pure["since_of_default_now"] = {r: touches.since_of(r).isoformat() for r in ["24h", "90d"]}
pure["constants"] = {
    "RANGES": touches.RANGES,
    "DEFAULT_RANGE": touches.DEFAULT_RANGE,
    "MARKS": list(touches.MARKS),
    "LIMIT": touches.LIMIT,
    "LESSON_MAX": touches.LESSON_MAX,
    "KINDS": touches.KINDS,
    "MACHINE": sorted(touches.MACHINE),
    "EDIT_ACTION": touches.EDIT_ACTION,
    "SIGNIN_ACTION": touches.SIGNIN_ACTION,
    "PAUSE_ACTIONS": list(touches.PAUSE_ACTIONS),
    "CLAIMED": touches.CLAIMED,
    "RUN_ENDED": list(touches.RUN_ENDED),
    "STOP_WITH_PAUSE_S": touches.STOP_WITH_PAUSE_S,
    "EDIT_COALESCE_S": touches.EDIT_COALESCE_S,
    "WISH": compact.WISH,
    "TIMEOUT_S": compact.TIMEOUT_S,
    "DIGEST_MAX": session_history.DIGEST_MAX,
    "HEALTH_RANGES": health.RANGES,
    "MIN_RUNS": health.MIN_RUNS,
    "MAX_FIXES": health.MAX_FIXES,
    "ENDED": list(health.ENDED),
    "NOT_THE_TEAM": list(health.NOT_THE_TEAM),
    "MIN_CASES": health.MIN_CASES,
    "MIN_CASES_MEMORY": health.MIN_CASES_MEMORY,
}

Q_OLD = {"text": "Which branch?", "answered_at": ago(days=2), "answered_by": "An Nguyen"}
PREV = [{"text": f"q{i}", "answer": f"a{i}", "answered_at": ago(days=3, minutes=-i), "answered_by": "Binh"} for i in range(25)]
QUESTIONS = [
    (None, None),
    (None, "yes"),
    ("", "yes"),
    ("not json", "yes"),
    ("[]", "yes"),
    ("{}", "yes"),
    (json.dumps({"text": "Which branch?"}), "main"),
    (json.dumps(Q_OLD), "main"),
    (json.dumps(Q_OLD), ""),
    (json.dumps(Q_OLD), None),
    (json.dumps({"answered_at": ago(days=1)}), "ok"),
    (json.dumps({**Q_OLD, "previous": PREV[:2]}), "main"),
    (json.dumps({**Q_OLD, "previous": PREV[:19]}), "main"),
    (json.dumps({**Q_OLD, "previous": PREV[:20]}), "main"),
    (json.dumps({**Q_OLD, "previous": PREV}), "main"),
    (json.dumps({**Q_OLD, "previous": PREV}), None),
    (json.dumps({"text": "t", "answered_at": "", "previous": PREV[:1]}), "x"),
    (json.dumps({**Q_OLD, "previous": None}), "main"),
    (json.dumps({**Q_OLD, "previous": [PREV[0], "odd", 3, None, {"answer": "only an answer"}]}), "main"),
    (json.dumps({**Q_OLD, "answered_by": None, "text": "Câu hỏi – “đâu”?"}), "đây"),
]
pure["carry_answer"] = [{"question": q, "answer": a, "out": touches.carry_answer(q, a)} for q, a in QUESTIONS]
pure["answers_of"] = [
    {"question": q, "answer": a, "out": touches.answers_of(AiRun(project_id="p", member_id="m", question=q, answer=a))}
    for q, a in QUESTIONS
]


def a_touch(kind, details, ticket_id=None):
    return {"label": touches.KINDS[kind], "ticket_id": ticket_id, "details": details}


DRAFTS = [
    a_touch("answer", "“Which branch?” → “main”", "KAN-1"),
    a_touch("answer", "“Which branch?” → “main”"),
    a_touch("run_by_hand", "Run #3", "KAN-2"),
    a_touch("stop", "Cancelled by An Nguyen.", "KAN-2"),
    a_touch("stop", "Why did it stop?", "KAN-2"),
    a_touch("message", "“Use the other folder!”", "KAN-3"),
    a_touch("edit", "Changed the description while the lead was working", "KAN-3"),
    a_touch("pause", "", None),
    a_touch("pause", None, None),
    a_touch("signin", "  spread \n over   lines  ", ""),
    a_touch("message", "x" * 700, "KAN-4"),
    a_touch("message", "word " * 200, "KAN-4"),
    a_touch("edit", "é" * 520, "KAN-5"),
    a_touch("edit", "é" * 521, "KAN-5"),
    a_touch("edit", ("ab " * 173) + "end…", "KAN-5"),
    a_touch("answer", "ends with an ellipsis…", "K" * 600),
    a_touch("answer", "y" * 30, "K" * 560),
]
pure["draft_lesson"] = [{"touch": t, "out": touches.draft_lesson(t)} for t in DRAFTS]

VALUES = [None, 0, 0.0, 0.05, 0.1, 0.1000001, 0.15, 0.2, 0.2000001, 0.69, 0.7, 0.7000001, 0.849999, 0.85, 0.9, 0.9000001, 1, 1.0, 2, 2.0, 2.5, 100]
pure["verdict_of"] = [
    {"value": v, "good": g, "watch": w, "higher": h, "out": health.verdict_of(v, g, w, higher_is_better=h)}
    for v in VALUES
    for g, w, h in [(0.85, 0.7, True), (1, 2, False), (0.1, 0.2, False), (0.7, 0.9, False)]
]
MEDIANS = [[], [5.0], [1.0, 2.0], [3.0, 1.0, 2.0], [0.25, 0.35], [1.05, 1.15], [10.0, 20.0, 30.0, 40.0], [0.05], [0.15], [0.25], [2.675, 2.665], [1e9, 1.0],
           [61.123456, 59.5, 3600.0, 0.0], [33.333333, 33.333334], [7.45], [7.55], [0.449999, 0.45]]
pure["median"] = [{"values": v, "out": health._median(v)} for v in MEDIANS]
TIMES = [None, "", "nope", "2026-03-15T12:00:00+00:00", "2026-03-15T12:00:01.500000+00:00", "2026-03-15T19:00:00+07:00", "2026-03-15T11:59:59+00:00",
         "2026-03-15 12:30:00", "2026-03-15", "2026-03-16T00:00:00Z", "2026-03-15T12:00:00.000001+00:00", "2025-12-31T23:59:59.999999-08:00"]
pure["secs"] = [{"a": a, "b": b, "out": health._secs(a, b)} for a in TIMES for b in TIMES]
REASONS = ["", "Done.", "Done...", "The CLI ended with exit code 1.", "  spread\n over  lines.  ", "x" * 139, "x" * 140, "x" * 141, "x" * 200,
           "word " * 40, "a, b; c: " * 20, ("y" * 137) + " zz tail", ("y" * 130) + ", next words here", "é" * 150, "one two. three." * 12,
           ("k" * 138) + ". more"]
pure["reason"] = [{"text": t, "limit": n, "out": health._reason(t, n)} for t in REASONS for n in (140, 20)]


def m_of(rel, autonomy, value, avoidable, speed):
    return {"reliability": {"verdict": rel}, "autonomy": {"verdict": autonomy, "value": value, "avoidable": avoidable}, "speed": {"run_median_s": speed}}


SENTENCES = [
    (m_of("good", "good", 0.5, 0, 100.0), None, [], []),
    (m_of("watch", "watch", 1.5, 0, 100.0), {"speed": {"run_median_s": 300.0}}, [{}], ["Dev Team"]),
    (m_of("fix", "fix", 2.0, 3, 500.5), {"speed": {"run_median_s": 300.0}}, [{}, {}], ["Dev Team", "QA Team", "Old Team"]),
    (m_of(None, None, None, 0, None), {"speed": {"run_median_s": 300.0}}, [], []),
    (m_of("good", "watch", 1.0, 1, 359.9), {"speed": {"run_median_s": 300.0}}, [], ["Đội QA"]),
    (m_of("good", None, 0.3, 0, 361.0), {"speed": {"run_median_s": 300.0}}, [{}], []),
    (m_of("good", "good", 0.3, 0, 240.0), {"speed": {"run_median_s": 300.0}}, [], []),
    (m_of("good", "good", 0.3, 0, 239.9), {"speed": {"run_median_s": 300.0}}, [], []),
    (m_of("watch", "fix", 12.3, 0, 10.0), {"speed": {"run_median_s": None}}, [{}, {}, {}, {}, {}], ["A", "B"]),
    (m_of("good", "fix", 3.0, 7, 10.0), {}, [], []),
]
pure["sentence"] = [{"m": m, "prev": p, "fixes": f, "bad": b, "out": health._sentence(m, p, f, b)} for m, p, f, b in SENTENCES]


def a_run(i, **kw):
    kw.setdefault("project_id", "p")
    kw.setdefault("member_id", "team-a")
    kw.setdefault("queued_at", ago(days=3, minutes=-i))
    return AiRun(id=f"pr_{i}", number=i, **kw)


ACTIVITY = [
    {"field": "assignee", "from": None, "to": "team-a", "at": ago(days=6), "actor": "An"},
    {"field": "status", "from": "todo", "to": "review", "at": ago(days=5), "actor": "Dev"},
    {"field": "assignee", "from": "team-a", "to": "team-b", "at": ago(days=4), "actor": "An"},
    {"field": "assignee", "from": "team-b", "to": "team-a", "at": ago(days=3, hours=1), "actor": "An"},
    {"field": "status", "from": "in_progress", "to": "review", "at": ago(days=2), "actor": "Dev"},
    {"field": "status", "from": "review", "to": "done", "at": ago(days=1), "actor": "An"},
    {"field": "assignee", "to": "", "at": ago(days=1)},
    {"field": "assignee", "to": "team-a"},
    {"field": "status", "to": "review"},
    "odd",
    {"field": "title", "to": "review", "at": ago(days=1)},
]
REOPENS = [{"at": ago(days=9), "by": "An"}, {"at": ago(days=2, hours=12), "by": "An"}, {"at": ago(days=1), "by": "Binh"}, {"by": "nobody"}, "odd", {"at": ""}]
T_FULL = Ticket(id="PT-1", project_id="p", title="Full", activity_log=json.dumps(ACTIVITY), reopen_history=json.dumps(REOPENS))
T_EMPTY = Ticket(id="PT-2", project_id="p", title="Empty")
T_BAD = Ticket(id="PT-3", project_id="p", title="Bad", activity_log="not json", reopen_history="{}")
pure["tickets"] = [row_dict(t) for t in (T_FULL, T_EMPTY, T_BAD)]
pure["ticket_times"] = [{"ticket": t and t.id, "out": [list(map(list, health._ticket_times(t)[0])), health._ticket_times(t)[1]]} for t in (T_FULL, T_EMPTY, T_BAD, None)]
AFTERS = [None, "", ago(days=10), ago(days=3), ago(days=2, hours=12), ago(days=1), ago(hours=1)]
pure["reopens_after"] = [
    {"ticket": t and t.id, "after": a, "until": u, "out": health._reopens_after(t, a, u)}
    for t in (T_FULL, T_EMPTY, T_BAD, None)
    for a in AFTERS
    for u in (None, ago(days=2), ago(days=1), ago(hours=1))
]

REPORT_FINDINGS = json.dumps({"status": "done", "summary": "ok", "findings": ["one", "two", "three"]})
PURE_RUNS = [
    a_run(1, ticket_id="PT-1", state="finished", started_at=ago(days=3), ended_at=ago(days=2, hours=23), cost_usd=0.4, metered=True, tokens_in=1000, tokens_out=500),
    a_run(2, ticket_id="PT-1", state="finished", started_at=ago(days=2, hours=20), ended_at=ago(days=2, hours=19, minutes=30), cost_usd=0.6, metered=True, tokens_in=10, tokens_out=5, report=REPORT_FINDINGS),
    a_run(3, ticket_id="PT-1", state="failed", started_at=ago(days=2), ended_at=ago(days=1, hours=23, minutes=58), ended_reason="exit 1", cost_usd=0.1),
    a_run(4, ticket_id="PT-2", state="timed_out", started_at=ago(days=2), ended_at=ago(days=1, hours=20), cost_usd=0.0, tokens_in=7),
    a_run(5, ticket_id="PT-2", state="cancelled", started_at=ago(days=2), ended_at=ago(days=1, hours=22), stop_code="board_closed"),
    a_run(6, ticket_id="PT-2", state="cancelled", started_at=ago(days=2), ended_at=ago(days=1, hours=22), ended_by="An"),
    a_run(7, ticket_id="PT-3", state="failed", stop_code="deleted", started_at=ago(days=2), ended_at=ago(days=2)),
    a_run(8, ticket_id="PT-3", state="running", started_at=ago(hours=1)),
    a_run(9, ticket_id=None, state="finished", started_at=ago(days=1), ended_at=ago(hours=23), cost_usd=1.25, metered=False),
    a_run(10, ticket_id="PT-4", state="finished", started_at=ago(days=1), ended_at=ago(days=1, hours=1)),
    a_run(11, ticket_id="PT-4", state="finished", started_at=None, ended_at=ago(hours=5), metered=True, report=json.dumps({"findings": []})),
    a_run(12, ticket_id="PT-5", state="queued", report=json.dumps({"findings": "none"})),
    a_run(13, ticket_id="PT-1", state="finished", started_at=ago(days=2, hours=18), ended_at=ago(days=2, hours=17, minutes=59, seconds=30), cost_usd=0.005, report=json.dumps({"findings": ["x"]})),
]
PURE_TKS = [
    {"ticket_id": "PT-1", "mark": "avoidable"},
    {"ticket_id": "PT-1", "mark": None},
    {"ticket_id": "PT-2", "mark": "needed"},
    {"ticket_id": None, "mark": "avoidable"},
    {"ticket_id": "PT-9", "mark": None},
]
TEAM_CAPS = AiTeam(id="team-a", project_id="p", cap_per_run=0.5, monthly_cap=20.0)
TEAM_NONE = AiTeam(id="team-a", project_id="p")
TEAM_ZERO = AiTeam(id="team-a", project_id="p", cap_per_run=0.0, monthly_cap=0.0)
TEAM_TIGHT = AiTeam(id="team-a", project_id="p", cap_per_run=0.05, monthly_cap=2.0)
PURE_TICKETS = {t.id: t for t in (T_FULL, T_EMPTY, T_BAD)}
pure["runs"] = [row_dict(r) for r in PURE_RUNS]
pure["teams"] = {"caps": row_dict(TEAM_CAPS), "none": row_dict(TEAM_NONE), "zero": row_dict(TEAM_ZERO), "tight": row_dict(TEAM_TIGHT)}
pure["first_finish"] = {
    "all": health._first_finish(PURE_RUNS),
    "reversed": health._first_finish(PURE_RUNS[::-1]),
    "none": health._first_finish([]),
}
TEAMS = {"caps": TEAM_CAPS, "none": TEAM_NONE, "zero": TEAM_ZERO, "tight": TEAM_TIGHT, "project": None}
SUBSETS = {
    "all": list(range(13)),
    "none": [],
    "one": [0],
    "failed": [2, 3, 6],
    "free": [3, 4, 5, 6, 7],
    "priced": [0, 1, 8, 12],
    "odd": [9, 10, 11],
}
SPENDS = {"none": [], "zeros": [0.0, 0.0], "small": [0.1, 0.2, 0.3], "near": [14.0], "limit": [18.0], "over": [18.01, 0.0, 1.0], "tight": [1.4], "tight_over": [1.81]}
MEASURES = []
for runs_key, idx in SUBSETS.items():
    for team_key, team in TEAMS.items():
        if runs_key != "all" and team_key not in ("caps", "project"):
            continue
        for spend_key in list(SPENDS) if runs_key == "all" else ["none", "over"]:
            for judged, tks_key, until in ((True, "some", None), (False, "some", None), (True, "none", ago(days=2))):
                got = health.measures(
                    [PURE_RUNS[i] for i in idx],
                    PURE_TKS if tks_key == "some" else [],
                    PURE_TICKETS,
                    team=team,
                    # (as `health.health` adds the costs up: a cost of zero counts as the int 0)
                    month_spend=sum(x or 0 for x in SPENDS[spend_key]),
                    judged=judged,
                    until=until,
                )
                MEASURES.append({"runs": idx, "team": team_key, "spend": SPENDS[spend_key], "judged": judged, "tks": tks_key, "until": until, "out": got})
pure["tks"] = PURE_TKS
pure["measures"] = MEASURES

H_ROWS = [
    AiSessionHistory(id="ses_pure1", project_id="p", ticket_id="PT-1", member_id="team-a", title="First", summary="  Did things.  ",
                     session_ids=json.dumps(["s-1", "s-2"]), run_ids=json.dumps(["r-1"]), started_at=ago(days=9), ended_at=ago(days=8), created_by="An", summarised_by="digest"),
    AiSessionHistory(id="ses_pure2", project_id="p", ticket_id="PT-1", member_id="team-a", session_ids="", run_ids="not json", ended_at=ago(days=1)),
]
pure["history_to_dict"] = [{"row": row_dict(r), "out": session_history.to_dict(r), "keys": list(session_history.to_dict(r))} for r in H_ROWS]
FALLBACKS = [
    ([a_run(1, instruction="  Fix   the\tadd() function  "), a_run(2, instruction="second")], "digest text " * 200),
    ([a_run(3, instruction="   "), a_run(4, instruction="")], "short"),
    ([a_run(5, instruction=""), a_run(6, instruction=" later one ")], ""),
    ([a_run(7, instruction="x" * 100)], "é" * 1600),
    ([a_run(8, instruction=("word " * 30))], "d"),
    ([a_run(9, instruction="\x1c\x1d only separators")], "d"),
]
pure["fallback"] = [{"runs": [row_dict(r) for r in runs], "digest": d, "out": list(session_history._fallback(runs, d))} for runs, d in FALLBACKS]
out["pure"] = pure

# ---------------------------------------------------------------------------------------------------------------------
# a project with a past (touches and health)
# ---------------------------------------------------------------------------------------------------------------------
P = "p-rev"
DEV, QA, OLD, IDLE, DOC = "rev-dev", "rev-qa", "rev-old", "rev-idle", "rev-doc"


def q(text, at=None, by=None, previous=None):
    d = {"text": text}
    if at:
        d["answered_at"] = at
        d["answered_by"] = by
    if previous is not None:
        d["previous"] = previous
    return json.dumps(d)


def report(summary, **more):
    return json.dumps({"status": "done", "summary": summary, **more})


def review_rows():
    rows: list = [
        Project(id=P, name="Review", prefix="REV", color="#2E6F40"),
        Project(id="p-rev-other", name="Other", prefix="REO", color="#2E6F40"),
        Project(id="p-rev-empty", name="Empty", prefix="REE", color="#2E6F40"),
        Project(id="p-rev-few", name="Few", prefix="REF", color="#2E6F40"),
        Member(id="rev-an", project_id=P, name="An Nguyen", color="#3B82F6", role="admin", created_at=STAMP),
        Member(id="rev-binh", project_id=P, name="Binh", color="#3B82F6", created_at=STAMP),
        Member(id=DEV, project_id=P, name="Dev Team", color="#2E6F40", kind="ai", created_at=STAMP),
        Member(id=QA, project_id=P, name="QA Team", color="#6D5DD3", kind="ai", created_at=STAMP),
        Member(id=OLD, project_id=P, name="Old Team", color="#2F6FB0", kind="ai_removed", created_at=STAMP),
        Member(id=IDLE, project_id=P, name="Idle Team", color="#B4791E", kind="ai", created_at=STAMP),
        Member(id="rev-gone", project_id=P, name="Gone Team", color="#B4791E", kind="ai_removed", created_at=STAMP),
        Member(id=DOC, project_id=P, name="Doc Team", color="#B0446E", kind="ai", created_at=STAMP),
        Member(id="oth-an", project_id="p-rev-other", name="An Nguyen", color="#3B82F6", created_at=STAMP),
        Member(id="oth-team", project_id="p-rev-other", name="Other Team", color="#2E6F40", kind="ai", created_at=STAMP),
        Member(id="few-team", project_id="p-rev-few", name="Few Team", color="#2E6F40", kind="ai", created_at=STAMP),
        AiTeam(id=DEV, project_id=P, cap_per_run=0.5, monthly_cap=20.0, account_id="acct_rev", created_at=STAMP, updated_at=STAMP),
        AiTeam(id=QA, project_id=P, monthly_cap=2.0, account_id="acct_rev", created_at=STAMP, updated_at=STAMP),
        AiTeam(id=OLD, project_id=P, created_at=STAMP, updated_at=STAMP),
        AiTeam(id=IDLE, project_id=P, paused=True, paused_reason="lunch", created_at=STAMP, updated_at=STAMP),
        AiTeam(id=DOC, project_id=P, cap_per_run=0.2, created_at=STAMP, updated_at=STAMP),
        AiTeam(id="oth-team", project_id="p-rev-other", account_id="acct_rev", created_at=STAMP, updated_at=STAMP),
        AiTeam(id="few-team", project_id="p-rev-few", created_at=STAMP, updated_at=STAMP),
        AiAccount(id="acct_rev", name="Work login", cli="claude", folder=f"{work}/accounts/work", status="signed_in", created_at=STAMP, updated_at=STAMP),
        AiProjectSettings(project_id=P, run_memory_limit_mb=3072, updated_at=STAMP),
    ]
    # tickets: who was given what and when it reached Review; some came back
    def log(*entries):
        return json.dumps([{"field": f, "from": None, "to": to, "at": at, "actor": "An Nguyen"} for f, to, at in entries])

    rows += [
        Ticket(id="REV-1", project_id=P, title="Fix add()", status="review", activity_log=log(("assignee", DEV, ago(days=6, hours=2)), ("status", "review", ago(days=5))), created_at=STAMP, updated_at=STAMP),
        Ticket(id="REV-2", project_id=P, title="Rename the “widget” module everywhere, and keep the old name working for a release " + "x" * 40, status="in_progress",
               activity_log=log(("assignee", DEV, ago(days=4)), ("status", "review", ago(days=3, hours=20)), ("status", "review", ago(days=1))),
               reopen_history=json.dumps([{"at": ago(days=3), "by": "An Nguyen"}, {"at": ago(days=2), "by": "Binh"}, {"at": ago(hours=30), "by": "Binh"}]), created_at=STAMP, updated_at=STAMP),
        Ticket(id="REV-3", project_id=P, title="Out of memory", status="todo", activity_log=log(("assignee", DEV, ago(days=3))), created_at=STAMP, updated_at=STAMP),
        Ticket(id="REV-4", project_id=P, title="Keeps failing", status="todo", activity_log=log(("assignee", QA, ago(days=5))), created_at=STAMP, updated_at=STAMP),
        Ticket(id="REV-5", project_id=P, title="Asked again", status="todo", created_at=STAMP, updated_at=STAMP),
        Ticket(id="REV-6", project_id=P, title="Before the range", status="done",
               activity_log=log(("assignee", DEV, ago(days=13)), ("status", "review", ago(days=12))),
               reopen_history=json.dumps([{"at": ago(days=11), "by": "An Nguyen"}, {"at": ago(days=8), "by": "An Nguyen"}]), created_at=STAMP, updated_at=STAMP),
        Ticket(id="REV-7", project_id=P, title="Docs", status="review", activity_log=log(("status", "review", ago(days=1, hours=2))), created_at=STAMP, updated_at=STAMP),
        Ticket(id="FEW-1", project_id="p-rev-few", title="One", status="todo", created_at=STAMP, updated_at=STAMP),
    ]
    n = 0

    def run(member, ticket, state, queued, minutes=10, **kw):
        nonlocal n
        n += 1
        started = kw.pop("started_at", queued)
        ended = kw.pop("ended_at", None)
        if ended is None and state in ("finished", "failed", "cancelled", "timed_out"):
            ended = (datetime.fromisoformat(started) + timedelta(minutes=minutes)).isoformat() if started else None
        return AiRun(id=f"rr_{n:02d}", project_id=kw.pop("project_id", P), member_id=member, ticket_id=ticket, number=n, state=state,
                     queued_at=queued, started_at=started, ended_at=ended, **kw)

    rows += [
        # the Dev team in the last seven days: enough runs to be judged
        run(DEV, "REV-1", "finished", ago(days=6), 12, trigger="assign", started_by="An Nguyen", cost_usd=0.31, metered=True, tokens_in=12000, tokens_out=3000, report=report("Fixed add().", findings=["a", "b"])),
        run(DEV, "REV-1", "finished", ago(days=5, hours=20), 8, trigger="run_button", started_by="An Nguyen", instruction="Also   add tests\nfor sub().", cost_usd=0.62, metered=True, tokens_in=22000, tokens_out=6000),
        run(DEV, "REV-2", "finished", ago(days=3, hours=23), 30, trigger="assign", started_by="An Nguyen", cost_usd=0.45, metered=True, tokens_in=1, tokens_out=2,
            question=q("Which name do you want to keep?", ago(days=3, hours=22, minutes=50), "An Nguyen"), answer="widget"),
        run(DEV, "REV-2", "cancelled", ago(days=3, hours=21), 5, trigger="retry", started_by="Binh", ended_by="Binh", ended_reason="Wrong folder.", cost_usd=0.05, metered=True),
        run(DEV, "REV-2", "finished", ago(days=2, hours=12), 45, trigger="message", started_by="Binh", cost_usd=0.55, metered=True, tokens_in=5000, tokens_out=100),
        run(DEV, "REV-3", "failed", ago(days=2, hours=10), 3, stop_code="memory", peak_rss_mb=3100.4, ended_reason="Stopped: over 3072 MB.", started_by="board", cost_usd=0.2, metered=True),
        run(DEV, "REV-3", "failed", ago(days=2, hours=9), 4, stop_code="memory", peak_rss_mb=3250.5, ended_reason="Stopped: over 3072 MB.", trigger="retry", started_by="An Nguyen", cost_usd=0.2, metered=True),
        run(DEV, "REV-3", "timed_out", ago(days=2, hours=8), 60, ended_reason="No output for 30 minutes.", started_by="schedule", trigger="schedule"),
        run(DEV, "REV-5", "finished", ago(days=1, hours=20), 6, started_by="An Nguyen",
            question=q("Which branch should I use?", ago(days=1, hours=19, minutes=58), "An Nguyen",
                       previous=[{"text": "Which  branch should I USE?", "answer": "main", "answered_at": ago(days=1, hours=19, minutes=59), "answered_by": "Binh"}]),
            answer="main  please", cost_usd=0.1, metered=True),
        run(DEV, "REV-5", "finished", ago(days=1, hours=10), 6, started_by="An Nguyen",
            question=q("which branch should i use?", ago(days=1, hours=9, minutes=58), "Binh"), answer="main", cost_usd=0.1, metered=True),
        run(DEV, "REV-5", "cancelled", ago(days=1, hours=8), 2, ended_by="An Nguyen", ended_reason="", cost_usd=0.0),
        run(DEV, "REV-5", "cancelled", ago(days=1, hours=7), 2, ended_by="board", stop_code="board_closed", ended_reason="The board closed."),
        run(DEV, "REV-5", "cancelled", ago(hours=30), 2, ended_by="An Nguyen", ended_reason="Stopped with the pause."),
        run(DEV, None, "finished", ago(hours=20), 1, kind="assistant", started_by="An Nguyen", trigger="run_button"),
        run(DEV, "REV-1", "needs_input", ago(hours=3), started_by="Binh", trigger="run_button", question=q("Deploy now?")),
        # the QA team: fails often, near its monthly cap
        run(QA, "REV-4", "failed", ago(days=4, hours=5), 2, ended_reason="The CLI ended with exit code 1.", started_by="An Nguyen", cost_usd=0.6, metered=True),
        run(QA, "REV-4", "failed", ago(days=4, hours=4), 2, ended_reason="The CLI ended with exit code 1.", started_by="An Nguyen", cost_usd=0.6, metered=True),
        run(QA, "REV-4", "timed_out", ago(days=4, hours=3), 2, ended_reason="No output for 30 minutes, and the run never said why it stopped talking, so the board ended it after waiting a long while for anything at all.", cost_usd=0.4, metered=True),
        run(QA, "REV-4", "failed", ago(days=4, hours=2), 2, ended_reason=None, cost_usd=0.1, metered=True),
        run(QA, "REV-4", "finished", ago(days=4, hours=1), 2, cost_usd=0.2, metered=True),
        run(QA, "REV-4", "failed", ago(days=3, hours=1), 2, ended_reason="Other reason", cost_usd=0.01, metered=True),
        # the Doc team: two runs over its cap of one run
        run(DOC, "REV-7", "finished", ago(days=1, hours=5), 20, cost_usd=0.25, metered=True, started_by="An Nguyen"),
        run(DOC, "REV-7", "finished", ago(days=1, hours=4), 20, cost_usd=0.3, metered=True, started_by="An Nguyen"),
        # a removed team that still ran in the range
        run(OLD, "REV-7", "finished", ago(days=6, hours=12), 15, started_by="An Nguyen", trigger="run_button", instruction=""),
        # the range before (7 to 14 days ago)
        run(DEV, "REV-6", "finished", ago(days=12, hours=5), 25, cost_usd=0.9, metered=True, started_by="An Nguyen", trigger="run_button", instruction="Before the range"),
        run(DEV, "REV-6", "failed", ago(days=10), 5, ended_reason="exit 2", cost_usd=0.3, metered=True),
        run(QA, "REV-6", "cancelled", ago(days=9), 1, ended_by="Binh", ended_reason="Not now."),
        # older than 14 days but inside the month, and older than the month
        run(DEV, "REV-6", "finished", ago(days=20), 5, cost_usd=1.5, metered=True, started_by="An Nguyen", trigger="run_button"),
        run(QA, "REV-6", "finished", ago(days=25), 5, cost_usd=1.0, metered=True),
        run(DEV, "REV-6", "finished", ago(days=45), 5, cost_usd=9.0, metered=True, started_by="An Nguyen", trigger="run_button"),
        run(QA, "REV-6", "cancelled", ago(days=95), 5, ended_at=ago(days=80), ended_by="An Nguyen", ended_reason="Long ago"),
        # another project, and a project with only a few runs
        run("oth-team", None, "cancelled", ago(days=1), 5, project_id="p-rev-other", ended_by="An Nguyen"),
        run("few-team", "FEW-1", "finished", ago(days=2), 5, project_id="p-rev-few", started_by="An Nguyen", trigger="run_button", instruction="Just this"),
        run("few-team", "FEW-1", "failed", ago(days=1), 5, project_id="p-rev-few", ended_reason="exit 3"),
    ]
    ids = {r.number: r.id for r in rows if isinstance(r, AiRun)}
    # a project whose team is reliable but asks, costs and comes back (the findings to watch), and a healthy one
    W, OK = "p-rev-w", "p-rev-ok"
    rows += [
        Project(id=W, name="Watch", prefix="REW", color="#2E6F40"),
        Project(id=OK, name="Healthy", prefix="REH", color="#2E6F40"),
        Member(id="w-an", project_id=W, name="An Nguyen", color="#3B82F6", created_at=STAMP),
        Member(id="w-team", project_id=W, name="Watch Team", color="#2E6F40", kind="ai", created_at=STAMP),
        Member(id="w-two", project_id=W, name="Second Team", color="#2E6F40", kind="ai", created_at=STAMP),
        Member(id="ok-team", project_id=OK, name="Fine Team", color="#2E6F40", kind="ai", created_at=STAMP),
        AiTeam(id="w-team", project_id=W, cap_per_run=0.1, monthly_cap=100.0, created_at=STAMP, updated_at=STAMP),
        AiTeam(id="w-two", project_id=W, created_at=STAMP, updated_at=STAMP),
        AiTeam(id="ok-team", project_id=OK, monthly_cap=50.0, created_at=STAMP, updated_at=STAMP),
        Ticket(id="REW-1", project_id=W, title="Came back twice", status="in_progress", activity_log=log(("assignee", "w-team", ago(days=6)), ("status", "review", ago(days=5, hours=20))),
               reopen_history=json.dumps([{"at": ago(days=5), "by": "An Nguyen"}, {"at": ago(days=4), "by": "An Nguyen"}]), created_at=STAMP, updated_at=STAMP),
        Ticket(id="REW-2", project_id=W, title="Asks", status="todo", created_at=STAMP, updated_at=STAMP),
        Ticket(id="REW-3", project_id=W, title="Asks too", status="todo", created_at=STAMP, updated_at=STAMP),
        Ticket(id="REH-1", project_id=OK, title="Fine", status="review", activity_log=log(("assignee", "ok-team", ago(days=6)), ("status", "review", ago(days=5, hours=23, minutes=30))), created_at=STAMP, updated_at=STAMP),
    ]
    first_w = n + 1
    rows += [
        run("w-team", "REW-1", "finished", ago(days=5, hours=22), 30, project_id=W, started_by="An Nguyen", trigger="run_button", instruction="Do it", cost_usd=0.25, metered=True),
        run("w-team", "REW-1", "finished", ago(days=4, hours=22), 30, project_id=W, started_by="An Nguyen", trigger="run_button", instruction="Again", cost_usd=0.3, metered=True),
        run("w-team", "REW-2", "finished", ago(days=3, hours=5), 10, project_id=W, started_by="An Nguyen", trigger="run_button", instruction="Third",
            question=q("Which env?", ago(days=3, hours=4, minutes=58), "An Nguyen"), answer="staging", cost_usd=0.05, metered=True),
        run("w-team", "REW-2", "finished", ago(days=3, hours=4), 10, project_id=W, question=q("Which   ENV?", ago(days=3, hours=3, minutes=58), "An Nguyen"), answer=" staging ", cost_usd=0.05, metered=True),
        run("w-two", "REW-3", "finished", ago(days=3, hours=3), 10, project_id=W, question=q("which env?", ago(days=3, hours=2, minutes=58), "An Nguyen"), answer="prod"),
        run("w-team", "REW-3", "finished", ago(days=2, hours=3), 10, project_id=W, question=q("Something else?", ago(days=2, hours=2, minutes=58), "An Nguyen"), answer="no"),
    ]
    rows += [run("w-team", "REW-3", "finished", ago(days=1, hours=i), 5, project_id=W, tokens_in=100 * i, tokens_out=7) for i in range(1, 6)]
    rows += [run("ok-team", "REH-1", "finished", ago(days=6, hours=-i), 10 + i, project_id=OK, cost_usd=0.5, metered=True, tokens_in=1000, tokens_out=10) for i in range(11)]
    rows += [run("ok-team", "REH-1", "finished", ago(days=10, hours=-i), 20 + i, project_id=OK, cost_usd=0.5, metered=True) for i in range(3)]
    rows += [AiTouchMark(key=f"run:rr_{first_w + i:02d}", project_id=W, mark="avoidable", marked_by="An Nguyen", marked_at=ago(days=1)) for i in range(3)]

    def msg(i, run_no, at, peer, text, direction="in"):
        return AiRunMessage(id=f"msg_rev{i:02d}", run_id=ids[run_no], direction=direction, peer=peer, text=text, at=at)

    rows += [
        msg(1, 5, ago(days=2, hours=11, minutes=50), "Binh", "Use the   other folder,\nplease."),
        msg(2, 5, ago(days=2, hours=11, minutes=49), "Dev Team", "from an AI session"),
        msg(3, 5, ago(days=2, hours=11, minutes=48), "Binh", compact.WISH),
        msg(4, 5, ago(days=2, hours=11, minutes=47), "Binh", "an answer went out", direction="out"),
        msg(5, 5, ago(days=2, hours=11), "An Nguyen", "sent after the run had ended"),
        msg(6, 3, ago(days=3, hours=22, minutes=50, seconds=-4), "An Nguyen", "widget"),
        msg(7, 3, ago(days=3, hours=22, minutes=49), "An Nguyen", "and keep the old name " + "y" * 200),
        msg(8, 14, ago(hours=19, minutes=59, seconds=30), "An Nguyen", "to an assistant run"),
        msg(9, 15, ago(hours=2), "board", "from the board itself"),
        msg(10, 15, ago(hours=1), " Binh ", "Any news?"),
        msg(11, 32, ago(hours=23, minutes=58), "An Nguyen", "in the other project"),
        msg(12, 31, ago(days=94), "An Nguyen", "long ago, while it ran"),
    ]
    seq = 0

    def aud(action, at, by, member=None, name="", run_no=None, target=None, detail=None, project=P):
        nonlocal seq
        seq += 1
        return AiAudit(id=f"aud_rev{seq:02d}", seq=seq, project_id=project, member_id=member, member_name=name, on_behalf_of=by,
                       run_id=ids.get(run_no), action=action, target=target, result="info", detail=json.dumps(detail or {}), created_at=at, hash=f"h{seq}")

    rows += [
        aud(touches.EDIT_ACTION, ago(days=2, hours=11, minutes=40), "Binh", DEV, "Dev Team", 5, "REV-2", {"what": "the description", "via": "mcp"}),
        aud(touches.EDIT_ACTION, ago(days=2, hours=11, minutes=30), "An Nguyen", DEV, "Dev Team", 5, "REV-2", {}),
        aud(touches.EDIT_ACTION, ago(days=2, hours=11, minutes=20), "QA Team", DEV, "Dev Team", 5, "REV-2", {"what": "the title"}),
        aud(touches.SIGNIN_ACTION, ago(days=2, hours=5), "An Nguyen", detail={"account": "Work login", "account_id": "acct_rev", "team_ids": [DEV, QA, "rev-unknown"]}),
        aud(touches.SIGNIN_ACTION, ago(days=2, hours=4), "Binh", detail={}),
        aud("team_paused", ago(hours=29, minutes=58, seconds=30), "An Nguyen", DEV, "Dev Team", detail={"cancel_current": True}),
        aud("team_resumed", ago(hours=29), "An Nguyen", DEV, "Dev Team"),
        aud("team_paused", ago(days=1, hours=7, minutes=59), "An Nguyen", DEV, "", detail={"cancel_current": False}),
        aud("project_paused", ago(hours=10), "Binh", detail={"cancel_running": False, "via": "mcp"}),
        aud("project_resumed", ago(hours=9), "Binh"),
        aud("project_paused", ago(days=9, minutes=-1), "Binh"),
        aud("team_removed", ago(days=6), "An Nguyen", OLD, "Old Team"),
        aud("team_paused", ago(hours=8), "scheduler", QA, "QA Team"),
        aud("run_queued", ago(hours=7), "An Nguyen", DEV, "Dev Team", 15, "REV-1"),
        aud("team_paused", ago(hours=6), "An Nguyen", "oth-team", "Other Team", project="p-rev-other", detail={"cancel_current": True}),
        aud("team_paused", ago(days=100), "An Nguyen", QA, "QA Team"),
    ]
    rows += [
        AiTouchMark(key=f"answer:{ids[3]}", project_id=P, mark="needed", marked_by="An Nguyen", marked_at=ago(days=1)),
        AiTouchMark(key=f"run:{ids[2]}", project_id=P, mark="avoidable", marked_by="Binh", marked_at=ago(days=1)),
        AiTouchMark(key=f"stop:{ids[4]}", project_id=P, mark="avoidable", marked_by="Binh", marked_at=ago(days=1), lesson_id="les_done"),
        AiTouchMark(key="msg:msg_rev01", project_id=P, mark="avoidable", marked_by="Binh", marked_at=ago(hours=5)),
        AiTouchMark(key="audit:aud_rev01", project_id=P, mark="avoidable", marked_by="Binh", marked_at=ago(hours=4)),
        AiTouchMark(key="audit:aud_rev06", project_id=P, mark="needed", marked_by="An Nguyen", marked_at=ago(hours=3)),
        AiTouchMark(key=f"run:{ids[33]}", project_id="p-rev-few", mark="avoidable", marked_by="An Nguyen", marked_at=ago(hours=3)),
        AiTouchMark(key="audit:aud_gone", project_id=P, mark="avoidable", marked_by="An Nguyen", marked_at=ago(hours=3)),
    ]
    return rows, ids


TABLES = {
    Project: "project",
    Member: "member",
    AiTeam: "ai_team",
    AiAccount: "ai_account",
    AiProjectSettings: "ai_project_settings",
    Ticket: "ticket",
    AiRun: "ai_run",
    AiRunMessage: "ai_run_message",
    AiRunStep: "ai_run_step",
    AiAudit: "ai_audit",
    AiTouchMark: "ai_touch_mark",
    AiSessionHistory: "ai_session_history",
    AiLesson: "ai_lesson",
}


def dump_rows(rows):
    dumped: dict = {}
    for r in rows:
        dumped.setdefault(TABLES[type(r)], []).append(row_dict(r))
    return dumped


async def put(rows):
    async with database.async_session() as session:
        for r in rows:
            session.add(r)
        await session.commit()
        for r in rows:
            await session.refresh(r)
    return dump_rows(rows)


async def mark_row(key):
    async with database.async_session() as session:
        row = await session.get(AiTouchMark, key)
        return row_dict(row) if row else None


async def audits_after(seq):
    async with database.async_session() as session:
        rows = (await session.exec(select(AiAudit).where(AiAudit.seq > seq).order_by(col(AiAudit.seq)))).all()
        return [
            {k: v for k, v in row_dict(r).items() if k in ("project_id", "member_id", "member_name", "on_behalf_of", "run_id", "action", "target", "result", "detail")}
            for r in rows
        ]


async def last_seq():
    async with database.async_session() as session:
        last = (await session.exec(select(AiAudit).order_by(col(AiAudit.seq).desc()).limit(1))).first()
        return last.seq if last else 0


def refused(exc):
    return {"error": [type(exc).__name__, str(exc)]}


async def review():
    rows, ids = review_rows()
    res: dict = {"rows": await put(rows), "run_ids": {str(k): v for k, v in ids.items()}}
    async with database.async_session() as session:
        since = {k: touches.since_of(k) for k in ("24h", "7d", "30d", "90d")}
        res["collect"] = {k: await touches.collect(session, P, at) for k, at in since.items()}
        res["collect_other"] = {
            "p-rev-other": await touches.collect(session, "p-rev-other", since["90d"]),
            "p-rev-few": await touches.collect(session, "p-rev-few", since["90d"]),
            "p-rev-empty": await touches.collect(session, "p-rev-empty", since["90d"]),
            "p-no-such": await touches.collect(session, "p-no-such", since["90d"]),
        }
        every = await touches.collect(session, P, NOW - timedelta(days=400))
        keys = [t["id"] for t in every] + [
            "", "answer:", "answer:nope", f"answer:{ids[9]}:1", f"answer:{ids[9]}:5", f"run:{ids[1]}", f"retry:{ids[4]}", f"stop:{ids[13]}", f"stop:{ids[12]}",
            "stop:", "msg:", "msg:nope", "msg:msg_rev05", "msg:msg_rev11", "audit:", "audit:nope", "audit:aud_rev12", "audit:aud_rev15", "odd", "odd:key:with:colons",
            f"stop:{ids[31]}", f"run:{ids[33]}",
        ]
        res["collect_all"] = every
        res["by_key"] = [{"key": k, "since": r, "out": await touches.collect(session, P, since[r], key=k)} for k in keys for r in ("24h", "90d")]
        stepped = []
        for range_key in ("7d", "24h", "30d", "90d", "bogus"):
            stepped.append({"args": {"range_key": range_key}, "out": await touches.stepped_in(session, P, range_key=range_key)})
        for kw in (
            {"team_id": DEV}, {"team_id": QA}, {"team_id": "rev-unknown"}, {"kind": "answer"}, {"kind": "pause"}, {"kind": "nope"}, {"mark": "needed"}, {"mark": "avoidable"},
            {"mark": "unmarked"}, {"mark": "other"}, {"team_id": DEV, "kind": "stop", "mark": "avoidable"}, {"team_id": "", "kind": "", "mark": ""},
        ):
            stepped.append({"args": {"range_key": "30d", **kw}, "out": await touches.stepped_in(session, P, range_key="30d", **kw)})
        for project in ("p-rev-w", "p-rev-other", "p-rev-few", "p-rev-empty", "p-no-such"):
            stepped.append({"args": {"range_key": "7d", "project_id": project}, "out": await touches.stepped_in(session, project, range_key="7d")})
        res["stepped_in"] = stepped
        res["stepped_default"] = await touches.stepped_in(session, P)
        res["health"] = [
            {"project_id": project, "range_key": r, "out": await health.health(session, project, r), "keys": list(await health.health(session, project, r))}
            for project in (P, "p-rev-w", "p-rev-ok", "p-rev-other", "p-rev-few", "p-rev-empty", "p-no-such")
            for r in ("7d", "30d", "bogus")
        ]
        res["health_default"] = await health.health(session, P)
    return res


async def marks_and_lessons(ids):
    """`set_mark` and `make_lesson` step by step; after each step the mark's row."""
    steps = []
    LONG = "word " * 121

    async def step(call, **kw):
        async with database.async_session() as session:
            try:
                if call == "set_mark":
                    got = await touches.set_mark(session, kw["project_id"], kw["key"], kw["mark"], by=kw["by"])
                else:
                    got = await touches.make_lesson(session, kw["project_id"], kw["key"], kw["text"], by=kw["by"])
                result = {"ok": got}
            except Exception as exc:  # noqa: BLE001
                result = refused(exc)
        steps.append({"call": call, **kw, **result, "row": await mark_row(kw["key"])})

    retry_key, answer_key, hand_key = f"retry:{ids[7]}", f"answer:{ids[9]}:1", f"run:{ids[2]}"
    await step("set_mark", project_id=P, key=retry_key, mark="maybe", by="An Nguyen")
    await step("set_mark", project_id=P, key=retry_key, mark="", by="An Nguyen")
    await step("set_mark", project_id=P, key=retry_key, mark=None, by="An Nguyen")
    await step("set_mark", project_id=P, key=retry_key, mark="needed", by="An Nguyen")
    await step("set_mark", project_id=P, key=retry_key, mark="avoidable", by="Binh")
    await step("set_mark", project_id="p-rev-other", key=retry_key, mark="needed", by="An Nguyen")
    await step("set_mark", project_id="p-rev-other", key=retry_key, mark=None, by="An Nguyen")
    await step("set_mark", project_id=P, key=retry_key, mark=None, by="An Nguyen")
    await step("set_mark", project_id=P, key="run:nope", mark="needed", by="An Nguyen")
    await step("set_mark", project_id=P, key="audit:aud_rev12", mark="needed", by="An Nguyen")
    await step("set_mark", project_id=P, key="audit:aud_gone", mark="needed", by="An Nguyen")
    await step("set_mark", project_id=P, key=f"stop:{ids[4]}", mark=None, by="An Nguyen")
    await step("set_mark", project_id=P, key=f"stop:{ids[4]}", mark="needed", by="An Nguyen")
    await step("set_mark", project_id=P, key=answer_key, mark="avoidable", by="An Nguyen")
    # lessons
    await step("make_lesson", project_id=P, key="run:nope", text=None, by="An Nguyen")
    await step("make_lesson", project_id=P, key=f"answer:{ids[3]}", text=None, by="An Nguyen")
    await step("make_lesson", project_id=P, key=f"stop:{ids[4]}", text="again", by="An Nguyen")
    await step("make_lesson", project_id=P, key=hand_key, text=LONG, by="An Nguyen")
    await step("make_lesson", project_id=P, key=hand_key, text="  Run the tests   before\nasking.  ", by="An Nguyen")
    await step("make_lesson", project_id=P, key=hand_key, text="Another lesson.", by="An Nguyen")
    await step("set_mark", project_id=P, key=hand_key, mark=None, by="An Nguyen")
    await step("make_lesson", project_id=P, key="msg:msg_rev01", text="Run the tests before asking.", by="Binh")
    await step("make_lesson", project_id=P, key="msg:msg_rev01", text="   ", by="Binh")
    await step("make_lesson", project_id=P, key=answer_key, text=None, by="Binh")
    await step("make_lesson", project_id=P, key="audit:aud_rev01", text="", by="Binh")
    async with database.async_session() as session:
        lessons = (await session.exec(select(AiLesson).where(AiLesson.project_id == P).order_by(col(AiLesson.created_at)))).all()
        kept = [{k: v for k, v in row_dict(x).items() if k in ("text", "state", "source_ticket_id", "source_run_id", "proposed_by", "kept_by")} for x in lessons]
    return {"steps": steps, "lessons": kept}


async def recording():
    """`record_edit`, `record_signin`, `record_pause`: what they answer and the audit entries they write."""
    PR = "p-rec"
    rows = [
        Project(id=PR, name="Recording", prefix="REC", color="#2E6F40"),
        Project(id="p-rec2", name="Recording two", prefix="RE2", color="#2E6F40"),
        Member(id="rec-an", project_id=PR, name="An Nguyen", color="#3B82F6", created_at=STAMP),
        Member(id="rec-team", project_id=PR, name="Rec Team", color="#2E6F40", kind="ai", created_at=STAMP),
        Member(id="rec-team2", project_id=PR, name="Rec Two", color="#2E6F40", kind="ai", created_at=STAMP),
        Member(id="rec2-team", project_id="p-rec2", name="Far Team", color="#2E6F40", kind="ai", created_at=STAMP),
        AiTeam(id="rec-team", project_id=PR, account_id="acct_rec", created_at=STAMP, updated_at=STAMP),
        AiTeam(id="rec-team2", project_id=PR, account_id="acct_rec", created_at=STAMP, updated_at=STAMP),
        AiTeam(id="rec2-team", project_id="p-rec2", account_id="acct_rec", created_at=STAMP, updated_at=STAMP),
        AiAccount(id="acct_rec", name="Rec login", cli="claude", folder=f"{work}/accounts/rec", status="signed_in", created_at=STAMP, updated_at=STAMP),
        AiAccount(id="acct_none", name="Nobody's", cli="claude", folder=f"{work}/accounts/none", status="signed_in", created_at=STAMP, updated_at=STAMP),
        Ticket(id="REC-1", project_id=PR, title="Edited", created_at=STAMP, updated_at=STAMP),
        Ticket(id="REC-2", project_id=PR, title="Quiet", created_at=STAMP, updated_at=STAMP),
        Ticket(id="REC-3", project_id=PR, title="Two runs", created_at=STAMP, updated_at=STAMP),
        AiRun(id="rec_r1", project_id=PR, member_id="rec-team", ticket_id="REC-1", number=1, state="running", queued_at=ago(hours=1)),
        AiRun(id="rec_r2", project_id=PR, member_id="rec-team", ticket_id="REC-2", number=1, state="queued", queued_at=ago(hours=1)),
        AiRun(id="rec_r3", project_id=PR, member_id="rec-team", ticket_id="REC-2", number=2, state="finished", queued_at=ago(hours=2)),
        AiRun(id="rec_r4", project_id=PR, member_id="rec-team", ticket_id="REC-3", number=1, state="needs_input", queued_at=ago(hours=1)),
        AiRun(id="rec_r5", project_id=PR, member_id="rec-gone", ticket_id="REC-3", number=2, state="starting", queued_at=ago(minutes=50)),
        AiRun(id="rec_r6", project_id=PR, member_id="rec-team2", ticket_id="REC-3", number=3, state="running", kind="assistant", queued_at=ago(minutes=40)),
        # an entry of four minutes ago on the second run of REC-3, by An: her next edit is the same touch
        AiAudit(id="aud_rec01", seq=900, project_id=PR, member_id="rec-gone", on_behalf_of="An Nguyen", run_id="rec_r5", action=touches.EDIT_ACTION, target="REC-3",
                result="info", detail="{}", created_at=ago(minutes=4), hash="h900"),
        AiAudit(id="aud_rec02", seq=901, project_id=PR, member_id="rec-team", on_behalf_of="An Nguyen", run_id="rec_r4", action=touches.EDIT_ACTION, target="REC-3",
                result="info", detail="{}", created_at=ago(minutes=6), hash="h901"),
    ]
    res: dict = {"rows": await put(rows)}
    calls = []
    EDITS = [
        ("REC-1", "An Nguyen", "the description"),
        ("REC-1", "An Nguyen", ""),
        ("REC-1", "Rec Team", "the title"),
        ("REC-1", "board", "the title"),
        ("REC-1", None, "the title"),
        ("REC-1", "", "the title"),
        ("REC-2", "An Nguyen", "the title"),
        ("REC-3", "An Nguyen", "the criteria"),
        ("REC-3", "Binh", "the criteria"),
        ("REC-9", "An Nguyen", "nothing"),
    ]
    for ticket_id, by, what in EDITS:
        before = await last_seq()
        async with database.async_session() as session:
            n = await touches.record_edit(session, ticket_id, by=by, what=what)
        calls.append({"call": "record_edit", "ticket_id": ticket_id, "by": by, "what": what, "out": n, "audit": await audits_after(before)})
    for account_id, by in (("acct_rec", "An Nguyen"), ("acct_none", "An Nguyen")):
        before = await last_seq()
        async with database.async_session() as session:
            account = await session.get(AiAccount, account_id)
            n = await touches.record_signin(session, account, by)
        calls.append({"call": "record_signin", "account_id": account_id, "by": by, "out": n, "audit": await audits_after(before)})
    for action, by, detail in (("project_paused", "An Nguyen", {"cancel_running": True, "reason": "Lunch"}), ("project_resumed", "Binh", None)):
        before = await last_seq()
        await touches.record_pause(PR, action, by, detail)
        calls.append({"call": "record_pause", "action": action, "by": by, "detail": detail, "audit": await audits_after(before)})
    res["calls"] = calls
    return res


# ---------------------------------------------------------------------------------------------------------------------
# session history
# ---------------------------------------------------------------------------------------------------------------------
async def histories():
    PH = "p-his"
    rows: list = [
        Project(id=PH, name="History", prefix="HIS", color="#2E6F40"),
        Member(id="his-an", project_id=PH, name="An Nguyen", color="#3B82F6", created_at=STAMP),
        Member(id="his-team", project_id=PH, name="History Team", color="#2E6F40", kind="ai", created_at=STAMP),
        AiTeam(id="his-team", project_id=PH, created_at=STAMP, updated_at=STAMP),
        Ticket(id="HIS-1", project_id=PH, title="Closed twice", created_at=STAMP, updated_at=STAMP),
        Ticket(id="HIS-2", project_id=PH, title="Never closed", created_at=STAMP, updated_at=STAMP),
        Ticket(id="HIS-3", project_id=PH, title="Working", created_at=STAMP, updated_at=STAMP),
        Ticket(id="HIS-4", project_id=PH, title="Asks the assistant", created_at=STAMP, updated_at=STAMP),
        Ticket(id="HIS-5", project_id=PH, title="Assistant fails", created_at=STAMP, updated_at=STAMP),
        Ticket(id="HIS-6", project_id=PH, title="Nothing since", created_at=STAMP, updated_at=STAMP),
        Ticket(id="HIS-7", project_id=PH, title="A long talk", created_at=STAMP, updated_at=STAMP),
        AiSessionHistory(id="ses_his1", project_id=PH, ticket_id="HIS-1", member_id="his-team", title="The first try", summary="  Tried the easy way; it failed on Windows.\n",
                         session_ids=json.dumps(["sess-a", "sess-b"]), run_ids=json.dumps(["his_r1"]), started_at=ago(days=20), ended_at=ago(days=10), created_by="An Nguyen", summarised_by="digest"),
        AiSessionHistory(id="ses_his2", project_id=PH, ticket_id="HIS-1", member_id="his-team", title="", summary="x" * 900,
                         session_ids=json.dumps(["sess-c", 7]), run_ids=json.dumps(["his_r2", "his_r3"]), started_at=ago(days=9), ended_at=ago(days=5), created_by="An Nguyen", summarised_by="small-model"),
        AiSessionHistory(id="ses_his3", project_id=PH, ticket_id="HIS-6", member_id="his-team", title="Done", summary="All of it.", session_ids="[]", ended_at=ago(days=1)),
    ]
    rows += [
        AiSessionHistory(id=f"ses_many{i}", project_id=PH, ticket_id="HIS-7", member_id="his-team", title=f"Talk {i}", summary=f"Summary {i}",
                         session_ids=json.dumps([f"many-{i}"]), ended_at=ago(days=30 - i))
        for i in range(8)
    ]

    def run(i, ticket, state, queued, **kw):
        kw.setdefault("started_at", queued)
        return AiRun(id=f"his_r{i}", project_id=PH, member_id=kw.pop("member_id", "his-team"), ticket_id=ticket, number=i, state=state, queued_at=queued, **kw)

    rows += [
        run(1, "HIS-1", "finished", ago(days=20), session_id="sess-a"),
        run(2, "HIS-1", "finished", ago(days=9), session_id="sess-c"),
        run(3, "HIS-1", "failed", ago(days=8), session_id="sess-c"),
        run(4, "HIS-1", "finished", ago(days=4), session_id="sess-d", started_by="An Nguyen", trigger="assign", instruction="  Fix   add()\n in calc.py  ", summary="Fixed add().",
            report=json.dumps({"status": "done", "summary": "  Fixed add() and added tests.  ", "open_items": ["sub() is untested", 2, "x", "y", "z", "w", "seventh"]})),
        run(5, "HIS-1", "cancelled", ago(days=3), session_id="sess-d", started_by="", trigger="", instruction="", summary="  Stopped half way.  ", report=""),
        run(6, "HIS-1", "cancelled", ago(days=2), session_id="sess-e", started_at=None, instruction="never started"),
        run(7, "HIS-1", "finished", ago(days=1), session_id=None, instruction="x" * 800, report=json.dumps({"summary": "", "open_items": []})),
        run(8, "HIS-2", "finished", ago(days=2), session_id="sess-f", instruction="Only run"),
        run(9, "HIS-3", "finished", ago(days=2), session_id="sess-g"),
        run(10, "HIS-3", "running", ago(hours=1), session_id="sess-g"),
        run(11, "HIS-4", "finished", ago(days=2), session_id="sess-h", instruction="Summarise me"),
        run(12, "HIS-5", "finished", ago(days=2), session_id="sess-i", instruction="", member_id="his-gone"),
        run(13, "HIS-5", "finished", ago(days=1), session_id="sess-i", instruction=""),
        run(14, "HIS-6", "finished", ago(days=3), session_id="sess-j"),
    ]
    rows += [AiRunStep(run_id="his_r4", seq=i, at=ago(days=4, minutes=-i), kind="text" if i % 3 else "command", title=f"said {i} " + "t" * (250 if i == 40 else 5)) for i in range(1, 61)]
    rows += [AiRunStep(run_id="his_r5", seq=1, at=ago(days=3), kind="text", agent_id="sub", title="a subagent's words")]
    rows += [AiRunMessage(id=f"msg_his{i:02d}", run_id="his_r4", direction="in" if i % 2 else "out", peer="An Nguyen" if i % 2 else "lead", text=f"note {i} " + "n" * (400 if i == 2 else 3),
                          at=ago(days=4, minutes=-i)) for i in range(1, 11)]
    res: dict = {"rows": await put(rows)}
    async with database.async_session() as session:
        tickets = ["HIS-1", "HIS-2", "HIS-6", "HIS-7", "HIS-9"]
        res["rows_for"] = [{"ticket_id": t, "limit": n, "out": [r.id for r in await session_history.rows_for(session, t, n)]} for t in tickets for n in (20, 1, 3)]
        res["list_for_ticket"] = {t: await session_history.list_for_ticket(t) for t in tickets}
        res["list_for_ticket_10"] = {t: await session_history.list_for_ticket(t, 10) for t in ("HIS-7",)}
        res["closed_session_ids"] = {t: sorted(await session_history.closed_session_ids(session, t)) for t in tickets}
        res["prompt_block"] = [{"ticket_id": t, "limit": n, "out": await session_history.prompt_block(session, t, n)} for t in tickets for n in (5, 1)]
        groups = {"HIS-1": [4, 5, 6, 7], "one": [4], "empty": [], "HIS-2": [8], "plain": [1, 2, 3]}
        by_id = {r.id: r for r in rows if isinstance(r, AiRun)}
        res["digest"] = [{"runs": [f"his_r{i}" for i in idx], "out": await session_history._digest(session, [by_id[f"his_r{i}"] for i in idx])} for idx in groups.values()]
        # a digest longer than the model is given keeps its end
        long_runs = [AiRun(id=f"his_long{i}", project_id=PH, member_id="his-team", ticket_id="HIS-1", number=100 + i, state="finished", queued_at=ago(days=1),
                           instruction=f"{i} " + "i" * 698, summary="s" * 1300) for i in range(12)]
        text = await session_history._digest(session, long_runs)
        res["digest_long"] = {"runs": [row_dict(r) for r in long_runs], "chars": len(text), "head": text[:80], "tail": text[-80:]}

    # start_over: the assistant answers, fails, or is not there
    from services.assistant import engine

    asked = []
    answers = {
        "HIS-4": engine.Turn(run_id="", structured={"title": "  A fine title  " + "t" * 100, "summary": "  The team summarised it.  "}, model="claude-light"),
        "HIS-1": engine.Turn(run_id="", structured={"title": "", "summary": "Second try worked."}, model=None),
        "HIS-2": engine.Turn(run_id="", structured={"title": "Ignored", "summary": "   "}, model="m"),
        "HIS-5": engine.Turn(run_id="", state="failed", structured={"title": "T", "summary": "Not used."}, model="m"),
    }

    async def oneshot(skill, inputs, *, by="user", timeout_s=240.0, model="x"):
        asked.append({"skill": skill, "inputs": inputs, "by": by, "model": model})
        ticket_id = inputs["ticket"].split(" ")[0]
        if ticket_id not in answers:
            raise RuntimeError("no assistant")
        return answers[ticket_id]

    engine.oneshot = oneshot
    overs = []
    for ticket_id in ("HIS-9", "HIS-3", "HIS-6", "HIS-4", "HIS-1", "HIS-2", "HIS-5", "HIS-1"):
        try:
            got = await session_history.start_over(ticket_id, by="An Nguyen")
            result = {"ok": {k: v for k, v in got.items() if k not in ("id", "ended_at")}}
        except RunError as exc:
            result = refused(exc)
        overs.append({"ticket_id": ticket_id, **result})
    res["start_over"] = overs
    res["asked"] = asked
    return res


# ---------------------------------------------------------------------------------------------------------------------
# compact
# ---------------------------------------------------------------------------------------------------------------------
SCRIPT = """#!/bin/sh
# a stand-in for `claude -p /compact --resume <session> ...`: it says what it was started with and "compacts"
printf '%s\\n' "$@" > "$PWD/args.txt"
echo 'not json'
echo '{"type":"system","subtype":"init","session_id":"sess-new"}'
case "$4" in
  sess-quiet) echo '{"type":"result","session_id":"sess-quiet-2"}' ;;
  *) echo '{"type":"system","subtype":"compact_boundary","compact_metadata":{"pre_tokens":150000,"post_tokens":8000}}' ;;
esac
echo '{"type":"result","subtype":"success","session_id":"sess-after"}'
"""


async def compacting():
    PC = "p-com"
    repo = f"{work}/compact-repo"
    os.makedirs(repo, exist_ok=True)
    tool = f"{work}/tools/compact-claude"
    os.makedirs(os.path.dirname(tool), exist_ok=True)
    Path(tool).write_text(SCRIPT)
    os.chmod(tool, os.stat(tool).st_mode | stat.S_IXUSR)
    # the sessions the CLI "has on disk"
    for name in ("sess-idle", "sess-quiet"):
        folder = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "compact-repo"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{name}.jsonl").write_text("{}\n")
    rows = [
        Project(id=PC, name="Compact", prefix="COM", color="#2E6F40"),
        Member(id="com-team", project_id=PC, name="Compact Team", color="#2E6F40", kind="ai", created_at=STAMP),
        Member(id="com-bare", project_id=PC, name="Bare Team", color="#2E6F40", kind="ai", created_at=STAMP),
        AiTeam(id="com-team", project_id=PC, cli_path=tool, working_dir=repo, model="light-one", created_at=STAMP, updated_at=STAMP),
        AiTeam(id="com-bare", project_id=PC, cli_path=tool, working_dir=None, created_at=STAMP, updated_at=STAMP),
        Ticket(id="COM-1", project_id=PC, title="Working", created_at=STAMP, updated_at=STAMP),
        Ticket(id="COM-2", project_id=PC, title="No conversation", created_at=STAMP, updated_at=STAMP),
        Ticket(id="COM-3", project_id=PC, title="Idle", created_at=STAMP, updated_at=STAMP),
        Ticket(id="COM-4", project_id=PC, title="Session gone", created_at=STAMP, updated_at=STAMP),
        Ticket(id="COM-5", project_id=PC, title="Does not compact", created_at=STAMP, updated_at=STAMP),
        Ticket(id="COM-6", project_id=PC, title="No folder", created_at=STAMP, updated_at=STAMP),
        Ticket(id="COM-7", project_id=PC, title="Team gone", created_at=STAMP, updated_at=STAMP),
        AiRun(id="com_r1", project_id=PC, member_id="com-team", ticket_id="COM-1", number=1, state="running", session_id="sess-live", queued_at=ago(hours=1)),
        AiRun(id="com_r2", project_id=PC, member_id="com-team", ticket_id="COM-2", number=1, state="finished", session_id=None, queued_at=ago(hours=1)),
        AiRun(id="com_r3", project_id=PC, member_id="com-team", ticket_id="COM-3", number=1, state="finished", session_id="sess-old", queued_at=ago(hours=3)),
        AiRun(id="com_r4", project_id=PC, member_id="com-team", ticket_id="COM-3", number=2, state="finished", session_id="sess-idle", queued_at=ago(hours=2), context_used=150000),
        AiRun(id="com_r5", project_id=PC, member_id="com-team", ticket_id="COM-4", number=1, state="finished", session_id="sess-gone", queued_at=ago(hours=2)),
        AiRun(id="com_r6", project_id=PC, member_id="com-team", ticket_id="COM-5", number=1, state="finished", session_id="sess-quiet", model="run-model", queued_at=ago(hours=2)),
        AiRun(id="com_r7", project_id=PC, member_id="com-bare", ticket_id="COM-6", number=1, state="finished", session_id="sess-idle", queued_at=ago(hours=2)),
        AiRun(id="com_r8", project_id=PC, member_id="com-nobody", ticket_id="COM-7", number=1, state="finished", session_id="sess-idle", queued_at=ago(hours=2)),
    ]
    res: dict = {"rows": await put(rows), "script": SCRIPT, "tool": norm(tool), "repo": norm(repo), "sessions": ["sess-idle", "sess-quiet"]}
    calls = []
    for ticket_id in ("COM-1", "COM-2", "COM-3", "COM-4", "COM-5", "COM-6", "COM-7", "COM-9"):
        args_file = Path(repo) / "args.txt"
        args_file.unlink(missing_ok=True)
        try:
            result = {"ok": await compact.compact_ticket(ticket_id, by="An Nguyen " + "n" * 250)}
        except RunError as exc:
            result = refused(exc)
        async with database.async_session() as session:
            runs = (await session.exec(select(AiRun).where(AiRun.ticket_id == ticket_id).order_by(col(AiRun.number)))).all()
            after = [{"id": r.id, "session_id": r.session_id, "context_used": r.context_used} for r in runs]
            msgs = (await session.exec(select(AiRunMessage).where(col(AiRunMessage.run_id).in_([r.id for r in runs])))).all()
            messages = [{"run_id": m.run_id, "direction": m.direction, "peer": m.peer, "text": m.text} for m in msgs]
        calls.append({
            "ticket_id": ticket_id, **result, "runs": after, "messages": messages,
            "args": norm(args_file.read_text().splitlines()) if args_file.exists() else None,
        })
    res["calls"] = calls
    return res


async def main():
    await database.init_db()
    rev = await review()
    ids = {int(k): v for k, v in rev["run_ids"].items()}
    rev["marks"] = await marks_and_lessons(ids)
    out["review"] = rev
    out["recording"] = await recording()
    out["history"] = await histories()
    out["compact"] = await compacting()
    text = json.dumps(out, ensure_ascii=False, indent=1)
    OUT.write_text(text + "\n", encoding="utf-8")
    print(f"{OUT.name}: {len(text.encode()) // 1024} KB")
    print("  touches in 90d:", len(rev["collect"]["90d"]), "kinds:", sorted({t["kind"] for t in rev["collect"]["90d"]}))
    for h in rev["health"][::3]:
        print("  health", h["range_key"], h["out"]["state"], "|", h["out"]["text"], "| fixes:", [f["id"] for f in h["out"]["fixes"]])
    print("  marks refused:", sum("error" in s for s in rev["marks"]["steps"]), "of", len(rev["marks"]["steps"]))
    print("  start_over:", [(o["ticket_id"], "error" in o) for o in out["history"]["start_over"]])
    print("  compact:", [(c["ticket_id"], c.get("ok") or c["error"][1][:40]) for c in out["compact"]["calls"]])


asyncio.run(main())
