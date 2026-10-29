"""Docs search: an FTS5 index (title > headings > body) with a LIKE-style fallback.

The index is a plain FTS5 table, ``docs_fts``, kept in step synchronously by the docs
service (publish, rename, delete, restore, purge, import). Query syntax: words are ANDed,
``"a phrase"`` must match as written, ``-word`` excludes. User input never reaches FTS5
unquoted, so odd characters cannot raise syntax errors; when FTS5 is missing (or a MATCH
still fails) the same query is evaluated in Python over the pages.
"""

import html
import re
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from rapidfuzz import fuzz, process
from sqlalchemy import bindparam, text
from sqlalchemy.exc import DBAPIError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsDraft, DocsLink, DocsPage, DocsVersion, Project, Ticket
from services.docs_text import (
    _FENCE,
    _HEADING,
    DocsError,
    _strip_inline,
    strip_block_prefix,
    heading_anchors,
)

CREATE_FTS = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5("
    "page_id UNINDEXED, project_id UNINDEXED, title, headings, body, "
    "tokenize = 'unicode61 remove_diacritics 2')"
)
MAX_TERMS = 12
MAX_QUERY = 300
_fts_broken = False


# ---------------------------------------------------------------------------
# Index maintenance
# ---------------------------------------------------------------------------


def index_fields(title: str, markdown: str) -> tuple[str, str, str]:
    """Return the three columns indexed for a page.

    Args:
        title: Page title.
        markdown: Page content.

    Returns:
        `(title, headings, body)`.
    """
    headings = "\n".join(h["text"] for h in heading_anchors(markdown))
    return title, headings, markdown


def create_fts_sync(conn: Any) -> bool:
    """Create the FTS table on a sync connection (migrations). False when FTS5 is unavailable."""
    try:
        conn.execute(text(CREATE_FTS))
    except DBAPIError:
        return False
    return True


def backfill_sync(conn: Any) -> None:
    """Index every live page from its latest version (or, if never published, its draft)."""
    rows = conn.execute(
        text(
            "SELECT p.id, p.project_id, p.title, "
            "COALESCE((SELECT v.markdown FROM docs_version v WHERE v.page_id = p.id "
            "AND v.version = p.version), "
            "(SELECT d.markdown FROM docs_draft d WHERE d.page_id = p.id LIMIT 1), '') "
            "FROM docs_page p WHERE p.deleted_at IS NULL"
        )
    ).all()
    conn.execute(text("DELETE FROM docs_fts"))
    for pid, project_id, title, markdown in rows:
        t, h, b = index_fields(title, markdown or "")
        conn.execute(
            text(
                "INSERT INTO docs_fts (page_id, project_id, title, headings, body) "
                "VALUES (:p, :j, :t, :h, :b)"
            ),
            {"p": pid, "j": project_id, "t": t, "h": h, "b": b},
        )


async def _exec(session: AsyncSession, stmt: Any, params: dict | None = None) -> Any:
    conn = await session.connection()
    return await conn.execute(stmt, params or {})


async def ensure_fts(session: AsyncSession) -> bool:
    """Create ``docs_fts`` on first use (databases built without migrations) and report availability."""
    global _fts_broken
    if _fts_broken:
        return False
    try:
        conn = await session.connection()
        if conn.dialect.name != "sqlite":
            return False
        exists = (
            await _exec(
                session, text("SELECT 1 FROM sqlite_master WHERE name = 'docs_fts'")
            )
        ).first()
        if exists:
            return True
        await _exec(session, text(CREATE_FTS))
    except DBAPIError:
        _fts_broken = True
        return False
    await rebuild_index(session)
    return True


async def _contents(session: AsyncSession, pages: list[DocsPage]) -> dict[str, str]:
    """Markdown per page: the latest published version, else the oldest draft."""
    ids = [p.id for p in pages]
    if not ids:
        return {}
    out: dict[str, str] = {}
    rows = await _exec(
        session,
        select(DocsVersion.page_id, DocsVersion.markdown)
        .join(
            DocsPage,
            (DocsVersion.page_id == DocsPage.id)
            & (DocsVersion.version == DocsPage.version),
        )
        .where(DocsVersion.page_id.in_(ids)),  # type: ignore[attr-defined]
    )
    for pid, markdown in rows.all():
        out[pid] = markdown
    missing = [i for i in ids if i not in out]
    if missing:
        drafts = await _exec(
            session,
            select(DocsDraft.page_id, DocsDraft.markdown)
            .where(DocsDraft.page_id.in_(missing))  # type: ignore[attr-defined]
            .order_by(DocsDraft.updated_at),  # type: ignore[arg-type]
        )
        for pid, markdown in drafts.all():
            out.setdefault(pid, markdown)
    return out


async def reindex(session: AsyncSession, page_ids: list[str]) -> None:
    """(Re)write the index rows of these pages; deleted or missing pages are removed."""
    if not page_ids or not await ensure_fts(session):
        return
    pages = []
    for pid in page_ids:
        page = await session.get(DocsPage, pid)
        if page is not None and not page.deleted_at:
            pages.append(page)
    await unindex(session, page_ids)
    contents = await _contents(session, pages)
    for page in pages:
        t, h, b = index_fields(page.title, contents.get(page.id, ""))
        await _exec(
            session,
            text(
                "INSERT INTO docs_fts (page_id, project_id, title, headings, body) "
                "VALUES (:p, :j, :t, :h, :b)"
            ),
            {"p": page.id, "j": page.project_id, "t": t, "h": h, "b": b},
        )


async def unindex(session: AsyncSession, page_ids: list[str]) -> None:
    """Remove pages from the search index."""
    if not page_ids or not await ensure_fts(session):
        return
    stmt = text("DELETE FROM docs_fts WHERE page_id IN :ids").bindparams(
        bindparam("ids", expanding=True)
    )
    await _exec(session, stmt, {"ids": list(page_ids)})


async def rebuild_index(session: AsyncSession) -> None:
    """Re-create every index row from the pages table."""
    await _exec(session, text("DELETE FROM docs_fts"))
    result = await session.exec(select(DocsPage).where(DocsPage.deleted_at.is_(None)))  # type: ignore[union-attr]
    pages = list(result.all())
    contents = await _contents(session, pages)
    for page in pages:
        t, h, b = index_fields(page.title, contents.get(page.id, ""))
        await _exec(
            session,
            text(
                "INSERT INTO docs_fts (page_id, project_id, title, headings, body) "
                "VALUES (:p, :j, :t, :h, :b)"
            ),
            {"p": page.id, "j": page.project_id, "t": t, "h": h, "b": b},
        )


# ---------------------------------------------------------------------------
# Query parsing
# ---------------------------------------------------------------------------


def _trim_nonword(text: str) -> str:
    """Strip leading / trailing non-word characters (linear; ``^\W+|\W+$`` is quadratic)."""
    start, end = 0, len(text)
    while start < end and not (text[start].isalnum() or text[start] == "_"):
        start += 1
    while end > start and not (text[end - 1].isalnum() or text[end - 1] == "_"):
        end -= 1
    return text[start:end]


_TOKEN = re.compile(r'-?"[^"]*"|\S+')


class Query:
    """Parsed search query: words, quoted phrases and `-excluded` terms."""

    def __init__(self, q: str) -> None:
        """Tokenize `q` (truncated to the maximum length)."""
        self.words: list[str] = []
        self.phrases: list[str] = []
        self.excludes: list[str] = []
        for tok in _TOKEN.findall(q[:MAX_QUERY]):
            neg = tok.startswith("-") and len(tok) > 1
            body = tok[1:] if neg else tok
            if body.startswith('"'):
                kind = "phrase"
                body = body.strip('"')
            else:
                kind = "word"
            body = _trim_nonword(body)
            body = " ".join(body.split())
            if not re.search(r"\w", body, flags=re.UNICODE):
                continue
            if neg:
                self.excludes.append(body)
            elif kind == "phrase":
                self.phrases.append(body)
            else:
                self.words.append(body)
        self.words = self.words[:MAX_TERMS]

    @property
    def positive(self) -> list[str]:
        """Return the terms that must match (words and phrases)."""
        return self.words + self.phrases

    def fts(self) -> str:
        """Build the FTS5 MATCH expression for this query."""

        def quote(s: str) -> str:
            return '"' + s.replace('"', '""') + '"'

        pos = [quote(w) + "*" for w in self.words] + [quote(p) for p in self.phrases]
        expr = " AND ".join(pos)
        if self.excludes:
            expr = f"({expr}) NOT ({' OR '.join(quote(e) for e in self.excludes)})"
        return expr


def _contains(haystack: str, needle: str) -> bool:
    return needle.casefold() in haystack.casefold()


def _passes(query: Query, *fields: str) -> bool:
    blob = "\n".join(fields)
    return all(_contains(blob, t) for t in query.positive) and not any(
        _contains(blob, e) for e in query.excludes
    )


# ---------------------------------------------------------------------------
# Snippets
# ---------------------------------------------------------------------------


def highlight(plain: str, terms: list[str]) -> str:
    """HTML-escape text and wrap occurrences of the terms in `<mark>`.

    Args:
        plain: Plain text to escape and mark.
        terms: Terms to highlight, case-insensitive.

    Returns:
        Safe HTML.
    """
    terms = sorted({t for t in terms if t}, key=len, reverse=True)
    if not terms:
        return html.escape(plain)
    rx = re.compile("|".join(re.escape(t) for t in terms), re.IGNORECASE)
    out, last = [], 0
    for m in rx.finditer(plain):
        out.append(html.escape(plain[last : m.start()]))
        out.append(f"<mark>{html.escape(m.group(0))}</mark>")
        last = m.end()
    out.append(html.escape(plain[last:]))
    return "".join(out)


def _window(plain: str, terms: list[str], width: int = 150) -> str:
    low = plain.casefold()
    pos = min((p for p in (low.find(t.casefold()) for t in terms) if p >= 0), default=0)
    start = max(0, pos - width // 3)
    end = min(len(plain), start + width)
    chunk = plain[start:end].strip()
    return ("… " if start > 0 else "") + chunk + (" …" if end < len(plain) else "")


def _plain_line(raw: str) -> str:
    return _strip_inline(strip_block_prefix(raw, headings=True))


def build_matches(
    markdown: str, terms: list[str], *, headings_only: bool = False, limit: int = 3
) -> list[dict[str, Any]]:
    """Return the sections whose text contains a term, each with a marked snippet.

    Args:
        markdown: Page content to scan.
        terms: Terms to look for.
        headings_only: Match only heading text.
        limit: Maximum number of sections returned.

    Returns:
        Matches, each with its section and a snippet in safe HTML.
    """
    anchors = heading_anchors(markdown)
    section: dict[str, Any] | None = None
    idx = 0
    in_fence = False
    seen: set[str | None] = set()
    out: list[dict[str, Any]] = []
    for raw in markdown.splitlines():
        if _FENCE.match(raw):
            in_fence = not in_fence
            continue
        is_heading = False
        if not in_fence and _HEADING.match(raw):
            is_heading = True
            if idx < len(anchors):
                section = anchors[idx]
                idx += 1
        if headings_only and not is_heading:
            continue
        plain = _plain_line(raw)
        if not plain or not any(_contains(plain, t) for t in terms):
            continue
        key = section["slug"] if section else None
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "section": section["text"] if section else None,
                "slug": key,
                "snippet": highlight(_window(plain, terms), terms),
            }
        )
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def _parse_since(value: str) -> str:
    value = value.strip()
    m = re.fullmatch(r"(\d{1,4})d", value)
    if m:
        return (datetime.now(UTC) - timedelta(days=int(m.group(1)))).isoformat()
    try:
        datetime.fromisoformat(value)
    except ValueError as exc:
        raise DocsError(
            422, "bad_filter", "edited_since must be a date (2026-01-31) or like '7d'"
        ) from exc
    return value


async def _fts_candidates(
    session: AsyncSession, query: Query, project_ids: list[str], headings_only: bool
) -> dict[str, float] | None:
    """page_id -> score from FTS5, or None when FTS5 is unavailable or the MATCH failed."""
    if not await ensure_fts(session):
        return None
    expr = query.fts()
    if headings_only:
        expr = f"headings : ({expr})"
    stmt = text(
        "SELECT docs_fts.page_id, bm25(docs_fts, 0.0, 0.0, 10.0, 5.0, 1.0) "
        "FROM docs_fts JOIN docs_page p ON p.id = docs_fts.page_id "
        "WHERE docs_fts MATCH :q AND p.deleted_at IS NULL AND p.project_id IN :ids"
    ).bindparams(bindparam("ids", expanding=True))
    try:
        rows = (await _exec(session, stmt, {"q": expr, "ids": project_ids})).all()
    except DBAPIError:
        return None
    return {pid: -float(rank) for pid, rank in rows}


async def _fallback_candidates(
    session: AsyncSession,
    query: Query,
    pages: list[DocsPage],
    contents: dict[str, str],
    headings_only: bool,
) -> dict[str, float]:
    out: dict[str, float] = {}
    for p in pages:
        md = contents.get(p.id, "")
        heads = "\n".join(h["text"] for h in heading_anchors(md))
        if headings_only:
            if not _passes(query, heads):
                continue
            out[p.id] = 5.0
            continue
        if not _passes(query, p.title, heads, md):
            continue
        score = 0.0
        for t in query.positive:
            score += 10.0 * _contains(p.title, t) + 5.0 * _contains(heads, t)
            score += min(md.casefold().count(t.casefold()), 10) * 0.1
        out[p.id] = score
    return out


def _path_titles(page: DocsPage, by_id: dict[str, DocsPage]) -> list[str]:
    titles: list[str] = []
    cur, seen = page, {page.id}
    while cur.parent_id and cur.parent_id in by_id and cur.parent_id not in seen:
        cur = by_id[cur.parent_id]
        seen.add(cur.id)
        titles.insert(0, cur.title)
    return titles


def _root_of(page: DocsPage, by_id: dict[str, DocsPage]) -> DocsPage:
    cur, seen = page, {page.id}
    while cur.parent_id and cur.parent_id in by_id and cur.parent_id not in seen:
        cur = by_id[cur.parent_id]
        seen.add(cur.id)
    return cur


def _is_under(page: DocsPage, ancestor_id: str, by_id: dict[str, DocsPage]) -> bool:
    cur, seen = page, set()
    while cur is not None and cur.id not in seen:
        if cur.id == ancestor_id:
            return True
        seen.add(cur.id)
        cur = by_id.get(cur.parent_id) if cur.parent_id else None  # type: ignore[assignment]
    return False


async def _search_tickets(
    session: AsyncSession, query: Query, project_ids: list[str] | None
) -> list[dict[str, Any]]:
    stmt = select(Ticket)
    if project_ids is not None:
        stmt = stmt.where(Ticket.project_id.in_(project_ids))  # type: ignore[attr-defined]
    scored: list[tuple[float, Ticket]] = []
    for t in (await session.exec(stmt)).all():
        desc = t.description or ""
        if not _passes(query, t.id, t.title, desc):
            continue
        score = sum(
            10.0 * (_contains(t.title, w) or _contains(t.id, w)) + _contains(desc, w)
            for w in query.positive
        )
        scored.append((score, t))
    scored.sort(key=lambda s: (-s[0], s[1].id))
    out = []
    for _score, t in scored:
        desc_plain = _plain_line(" ".join((t.description or "").split()))
        hit_in_desc = any(_contains(desc_plain, w) for w in query.positive)
        source = desc_plain if hit_in_desc else t.title
        out.append(
            {
                "ticket_id": t.id,
                "title": t.title,
                "status": t.status,
                "snippet": highlight(_window(source, query.positive), query.positive),
            }
        )
    return out


async def _suggest(
    session: AsyncSession, query: Query, pages: list[DocsPage]
) -> str | None:
    vocab: set[str] = set()
    for p in pages:
        vocab.update(w for w in re.findall(r"\w{3,}", p.title.casefold()))
    if not vocab or not query.words:
        return None
    changed = False
    fixed: list[str] = []
    for w in query.words:
        if w.casefold() in vocab:
            fixed.append(w)
            continue
        best = process.extractOne(
            w.casefold(), vocab, scorer=fuzz.ratio, score_cutoff=70
        )
        if best:
            fixed.append(best[0])
            changed = True
        else:
            fixed.append(w)
    return " ".join(fixed + [f'"{p}"' for p in query.phrases]) if changed else None


async def search(
    session: AsyncSession,
    project_id: str,
    q: str,
    *,
    scope: str = "space",
    limit: int = 20,
    offset: int = 0,
    page_id: str | None = None,
    mode: str | None = None,
    author: str | None = None,
    edited_since: str | None = None,
    under_page: str | None = None,
    has_tickets: bool | None = None,
    status: str | None = None,
    sort: str = "relevance",
) -> dict[str, Any]:
    """Search pages and/or tickets by scope, with filters, sorting and paging.

    Args:
        project_id: Project to search.
        q: Query; supports `"phrases"` and `-excluded` terms.
        scope: "space" (pages), "tickets" or "all".
        limit: Page size.
        offset: Results to skip.
        page_id: Search inside this page only (find-in-page).
        mode: "headings" to match headings only.
        author: Only pages last edited by this author.
        edited_since: Only pages edited after this ISO time.
        under_page: Only this page's sub-tree.
        has_tickets: Only pages that do (or do not) reference tickets.
        status: Only tickets in this status.
        sort: "relevance" or "edited_at".

    Returns:
        Pages, tickets, totals and timing.

    Raises:
        DocsError: 422 for an invalid `scope`, `sort` or `mode`.
    """
    started = time.perf_counter()
    if scope not in {"space", "all", "tickets"}:
        raise DocsError(422, "bad_scope", "scope must be space, all or tickets")
    if sort not in {"relevance", "edited_at"}:
        raise DocsError(422, "bad_sort", "sort must be relevance or edited_at")
    if mode not in (None, "", "headings", "all"):
        raise DocsError(422, "bad_mode", "mode must be headings or omitted")
    since = _parse_since(edited_since) if edited_since else None
    headings_only = mode == "headings"
    if headings_only:
        q = q.lstrip().lstrip("#")
    query = Query(q or "")
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    empty = {
        "total": 0,
        "took_ms": 0,
        "pages": [],
        "tickets": [],
        "suggestion": None,
        "facets": {"authors": [], "under": [], "status": [], "has_tickets": 0},
    }
    if not query.positive:
        return empty

    project_ids = [project_id]
    projects: dict[str, Project] = {}
    if scope == "all":
        rows = await session.exec(select(Project).where(Project.docs_enabled.is_(True)))  # type: ignore[attr-defined]
        projects = {p.id: p for p in rows.all()}
        project_ids = list(projects) or [project_id]
    own = await session.get(Project, project_id)
    if own is not None:
        projects[own.id] = own
    ticket_pool = None if scope == "all" else [project_id]

    pages: list[DocsPage] = []
    by_id: dict[str, DocsPage] = {}
    result = await session.exec(
        select(DocsPage).where(
            DocsPage.project_id.in_(project_ids),  # type: ignore[attr-defined]
            DocsPage.deleted_at.is_(None),  # type: ignore[union-attr]
        )
    )
    pages = list(result.all())
    by_id = {p.id: p for p in pages}

    ticket_hits = await _search_tickets(session, query, ticket_pool)
    if scope == "tickets":
        took = int((time.perf_counter() - started) * 1000)
        return {
            **empty,
            "total": len(ticket_hits),
            "took_ms": took,
            "tickets": ticket_hits[offset : offset + limit],
            "suggestion": None,
        }

    scores = await _fts_candidates(session, query, project_ids, headings_only)
    contents: dict[str, str] = {}
    if scores is None:
        contents = await _contents(session, pages)
        scores = await _fallback_candidates(
            session, query, pages, contents, headings_only
        )
    # FTS prefix-matches words; keep only pages that really hold every phrase/word as written
    scores = {pid: s for pid, s in scores.items() if pid in by_id}
    candidates = [by_id[pid] for pid in scores]

    # facets are counted over everything the query matches, before the filters narrow it
    authors: dict[str, int] = {}
    unders: dict[str, int] = {}
    statuses: dict[str, int] = {}
    for p in candidates:
        authors[p.updated_by] = authors.get(p.updated_by, 0) + 1
        statuses[p.status] = statuses.get(p.status, 0) + 1
        root = _root_of(p, by_id)
        unders[root.id] = unders.get(root.id, 0) + 1
    ticket_linked: set[str] = set()
    if candidates:
        rows = await session.exec(
            select(DocsLink.source_page_id).where(
                DocsLink.source_page_id.in_([p.id for p in candidates]),  # type: ignore[attr-defined]
                DocsLink.target_ticket_id.is_not(None),  # type: ignore[union-attr]
            )
        )
        ticket_linked = set(rows.all())

    scope_root = under_page or page_id
    filtered = []
    for p in candidates:
        if author and p.updated_by != author:
            continue
        if since and p.updated_at < since:
            continue
        if status and p.status != status:
            continue
        if has_tickets is not None and (p.id in ticket_linked) != has_tickets:
            continue
        if scope_root and not _is_under(p, scope_root, by_id):
            continue
        filtered.append(p)
    if sort == "edited_at":
        filtered.sort(key=lambda p: p.updated_at, reverse=True)
    else:
        filtered.sort(key=lambda p: (-scores[p.id], p.title.casefold()))

    window = filtered[offset : offset + limit]
    if not contents:
        contents = await _contents(session, window)
    out_pages = []
    for p in window:
        out_pages.append(
            {
                "page_id": p.id,
                "project_id": p.project_id,
                "project_name": projects[p.project_id].name
                if p.project_id in projects
                else "",
                "title": p.title,
                "title_snippet": highlight(p.title, query.positive),
                "path": _path_titles(p, by_id),
                "status": p.status,
                "version": p.version,
                "updated_at": p.updated_at,
                "updated_by": p.updated_by,
                "matches": build_matches(
                    contents.get(p.id, ""), query.positive, headings_only=headings_only
                ),
            }
        )
    suggestion = None
    if not filtered and not ticket_hits:
        suggestion = await _suggest(session, query, pages)
    under_facet = [
        {"page_id": rid, "title": by_id[rid].title, "count": n}
        for rid, n in sorted(
            unders.items(), key=lambda kv: (-kv[1], by_id[kv[0]].title)
        )[:8]
    ]
    return {
        "total": len(filtered),
        "took_ms": int((time.perf_counter() - started) * 1000),
        "pages": out_pages,
        "tickets": ticket_hits[:5],
        "suggestion": suggestion,
        "facets": {
            "authors": [
                {"name": n, "count": c}
                for n, c in sorted(authors.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
            "under": under_facet,
            "status": [
                {"name": n, "count": c}
                for n, c in sorted(statuses.items(), key=lambda kv: kv[0])
            ],
            "has_tickets": len(ticket_linked),
        },
    }


async def similar(
    session: AsyncSession, project_id: str, slug: str
) -> list[dict[str, Any]]:
    """Suggest up to 4 pages whose slug or title resembles a slug (for the "page not found" screen).

    Args:
        project_id: Project to search.
        slug: Slug or path that was not found.

    Returns:
        Matching pages, best first.
    """
    needle = slug.strip().strip("/").split("/")[-1].replace("-", " ").replace("_", " ")
    if not needle:
        return []
    result = await session.exec(
        select(DocsPage).where(
            DocsPage.project_id == project_id, DocsPage.deleted_at.is_(None)
        )  # type: ignore[union-attr]
    )
    pages = list(result.all())
    by_id = {p.id: p for p in pages}
    scored = []
    for p in pages:
        s = max(
            fuzz.WRatio(needle.casefold(), p.slug.replace("-", " ").casefold()),
            fuzz.WRatio(needle.casefold(), p.title.casefold()),
        )
        if s >= 60:
            scored.append((s, p))
    scored.sort(key=lambda sp: (-sp[0], sp[1].title))
    return [
        {"page_id": p.id, "title": p.title, "path": _path_titles(p, by_id)}
        for _s, p in scored[:4]
    ]
