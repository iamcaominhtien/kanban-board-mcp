"""Docs space: a page tree per project, drafts, versions, history and references.

Pages store markdown. The title is its own field; body headings start at ``##``.
Every publish adds a ``DocsVersion`` row; a restore adds a new one rather than
rewriting history. References (``[[Page#Section|text]]`` and ticket keys) are
indexed in ``DocsLink`` when a page is published.
"""

import difflib
import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import or_
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    DocsAnchorAlias,
    DocsDraft,
    DocsLink,
    DocsPage,
    DocsVersion,
    Project,
    Ticket,
)
from services import activity, docs_search
from services.docs_templates import TEMPLATES
from services.docs_text import (  # noqa: F401  (re-exported)
    DocsError,
    count_page_links,
    heading_anchors,
    page_ref_contexts,
    parse_references,
    rewrite_page_links,
    slugify,
    _FENCE,
    _HEADING,
    _INLINE_CODE,
    _REF,
    _strip_inline,
)

RECYCLE_DAYS = 30
MAX_TITLE = 200
MAX_MARKDOWN = 1_000_000


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ---------------------------------------------------------------------------
# Markdown helpers live in docs_text (re-exported here for callers and tests).


# ---------------------------------------------------------------------------
# Pages: lookup, tree, create
# ---------------------------------------------------------------------------


async def _project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise DocsError(404, "project_not_found", "Project not found")
    if not project.docs_enabled:
        raise DocsError(403, "docs_disabled", "Docs are turned off for this project")
    return project


async def get_page(
    session: AsyncSession, page_id: str, *, include_deleted: bool = False
) -> DocsPage:
    page = await session.get(DocsPage, page_id)
    if page is None:
        raise DocsError(404, "page_not_found", "Page not found")
    await _project(session, page.project_id)
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
    await session.flush()
    await docs_search.reindex(session, [page.id])
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
        "stats": await page_stats(session, page, markdown),
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
    await session.flush()
    root = await session.get(DocsPage, root_id)
    copied = [root_id, *(d.id for d in await _descendants(session, root))]  # type: ignore[arg-type]
    await docs_search.reindex(session, copied)
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
    await session.flush()
    await refresh_link_targets(session, page.project_id)
    await docs_search.unindex(session, [p.id for p in subtree])
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
    await session.flush()
    await refresh_link_targets(session, page.project_id)
    await docs_search.reindex(session, list(restored_ids))
    await session.commit()
    return {
        "id": page.id,
        "restored_pages": len(restored_ids),
        "moved_to_top_level": reparented,
    }


async def list_deleted(session: AsyncSession, project_id: str) -> list[dict[str, Any]]:
    await _project(session, project_id)
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
        parent = await session.get(DocsPage, p.parent_id) if p.parent_id else None
        out.append(
            {
                "id": p.id,
                "title": p.title,
                "project_id": p.project_id,
                "parent_title": parent.title if parent else None,
                "parent_deleted": bool(parent and parent.deleted_at),
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
    await docs_search.unindex(session, ids)
    for model in (DocsLink, DocsDraft, DocsVersion, DocsAnchorAlias):
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


async def empty_recycle_bin(session: AsyncSession, project_id: str) -> dict[str, int]:
    """Delete everything in the project's Recycle Bin for good."""
    await _project(session, project_id)
    pages = await _all_pages(session, project_id, deleted=True)
    await _hard_delete(session, pages)
    await session.commit()
    return {"purged": len(pages)}


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
    *,
    commit: bool = True,
) -> dict[str, Any]:
    previous = await _latest_version(session, page)
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
    await _update_aliases(
        session, page, previous.markdown if previous else "", markdown
    )
    await reindex_links(session, page, markdown)
    await session.flush()
    await refresh_link_targets(session, page.project_id)
    await docs_search.reindex(session, [page.id])
    if not commit:
        return {}
    await session.commit()
    return await page_detail(session, page.id)


async def _update_aliases(
    session: AsyncSession, page: DocsPage, old_md: str, new_md: str
) -> None:
    """Remember renamed headings (a slug that vanished while a new one took its place)."""
    old = [h["slug"] for h in heading_anchors(old_md)]
    new = [h["slug"] for h in heading_anchors(new_md)]
    pairs: list[tuple[str, str]] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(
        None, old, new, autojunk=False
    ).get_opcodes():
        if tag == "replace" and i2 - i1 == j2 - j1:
            pairs.extend(zip(old[i1:i2], new[j1:j2]))
    rows = await session.exec(
        select(DocsAnchorAlias).where(DocsAnchorAlias.page_id == page.id)
    )
    existing = list(rows.all())
    live = set(new)
    for old_slug, new_slug in pairs:
        if old_slug in live:
            continue
        for row in existing:
            if row.new_slug == old_slug:  # a chain: A -> B becomes A -> C
                row.new_slug = new_slug
                session.add(row)
        match = next((r for r in existing if r.old_slug == old_slug), None)
        if match is None:
            match = DocsAnchorAlias(
                page_id=page.id, old_slug=old_slug, new_slug=new_slug
            )
            existing.append(match)
        match.new_slug = new_slug
        session.add(match)
    for row in existing:
        if row.old_slug in live or row.old_slug == row.new_slug:
            await session.delete(row)


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


async def _aliases_by_page(
    session: AsyncSession, page_ids: list[str]
) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    if not page_ids:
        return out
    rows = await session.exec(
        select(DocsAnchorAlias).where(DocsAnchorAlias.page_id.in_(page_ids))  # type: ignore[attr-defined]
    )
    for a in rows.all():
        out.setdefault(a.page_id, {})[a.old_slug] = a.new_slug
    return out


def _follow_alias(
    wanted: str, slugs: dict[str, Any], aliases: dict[str, str]
) -> str | None:
    """The current slug a renamed heading's old slug leads to (chains are followed)."""
    seen: set[str] = set()
    cur = wanted
    while cur in aliases and cur not in seen:
        seen.add(cur)
        cur = aliases[cur]
        if cur in slugs:
            return cur
    return None


async def _resolve_page_ref(
    pages: list[DocsPage],
    deleted: list[DocsPage],
    title: str,
    anchor: str | None,
    headings_of: dict[str, list[dict[str, Any]]],
    aliases: dict[str, dict[str, str]] | None = None,
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
        if wanted not in slugs:
            renamed = _follow_alias(wanted, slugs, (aliases or {}).get(page.id, {}))
            if renamed:
                wanted = renamed
                out["anchor_renamed"] = True
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
    contents = await docs_search._contents(session, [p for p in pages if p.version > 0])
    return {
        p.id: heading_anchors(contents[p.id]) if p.id in contents else [] for p in pages
    }


async def resolve_refs(
    session: AsyncSession, project_id: str, refs: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Resolve [[page]] and ticket references: status, title, path, and ticket state."""
    await _project(session, project_id)
    pages = await _all_pages(session, project_id)
    deleted = await _all_pages(session, project_id, deleted=True)
    headings = await _headings_by_page(session, pages)
    aliases = await _aliases_by_page(session, [p.id for p in pages])
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
                pages, deleted, r.get("title", ""), r.get("anchor"), headings, aliases
            )
            out.append({"kind": "page", **res})
    return out


async def reindex_links(session: AsyncSession, page: DocsPage, markdown: str) -> None:
    old = await session.exec(
        select(DocsLink).where(
            DocsLink.source_page_id == page.id, DocsLink.origin == "page"
        )
    )
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


async def refresh_link_targets(session: AsyncSession, project_id: str) -> None:
    """Re-point indexed [[links]] after pages appear, change title, are deleted or restored.

    A link written before its target existed (or while it was in the Recycle Bin) is
    resolved here, so "Referenced by" stays right without re-publishing the source.
    """
    pages = await _all_pages(session, project_id)
    deleted = await _all_pages(session, project_id, deleted=True)
    ids = [p.id for p in pages + deleted]
    if not ids:
        return
    headings = await _headings_by_page(session, pages)
    aliases = await _aliases_by_page(session, [p.id for p in pages])
    rows = await session.exec(
        select(DocsLink).where(
            DocsLink.source_page_id.in_(ids),  # type: ignore[attr-defined]
            DocsLink.target_title.is_not(None),  # type: ignore[union-attr]
        )
    )
    for link in rows.all():
        res = await _resolve_page_ref(
            pages,
            deleted,
            link.target_title or "",
            link.target_anchor,
            headings,
            aliases,
        )
        new_target = res.get("page_id")
        if new_target != link.target_page_id:
            link.target_page_id = new_target
            session.add(link)


def _json_list(raw: str | None) -> list[Any]:
    try:
        data = json.loads(raw or "[]")
    except ValueError:
        return []
    return data if isinstance(data, list) else []


def _ticket_texts(ticket: Ticket) -> list[tuple[str, str, str]]:
    """(origin, detail, text) for every text field of a ticket that can hold a [[reference]].

    ``detail`` names the exact place for the "Mentioned in test case TC-3" wording.
    """
    out: list[tuple[str, str, str]] = [("description", "", ticket.description or "")]
    for c in _json_list(ticket.comments):
        if isinstance(c, dict) and c.get("text") and not c.get("deleted_at"):
            out.append(("comment", "", str(c["text"])))
    for ac in _json_list(ticket.acceptance_criteria):
        if isinstance(ac, dict) and ac.get("text"):
            out.append(("acceptance_criterion", "", str(ac["text"])))
    for tc in _json_list(ticket.test_cases):
        if not isinstance(tc, dict):
            continue
        code = str(tc.get("code") or "")
        for key in ("description", "expected_result", "notes", "test_data"):
            if isinstance(tc.get(key), str) and tc[key]:
                out.append(("test_case", code, tc[key]))
    for w in _json_list(ticket.work_log):
        if isinstance(w, dict) and w.get("note"):
            out.append(("debug_note", "", str(w["note"])))
    return out


async def _tickets_mentioning_pages(
    session: AsyncSession, project_id: str
) -> list[Ticket]:
    result = await session.exec(
        select(Ticket).where(
            Ticket.project_id == project_id,
            or_(
                Ticket.description.contains("[["),  # type: ignore[attr-defined]
                Ticket.comments.contains("[["),  # type: ignore[attr-defined]
                Ticket.acceptance_criteria.contains("[["),  # type: ignore[attr-defined]
                Ticket.test_cases.contains("[["),  # type: ignore[attr-defined]
                Ticket.work_log.contains("[["),  # type: ignore[attr-defined]
            ),
        )
    )
    return list(result.all())


async def _ticket_mentions(
    session: AsyncSession, project_id: str
) -> list[dict[str, Any]]:
    """Every [[page]] mention in ticket descriptions/comments, resolved to a page."""
    tickets = await _tickets_mentioning_pages(session, project_id)
    if not tickets:
        return []
    pages = await _all_pages(session, project_id)
    headings = await _headings_by_page(session, pages)
    aliases = await _aliases_by_page(session, [p.id for p in pages])
    out: list[dict[str, Any]] = []
    for t in tickets:
        for origin, detail, body in _ticket_texts(t):
            if "[[" not in body:
                continue
            for ref in page_ref_contexts(body):
                res = await _resolve_page_ref(
                    pages, [], ref["title"], ref["anchor"], headings, aliases
                )
                if res.get("page_id"):
                    out.append(
                        {
                            "ticket": t,
                            "origin": origin,
                            "detail": detail,
                            "page_id": res["page_id"],
                            "section": res.get("section"),
                            "context": ref["context"],
                        }
                    )
    return out


async def _page_row_context(
    session: AsyncSession, link: DocsLink, src: DocsPage
) -> str:
    contents = await docs_search._contents(session, [src])
    wanted = (link.target_title or "").lower()
    refs = [
        r
        for r in page_ref_contexts(contents.get(src.id, ""))
        if r["title"].lower() == wanted
    ]
    for r in refs:
        if r["section"] == link.source_section:
            return r["context"]
    return refs[0]["context"] if refs else link.snippet


async def backlinks(session: AsyncSession, page_id: str) -> dict[str, Any]:
    """Pages and tickets that reference this page (the 'Referenced by' panel)."""
    page = await get_page(session, page_id)
    rows = await session.exec(
        select(DocsLink).where(
            DocsLink.target_page_id == page.id, DocsLink.origin == "page"
        )
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
                "origin": "page",
                "context": await _page_row_context(session, link, src),
            }
        )
    tickets_out: list[dict[str, Any]] = []
    seen_tickets: set[tuple[str, str, str]] = set()
    for m in await _ticket_mentions(session, page.project_id):
        t: Ticket = m["ticket"]
        if m["page_id"] != page.id or (t.id, m["origin"], m["detail"]) in seen_tickets:
            continue
        seen_tickets.add((t.id, m["origin"], m["detail"]))
        tickets_out.append(
            {
                "ticket_id": t.id,
                "title": t.title,
                "status": t.status,
                "origin": m["origin"],
                "detail": m["detail"],
                "context": m["context"],
            }
        )
    manual = await session.exec(
        select(DocsLink).where(
            DocsLink.source_page_id == page.id,
            DocsLink.origin == "manual",
            DocsLink.target_ticket_id.is_not(None),  # type: ignore[union-attr]
        )
    )
    for link in manual.all():
        t = await session.get(Ticket, link.target_ticket_id)  # type: ignore[arg-type]
        if t is not None and (t.id, "manual", "") not in seen_tickets:
            seen_tickets.add((t.id, "manual", ""))
            tickets_out.append(
                {
                    "ticket_id": t.id,
                    "title": t.title,
                    "status": t.status,
                    "origin": "manual",
                    "detail": "",
                    "context": "",
                }
            )
    return {"pages": pages_out, "tickets": tickets_out}


async def page_stats(
    session: AsyncSession, page: DocsPage, markdown: str
) -> dict[str, int]:
    inbound = await session.exec(
        select(DocsLink.source_page_id).where(
            DocsLink.target_page_id == page.id, DocsLink.origin == "page"
        )
    )
    sources = set(inbound.all()) - {page.id}
    live = 0
    for sid in sources:
        src = await session.get(DocsPage, sid)
        if src is not None and not src.deleted_at:
            live += 1
    tickets: set[str] = set()
    outbound = await session.exec(
        select(DocsLink.target_ticket_id).where(
            DocsLink.source_page_id == page.id,
            DocsLink.target_ticket_id.is_not(None),  # type: ignore[union-attr]
        )
    )
    tickets.update(t for t in outbound.all() if t)
    for m in await _ticket_mentions(session, page.project_id):
        if m["page_id"] == page.id:
            tickets.add(m["ticket"].id)
    return {
        "words": len(markdown.split()),
        "linked_tickets": len(tickets),
        "inbound_links": live,
    }


# ---------------------------------------------------------------------------
# Ticket <-> docs
# ---------------------------------------------------------------------------

_ORIGIN_ORDER = {
    "description": 0,
    "acceptance_criterion": 1,
    "test_case": 2,
    "comment": 3,
    "debug_note": 4,
    "manual": 5,
    "page": 6,
}


async def _ticket_or_404(session: AsyncSession, ticket_id: str) -> Ticket:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise DocsError(404, "ticket_not_found", "Ticket not found")
    return ticket


async def docs_for_ticket(
    session: AsyncSession, ticket_id: str
) -> list[dict[str, Any]]:
    """Pages tied to a ticket: mentioned in it (description/comment), linked by hand, or mentioning it."""
    ticket = await session.get(Ticket, ticket_id)
    project = await session.get(Project, ticket.project_id) if ticket else None
    if ticket is not None and project is not None and not project.docs_enabled:
        return []
    pages = await _all_pages(session, ticket.project_id) if ticket else []
    by_id = {p.id: p for p in pages}
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()

    def row(
        page: DocsPage, origin: str, section: str | None, snippet: str, detail: str = ""
    ) -> None:
        if (page.id, origin, detail) in seen:
            return
        seen.add((page.id, origin, detail))
        out.append(
            {
                "page_id": page.id,
                "project_id": page.project_id,
                "title": page.title,
                "path": docs_search._path_titles(page, by_id),
                "section": section,
                "snippet": snippet,
                "origin": origin,
                "detail": detail,
                "version": page.version,
            }
        )

    if (
        ticket is not None
        and pages
        and "[[" in " ".join(t for _o, _d, t in _ticket_texts(ticket))
    ):
        headings = await _headings_by_page(session, pages)
        aliases = await _aliases_by_page(session, [p.id for p in pages])
        for origin, detail, body in _ticket_texts(ticket):
            for ref in page_ref_contexts(body) if "[[" in body else []:
                res = await _resolve_page_ref(
                    pages, [], ref["title"], ref["anchor"], headings, aliases
                )
                if res.get("page_id"):
                    row(
                        by_id[res["page_id"]],
                        origin,
                        res.get("section"),
                        ref["context"],
                        detail,
                    )
    links = await session.exec(
        select(DocsLink).where(DocsLink.target_ticket_id == ticket_id)
    )
    for link in links.all():
        src = await session.get(DocsPage, link.source_page_id)
        if src is None or src.deleted_at:
            continue
        by_id.setdefault(src.id, src)
        row(
            src,
            "manual" if link.origin == "manual" else "page",
            link.source_section,
            link.snippet,
        )
    out.sort(key=lambda r: (_ORIGIN_ORDER[r["origin"]], r["title"].lower()))
    return out


async def link_ticket_doc(
    session: AsyncSession, ticket_id: str, page_id: str
) -> dict[str, Any]:
    ticket = await _ticket_or_404(session, ticket_id)
    page = await get_page(session, page_id)
    if page.project_id != ticket.project_id:
        raise DocsError(
            422, "bad_project", "The page and the ticket belong to different projects"
        )
    existing = await session.exec(
        select(DocsLink).where(
            DocsLink.source_page_id == page.id,
            DocsLink.target_ticket_id == ticket_id,
            DocsLink.origin == "manual",
        )
    )
    if existing.first() is None:
        session.add(
            DocsLink(
                source_page_id=page.id,
                target_ticket_id=ticket_id,
                origin="manual",
                snippet="",
            )
        )
        await session.commit()
    rows = await docs_for_ticket(session, ticket_id)
    return next(r for r in rows if r["page_id"] == page.id and r["origin"] == "manual")


async def unlink_ticket_doc(
    session: AsyncSession, ticket_id: str, page_id: str
) -> dict[str, Any]:
    await _ticket_or_404(session, ticket_id)
    rows = await session.exec(
        select(DocsLink).where(
            DocsLink.source_page_id == page_id,
            DocsLink.target_ticket_id == ticket_id,
            DocsLink.origin == "manual",
        )
    )
    removed = 0
    for link in rows.all():
        await session.delete(link)
        removed += 1
    await session.commit()
    return {"removed": removed}


# ---------------------------------------------------------------------------
# Rename preview and delete preview
# ---------------------------------------------------------------------------

_NOT_LINKABLE = re.compile(r"[\[\]|#]")


async def _links_to_rename(
    session: AsyncSession, page: DocsPage, old_title: str
) -> list[dict[str, Any]]:
    """Other pages whose published text or drafts hold [[old_title]] links that resolve to ``page``."""
    pages = await _all_pages(session, page.project_id)
    res = await _resolve_page_ref(pages, [], old_title, None, {})
    if res.get("page_id") != page.id:
        return []  # another page with the same title wins that link; nothing to repoint
    others = [p for p in pages if p.id != page.id]
    contents = await docs_search._contents(
        session, [p for p in others if p.version > 0]
    )
    drafts = await session.exec(
        select(DocsDraft).where(DocsDraft.page_id.in_([p.id for p in others] or [""]))  # type: ignore[attr-defined]
    )
    drafts_by_page: dict[str, list[DocsDraft]] = {}
    for d in drafts.all():
        drafts_by_page.setdefault(d.page_id, []).append(d)
    out = []
    for p in others:
        published = (
            count_page_links(contents.get(p.id, ""), old_title) if p.version > 0 else 0
        )
        in_drafts = max(
            (
                count_page_links(d.markdown, old_title)
                for d in drafts_by_page.get(p.id, [])
            ),
            default=0,
        )
        count = published if p.version > 0 else in_drafts
        if published or in_drafts:
            out.append(
                {
                    "page": p,
                    "published": published,
                    "drafts": drafts_by_page.get(p.id, []),
                    "count": count or in_drafts,
                }
            )
    return out


async def rename_preview(
    session: AsyncSession, page_id: str, title: str
) -> dict[str, Any]:
    page = await get_page(session, page_id)
    new_title = _clean_title(title)
    if new_title == page.title:
        return {"affected_pages": [], "total": 0}
    affected = await _links_to_rename(session, page, page.title)
    rows = [
        {"page_id": a["page"].id, "title": a["page"].title, "count": a["count"]}
        for a in affected
    ]
    rows.sort(key=lambda r: r["title"].lower())
    return {"affected_pages": rows, "total": sum(r["count"] for r in rows)}


async def rename_page(
    session: AsyncSession, page_id: str, title: str, *, rewrite_links: bool = False
) -> dict[str, Any]:
    page = await get_page(session, page_id)
    new_title = _clean_title(title)
    old_title = page.title
    actor = activity.current_actor()
    affected: list[dict[str, Any]] = []
    if rewrite_links and new_title != old_title:
        if _NOT_LINKABLE.search(new_title):
            raise DocsError(
                422,
                "title_not_linkable",
                "A title with [, ], | or # cannot be written as a [[link]]; rename without updating links",
            )
        affected = await _links_to_rename(session, page, old_title)
    page.title = new_title
    page.updated_at = _now()
    page.updated_by = actor
    session.add(page)
    draft = await _draft_for(session, page.id, actor)
    if draft:
        draft.title = page.title
        session.add(draft)
    await session.flush()
    rewritten_links = rewritten_pages = 0
    touched = [page.id]
    for item in affected:
        src: DocsPage = item["page"]
        old_version, published_n = src.version, 0
        if src.version > 0:
            latest = await _latest_version(session, src)
            if latest is not None:
                new_md, published_n = rewrite_page_links(
                    latest.markdown, old_title, new_title
                )
                if published_n:
                    await _commit_version(
                        session,
                        src,
                        new_md,
                        src.title,
                        actor,
                        f'Link to "{new_title}" updated',
                        None,
                        commit=False,
                    )
        draft_n = 0
        for d in item["drafts"]:
            new_md, n = rewrite_page_links(d.markdown, old_title, new_title)
            if not n:
                continue
            draft_n = max(draft_n, n)
            if published_n and d.base_version == old_version:
                d.base_version = (
                    src.version
                )  # the rewrite is in this draft too: no false conflict
            d.markdown = new_md
            session.add(d)
        if published_n or draft_n:
            rewritten_links += published_n or draft_n
            rewritten_pages += 1
            touched.append(src.id)
    await refresh_link_targets(session, page.project_id)
    await docs_search.reindex(session, touched)
    await session.commit()
    detail = await page_detail(session, page_id)
    return {**detail, "rewritten": rewritten_links, "rewritten_pages": rewritten_pages}


async def delete_preview(session: AsyncSession, page_id: str) -> dict[str, Any]:
    page = await get_page(session, page_id)
    subtree = await _descendants(session, page)
    ids = {page.id, *(p.id for p in subtree)}
    rows = await session.exec(
        select(DocsLink.source_page_id).where(
            DocsLink.target_page_id.in_(list(ids)),  # type: ignore[attr-defined]
            DocsLink.origin == "page",
        )
    )
    linking = {sid for sid in rows.all() if sid not in ids}
    live = 0
    for sid in linking:
        src = await session.get(DocsPage, sid)
        if src is not None and not src.deleted_at:
            live += 1
    return {
        "pages": [
            {"id": page.id, "title": page.title, "role": "this"},
            *(
                {"id": p.id, "title": p.title, "role": "child"}
                for p in sorted(subtree, key=lambda p: (p.position, p.title))
            ),
        ],
        "linking_pages": live,
    }
