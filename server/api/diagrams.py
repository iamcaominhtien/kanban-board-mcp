from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import diagrams as svc

router = APIRouter(tags=["diagrams"])

Session = Annotated[AsyncSession, Depends(get_session)]

# The preview is only ever shown through <img>; these headers also stop it running if opened directly.
_SVG_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=0, must-revalidate",
}


class DiagramCreate(BaseModel):
    """Request body to save a new diagram."""

    label: str | None = None
    source: str
    svg: str
    summary: str | None = None
    item_kind: str | None = None
    item_id: str | None = None


class DiagramUpdate(BaseModel):
    """Request body to save a new version of a diagram."""

    base_version: int
    source: str
    svg: str
    label: str | None = None
    summary: str | None = None


class DiagramSettingsBody(BaseModel):
    """Request body to choose where the draw.io editor runs."""

    mode: str
    url: str | None = None


@router.get("/projects/{project_id}/diagrams")
async def get_diagrams(
    project_id: str, session: Session, deleted: bool = False
) -> list[dict[str, Any]]:
    """List a project's diagrams, or the unlinked ones in the Recycle Bin."""
    return await svc.list_diagrams(session, project_id, deleted=deleted)


@router.post("/projects/{project_id}/diagrams", status_code=201)
async def post_diagram(
    project_id: str, body: DiagramCreate, session: Session
) -> dict[str, Any]:
    """Save a new diagram: the `.drawio` source and its SVG preview (2 MB limit each)."""
    out = await svc.create_diagram(session, project_id, **body.model_dump())
    await board_events.publish("invalidate")
    return out


@router.get("/diagrams/settings")
async def get_diagram_settings(session: Session) -> dict[str, Any]:
    """Where the draw.io editor runs."""
    return await svc.get_settings(session)


@router.put("/diagrams/settings")
async def put_diagram_settings(
    body: DiagramSettingsBody, session: Session
) -> dict[str, Any]:
    """Choose self-hosted or public draw.io (admin only)."""
    return await svc.set_settings(session, mode=body.mode, url=body.url)


@router.get("/diagrams/{diagram_id}")
async def get_diagram(
    diagram_id: str,
    session: Session,
    version: int | None = None,
    source: bool = False,
) -> dict[str, Any]:
    """Read a diagram; `source=true` adds the `.drawio` XML (for the editor)."""
    return await svc.get_diagram(
        session, diagram_id, version=version, include_source=source
    )


@router.put("/diagrams/{diagram_id}")
async def put_diagram(
    diagram_id: str, body: DiagramUpdate, session: Session
) -> dict[str, Any]:
    """Save a new version; 409 `diagram_conflict` if someone saved a newer one."""
    out = await svc.update_diagram(session, diagram_id, **body.model_dump())
    await board_events.publish("invalidate")
    return out


@router.delete("/diagrams/{diagram_id}")
async def del_diagram(diagram_id: str, session: Session) -> dict[str, Any]:
    """Unlink a diagram. It is kept in the Recycle Bin and can be restored."""
    out = await svc.delete_diagram(session, diagram_id)
    await board_events.publish("invalidate")
    return out


@router.post("/diagrams/{diagram_id}/restore")
async def post_restore_diagram(diagram_id: str, session: Session) -> dict[str, Any]:
    """Bring an unlinked diagram back."""
    out = await svc.restore_diagram(session, diagram_id)
    await board_events.publish("invalidate")
    return out


@router.get("/diagrams/{diagram_id}/versions")
async def get_diagram_versions(
    diagram_id: str, session: Session
) -> list[dict[str, Any]]:
    """List the saved versions, newest first."""
    return await svc.list_versions(session, diagram_id)


@router.get("/diagrams/{diagram_id}/svg")
async def get_diagram_svg(
    diagram_id: str, session: Session, version: int | None = None
) -> Response:
    """The SVG preview shown on the page."""
    content, media, _ = await svc.read_file(
        session, diagram_id, kind="svg", version=version
    )
    return Response(content, media_type=media, headers=_SVG_HEADERS)


@router.get("/diagrams/{diagram_id}/download")
async def get_diagram_download(
    diagram_id: str,
    session: Session,
    format: str = "drawio",
    version: int | None = None,
) -> Response:
    """Download the diagram as `.drawio` (editable) or `.svg`."""
    kind = "svg" if format == "svg" else "drawio"
    content, media, name = await svc.read_file(
        session, diagram_id, kind=kind, version=version
    )
    headers = dict(_SVG_HEADERS)
    headers["Content-Disposition"] = f'attachment; filename="{name}"'
    headers["Access-Control-Expose-Headers"] = "Content-Disposition"
    return Response(content, media_type=media, headers=headers)
