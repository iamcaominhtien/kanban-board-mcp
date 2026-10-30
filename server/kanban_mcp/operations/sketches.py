"""Sketch operations: paint-style drawings that sit in markdown as ``![Name](sketch:sk_xxxxxxxx)``.

An agent works on the files: export a sketch to a local PNG and its editable ``.sketch.json`` source, change them with
its own tools (or draw a new PNG), save them back. The format and its limits are in docs/specs/sketch-tool.md.
"""

import services.sketches as svc_sketches
from pydantic import Field
from typing import Annotated, Literal
from .. import common
from ..common import ProjectId, notify_on_success

SketchId = Annotated[
    str,
    Field(
        description="Sketch id 'sk_xxxxxxxx' (the id inside `(sketch:sk_xxxxxxxx)` in a text)."
    ),
]
PngPath = Annotated[
    str,
    Field(description="Absolute path of a local .png file (at most 4096 px, 10 MB)."),
]
SourcePath = Annotated[
    str | None,
    Field(
        description="Absolute path of the editable .sketch.json (format 'kanban-sketch' version 1: at most 4096 px, 10 layers, 10 MB; its width and height must equal the PNG's). Without it the PNG becomes one picture layer on a white page."
    ),
]


def _error(exc: "svc_sketches.DocsError") -> ValueError:
    hint = (
        " Export the sketch again, re-apply your change on the new version, and save it."
        if exc.code == "sketch_conflict"
        else ""
    )
    return ValueError(f"{exc.message}{hint}")


async def _same_project(project_id: str | None) -> None:
    """An AI run may only touch sketches of the project it works in."""
    from services.ai import guard

    ctx = guard.current()
    if ctx is not None and project_id != ctx.project_id:
        raise ValueError(
            "That sketch belongs to another project than this run works in, so it was left alone."
        )


async def list_project_sketches(project_id: ProjectId) -> list[dict]:
    """List a project's sketches: [{id, title, owner_kind, owner_id, version, width, height, layers, updated_by, updated_at, markdown}]."""
    async with common.async_session() as session:
        return await svc_sketches.list_for_agent(session, project_id)


async def export_sketch(
    sketch_id: SketchId,
    path: Annotated[
        str,
        Field(
            description="Absolute folder to write to ('<name>.png' and '<name>.sketch.json' inside it), or a '.png' path (the source goes next to it)."
        ),
    ],
) -> dict:
    """Write a sketch's PNG and editable source to local paths. Returns {png_path, source_path, version, width, height, layers, markdown}."""
    async with common.async_session() as session:
        try:
            s = await svc_sketches.get_sketch(session, sketch_id)
            await _same_project(s["project_id"])
            return await svc_sketches.export_to_files(session, sketch_id, path)
        except svc_sketches.DocsError as exc:
            raise _error(exc) from exc


@notify_on_success
async def create_sketch_from_files(
    owner_kind: Annotated[
        Literal["ticket", "doc"],
        Field(description="Where the sketch belongs: a ticket or a Docs page."),
    ],
    owner_id: Annotated[
        str, Field(description="Ticket id 'IAM-12', or the Docs page id (UUID).")
    ],
    title: Annotated[str, Field(description="Name of the sketch; it is the alt text.")],
    path: PngPath,
    source_path: SourcePath = None,
) -> dict:
    """Create a sketch from a local PNG (and its .sketch.json). Returns {id, title, version, markdown}: put `markdown` on its own line in a ticket, comment or Docs page."""
    async with common.async_session() as session:
        try:
            project = await svc_sketches._project_of(
                session, owner_kind, owner_id, None
            )
            await _same_project(project)
            out = await svc_sketches.create_from_files(
                session,
                owner_kind=owner_kind,
                owner_id=owner_id,
                title=title,
                path=path,
                source_path=source_path,
            )
        except svc_sketches.DocsError as exc:
            raise _error(exc) from exc
        return {
            "id": out["id"],
            "title": out["title"],
            "version": out["version"],
            "markdown": f"![{out['title']}](sketch:{out['id']})",
        }


@notify_on_success
async def save_sketch_files(
    sketch_id: SketchId,
    path: PngPath,
    base_version: Annotated[
        int,
        Field(
            description="`version` from docs_read(sketch); a stale value is rejected."
        ),
    ],
    source_path: SourcePath = None,
    title: Annotated[str | None, Field(description="New name.")] = None,
) -> dict:
    """Save a local PNG (and its .sketch.json) as a new version of a sketch. Returns {id, title, version}."""
    async with common.async_session() as session:
        try:
            s = await svc_sketches.get_sketch(session, sketch_id)
            await _same_project(s["project_id"])
            out = await svc_sketches.save_from_files(
                session,
                sketch_id,
                path=path,
                base_version=base_version,
                source_path=source_path,
                title=title,
            )
        except svc_sketches.DocsError as exc:
            raise _error(exc) from exc
        return {k: out[k] for k in ("id", "title", "version")}
