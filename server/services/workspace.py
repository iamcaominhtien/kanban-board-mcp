from datetime import datetime, timezone
import os
from pathlib import Path
from typing import Any, Optional

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import Ticket, WorkspaceSettings, WorkspaceSettingsUpdate


async def get_workspace_settings(session: AsyncSession) -> WorkspaceSettings:
    result = await session.exec(select(WorkspaceSettings).where(WorkspaceSettings.id == 1))
    settings = result.first()
    if settings is None:
        settings = WorkspaceSettings(
            id=1,
            enabled=True,
            root_path="~/kanban-workspace",
            default_retention_days=14,
        )
        session.add(settings)
        await session.commit()
        await session.refresh(settings)
    return settings


async def update_workspace_settings(
    session: AsyncSession,
    enabled: Optional[bool] = None,
    root_path: Optional[str] = None,
    default_retention_days: Optional[int] = None,
) -> WorkspaceSettings:
    settings = await get_workspace_settings(session)
    if enabled is not None:
        settings.enabled = enabled
    if root_path is not None:
        settings.root_path = root_path
    if default_retention_days is not None:
        settings.default_retention_days = default_retention_days
    session.add(settings)
    await session.commit()
    await session.refresh(settings)
    return settings


def _resolve_workspace_path(root_path: str, ticket_id: str) -> Path:
    expanded = os.path.expanduser(root_path)
    return Path(expanded) / ticket_id


async def get_ticket_workspace(session: AsyncSession, ticket_id: str) -> dict[str, Any] | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    settings = await get_workspace_settings(session)
    folder_path = _resolve_workspace_path(settings.root_path, ticket_id)

    files: list[dict[str, Any]] = []
    total_bytes = 0
    exists = folder_path.is_dir()

    if exists:
        try:
            for entry in sorted(folder_path.rglob('*')):
                if entry.is_file():
                    stat = entry.stat()
                    total_bytes += stat.st_size
                    files.append({
                        "name": str(entry.relative_to(folder_path)),
                        "size": stat.st_size,
                        "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                    })
        except OSError:
            pass

    retention_days = (
        ticket.workspace_retention_days
        if ticket.workspace_retention_days is not None
        else settings.default_retention_days
    )

    return {
        "enabled": settings.enabled,
        "path": str(folder_path),
        "exists": exists,
        "retention_days": retention_days,
        "files": files,
        "file_count": len(files),
        "total_bytes": total_bytes,
    }


async def set_ticket_workspace_retention(
    session: AsyncSession, ticket_id: str, retention_days: Optional[int]
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    ticket.workspace_retention_days = retention_days
    ticket.updated_at = datetime.now(timezone.utc).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket
