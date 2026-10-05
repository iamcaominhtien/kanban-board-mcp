"""Docs space: a page tree per project, drafts, versions, history and references.

Pages store markdown. The title is its own field; body headings start at ``##``.
Every publish adds a ``DocsVersion`` row; a restore adds a new one rather than
rewriting history. References (``[[Page#Section|text]]`` and ticket keys) are
indexed in ``DocsLink`` when a page is published.
"""

import difflib
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsDraft, DocsLink, DocsPage, DocsVersion, Project, Ticket
from services import activity
from services.docs_templates import TEMPLATES

RECYCLE_DAYS = 30
MAX_TITLE = 200
MAX_MARKDOWN = 1_000_000


class DocsError(Exception):
    """Domain error carrying an HTTP status and a machine-readable code."""

    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ---------------------------------------------------------------------------
# Markdown helpers: slugs, headings, references
# ---------------------------------------------------------------------------

_FENCE = re.compile(r"^\s*(```|~~~)")
_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_REF = re.compile(r"\[\[([^\]\|#]+?)(?:#([^\]\|]+?))?(?:\|([^\]]+?))?\]\]")
_TICKET = re.compile(r"\b([A-Z][A-Z0-9]{1,5}-\d+)\b")
_INLINE_CODE = re.compile(r"`[^`\n]*`")


def slugify(text: str) -> str:
    """Lower-case, spaces to dashes, punctuation dropped (``Example request`` -> ``example-request``)."""
    slug = re.sub(r"[^\w\s-]", "", text.lower(), flags=re.UNICODE)
    slug = re.sub(r"[\s_]+", "-", slug.strip())
    return re.sub(r"-{2,}", "-", slug).strip("-")


def _strip_inline(text: str) -> str:
    text = re.sub(
        r"\[\[([^\]\|#]+?)(?:#[^\]\|]+?)?(?:\|([^\]]+?))?\]\]",
        lambda m: m.group(2) or m.group(1),
        text,
    )
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    return re.sub(r"[*_`~]", "", text).strip()


def heading_anchors(markdown: str) -> list[dict[str, Any]]:
    """Headings with their slug anchors; duplicates get ``-2``, ``-3``…"""
    out: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    in_fence = False
    for line in markdown.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING.match(line)
        if not m:
            continue
        text = _strip_inline(m.group(2))
        base = slugify(text) or "section"
        count = seen.get(base, 0) + 1
        seen[base] = count
        slug = base if count == 1 else f"{base}-{count}"
        out.append({"level": len(m.group(1)), "text": text, "slug": slug})
    return out


def _prose_lines(markdown: str) -> list[tuple[str, str | None, str]]:
    """(line, current section slug, raw line) for lines outside code fences."""
    anchors = {a["text"]: a["slug"] for a in heading_anchors(markdown)}
    section: str | None = None
    in_fence = False
    out: list[tuple[str, str | None, str]] = []
    for raw in markdown.splitlines():
        if _FENCE.match(raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING.match(raw)
        if m:
            section = anchors.get(_strip_inline(m.group(2)), section)
        out.append((_INLINE_CODE.sub("", raw), section, raw))
    return out


def parse_references(markdown: str) -> list[dict[str, Any]]:
    """Every [[page]] and ticket-key reference with its section and a context snippet."""
    refs: list[dict[str, Any]] = []
    for line, section, raw in _prose_lines(markdown):
        snippet = _strip_inline(raw)[:160]
        for m in _REF.finditer(line):
            refs.append(
                {
                    "kind": "page",
                    "title": m.group(1).strip(),
                    "anchor": (m.group(2) or "").strip() or None,
                    "display": (m.group(3) or "").strip() or None,
                    "section": section,
                    "snippet": snippet,
                }
            )
        stripped = _REF.sub("", line)
        for m in _TICKET.finditer(stripped):
            refs.append(
                {
                    "kind": "ticket",
                    "key": m.group(1),
                    "section": section,
                    "snippet": snippet,
                }
            )
    return refs


# ---------------------------------------------------------------------------
# Pages: lookup, tree, create
# ---------------------------------------------------------------------------


async def _project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise DocsError(404, "project_not_found", "Project not found")
    return project


async def get_page(
    session: AsyncSession, page_id: str, *, include_deleted: bool = False
) -> DocsPage:
    page = await session.get(DocsPage, page_id)
    if page is None:
        raise DocsError(404, "page_not_found", "Page not found")
    if page.deleted_at and not include_deleted:
        raise DocsError(
            410,
            "page_deleted",
            "Page is in the Recycle Bin",
            deleted_by=page.deleted_by,
            deleted_at=page.deleted_at,
        )
    return page


async def _all_pages(
    session: AsyncSession, project_id: str, *, deleted: bool = False
) -> list[DocsPage]:
    stmt = select(DocsPage).where(DocsPage.project_id == project_id)
    stmt = stmt.where(
        DocsPage.deleted_at.is_not(None) if deleted else DocsPage.deleted_at.is_(None)  # type: ignore[union-attr]
    )
    result = await session.exec(stmt.order_by(DocsPage.position, DocsPage.created_at))  # type: ignore[arg-type]
    return list(result.all())


async def _unique_slug(session: AsyncSession, project_id: str, title: str) -> str:
    base = slugify(title) or "page"
    result = await session.exec(
        select(DocsPage.slug).where(DocsPage.project_id == project_id)
    )
    taken = set(result.all())
    slug, n = base, 1
    while slug in taken:
        n += 1
        slug = f"{base}-{n}"
    return slug


def _clean_title(title: str | None) -> str:
    title = (title or "").strip()
    if not title:
        raise DocsError(422, "title_required", "Give the page a title")
    if len(title) > MAX_TITLE:
        raise DocsError(
            422, "title_too_long", f"Title is limited to {MAX_TITLE} characters"
        )
    return title


def _check_markdown(markdown: str) -> str:
    if len(markdown) > MAX_MARKDOWN:
        raise DocsError(413, "too_large", "Page is too large")
    return markdown


async def _next_position(
    session: AsyncSession, project_id: str, parent_id: str | None
) -> int:
    pages = [
        p for p in await _all_pages(session, project_id) if p.parent_id == parent_id
    ]
    return (max((p.position for p in pages), default=-1)) + 1


async def _draft_for(
    session: AsyncSession, page_id: str, author: str
) -> DocsDraft | None:
    result = await session.exec(
        select(DocsDraft).where(
            DocsDraft.page_id == page_id, DocsDraft.author == author
        )
    )
    return result.first()


async def _latest_version(session: AsyncSession, page: DocsPage) -> DocsVersion | None:
    if page.version == 0:
        return None
    result = await session.exec(
        select(DocsVersion).where(
            DocsVersion.page_id == page.id, DocsVersion.version == page.version
        )
    )
    return result.first()


async def list_tree(session: AsyncSession, project_id: str) -> list[dict[str, Any]]:
    await _project(session, project_id)
    pages = await _all_pages(session, project_id)
    author = activity.current_actor()
    result = await session.exec(
        select(DocsDraft.page_id).where(
            DocsDraft.author == author,
            DocsDraft.page_id.in_([p.id for p in pages] or [""]),  # type: ignore[attr-defined]
        )
    )
    drafted = set(result.all())
    return [
        {
            "id": p.id,
            "parent_id": p.parent_id,
            "position": p.position,
            "title": p.title,
            "slug": p.slug,
            "status": p.status,
            "version": p.version,
            "has_draft": p.id in drafted,
            "updated_at": p.updated_at,
        }
        for p in pages
    ]


async def create_page(
    session: AsyncSession,
    project_id: str,
    title: str,
    *,
    parent_id: str | None = None,
    template: str = "blank",
    markdown: str | None = None,
) -> dict[str, Any]:
    await _project(session, project_id)
    title = _clean_title(title)
    if parent_id is not None:
        parent = await get_page(session, parent_id)
        if parent.project_id != project_id:
            raise DocsError(422, "bad_parent", "Parent belongs to another project")
    if markdown is None:
        tpl = TEMPLATES.get(template)
        if tpl is None:
            raise DocsError(422, "bad_template", f"Unknown template '{template}'")
        markdown = tpl["markdown"]
    _check_markdown(markdown)
    actor = activity.current_actor()
    page = DocsPage(
        project_id=project_id,
        parent_id=parent_id,
        position=await _next_position(session, project_id, parent_id),
        title=title,
        slug=await _unique_slug(session, project_id, title),
        created_by=actor,
        updated_by=actor,
    )
    session.add(page)
    session.add(
        DocsDraft(
            page_id=page.id,
            author=actor,
            title=title,
            markdown=markdown,
            base_version=0,
        )
    )
    await session.commit()
    return await page_detail(session, page.id)


async def _path(session: AsyncSession, page: DocsPage) -> list[dict[str, str]]:
    path: list[dict[str, str]] = []
    cur = page
    seen = {page.id}
    while cur.parent_id and cur.parent_id not in seen:
        parent = await session.get(DocsPage, cur.parent_id)
        if parent is None:
            break
        path.insert(0, {"id": parent.id, "title": parent.title, "slug": parent.slug})
        seen.add(parent.id)
        cur = parent
    return path


async def page_detail(session: AsyncSession, page_id: str) -> dict[str, Any]:
    page = await get_page(session, page_id)
    actor = activity.current_actor()
    latest = await _latest_version(session, page)
    draft = await _draft_for(session, page.id, actor)
    markdown = latest.markdown if latest else ""
    unpublished = (
        draft is not None
        and page.version > 0
        and (draft.markdown != markdown or draft.title != page.title)
    )
    return {
        "id": page.id,
        "project_id": page.project_id,
        "parent_id": page.parent_id,
        "title": page.title,
        "slug": page.slug,
        "status": page.status,
        "version": page.version,
        "markdown": markdown,
        "headings": heading_anchors(markdown),
        "path": await _path(session, page),
        "created_by": page.created_by,
        "updated_by": latest.author if latest else page.updated_by,
        "updated_at": latest.created_at if latest else page.updated_at,
        "created_at": page.created_at,
        "has_unpublished_changes": unpublished,
        "draft": (
            {
                "title": draft.title,
                "markdown": draft.markdown,
                "base_version": draft.base_version,
                "updated_at": draft.updated_at,
                "author": draft.author,
            }
            if draft
            else None
        ),
    }


async def page_by_slug(
    session: AsyncSession, project_id: str, slug: str
) -> dict[str, Any]:
    result = await session.exec(
        select(DocsPage).where(DocsPage.project_id == project_id, DocsPage.slug == slug)
    )
    page = result.first()
    if page is None:
        raise DocsError(404, "page_not_found", f"No page at '{slug}'")
    return await page_detail(session, page.id)


async def rename_page(
    session: AsyncSession, page_id: str, title: str
) -> dict[str, Any]:
    page = await get_page(session, page_id)
    page.title = _clean_title(title)
    page.updated_at = _now()
    page.updated_by = activity.current_actor()
    session.add(page)
    draft = await _draft_for(session, page.id, activity.current_actor())
    if draft:
        draft.title = page.title
        session.add(draft)
    await session.commit()
    return await page_detail(session, page_id)


# ---------------------------------------------------------------------------
# Move, duplicate, delete, restore
# ---------------------------------------------------------------------------


async def _descendants(
    session: AsyncSession, page: DocsPage, *, deleted: bool = False
) -> list[DocsPage]:
    pages = await _all_pages(session, page.project_id, deleted=deleted)
    by_parent: dict[str | None, list[DocsPage]] = {}
    for p in pages:
        by_parent.setdefault(p.parent_id, []).append(p)
    out: list[DocsPage] = []
    stack = list(by_parent.get(page.id, []))
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(by_parent.get(cur.id, []))
    return out


async def move_page(
    session: AsyncSession,
    page_id: str,
    *,
    parent_id: str | None,
    before_id: str | None = None,
    after_id: str | None = None,
) -> dict[str, Any]:
    page = await get_page(session, page_id)
    if parent_id is not None:
        parent = await get_page(session, parent_id)
        if parent.project_id != page.project_id:
            raise DocsError(422, "bad_parent", "Parent belongs to another project")
        if parent.id == page.id or parent.id in {
            d.id for d in await _descendants(session, page)
        }:
            raise DocsError(
                409, "cycle", "A page cannot be moved into itself or its own sub-pages"
            )
    pages = await _all_pages(session, page.project_id)
    siblings = [p for p in pages if p.parent_id == parent_id and p.id != page.id]
    ids = [p.id for p in siblings]
    for anchor in (before_id, after_id):
        if anchor is not None and anchor not in ids:
            raise DocsError(
                422, "bad_anchor", "Anchor page is not a sibling at the target"
            )
    if before_id is not None:
        idx = ids.index(before_id)
    elif after_id is not None:
        idx = ids.index(after_id) + 1
    else:
        idx = len(ids)
    ids.insert(idx, page.id)
    by_id = {p.id: p for p in siblings} | {page.id: page}
    page.parent_id = parent_id
    page.updated_at = _now()
    page.updated_by = activity.current_actor()
    for pos, pid in enumerate(ids):
        by_id[pid].position = pos
        session.add(by_id[pid])
    await session.commit()
    return await page_detail(session, page_id)


async def duplicate_page(
    session: AsyncSession,
    page_id: str,
    *,
    title: str | None = None,
    parent_id: str | None = None,
    include_children: bool = False,
    parent_given: bool = False,
) -> dict[str, Any]:
    src = await get_page(session, page_id)
    target_parent = parent_id if parent_given else src.parent_id
    new_title = _clean_title(title or f"{src.title} (copy)")
    root_id = await _copy_page(session, src, new_title, target_parent)
    if include_children:
        await _copy_children(session, src, root_id)
    await session.commit()
    return await page_detail(session, root_id)


async def _copy_children(
    session: AsyncSession, src: DocsPage, new_parent_id: str
) -> None:
    pages = await _all_pages(session, src.project_id)
    for child in sorted(
        (p for p in pages if p.parent_id == src.id), key=lambda p: p.position
    ):
        new_id = await _copy_page(session, child, child.title, new_parent_id)
        await _copy_children(session, child, new_id)


async def _copy_page(
    session: AsyncSession, src: DocsPage, title: str, parent_id: str | None
) -> str:
    latest = await _latest_version(session, src)
    draft = await _draft_for(session, src.id, activity.current_actor())
    markdown = latest.markdown if latest else (draft.markdown if draft else "")
    actor = activity.current_actor()
    page = DocsPage(
        project_id=src.project_id,
        parent_id=parent_id,
        position=await _next_position(session, src.project_id, parent_id),
        title=title,
        slug=await _unique_slug(session, src.project_id, title),
        created_by=actor,
        updated_by=actor,
    )
    session.add(page)
    session.add(
        DocsDraft(
            page_id=page.id,
            author=actor,
            title=title,
            markdown=markdown,
            base_version=0,
        )
    )
    await session.flush()
    return page.id


async def delete_page(session: AsyncSession, page_id: str) -> dict[str, Any]:
    page = await get_page(session, page_id)
    subtree = [page, *await _descendants(session, page)]
    now, actor = _now(), activity.current_actor()
    for p in subtree:
        p.deleted_at, p.deleted_by, p.deleted_root_id = now, actor, page.id
        session.add(p)
    await session.commit()
    return {"id": page.id, "deleted_pages": len(subtree)}


async def restore_page(session: AsyncSession, page_id: str) -> dict[str, Any]:
    page = await get_page(session, page_id, include_deleted=True)
    if not page.deleted_at:
        raise DocsError(409, "not_deleted", "Page is not in the Recycle Bin")
    root = page.deleted_root_id
    subtree = [page, *await _descendants(session, page, deleted=True)]
    subtree = [p for p in subtree if p.deleted_root_id == root]
    restored_ids = {p.id for p in subtree}
    parent = await session.get(DocsPage, page.parent_id) if page.parent_id else None
    reparented = bool(parent and parent.deleted_at)
    if reparented:
        page.parent_id = None
        page.position = await _next_position(session, page.project_id, None)
    for p in subtree:
        p.deleted_at = p.deleted_by = p.deleted_root_id = None
        session.add(p)
    await session.commit()
    return {
        "id": page.id,
        "restored_pages": len(restored_ids),
        "moved_to_top_level": reparented,
    }


async def list_deleted(session: AsyncSession, project_id: str) -> list[dict[str, Any]]:
    await purge_expired(session, project_id)
    pages = await _all_pages(session, project_id, deleted=True)
    ids = {p.id for p in pages}
    out = []
    for p in pages:
        # one entry per deletion: the root, plus children whose parent is not deleted with them
        if p.deleted_root_id != p.id and p.parent_id in ids:
            continue
        count = 1 + len(
            [d for d in pages if d.deleted_root_id == p.id and d.id != p.id]
        )
        out.append(
            {
                "id": p.id,
                "title": p.title,
                "project_id": p.project_id,
                "deleted_at": p.deleted_at,
                "deleted_by": p.deleted_by,
                "page_count": count,
                "days_left": max(
                    0,
                    RECYCLE_DAYS
                    - (
                        datetime.now(UTC)
                        - datetime.fromisoformat(p.deleted_at or _now())
                    ).days,
                ),
            }
        )
    return sorted(out, key=lambda e: e["deleted_at"] or "", reverse=True)


async def _hard_delete(session: AsyncSession, pages: list[DocsPage]) -> None:
    ids = [p.id for p in pages]
    if not ids:
        return
    for model in (DocsLink, DocsDraft, DocsVersion):
        col = model.source_page_id if model is DocsLink else model.page_id  # type: ignore[attr-defined]
        rows = await session.exec(select(model).where(col.in_(ids)))
        for row in rows.all():
            await session.delete(row)
    # children first so the parent foreign key never dangles
    for p in sorted(pages, key=lambda p: 0 if p.parent_id in ids else 1):
        await session.delete(p)


async def purge_page(session: AsyncSession, page_id: str) -> None:
    page = await get_page(session, page_id, include_deleted=True)
    if not page.deleted_at:
        raise DocsError(
            409, "not_deleted", "Only pages in the Recycle Bin can be deleted forever"
        )
    pages = [page, *await _descendants(session, page, deleted=True)]
    await _hard_delete(
        session, [p for p in pages if p.deleted_root_id == page.deleted_root_id]
    )
    await session.commit()


async def purge_expired(session: AsyncSession, project_id: str) -> int:
    cutoff = (datetime.now(UTC) - timedelta(days=RECYCLE_DAYS)).isoformat()
    pages = [
        p
        for p in await _all_pages(session, project_id, deleted=True)
        if (p.deleted_at or "") < cutoff
    ]
    await _hard_delete(session, pages)
    if pages:
        await session.commit()
    return len(pages)


# ---------------------------------------------------------------------------
# Drafts, publish, versions
# ---------------------------------------------------------------------------


async def save_draft(
    session: AsyncSession,
    page_id: str,
    *,
    markdown: str,
    title: str | None = None,
    base_version: int | None = None,
) -> dict[str, Any]:
    page = await get_page(session, page_id)
    _check_markdown(markdown)
    actor = activity.current_actor()
    draft = await _draft_for(session, page.id, actor)
    new_title = _clean_title(title) if title is not None else None
    if draft is None:
        draft = DocsDraft(
            page_id=page.id,
            author=actor,
            title=new_title or page.title,
            markdown=markdown,
            base_version=page.version if base_version is None else base_version,
        )
    else:
        draft.markdown = markdown
        if new_title:
            draft.title = new_title
        if base_version is not None:
            draft.base_version = base_version
        draft.updated_at = _now()
    session.add(draft)
    await session.commit()
    return await page_detail(session, page_id)


async def discard_draft(session: AsyncSession, page_id: str) -> dict[str, Any]:
    page = await get_page(session, page_id)
    draft = await _draft_for(session, page.id, activity.current_actor())
    if draft:
        await session.delete(draft)
        await session.commit()
    return await page_detail(session, page_id)


async def publish_page(
    session: AsyncSession,
    page_id: str,
    *,
    base_version: int,
    note: str | None = None,
    markdown: str | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    page = await get_page(session, page_id)
    actor = activity.current_actor()
    if base_version != page.version:
        latest = await _latest_version(session, page)
        raise DocsError(
            409,
            "conflict",
            f"Page was published as v{page.version} since you started from v{base_version}",
            latest_version=page.version,
            latest_author=latest.author if latest else None,
            latest_at=latest.created_at if latest else None,
        )
    draft = await _draft_for(session, page.id, actor)
    if markdown is None:
        if draft is None:
            raise DocsError(422, "nothing_to_publish", "There is no draft to publish")
        markdown = draft.markdown
    _check_markdown(markdown)
    new_title = _clean_title(title or (draft.title if draft else page.title))
    return await _commit_version(session, page, markdown, new_title, actor, note, draft)


async def _commit_version(
    session: AsyncSession,
    page: DocsPage,
    markdown: str,
    title: str,
    author: str,
    note: str | None,
    draft: DocsDraft | None,
) -> dict[str, Any]:
    page.version += 1
    page.status = "published"
    page.title = title
    page.updated_at = _now()
    page.updated_by = author
    session.add(page)
    session.add(
        DocsVersion(
            page_id=page.id,
            version=page.version,
            title=title,
            markdown=markdown,
            author=author,
            note=(note or "").strip() or None,
        )
    )
    if draft is not None:
        await session.delete(draft)
    await session.flush()
    await reindex_links(session, page, markdown)
    await session.commit()
    return await page_detail(session, page.id)


async def list_versions(session: AsyncSession, page_id: str) -> list[dict[str, Any]]:
    await get_page(session, page_id)
    result = await session.exec(
        select(DocsVersion)
        .where(DocsVersion.page_id == page_id)
        .order_by(DocsVersion.version.desc())  # type: ignore[attr-defined]
    )
    return [
        {
            "version": v.version,
            "title": v.title,
            "author": v.author,
            "note": v.note,
            "created_at": v.created_at,
            "words": len(v.markdown.split()),
        }
        for v in result.all()
    ]


async def _version(session: AsyncSession, page_id: str, n: int) -> DocsVersion:
    result = await session.exec(
        select(DocsVersion).where(
            DocsVersion.page_id == page_id, DocsVersion.version == n
        )
    )
    v = result.first()
    if v is None:
        raise DocsError(404, "version_not_found", f"Version {n} not found")
    return v


async def get_version(session: AsyncSession, page_id: str, n: int) -> dict[str, Any]:
    await get_page(session, page_id)
    v = await _version(session, page_id, n)
    return {
        "version": v.version,
        "title": v.title,
        "markdown": v.markdown,
        "author": v.author,
        "note": v.note,
        "created_at": v.created_at,
    }


def diff_markdown(old: str, new: str) -> dict[str, Any]:
    """Line diff with word-level highlights on changed pairs and per-section counts."""
    a, b = old.splitlines(), new.splitlines()
    rows: list[dict[str, Any]] = []
    added = removed = 0
    section = "(top)"
    sections: dict[str, dict[str, int]] = {}
    old_no = new_no = 0

    def bump(kind: str) -> None:
        s = sections.setdefault(section, {"added": 0, "removed": 0})
        s[kind] += 1

    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(
        None, a, b, autojunk=False
    ).get_opcodes():
        if tag == "equal":
            for line in a[i1:i2]:
                old_no += 1
                new_no += 1
                m = _HEADING.match(line)
                if m:
                    section = _strip_inline(m.group(2))
                rows.append(
                    {"type": "same", "text": line, "old_no": old_no, "new_no": new_no}
                )
            continue
        olds, news = a[i1:i2], b[j1:j2]
        for line in olds:
            m = _HEADING.match(line)
            if m:
                section = _strip_inline(m.group(2))
        for k, line in enumerate(olds):
            old_no += 1
            removed += 1
            bump("removed")
            row: dict[str, Any] = {
                "type": "del",
                "text": line,
                "old_no": old_no,
                "new_no": None,
            }
            if tag == "replace" and k < len(news):
                row["words"] = _word_diff(line, news[k], "del")
            rows.append(row)
        for k, line in enumerate(news):
            new_no += 1
            added += 1
            m = _HEADING.match(line)
            if m:
                section = _strip_inline(m.group(2))
            bump("added")
            row = {"type": "add", "text": line, "old_no": None, "new_no": new_no}
            if tag == "replace" and k < len(olds):
                row["words"] = _word_diff(olds[k], line, "add")
            rows.append(row)
    return {
        "rows": rows,
        "added": added,
        "removed": removed,
        "sections": [{"heading": h, **c} for h, c in sections.items()],
    }


def _word_diff(old: str, new: str, side: str) -> list[dict[str, Any]]:
    """Token list for the `side` line with `changed` marking differing words."""
    ot, nt = re.findall(r"\s+|\S+", old), re.findall(r"\s+|\S+", new)
    sm = difflib.SequenceMatcher(None, ot, nt, autojunk=False)
    out: list[dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if side == "del":
            out.extend({"text": t, "changed": tag != "equal"} for t in ot[i1:i2])
        else:
            out.extend({"text": t, "changed": tag != "equal"} for t in nt[j1:j2])
    return out


async def diff_versions(
    session: AsyncSession, page_id: str, a: int, b: int
) -> dict[str, Any]:
    await get_page(session, page_id)
    va = await _version(session, page_id, a)
    vb = await _version(session, page_id, b)
    result = diff_markdown(va.markdown, vb.markdown)
    return {"from": a, "to": b, **result}


async def restore_version(
    session: AsyncSession, page_id: str, n: int, *, note: str | None = None
) -> dict[str, Any]:
    page = await get_page(session, page_id)
    v = await _version(session, page_id, n)
    actor = activity.current_actor()
    draft = await _draft_for(session, page.id, actor)
    return await _commit_version(
        session, page, v.markdown, v.title, actor, note or f"Restored from v{n}", draft
    )


# ---------------------------------------------------------------------------
# References and backlinks
# ---------------------------------------------------------------------------


async def _resolve_page_ref(
    pages: list[DocsPage],
    deleted: list[DocsPage],
    title: str,
    anchor: str | None,
    headings_of: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    needle = title.strip().lower()
    by_id = {p.id: p for p in pages}

    def depth(p: DocsPage) -> int:
        d, cur = 0, p
        while cur.parent_id and cur.parent_id in by_id:
            d += 1
            cur = by_id[cur.parent_id]
        return d

    def path_of(p: DocsPage) -> str:
        parts, cur = [p.title], p
        while cur.parent_id and cur.parent_id in by_id:
            cur = by_id[cur.parent_id]
            parts.insert(0, cur.title)
        return "/".join(parts)

    matches = [p for p in pages if p.title.lower() == needle]
    status = "ok"
    if not matches and "/" in needle:
        matches = [p for p in pages if path_of(p).lower().endswith(needle)]
    if not matches:
        if any(p.title.lower() == needle for p in deleted):
            return {"status": "in_bin", "title": title}
        return {"status": "missing", "title": title}
    if len(matches) > 1:
        matches.sort(key=lambda p: (depth(p), p.position))
        if depth(matches[0]) == depth(matches[1]):
            status = "ambiguous"
    page = matches[0]
    out = {
        "status": status,
        "page_id": page.id,
        "title": page.title,
        "slug": page.slug,
        "path": path_of(page),
        "published": page.version > 0,
    }
    if anchor:
        slugs = {h["slug"]: h for h in headings_of.get(page.id, [])}
        wanted = slugify(anchor)
        if wanted in slugs:
            out["anchor"] = wanted
            out["section"] = slugs[wanted]["text"]
        else:
            out["status"] = "section_missing"
            out["anchor"] = wanted
    return out


async def _headings_by_page(
    session: AsyncSession, pages: list[DocsPage]
) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for p in pages:
        v = await _latest_version(session, p)
        out[p.id] = heading_anchors(v.markdown) if v else []
    return out


async def resolve_refs(
    session: AsyncSession, project_id: str, refs: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Resolve [[page]] and ticket references: status, title, path, and ticket state."""
    await _project(session, project_id)
    pages = await _all_pages(session, project_id)
    deleted = await _all_pages(session, project_id, deleted=True)
    headings = await _headings_by_page(session, pages)
    keys = [r["key"] for r in refs if r.get("kind") == "ticket" and r.get("key")]
    tickets: dict[str, Ticket] = {}
    if keys:
        rows = await session.exec(
            select(Ticket).where(Ticket.project_id == project_id, Ticket.id.in_(keys))  # type: ignore[attr-defined]
        )
        tickets = {t.id: t for t in rows.all()}
    out: list[dict[str, Any]] = []
    for r in refs:
        if r.get("kind") == "ticket":
            t = tickets.get(r.get("key", ""))
            out.append(
                {
                    "kind": "ticket",
                    "key": r.get("key"),
                    "status": "ok" if t else "missing",
                }
                | ({"title": t.title, "ticket_status": t.status} if t else {})
            )
        else:
            res = await _resolve_page_ref(
                pages, deleted, r.get("title", ""), r.get("anchor"), headings
            )
            out.append({"kind": "page", **res})
    return out


async def reindex_links(session: AsyncSession, page: DocsPage, markdown: str) -> None:
    old = await session.exec(select(DocsLink).where(DocsLink.source_page_id == page.id))
    for row in old.all():
        await session.delete(row)
    refs = parse_references(markdown)
    if not refs:
        return
    resolved = await resolve_refs(session, page.project_id, refs)
    for ref, res in zip(refs, resolved):
        if ref["kind"] == "ticket":
            if res["status"] != "ok":
                continue
            session.add(
                DocsLink(
                    source_page_id=page.id,
                    source_section=ref["section"],
                    target_ticket_id=ref["key"],
                    snippet=ref["snippet"],
                )
            )
        else:
            session.add(
                DocsLink(
                    source_page_id=page.id,
                    source_section=ref["section"],
                    target_page_id=res.get("page_id"),
                    target_title=ref["title"],
                    target_anchor=ref["anchor"],
                    display_text=ref["display"],
                    snippet=ref["snippet"],
                )
            )


async def backlinks(session: AsyncSession, page_id: str) -> dict[str, Any]:
    """Pages and tickets that reference this page (the 'Referenced by' panel)."""
    page = await get_page(session, page_id)
    rows = await session.exec(
        select(DocsLink).where(DocsLink.target_page_id == page.id)
    )
    seen: set[tuple[str, str | None]] = set()
    pages_out = []
    for link in rows.all():
        src = await session.get(DocsPage, link.source_page_id)
        if src is None or src.deleted_at or src.id == page.id:
            continue
        key = (src.id, link.source_section)
        if key in seen:
            continue
        seen.add(key)
        parent = await session.get(DocsPage, src.parent_id) if src.parent_id else None
        pages_out.append(
            {
                "page_id": src.id,
                "title": src.title,
                "in": link.source_section or (parent.title if parent else None),
                "snippet": link.snippet,
            }
        )
    tickets_out = []
    result = await session.exec(
        select(Ticket).where(
            Ticket.project_id == page.project_id, Ticket.description.contains("[[")
        )  # type: ignore[attr-defined]
    )
    all_pages = await _all_pages(session, page.project_id)
    headings: dict[str, list[dict[str, Any]]] = {}
    for t in result.all():
        for ref in parse_references(t.description):
            if ref["kind"] != "page":
                continue
            res = await _resolve_page_ref(
                all_pages, [], ref["title"], ref["anchor"], headings
            )
            if res.get("page_id") == page.id:
                tickets_out.append(
                    {"ticket_id": t.id, "title": t.title, "status": t.status}
                )
                break
    return {"pages": pages_out, "tickets": tickets_out}


async def docs_for_ticket(
    session: AsyncSession, ticket_id: str
) -> list[dict[str, Any]]:
    """Published pages that mention this ticket ('Linked docs' on the ticket)."""
    rows = await session.exec(
        select(DocsLink).where(DocsLink.target_ticket_id == ticket_id)
    )
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for link in rows.all():
        src = await session.get(DocsPage, link.source_page_id)
        if src is None or src.deleted_at or src.id in seen:
            continue
        seen.add(src.id)
        out.append(
            {
                "page_id": src.id,
                "project_id": src.project_id,
                "title": src.title,
                "section": link.source_section,
                "snippet": link.snippet,
                "version": src.version,
            }
        )
    return out
