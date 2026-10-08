from typing import Annotated, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import TicketRead, WorkspaceSettings, WorkspaceSettingsUpdate
from services import workspace as svc_workspace
from services.workspace import WorkspaceError

router = APIRouter(tags=["workspace"])
Session = Annotated[AsyncSession, Depends(get_session)]


class TicketRetentionBody(BaseModel):
    """Request body for a ticket's workspace retention override."""

    retention_days: Optional[int] = None  # None = inherit, 0 = keep forever


class FolderBody(BaseModel):
    """Request body naming a folder inside a workspace."""

    path: str


class SweepBody(BaseModel):
    """Request body for the expired-workspace sweep."""

    dry_run: bool = False


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, LookupError):
        return HTTPException(status_code=404, detail=str(exc).strip("'\""))
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/workspace/settings", response_model=WorkspaceSettings)
async def get_settings(session: Session) -> WorkspaceSettings:
    """Get the workspace settings."""
    return await svc_workspace.get_workspace_settings(session)


@router.patch("/workspace/settings", response_model=WorkspaceSettings)
async def patch_settings(
    body: WorkspaceSettingsUpdate, session: Session
) -> WorkspaceSettings:
    """Update the workspace settings."""
    try:
        settings = await svc_workspace.update_workspace_settings(
            session,
            enabled=body.enabled,
            root_path=body.root_path,
            default_retention_days=body.default_retention_days,
        )
    except WorkspaceError as exc:
        raise _http(exc) from exc
    await board_events.publish("invalidate")
    return settings


@router.post("/workspace/sweep")
async def sweep(body: SweepBody, session: Session) -> dict:
    """Delete (or with `dry_run`, list) expired workspaces."""
    removed = await svc_workspace.sweep_expired(session, dry_run=body.dry_run)
    if removed and not body.dry_run:
        await board_events.publish("invalidate")
    return {"dry_run": body.dry_run, "removed": removed}


@router.get("/tickets/{ticket_id}/workspace")
async def get_ticket_workspace(ticket_id: str, session: Session) -> dict:
    """Get a ticket's workspace folder and entries."""
    workspace_info = await svc_workspace.get_ticket_workspace(session, ticket_id)
    if workspace_info is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return workspace_info


@router.patch("/tickets/{ticket_id}/workspace/retention", response_model=TicketRead)
async def patch_ticket_workspace_retention(
    ticket_id: str, body: TicketRetentionBody, session: Session
) -> TicketRead:
    """Set a ticket's workspace retention override."""
    try:
        ticket = await svc_workspace.set_ticket_workspace_retention(
            session, ticket_id, body.retention_days
        )
    except WorkspaceError as exc:
        raise _http(exc) from exc
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    await board_events.publish("invalidate")
    return TicketRead.from_ticket(ticket)


@router.post("/tickets/{ticket_id}/workspace/init")
async def init_workspace(ticket_id: str, session: Session) -> dict:
    """Create a ticket's workspace folder."""
    try:
        folder = await svc_workspace.init_ticket_workspace(session, ticket_id)
    except (LookupError, WorkspaceError) as exc:
        raise _http(exc) from exc
    return {"path": str(folder), "exists": True}


@router.post("/tickets/{ticket_id}/workspace/open")
async def open_workspace(ticket_id: str, session: Session) -> dict:
    """Open a ticket's workspace folder in the file manager."""
    try:
        path = await svc_workspace.open_in_file_manager(session, ticket_id)
    except (LookupError, WorkspaceError) as exc:
        raise _http(exc) from exc
    return {"path": path}


@router.post("/tickets/{ticket_id}/workspace/folders")
async def create_workspace_folder(
    ticket_id: str, body: FolderBody, session: Session
) -> dict:
    """Create a folder inside a ticket's workspace."""
    try:
        name = await svc_workspace.create_folder(session, ticket_id, body.path)
    except (LookupError, WorkspaceError) as exc:
        raise _http(exc) from exc
    return {"name": name}


@router.post("/tickets/{ticket_id}/workspace/files")
async def upload_workspace_file(
    ticket_id: str,
    session: Session,
    file: UploadFile = File(...),
    directory: str = Form(""),
) -> dict:
    """Upload a file into a ticket's workspace."""
    data = await file.read(svc_workspace.MAX_UPLOAD_BYTES + 1)
    try:
        return await svc_workspace.save_upload(
            session, ticket_id, directory, file.filename or "", data
        )
    except (LookupError, WorkspaceError) as exc:
        raise _http(exc) from exc


@router.get("/tickets/{ticket_id}/workspace/file")
async def get_workspace_file(
    ticket_id: str, path: str, session: Session, download: bool = False
):
    """Download or preview a file from a ticket's workspace."""
    try:
        target, image_type = await svc_workspace.resolve_file(session, ticket_id, path)
    except (LookupError, WorkspaceError) as exc:
        raise _http(exc) from exc
    headers = {"X-Content-Type-Options": "nosniff"}
    if download:
        return FileResponse(
            target,
            filename=target.name,
            media_type="application/octet-stream",
            headers=headers,
        )
    if image_type:
        return FileResponse(target, media_type=image_type, headers=headers)
    return JSONResponse(svc_workspace.read_text_preview(target), headers=headers)


@router.delete("/tickets/{ticket_id}/workspace/entry")
async def delete_workspace_entry(ticket_id: str, path: str, session: Session) -> dict:
    """Delete a file or folder from a ticket's workspace."""
    try:
        await svc_workspace.delete_entry(session, ticket_id, path)
    except (LookupError, WorkspaceError) as exc:
        raise _http(exc) from exc
    return {"deleted": path}
