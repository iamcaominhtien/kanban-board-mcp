"""Memory a run can write, and keeping the project's memory honest (issue #274).

Three layers reach a run's prompt (services/ai/knowledge.py builds the block):

- **Lessons** (project-wide, every AI): a person keeps them. An AI (the lead's report, or `knowledge(action='remember')`) or an outside agent only proposes.
- **Notes** (this module): what one role learned for itself across runs: what works in this repository, the
  commands, where things are, a person's feedback. Kept per **role** (every Dev reads the Dev notes: a second Dev must
  not pay for the first one's mistake again) or per **member** when the member has no role; and per **ticket**, so
  what one run learned about a ticket reaches the next run on it. An AI writes them itself with `knowledge(action='remember')`
  (the `keeping-memory` skill says when); they are live at once, shown to people, editable, and capped.
- **Hygiene**: a lesson or note that names a file the repository no longer has, or that a newer one says something
  close to, is flagged for a person. Nothing is dropped by the board.

Decided: notes per role (not per project: a project-wide fact is a lesson, which a person keeps; not per member: two
members of one role learn the same repository), per member only for a member without a role, and per ticket.
"""

import re
from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import col, select

from models import AiLesson, AiTeam, AiMemoryNote

from .config_model import estimate_tokens

NOTE_CHARS = 500
# the most notes one scope keeps: past it, a write is refused and the AI is told to replace or forget one, so the
# memory is curated instead of growing
MAX_NOTES = {"role": 30, "member": 30, "ticket": 15}
# tokens of notes in a run's prompt, per scope: the newest and most used first
PROMPT_TOKENS = {"role": 1200, "member": 1200, "ticket": 800}
SCOPES = ("role", "member", "ticket")
KINDS = ("learned", "feedback")


def _now() -> str:
    return datetime.now(UTC).isoformat()


def clean(text: str | None) -> str:
    """One line, trimmed to the cap."""
    return " ".join((text or "").split())[:NOTE_CHARS]


def own_scope(role: str | None, member_id: str) -> tuple[str, str]:
    """Where a member's own notes live: its role's, or its own when it has no role."""
    return ("role", role) if role else ("member", member_id)


async def notes(
    session, project_id: str, scope: str | None = None, key: str | None = None
) -> list[AiMemoryNote]:
    """A project's notes, newest first, optionally of one scope (and key)."""
    stmt = select(AiMemoryNote).where(AiMemoryNote.project_id == project_id)
    if scope:
        stmt = stmt.where(AiMemoryNote.scope == scope)
    if key is not None:
        stmt = stmt.where(AiMemoryNote.scope_key == key)
    return list(
        (await session.exec(stmt.order_by(col(AiMemoryNote.updated_at).desc()))).all()
    )


async def write(
    session,
    project_id: str,
    scope: str,
    key: str,
    text: str,
    *,
    by: str,
    kind: str = "learned",
    note_id: str | None = None,
    source_run_id: str | None = None,
    source_ticket_id: str | None = None,
) -> tuple[AiMemoryNote, str]:
    """Add a note, or replace one (``note_id``). Returns (note, "added" | "updated" | "unchanged")."""
    if scope not in SCOPES:
        raise ValueError("A note is kept by a role, a member or a ticket.")
    if not key:
        raise ValueError("Say whose note it is.")
    body = clean(text)
    if not body:
        raise ValueError("Write the note.")
    kind = kind if kind in KINDS else "learned"
    if note_id:
        row = await session.get(AiMemoryNote, note_id)
        if row is None or row.project_id != project_id:
            raise LookupError("No such note in this project.")
        row.text, row.kind, row.updated_at = body, kind, _now()
        row.written_by = by
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return row, "updated"
    rows = await notes(session, project_id, scope, key)
    same = next((r for r in rows if r.text.lower() == body.lower()), None)
    if same is not None:
        return same, "unchanged"
    if len(rows) >= MAX_NOTES[scope]:
        oldest = sorted(rows, key=lambda r: (r.uses or 0, r.updated_at))[:3]
        raise ValueError(
            f"This memory is full ({MAX_NOTES[scope]} notes). Replace one (note_id) or forget one first; the least "
            "used: " + ", ".join(f"{r.id} “{r.text[:60]}”" for r in oldest)
        )
    row = AiMemoryNote(
        project_id=project_id,
        scope=scope,
        scope_key=key,
        text=body,
        kind=kind,
        written_by=by,
        source_run_id=source_run_id,
        source_ticket_id=source_ticket_id,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row, "added"


async def forget(session, project_id: str, note_id: str) -> AiMemoryNote:
    """Remove a note."""
    row = await session.get(AiMemoryNote, note_id)
    if row is None or row.project_id != project_id:
        raise LookupError("No such note in this project.")
    await session.delete(row)
    await session.commit()
    return row


def _pick(rows: list[AiMemoryNote], cap: int) -> list[AiMemoryNote]:
    """Notes up to ``cap`` tokens: a person's feedback first, then the most used, then the newest."""
    out, used = [], 0
    ordered = sorted(
        rows,
        key=lambda r: (r.kind != "feedback", -(r.uses or 0), _neg(r.updated_at)),
    )
    for r in ordered:
        cost = estimate_tokens(r.text)
        if used + cost > cap:
            continue
        out.append(r)
        used += cost
    return out


def _neg(stamp: str | None) -> str:
    """A sort key that puts the newest ISO time first."""
    return "".join(chr(0x10FFFF - ord(ch)) for ch in (stamp or ""))


async def for_run(
    session,
    project_id: str,
    *,
    role: str | None,
    member_id: str | None,
    ticket_id: str | None,
) -> tuple[list[AiMemoryNote], list[AiMemoryNote]]:
    """(own notes, ticket notes) that go in a run's prompt."""
    own: list[AiMemoryNote] = []
    if member_id:
        scope, key = own_scope(role, member_id)
        own = _pick(await notes(session, project_id, scope, key), PROMPT_TOKENS[scope])
    on_ticket: list[AiMemoryNote] = []
    if ticket_id:
        on_ticket = _pick(
            await notes(session, project_id, "ticket", ticket_id),
            PROMPT_TOKENS["ticket"],
        )
    return own, on_ticket


async def labels(session, rows: list[AiMemoryNote]) -> dict[tuple[str, str], str]:
    """A name a person reads for each note's owner: the role's name, the member's, the ticket's key and title."""
    from models import Member, Ticket

    from . import packs

    out: dict[tuple[str, str], str] = {}
    for r in rows:
        k = (r.scope, r.scope_key)
        if k in out:
            continue
        if r.scope == "role":
            out[k] = packs.role_name(r.scope_key) or r.scope_key
        elif r.scope == "member":
            m = await session.get(Member, r.scope_key)
            out[k] = m.name if m else r.scope_key
        else:
            t = await session.get(Ticket, r.scope_key)
            out[k] = f"{r.scope_key} · {t.title}" if t else r.scope_key
    return out


def note_dict(r: AiMemoryNote) -> dict:
    """A note for the API and MCP."""
    return {
        "id": r.id,
        "scope": r.scope,
        "scope_key": r.scope_key,
        "text": r.text,
        "kind": r.kind,
        "tokens": estimate_tokens(r.text),
        "written_by": r.written_by,
        "source_run_id": r.source_run_id,
        "source_ticket_id": r.source_ticket_id,
        "uses": r.uses or 0,
        "last_used_at": r.last_used_at,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    }


# ---------------------------------------------------------------------------
# Hygiene: flag what went stale, for a person to decide
# ---------------------------------------------------------------------------

_PATH = re.compile(
    r"(?<![\w@:/.-])((?:[\w.-]+/)*[\w-]+\.(?:py|tsx?|jsx?|mjs|cjs|md|json|toml|ya?ml|css|scss|html|sql|sh|txt|cfg|ini|lock|go|rs|java|kt|rb|php|cs|swift|vue|svelte))(?![\w/])"
    r"|(?<![\w@:/.-])((?:[\w.-]+/){1,}[\w.-]*/?)(?=[\s,.;:)\"'`]|$)"
)
_WORD = re.compile(r"[a-z0-9_]{4,}")
_STOP = {
    "this",
    "that",
    "with",
    "from",
    "they",
    "them",
    "when",
    "what",
    "then",
    "than",
    "have",
    "must",
    "should",
    "into",
    "only",
    "always",
    "never",
    "does",
    "every",
    "before",
    "after",
}
_NEGATION = re.compile(
    r"\b(not|never|no longer|don't|do not|instead|stop|avoid)\b", re.I
)
SIMILAR = 0.5


def paths_in(text: str) -> list[str]:
    """File and folder paths a text names (``server/models.py``, ``ui/src/``), without URLs."""
    found = []
    for m in _PATH.finditer(text or ""):
        raw = (m.group(1) or m.group(2) or "").strip("`'\"")
        p = raw.rstrip("/.")
        if not p or "://" in p or p.startswith(("http", "www.")) or p in found:
            continue
        if "/" not in raw and "." not in p:
            continue
        found.append(p)
    return found


def _words(text: str) -> set[str]:
    return {w for w in _WORD.findall((text or "").lower()) if w not in _STOP}


def similarity(a: str, b: str) -> float:
    """Word overlap of two texts (0 to 1)."""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


async def repo_roots(session, project_id: str) -> list[Path]:
    """The folders the project's AIs work in: the worktrees' main checkout and each member's working folder."""
    from . import ops
    from .store import get_settings

    settings = await get_settings(session, project_id)
    found: list[Path] = []
    repo = (ops.get(settings).get("worktrees") or {}).get("repo")
    candidates = [repo] if repo else []
    for m in (
        await session.exec(select(AiTeam).where(AiTeam.project_id == project_id))
    ).all():
        if m.working_dir:
            candidates.append(m.working_dir)
    for c in candidates:
        p = Path(c).expanduser()
        if p.is_dir() and p not in found:
            found.append(p)
    return found


def _missing(paths: list[str], roots: list[Path]) -> list[str]:
    out = []
    for p in paths:
        rel = p.lstrip("./")
        if Path(p).is_absolute():
            if not Path(p).exists():
                out.append(p)
            continue
        if not any((r / rel).exists() for r in roots):
            out.append(p)
    return out


async def flags(session, project_id: str) -> dict[str, list[dict]]:
    """What a person should look at again: ``{lesson or note id: [{kind, text, other_id?}]}``.

    - ``missing_path``: it names a file or folder none of the project's checkouts has (moved or deleted). Only when the
      board knows where the repository is.
    - ``newer``: a newer kept lesson (or a newer note of the same scope) says something close; when one of the two
      negates ("never", "instead", "no longer"), it may contradict the older one.
    """
    out: dict[str, list[dict]] = {}
    kept = [
        r
        for r in (
            await session.exec(
                select(AiLesson).where(
                    AiLesson.project_id == project_id, AiLesson.state == "kept"
                )
            )
        ).all()
    ]
    all_notes = await notes(session, project_id)
    roots = await repo_roots(session, project_id)
    items: list[tuple[str, str, str, str]] = [
        (r.id, r.text, "lesson", r.created_at) for r in kept
    ] + [(n.id, n.text, f"{n.scope}:{n.scope_key}", n.created_at) for n in all_notes]
    if roots:
        for item_id, text, _group, _at in items:
            gone = _missing(paths_in(text), roots)
            if gone:
                out.setdefault(item_id, []).append(
                    {
                        "kind": "missing_path",
                        "text": "Names "
                        + ", ".join(f"`{g}`" for g in gone[:3])
                        + ", which the repository no longer has. Still true?",
                        "paths": gone,
                    }
                )
    by_group: dict[str, list[tuple[str, str, str]]] = {}
    for item_id, text, group, at in items:
        by_group.setdefault(group, []).append((item_id, text, at))
    for rows in by_group.values():
        rows.sort(key=lambda r: r[2])
        for i, (old_id, old_text, _at) in enumerate(rows):
            for new_id, new_text, _nat in rows[i + 1 :]:
                if similarity(old_text, new_text) < SIMILAR:
                    continue
                contradicts = bool(_NEGATION.search(old_text)) != bool(
                    _NEGATION.search(new_text)
                )
                out.setdefault(old_id, []).append(
                    {
                        "kind": "newer",
                        "other_id": new_id,
                        "text": (
                            "A newer one may contradict it: “"
                            if contradicts
                            else "A newer one says something close: “"
                        )
                        + new_text[:120]
                        + "”. Keep one.",
                    }
                )
                break
    return out
