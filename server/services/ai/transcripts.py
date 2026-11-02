"""The board's own copy of every CLI run (design/screens/ai-operations.md, F and G).

Claude Code deletes its session files after about 30 days, so "why did it do that" would have no answer for last
month's tickets. While a run's CLI works, every line it prints is appended to ``<data>/ai-runs/<yyyy-mm>/<run>.jsonl``
next to what the board sent it (the system prompt, the prompt, a note it was given) and the board's own notes
(restarts, diagnoses, messages a person sent). When the run ends the file is compressed and indexed for search.

- Secrets are masked before anything is written (``secrets.redact``), the run's MCP token included.
- One string is kept up to ``MAX_TEXT`` characters; a long tool output is cut and says so.
- The summary of a run (``AiRun``) is kept forever; the transcript for the notification retention (90 days by
  default, one setting), unless the run is pinned.
- The search index ``ai_run_fts`` holds the summary, the question and answer, what the AI said, tool names, commands,
  file paths and errors.
"""

import asyncio
import gzip
import json
import logging
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlmodel import col, select

import database
from models import AiRun, AiRunTranscript, AiSkillUse

from .secrets import redact

logger = logging.getLogger(__name__)

MAX_TEXT = 64_000  # characters of one string inside one event
MAX_INDEX = 200_000  # characters of a run's search document
SUBAGENT_TOOLS = ("Task", "Agent")

CREATE_FTS = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS ai_run_fts USING fts5("
    "run_id UNINDEXED, project_id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2')"
)
_fts_broken = False


def root() -> Path:
    """Where transcripts live: ``KANBAN_AI_RUNS_DIR``, else ``ai-runs`` beside the database."""
    configured = os.environ.get("KANBAN_AI_RUNS_DIR")
    base = Path(configured) if configured else database.get_db_path().parent / "ai-runs"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _now() -> str:
    return datetime.now(UTC).isoformat()


def content_of(event) -> list | str | None:
    """The ``message.content`` of a stream event, or None. A CLI may print an event whose ``message`` is plain text
    (or none at all): every reader goes through here, so such an event is skipped, never a crash."""
    if not isinstance(event, dict):
        return None
    message = event.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    return content if isinstance(content, (list, str)) else None


def blocks_of(event) -> list[dict]:
    """The content blocks of a stream event (dicts only), [] when it has none."""
    content = content_of(event)
    if not isinstance(content, list):
        return []
    return [b for b in content if isinstance(b, dict)]


def _mask(value):
    """Redact every string of a JSON value and cut very long ones."""
    if isinstance(value, str):
        out = redact(value)
        if len(out) > MAX_TEXT:
            out = f"{out[:MAX_TEXT]}\n… [{len(out) - MAX_TEXT:,} more characters not kept]"
        return out
    if isinstance(value, list):
        return [_mask(v) for v in value]
    if isinstance(value, dict):
        return {k: _mask(v) for k, v in value.items()}
    return value


class _Open:
    """A transcript being written: the file stays open for the run's lifetime (restarts append to it)."""

    def __init__(self, path: Path):
        self.path = path
        self.fh = open(path, "a", encoding="utf-8")  # noqa: SIM115 - closed in finish()
        self.events = 0
        self.skills: list[tuple[str, str]] = []  # (kind, name)

    def write(self, record: dict) -> None:
        self.fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        self.fh.flush()
        self.events += 1


_OPEN: dict[str, _Open] = {}


def _path_for(run_id: str, started: str | None = None) -> Path:
    month = (started or _now())[:7]
    folder = root() / month
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{run_id}.jsonl"


def _safe_args(args: list[str]) -> list[str]:
    """The command line without the prompt texts (recorded on their own) and with the MCP config's headers and env
    values masked."""
    out: list[str] = []
    skip = {"-p", "--append-system-prompt", "--system-prompt"}
    i = 0
    while i < len(args):
        a = args[i]
        if a in skip and i + 1 < len(args):
            out += [a, "<recorded above>"]
            i += 2
            continue
        if a == "--mcp-config" and i + 1 < len(args):
            try:
                cfg = json.loads(args[i + 1])
                for server in (cfg.get("mcpServers") or {}).values():
                    if not isinstance(server, dict):
                        continue
                    # headers carry tokens, and an env carries whatever the server needs (an API key, a
                    # DATABASE_URL with its password): the names are kept, never a value
                    for part in ("headers", "env"):
                        if isinstance(server.get(part), dict) and server[part]:
                            server[part] = dict.fromkeys(server[part], "••••••••")
                out += [a, json.dumps(cfg)]
            except ValueError:
                out += [a, "<mcp config>"]
            i += 2
            continue
        out.append(a)
        i += 1
    return [redact(x) for x in out]


async def begin(
    run_id: str,
    *,
    project_id: str,
    member_id: str,
    system: str | None,
    prompt: str | None,
    args: list[str] | None = None,
    resume: bool = False,
    session_id: str | None = None,
    note: str | None = None,
    started_at: str | None = None,
) -> None:
    """Open (or reopen, after a restart inside the run) a run's transcript and record what the board sent the CLI.
    A transcript that was finished stays as it is."""
    try:
        opened = _OPEN.get(run_id)
        if opened is None:
            async with database.async_session() as session:
                row = await session.get(AiRunTranscript, run_id)
                if row is None:
                    path = _path_for(run_id, started_at)
                    row = AiRunTranscript(
                        run_id=run_id,
                        project_id=project_id,
                        member_id=member_id,
                        path=str(path),
                        started_at=started_at or _now(),
                    )
                    session.add(row)
                    await session.commit()
                if row.ended_at or _existing(Path(row.path)).suffix == ".gz":
                    # an ended run is never reopened (a retry is a new run): a late start for it, after a cancel,
                    # must not reopen the finished, compressed and indexed transcript
                    return
                path = Path(row.path)
            opened = _OPEN[run_id] = _Open(path)
        opened.write(
            {
                "t": _now(),
                "k": "sent",
                "system": _mask(system or ""),
                "prompt": _mask(prompt or ""),
                "note": _mask(note) if note else None,
                "resume": resume,
                "session_id": session_id,
                "args": _safe_args(args or []),
            }
        )
    except OSError:
        logger.exception("Could not open the transcript of run %s", run_id)


def feed(run_id: str, line: str) -> None:
    """One stdout line of the CLI. Non-JSON lines are kept as text."""
    opened = _OPEN.get(run_id)
    if opened is None:
        return
    line = line.strip()
    if not line:
        return
    try:
        event = json.loads(line) if line.startswith("{") else None
    except ValueError:
        event = None
    try:
        if event is None:
            opened.write({"t": _now(), "k": "text", "text": _mask(line)})
            return
        opened.write({"t": _now(), "k": "event", "e": _mask(event)})
        if event.get("type") == "assistant":
            for block in blocks_of(event):
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                inp = block.get("input") or {}
                if block.get("name") == "Skill" and inp.get("skill"):
                    opened.skills.append(("skill", str(inp["skill"])[:120]))
                elif block.get("name") in SUBAGENT_TOOLS:
                    name = (
                        inp.get("subagent_type")
                        or inp.get("agent")
                        or "general-purpose"
                    )
                    opened.skills.append(("subagent", str(name)[:120]))
    except OSError:
        logger.exception("Could not write the transcript of run %s", run_id)


def note(run_id: str, kind: str, text: str, **data) -> None:
    """A line the board adds itself: a restart, a diagnosis, a message a person sent, a rule that fired."""
    opened = _OPEN.get(run_id)
    if opened is None:
        return
    try:
        opened.write(
            {"t": _now(), "k": "note", "kind": kind, "text": _mask(text), **_mask(data)}
        )
    except OSError:
        logger.exception("Could not write the transcript of run %s", run_id)


def _gzip_copy(src: Path, dst: Path) -> None:
    with open(src, "rb") as raw, gzip.open(dst, "wb") as packed:
        packed.write(raw.read())


def _packed(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".gz")


def _existing(path: Path) -> Path:
    """The file a recorded path stands for: the path itself, else its compressed sibling (a finish that compressed it
    but could not record the new name)."""
    if path.suffix != ".gz" and not path.exists() and _packed(path).exists():
        return _packed(path)
    return path


def _read_lines(path: Path) -> list[dict]:
    path = _existing(path)
    opener = gzip.open if path.suffix == ".gz" else open
    out: list[dict] = []
    try:
        with opener(path, "rt", encoding="utf-8") as fh:
            for line in fh:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        return []
    return out


async def read(run_id: str) -> list[dict] | None:
    """Every record of a run's transcript, or None when the board has none (an old run, or it was deleted)."""
    async with database.async_session() as session:
        row = await session.get(AiRunTranscript, run_id)
    if row is None or row.deleted_at:
        return None
    return _read_lines(Path(row.path))


def _index_text(records: list[dict], run: AiRun | None) -> str:
    """What a search finds a run by."""
    parts: list[str] = []
    if run is not None:
        parts += [run.summary or "", run.instruction or "", run.ended_reason or ""]
        for raw in (run.question, run.answer):
            try:
                q = json.loads(raw) if raw else None
            except ValueError:
                q = raw
            if isinstance(q, dict):
                parts.append(str(q.get("text") or ""))
            elif q:
                parts.append(str(q))
        try:
            parts += [f.get("path", "") for f in json.loads(run.files or "[]")]
        except ValueError:
            pass
    for rec in records:
        if rec.get("k") == "note":
            parts.append(rec.get("text") or "")
            continue
        ev = rec.get("e") if rec.get("k") == "event" else None
        if not isinstance(ev, dict):
            continue
        content = content_of(ev)
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                parts.append(block.get("text") or "")
            elif block.get("type") == "tool_use":
                inp = block.get("input") or {}
                parts.append(block.get("name") or "")
                for key in (
                    "command",
                    "file_path",
                    "pattern",
                    "skill",
                    "subagent_type",
                    "description",
                ):
                    if inp.get(key):
                        parts.append(str(inp[key]))
            elif block.get("type") == "tool_result" and block.get("is_error"):
                body = block.get("content")
                if isinstance(body, list):
                    body = " ".join(
                        str(c.get("text", "")) for c in body if isinstance(c, dict)
                    )
                parts.append(str(body or "")[:2000])
    doc = "\n".join(p for p in parts if p)
    return doc[:MAX_INDEX]


async def _fts_ready(session) -> bool:
    global _fts_broken
    if _fts_broken:
        return False
    try:
        conn = await session.connection()
        if conn.dialect.name != "sqlite":
            return False
        await conn.execute(text(CREATE_FTS))
    except DBAPIError:
        _fts_broken = True
        return False
    return True


async def index(session, run: AiRun, records: list[dict]) -> None:
    """(Re)write a run's row in the search index."""
    if not await _fts_ready(session):
        return
    conn = await session.connection()
    await conn.execute(text("DELETE FROM ai_run_fts WHERE run_id = :r"), {"r": run.id})
    await conn.execute(
        text("INSERT INTO ai_run_fts (run_id, project_id, body) VALUES (:r, :p, :b)"),
        {"r": run.id, "p": run.project_id, "b": _index_text(records, run)},
    )


async def finish(run_id: str) -> None:
    """The run ended: close and compress its transcript, record the skills it used, index it for search. The file and
    its row are settled first and on their own: a search index that fails never leaves the row naming a file that is
    gone."""
    opened = _OPEN.pop(run_id, None)
    skills = opened.skills if opened else []
    if opened is not None:
        try:
            opened.fh.close()
        except OSError:
            pass
    try:
        async with database.async_session() as session:
            row = await session.get(AiRunTranscript, run_id)
            run = await session.get(AiRun, run_id)
            if row is None or run is None:
                return
            path = _existing(Path(row.path))
            records = _read_lines(path)
            plain = None
            if path.suffix != ".gz" and path.exists():
                packed = _packed(path)
                await asyncio.to_thread(_gzip_copy, path, packed)
                plain, path = path, packed
            row.path = str(path)
            row.bytes = path.stat().st_size if path.exists() else 0
            row.events = len(records)
            row.ended_at = _now()
            session.add(row)
            for kind, name in skills:
                plugin = name.split(":", 1)[0] if ":" in name else None
                session.add(
                    AiSkillUse(
                        run_id=run_id,
                        project_id=run.project_id,
                        member_id=run.member_id,
                        kind=kind,
                        name=name,
                        plugin=plugin,
                    )
                )
            try:
                # in a savepoint of the same commit: the run is searchable the moment it is recorded as ended, and
                # an index that fails rolls back only itself
                async with session.begin_nested():
                    await index(session, run, records)
            except Exception:  # noqa: BLE001 - search is a convenience: the transcript itself is kept
                logger.exception("Could not index the transcript of run %s", run_id)
            await session.commit()
            if plain is not None:
                plain.unlink(
                    missing_ok=True
                )  # only once the row names the compressed file
    except (OSError, DBAPIError):
        logger.exception("Could not finish the transcript of run %s", run_id)


async def pin(run_id: str, on: bool, by: str) -> AiRunTranscript | None:
    """A pinned run's transcript is kept whatever the retention."""
    async with database.async_session() as session:
        row = await session.get(AiRunTranscript, run_id)
        if row is None:
            return None
        row.pinned = on
        row.pinned_by = by if on else None
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return row


async def prune(retention_days: int, now: datetime | None = None) -> int:
    """Delete the transcripts of runs that ended more than `retention_days` ago and are not pinned. The run itself
    (its summary, steps, files and cost) stays."""
    cutoff = ((now or datetime.now(UTC)) - timedelta(days=retention_days)).isoformat()
    removed = 0
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiRunTranscript).where(
                    col(AiRunTranscript.ended_at).is_not(None),
                    col(AiRunTranscript.ended_at) < cutoff,
                    AiRunTranscript.pinned == False,  # noqa: E712
                    col(AiRunTranscript.deleted_at).is_(None),
                )
            )
        ).all()
        for row in rows:
            _existing(Path(row.path)).unlink(missing_ok=True)
            row.deleted_at = _now()
            row.bytes = 0
            session.add(row)
            removed += 1
        await session.commit()
    return removed


async def usage() -> dict:
    """How much space transcripts take: {bytes, runs, pinned}."""
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiRunTranscript).where(col(AiRunTranscript.deleted_at).is_(None))
            )
        ).all()
    return {
        "bytes": sum(r.bytes or 0 for r in rows),
        "runs": len(rows),
        "pinned": sum(1 for r in rows if r.pinned),
    }


_WORD = re.compile(r"[\w\-./]+", re.UNICODE)


def fts_query(q: str) -> str | None:
    """User words → an FTS5 query where every word must appear (each one quoted, so nothing can break the syntax)."""
    words = [w for w in _WORD.findall(q or "") if w.strip("-./")][:12]
    if not words:
        return None
    return " ".join('"' + w.replace('"', "") + '"' for w in words)


async def search_ids(
    session, q: str, limit: int = 500, project_id: str | None = None
) -> list[str] | None:
    """Run ids that match `q`, best first; None when the index cannot be used (the caller falls back). With
    `project_id` only that project's runs count, inside the query (the cap would otherwise go to other projects)."""
    query = fts_query(q)
    if query is None:
        return []
    if not await _fts_ready(session):
        return None
    conn = await session.connection()
    try:
        rows = (
            await conn.execute(
                text(
                    "SELECT run_id FROM ai_run_fts WHERE ai_run_fts MATCH :q "
                    + ("AND project_id = :p " if project_id else "")
                    + "ORDER BY rank LIMIT :n"
                ),
                {"q": query, "n": limit, **({"p": project_id} if project_id else {})},
            )
        ).all()
    except DBAPIError:
        return None
    return [r[0] for r in rows]


def snippet(records: list[dict], q: str, width: int = 160) -> str | None:
    """A short piece of the transcript around the first word of `q`, to show under a search result."""
    words = [w.lower() for w in _WORD.findall(q or "")]
    if not words:
        return None
    for rec in records:
        if rec.get("k") != "event":
            continue
        content = content_of(rec.get("e"))
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            body = block.get("text") or json.dumps(
                block.get("input") or "", ensure_ascii=False
            )
            low = body.lower()
            hit = low.find(words[0])
            if hit >= 0:
                start = max(0, hit - width // 2)
                return (
                    ("…" if start else "")
                    + body[start : start + width].replace("\n", " ")
                    + "…"
                )
    return None
