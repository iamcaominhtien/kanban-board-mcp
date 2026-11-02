"""AI Team, Flow, Live commentary: a live-chat feed of short, human lines about what each AI is doing right now.

Nothing is tracked for it. Every line is built from what the board already stores: the steps of each run (what the AI
read, edited, ran and said), the run's own life (queued, started, asked, finished, failed) and the moves of the
workflows (a step started, handed in, sent back, blocked; the PM's split; the board taking a ticket in, or moving it to
Done). Lines are oldest first, like a chat.

Polling is cheap and exact: the client sends back the `cursor` it got. The cursor holds the newest time it has seen and
short hashes of the lines it got in the last `GRACE_S` seconds before it, so a line that was committed a moment late
(stamped before a line it was committed after) is still delivered once, and a line already delivered never comes back.
"""

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta

from sqlmodel import col, or_, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    AiDecision,
    AiMember,
    AiRun,
    AiTicketStep,
    AiTicketWorkflow,
    Member,
)

from . import scope
from .packs import BUILTIN
from .secrets import redact
from .store import loads, parse_iso

# A first load shows this much of the past; a cursor reads only after itself (bounded, for a laptop that slept)
WINDOW_H = 3
MAX_BACK_H = 24
# How late a line may be committed after the newest line the client already has, and still be delivered
GRACE_S = 15
MAX_LIMIT = 500
TEXT_MAX = 220

ACTIVE = ("queued", "starting", "running", "needs_input")
WORKING = ("starting", "running", "needs_input")
# runs the workflow starts: the step that started says it, so the run's own "started" line is left out
WORKFLOW_TRIGGERS = ("workflow", "manager", "arbitration", "review")
BOARD = {
    "member_id": None,
    "member_name": "Board",
    "glyph": "board",
    "color": "#5B6B60",
    "role": None,
}
INTAKE_BY = "the board (intake)"

# Steps that only the board needs (its own bookkeeping), or that another line already says
SKIP_KINDS = {
    "system",
    "compact",
    "window",
    "context",
    "fresh_session",
    "held",
    "not_started",
    "summary",
    "end",
    "start",
    "answer",
}
ROLE_LABEL = {p["key"]: p["name"] for p in BUILTIN}
# The lines Highlights keeps (design/screens/ai-story-flow.md K): a step or a run finished, work sent back, a PM
# decision, a pull request opened, anything that needs a person. Commands, reads and edits are Everything only.
HIGHLIGHT_KINDS = {
    "finished",
    "failed",
    "blocked",
    "sent_back",
    "review",
    "tdd",
    "done",
    "decision",
    "pm_decision",
    "split",
    "waiting",
    "question",
    "pull_request",
}
_PR_CREATE = re.compile(r"\bgh\s+pr\s+create\b")


@dataclass
class Item:
    """One line of the feed, before it is handed out."""

    id: str
    at: datetime
    order: tuple
    speaker: dict
    ticket_id: str | None
    kind: str
    text: str
    tone: str = "info"
    ref: str | None = None
    highlight: bool = False
    run_id: str | None = None

    def out(
        self, ticket_titles: dict[str, str], stories: dict[str, str] | None = None
    ) -> dict:
        """The line as the API hands it out."""
        return {
            "id": self.id,
            "at": _iso(self.at),
            **self.speaker,
            "role_label": ROLE_LABEL.get(self.speaker.get("role") or "")
            or (self.speaker.get("role") or None),
            "ticket_id": self.ticket_id,
            "ticket_title": ticket_titles.get(self.ticket_id or ""),
            "kind": self.kind,
            "text": self.text,
            "tone": self.tone,
            "ref": self.ref,
            "highlight": self.highlight or self.kind in HIGHLIGHT_KINDS,
            "story_id": (stories or {}).get(self.ticket_id or ""),
            "run_id": self.run_id,
        }


def _iso(at: datetime) -> str:
    return at.astimezone(UTC).isoformat(timespec="milliseconds")


def _ms(at: datetime) -> datetime:
    """The time at the precision the feed hands out, so a cursor compares equal to the line it came from."""
    at = at.astimezone(UTC)
    return at.replace(microsecond=(at.microsecond // 1000) * 1000)


def _clip(text: str | None, n: int = TEXT_MAX) -> str:
    text = redact(" ".join((text or "").split()))
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _first_line(text: str | None) -> str:
    for line in (text or "").splitlines():
        line = line.strip().lstrip("#*-> ").strip()
        if line:
            return line
    return ""


# ---------------------------------------------------------------------------------------------------- the sentences

_BOARD_CALL = re.compile(r"^board\.([\w.]+)\((.*)\)$")


def board_sentence(text: str) -> tuple[str, str]:
    """(sentence, tone) for a board tool call the runner logged as `board.tool.item.action(target)`."""
    m = _BOARD_CALL.match((text or "").strip())
    if not m:
        return _clip(text), "info"
    parts = m.group(1).split(".")
    tool, rest = parts[0], parts[1:]
    action = rest[-1] if rest else ""
    item = rest[0] if len(rest) > 1 else ""
    target = m.group(2).strip()
    on = f" {target}" if target else ""
    if tool == "ai_run":
        if action == "report":
            return "Reported its work", "good"
        if action == "ask":
            return "Asked a question", "warn"
        return "Updated its run", "info"
    if tool == "get_ticket":
        return (f"Read{on}" if target else "Read the ticket"), "info"
    if tool == "list_tickets":
        return "Looked over the board", "info"
    if tool == "get_projects":
        return "Looked at the projects", "info"
    if tool == "docs_read":
        return "Read the docs", "info"
    if tool == "docs_write":
        return "Wrote in the docs", "info"
    if tool == "manage_ticket":
        words = {
            "create": "Created a ticket",
            "update": f"Updated{on or ' the ticket'}",
            "move": f"Moved{on or ' the ticket'}",
            "status": f"Moved{on or ' the ticket'}",
            "assign": f"Assigned{on or ' the ticket'}",
            "delete": f"Deleted{on or ' a ticket'}",
            "archive": f"Archived{on or ' a ticket'}",
        }
        return words.get(action, f"Changed{on or ' the ticket'}"), "info"
    if tool == "ticket_items":
        noun = (item or "item").replace("_", " ")
        if noun.startswith("comment"):
            return f"Commented on{on or ' the ticket'}", "info"
        if action in ("list", "get", "read"):
            return f"Read the {noun}s{' of' + on if on else ''}", "info"
        return f"Updated the {noun}s{' of' + on if on else ''}", "info"
    if tool == "ticket_branches":
        return f"Worked on the branch{' of' + on if on else ''}", "info"
    if tool == "ai_team":
        if action == "ask":
            return "Woke a teammate", "info"
        return "Checked on the team", "info"
    if tool == "ai_schedules":
        return "Looked at the schedules", "info"
    return _clip(f"Used the board: {'.'.join(parts)}{on}"), "info"


def _tests_line(tests: dict) -> tuple[str, str]:
    passed, failed = int(tests.get("passed") or 0), int(tests.get("failed") or 0)
    bits = [f"{passed} passed"] if passed or not failed else []
    if failed:
        bits.append(f"{failed} failed")
    return ", ".join(bits), ("bad" if failed else "good")


def step_sentence(step: dict) -> tuple[str, str, str] | None:
    """(kind, sentence, tone) for one run step, or None when it is noise."""
    kind = str(step.get("kind") or "")
    text = str(step.get("text") or "")
    if kind in SKIP_KINDS or not text.strip():
        return None
    if kind == "command":
        cmd = text[4:] if text.startswith("Ran ") else text
        cmd = cmd.replace("`", "'")
        return "command", _clip(f"Ran `{cmd}`"), "info"
    if kind == "board":
        sentence, tone = board_sentence(text)
        return "board", sentence, tone
    if kind == "say":
        return "say", _clip(f"Said: {text}"), "info"
    if kind == "read":
        if text.startswith("Sent the ticket") or text.startswith("Sent what changed"):
            return "read", "Read the ticket", "info"
        return "read", _clip(text), "info"
    if kind == "question":
        m = re.match(r"^Asked [^:]{1,80}:\s*(.+)$", text, re.DOTALL)
        if m:
            return "question", _clip(f"Asks: {m.group(1)}"), "warn"
        return "question", _clip(text), "warn"
    if kind == "message":
        who, _, said = text.partition(": ")
        if said:
            return "message", _clip(f"Got a message from {who}: {said}"), "info"
        return "message", _clip(f"Got a message: {text}"), "info"
    if kind == "report":
        return "report", "Reported its work", "good"
    if kind in ("edit", "create", "search", "skill", "subagent", "tool"):
        return kind, _clip(text), "info"
    if kind in ("error", "trouble", "failed", "ask_failed"):
        return kind, _clip(text), "bad"
    if kind == "rate_limited":
        return kind, "Hit a rate limit; it will try again shortly", "warn"
    if kind in ("retry", "paused", "cancel"):
        return kind, _clip(text), "warn"
    return kind or "note", _clip(text), "info"


def result_sentence(step: dict) -> tuple[str, str] | None:
    """(sentence, tone) for what a command printed: its tests, or a non-zero exit. A clean exit says nothing."""
    tests = step.get("tests")
    if isinstance(tests, dict) and (tests.get("passed") or tests.get("failed")):
        return _tests_line(tests)
    code = step.get("exit_code")
    if isinstance(code, int) and code != 0:
        return f"exited with {code}", "bad"
    return None


# ------------------------------------------------------------------------------------------------- the step times


def step_times(steps: list[dict], base: datetime) -> list[datetime]:
    """Full times for the steps' `HH:MM:SS` (UTC, no date): the day of `base` (when the run was queued), moving to the
    next day each time the clock goes back past midnight. The times never go back (a step is never before the one
    before it, nor before the run was queued)."""
    out: list[datetime] = []
    prev = base.astimezone(UTC)
    for s in steps:
        try:
            h, m, sec = (int(x) for x in str(s.get("at") or "").split(":")[:3])
            t = time(h, m, sec)
        except (TypeError, ValueError):
            out.append(prev)
            continue
        cand = datetime.combine(prev.date(), t, UTC)
        while cand < prev - timedelta(minutes=2):
            cand += timedelta(days=1)
        # a stamp has no fraction of a second: a step of the same second as the one before is not before it
        cand = max(cand, prev)
        out.append(cand)
        prev = cand
    return out


def _step_ids(run_id: str, steps: list[dict]) -> list[str]:
    """A stable id per step: from its content, not its place (the board keeps only the last steps of a long run)."""
    seen: dict[str, int] = {}
    ids = []
    for s in steps:
        key = f"{s.get('at')}|{s.get('kind')}|{s.get('text')}|{s.get('tool_id') or ''}"
        n = seen.get(key, 0)
        seen[key] = n + 1
        ids.append(f"{run_id}:{hashlib.sha1(f'{key}|{n}'.encode()).hexdigest()[:10]}")
    return ids


# ------------------------------------------------------------------------------------------------------ the items


def run_items(run: AiRun, speaker: dict) -> list[Item]:
    """Every line one run gives: its life, and its steps in friendly words."""
    items: list[Item] = []
    tid = run.ticket_id
    queued = parse_iso(run.queued_at) or datetime.now(UTC)

    def add(suffix: str, at, kind: str, text: str, tone: str, rank: int, ref=None):
        if at is None:
            return
        items.append(
            Item(
                id=f"{run.id}:{suffix}",
                at=_ms(at),
                order=(run.id, rank),
                speaker=speaker,
                ticket_id=tid,
                kind=kind,
                text=text,
                tone=tone,
                ref=ref,
            )
        )

    if run.behind_run_id:
        add("q", queued, "queued", "Waits for the AI holding this ticket", "info", -3)
    else:
        add("q", queued, "queued", "Queued", "info", -3)
    if run.trigger not in WORKFLOW_TRIGGERS:
        text = "Started answering a question" if run.mode == "ask" else "Started work"
        add("s", parse_iso(run.started_at), "started", text, "info", -2)

    steps = [s for s in loads(run.steps, []) if isinstance(s, dict)]
    times = step_times(steps, queued)
    ids = _step_ids(run.id, steps)
    last_text = None
    for i, s in enumerate(steps):
        said = step_sentence(s)
        if said is not None:
            kind, text, tone = said
            if text != last_text:  # the same line twice in a row says nothing new
                items.append(
                    Item(
                        ids[i],
                        _ms(times[i]),
                        (run.id, i * 2),
                        speaker,
                        tid,
                        kind,
                        text,
                        tone,
                        # opening a pull request is a highlight, the other commands are not
                        highlight=kind == "command"
                        and bool(_PR_CREATE.search(str(s.get("text") or ""))),
                    )
                )
                last_text = text
        if s.get("kind") != "command":
            continue
        res = result_sentence(s)
        if res is None:
            continue
        # the result lands on the command's step later; it is told when the run has moved past it (a later step
        # stamped after it) or ended, at that time, so a client that already has the command still gets it
        later = next(
            (times[j] for j in range(i + 1, len(steps)) if times[j] > times[i]), None
        )
        at = later or (parse_iso(run.ended_at) if run.ended_at else None)
        if at is None:
            continue
        cmd = s.get("text") or ""
        cmd = (cmd[4:] if cmd.startswith("Ran ") else cmd).replace("`", "'")
        text, tone = res
        items.append(
            Item(
                f"{ids[i]}:r",
                _ms(at),
                (run.id, i * 2 + 1),
                speaker,
                tid,
                "result",
                _clip(f"`{cmd}` — {text}"),
                tone,
                ref=ids[i],
            )
        )

    ended = parse_iso(run.ended_at)
    if ended is not None:
        summary = _first_line(run.summary or loads(run.report, {}).get("summary"))
        reason = _first_line(run.ended_reason)
        if run.state == "finished":
            text = "Answered" if run.mode == "ask" else "Finished"
            add(
                "e",
                ended,
                "finished",
                _clip(f"{text}: {summary}" if summary else text),
                "good",
                10**6,
            )
        elif run.state == "failed":
            add(
                "e",
                ended,
                "failed",
                _clip(f"Failed: {reason}" if reason else "Failed"),
                "bad",
                10**6,
            )
        elif run.state == "timed_out":
            add("e", ended, "failed", "Ran out of time", "bad", 10**6)
        elif run.state == "cancelled":
            add(
                "e",
                ended,
                "stopped",
                _clip(f"Stopped: {reason}" if reason else "Stopped"),
                "warn",
                10**6,
            )
    for i in items:
        i.run_id = run.id
    return items


def step_row_items(row: AiTicketStep, speaker: dict, wf_order: int) -> list[Item]:
    """The lines of one workflow step row: it started, it was handed in, sent back, blocked, decided."""
    if row.state == "superseded" and not row.ended_at:
        return []  # replaced before it ran (a send-back to an earlier step)
    items: list[Item] = []
    label = row.label or row.key
    tid = row.ticket_id
    ai = row.kind == "ai"

    def add(suffix: str, at, kind: str, text: str, tone: str, who: dict, rank: int):
        if at is None:
            return
        items.append(
            Item(
                f"{row.id}:{suffix}",
                _ms(at),
                (f"wf:{tid}", wf_order, rank),
                who,
                tid,
                kind,
                _clip(text),
                tone,
                # a step that ended (handed in, checks passed or failed) or stopped; its start is Everything only
                highlight=suffix in ("e", "b"),
                run_id=row.run_id,
            )
        )

    started, ended = parse_iso(row.started_at), parse_iso(row.ended_at)
    if ai:
        if row.attempt > 1 and row.note_in:
            add(
                "s",
                started,
                "sent_back",
                f"Took it back for {label}: {row.note_in}",
                "warn",
                speaker,
                0,
            )
        else:
            add("s", started, "step", f"Started the {label} step", "info", speaker, 0)
    elif row.kind == "code":
        add("s", started, "checks", "Running the checks", "info", BOARD, 0)
    elif row.kind == "person" and row.state == "waiting":
        add("s", started, "waiting", f"Waiting for a person: {label}", "warn", BOARD, 0)

    if row.state == "blocked":
        add(
            "b",
            ended or started,
            "blocked",
            f"Blocked on {label}" + (f": {row.note}" if row.note else ""),
            "bad",
            speaker if ai else BOARD,
            1,
        )
        return items
    if ended is None:
        return items
    note = _first_line(row.note)
    outcome = row.outcome
    if outcome == "board":
        add(
            "e",
            ended,
            "done",
            "Moved it to Done: the checks, the test-first rule and the review all passed",
            "good",
            BOARD,
            1,
        )
    elif row.kind == "code":
        if outcome == "failed":
            add(
                "e",
                ended,
                "checks",
                f"Checks failed: {note}" if note else "Checks failed",
                "bad",
                BOARD,
                1,
            )
        else:
            add("e", ended, "checks", note or "Checks passed", "good", BOARD, 1)
    elif row.kind == "person":
        if outcome in ("approved", "sent_back"):
            add(
                "e",
                ended,
                "decision",
                note or ("Approved" if outcome == "approved" else "Sent back"),
                "good" if outcome == "approved" else "warn",
                BOARD,
                1,
            )
    elif outcome == "pass":
        add("e", ended, "review", "Passed the review", "good", speaker, 1)
    elif outcome == "changes":
        add(
            "e",
            ended,
            "review",
            f"Asked for changes: {note}" if note else "Asked for changes",
            "warn",
            speaker,
            1,
        )
    elif outcome == "failed" or row.state == "failed":
        add(
            "e",
            ended,
            "failed",
            f"The {label} step failed" + (f": {note}" if note else ""),
            "bad",
            speaker,
            1,
        )
    elif outcome == "unproven":
        add("e", ended, "tdd", f"No test-first evidence for {label}", "warn", BOARD, 1)
    elif row.state == "done" and ai:
        add("e", ended, "step", f"Handed in the {label} step", "good", speaker, 1)
    return items


def workflow_items(
    wf: AiTicketWorkflow, rows: list[AiTicketStep], speakers: dict[str, dict]
) -> list[Item]:
    """The board taking the ticket in, and the PM's split."""
    items: list[Item] = []
    tid = wf.ticket_id
    if wf.attached_by == INTAKE_BY:
        at = parse_iso(wf.created_at)
        if at:
            items.append(
                Item(
                    f"wf:{tid}:intake",
                    _ms(at),
                    (f"wf:{tid}", -1, 0),
                    BOARD,
                    tid,
                    "intake",
                    _clip(f"Took the ticket in for the team: {wf.template_name}"),
                    "info",
                )
            )
    if wf.stop_reason == "split":
        pm = next(
            (r for r in reversed(rows) if r.kind == "ai" and r.role == "pm"), None
        )
        pm = pm or next((r for r in reversed(rows) if r.kind == "ai"), None)
        who = speakers.get(pm.member_id or "") if pm else None
        at = parse_iso((pm.ended_at or pm.started_at) if pm else None) or parse_iso(
            wf.updated_at
        )
        kids = [str(k) for k in (loads(wf.meta, {}).get("split") or [])]
        detail = ", ".join(kids) if kids else (wf.stop_detail or "")
        n = len(kids)
        text = (
            f"Split it into {n} pieces: {detail}"
            if n
            else f"Split it up: {detail}"
            if detail
            else "Split it up"
        )
        if at:
            items.append(
                Item(
                    f"wf:{tid}:split",
                    _ms(at),
                    (f"wf:{tid}", 10**6, 0),
                    who or BOARD,
                    tid,
                    "split",
                    _clip(text),
                    "info",
                )
            )
    return items


def decision_items(rows: list[AiDecision], speakers: dict[str, dict]) -> list[Item]:
    """What the PM decided in a person's place: one line each, said by the PM."""
    items = []
    for x in rows:
        at = parse_iso(x.at)
        if at is None:
            continue
        who = speakers.get(x.member_id or "") or {
            **_unknown(x.member_id),
            "member_name": "PM",
        }
        items.append(
            Item(
                f"dec:{x.id}",
                _ms(at),
                (f"dec:{x.id}", 0),
                who,
                x.ticket_id or x.story_id,
                "pm_decision",
                _clip(x.title + (" (overridden)" if x.state == "overridden" else "")),
                "info",
            )
        )
    return items


# ---------------------------------------------------------------------------------------------------------- cursor


def _h(item_id: str) -> str:
    return hashlib.sha1(item_id.encode()).hexdigest()[:10]


def encode_cursor(t: datetime, seen: list[str]) -> str:
    """The opaque cursor: the newest time handed out and the hashes of the lines handed out just before it."""
    raw = json.dumps(
        {"v": 1, "t": _iso(t), "s": sorted(set(seen))}, separators=(",", ":")
    )
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> tuple[datetime, set[str]] | None:
    """(time, hashes) of a cursor, or None when there is none or it does not read."""
    if not cursor:
        return None
    try:
        pad = "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(cursor + pad).decode())
        t = parse_iso(data["t"])
        seen = {str(x) for x in data.get("s") or []}
    except (ValueError, KeyError, TypeError):
        return None
    return (_ms(t), seen) if t else None


# ----------------------------------------------------------------------------------------------------------- feed


async def _speakers(session: AsyncSession, project_id: str) -> dict[str, dict]:
    members = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    profiles = {
        p.id: p
        for p in (
            await session.exec(
                select(AiMember).where(
                    col(AiMember.id).in_([m.id for m in members] or [""])
                )
            )
        ).all()
    }
    out = {}
    for m in members:
        p = profiles.get(m.id)
        cfg = loads(p.config, {}) if p else {}
        out[m.id] = {
            "member_id": m.id,
            "member_name": m.name,
            "glyph": (p.glyph if p else None) or "spark",
            "color": m.color,
            "role": (cfg.get("role") if isinstance(cfg, dict) else None) or None,
        }
    return out


def _unknown(member_id: str | None) -> dict:
    return {
        "member_id": member_id,
        "member_name": "An AI",
        "glyph": "spark",
        "color": "#5B6B60",
        "role": None,
    }


async def feed(
    session: AsyncSession,
    project_id: str,
    *,
    after: str | None = None,
    limit: int = 200,
    now: datetime | None = None,
    story: str | None = None,
    ticket: str | None = None,
) -> dict | None:
    """`{items, cursor, working, needs_you, scope}`: the lines after the cursor (or the last `WINDOW_H` hours' last
    `limit` lines) in the scope (the project, one Story or one ticket), oldest first; `working` is the AIs that have a
    run going right now on it, `needs_you` the rows of the Now tab's Needs you list that belong to it. None when the
    Story or the ticket is not in the project."""
    sc = await scope.resolve(session, project_id, story=story, ticket=ticket)
    if sc is None:
        return None
    now = now or datetime.now(UTC)
    limit = max(1, min(int(limit or 200), MAX_LIMIT))
    cur = decode_cursor(after)
    if cur is not None:
        t, seen = cur
        floor = max(t - timedelta(seconds=GRACE_S), now - timedelta(hours=MAX_BACK_H))
    else:
        t, seen = None, set()
        floor = now - timedelta(hours=WINDOW_H)
    floor_s = floor.isoformat()

    speakers = await _speakers(session, project_id)
    q = select(AiRun).where(
        AiRun.project_id == project_id,
        or_(
            col(AiRun.state).in_(ACTIVE),
            col(AiRun.queued_at) >= floor_s,
            col(AiRun.ended_at) >= floor_s,
            col(AiRun.last_output_at) >= floor_s,
        ),
    )
    if sc.ids is not None:
        q = q.where(col(AiRun.ticket_id).in_(list(sc.ids)))
    runs = (await session.exec(q)).all()
    items: list[Item] = []
    for r in runs:
        items += run_items(r, speakers.get(r.member_id) or _unknown(r.member_id))

    # only the workflow rows and workflows that moved in the window, not every workflow the project ever had
    of_project = select(AiTicketWorkflow.ticket_id).where(
        AiTicketWorkflow.project_id == project_id
    )
    rows = (
        await session.exec(
            select(AiTicketStep)
            .where(
                col(AiTicketStep.ticket_id).in_(of_project),
                or_(
                    col(AiTicketStep.started_at) >= floor_s,
                    col(AiTicketStep.ended_at) >= floor_s,
                ),
            )
            .order_by(col(AiTicketStep.seq))
        )
    ).all()
    by_ticket: dict[str, list[AiTicketStep]] = {}
    for row in rows:
        by_ticket.setdefault(row.ticket_id, []).append(row)
    wfs = (
        await session.exec(
            select(AiTicketWorkflow).where(
                AiTicketWorkflow.project_id == project_id,
                or_(
                    col(AiTicketWorkflow.ticket_id).in_(list(by_ticket) or [""]),
                    col(AiTicketWorkflow.updated_at) >= floor_s,
                    col(AiTicketWorkflow.created_at) >= floor_s,
                ),
            )
        )
    ).all()
    for wf in wfs:
        mine = [
            r for r in by_ticket.get(wf.ticket_id, []) if r.seq >= (wf.seq_base or 0)
        ]
        for row in mine:
            who = speakers.get(row.member_id or "") or (
                BOARD if not row.member_id else _unknown(row.member_id)
            )
            items += step_row_items(row, who, row.seq)
        items += workflow_items(wf, mine, speakers)
    items += decision_items(
        list(
            (
                await session.exec(
                    select(AiDecision).where(
                        AiDecision.project_id == project_id,
                        col(AiDecision.at) >= floor_s,
                    )
                )
            ).all()
        ),
        speakers,
    )

    items = [i for i in items if i.at >= _ms(floor) and sc.has(i.ticket_id)]
    items.sort(key=lambda i: (i.at, i.order, i.id))

    if cur is None:
        out = items[-limit:]
        new_t = max([i.at for i in items], default=_ms(now))
        new_seen = {
            _h(i.id) for i in items if i.at >= new_t - timedelta(seconds=GRACE_S)
        }
    else:
        fresh = [i for i in items if _h(i.id) not in seen]
        out = fresh[:limit]
        new_t = max([t, *(i.at for i in out)])
        known = seen | {_h(i.id) for i in out}
        window = new_t - timedelta(seconds=GRACE_S)
        new_seen = {_h(i.id) for i in items if i.at >= window and _h(i.id) in known}

    stories, titles = await scope.index(session, project_id)
    working = sorted({r.member_id for r in runs if r.state in WORKING})
    return {
        "items": [i.out(titles, stories) for i in out],
        "cursor": encode_cursor(new_t, list(new_seen)),
        "working": working,
        "more": cur is not None and len(fresh) > limit,
        "scope": sc.out(),
        "needs_you": await needs_you_in(session, project_id, sc, stories, titles, now),
    }


async def needs_you_in(
    session: AsyncSession,
    project_id: str,
    sc: scope.Scope,
    stories: dict[str, str],
    titles: dict[str, str],
    now: datetime,
) -> list[dict]:
    """The Now tab's Needs you rows (team.needs_you) that belong to the scope, pinned on top of the column (K)."""
    from types import SimpleNamespace

    from . import members as svc_members
    from . import team

    # the column polls every 2 s: the list is worked out at most once per NEEDS_TTL_S for the same project and tickets
    key = (project_id, hash(tuple(sorted(titles.items()))))
    cached = _NEEDS_CACHE.get(key)
    if cached and (now - cached[0]).total_seconds() < NEEDS_TTL_S:
        return _in_scope(cached[1], sc, stories)
    members = await svc_members.list_members(session, project_id)
    active = list(
        (
            await session.exec(
                select(AiRun).where(
                    AiRun.project_id == project_id, col(AiRun.state).in_(ACTIVE)
                )
            )
        ).all()
    )
    # needs_you reads only the titles of the tickets
    tickets = {tid: SimpleNamespace(title=t) for tid, t in titles.items()}
    rows = await team.needs_you(session, project_id, members, active, tickets, now)  # type: ignore[arg-type]
    if len(_NEEDS_CACHE) > 64:
        _NEEDS_CACHE.clear()
    _NEEDS_CACHE[key] = (now, rows)
    return _in_scope(rows, sc, stories)


NEEDS_TTL_S = 5
_NEEDS_CACHE: dict[tuple, tuple[datetime, list[dict]]] = {}


def _in_scope(rows: list[dict], sc: scope.Scope, stories: dict[str, str]) -> list[dict]:
    out = []
    for row in rows:
        keys = {
            row.get("ticket_id"),
            row.get("blocks"),
            *(row.get("tickets_waiting") or []),
        }
        if sc.ids is not None and not (keys & sc.ids):
            continue
        out.append({**row, "story_id": stories.get(row.get("ticket_id") or "")})
    return out
