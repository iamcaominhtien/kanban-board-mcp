"""The Docs tools: reading and writing a project's page tree."""

from .routing import Op, batch, dispatch, params_of
from pydantic import Field
from typing import Annotated, Literal
from .. import operations as ops


PageId = Annotated[
    str | None, Field(description="Docs page id (UUID) from docs_read(action='list').")
]

DocsReadAction = Literal[
    "list",
    "get",
    "search",
    "versions",
    "version",
    "recycle_bin",
    "check_links",
    "comments",
    "diagrams",
    "diagram",
    "sketches",
    "sketch",
    "canvases",
    "canvas",
    "design_guide",
    "permissions_guide",
]

DOCS_READ_OPS = {
    "list": Op(ops.list_docs_pages, ("project_id",)),
    "get": Op(ops.get_docs_page, ("page_id",)),
    "search": Op(ops.search_docs, ("project_id", "query"), ("scope", "limit")),
    "versions": Op(ops.list_docs_versions, ("page_id",)),
    "version": Op(ops.get_docs_version, ("page_id", "version"), ("compare_to",)),
    "recycle_bin": Op(ops.list_docs_recycle_bin, ("project_id",)),
    "check_links": Op(ops.resolve_docs_links, ("project_id", "refs")),
    "comments": Op(ops.list_docs_comments, ("page_id",), ("state",)),
    "diagrams": Op(ops.list_project_diagrams, ("project_id",)),
    "diagram": Op(ops.export_diagram, ("diagram_id", "path"), ("version",)),
    "sketches": Op(ops.list_project_sketches, ("project_id",)),
    "sketch": Op(ops.export_sketch, ("sketch_id", "path")),
    "canvases": Op(ops.list_project_canvases, ("project_id",)),
    "canvas": Op(ops.read_canvas, ("canvas_id",), ("board_id", "path")),
    "design_guide": Op(ops.design_guide, ()),
    "permissions_guide": Op(ops.permissions_guide, ()),
}


async def docs_read(
    action: Annotated[
        DocsReadAction, Field(description="What to read; see the tool description.")
    ],
    project_id: Annotated[
        str | None,
        Field(
            description="Project UUID from get_projects (list, search, recycle_bin, check_links, diagrams, sketches, canvases)."
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
        Field(
            description="version: version number from the `versions` action. diagram: an older diagram version."
        ),
    ] = None,
    diagram_id: Annotated[
        str | None,
        Field(
            description="diagram, diagram_save, diagram_delete, diagram_restore: id 'dg_xxxxxxxx' from `(diagram:dg_xxxxxxxx)` in a text."
        ),
    ] = None,
    path: Annotated[
        str | None,
        Field(
            description="diagram: absolute path to write the .drawio file to (a folder gets '<name>.drawio' inside it). sketch: absolute folder (gets '<name>.png' and '<name>.sketch.json') or a '.png' path. canvas: folder to write a frame's files to."
        ),
    ] = None,
    sketch_id: Annotated[
        str | None,
        Field(
            description="sketch, sketch_save: id 'sk_xxxxxxxx' from `(sketch:sk_xxxxxxxx)` in a text."
        ),
    ] = None,
    canvas_id: Annotated[
        str | None,
        Field(description="canvas: id 'cv_xxxxxxxx'."),
    ] = None,
    board_id: Annotated[
        str | None,
        Field(description="canvas: frame id 'b_xxxxxxxx' to read the source of."),
    ] = None,
    compare_to: Annotated[
        int | None,
        Field(
            description="version: another version number; returns a line diff `version` -> `compare_to` instead."
        ),
    ] = None,
    state: Annotated[
        Literal["all", "open", "resolved"] | None,
        Field(description="comments: inline threads to list (default all)."),
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
    - check_links: project_id, refs. Whether [[page]] / ticket references resolve: ok, missing, section_missing, in_bin or ambiguous.
    - comments: page_id [, state]. {threads: [{id, kind: inline|page, status, quote, anchor_state, comments: [{id, author, body}]}], counts}.
    - diagrams: project_id. draw.io diagrams: [{id, label, version, updated_by, updated_at, summary}]. A text shows one as `[Name](diagram:dg_xxxxxxxx)`.
    - diagram: diagram_id, path [, version]. Writes the diagram's .drawio file (XML) to `path`: edit it with your own file tools, then docs_write(diagram_save). Returns {path, version, markdown}.
    - sketches: project_id. Freehand sketches: [{id, title, owner_kind, owner_id, version, width, height, layers, updated_by, updated_at, markdown}]. A text shows one as `![Name](sketch:sk_xxxxxxxx)`.
    - sketch: sketch_id, path. Writes the sketch's PNG and its editable .sketch.json (JSON; layers as PNG data URLs) to local files, then docs_write(sketch_save). Returns {png_path, source_path, version, width, height, layers, markdown}.
    - canvases: project_id. Canvases (frames on one plane): [{id, title, version, boards, updated_by, markdown}]; in a text: `![Name](canvas:cv_xxxxxxxx)`.
    - canvas: canvas_id [, board_id, path]. {boards, notes, arrows, labels, comments, proposals, locks}; with board_id also that frame's source (path: write its files to a folder to edit, then docs_write(canvas_propose)).
    - design_guide: {guide, craft, examples}, the canvas design guide, how to keep a design from looking machine-made, and the folder of its exemplar boards; read them before designing.
    - permissions_guide: {guide, you}: what you may do; read it when refused."""
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
    "comment",
    "reply",
    "edit_comment",
    "delete_comment",
    "resolve",
    "reopen",
    "diagram_create",
    "diagram_save",
    "diagram_delete",
    "diagram_restore",
    "sketch_create",
    "sketch_save",
    "canvas_create",
    "canvas_comment",
    "canvas_propose",
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
    "comment": Op(ops.add_docs_comment, ("page_id", "body"), ("quote",)),
    "reply": Op(ops.reply_docs_comment, ("thread_id", "body")),
    "edit_comment": Op(ops.edit_docs_comment, ("comment_id", "body")),
    "delete_comment": Op(ops.delete_docs_comment, ("comment_id",)),
    "resolve": Op(ops.resolve_docs_comment, ("thread_id",)),
    "reopen": Op(ops.reopen_docs_comment, ("thread_id",)),
    "diagram_create": Op(
        ops.create_diagram_from_file,
        ("project_id", "title", "path"),
        ("svg_path", "summary"),
        rename={"title": "label"},
    ),
    "diagram_save": Op(
        ops.save_diagram_file,
        ("diagram_id", "path", "base_version"),
        ("svg_path", "title"),
        rename={"title": "label"},
    ),
    "diagram_delete": Op(ops.delete_diagram, ("diagram_id",)),
    "diagram_restore": Op(ops.restore_diagram, ("diagram_id",)),
    "sketch_create": Op(
        ops.create_sketch_from_files,
        ("owner_kind", "owner_id", "title", "path"),
        ("source_path",),
    ),
    "sketch_save": Op(
        ops.save_sketch_files,
        ("sketch_id", "path", "base_version"),
        ("source_path", "title"),
    ),
    "canvas_create": Op(
        ops.create_canvas_from_files,
        ("path",),
        ("owner_kind", "owner_id", "title", "canvas_id"),
    ),
    "canvas_comment": Op(
        ops.comment_on_canvas,
        ("canvas_id", "body"),
        ("board_id", "thread_id", "at"),
    ),
    "canvas_propose": Op(
        ops.propose_canvas_change,
        ("canvas_id", "board_id", "path"),
        ("note",),
    ),
}


# The light actions that take `items`; page, file and diagram work is one call each
_BATCH_ACTIONS = {"comment", "reply", "resolve", "reopen"}


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
            description="create: page title (body headings start at '##'). update: new title (renames the page; links to it are rewritten). duplicate: title of the copy (default '<title> (copy)'). sketch_create, sketch_save, canvas_create: name of the sketch or canvas."
        ),
    ] = None,
    markdown: Annotated[
        str | None,
        Field(
            description="create: initial body. update: the FULL new Markdown body (not a patch). In an AI run, a picture may be named by its path in your working folder (![TC-1](qa/evidence/TC-1.png); the file must exist): the board keeps a copy and rewrites it to /uploads/…. So is [a document](a/b.xlsx)."
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
            description="update: the `version` you read with docs_read(get). diagram_save: from docs_read(diagram). sketch_save: from docs_read(sketch). A stale value is rejected, so re-read and retry."
        ),
    ] = None,
    note: Annotated[
        str | None,
        Field(
            description="update: change note for the page history. canvas_propose: what you changed."
        ),
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
    body: Annotated[
        str | None,
        Field(
            description="comment, reply, edit_comment, canvas_comment: comment text (Markdown; @Name mentions a member)."
        ),
    ] = None,
    quote: Annotated[
        str | None,
        Field(
            description="comment: exact page text to attach to (within one block); omit to comment on the page."
        ),
    ] = None,
    thread_id: Annotated[
        str | None,
        Field(description="reply, resolve, reopen, canvas_comment: thread id."),
    ] = None,
    comment_id: Annotated[
        str | None,
        Field(description="edit_comment, delete_comment: comment id."),
    ] = None,
    path: Annotated[
        str | None,
        Field(
            description="import: absolute path of a .md/.markdown file or a folder (folders become a page tree). diagram_create, diagram_save: absolute path of a .drawio file. sketch_create, sketch_save: absolute path of the .png (at most 4096 px and 10 MB). canvas_propose: folder with the frame's files."
        ),
    ] = None,
    diagram_id: Annotated[
        str | None,
        Field(
            description="diagram_save, diagram_delete, diagram_restore: diagram id 'dg_xxxxxxxx'."
        ),
    ] = None,
    svg_path: Annotated[
        str | None,
        Field(
            description="diagram_create, diagram_save: absolute path of an SVG export of the drawing, used as the preview (default: the server draws a plain one)."
        ),
    ] = None,
    summary: Annotated[
        str | None,
        Field(description="diagram_create: short text summary shown with the image."),
    ] = None,
    sketch_id: Annotated[
        str | None,
        Field(description="sketch_save: sketch id 'sk_xxxxxxxx'."),
    ] = None,
    source_path: Annotated[
        str | None,
        Field(
            description="sketch_create, sketch_save: absolute path of the .sketch.json (format 'kanban-sketch', version 1; at most 10 layers, 10 MB; width and height equal to the PNG's). Without it the PNG becomes one picture layer on a white page."
        ),
    ] = None,
    owner_kind: Annotated[
        Literal["ticket", "doc", "idea"] | None,
        Field(
            description="sketch_create: ticket or doc (a Docs page). canvas_create: ticket, doc or idea."
        ),
    ] = None,
    owner_id: Annotated[
        str | None,
        Field(
            description="sketch_create, canvas_create: ticket id 'IAM-12', Docs page id (UUID) or idea id."
        ),
    ] = None,
    canvas_id: Annotated[
        str | None,
        Field(
            description="canvas_comment, canvas_propose: canvas id. canvas_create: add frames to it instead of making a new canvas."
        ),
    ] = None,
    board_id: Annotated[
        str | None,
        Field(
            description="canvas_propose: the HTML frame to change. canvas_comment: pin to this frame."
        ),
    ] = None,
    at: Annotated[
        str | None,
        Field(
            description="canvas_comment (needs board_id): pin on an element: CSS selector or 'text=Add task'."
        ),
    ] = None,
    items: Annotated[
        list[dict] | None,
        Field(
            description="comment, reply, resolve, reopen: many at once (max 25): one object of parameters per call; the other arguments apply to all. In order; failures are reported per item."
        ),
    ] = None,
) -> dict:
    """Write a project's Docs. `action`:
    - create: project_id, title [, markdown, parent_id]. Published as v1. Returns {id, title, slug, status, version}.
    - update: page_id, markdown, base_version [, note, publish, title]. Replaces the whole body; may rename. Returns {id, title, version, published}.
    - move: page_id [, parent_id, after_id]. Under another page or to the top level (not into itself or its sub-pages).
    - duplicate: page_id [, include_children, title]. A new draft copy. Returns {id, title, slug, status}.
    - delete: page_id. Moves the page and its sub-pages to the Recycle Bin (30 days).
    - restore: page_id. Brings a deleted page and its sub-pages back.
    - restore_version: page_id, version. Publishes an old version again as a new one. Returns {id, title, version}.
    - import: project_id, path [, parent_id]. Local Markdown files become draft pages, folders a tree. Returns {created, failed}.
    - comment: page_id, body [, quote]. A comment on quoted text or the whole page. Returns the thread.
    - reply: thread_id, body. Reply in a thread.
    - edit_comment [, body] / delete_comment: comment_id. Own comments only; deleting a thread's first comment removes it.
    - resolve / reopen: thread_id (inline threads).
    - diagram_create: project_id, title, path [, svg_path, summary]. A new diagram from a local .drawio file. Returns {id, label, version, markdown}: put `markdown` on its own line in a ticket, comment or Docs page.
    - diagram_save: diagram_id, path, base_version [, svg_path, title]. Saves the edited .drawio file as a new version; base_version is the `version` from docs_read(diagram), a stale one is rejected. Returns {id, label, version}.
    - diagram_delete / diagram_restore: diagram_id. Unlink a diagram (kept, restorable) / bring it back.
    - sketch_create: owner_kind (ticket|doc), owner_id, title, path [, source_path]. A new sketch from a local PNG and its .sketch.json. Returns {id, title, version, markdown}: put `markdown` on its own line in a ticket, comment or Docs page.
    - sketch_save: sketch_id, path, base_version [, source_path, title]. Saves the PNG and source as a new version; base_version is the `version` from docs_read(sketch), a stale one is rejected. Returns {id, title, version}. The PNG is what the text shows, so keep it the flattened picture of the source.
    - canvas_create: path [, owner_kind (ticket|doc|idea), owner_id, title | canvas_id]. A new canvas, or frames added to canvas_id, from a folder: one sub-folder with an .html page per frame (name order); optional frame.json, canvas.json (see the design guide). Returns {id, markdown, boards}: put `markdown` on its own line in the text.
    - canvas_comment: canvas_id, body [, board_id, at, thread_id]. Comment under your own name: pin on an element (at) of a frame, the plane, or reply. You never resolve a person's thread.
    - canvas_propose: canvas_id, board_id, path [, note]. Offer a changed HTML frame from a folder (see docs_read(canvas)). Nothing changes until a person accepts; a frame being edited waits.
    Link pages with [[Title#Section]] and tickets by key (IAM-12) in the Markdown."""
    given = params_of(locals())
    many = given.pop("items", None)
    if many is not None:
        if action not in _BATCH_ACTIONS:
            raise ValueError(
                f"docs_write: items only works with {', '.join(sorted(_BATCH_ACTIONS))}."
            )
        return await batch(
            lambda extra: dispatch(
                "docs_write", DOCS_WRITE_OPS, action, {**given, **extra}
            ),
            many,
        )
    return await dispatch("docs_write", DOCS_WRITE_OPS, action, given)
