"""Docs operations: the wiki-like page tree of a project."""

import services.docs as svc_docs
from pydantic import Field
from typing import Annotated, Literal
from .. import common
from ..common import ProjectId, TicketId, notify_on_success


DocsPageId = Annotated[
    str, Field(description="Docs page id (UUID) from docs_read(action='list').")
]


def _docs_error(exc: "svc_docs.DocsError") -> ValueError:
    hint = (
        " Call docs_read(action='get') again, re-apply your edit on the new version, and retry."
        if exc.code == "conflict"
        else ""
    )
    return ValueError(f"{exc.message}.{hint}")


async def list_docs_pages(project_id: ProjectId) -> list[dict]:
    """List a project's Docs pages as a flat tree: [{id, parent_id, position, title, slug, status, version}]."""
    async with common.async_session() as session:
        try:
            tree = await svc_docs.list_tree(session, project_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return [
            {
                k: n[k]
                for k in (
                    "id",
                    "parent_id",
                    "position",
                    "title",
                    "slug",
                    "status",
                    "version",
                )
            }
            for n in tree
        ]


async def get_docs_page(page_id: DocsPageId) -> dict:
    """Read a Docs page: {title, markdown (latest published), version, headings, referenced_by}. Pass `version` to update_docs_page as `base_version`."""
    async with common.async_session() as session:
        try:
            page = await svc_docs.page_detail(session, page_id)
            links = await svc_docs.backlinks(session, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        keep = (
            "id",
            "project_id",
            "parent_id",
            "title",
            "slug",
            "status",
            "version",
            "markdown",
            "headings",
            "updated_by",
            "updated_at",
        )
        return {k: page[k] for k in keep} | {"referenced_by": links}


@notify_on_success
async def create_docs_page(
    project_id: ProjectId,
    title: Annotated[
        str, Field(description="Page title; body headings start at '##'.")
    ],
    markdown: Annotated[str, Field(description="Initial Markdown body.")] = "",
    parent_id: Annotated[
        str | None, Field(description="Parent page id; omit for a top-level page.")
    ] = None,
) -> dict:
    """Create a Docs page and publish it as v1. Returns {id, title, slug, status, version}."""
    async with common.async_session() as session:
        try:
            page = await svc_docs.create_page(
                session, project_id, title, parent_id=parent_id, markdown=markdown
            )
            page = await svc_docs.publish_page(
                session, page["id"], base_version=0, note="Created via MCP"
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {k: page[k] for k in ("id", "title", "slug", "status", "version")}


@notify_on_success
async def update_docs_page(
    page_id: DocsPageId,
    markdown: Annotated[
        str, Field(description="The full new Markdown body (not a patch).")
    ],
    base_version: Annotated[
        int,
        Field(description="`version` from get_docs_page; a stale value is rejected."),
    ],
    note: Annotated[
        str | None, Field(description="Change note for the page history.")
    ] = None,
    publish: Annotated[
        bool,
        Field(
            description="Publish a new version (default). False only saves an agent draft nobody else sees."
        ),
    ] = True,
    title: Annotated[
        str | None,
        Field(
            description="New page title (renames the page; links to it are rewritten)."
        ),
    ] = None,
) -> dict:
    """Replace a Docs page's Markdown and optionally rename it. Returns {id, title, version, published}."""
    async with common.async_session() as session:
        try:
            if title is not None:
                current = await svc_docs.page_detail(session, page_id)
                if title.strip() != current["title"]:
                    await svc_docs.rename_page(
                        session, page_id, title, rewrite_links=True
                    )
            if publish:
                page = await svc_docs.publish_page(
                    session,
                    page_id,
                    base_version=base_version,
                    note=note,
                    markdown=markdown,
                )
            else:
                page = await svc_docs.save_draft(
                    session, page_id, markdown=markdown, base_version=base_version
                )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {
            "id": page["id"],
            "title": page["title"],
            "version": page["version"],
            "published": publish,
        }


@notify_on_success
async def move_docs_page(
    page_id: DocsPageId,
    parent_id: Annotated[
        str | None,
        Field(description="New parent page id; omit or null for the top level."),
    ] = None,
    after_id: Annotated[
        str | None,
        Field(description="Sibling to place it after; omit to append at the end."),
    ] = None,
) -> dict:
    """Move a Docs page under another page (or to the top level). Moving into itself or its own sub-pages is rejected."""
    async with common.async_session() as session:
        try:
            page = await svc_docs.move_page(
                session, page_id, parent_id=parent_id, after_id=after_id
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {
            "id": page["id"],
            "title": page["title"],
            "parent_id": page["parent_id"],
        }


@notify_on_success
async def duplicate_docs_page(
    page_id: DocsPageId,
    include_children: Annotated[
        bool, Field(description="Also copy the sub-pages.")
    ] = False,
    title: Annotated[
        str | None, Field(description="Title of the copy; default '<title> (copy)'.")
    ] = None,
) -> dict:
    """Copy a Docs page as a new draft (no history). Returns the copy {id, title, slug, status}."""
    async with common.async_session() as session:
        try:
            page = await svc_docs.duplicate_page(
                session, page_id, title=title, include_children=include_children
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {k: page[k] for k in ("id", "title", "slug", "status")}


@notify_on_success
async def delete_docs_page(page_id: DocsPageId) -> dict:
    """Soft-delete a Docs page and its sub-pages into the Recycle Bin (kept 30 days; restore_docs_page undoes it)."""
    async with common.async_session() as session:
        try:
            return await svc_docs.delete_page(session, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


@notify_on_success
async def restore_docs_page(page_id: DocsPageId) -> dict:
    """Restore a deleted Docs page (with the sub-pages deleted together with it) from the Recycle Bin."""
    async with common.async_session() as session:
        try:
            return await svc_docs.restore_page(session, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


async def list_docs_recycle_bin(project_id: ProjectId) -> list[dict]:
    """List deleted Docs pages still in the Recycle Bin: [{id, title, page_count, deleted_at, deleted_by, days_left}]."""
    async with common.async_session() as session:
        try:
            return await svc_docs.list_deleted(session, project_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


async def list_docs_versions(page_id: DocsPageId) -> list[dict]:
    """List a Docs page's published versions, newest first: [{version, author, note, created_at, words}]."""
    async with common.async_session() as session:
        try:
            return await svc_docs.list_versions(session, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


async def get_docs_version(
    page_id: DocsPageId,
    version: Annotated[
        int, Field(description="Version number from list_docs_versions.")
    ],
    compare_to: Annotated[
        int | None,
        Field(
            description="Another version number: returns a line diff `version` -> `compare_to` instead."
        ),
    ] = None,
) -> dict:
    """Read one old version of a Docs page (markdown), or a line diff between two versions."""
    async with common.async_session() as session:
        try:
            if compare_to is not None:
                return await svc_docs.diff_versions(
                    session, page_id, version, compare_to
                )
            return await svc_docs.get_version(session, page_id, version)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


@notify_on_success
async def restore_docs_version(
    page_id: DocsPageId,
    version: Annotated[int, Field(description="Version number to restore.")],
) -> dict:
    """Publish an old version of a Docs page again as a new version (history is kept). Returns {id, title, version}."""
    async with common.async_session() as session:
        try:
            page = await svc_docs.restore_version(session, page_id, version)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {"id": page["id"], "title": page["title"], "version": page["version"]}


async def resolve_docs_links(
    project_id: ProjectId,
    refs: Annotated[
        list[str],
        Field(
            description="References to check: '[[Page]]', '[[Page#Section]]' or a ticket key like 'IAM-12'."
        ),
    ],
) -> list[dict]:
    """Check whether [[page]] / ticket references resolve: status ok, missing, section_missing, in_bin or ambiguous."""
    from services.docs import parse_references

    parsed: list[dict] = []
    for ref in refs:
        found = parse_references(ref if ref.startswith("[[") else f"{ref}")
        if not found:
            raise ValueError(f"'{ref}' is not a [[Page]] link or a ticket key")
        item = found[0]
        parsed.append(
            {"kind": "page", "title": item["title"], "anchor": item["anchor"]}
            if item["kind"] == "page"
            else {"kind": "ticket", "key": item["key"]}
        )
    async with common.async_session() as session:
        try:
            return await svc_docs.resolve_refs(session, project_id, parsed)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


async def search_docs(
    project_id: ProjectId,
    query: Annotated[
        str,
        Field(
            description='Words are AND-ed; "a b" is a phrase; -word excludes; a ticket key finds pages mentioning it.'
        ),
    ],
    scope: Annotated[
        Literal["space", "all", "tickets"],
        Field(
            description="This project's docs, docs of all projects, or tickets only."
        ),
    ] = "space",
    limit: Annotated[int, Field(description="Max results (default 10).")] = 10,
) -> dict:
    """Full-text search over Docs pages (title, headings, body) with snippets. Returns {total, pages, tickets}."""
    from services import docs_search

    async with common.async_session() as session:
        try:
            res = await docs_search.search(
                session, project_id, query, scope=scope, limit=limit
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {k: res[k] for k in ("total", "pages", "tickets") if k in res}


@notify_on_success
async def import_docs(
    project_id: ProjectId,
    path: Annotated[
        str,
        Field(
            description="Absolute path of a .md/.markdown file or a folder (folders become a page tree)."
        ),
    ],
    parent_id: Annotated[
        str | None, Field(description="Parent page id; omit for the top level.")
    ] = None,
) -> dict:
    """Import local Markdown files as new Docs pages (drafts), keeping folders as a tree. Returns {created, failed}."""
    from pathlib import Path

    from services import docs_import

    root = Path(path).expanduser()
    if not root.exists():
        raise ValueError(f"Path not found: {path}")
    files: list[tuple[str, bytes]] = []
    candidates = [root] if root.is_file() else sorted(root.rglob("*"))
    for f in candidates:
        if f.is_file() and f.suffix.lower() in {".md", ".markdown"}:
            rel = f.name if root.is_file() else str(f.relative_to(root))
            files.append((rel, f.read_bytes()[: docs_import.MAX_FILE_BYTES + 1]))
    if not files:
        raise ValueError("No .md or .markdown files found at that path")
    async with common.async_session() as session:
        try:
            return await docs_import.run_import(
                session, project_id, files, parent_id=parent_id
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


@notify_on_success
async def link_ticket_doc(ticket_id: TicketId, page_id: DocsPageId) -> dict:
    """Link a Docs page to a ticket manually (shown under 'Linked docs' on the ticket)."""
    async with common.async_session() as session:
        try:
            return await svc_docs.link_ticket_doc(session, ticket_id, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


@notify_on_success
async def unlink_ticket_doc(ticket_id: TicketId, page_id: DocsPageId) -> dict:
    """Remove a manual link between a Docs page and a ticket."""
    async with common.async_session() as session:
        try:
            return await svc_docs.unlink_ticket_doc(session, ticket_id, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
