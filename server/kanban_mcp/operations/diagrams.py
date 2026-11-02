"""Diagram operations: draw.io drawings that sit in markdown as ``[label](diagram:dg_xxxxxxxx)``.

An agent works on the ``.drawio`` file itself: export it to a local path, edit it with its own file tools, save it back.
"""

from pathlib import Path

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
        str | None,
        Field(
            description="Absolute path to write the .drawio file to; a folder gets '<name>.drawio' inside it. Omit to read the model only."
        ),
    ] = None,
    version: Annotated[
        int | None, Field(description="A saved version; default the latest.")
    ] = None,
) -> dict:
    """Read a diagram as a model (shapes, links, labels, boxes, styles, problems), and with `path` write its .drawio
    file there to edit. Returns {id, label, version, markdown, model[, path]}."""
    from services import diagram_model

    async with common.async_session() as session:
        try:
            d = await svc_diagrams.get_diagram(
                session, diagram_id, version=version, include_source=True
            )
            await _same_project(d.get("project_id"))
            out = (
                await svc_diagrams.export_to_file(
                    session, diagram_id, path, version=version
                )
                if path
                else {
                    "id": d["id"],
                    "label": d["label"],
                    "version": d["version"],
                    "markdown": f"[{d['label']}](diagram:{d['id']})",
                }
            )
            try:
                out["model"] = diagram_model.model(d["source"])
            except svc_diagrams.DocsError as exc:
                out["model"] = {"error": exc.message}
            return out
        except svc_diagrams.DocsError as exc:
            raise _error(exc) from exc


async def _same_project(project_id: str | None) -> None:
    """An AI run may only read diagrams of the project it works in."""
    from services.ai import guard

    ctx = guard.current()
    if ctx is not None and project_id and project_id != ctx.project_id:
        raise ValueError(
            "That diagram belongs to another project than this run works in, so it was left alone."
        )


def _problems(path: str) -> dict:
    """What will look broken in the saved file (links to nothing, overlaps), as a hint after a save."""
    from services import diagram_model

    try:
        found = diagram_model.problems(
            diagram_model.Drawing(Path(path).read_text("utf-8"))
        )
    except (OSError, UnicodeDecodeError, svc_diagrams.DocsError):
        return {}
    if not found:
        return {}
    return {
        "problems": found,
        "fix": "Saved as it is. Fix these in the file and save again (docs_write diagram_save with the new version).",
    }


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
            **_problems(path),
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
        return {
            **{k: out[k] for k in ("id", "label", "version")},
            **_preview_note(out),
            **_problems(path),
        }


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
