"""AI Team, Health: is the AI feature working? (design/screens/ai-team-review.md, B and E)

Five measures (reliability, autonomy, speed, quality, cost), a row per AI and a short list of what to fix, each with the
evidence behind it. Every number is worked out on the server from records the app keeps, for a range and the same-length
range before it, so the same range always gives the same numbers. Nothing is changed for the person.
"""

import json
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    AiApproval,
    AiAudit,
    AiMember,
    AiProjectSettings,
    AiRun,
    DocsAiProposal,
    DocsCommentThread,
    DocsLink,
    DocsPage,
    DocsVersion,
    Member,
    Project,
    Ticket,
)

from . import flow
from .members import MAX_PERSONA
from . import permissions as perms
from . import touches as svc_touches
from .store import get_settings, loads, now_iso, parse_iso
from .team import RANGES, window_start

ENDED = ("finished", "failed", "timed_out", "cancelled")
MIN_RUNS = 10  # under this there is no verdict
TOO_FEW = 20  # under this a change is "too few to be sure"
MIN_CASES = 3  # a pattern needs this many cases to be suggested
QUEUE_WAIT_S = 30 * 60
SLICES = 7

# (good at or beyond, watch at or beyond): "higher" measures are good when high, "lower" when low
THRESHOLDS = {
    "reliability": ("higher", 0.85, 0.70),
    "autonomy": ("higher", 0.70, 0.50),
    "waiting": ("lower", 0.15, 0.30),
    "quality": ("lower", 0.10, 0.20),
    "cost": ("lower", 0.70, 0.90),
}


def verdict(name: str, value: float | None) -> str | None:
    """good | watch | fix for a measure value, or None when there is nothing to judge."""
    if value is None:
        return None
    way, good, watch = THRESHOLDS[name]
    if way == "higher":
        return "good" if value >= good else "watch" if value >= watch else "fix"
    return "good" if value < good else "watch" if value <= watch else "fix"


@dataclass
class Data:
    """Everything the measures read, loaded once for the two ranges."""

    project_id: str
    ais: dict[str, Member]
    templates: dict[str, str]
    personas: dict[str, str]
    project_name: str
    runs: list[AiRun]
    tickets: dict[str, Ticket]
    touches: list[dict]
    approvals: list[AiApproval]
    blocked: list[AiAudit]
    threads: list[DocsCommentThread]
    pages: dict[str, DocsPage]
    versions: list[DocsVersion] = field(default_factory=list)
    links: list[DocsLink] = field(default_factory=list)
    proposals: list[DocsAiProposal] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    cap: float | None = None


def _in(value: str | None, a: datetime, b: datetime) -> bool:
    at = parse_iso(value)
    return at is not None and a <= at < b


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def _waiting_s(tid: str, runs: list[AiRun], approvals: list[AiApproval]) -> float:
    """Time the ticket's runs waited for a person: a question open, or an approval pending."""
    total = 0.0
    for r in runs:
        q = loads(r.question, None) or {}
        asked = parse_iso(q.get("asked_at"))
        answered = parse_iso(q.get("answered_at")) or parse_iso(r.ended_at)
        if asked and answered and answered > asked:
            total += (answered - asked).total_seconds()
    for a in approvals:
        if a.ticket_id == tid and a.decided_at:
            s = flow._secs(a.requested_at, a.decided_at)
            total += max(s or 0, 0)
    return total


@dataclass
class Done:
    """A ticket that counts as completed: its last work run finished and the deliverable exists, or a person accepted
    it."""

    ticket_id: str
    last: AiRun
    elapsed_s: float
    waiting_s: float
    deliverable: dict
    at: str  # when it counted as completed


def deliverable_of(d: Data, tid: str, rows: list[AiRun]) -> dict:
    """What the AIs delivered on a ticket: a branch with the work, a published Docs page, or files changed.

    Returns {kind: branch | docs | files | None, label, branch, page_ids}."""
    t = d.tickets.get(tid)
    last = rows[-1]
    first_at = parse_iso(rows[0].queued_at)
    end_at = parse_iso(last.ended_at) or datetime.now(UTC)
    branches = [b for b in loads(t.branches, []) if isinstance(b, dict)] if t else []
    live = [
        b
        for b in branches
        if b.get("status") not in ("abandoned", "deleted", "removed")
    ]
    # only pages written by the AIs that worked on this ticket count as its deliverable
    names = {d.ais[r.member_id].name for r in rows if r.member_id in d.ais}
    pages: list[str] = []
    for v in d.versions:
        if (
            v.author in names
            and first_at
            and (at := parse_iso(v.created_at))
            and first_at <= at <= end_at + timedelta(minutes=10)
        ):
            if v.page_id not in pages:
                pages.append(v.page_id)
    for ln in d.links:
        if ln.target_ticket_id == tid and ln.source_page_id not in pages:
            page = d.pages.get(ln.source_page_id)
            if page is not None and page.version >= 1:
                pages.append(ln.source_page_id)
    pages = [
        p
        for p in pages
        if d.pages.get(p) is not None
        and d.pages[p].version >= 1
        and not d.pages[p].deleted_at
    ]
    files = loads(last.files, [])
    if live:
        name = live[-1].get("name") or "branch"
        return {
            "kind": "branch",
            "label": f"branch {name}",
            "branch": name,
            "page_ids": pages,
            "files": len(files),
        }
    if pages:
        titles = ", ".join(d.pages[p].title for p in pages[:2])
        return {
            "kind": "docs",
            "label": f"Docs: {titles}",
            "branch": None,
            "page_ids": pages,
            "files": len(files),
        }
    if files:
        return {
            "kind": "files",
            "label": f"{len(files)} file{'s' if len(files) != 1 else ''} changed",
            "branch": None,
            "page_ids": [],
            "files": len(files),
        }
    return {"kind": None, "label": "", "branch": None, "page_ids": [], "files": 0}


def accepted_at(d: Data, tid: str, after: str | None) -> str | None:
    """When a person accepted the work of a ticket: moved it to Done, or accepted a Docs proposal made for it."""
    names = {m.name for m in d.ais.values()}
    since = parse_iso(after)
    t = d.tickets.get(tid)
    stamps: list[str] = []
    if t is not None:
        for e in loads(t.activity_log, []):
            if (
                e.get("field") == "status"
                and e.get("to") == "done"
                and e.get("actor") not in names
            ):
                stamps.append(e.get("at") or "")
    for p in d.proposals:
        if p.ticket_id == tid and p.status in ("accepted", "partial") and p.decided_at:
            stamps.append(p.decided_at)
    later = [s for s in stamps if s and (not since or (parse_iso(s) or since) >= since)]
    return max(later) if later else None


def completed(d: Data, a: datetime, b: datetime) -> list[Done]:
    """Tickets completed in [a, b): the last work run finished and the deliverable exists (a branch with the work, a
    published Docs page), or a person accepted it. Not tied to the status Review, so members whose ceiling is lower,
    and tickets that deliver Docs, are not counted as failures."""
    by_t: dict[str, list[AiRun]] = defaultdict(list)
    for r in d.runs:
        if r.mode == "work":
            by_t[r.ticket_id].append(r)
    out = []
    for tid, rows in by_t.items():
        rows.sort(key=lambda r: r.queued_at or "")
        last = rows[-1]
        if last.state != "finished":
            continue
        deliver = deliverable_of(d, tid, rows)
        accepted = accepted_at(d, tid, last.queued_at)
        if deliver["kind"] is None and not accepted:
            continue
        at = (
            accepted
            if (
                accepted
                and (deliver["kind"] is None or accepted > (last.ended_at or ""))
            )
            else last.ended_at
        )
        if not _in(at, a, b):
            continue
        elapsed = flow._secs(rows[0].queued_at, at)
        if elapsed is None:
            continue
        out.append(
            Done(
                tid,
                last,
                float(elapsed),
                _waiting_s(tid, rows, d.approvals),
                deliver,
                at,
            )
        )
    return out


def measure(d: Data, a: datetime, b: datetime) -> dict:
    """The five measures for [a, b)."""
    runs = [r for r in d.runs if _in(r.queued_at, a, b)]
    ended = [r for r in runs if r.state in ENDED]
    ok = [r for r in ended if r.state == "finished"]
    done = completed(d, a, b)
    touches = [t for t in d.touches if _in(t["at"], a, b)]
    bad = {t["ticket_id"] for t in touches if t["mark"] in ("needed", "avoidable")}
    clean = [c for c in done if c.ticket_id not in bad]
    evs = [e for e in d.events if _in(e["at"], a, b)]
    sent_back = [e for e in evs if e["sent_back"]]
    elapsed = sum(c.elapsed_s for c in done)
    waiting = sum(min(c.waiting_s, c.elapsed_s) for c in done)
    priced = sum(r.cost_usd for r in runs if r.metered or r.cost_usd > 0)
    per_ticket = priced / len(done) if done and priced else None
    return {
        "runs": len(runs),
        "reliability": {
            "value": len(ok) / len(ended) if ended else None,
            "ok": len(ok),
            "total": len(ended),
        },
        "autonomy": {
            "value": len(clean) / len(done) if done else None,
            "clean": len(clean),
            "total": len(done),
        },
        "speed": {
            "median_s": _median([c.elapsed_s for c in done]),
            "waiting_share": waiting / elapsed if elapsed else None,
            "tickets": len(done),
        },
        "quality": {
            "value": len(sent_back) / len(evs) if evs else None,
            "sent_back": len(sent_back),
            "handoffs": len(evs),
        },
        "cost": {
            "usd": round(priced, 4),
            "per_ticket": round(per_ticket, 4) if per_ticket is not None else None,
            "cap_share": priced / d.cap if d.cap else None,
            "tokens_only": len(
                [
                    r
                    for r in runs
                    if not (r.metered or r.cost_usd > 0)
                    and (r.tokens_in or r.tokens_out)
                ]
            ),
        },
    }


def _spark(d: Data, a: datetime, b: datetime, pick) -> list[float]:
    """The measure in SLICES equal parts of the range, for the little trend line."""
    step = (b - a) / SLICES
    vals = []
    for i in range(SLICES):
        v = pick(measure(d, a + step * i, a + step * (i + 1)))
        vals.append(float(v) if v is not None else 0.0)
    return vals


def _failure_reason(r: AiRun, blocked_runs: set[str]) -> str:
    text = " ".join(filter(None, [r.ended_reason, r.stop_code])).lower()
    if r.state == "timed_out":
        return "Timed out"
    if "rate" in text:
        return "Rate limit"
    if "budget" in text or "cap" in text:
        return "Hit the budget cap"
    if any(w in text for w in ("not logged in", "runner", "offline", "key", "cli")):
        return "Runner offline"
    if (
        r.id in blocked_runs
        or "blocked" in text
        or "refus" in text
        or "permission" in text
    ):
        return "Blocked by permission"
    return "Other"


def _draft(d: Data, member_id: str | None, text: str) -> dict | None:
    """A change to a member's instructions that a person confirms before anything is saved: the text to add, and
    whether it still fits the instructions' length limit."""
    if not member_id or member_id not in d.ais:
        return None
    current = d.personas.get(member_id, "")
    return {
        "member_id": member_id,
        "member_name": d.ais[member_id].name,
        "text": text,
        "current": current,
        "limit": MAX_PERSONA,
    }


def _quoted(details: str) -> tuple[str, str]:
    """“question” → “answer” as the touch list wrote it, back to the two texts."""
    q, _, a = details.partition(" → ")
    return q.strip("“” "), a.strip("“” ")


def _suggestions(
    d: Data, a: datetime, b: datetime, names: dict[str, str]
) -> list[dict]:
    """ "What to fix": patterns worked out from rules, with the evidence. A pattern needs MIN_CASES cases; a state (an
    orphaned thread, a long wait) shows as soon as it exists."""
    out: list[dict] = []
    runs = [r for r in d.runs if _in(r.queued_at, a, b)]

    # 1. the same refusal again and again
    refused: dict[tuple[str, str], list[AiAudit]] = defaultdict(list)
    for e in d.blocked:
        if e.member_id and _in(e.created_at, a, b):
            refused[(e.member_id, e.action)].append(e)
    for (mid, action), rows in refused.items():
        if len(rows) < MIN_CASES:
            continue
        label = perms.ACTIONS.get(action, (action.replace("_", " "),))[0]
        who = names.get(mid, "An AI")
        in_runs = {e.run_id for e in rows if e.run_id}
        tickets = sorted({e.target for e in rows if e.target and e.target in d.tickets})
        out.append(
            {
                "key": f"refused:{mid}:{action}",
                "severity": "fix",
                "title": f"{who} is refused “{label}” again and again",
                "evidence": f"{len(rows)} refusals in {len(in_runs) or 1} run{'s' if len(in_runs) != 1 else ''}.",
                "suggestion": f"Check what {who} may do. If “{label.lower()}” is meant to be allowed, change it in its permissions; if not, tell it in its instructions.",
                "member_id": mid,
                "tickets": tickets[:3],
                "target": {"type": "member", "id": mid},
                "button": f"Open {who} permissions",
            }
        )

    # 2. the same question, the same answer
    asked: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for t in d.touches:
        if t["kind"] == "answer" and t["mark"] == "avoidable" and _in(t["at"], a, b):
            asked[
                (t["member_id"] or "", t["details"].split(" → ")[0], t["details"])
            ].append(t)
    for (mid, qtext, _), rows in asked.items():
        who = names.get(mid, "An AI")
        out.append(
            {
                "key": f"repeat:{mid}:{qtext}",
                "severity": "watch",
                "title": f"{who} asks the same question again and again",
                "evidence": f"Asked {qtext} and got the same answer each time ({len(rows) + 2} times).",
                "suggestion": f"Put the answer in {who}’s instructions. You confirm before anything is saved.",
                "member_id": mid,
                "tickets": sorted({t["ticket_id"] for t in rows if t["ticket_id"]})[:3],
                "target": {"type": "member", "id": mid},
                "button": "Review the change",
                "draft": _draft(
                    d,
                    mid,
                    (
                        lambda qa: (
                            f"If you are about to ask “{qa[0]}”, the answer is “{qa[1]}”. Use it and do not ask again."
                        )
                    )(_quoted(rows[-1]["details"])),
                ),
            }
        )

    # 3. a ticket sent back again and again
    for tid, n in flow.ping_pong([e for e in d.events if _in(e["at"], a, b)]).items():
        out.append(
            {
                "key": f"pingpong:{tid}",
                "severity": "watch",
                "title": f"{tid} was sent back {n} times",
                "evidence": f"After the first review round it went back {n} more times.",
                "suggestion": "Read what was asked for again: make the criteria concrete (a number, an example), then run once more.",
                "member_id": None,
                "tickets": [tid],
                "target": {"type": "ticket", "id": tid},
                "button": "Open the ticket flow",
            }
        )

    # 4. approvals that are always approved
    decided: dict[tuple[str, str], list[AiApproval]] = defaultdict(list)
    for ap in d.approvals:
        if ap.decided_by and _in(ap.decided_at, a, b):
            decided[(ap.member_id, ap.action)].append(ap)
    for (mid, action), rows in decided.items():
        if len(rows) >= MIN_CASES and all(r.status == "approved" for r in rows):
            label = perms.ACTIONS.get(action, (action,))[0]
            who = names.get(mid, "An AI")
            waits = [flow._secs(r.requested_at, r.decided_at) or 0 for r in rows]
            docs = action == "edit_docs"
            out.append(
                {
                    "key": f"approved:{mid}:{action}",
                    "severity": "watch",
                    "title": f"{who}’s “{label.lower()}” approvals are always approved",
                    "evidence": f"{len(rows)} of {len(rows)} approved, median {int(statistics.median(waits) // 60)} min. None denied.",
                    "suggestion": (
                        "Tick “Don’t ask again” on the next approval: it is the Always allow choice, and you can undo it."
                        if docs
                        else f"You could change “{label.lower()}” for {who} from Needs approval to Allowed. This lowers a safety check, so it is your call; the suggestion is never applied for you."
                    ),
                    "member_id": mid,
                    "tickets": [],
                    "target": {"type": "member", "id": mid},
                    "button": f"Open {who} permissions",
                    "dismiss": "Keep as is",
                }
            )

    # 5. the same tool error, run after run
    errors: dict[str, list[str]] = defaultdict(list)
    for r in runs:
        for s in loads(r.steps, []):
            text = str(s.get("text") or "")
            # a refusal by the board's rules is its own suggestion (1); this one is for tools that fail
            if "BLOCKED" in text:
                continue
            if s.get("kind") == "error" or "Error executing tool" in text:
                key = text.split(":", 1)[-1].strip()[:80]
                if key:
                    errors[key].append(r.id)
    for text, ids in errors.items():
        if len(ids) >= MIN_CASES:
            who_runs = Counter(r.member_id for r in runs if r.id in set(ids))
            culprit = who_runs.most_common(1)[0][0] if who_runs else None
            if "project_id" in text.lower() or "project id" in text.lower():
                fix = f"You work in the project “{d.project_name}” (project_id {d.project_id}). Pass it whenever a tool asks for a project."
            else:
                fix = f"If a tool call fails with “{text[:60]}”, read the tool’s description and correct the arguments before you try again."
            out.append(
                {
                    "key": f"toolerror:{text}",
                    "severity": "watch",
                    "title": "The same tool error, run after run",
                    "evidence": f"“{text}” {len(ids)} times in {len(set(ids))} runs.",
                    "suggestion": "Say in the instructions how to use the tool (for example which project), or fix the tool description. It is a prompt or tool problem, not a failing AI.",
                    "member_id": culprit,
                    "tickets": [],
                    "target": {"type": "member", "id": culprit},
                    "button": "Review the change",
                    "draft": _draft(d, culprit, fix),
                }
            )

    # 6. "Finished." that hid a failure
    hid = [
        r
        for r in runs
        if r.state == "finished"
        and len((r.summary or "").split()) <= 2
        and any(
            s.get("kind") == "error" or "BLOCKED" in str(s.get("text") or "")
            for s in loads(r.steps, [])
        )
    ]
    if len(hid) >= MIN_CASES:
        out.append(
            {
                "key": "hidfailure",
                "severity": "watch",
                "title": "Runs that end with a one-word summary but hid a failure",
                "evidence": f"{len(hid)} runs gave a one-word summary while a refused action or an error is in their steps.",
                "suggestion": "Ask for a closing line that says what could not be done.",
                "member_id": (
                    culprit := Counter(r.member_id for r in hid).most_common(1)[0][0]
                ),
                "tickets": sorted({r.ticket_id for r in hid})[:3],
                "target": {"type": "member", "id": culprit},
                "button": "Review the change",
                "draft": _draft(
                    d,
                    culprit,
                    "End every run with one closing line that says what could not be done, if anything. Do not write only “Finished.” when an action was refused or a tool failed.",
                ),
            }
        )

    # 7. review threads orphaned after a revision
    orphaned: dict[str, int] = Counter()
    for th in d.threads:
        if th.status == "open" and th.anchor_state == "orphaned":
            orphaned[th.page_id] += 1
    for pid, n in orphaned.items():
        page = d.pages.get(pid)
        out.append(
            {
                "key": f"orphaned:{pid}",
                "severity": "watch",
                "title": "Review threads orphaned after a revision",
                "evidence": f"{n} thread{'s' if n != 1 else ''} on {page.title if page else 'a page'} lost their text. They are still open.",
                "suggestion": "Re-attach or resolve them, and ask the author to answer each thread before rewriting a section.",
                "member_id": None,
                "tickets": [],
                "target": {"type": "page", "id": pid},
                "button": "Open the threads",
            }
        )

    # 8. a run that waited behind another
    for r in runs:
        if r.behind_run_id and r.started_at:
            wait = flow._secs(r.queued_at, r.started_at) or 0
            if wait >= QUEUE_WAIT_S:
                who = names.get(r.member_id, "An AI")
                out.append(
                    {
                        "key": f"queued:{r.id}",
                        "severity": "watch",
                        "title": f"A run waited {wait // 60} minutes behind another",
                        "evidence": f"{r.ticket_id} was queued behind {who}’s run. {who} can run one at a time.",
                        "suggestion": f"Allow {who} more runs at once, or add a second member for this role.",
                        "member_id": r.member_id,
                        "tickets": [r.ticket_id],
                        "target": {"type": "member", "id": r.member_id},
                        "button": f"Open {who} limits",
                    }
                )
    return out


async def load(session: AsyncSession, project_id: str, since: datetime) -> Data:
    """Read what the measures need, from `since` (the start of the previous range) on, and the older runs of the
    tickets involved (rounds are counted from a ticket's first run)."""
    ai_rows = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    ais = {m.id: m for m in ai_rows}
    profiles = (
        await session.exec(
            select(AiMember).where(col(AiMember.id).in_(list(ais) or [""]))
        )
    ).all()
    personas = {p.id: p.persona or "" for p in profiles}
    project = await session.get(Project, project_id)
    templates = {
        p.id: p.template
        for p in (
            await session.exec(
                select(AiMember).where(col(AiMember.id).in_(list(ais) or [""]))
            )
        ).all()
    }
    all_runs = (
        await session.exec(select(AiRun).where(AiRun.project_id == project_id))
    ).all()
    recent_tickets = {
        r.ticket_id for r in all_runs if (parse_iso(r.queued_at) or since) >= since
    }
    runs = [r for r in all_runs if r.ticket_id in recent_tickets]
    tickets = {
        t.id: t
        for t in (
            await session.exec(select(Ticket).where(Ticket.project_id == project_id))
        ).all()
    }
    settings = await get_settings(session, project_id)
    touches = await svc_touches.collect(session, project_id, since)
    approvals = [
        a
        for a in (
            await session.exec(
                select(AiApproval).where(AiApproval.project_id == project_id)
            )
        ).all()
    ]
    blocked = (
        await session.exec(
            select(AiAudit).where(
                AiAudit.project_id == project_id, AiAudit.result == "blocked"
            )
        )
    ).all()
    pages = {
        p.id: p
        for p in (
            await session.exec(
                select(DocsPage).where(DocsPage.project_id == project_id)
            )
        ).all()
    }
    threads = (
        await session.exec(
            select(DocsCommentThread).where(
                col(DocsCommentThread.page_id).in_(list(pages) or [""])
            )
        )
    ).all()
    versions = (
        await session.exec(
            select(DocsVersion).where(col(DocsVersion.page_id).in_(list(pages) or [""]))
        )
    ).all()
    links = (
        await session.exec(
            select(DocsLink).where(
                col(DocsLink.source_page_id).in_(list(pages) or [""])
            )
        )
    ).all()
    proposals = (
        await session.exec(
            select(DocsAiProposal).where(DocsAiProposal.project_id == project_id)
        )
    ).all()
    d = Data(
        project_id=project_id,
        ais=ais,
        templates=templates,
        personas=personas,
        project_name=project.name if project else "",
        runs=runs,
        tickets=tickets,
        touches=touches,
        approvals=approvals,
        blocked=list(blocked),
        threads=list(threads),
        pages=pages,
        versions=list(versions),
        links=list(links),
        proposals=list(proposals),
        cap=settings.board_monthly_budget or None,
    )
    d.events = flow.events(runs, ais, templates)
    return d


def _delta(
    now_v: float | None, prev_v: float | None, scale: float = 1.0
) -> float | None:
    if now_v is None or prev_v is None:
        return None
    return (now_v - prev_v) * scale


def _dismissed(settings: AiProjectSettings) -> set[str]:
    return {
        x.get("key") for x in loads(settings.team_dismissed, []) if isinstance(x, dict)
    }


async def health(session: AsyncSession, project_id: str, range_key: str = "7d") -> dict:
    """The Health tab: verdict, five measures with the change since the previous range, a row per AI, what to fix."""
    if range_key not in RANGES:
        range_key = "7d"
    now = datetime.now(UTC)
    a = window_start(range_key, now)
    prev_a = a - (now - a)
    d = await load(session, project_id, prev_a)
    names = {m.id: m.name for m in d.ais.values()}
    cur = measure(d, a, now)
    prev = measure(d, prev_a, a)
    judge = cur["runs"] >= MIN_RUNS
    few = cur["runs"] < TOO_FEW

    cur_cost_pct = cur["cost"]["cap_share"]
    measures = {
        "reliability": {
            **cur["reliability"],
            "verdict": verdict("reliability", cur["reliability"]["value"])
            if judge
            else None,
            "delta": _delta(
                cur["reliability"]["value"], prev["reliability"]["value"], 100
            ),
            "better": "up",
            "spark": _spark(
                d, a, now, lambda m: (m["reliability"]["value"] or 0) * 100
            ),
        },
        "autonomy": {
            **cur["autonomy"],
            "goal": 0.70,
            "verdict": verdict("autonomy", cur["autonomy"]["value"]) if judge else None,
            "delta": _delta(cur["autonomy"]["value"], prev["autonomy"]["value"], 100),
            "better": "up",
            "spark": _spark(d, a, now, lambda m: (m["autonomy"]["value"] or 0) * 100),
        },
        "speed": {
            **cur["speed"],
            "verdict": verdict("waiting", cur["speed"]["waiting_share"])
            if judge
            else None,
            "delta_s": _delta(cur["speed"]["median_s"], prev["speed"]["median_s"]),
            "better": "down",
            "spark": _spark(d, a, now, lambda m: m["speed"]["median_s"] or 0),
        },
        "quality": {
            **cur["quality"],
            "verdict": verdict("quality", cur["quality"]["value"]) if judge else None,
            "delta": _delta(cur["quality"]["value"], prev["quality"]["value"], 100),
            "better": "down",
            "spark": _spark(d, a, now, lambda m: (m["quality"]["value"] or 0) * 100),
        },
        "cost": {
            **cur["cost"],
            "cap": d.cap,
            "verdict": verdict("cost", cur_cost_pct)
            if judge and cur_cost_pct is not None
            else None,
            "delta_usd": _delta(cur["cost"]["usd"], prev["cost"]["usd"]),
            "better": "down",
            "spark": _spark(d, a, now, lambda m: m["cost"]["usd"]),
        },
    }

    settings = await get_settings(session, project_id)
    hidden = _dismissed(settings)
    suggestions = [s for s in _suggestions(d, a, now, names) if s["key"] not in hidden]
    suggestions.sort(key=lambda s: 0 if s["severity"] == "fix" else 1)
    if not judge:
        suggestions = []  # "the verdict and What to fix wait for 10 runs"

    # why runs did not finish OK
    runs = [r for r in d.runs if _in(r.queued_at, a, now)]
    blocked_runs = {e.run_id for e in d.blocked if e.run_id}
    why: dict[str, list[str]] = defaultdict(list)
    for r in runs:
        if r.state in ENDED and r.state != "finished":
            why[_failure_reason(r, blocked_runs)].append(r.id)
    not_ok = [
        {
            "label": k,
            "count": len(v),
            "run_ids": v[:20],
            "ticket_ids": sorted(
                {next(r.ticket_id for r in runs if r.id == i) for i in v}
            )[:5],
        }
        for k, v in sorted(why.items(), key=lambda kv: -len(kv[1]))
    ]

    # a row per AI
    per_ai = []
    touches = [t for t in d.touches if _in(t["at"], a, now)]
    evs = [e for e in d.events if _in(e["at"], a, now)]
    for mid, m in d.ais.items():
        mine = [r for r in runs if r.member_id == mid]
        ended = [r for r in mine if r.state in ENDED]
        ok = [r for r in ended if r.state == "finished"]
        asked = [r for r in mine if loads(r.question, None)]
        durations = [s for r in ended if (s := flow._secs(r.started_at, r.ended_at))]
        priced = sum(r.cost_usd for r in mine if r.metered or r.cost_usd > 0)
        tickets_n = len({r.ticket_id for r in mine})
        tokens = sum((r.tokens_in or 0) + (r.tokens_out or 0) for r in mine)
        my_sug = [s for s in suggestions if s["member_id"] == mid]
        reliability = len(ok) / len(ended) if ended else None
        status = "healthy"
        if any(s["severity"] == "fix" for s in my_sug) or (
            reliability is not None and len(ended) >= 3 and reliability < 0.75
        ):
            status = "fix"
        elif my_sug:
            status = "watch"
        per_ai.append(
            {
                "id": mid,
                "name": m.name,
                "color": m.color,
                "runs": len(mine),
                "ok_share": reliability,
                "asked": len(asked),
                "asked_share": len(asked) / len(mine) if mine else None,
                "touches_per_10": round(
                    len([t for t in touches if t["member_id"] == mid]) * 10 / len(mine),
                    1,
                )
                if mine
                else None,
                "avg_run_s": int(statistics.mean(durations)) if durations else None,
                "cost_per_ticket": round(priced / tickets_n, 4)
                if priced and tickets_n
                else None,
                "tokens": tokens if not priced else None,
                "sent_back_to": len(
                    [e for e in evs if e["to"] == mid and e["sent_back"]]
                ),
                "status": status if mine else "idle",
            }
        )

    counts = Counter(v["verdict"] for v in measures.values() if v["verdict"])
    state = (
        "unknown"
        if not judge
        else "fix"
        if counts["fix"]
        else "watch"
        if counts["watch"] or suggestions
        else "good"
    )
    return {
        "range": range_key,
        "since": a.isoformat(),
        "until": now.isoformat(),
        "previous_since": prev_a.isoformat(),
        "runs": cur["runs"],
        "tickets": len({r.ticket_id for r in runs}),
        "can_judge": judge,
        "too_few": few,
        "state": state,
        "counts": {
            "good": counts["good"],
            "watch": counts["watch"],
            "fix": counts["fix"],
        },
        "touches": {
            "total": len(touches),
            "avoidable": len([t for t in touches if t["mark"] == "avoidable"]),
        },
        "measures": measures,
        "per_ai": per_ai,
        "suggestions": suggestions,
        "not_ok": not_ok,
        "not_ok_total": sum(x["count"] for x in not_ok),
    }


async def dismiss(
    session: AsyncSession, project_id: str, key: str, *, by: str
) -> list[str]:
    """Hide a suggestion until the pattern changes (its key does). Nothing else is touched."""
    settings = await get_settings(session, project_id)
    rows = [x for x in loads(settings.team_dismissed, []) if isinstance(x, dict)]
    if not any(x.get("key") == key for x in rows):
        rows.append({"key": key, "at": now_iso(), "by": by})
    settings.team_dismissed = json.dumps(rows[-200:])
    session.add(settings)
    await session.commit()
    return [x["key"] for x in rows]
