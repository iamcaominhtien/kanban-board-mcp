"""Health (design/screens/ai-team-review.md, B and E; AI v2): is the AI team healthy, per team.

One page, computed on the server from what the board keeps; nothing is stored. Five measures, for the project and for
each team (cost exists per run only, so there is no row per role):

- **reliability**: runs that finished OK of the runs that ended (failed, timed out and cancelled count against). Runs the
  team did not cause (the board closed, the ticket was deleted or reassigned) are left out. 85% or more good, 70 to 85%
  watch, below 70% fix (the design's term table).
- **autonomy**: touches per ticket, from the tab You stepped in. The design measured the share of completed tickets with
  no touch; v2 asks for touches per ticket, which is not the same number, so its thresholds are ours: under 1 good, 1 to
  2 watch, over 2 fix. The share of tickets with no touch at all is shown beside it.
- **speed**: median run duration and median time from the assignment to Review. The design gives it no thresholds, so it
  has no verdict.
- **quality**: how often work the AI finished is sent back: tickets a run finished that a person reopened afterwards (from the ticket's reopen history).
  Under 10% good, 10 to 20% watch, over 20% fix (the design's "sent back" terms). A Reviewer's findings are counted
  where a run's report lists them (`findings`, one line each) and shown only when a run reported some.
- **cost**: money and tokens against the team's caps: this range's spend, the average per run, runs over the cap of one
  run and the last 30 days against the monthly cap. Under 70% of the cap good, 70 to 90% watch, over 90% fix; a team with
  no monthly cap has no verdict. Runs that report no price show tokens, never $0.

Under `MIN_RUNS` runs there is no verdict (the numbers show). "What to fix" has at most five items, each with its
evidence and an action that opens the exact setting, run, team, ticket or tab.
"""

import statistics
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiProjectSettings, AiRun, AiTeam, Member, Ticket

from . import touches
from .store import loads, parse_iso

RANGES = {"7d": 7, "30d": 30}
MIN_RUNS = 10  # under this many runs the numbers show and the verdict waits
MAX_FIXES = 5
ENDED = ("finished", "failed", "cancelled", "timed_out")
# runs that ended for a reason that is not the team's doing
NOT_THE_TEAM = ("board_closed", "deleted", "reassigned")

# a rule shows only with this many cases (the design: "shown only with 3 or more cases"; a memory stop is clear at 2)
MIN_CASES = 3
MIN_CASES_MEMORY = 2


def verdict_of(
    value: float | None, good: float, watch: float, *, higher_is_better: bool
) -> str | None:
    """good / watch / fix for a value against the two limits (None when there is no value)."""
    if value is None:
        return None
    if higher_is_better:
        return "good" if value >= good else "watch" if value >= watch else "fix"
    return "good" if value < good else "watch" if value <= watch else "fix"


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def _secs(a: str | None, b: str | None) -> float | None:
    x, y = parse_iso(a), parse_iso(b)
    return (y - x).total_seconds() if x and y and y >= x else None


def _priced(r: AiRun) -> bool:
    return bool(r.metered or (r.cost_usd or 0) > 0)


def _ticket_times(t: Ticket | None) -> tuple[list[tuple[str, str]], list[str]]:
    """The ticket's assignments (to, at) and the times it moved into Review, from its activity log."""
    assigned: list[tuple[str, str]] = []
    review: list[str] = []
    for e in loads(t.activity_log if t else "[]", []):
        if not isinstance(e, dict):
            continue
        if e.get("field") == "assignee" and e.get("to") and e.get("at"):
            assigned.append((e["to"], e["at"]))
        elif e.get("field") == "status" and e.get("to") == "review" and e.get("at"):
            review.append(e["at"])
    return assigned, review


def _reopens_after(
    t: Ticket | None, after: str | None, until: str | None = None
) -> int:
    """How many times the ticket was reopened after this time (and before `until`), from its reopen history."""
    if t is None or not after:
        return 0
    return sum(
        1
        for e in loads(t.reopen_history, [])
        if isinstance(e, dict)
        and e.get("at")
        and e["at"] >= after
        and (until is None or e["at"] < until)
    )


def _first_finish(runs: list[AiRun]) -> dict[str, str]:
    """For each ticket, when the first run of these that finished OK on it ended."""
    out: dict[str, str] = {}
    for r in runs:
        if r.ticket_id and r.state == "finished" and r.ended_at:
            if r.ticket_id not in out or r.ended_at < out[r.ticket_id]:
                out[r.ticket_id] = r.ended_at
    return out


def measures(
    runs: list[AiRun],
    tks: list[dict],
    tickets: dict[str, Ticket],
    *,
    team: AiTeam | None,
    month_spend: float,
    judged: bool,
    until: str | None = None,
) -> dict:
    """The five measures of a set of runs (one team's, or the project's) and of the touches that belong to it."""
    ended = [r for r in runs if r.state in ENDED and r.stop_code not in NOT_THE_TEAM]
    ok = [r for r in ended if r.state == "finished"]
    rel = len(ok) / len(ended) if ended else None

    ticket_ids = {r.ticket_id for r in runs if r.ticket_id}
    touched = {t["ticket_id"] for t in tks if t["ticket_id"]}
    on_tickets = sum(1 for t in tks if t["ticket_id"] in ticket_ids)
    raw_per_ticket = on_tickets / len(ticket_ids) if ticket_ids else None
    per_ticket = None if raw_per_ticket is None else round(raw_per_ticket, 1)
    clean = len(ticket_ids - touched)

    durations = [
        d
        for r in runs
        if r.state in ENDED and (d := _secs(r.started_at, r.ended_at)) is not None
    ]
    to_review: list[float] = []
    queued_by_ticket: dict[str, list[str]] = defaultdict(list)
    for r in runs:
        if r.ticket_id:
            queued_by_ticket[r.ticket_id].append(r.queued_at)
    for tid in ticket_ids:
        mine = sorted(queued_by_ticket[tid])
        assigned, review = _ticket_times(tickets.get(tid))
        start = mine[0] if mine else None
        if team is not None:
            before = [
                at
                for to, at in assigned
                if to == team.id and (start is None or at <= start)
            ]
            start = max(before) if before else start
        after = [at for at in review if start and at >= start]
        if start and after and (d := _secs(start, min(after))) is not None:
            to_review.append(d)

    # work the AI finished that a person then reopened (reopens after the first finish, not the ticket's whole life)
    first_finish = _first_finish(ok)
    done_tickets = set(first_finish)
    reopened = [
        tid
        for tid, at in first_finish.items()
        if _reopens_after(tickets.get(tid), at, until) > 0
    ]
    quality = len(reopened) / len(done_tickets) if done_tickets else None
    # a Reviewer's findings, where the lead's final report lists them
    findings = [
        len(f)
        for r in runs
        if isinstance(f := loads(r.report, {}).get("findings"), list) and f
    ]

    priced = [r for r in runs if _priced(r)]
    spend = round(sum(r.cost_usd or 0 for r in runs), 2)
    tokens = sum((r.tokens_in or 0) + (r.tokens_out or 0) for r in runs)
    cap_run = team.cap_per_run if team else None
    over = [r for r in priced if cap_run and (r.cost_usd or 0) > cap_run]
    monthly = team.monthly_cap if team else None
    share = round(month_spend / monthly, 3) if monthly else None
    cost_verdict = verdict_of(share, 0.7, 0.9, higher_is_better=False)
    if over and cost_verdict in (None, "good"):
        cost_verdict = "watch"

    def v(value, good, watch, hib):
        return verdict_of(value, good, watch, higher_is_better=hib) if judged else None

    return {
        "reliability": {
            "value": None if rel is None else round(rel, 3),
            "verdict": v(rel, 0.85, 0.7, True),
            "ok": len(ok),
            "ended": len(ended),
            "failed": sum(r.state == "failed" for r in ended),
            "timed_out": sum(r.state == "timed_out" for r in ended),
            "cancelled": sum(r.state == "cancelled" for r in ended),
        },
        "autonomy": {
            "value": per_ticket,
            "verdict": v(raw_per_ticket, 1, 2, False),
            "touches": on_tickets,
            "touches_all": len(tks),
            "tickets": len(ticket_ids),
            "clean": clean,
            "avoidable": sum(t["mark"] == "avoidable" for t in tks),
        },
        "speed": {
            "run_median_s": _median(durations),
            "to_review_median_s": _median(to_review),
            "to_review_tickets": len(to_review),
            "verdict": None,
        },
        "quality": {
            "value": None if quality is None else round(quality, 3),
            "verdict": v(quality, 0.1, 0.2, False),
            "reopened": len(reopened),
            "finished_tickets": len(done_tickets),
            "findings": sum(findings) if findings else None,
            "runs_with_findings": len(findings),
        },
        "cost": {
            "usd": spend,
            "tokens": tokens,
            "runs": len(runs),
            "priced_runs": len(priced),
            "tokens_only_runs": len(runs) - len(priced),
            "per_run": round(spend / len(priced), 2) if priced else None,
            "tokens_per_run": round(tokens / len(runs)) if runs else None,
            "cap_per_run": cap_run,
            "runs_over_cap": len(over),
            "monthly_cap": monthly,
            "month_spend": round(month_spend, 2),
            "month_share": share,
            "verdict": cost_verdict if judged else None,
        },
    }


def _state_of(m: dict) -> str:
    vs = [
        m[k]["verdict"]
        for k in ("reliability", "autonomy", "quality", "cost")
        if m[k]["verdict"]
    ]
    return "fix" if "fix" in vs else "watch" if "watch" in vs else "good"


async def _fixes(
    session: AsyncSession,
    project_id: str,
    runs: list[AiRun],
    tks: list[dict],
    teams: dict[str, Member],
    profiles: dict[str, AiTeam],
    rows: dict[str, dict],
    tickets: dict[str, Ticket],
    memory_limit: int,
    since_iso: str,
) -> list[dict]:
    """What to fix, worked out from rules, worst first, at most five."""
    out: list[dict] = []
    name = lambda tid: teams[tid].name if tid in teams else "A team"  # noqa: E731

    # a ticket whose runs keep failing, and the reason
    failing: dict[tuple[str, str], list[AiRun]] = defaultdict(list)
    for r in runs:
        if (
            r.ticket_id
            and r.state in ("failed", "timed_out")
            and r.stop_code not in NOT_THE_TEAM
        ):
            failing[(r.ticket_id, r.member_id)].append(r)
    for (tid, team_id), rs in failing.items():
        rs.sort(key=lambda r: r.queued_at)
        memory = [r for r in rs if r.stop_code == "memory"]
        last = rs[-1]
        if len(memory) >= MIN_CASES_MEMORY:
            peak = max((r.peak_rss_mb or 0 for r in memory), default=0)
            out.append(
                {
                    "id": f"memory:{tid}:{team_id}",
                    "severity": "fix",
                    "weight": len(memory),
                    "title": f"{tid} failed {len(memory)} times, stopped for memory",
                    "evidence": f"{len(memory)} runs of {name(team_id)} on {tid} ended because Claude Code went over "
                    f"{memory_limit} MB"
                    + (f" (peak {round(peak)} MB)" if peak else "")
                    + ".",
                    "suggestion": f"Raise Memory of one run (now {memory_limit} MB), or split the ticket so one run needs less.",
                    "tickets": [tid],
                    "team_id": team_id,
                    "run_id": last.id,
                    "action": {
                        "type": "setting",
                        "label": "Open Memory of one run",
                        "page": "ai",
                        "setting": "ai-limits",
                    },
                }
            )
        elif len(rs) >= MIN_CASES:
            reasons = Counter((r.ended_reason or r.state) for r in rs).most_common(1)[
                0
            ][0]
            out.append(
                {
                    "id": f"failing:{tid}:{team_id}",
                    "severity": "fix",
                    "weight": len(rs),
                    "title": f"{tid} failed {len(rs)} times",
                    "evidence": f"{len(rs)} runs of {name(team_id)} on {tid} failed or timed out. Most often: “{_reason(reasons)}”.",
                    "suggestion": "Read the last run: the ticket may be too big, or missing something the team needs.",
                    "tickets": [tid],
                    "team_id": team_id,
                    "run_id": last.id,
                    "action": {
                        "type": "run",
                        "label": "Open the last run",
                        "run_id": last.id,
                    },
                }
            )

    # a team that fails often
    for team_id, row in rows.items():
        rel = row["measures"]["reliability"]
        if rel["ended"] >= 5 and rel["value"] is not None and rel["value"] < 0.7:
            bad = rel["ended"] - rel["ok"]
            out.append(
                {
                    "id": f"reliability:{team_id}",
                    "severity": "fix",
                    "weight": bad,
                    "title": f"{name(team_id)} finishes only {round(rel['value'] * 100)}% of its runs",
                    "evidence": f"{rel['ok']} of {rel['ended']} runs finished OK. Failed: {rel['failed']}, "
                    f"timed out: {rel['timed_out']}, cancelled: {rel['cancelled']}.",
                    "suggestion": "Look at the failed runs together: the same cause often repeats. Check the team's model, "
                    "working folder and caps.",
                    "tickets": [],
                    "team_id": team_id,
                    "run_id": None,
                    "action": {
                        "type": "team",
                        "label": "Open the team",
                        "team_id": team_id,
                    },
                }
            )

    # the same question again and again (every answered question of the range counts, also a run's earlier ones)
    asked: dict[str, list[tuple[AiRun, dict]]] = defaultdict(list)
    for r in runs:
        for a in touches.answers_of(r):
            text = " ".join(str(a["text"] or "").lower().split())
            if text and a["at"] and a["at"] >= since_iso:
                asked[text].append((r, a))
    for pairs in asked.values():
        if len(pairs) >= MIN_CASES:
            pairs.sort(key=lambda p: p[1]["at"])
            q = pairs[0][1]["text"]
            team_id = Counter(r.member_id for r, _ in pairs).most_common(1)[0][0]
            answers = Counter(
                " ".join((a["answer"] or "").split())[:80] for _, a in pairs
            ).most_common(1)[0]
            out.append(
                {
                    "id": f"asked:{pairs[0][0].id}:{pairs[0][1]['index']}",
                    "severity": "watch",
                    "weight": len(pairs),
                    "title": f"{name(team_id)} asks the same question again and again",
                    "evidence": f"Asked “{q[:120]}” {len(pairs)} times; the answer was “{answers[0]}” {answers[1]} "
                    f"time{'s' if answers[1] != 1 else ''}.",
                    "suggestion": "Write the answer down once as a lesson, so the team stops asking.",
                    "tickets": sorted({r.ticket_id for r, _ in pairs if r.ticket_id})[
                        :4
                    ],
                    "team_id": team_id,
                    "run_id": pairs[-1][0].id,
                    "action": {
                        "type": "tab",
                        "label": "Add a lesson in Memory",
                        "tab": "memory",
                    },
                }
            )

    # touches marked avoidable
    avoidable = [t for t in tks if t["mark"] == "avoidable"]
    if len(avoidable) >= MIN_CASES:
        top = Counter(t["kind"] for t in avoidable).most_common(1)[0]
        out.append(
            {
                "id": "avoidable",
                "severity": "watch",
                "weight": len(avoidable),
                "title": f"{len(avoidable)} touches were avoidable",
                "evidence": f"You marked {len(avoidable)} of {len(tks)} touches Avoidable; the most common: "
                f"{touches.KINDS[top[0]].lower()} ({top[1]}).",
                "suggestion": "Open them one by one and make a lesson, a rule or a setting out of each.",
                "tickets": sorted(
                    {t["ticket_id"] for t in avoidable if t["ticket_id"]}
                )[:4],
                "team_id": None,
                "run_id": None,
                "action": {
                    "type": "tab",
                    "label": "Open the avoidable touches",
                    "tab": "stepped",
                    "mark": "avoidable",
                },
            }
        )

    # work the AI finished that came back (reopened after the first finish, at least twice)
    for tid, at in sorted(_first_finish(runs).items()):
        t = tickets.get(tid)
        n = _reopens_after(t, at)
        if t is not None and n >= 2:
            out.append(
                {
                    "id": f"reopened:{tid}",
                    "severity": "watch",
                    "weight": n,
                    "title": f"{tid} was reopened {n} times after the AI finished it",
                    "evidence": f"A run finished {tid} and a person reopened it {n} times since: “{t.title[:100]}”.",
                    "suggestion": "Rewrite the acceptance criteria so the team and the reviewer read them the same way.",
                    "tickets": [tid],
                    "team_id": None,
                    "run_id": None,
                    "action": {
                        "type": "ticket",
                        "label": "Open the ticket",
                        "ticket_id": tid,
                    },
                }
            )

    # cost against the caps
    for team_id, row in rows.items():
        c = row["measures"]["cost"]
        if c["runs_over_cap"] >= 2 or (
            c["month_share"] is not None and c["month_share"] > 0.9
        ):
            why = (
                f"{c['runs_over_cap']} runs cost more than the ${c['cap_per_run']:.2f} cap of one run."
                if c["runs_over_cap"] >= 2
                else f"The last 30 days cost ${c['month_spend']:.2f}, {round((c['month_share'] or 0) * 100)}% of the "
                f"${c['monthly_cap']:.2f} monthly cap."
            )
            out.append(
                {
                    "id": f"cost:{team_id}",
                    "severity": "fix" if (c["month_share"] or 0) > 0.9 else "watch",
                    "weight": c["runs_over_cap"] or 1,
                    "title": f"{name(team_id)} is near or over its caps",
                    "evidence": why,
                    "suggestion": "Raise the cap if the spend is worth it, or look at why one run costs so much.",
                    "tickets": [],
                    "team_id": team_id,
                    "run_id": None,
                    "action": {
                        "type": "team",
                        "label": "Open the team's caps",
                        "team_id": team_id,
                    },
                }
            )

    out.sort(key=lambda f: (f["severity"] != "fix", -f["weight"], f["id"]))
    for f in out:
        f.pop("weight", None)
    return out[:MAX_FIXES]


def _sentence(
    m: dict,
    prev: dict | None,
    fixes: list[dict],
    bad_teams: list[str],
) -> str:
    """The verdict in plain words."""
    rel = m["reliability"]["verdict"]
    reliable = {
        "good": "reliable",
        "watch": "mostly reliable",
        "fix": "not reliable yet",
    }.get(rel or "", "running")
    speed, was = (
        m["speed"]["run_median_s"],
        (prev or {}).get("speed", {}).get("run_median_s"),
    )
    faster = ""
    if speed is not None and was is not None and abs(speed - was) > 60:
        faster = " and getting faster" if speed < was else " and getting slower"
    parts = [f"The AI teams are {reliable}{faster}"]
    if m["autonomy"]["verdict"] in ("watch", "fix"):
        av = m["autonomy"]["avoidable"]
        parts.append(
            f"but people still step in too often ({m['autonomy']['value']} touches per ticket"
            + (f", {av} marked avoidable" if av else "")
            + ")"
        )
    text = ", ".join(parts) + "."
    if bad_teams:
        text += f" {', '.join(bad_teams[:2])} {'needs' if len(bad_teams) == 1 else 'need'} fixing first."
    if fixes:
        text += f" {len(fixes)} thing{'s' if len(fixes) != 1 else ''} to fix below."
    return text


def _reason(text: str, limit: int = 140) -> str:
    """A run's end reason for a sentence: no closing full stop of its own, cut with an ellipsis, not mid-word."""
    t = " ".join((text or "").split()).rstrip(".")
    return (
        t if len(t) <= limit else t[: limit - 1].rsplit(" ", 1)[0].rstrip(",;: ") + "…"
    )


async def health(session: AsyncSession, project_id: str, range_key: str = "7d") -> dict:
    """The Health page: a verdict, five measures with the change since the range before, a row per team, what to fix."""
    key = range_key if range_key in RANGES else "7d"
    span = timedelta(days=RANGES[key])
    until = datetime.now(UTC)
    since = until - span
    prev_since = since - span
    iso, prev_iso = since.isoformat(), prev_since.isoformat()

    members = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id,
                col(Member.kind).in_(["ai", "ai_removed"]),
            )
        )
    ).all()
    teams = {m.id: m for m in members}
    profiles = {
        p.id: p
        for p in (
            await session.exec(select(AiTeam).where(AiTeam.project_id == project_id))
        ).all()
    }
    all_runs = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                AiRun.kind == "team",
                AiRun.queued_at
                >= (min(prev_since, until - timedelta(days=30))).isoformat(),
            )
        )
    ).all()
    runs = [r for r in all_runs if r.queued_at >= iso]
    prev_runs = [r for r in all_runs if prev_iso <= r.queued_at < iso]
    month_iso = (until - timedelta(days=30)).isoformat()
    ticket_ids = {r.ticket_id for r in all_runs if r.ticket_id}
    tickets = (
        {
            t.id: t
            for t in (
                await session.exec(select(Ticket).where(col(Ticket.id).in_(ticket_ids)))
            ).all()
        }
        if ticket_ids
        else {}
    )
    settings = await session.get(AiProjectSettings, project_id)
    memory_limit = settings.run_memory_limit_mb if settings else 4096

    all_touches = await touches.collect(session, project_id, prev_since)
    tks = [t for t in all_touches if t["at"] and t["at"] >= iso]
    prev_tks = [t for t in all_touches if t["at"] and t["at"] < iso]

    def month_spend(team_id: str | None) -> float:
        return sum(
            r.cost_usd or 0
            for r in all_runs
            if r.queued_at >= month_iso and (team_id is None or r.member_id == team_id)
        )

    rows: dict[str, dict] = {}
    for team_id, m in teams.items():
        mine = [r for r in runs if r.member_id == team_id]
        if m.kind == "ai_removed" and not mine:
            continue
        mt = [t for t in tks if team_id in t["team_ids"]]
        judged = len(mine) >= MIN_RUNS
        ms = measures(
            mine,
            mt,
            tickets,
            team=profiles.get(team_id),
            month_spend=month_spend(team_id),
            judged=judged,
        )
        status = (
            "idle"
            if not mine
            else "too_few"
            if not judged
            else {"good": "healthy"}.get(_state_of(ms), _state_of(ms))
        )
        rows[team_id] = {
            "id": team_id,
            "name": m.name,
            "removed": m.kind == "ai_removed",
            "runs": len(mine),
            "judged": judged,
            "status": status,
            "paused": bool(profiles.get(team_id) and profiles[team_id].paused),
            "measures": ms,
        }

    judged = len(runs) >= MIN_RUNS
    total = measures(
        runs, tks, tickets, team=None, month_spend=month_spend(None), judged=judged
    )
    # the project's cost verdict follows its teams' caps: the worst of them
    team_costs = [
        r["measures"]["cost"]["verdict"]
        for r in rows.values()
        if r["measures"]["cost"]["verdict"]
    ]
    total["cost"]["verdict"] = (
        "fix"
        if "fix" in team_costs
        else "watch"
        if "watch" in team_costs
        else "good"
        if team_costs
        else None
    )
    prev_total = measures(
        prev_runs,
        prev_tks,
        tickets,
        team=None,
        month_spend=0,
        judged=False,
        until=iso,
    )
    fixes = (
        await _fixes(
            session,
            project_id,
            runs,
            tks,
            teams,
            profiles,
            rows,
            tickets,
            memory_limit,
            iso,
        )
        if runs or tks
        else []
    )

    vs = [
        total[k]["verdict"]
        for k in ("reliability", "autonomy", "quality", "cost")
        if total[k]["verdict"]
    ]
    counts = {n: vs.count(n) for n in ("good", "watch", "fix")}
    state = (
        "unknown"
        if not judged
        else "fix"
        if counts["fix"]
        else "watch"
        if counts["watch"]
        else "good"
    )
    if state != "unknown" and any(f["severity"] == "fix" for f in fixes):
        state = "fix"
    bad = [r["name"] for r in rows.values() if r["status"] == "fix"]
    title = {
        "good": "Healthy",
        "watch": "Needs attention",
        "fix": "Needs fixing",
        "unknown": "Not enough to judge yet",
    }[state]
    if not runs:
        text = "No AI work in this range, so there is nothing to judge yet."
    elif not judged:
        text = f"Only {len(runs)} run{'s' if len(runs) != 1 else ''} in this range. The numbers show; the verdict waits for {MIN_RUNS} runs."
    else:
        text = _sentence(total, prev_total, fixes, bad)
    return {
        "range": key,
        "since": iso,
        "until": until.isoformat(),
        "runs": len(runs),
        "tickets": len({r.ticket_id for r in runs if r.ticket_id}),
        "min_runs": MIN_RUNS,
        "can_judge": judged,
        "has_teams": any(m.kind == "ai" for m in members),
        "state": state,
        "title": title,
        "text": text,
        "counts": counts,
        "measures": total,
        "previous": {
            "reliability": prev_total["reliability"]["value"],
            "autonomy": prev_total["autonomy"]["value"],
            "quality": prev_total["quality"]["value"],
            "run_median_s": prev_total["speed"]["run_median_s"],
            "usd": prev_total["cost"]["usd"],
            "priced_runs": prev_total["cost"]["priced_runs"],
            "tokens": prev_total["cost"]["tokens"],
            "runs": len(prev_runs),
        },
        "teams": sorted(rows.values(), key=lambda r: (-r["runs"], r["name"])),
        "fixes": fixes,
    }
