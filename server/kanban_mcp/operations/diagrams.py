"""Diagram operations: draw.io drawings that sit in markdown as ``[label](diagram:dg_xxxxxxxx)``."""

import services.diagrams as svc_diagrams
from pydantic import Field
from typing import Annotated, Any, Literal
from .. import common
from ..common import ProjectId, notify_on_success

DiagramId = Annotated[
    str,
    Field(
        description="Diagram id 'dg_xxxxxxxx' (the id inside `(diagram:dg_xxxxxxxx)`)."
    ),
]


def _error(exc: "svc_diagrams.DocsError") -> ValueError:
    hint = {
        "diagram_conflict": " Call diagram_read(action='get') again, re-apply your change on the new version, and retry.",
        "invalid_diagram_edit": " Nothing was changed.",
    }.get(exc.code, "")
    return ValueError(f"{exc.message}{hint}")


def _brief(d: dict) -> dict:
    keys = ("id", "label", "version", "updated_by", "updated_at", "summary")
    return {k: d[k] for k in keys if k in d}


async def list_diagrams(project_id: ProjectId) -> list[dict]:
    """List a project's diagrams: [{id, label, version, updated_by, updated_at, summary}]."""
    async with common.async_session() as session:
        try:
            return [
                _brief(d) for d in await svc_diagrams.list_diagrams(session, project_id)
            ]
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc


async def list_deleted_diagrams(project_id: ProjectId) -> list[dict]:
    """List a project's unlinked diagrams (kept so they can be restored)."""
    async with common.async_session() as session:
        try:
            rows = await svc_diagrams.list_diagrams(session, project_id, deleted=True)
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc
        return [{**_brief(d), "deleted_at": d["deleted_at"]} for d in rows]


async def get_diagram(
    diagram_id: DiagramId,
    version: Annotated[
        int | None, Field(description="A saved version; default the latest.")
    ] = None,
    include_xml: Annotated[
        bool, Field(description="Also return the raw .drawio XML (large).")
    ] = False,
) -> dict:
    """Read a diagram: {id, label, version, markdown, pages, nodes, edges, xml?}. Pass its `version` to diagram_write as base_version."""
    async with common.async_session() as session:
        try:
            return await svc_diagrams.read_outline(
                session, diagram_id, version=version, include_xml=include_xml
            )
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc


async def list_diagram_versions(diagram_id: DiagramId) -> list[dict]:
    """List a diagram's saved versions, newest first: [{version, author, note, created_at, size_bytes}]."""
    async with common.async_session() as session:
        try:
            return await svc_diagrams.list_versions(session, diagram_id)
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc


@notify_on_success
async def create_diagram(
    project_id: ProjectId,
    label: Annotated[
        str, Field(description="Name of the diagram; it is the alt text.")
    ],
    nodes: Annotated[
        list[dict[str, Any]] | None,
        Field(description="Boxes: [{id, label, shape?, fill?, stroke?}]."),
    ] = None,
    edges: Annotated[
        list[dict[str, Any]] | None,
        Field(description="Arrows: [{from, to, label?}] between node ids."),
    ] = None,
    direction: Annotated[
        Literal["LR", "TB"],
        Field(description="Layout: left-to-right or top-to-bottom."),
    ] = "LR",
    xml: Annotated[
        str | None, Field(description="Instead of nodes/edges: a complete .drawio XML.")
    ] = None,
    summary: Annotated[
        str | None, Field(description="Short text summary shown with the image.")
    ] = None,
) -> dict:
    """Create a diagram. Returns {id, label, version, markdown}; put `markdown` on its own line in a ticket, comment or Docs page."""
    async with common.async_session() as session:
        try:
            out = await svc_diagrams.agent_create(
                session,
                project_id,
                label=label,
                nodes=nodes,
                edges=edges,
                direction=direction,
                xml=xml,
                summary=summary,
            )
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc
        return {k: out[k] for k in ("id", "label", "version", "markdown")}


@notify_on_success
async def edit_diagram(
    diagram_id: DiagramId,
    base_version: Annotated[
        int, Field(description="`version` from get_diagram; a stale value is rejected.")
    ],
    ops: Annotated[
        list[dict[str, Any]],
        Field(description="Operations applied in order; all or nothing."),
    ],
    label: Annotated[str | None, Field(description="New name.")] = None,
    summary: Annotated[str | None, Field(description="New text summary.")] = None,
) -> dict:
    """Edit a diagram with operations. Returns {id, label, version, added}."""
    async with common.async_session() as session:
        try:
            out = await svc_diagrams.agent_edit(
                session,
                diagram_id,
                base_version=base_version,
                ops=ops,
                label=label,
                summary=summary,
            )
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc
        return {k: out[k] for k in ("id", "label", "version", "added")}


@notify_on_success
async def replace_diagram(
    diagram_id: DiagramId,
    base_version: Annotated[
        int, Field(description="`version` from get_diagram; a stale value is rejected.")
    ],
    xml: Annotated[str, Field(description="The complete new .drawio XML.")],
    label: Annotated[str | None, Field(description="New name.")] = None,
) -> dict:
    """Replace a diagram's whole drawing. Returns {id, label, version}."""
    async with common.async_session() as session:
        try:
            out = await svc_diagrams.agent_replace(
                session, diagram_id, base_version=base_version, xml=xml, label=label
            )
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc
        return {k: out[k] for k in ("id", "label", "version")}


@notify_on_success
async def delete_diagram(diagram_id: DiagramId) -> dict:
    """Unlink a diagram. It is kept and can be restored; text that references it shows 'Diagram not found'."""
    async with common.async_session() as session:
        try:
            return await svc_diagrams.delete_diagram(session, diagram_id)
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc


@notify_on_success
async def restore_diagram(diagram_id: DiagramId) -> dict:
    """Bring an unlinked diagram back."""
    async with common.async_session() as session:
        try:
            out = await svc_diagrams.restore_diagram(session, diagram_id)
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc
        return _brief(out)


@notify_on_success
async def restore_diagram_version(
    diagram_id: DiagramId,
    version: Annotated[
        int, Field(description="Version to save again (from diagram_read(versions)).")
    ],
) -> dict:
    """Save an old version's drawing again as a new version (history is kept)."""
    async with common.async_session() as session:
        try:
            out = await svc_diagrams.restore_version(session, diagram_id, version)
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc
        return _brief(out)
