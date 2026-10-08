"""The Docs tools: reading and writing a project's page tree."""

from .routing import Op, dispatch, params_of
from pydantic import Field
from typing import Annotated, Literal
from .. import operations as ops


PageId = Annotated[
    str | None, Field(description="Docs page id (UUID) from docs_read(action='list').")
]

DocsReadAction = Literal[
    "list", "get", "search", "versions", "version", "recycle_bin", "check_links"
]

DOCS_READ_OPS = {
    "list": Op(ops.list_docs_pages, ("project_id",)),
    "get": Op(ops.get_docs_page, ("page_id",)),
    "search": Op(ops.search_docs, ("project_id", "query"), ("scope", "limit")),
    "versions": Op(ops.list_docs_versions, ("page_id",)),
    "version": Op(ops.get_docs_version, ("page_id", "version"), ("compare_to",)),
    "recycle_bin": Op(ops.list_docs_recycle_bin, ("project_id",)),
    "check_links": Op(ops.resolve_docs_links, ("project_id", "refs")),
}


async def docs_read(
    action: Annotated[
        DocsReadAction, Field(description="What to read; see the tool description.")
    ],
    project_id: Annotated[
        str | None,
        Field(
            description="Project UUID from get_projects (list, search, recycle_bin, check_links)."
        ),
    ] = None,
    page_id: PageId = None,
    query: Annotated[
        str | None,
        Field(
            description='search: words are AND-ed; "a b" is a phrase; -word excludes; a ticket key finds pages that mention it.'
        ),
    ] = None,
    scope: Annotated[
        Literal["space", "all", "tickets"] | None,
        Field(
            description="search: this project's docs (default), docs of all projects, or tickets only."
        ),
    ] = None,
    limit: Annotated[
        int | None, Field(description="search: max results (default 10).")
    ] = None,
    version: Annotated[
        int | None,
        Field(description="version: version number from the `versions` action."),
    ] = None,
    compare_to: Annotated[
        int | None,
        Field(
            description="version: another version number; returns a line diff `version` -> `compare_to` instead."
        ),
    ] = None,
    refs: Annotated[
        list[str] | None,
        Field(
            description="check_links: references to check: '[[Page]]', '[[Page#Section]]' or a ticket key like 'IAM-12'."
        ),
    ] = None,
) -> dict | list[dict]:
    """Read a project's Docs: a tree of Markdown pages. `action`:
    - list: project_id. The flat page tree [{id, parent_id, position, title, slug, status, version}].
    - get: page_id. {title, markdown (latest published), version, headings, referenced_by}. Pass its `version` to docs_write(update) as base_version.
    - search: project_id, query [, scope, limit]. Full-text search over titles, headings and bodies with snippets: {total, pages, tickets}.
    - versions: page_id. Published versions, newest first: [{version, author, note, created_at, words}].
    - version: page_id, version [, compare_to]. One old version's markdown, or a line diff between two versions.
    - recycle_bin: project_id. Deleted pages still restorable (30 days): [{id, title, page_count, deleted_at, deleted_by, days_left}].
    - check_links: project_id, refs. Whether [[page]] / ticket references resolve: ok, missing, section_missing, in_bin or ambiguous."""
    return await dispatch("docs_read", DOCS_READ_OPS, action, params_of(locals()))


DocsWriteAction = Literal[
    "create",
    "update",
    "move",
    "duplicate",
    "delete",
    "restore",
    "restore_version",
    "import",
]

DOCS_WRITE_OPS = {
    "create": Op(
        ops.create_docs_page, ("project_id", "title"), ("markdown", "parent_id")
    ),
    "update": Op(
        ops.update_docs_page,
        ("page_id", "markdown", "base_version"),
        ("note", "publish", "title"),
    ),
    "move": Op(ops.move_docs_page, ("page_id",), ("parent_id", "after_id")),
    "duplicate": Op(
        ops.duplicate_docs_page, ("page_id",), ("include_children", "title")
    ),
    "delete": Op(ops.delete_docs_page, ("page_id",)),
    "restore": Op(ops.restore_docs_page, ("page_id",)),
    "restore_version": Op(ops.restore_docs_version, ("page_id", "version")),
    "import": Op(ops.import_docs, ("project_id", "path"), ("parent_id",)),
}


async def docs_write(
    action: Annotated[
        DocsWriteAction, Field(description="What to do; see the tool description.")
    ],
    project_id: Annotated[
        str | None,
        Field(description="Project UUID from get_projects (create, import)."),
    ] = None,
    page_id: PageId = None,
    title: Annotated[
        str | None,
        Field(
            description="create: page title (body headings start at '##'). update: new title (renames the page; links to it are rewritten). duplicate: title of the copy (default '<title> (copy)')."
        ),
    ] = None,
    markdown: Annotated[
        str | None,
        Field(
            description="create: initial body. update: the FULL new Markdown body (not a patch)."
        ),
    ] = None,
    parent_id: Annotated[
        str | None,
        Field(
            description="create, import: parent page id (omit for the top level). move: new parent (omit for the top level)."
        ),
    ] = None,
    after_id: Annotated[
        str | None,
        Field(
            description="move: sibling page id to place it after (omit to append at the end)."
        ),
    ] = None,
    base_version: Annotated[
        int | None,
        Field(
            description="update: the `version` you read with docs_read(get); a stale value is rejected, so re-read and retry."
        ),
    ] = None,
    note: Annotated[
        str | None, Field(description="update: change note for the page history.")
    ] = None,
    publish: Annotated[
        bool | None,
        Field(
            description="update: publish a new version (default true). false only saves an agent draft nobody else sees."
        ),
    ] = None,
    include_children: Annotated[
        bool | None, Field(description="duplicate: also copy the sub-pages.")
    ] = None,
    version: Annotated[
        int | None,
        Field(
            description="restore_version: version number to publish again (from docs_read(versions))."
        ),
    ] = None,
    path: Annotated[
        str | None,
        Field(
            description="import: absolute path of a .md/.markdown file or a folder (folders become a page tree)."
        ),
    ] = None,
) -> dict:
    """Write a project's Docs. `action`:
    - create: project_id, title [, markdown, parent_id]. Published as v1. Returns {id, title, slug, status, version}.
    - update: page_id, markdown, base_version [, note, publish, title]. Replaces the whole body and optionally renames. Returns {id, title, version, published}.
    - move: page_id [, parent_id, after_id]. Under another page or to the top level; into itself or its own sub-pages is rejected.
    - duplicate: page_id [, include_children, title]. A new draft copy without history. Returns {id, title, slug, status}.
    - delete: page_id. Soft-delete of the page and its sub-pages into the Recycle Bin (kept 30 days).
    - restore: page_id. Brings a deleted page (with the sub-pages deleted with it) back.
    - restore_version: page_id, version. Publishes an old version again as a new one (history is kept). Returns {id, title, version}.
    - import: project_id, path [, parent_id]. Local Markdown files become new draft pages, folders a tree. Returns {created, failed}.
    Link pages with [[Title#Section]] and tickets by key (IAM-12) in the Markdown."""
    return await dispatch("docs_write", DOCS_WRITE_OPS, action, params_of(locals()))
