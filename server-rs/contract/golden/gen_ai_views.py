"""Golden vectors for the views of the AI team (`crates/kb-ai-work`): `timeline`, `flow` (the map and the scope picker) and
`activity` (the roles of a team and the recent runs), over recorded sets of rows built with the Python models: teams
with roles, runs in every state and of every trigger, subagents with several stretches of work and open ones, steps of
every kind (large inputs and outputs too), questions open and answered, notes between teams, a paused project, a crowded
project (more arrows than a picture holds) and a project with no teams.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_views.py
Writes `ai_views_rows.json` (the rows: the columns that differ from a fresh row of each table, with `defaults` per
table), `ai_timeline.json`, `ai_flow.json` and `ai_activity.json` (the `calls`: name, arguments, the Python result) and
`ai_timeline_pure.json` next to this file. The clock is frozen: `datetime.now` of the three modules answers NOW, and `budget.today_start` the UTC
midnight before it. The generator runs with its own temporary KANBAN_* folders and never opens the developer's database.
"""

import asyncio
import json
import os
import sys
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

work = tempfile.mkdtemp(prefix="gen-ai-views-")
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude"
os.environ["HOME"] = f"{work}/home"
os.environ["TZ"] = "UTC"
time.tzset()
sys.path.insert(0, os.getcwd())

import database  # noqa: E402
from models import (  # noqa: E402
    AiProjectSettings, AiRun, AiRunAgent, AiRunMessage, AiRunStep, AiTeam, Member, Ticket,
)
from services.ai import activity, budget, flow, timeline  # noqa: E402

HERE = Path(__file__).parent
NOW = datetime(2026, 11, 12, 10, 0, 0, 250000, tzinfo=UTC)
TODAY = datetime(2026, 11, 12, 0, 0, 0, tzinfo=UTC)


class FixedDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz else NOW.replace(tzinfo=None)


timeline.datetime = FixedDT
flow.datetime = FixedDT
activity.datetime = FixedDT
budget.today_start = lambda: TODAY


def ago(minutes: float, seconds: float = 0, micro: int = 0) -> str:
    at = NOW - timedelta(minutes=minutes, seconds=seconds)
    if micro:
        at = at.replace(microsecond=micro)
    elif at.microsecond == 250000:
        at = at.replace(microsecond=0)
    return at.isoformat()


ROWS: list[tuple[str, object]] = []


def add(row):
    ROWS.append((type(row).__name__, row))
    return row


def person(pid, mid, name):
    return add(Member(id=mid, project_id=pid, name=name, kind="person", color="#3B82F6", created_at=ago(9000)))


def team(pid, mid, name, color="#8B5CF6", **kw):
    add(Member(id=mid, project_id=pid, name=name, kind="ai", color=color, created_at=ago(9000)))
    return add(AiTeam(id=mid, project_id=pid, created_at=ago(9000), updated_at=ago(9000), **kw))


def ticket(pid, tid, title, **kw):
    return add(Ticket(id=tid, project_id=pid, title=title, created_at=ago(8000), updated_at=ago(8000), **kw))


_run_n = [0]


def run(pid, rid, member, ticket_id, state, queued, *, trigger="assign", started=None, ended=None, by="Ann Lee", **kw):
    _run_n[0] += 1
    return add(AiRun(
        id=rid, project_id=pid, member_id=member, ticket_id=ticket_id, state=state, trigger=trigger, started_by=by,
        number=kw.pop("number", _run_n[0]), queued_at=queued, started_at=started, ended_at=ended, **kw,
    ))


_agent_n = [0]


def agent(rid, aid, kind, started, ended=None, steps=0, text=None, claude_id=None):
    _agent_n[0] += 1
    return add(AiRunAgent(id=aid, run_id=rid, agent_type=kind, started_at=started, ended_at=ended, steps_count=steps, last_text=text, claude_id=claude_id))


_step_n = [0]


def step(rid, seq, at, kind, title="", agent_id=None, detail=None, output=None, tool=None):
    _step_n[0] += 1
    return add(AiRunStep(
        id=_step_n[0], run_id=rid, seq=seq, at=at, agent_id=agent_id, kind=kind, title=title, tool=tool,
        detail=json.dumps(detail if detail is not None else {}), output=output,
    ))


def mark(rid, seq, at, aid, event, name="role"):
    return step(rid, seq, at, "role", f"{name} {'works again' if event == 'start' else 'finished'}", agent_id=aid, detail={"event": event})


def msg(rid, mid, peer, text, at, direction="in", delivered=None):
    return add(AiRunMessage(id=mid, run_id=rid, direction=direction, peer=peer, text=text, at=at, delivered_at=delivered))


KINDS = ["tool", "edit", "create", "read", "command", "search", "skill", "subagent", "board", "text", "hook", "rate_limited", "start", "end", "error", "message"]


# --------------------------------------------------------------------------------------------------------------------
# p1: a busy project
# --------------------------------------------------------------------------------------------------------------------
P = "p1"
person(P, "m_ann", "Ann Lee")
person(P, "m_bo", "Bo Tran")
team(P, "m_alpha", "Alpha", "#8B5CF6")
team(P, "m_beta", "Beta", "#F59E0B")
team(P, "m_gamma", "Gamma", "#10B981", health="runner_missing")
team(P, "m_delta", "Delta", "#EF4444", health="not_logged_in", paused=True)
team(P, "m_eps", "Epsilon", "#06B6D4", paused=True)
ticket(P, "K-1", "The story", type="story", status="in-progress")
ticket(P, "K-2", "First child", parent_id="K-1", status="in-progress")
ticket(P, "K-3", "Second child", parent_id="K-1", blocked_by=json.dumps(["K-2", "K-9", "K-3"]), status="todo")
ticket(P, "K-4", "Standalone", blocked_by=json.dumps(["K-9"]), status="review")
ticket(P, "K-5", "Odd blocked_by", blocked_by="not json", status="done")
ticket(P, "K-6", "Blocked by a number", blocked_by=json.dumps([7, "K-2"]), status="todo")
ticket(P, "K-9", "Context only", status="backlog")
ticket(P, "K-10", "Another story", type="story", status="todo")
ticket(P, "K-11", "Child of another story", parent_id="K-10", status="todo")
ticket("p2", "X-1", "Other project", status="todo")

QUESTION_OPEN = json.dumps({"text": "Which database should the new table go in? " + "long " * 80, "options": [f"option {i} " + "x" * 90 for i in range(8)], "asked_at": ago(20)})
QUESTION_DONE = json.dumps({"text": "Ship it?", "options": ["yes", "no"], "asked_at": ago(130), "answered_at": ago(125), "answered_by": "Ann Lee"})
QUESTION_NOBODY = json.dumps({"text": "Anyone?", "asked_at": ago(70), "answered_at": ago(60)})

# r1: finished, a dev role woken twice and a tester
run(P, "r1", "m_alpha", "K-2", "finished", ago(180), started=ago(179), ended=ago(150), trigger="assign", steps_count=7, tokens_in=1200, tokens_out=800,
    tokens_cached=300, cost_usd=0.123456, metered=True, summary="Fixed add()", report=json.dumps({"summary": "report summary"}), model="haiku")
agent("r1", "a1", "dev", ago(178), ago(150), steps=4, text="done with the fix")
mark("r1", 20, ago(170), "a1", "stop", "dev")
mark("r1", 21, ago(165), "a1", "start", "dev")
mark("r1", 22, ago(160), "a1", "stop", "dev")
agent("r1", "a2", "code-reviewer", ago(175), ago(172), steps=1, text="looks fine")
agent("r1", "a3", "qa", ago(174), None, steps=0)
agent("r1", "a4", "", ago(173), ago(171), steps=0)
agent("r1", "a5", "tester_pro", ago(173, 30), ago(171, 30), steps=2, text="x" * 300)
for i, kind in enumerate(KINDS, 1):
    step("r1", i, ago(179 - i * 0.1), kind, f"{kind} step", detail={"path": f"f{i}.py", "added": i}, tool="Bash" if kind == "command" else None)
step("r1", 40, ago(176), "tool", "a subagent step", agent_id="a1", detail={"x": 1})
step("r1", 41, ago(176), "hook", "hook step", agent_id="a1")

# r2: failed, timed out; a run button
run(P, "r2", "m_alpha", "K-2", "failed", ago(300), started=ago(299), ended=ago(270), trigger="run_button", ended_reason="The run timed out after 30 minutes",
    stop_code="timeout", tokens_in=5, tokens_out=6)
# r3: memory stop; started by a message from a person
run(P, "r3", "m_alpha", "K-3", "failed", ago(260), started=ago(259), ended=ago(255), trigger="message", ended_reason="Out of memory", stop_code="memory",
    peak_rss_mb=2048.5, last_rss_mb=1900.25, restarts=json.dumps([{"at": ago(256), "reason": "memory"}]))
# r4: a note from team Alpha to Beta
run(P, "r4", "m_beta", "K-3", "finished", ago(240), started=ago(238), ended=ago(230), trigger="ai_message", by="Alpha")
# r5: a note from the board's agent (no team): no arrow
run(P, "r5", "m_beta", "K-3", "finished", ago(225), started=ago(224), ended=ago(222), trigger="ai_message", by="Board Agent")
# r6: rate limited; a retry
run(P, "r6", "m_alpha", "K-1", "failed", ago(215), started=ago(214), ended=ago(213), trigger="retry", stop_code="rate_limited", ended_reason="usage limit reached")
# r7/r8/r19: cancelled
run(P, "r7", "m_beta", "K-4", "cancelled", ago(205), started=ago(204), ended=ago(203), ended_reason="Pause all: the person paused the project", trigger="docs_threads")
run(P, "r8", "m_beta", "K-4", "cancelled", ago(200), ended=ago(199), ended_reason="Stopped by Ann Lee", trigger="assign")
run(P, "r19", "m_beta", "K-4", "cancelled", ago(198), started=ago(197), ended=ago(196), trigger="assign")
# r18: failed without a reason
run(P, "r18", "m_beta", "K-4", "failed", ago(195), started=ago(194), ended=ago(193), trigger="schedule")
# r9: waiting for the person: an open question
run(P, "r9", "m_alpha", "K-5", "needs_input", ago(40), started=ago(39), question=QUESTION_OPEN, trigger="assign", waiting_reason="question", context_used=1000, context_window=200000)
step("r9", 1, ago(38), "text", "I need to ask", detail={})
step("r9", 2, ago(37), "message", "A newer step is the one shown", detail={})
step("r9", 3, ago(36), "role", "role marker is never shown", agent_id=None, detail={"event": "stop"})
# r10: finished with an answered question
run(P, "r10", "m_beta", "K-5", "finished", ago(140), started=ago(139), ended=ago(100), question=QUESTION_DONE, trigger="docs_threads", report=json.dumps({"summary": "done and shipped"}))
# r20: answered by nobody in particular
run(P, "r20", "m_beta", "K-2", "finished", ago(75), started=ago(74), ended=ago(55), question=QUESTION_NOBODY, trigger="message", by="Bo Tran")
# r11: running with an open reviewer and a role called twice
run(P, "r11", "m_alpha", "K-2", "running", ago(30), started=ago(29), trigger="message", by="Beta", steps_count=12, model="sonnet",
    context_used=50000, context_window=200000, live=True)
agent("r11", "b1", "dev", ago(28), None, steps=3, text="working on it")
mark("r11", 30, ago(26), "b1", "stop", "dev")
mark("r11", 31, ago(24), "b1", "start", "dev")
agent("r11", "b2", "reviewer", ago(27), ago(25), steps=2, text="\n\n## **Review** done: [[Page|a link]] and `code`\n")
agent("r11", "b3", "reviewer", ago(22), None, steps=1)
step("r11", 1, ago(29), "command", "pytest", detail={"command": "pytest", "exit_code": 0}, output="o" * 12000)
step("r11", 2, ago(28), "tool", "a" * 200, detail={"input": "i" * 30000})
step("r11", 3, ago(21), "edit", "newest step of the lead", detail={"path": "a.py"})
step("r11", 4, ago(20), "hook", "a hook is not what it does", agent_id="b1")
step("r11", 5, ago(19), "tool", "newest step of the dev", agent_id="b1")
step("r11", 6, ago(18), "tool", "newest step of the open reviewer", agent_id="b3")
# r12: starting
run(P, "r12", "m_beta", "K-4", "starting", ago(5), trigger="assign")
# r13: queued
run(P, "r13", "m_alpha", "K-2", "queued", ago(3), trigger="run_button")
run(P, "r13b", "m_beta", "K-6", "queued", ago(2), trigger="assign")
# r14: a schedule's run (no ticket); r15: an assistant's run; r16: another project; r17: long ago
run(P, "r14", "m_alpha", None, "finished", ago(90), started=ago(89), ended=ago(85), trigger="schedule")
run(P, "r15", "m_alpha", "K-2", "finished", ago(90), started=ago(89), ended=ago(85), trigger="assign", kind="assistant", target="board")
run("p2", "r16", "m_zed", "X-1", "finished", ago(90), started=ago(89), ended=ago(85), trigger="assign")
run(P, "r17", "m_alpha", "K-2", "finished", ago(14400), started=ago(14399), ended=ago(14390), trigger="assign")
# yesterday's runs, for the day boundary of the activity view
run(P, "r21", "m_alpha", "K-2", "finished", ago(900), started=ago(899), ended=ago(880), trigger="assign", summary="yesterday")
agent("r21", "c1", "dev", ago(898), ago(881), steps=5, text="yesterday's work")
step("r21", 1, ago(897), "tool", "yesterday", agent_id="c1")
# a run of a team the project has no row for (its member is gone)
run(P, "r22", "m_gone", "K-2", "running", ago(10), started=ago(9), trigger="assign")
# a run that is still queued but whose queued time is after the end of a short window
run(P, "r23", "m_alpha", "K-1", "queued", ago(1), trigger="assign")

# notes to leads that already work
msg("r11", "n1", "Ann Lee", "please also check the docs", ago(27), delivered=ago(26, 30))
msg("r11", "n2", "Beta", "hand-off: the API is ready " + "z" * 200, ago(23))
msg("r11", "n3", "Ann Lee", "that started the run", ago(29, 59))
msg("r11", "n4", "Ann Lee", "an answer from the lead", ago(21), direction="out")
msg("r11", "n5", "", "no peer", ago(20, 30))
msg("r11", "n6", "Board Agent", "from an agent that is no team", ago(19))
msg("r9", "n7", "Beta", "psst", ago(35))
msg("r10", "n8", "Alpha", "old note", ago(120))
msg("r4", "n9", "Alpha", "the note that started r4", ago(240, 1))
msg("r4", "n10", "Alpha", "a later note", ago(235))
msg("r16", "n11", "Ann Lee", "other project", ago(80))

# --------------------------------------------------------------------------------------------------------------------
# p2: a paused project; names that are not unique
# --------------------------------------------------------------------------------------------------------------------
P2 = "p2"
person(P2, "m_zed_person", "Zed")
team(P2, "m_zed", "Zed", "#111111")
team(P2, "m_twin1", "Twin", "#222222")
team(P2, "m_twin2", "twin ", "#333333")
team(P2, "m_solo", " Solo ", "#444444")
ticket(P2, "Y-1", "Paused work", status="in-progress")
add(AiProjectSettings(project_id=P2, paused_all=True, paused_at=ago(50), paused_reason="Budget review"))
add(AiProjectSettings(project_id="p1", paused_all=False))
run(P2, "s1", "m_zed", "Y-1", "queued", ago(40), trigger="assign")
run(P2, "s2", "m_solo", "Y-1", "running", ago(30), started=ago(29), trigger="assign")
run(P2, "s3", "m_twin1", "Y-1", "finished", ago(60), started=ago(59), ended=ago(50), trigger="ai_message", by="Solo")
run(P2, "s4", "m_twin2", "Y-1", "finished", ago(58), started=ago(57), ended=ago(52), trigger="ai_message", by="Twin")
run(P2, "s5", "m_zed", "Y-1", "finished", ago(56), started=ago(55), ended=ago(53), trigger="ai_message", by="Zed")
run(P2, "s6", "m_solo", "Y-1", "queued", ago(45), trigger="ai_message", by="Zed")
agent("s2", "d1", "dev", ago(29), None, steps=1)
add(AiProjectSettings(project_id="p4", paused_all=True, paused_at="", paused_reason=None))

# --------------------------------------------------------------------------------------------------------------------
# p3: no teams at all; p4: a crowded project (450 runs, 20 minutes apart, one lead); p5: 260 runs 5 minutes apart
# --------------------------------------------------------------------------------------------------------------------
P4 = "p4"
team(P4, "m_big", "Big", "#555555")
ticket(P4, "B-1", "Big work")
for i in range(450):
    at = NOW - timedelta(minutes=20 * i + 7)
    run(P4, f"b{i:03d}", "m_big", "B-1", "finished", at.isoformat(), started=(at + timedelta(seconds=30)).isoformat(),
        ended=(at + timedelta(minutes=2)).isoformat(), trigger="assign" if i % 7 else "run_button", number=450 - i)
P5 = "p5"
team(P5, "m_busy", "Busy", "#666666")
ticket(P5, "C-1", "Busy work")
for i in range(260):
    at = NOW - timedelta(minutes=5 * i + 3)
    run(P5, f"c{i:03d}", "m_busy", "C-1", "finished", at.isoformat(), started=(at + timedelta(seconds=10)).isoformat(),
        ended=(at + timedelta(seconds=100)).isoformat(), trigger="assign", number=260 - i)


# --------------------------------------------------------------------------------------------------------------------
# the rows as JSON: only the columns that differ from a fresh row
# --------------------------------------------------------------------------------------------------------------------
DUMMY = {
    "Member": lambda: Member(project_id="x", name="x"),
    "AiTeam": lambda: AiTeam(id="x", project_id="x"),
    "Ticket": lambda: Ticket(id="x", project_id="x", title="x"),
    "AiRun": lambda: AiRun(id="x", project_id="x", member_id="x"),
    "AiRunAgent": lambda: AiRunAgent(id="x", run_id="x", agent_type="x"),
    "AiRunStep": lambda: AiRunStep(id=1, run_id="x", seq=1, kind="x"),
    "AiRunMessage": lambda: AiRunMessage(id="x", run_id="x"),
    "AiProjectSettings": lambda: AiProjectSettings(project_id="x"),
}
TABLE = {
    "Member": "member", "AiTeam": "ai_team", "Ticket": "ticket", "AiRun": "ai_run", "AiRunAgent": "ai_run_agent",
    "AiRunStep": "ai_run_step", "AiRunMessage": "ai_run_message", "AiProjectSettings": "ai_project_settings",
}


def rows_json():
    defaults = {TABLE[k]: json.loads(f().model_dump_json()) for k, f in DUMMY.items()}
    rows = []
    for kind, row in ROWS:
        d = json.loads(row.model_dump_json())
        base = defaults[TABLE[kind]]
        rows.append([TABLE[kind], {k: v for k, v in d.items() if k not in base or base[k] != v or k in ("id", "run_id", "project_id")}])
    return {"defaults": defaults, "rows": rows}


def iso(dt):
    return None if dt is None else dt.isoformat()


def dt(text):
    return datetime.fromisoformat(text)


async def main():
    await database.init_db()
    async with database.async_session() as session:
        for _kind, row in ROWS:
            session.add(row)
        await session.commit()
    recorded = rows_json()
    (HERE / "ai_views_rows.json").write_text(json.dumps(recorded, ensure_ascii=False, separators=(",", ":")) + "\n")

    # ---------------------------------------------------------------- timeline
    cases = []

    async def tl(name, project, **kw):
        async with database.async_session() as session:
            got = await timeline.timeline(session, project, **kw)
        args = {k: (iso(v) if isinstance(v, datetime) else v) for k, v in kw.items()}
        cases.append({"name": name, "project": project, "args": args, "out": got})

    await tl("default today", "p1")
    await tl("hour", "p1", range_key="hour")
    await tl("24h", "p1", range_key="24h")
    await tl("7d", "p1", range_key="7d")
    await tl("unknown range", "p1", range_key="decade")
    await tl("custom window", "p1", since=dt("2026-11-12T07:30:00+00:00"), until=dt("2026-11-12T08:30:00+00:00"))
    await tl("custom window with an offset", "p1", since=dt("2026-11-12T14:30:00+07:00"), until=dt("2026-11-12T15:30:00.5+07:00"))
    await tl("since only", "p1", since=dt("2026-11-12T09:00:00+00:00"))
    await tl("until before everything", "p1", since=dt("2026-11-01T00:00:00+00:00"), until=dt("2026-11-01T01:00:00+00:00"))
    await tl("window with the old run", "p1", range_key="7d", since=dt("2026-11-02T00:00:00+00:00"), until=dt("2026-11-12T10:00:00+00:00"))
    await tl("one ticket and its children", "p1", range_key="24h", ticket_id="K-1")
    await tl("one child", "p1", range_key="24h", ticket_id="K-2")
    await tl("an unknown ticket", "p1", range_key="24h", ticket_id="NOPE")
    await tl("one team", "p1", range_key="24h", team_id="m_alpha")
    await tl("a quiet team", "p1", range_key="24h", team_id="m_gamma")
    await tl("an unknown team", "p1", range_key="24h", team_id="m_nobody")
    await tl("ticket and team", "p1", range_key="24h", ticket_id="K-3", team_id="m_beta")
    await tl("empty ticket id", "p1", range_key="hour", ticket_id="", team_id="")
    await tl("paused project", "p2", range_key="24h")
    await tl("names that are not unique", "p2", range_key="hour")
    await tl("one team in a paused project", "p2", range_key="24h", team_id="m_solo")
    await tl("no teams", "p3", range_key="24h")
    await tl("crowded and truncated", "p4", range_key="7d")
    await tl("crowded", "p5", range_key="24h")
    await tl("custom window on the crowded one", "p4", since=dt("2026-11-11T10:00:00+00:00"), until=dt("2026-11-12T10:00:00+00:00"))
    # the filters read the stored queued_at as text; a project whose runs are all in the future of the window
    await tl("window ends before the runs", "p5", since=dt("2026-11-10T00:00:00+00:00"), until=dt("2026-11-10T00:30:00+00:00"))
    (HERE / "ai_timeline.json").write_text(json.dumps({"now": iso(NOW), "today": iso(TODAY), "calls": cases}, ensure_ascii=False, separators=(",", ":")) + "\n")

    # ---------------------------------------------------------------- flow
    fcases = []

    async def fm(name, project, **kw):
        async with database.async_session() as session:
            got = await flow.flow_map(session, project, **kw)
        args = {k: (iso(v) if isinstance(v, datetime) else v) for k, v in kw.items()}
        fcases.append({"name": name, "kind": "map", "project": project, "args": args, "out": got})

    async def fs(name, project):
        async with database.async_session() as session:
            got = await flow.flow_scopes(session, project)
        fcases.append({"name": name, "kind": "scopes", "project": project, "args": {}, "out": got})

    await fm("default today", "p1")
    await fm("24h", "p1", range_key="24h")
    await fm("7d", "p1", range_key="7d")
    await fm("hour", "p1", range_key="hour")
    await fm("all", "p1", range_key="all")
    await fm("custom window", "p1", since=dt("2026-11-12T07:30:00+00:00"), until=dt("2026-11-12T08:30:00+00:00"))
    await fm("all of one ticket", "p1", range_key="all", ticket_id="K-1")
    await fm("a story and its children", "p1", range_key="24h", ticket_id="K-10")
    await fm("a child", "p1", range_key="24h", ticket_id="K-3")
    await fm("an unknown ticket", "p1", range_key="all", ticket_id="NOPE")
    await fm("one team", "p1", range_key="24h", team_id="m_alpha")
    await fm("one team, all time", "p1", range_key="all", team_id="m_beta")
    await fm("one team and the notes it sent", "p1", range_key="hour", team_id="m_beta")
    await fm("a quiet team", "p1", range_key="24h", team_id="m_gamma")
    await fm("an unknown team", "p1", range_key="24h", team_id="m_nobody")
    await fm("team and ticket", "p1", range_key="all", ticket_id="K-3", team_id="m_alpha")
    await fm("unknown range", "p1", range_key="decade")
    await fm("paused project", "p2", range_key="24h")
    await fm("names that are not unique", "p2", range_key="all")
    await fm("one team of the paused project", "p2", range_key="all", team_id="m_solo")
    await fm("no teams", "p3", range_key="all")
    await fm("many runs", "p4", range_key="all")
    await fm("many runs in a week", "p4", range_key="7d")
    await fm("crowded", "p5", range_key="24h")
    await fs("scopes", "p1")
    await fs("scopes of a paused project", "p2")
    await fs("scopes with nothing", "p3")
    await fs("scopes of many runs", "p4")
    (HERE / "ai_flow.json").write_text(json.dumps({"now": iso(NOW), "today": iso(TODAY), "calls": fcases}, ensure_ascii=False, separators=(",", ":")) + "\n")

    # ---------------------------------------------------------------- activity
    acases = []

    async def ta(name, member, keys):
        async with database.async_session() as session:
            got = await activity.team_activity(session, member, keys)
        acases.append({"name": name, "kind": "team_activity", "args": {"member_id": member, "role_keys": keys}, "out": got})

    async def pa(name, teams):
        async with database.async_session() as session:
            got = await activity.project_activity(session, teams)
        acases.append({"name": name, "kind": "project_activity", "args": {"teams": teams}, "out": got})

    async def rc(name, project, **kw):
        async with database.async_session() as session:
            got = await activity.recent(session, project, **kw)
        acases.append({"name": name, "kind": "recent", "args": {"project_id": project, **kw}, "out": got})

    await ta("alpha with its roles", "m_alpha", ["dev", "reviewer", "tester"])
    await ta("alpha with no roles named", "m_alpha", [])
    await ta("alpha with a role it never called", "m_alpha", ["dev", "designer"])
    await ta("beta", "m_beta", ["dev", "reviewer"])
    await ta("gamma, who never ran", "m_gamma", ["dev"])
    await ta("nobody", "m_nobody", ["dev"])
    await ta("busy", "m_busy", [])
    await ta("zed", "m_zed", ["dev"])
    await ta("solo, running with an open role", "m_solo", ["dev"])
    await pa("two teams", [{"id": "m_alpha", "roles": [{"key": "dev"}, {"key": "reviewer"}]}, {"id": "m_beta"}, {"id": "m_gamma", "roles": None}])
    await pa("none", [])
    await rc("recent of p1", "p1")
    await rc("recent of p1, 3", "p1", limit=3)
    await rc("recent of one team", "p1", team_id="m_beta")
    await rc("recent of one team, 1", "p1", team_id="m_alpha", limit=1)
    await rc("recent of p2", "p2", limit=50)
    await rc("recent of p3", "p3")
    await rc("recent of p4", "p4", limit=8)
    LINES = [
        None, "", "\n\n", "plain", "  spaced  ", "# Heading", "## **bold** title", "> quote", "- item", "* star", "• bullet", "#>*-• mixed",
        "first\nsecond", "\n\n  \n# real line\nnext", "`code` and **bold**", "[[Page]] link", "[[a|b]] piped", "[[x]] and [[y|z]]", "[[unclosed",
        "[[]]", "x" * 200, "x" * 201, "y" * 300, "é" * 250, "ab " * 100, "tail   " + "z" * 195 + "   end", "-" * 10, "# " + "w" * 250,
        "• unicode bullet", "line\r\nwindows", "line\rmac", "line\x0bvt", " sep second", "**", "``", "[[a|b]][[c]]",
        "\t# tabbed", "  > #  deep", "a" * 199 + " b", "a" * 198 + "  b",
    ]
    fl = [[t, activity.first_line(t)] for t in LINES] + [[t, 160, activity.first_line(t, 160)] for t in LINES[:30]] + [[t, 5, activity.first_line(t, 5)] for t in LINES[:30]]
    (HERE / "ai_activity.json").write_text(json.dumps({"now": iso(NOW), "day": activity._day_start(), "calls": acases, "first_line": fl}, ensure_ascii=False, separators=(",", ":")) + "\n")

    # the other pure helpers of the timeline
    pure = {
        "role_label": [[t, timeline.role_label(t)] for t in ["tester", "code-reviewer", "snake_case_role", "", None, "x", "  spaced  ", "ünï", "a-b_c d", "--", "É"]],
        "role_color": [[t, timeline._role_color(t)] for t in ["dev", "Dev", " QA ", "reviewer", "tester", "", None, "code-reviewer", "x", "ünï", "agent", "designer", "a" * 50]],
        "window": [],
    }
    for key in ("hour", "today", "24h", "7d", "x"):
        a, b = timeline.window(key, NOW)
        pure["window"].append([key, None, None, iso(a), iso(b)])
    a, b = timeline.window("hour", NOW, dt("2026-01-01T00:00:00+07:00"))
    pure["window"].append(["hour", "2026-01-01T00:00:00+07:00", None, iso(a), iso(b)])
    a, b = timeline.window("hour", NOW, dt("2026-01-01T00:00:00+07:00"), dt("2026-01-02T00:00:00+00:00"))
    pure["window"].append(["hour", "2026-01-01T00:00:00+07:00", "2026-01-02T00:00:00+00:00", iso(a), iso(b)])
    arrows = []
    for i in range(14):
        arrows.append(timeline._arrow(f"a{i}", ago(100 - (i % 5) * 0.5 - (i // 5) * 10), "report" if i % 3 else "ask", "x", "y" if i % 2 else "z", f"K-{i}", f"r{i}"))
    arrows.append(timeline._arrow("e1", None, "assign", "you", "x", None, None))
    arrows.append(timeline._arrow("e2", "garbage", "assign", "you", "x", None, None))
    arrows.append(timeline._arrow("e3", ago(5), "assign", "you", "x", "", "r", to_at="", wait_s=0, label="", by=""))
    pure["group"] = {"arrows": arrows, "grouped_90": timeline._group(arrows), "grouped_600": timeline._group(arrows, 600), "grouped_1": timeline._group(arrows, 1)}
    (HERE / "ai_timeline_pure.json").write_text(json.dumps(pure, ensure_ascii=False, indent=1) + "\n")

    for name in ("ai_views_rows", "ai_timeline", "ai_flow", "ai_activity", "ai_timeline_pure"):
        p = HERE / f"{name}.json"
        print(f"wrote {p.name} ({p.stat().st_size} bytes)")


asyncio.run(main())
