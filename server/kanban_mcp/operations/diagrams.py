"""Diagram operations: draw.io drawings that sit in markdown as ``[label](diagram:dg_xxxxxxxx)``.

An agent works on the ``.drawio`` file itself: export it to a local path, edit it with its own file tools, save it back.
"""

import services.diagrams as svc_diagrams
from pydantic import Field
from typing import Annotated
from .. import common
from ..common import ProjectId, notify_on_success

DiagramId = Annotated[
    str,
    Field(
        description="Diagram id 'dg_xxxxxxxx' (the id inside `(diagram:dg_xxxxxxxx)` in a text)."
    ),
]
LocalPath = Annotated[
    str, Field(description="Absolute path of a local .drawio file (XML).")
]
SvgPath = Annotated[
    str | None,
    Field(
        description="Absolute path of an SVG export of the drawing, used as the preview. Without it the server draws a plain preview (boxes, arrows, text)."
    ),
]


def _error(exc: "svc_diagrams.DocsError") -> ValueError:
    hint = (
        " Export the diagram again, re-apply your change on the new version, and save it."
        if exc.code == "diagram_conflict"
        else ""
    )
    return ValueError(f"{exc.message}{hint}")


def _preview_note(out: dict) -> dict:
    """Tell the agent how good the stored picture is."""
    kind = out.get("preview_kind")
    note = {
        "editor": "exact: drawn by the draw.io editor",
        "agent": "your SVG",
        "basic": "plain: boxes, arrows and text only; shapes beyond those show as boxes until someone opens the diagram in the editor and saves",
    }.get(kind or "")
    return {"preview": note} if note else {}


async def list_project_diagrams(project_id: ProjectId) -> list[dict]:
    """List a project's diagrams: [{id, label, version, updated_by, updated_at, summary}]."""
    async with common.async_session() as session:
        try:
            return await svc_diagrams.list_for_agent(session, project_id)
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc


async def export_diagram(
    diagram_id: DiagramId,
    path: Annotated[
        str,
        Field(
            description="Absolute path to write to; a folder gets '<name>.drawio' inside it."
        ),
    ],
    version: Annotated[
        int | None, Field(description="A saved version; default the latest.")
    ] = None,
) -> dict:
    """Write a diagram's .drawio file to a local path. Returns {path, id, label, version, markdown}."""
    async with common.async_session() as session:
        try:
            return await svc_diagrams.export_to_file(
                session, diagram_id, path, version=version
            )
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc


@notify_on_success
async def create_diagram_from_file(
    project_id: ProjectId,
    label: Annotated[
        str, Field(description="Name of the diagram; it is the alt text.")
    ],
    path: LocalPath,
    svg_path: SvgPath = None,
    summary: Annotated[
        str | None, Field(description="Short text summary shown with the image.")
    ] = None,
) -> dict:
    """Create a diagram from a local .drawio file. Returns {id, label, version, markdown}: put `markdown` on its own line in a ticket, comment or Docs page."""
    async with common.async_session() as session:
        try:
            out = await svc_diagrams.create_from_file(
                session,
                project_id,
                label=label,
                path=path,
                svg_path=svg_path,
                summary=summary,
            )
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc
        return {
            **{k: out[k] for k in ("id", "label", "version", "markdown")},
            **_preview_note(out),
        }


@notify_on_success
async def save_diagram_file(
    diagram_id: DiagramId,
    path: LocalPath,
    base_version: Annotated[
        int,
        Field(
            description="`version` from docs_read(diagram); a stale value is rejected."
        ),
    ],
    svg_path: SvgPath = None,
    label: Annotated[str | None, Field(description="New name.")] = None,
) -> dict:
    """Save a local .drawio file as a new version of a diagram. Returns {id, label, version}."""
    async with common.async_session() as session:
        try:
            out = await svc_diagrams.save_from_file(
                session,
                diagram_id,
                path=path,
                base_version=base_version,
                svg_path=svg_path,
                label=label,
            )
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc
        return {**{k: out[k] for k in ("id", "label", "version")}, **_preview_note(out)}


@notify_on_success
async def delete_diagram(diagram_id: DiagramId) -> dict:
    """Unlink a diagram. It is kept and can be restored; texts that reference it show 'Diagram not found'."""
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
        return {k: out[k] for k in ("id", "label", "version")}
