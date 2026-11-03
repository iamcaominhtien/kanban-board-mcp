"""Handoff notes (issue #272): every step of a workflow, a take-back and a hand-over from outside the board leaves one
short note of fixed form on the ticket, and whoever takes the ticket next reads it first.

A note has four fields: **Done** (what was done), **Where** (where it is: the branch, files, pages, links), **Left**
(what is left, and why) and **Check** (what the next role should check first). An AI gives it with
`ai_run(action='report', handoff={...})`, or as a `HANDOFF` block at the end of its final message; when it gives
neither, the board writes what it knows (the summary, the files changed) and says the rest was not said.

The note is a ticket comment carrying `handoff` = {done, where, left, check, step, from, to, run_id, complete}, so a
person sees it in the comments, an AI reads it with get_ticket, and the board finds the latest one to start the next
run with.
"""

import re

from models import AiRun, Ticket

from .secrets import redact
from .store import loads

FIELDS = ("done", "where", "left", "check")
LABELS = {"done": "Done", "where": "Where", "left": "Left", "check": "Check"}
NOT_SAID = "Not said."

# The form, word for word in the run's prompt, the board's evidence-and-handover skill and the MCP team guide
FORM = """\
A handoff note has four lines, one or two sentences each:
- Done: what you did (the result, not the steps you took).
- Where: where it is: the branch, the files, the Docs page, the canvas, the comment with the screenshots.
- Left: what is not done, and why ("Nothing." when nothing is).
- Check: what the next role should check first: a risk, an assumption, a decision they must follow."""

HOW = (
    "End your step with your handoff note: ai_run(action='report', summary=..., handoff={'done': ..., 'where': ..., "
    "'left': ..., 'check': ...}); without that tool, end your final message with a line `HANDOFF` and the four lines "
    "`Done: …`, `Where: …`, `Left: …`, `Check: …`. The board posts it on the ticket and the next role reads it first."
)

_HEAD = re.compile(r"^\s*[#*>\-\s]*hand[\s-]?off(\s+note)?\s*[*:]*\s*$", re.IGNORECASE)
_LINE = re.compile(
    r"^\s*[-*>]?\s*\**\s*(done|where|left|check)\s*\**\s*:\s*\**\s*(.*)$", re.IGNORECASE
)
_OTHER_KEY = re.compile(
    r"^\s*[A-Z][A-Z_ ]{2,}:"
)  # VERDICT:, DEPTH:, WORKFLOW: … end a field
MAX_FIELD = 600


def clean(raw) -> dict | None:
    """The four fields of a note as given (a dict), trimmed and redacted; None when none is filled."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for key in FIELDS:
        value = raw.get(key)
        if value is None:
            value = raw.get(LABELS[key])
        out[key] = redact(" ".join(str(value or "").split()))[:MAX_FIELD]
    return out if any(out.values()) else None


def parse(text: str | None) -> dict | None:
    """The `HANDOFF` block of a final message: the last line `HANDOFF` and the `Done:`/`Where:`/`Left:`/`Check:` lines
    after it (a field may run on over several lines)."""
    if not text:
        return None
    lines = text.splitlines()
    start = next(
        (i for i in range(len(lines) - 1, -1, -1) if _HEAD.match(lines[i])), None
    )
    if start is None:
        return None
    out: dict[str, str] = {}
    key = None
    for line in lines[start + 1 :]:
        m = _LINE.match(line)
        if m:
            key = m.group(1).lower()
            out[key] = m.group(2).strip().rstrip("*").strip()
            continue
        if not line.strip():
            continue
        if _OTHER_KEY.match(line):
            key = None
            continue
        if key:
            out[key] = f"{out[key]} {line.strip()}".strip()
    return clean(out)


def _first_paragraph(text: str) -> str:
    for part in re.split(r"\n\s*\n", text or ""):
        if part.strip() and not _HEAD.match(part.strip().splitlines()[0]):
            return " ".join(part.split())
    return ""


def _where(run: AiRun, ticket: Ticket | None) -> str:
    parts = []
    branches = (
        [
            b.get("name")
            for b in loads(ticket.branches, [])
            if isinstance(b, dict) and b.get("name")
        ]
        if ticket
        else []
    )
    if branches:
        parts.append("Branch " + ", ".join(f"`{b}`" for b in branches[:3]))
    files = [
        f.get("path")
        for f in loads(run.files, [])
        if isinstance(f, dict) and f.get("path")
    ]
    if files:
        more = f" and {len(files) - 12} more" if len(files) > 12 else ""
        parts.append("files changed: " + ", ".join(f"`{p}`" for p in files[:12]) + more)
    return "; ".join(parts)


def fallback(run: AiRun, ticket: Ticket | None = None) -> dict:
    """What the board can say when the AI left no note: its summary and where its changes are; the rest not said."""
    report = loads(run.report, {}) or {}
    done = (
        report.get("summary")
        or run.summary
        or _first_paragraph(report.get("final") or "")
    )
    return {
        "done": redact(" ".join(str(done or "").split()))[:MAX_FIELD] or NOT_SAID,
        "where": _where(run, ticket) or NOT_SAID,
        "left": NOT_SAID,
        "check": NOT_SAID,
    }


def of_run(run: AiRun, text: str, ticket: Ticket | None = None) -> tuple[dict, bool]:
    """The run's note and whether the AI wrote it: its report's `handoff`, else the HANDOFF block of what it said, else
    the board's fallback (False)."""
    given = clean((loads(run.report, {}) or {}).get("handoff")) or parse(text)
    if given:
        for key in FIELDS:
            given[key] = given[key] or NOT_SAID
        return given, True
    return fallback(run, ticket), False


# a run's steps that are not work it did: its start and end, the board's notes, and refused or failed tool calls (their
# raw error text is no news for the next one)
_NOT_WORK = {
    "start",
    "end",
    "error",
    "skill",
    "context",
    "message",
    "report",
    "fresh_session",
    "retry",
    "window",
    "moved",
}


def _step_line(text: str) -> str:
    """One step in a few words: its first line, cut at 80 characters (a command may be a whole script)."""
    line = (
        " ".join(str(text).strip().splitlines()[0].split()) if str(text).strip() else ""
    )
    return line if len(line) <= 80 else line[:79] + "…"


def from_progress(run: AiRun, ticket: Ticket | None, *, by: str) -> dict:
    """A run stopped mid-way (a person took the ticket back): what its steps show, where its changes are, and that the
    rest of the task is left."""
    steps = [
        _step_line(s.get("text"))
        for s in loads(run.steps, [])
        if s.get("kind") not in _NOT_WORK and s.get("text")
    ]
    report = loads(run.report, {}) or {}
    done = report.get("summary") or ("; ".join(steps[-5:]) if steps else "")
    return {
        "done": redact(" ".join(str(done or "Nothing yet.").split()))[:MAX_FIELD],
        "where": _where(run, ticket) or NOT_SAID,
        "left": f"The rest of the task: {by} took the ticket back while run #{run.number} was working.",
        "check": "Look at `git status` and the files above before you go on, and do not redo what is done.",
    }


def markdown(note: dict, *, title: str) -> str:
    """The comment's text: a title line and the four fields, readable without the board's card."""
    return f"**{title}**\n\n" + "\n".join(
        f"- **{LABELS[k]}:** {note.get(k) or NOT_SAID}" for k in FIELDS
    )


def for_prompt(note: dict, *, source: str) -> str:
    """The block a run is started with, before anything else."""
    return (
        f"Read this first: the handoff note {source}. Start from it; do not redo what it says is done.\n"
        + "\n".join(f"- {LABELS[k]}: {note.get(k) or NOT_SAID}" for k in FIELDS)
    )


def title(*, by: str, step: str | None, to: str | None) -> str:
    """The note's title line: who left it, at which step, for whom."""
    head = f"Handoff note · {step} · {by}" if step else f"Handoff note · {by}"
    return head + (f" → {to}" if to else "")


def source_of(meta: dict, author: str) -> str:
    """'BA AI left at “Shape”', in the words of the prompt."""
    return f"{author} left" + (f" at “{meta['step']}”" if meta.get("step") else "")


async def post(
    session,
    ticket_id: str,
    note: dict,
    *,
    author: str,
    step: str | None = None,
    to: str | None = None,
    run: AiRun | None = None,
    complete: bool = True,
    ai: bool = True,
) -> str | None:
    """Post the note on the ticket as a comment; returns its id."""
    from services import tickets as svc_tickets

    meta: dict = {
        "handoff": {
            **{k: note.get(k) or NOT_SAID for k in FIELDS},
            "step": step,
            "from": author,
            "to": to,
            "run_id": run.id if run else None,
            "complete": complete,
        }
    }
    if ai and run is not None:
        meta["ai"] = {
            "kind": "handoff",
            "run_id": run.id,
            "run_number": run.number,
            "metered": run.metered,
            "cost_usd": run.cost_usd,
            "model": run.model,
        }
    ticket = await svc_tickets.add_comment(
        session,
        ticket_id,
        markdown(note, title=title(by=author, step=step, to=to)),
        author=author,
        meta=meta,
    )
    if ticket is None:
        return None
    comments = loads(ticket.comments, [])
    return comments[-1]["id"] if comments else None


def latest(
    ticket: Ticket | None, *, since: str | None = None
) -> tuple[dict, str] | None:
    """The newest handoff note on the ticket (posted at or after `since`), with its author."""
    if ticket is None:
        return None
    for c in reversed(loads(ticket.comments, [])):
        if c.get("deleted_at") or not isinstance(c.get("handoff"), dict):
            continue
        if since and (c.get("at") or "") < since:
            return None
        return c["handoff"], c.get("author") or "someone"
    return None


def prompt_from_latest(
    ticket: Ticket | None, *, since: str | None = None
) -> str | None:
    """The newest note as the block a run starts with, or None."""
    found = latest(ticket, since=since)
    if not found:
        return None
    meta, author = found
    return for_prompt(meta, source=source_of(meta, author))
