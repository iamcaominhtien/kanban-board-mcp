"""The diagram tools: draw.io drawings in tickets, comments and Docs."""

from .routing import Op, dispatch, params_of
from pydantic import Field
from typing import Annotated, Any, Literal
from .. import operations as ops

DiagramReadAction = Literal["list", "get", "versions", "recycle_bin"]

DIAGRAM_READ_OPS = {
    "list": Op(ops.list_diagrams, ("project_id",)),
    "get": Op(ops.get_diagram, ("diagram_id",), ("version", "include_xml")),
    "versions": Op(ops.list_diagram_versions, ("diagram_id",)),
    "recycle_bin": Op(ops.list_deleted_diagrams, ("project_id",)),
}


async def diagram_read(
    action: Annotated[
        DiagramReadAction, Field(description="What to read; see the tool description.")
    ],
    project_id: Annotated[
        str | None, Field(description="Project UUID (list, recycle_bin).")
    ] = None,
    diagram_id: Annotated[
        str | None,
        Field(
            description="Diagram id 'dg_xxxxxxxx' from `(diagram:dg_xxxxxxxx)` in a text, or list."
        ),
    ] = None,
    version: Annotated[int | None, Field(description="get: an older version.")] = None,
    include_xml: Annotated[
        bool | None, Field(description="get: also the raw .drawio XML (large).")
    ] = None,
) -> dict | list[dict]:
    """Read draw.io diagrams. A text shows one as `[Name](diagram:dg_xxxxxxxx)`. `action`:
    - list: project_id. [{id, label, version, updated_by, updated_at, summary}].
    - get: diagram_id [, version, include_xml]. The first page as {nodes [{id, label, shape, x, y, w, h, fill?, stroke?, parent?}], edges [{id, from, to, label?}], pages, version, markdown}. Pass `version` to diagram_write as base_version.
    - versions: diagram_id. Saved versions, newest first.
    - recycle_bin: project_id. Unlinked diagrams that can be restored."""
    return await dispatch("diagram_read", DIAGRAM_READ_OPS, action, params_of(locals()))


DiagramWriteAction = Literal[
    "create", "edit", "replace", "delete", "restore", "restore_version"
]

DIAGRAM_WRITE_OPS = {
    "create": Op(
        ops.create_diagram,
        ("project_id", "label"),
        ("nodes", "edges", "direction", "xml", "summary"),
    ),
    "edit": Op(
        ops.edit_diagram, ("diagram_id", "base_version", "ops"), ("label", "summary")
    ),
    "replace": Op(
        ops.replace_diagram, ("diagram_id", "base_version", "xml"), ("label",)
    ),
    "delete": Op(ops.delete_diagram, ("diagram_id",)),
    "restore": Op(ops.restore_diagram, ("diagram_id",)),
    "restore_version": Op(ops.restore_diagram_version, ("diagram_id", "version")),
}


async def diagram_write(
    action: Annotated[
        DiagramWriteAction, Field(description="What to do; see the tool description.")
    ],
    project_id: Annotated[
        str | None, Field(description="create: project UUID.")
    ] = None,
    diagram_id: Annotated[
        str | None, Field(description="Diagram id 'dg_xxxxxxxx'.")
    ] = None,
    label: Annotated[
        str | None,
        Field(description="create: name (alt text). edit, replace: new name."),
    ] = None,
    nodes: Annotated[
        list[dict[str, Any]] | None,
        Field(
            description="create: boxes [{id, label, shape?: rect|rounded|ellipse|diamond|cylinder|text, fill?, stroke?, w?, h?}]. Every node needs an id."
        ),
    ] = None,
    edges: Annotated[
        list[dict[str, Any]] | None,
        Field(description="create: arrows [{from, to, label?}] using node ids."),
    ] = None,
    direction: Annotated[
        Literal["LR", "TB"] | None,
        Field(description="create: layout left-to-right (default) or top-to-bottom."),
    ] = None,
    xml: Annotated[
        str | None,
        Field(
            description="create (instead of nodes/edges), replace: a complete .drawio XML."
        ),
    ] = None,
    summary: Annotated[
        str | None,
        Field(description="create, edit: short text summary shown with the image."),
    ] = None,
    base_version: Annotated[
        int | None,
        Field(
            description="edit, replace: the `version` you read with diagram_read(get); a stale value is rejected, so re-read and retry."
        ),
    ] = None,
    ops: Annotated[
        list[dict[str, Any]] | None,
        Field(
            description="edit: operations applied in order, all or nothing: {op:'add_node', id?, label, shape?, x?, y?, w?, h?, fill?, stroke?} | {op:'add_edge', from, to, label?} | {op:'update', id, label?, shape?, x?, y?, w?, h?, fill?, stroke?, from?, to?} | {op:'delete', id} | {op:'layout', direction?: LR|TB}."
        ),
    ] = None,
    version: Annotated[
        int | None, Field(description="restore_version: version number to save again.")
    ] = None,
) -> dict:
    """Write draw.io diagrams. `action`:
    - create: project_id, label, nodes [, edges, direction, summary] or xml. Laid out for you. Returns {id, label, version, markdown}: put `markdown` on its own line in a ticket description, comment or Docs page.
    - edit: diagram_id, base_version, ops [, label, summary]. Changes only what the operations name; the rest of the drawing is kept. A node added without x, y goes to the right of the drawing; use the layout op to tidy. Deleting a node removes its arrows. Edits the first page.
    - replace: diagram_id, base_version, xml [, label]. The whole .drawio source (e.g. one you wrote or converted yourself).
    - delete: diagram_id. Unlinks it (kept, restorable); texts that reference it show "Diagram not found".
    - restore: diagram_id. Brings an unlinked diagram back.
    - restore_version: diagram_id, version. Saves an old version again as a new one.
    A person who opens the diagram sees the full draw.io drawing; the preview made here is simpler."""
    return await dispatch(
        "diagram_write", DIAGRAM_WRITE_OPS, action, params_of(locals())
    )
