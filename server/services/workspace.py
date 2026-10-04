import asyncio
import logging
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
import os
import re
from pathlib import Path
from typing import Any, Optional

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import Ticket, WorkspaceSettings
from services import activity as act


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
        settings.root_path = _validate_root_path(root_path)
    if default_retention_days is not None:
        settings.default_retention_days = default_retention_days
    session.add(settings)
    await session.commit()
    await session.refresh(settings)
    return settings


_SAFE_TICKET_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def _resolve_workspace_path(root_path: str, ticket_id: str) -> Path:
    if not _SAFE_TICKET_ID.fullmatch(ticket_id):
        raise ValueError(f"Invalid ticket id: {ticket_id!r}")
    root = os.path.realpath(os.path.expanduser(root_path))
    folder = os.path.realpath(os.path.join(root, ticket_id))
    if not folder.startswith(root.rstrip(os.sep) + os.sep):
        raise ValueError("Workspace path escapes the workspace root")
    return Path(folder)


MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_LISTED_ENTRIES = 2000
MAX_PREVIEW_BYTES = 512 * 1024
SWEEP_INTERVAL_SECONDS = 3600
CLOSED_STATUSES = frozenset({"done", "wont_do"})
_IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

logger = logging.getLogger(__name__)


class WorkspaceError(ValueError):
    """A workspace request that is invalid or not permitted."""


def _validate_root_path(root_path: str) -> str:
    value = root_path.strip()
    if not value:
        raise WorkspaceError("Workspace root path must not be empty")
    resolved = os.path.realpath(os.path.expanduser(value))
    if resolved == os.path.dirname(resolved):
        raise WorkspaceError("Workspace root must not be the filesystem root")
    if resolved == os.path.realpath(os.path.expanduser("~")):
        raise WorkspaceError("Workspace root must not be the home directory itself")
    return value


def _folder_for(root_path: str, ticket_id: str) -> Path:
    try:
        return _resolve_workspace_path(root_path, ticket_id)
    except ValueError as exc:
        raise WorkspaceError(str(exc)) from exc


def _resolve_inside(folder: Path, rel: str) -> Path:
    """Resolve ``rel`` under ``folder``; reject traversal and symlink escapes."""
    rel = (rel or "").replace("\\", "/").strip("/")
    if not rel or "\x00" in rel:
        raise WorkspaceError("Path is required")
    base = os.path.realpath(folder)
    target = os.path.realpath(os.path.join(base, rel))
    if not target.startswith(base.rstrip(os.sep) + os.sep):
        raise WorkspaceError("Path escapes the workspace folder")
    return Path(target)


def _retention_for(ticket: Ticket, settings: WorkspaceSettings) -> Optional[int]:
    days = (
        ticket.workspace_retention_days
        if ticket.workspace_retention_days is not None
        else settings.default_retention_days
    )
    return days if days else None  # None / 0 = keep forever


def _scan(folder: Path) -> tuple[list[dict[str, Any]], int, float, bool]:
    """Walk ``folder`` without following symlinks.

    Returns (entries, total_bytes, last_activity_epoch, truncated).
    """
    entries: list[dict[str, Any]] = []
    total = 0
    latest = folder.stat().st_mtime
    truncated = False
    for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
        dirnames.sort()
        for name in dirnames:
            full = Path(dirpath, name)
            if full.is_symlink():
                continue
            st = full.stat()
            latest = max(latest, st.st_mtime)
            if len(entries) < MAX_LISTED_ENTRIES:
                entries.append({
                    "name": str(full.relative_to(folder)),
                    "is_dir": True,
                    "size": 0,
                    "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
                })
            else:
                truncated = True
        for name in sorted(filenames):
            full = Path(dirpath, name)
            if full.is_symlink():
                continue
            st = full.stat()
            total += st.st_size
            latest = max(latest, st.st_mtime)
            if len(entries) < MAX_LISTED_ENTRIES:
                entries.append({
                    "name": str(full.relative_to(folder)),
                    "is_dir": False,
                    "size": st.st_size,
                    "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
                })
            else:
                truncated = True
    entries.sort(key=lambda e: e["name"].split("/"))
    return entries, total, latest, truncated


async def _get_ticket(session: AsyncSession, ticket_id: str) -> Ticket | None:
    return await session.get(Ticket, ticket_id)


async def get_ticket_workspace(session: AsyncSession, ticket_id: str) -> dict[str, Any] | None:
    ticket = await _get_ticket(session, ticket_id)
    if ticket is None:
        return None
    settings = await get_workspace_settings(session)
    try:
        folder_path = _resolve_workspace_path(settings.root_path, ticket_id)
    except ValueError:
        return None

    exists = folder_path.is_dir()
    files: list[dict[str, Any]] = []
    total_bytes = 0
    truncated = False
    last_activity: float | None = None
    if exists:
        try:
            files, total_bytes, last_activity, truncated = await asyncio.to_thread(
                _scan, folder_path
            )
        except OSError:
            pass

    retention_days = _retention_for(ticket, settings)
    sweep_eligible = ticket.status in CLOSED_STATUSES
    expires_at = None
    if exists and retention_days and last_activity is not None:
        expires_at = datetime.fromtimestamp(
            last_activity + retention_days * 86400, tz=timezone.utc
        ).isoformat()

    return {
        "enabled": settings.enabled,
        "path": str(folder_path),
        "exists": exists,
        "retention_days": retention_days if retention_days else 0,
        "retention_override": ticket.workspace_retention_days,
        "sweep_eligible": sweep_eligible,
        "expires_at": expires_at,
        "files": files,
        "file_count": sum(1 for f in files if not f["is_dir"]),
        "total_bytes": total_bytes,
        "truncated": truncated,
    }


def _retention_label(days: Optional[int]) -> str:
    if days is None:
        return "default"
    return "forever" if days == 0 else f"{days} days"


async def set_ticket_workspace_retention(
    session: AsyncSession, ticket_id: str, retention_days: Optional[int]
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    if retention_days is not None and retention_days < 0:
        raise WorkspaceError("Retention must be 0 (forever) or a positive number of days")
    if ticket.workspace_retention_days != retention_days:
        act.record(
            ticket,
            "workspace_retention",
            _retention_label(ticket.workspace_retention_days),
            _retention_label(retention_days),
        )
    ticket.workspace_retention_days = retention_days
    ticket.updated_at = datetime.now(timezone.utc).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def _enabled_folder(session: AsyncSession, ticket_id: str) -> Path:
    ticket = await _get_ticket(session, ticket_id)
    if ticket is None:
        raise LookupError("Ticket not found")
    settings = await get_workspace_settings(session)
    if not settings.enabled:
        raise WorkspaceError("Workspace is disabled")
    return _folder_for(settings.root_path, ticket_id)


async def init_ticket_workspace(session: AsyncSession, ticket_id: str) -> Path:
    folder = await _enabled_folder(session, ticket_id)
    await asyncio.to_thread(folder.mkdir, 0o755, True, True)
    return folder


async def remove_ticket_workspace(session: AsyncSession, ticket_id: str) -> None:
    """Best-effort removal of a deleted ticket's scratch folder; never raises."""
    try:
        settings = await get_workspace_settings(session)
        folder = _resolve_workspace_path(settings.root_path, ticket_id)
        if folder.is_dir() and not folder.is_symlink():
            await asyncio.to_thread(shutil.rmtree, folder)
    except Exception:  # noqa: BLE001 - cleanup must not fail the delete
        logger.warning("Could not remove workspace of %s", ticket_id, exc_info=True)


async def get_workspace_path(
    session: AsyncSession, ticket_id: str, create: bool = True
) -> dict[str, Any] | None:
    """Path an agent can read/write directly. Returns None for unknown tickets."""
    ticket = await _get_ticket(session, ticket_id)
    if ticket is None:
        return None
    settings = await get_workspace_settings(session)
    folder = _folder_for(settings.root_path, ticket_id)
    if settings.enabled and create:
        await asyncio.to_thread(folder.mkdir, 0o755, True, True)
    return {
        "enabled": settings.enabled,
        "path": str(folder),
        "exists": folder.is_dir(),
    }


async def create_folder(session: AsyncSession, ticket_id: str, rel: str) -> str:
    folder = await _enabled_folder(session, ticket_id)
    target = _resolve_inside(folder, rel)
    await asyncio.to_thread(target.mkdir, 0o755, True, True)
    return str(target.relative_to(os.path.realpath(folder)))


def _safe_filename(name: str) -> str:
    base = os.path.basename((name or "").replace("\\", "/"))
    if not base or base in (".", "..") or "\x00" in base:
        raise WorkspaceError("Invalid file name")
    return base


async def save_upload(
    session: AsyncSession, ticket_id: str, directory: str, filename: str, data: bytes
) -> dict[str, Any]:
    if len(data) > MAX_UPLOAD_BYTES:
        raise WorkspaceError(f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    folder = await _enabled_folder(session, ticket_id)
    name = _safe_filename(filename)
    rel = f"{directory.strip('/')}/{name}" if directory.strip("/") else name
    target = _resolve_inside(folder, rel)
    if target.is_dir():
        raise WorkspaceError("A folder with that name already exists")

    def _write() -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    await asyncio.to_thread(_write)
    return {"name": str(target.relative_to(os.path.realpath(folder))), "size": len(data)}


async def delete_entry(session: AsyncSession, ticket_id: str, rel: str) -> None:
    folder = await _enabled_folder(session, ticket_id)
    target = _resolve_inside(folder, rel)
    if not target.exists():
        raise LookupError("Entry not found")
    if target.is_dir():
        await asyncio.to_thread(shutil.rmtree, target)
    else:
        await asyncio.to_thread(target.unlink)


async def resolve_file(
    session: AsyncSession, ticket_id: str, rel: str
) -> tuple[Path, str]:
    """Return (path, media_type) for a regular file inside the workspace."""
    folder = await _enabled_folder(session, ticket_id)
    target = _resolve_inside(folder, rel)
    if not target.is_file():
        raise LookupError("File not found")
    return target, _IMAGE_TYPES.get(target.suffix.lower(), "")


def read_text_preview(path: Path) -> dict[str, Any]:
    size = path.stat().st_size
    with open(path, "rb") as fh:
        raw = fh.read(MAX_PREVIEW_BYTES)
    if b"\x00" in raw:
        return {"binary": True, "text": "", "truncated": False, "size": size}
    return {
        "binary": False,
        "text": raw.decode("utf-8", errors="replace"),
        "truncated": size > MAX_PREVIEW_BYTES,
        "size": size,
    }


async def open_in_file_manager(session: AsyncSession, ticket_id: str) -> str:
    folder = await _enabled_folder(session, ticket_id)
    await asyncio.to_thread(folder.mkdir, 0o755, True, True)
    # The folder is passed as the working directory and "." as the only argument,
    # so no configurable path ever becomes part of the command line.
    if sys.platform == "darwin":
        opener = "open"
    elif sys.platform.startswith("win"):
        opener = "explorer"
    else:
        opener = "xdg-open"
    if shutil.which(opener) is None:
        raise WorkspaceError("No file manager available on this machine; copy the path instead")
    subprocess.Popen(  # noqa: S603 - fixed argv
        [opener, "."],
        cwd=folder,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return str(folder)


async def sweep_expired(session: AsyncSession, dry_run: bool = False) -> list[dict[str, Any]]:
    """Delete workspace folders of closed tickets idle past their retention window.

    Only ``<root>/<ticket_id>`` folders are ever touched. Open tickets and tickets
    whose effective retention is "forever" are skipped.
    """
    settings = await get_workspace_settings(session)
    if not settings.enabled:
        return []
    result = await session.exec(select(Ticket).where(Ticket.status.in_(list(CLOSED_STATUSES))))
    removed: list[dict[str, Any]] = []
    now = time.time()
    for ticket in result.all():
        days = _retention_for(ticket, settings)
        if not days:
            continue
        try:
            folder = _resolve_workspace_path(settings.root_path, ticket.id)
        except ValueError:
            continue
        if not folder.is_dir():
            continue
        try:
            entries, total, latest, _ = await asyncio.to_thread(_scan, folder)
        except OSError:
            continue
        if now - latest < days * 86400:
            continue
        if not dry_run:
            try:
                await asyncio.to_thread(shutil.rmtree, folder)
            except OSError:
                logger.warning("Could not remove workspace %s", folder, exc_info=True)
                continue
        removed.append({"ticket_id": ticket.id, "path": str(folder), "bytes": total})
    return removed


async def sweep_loop(session_factory) -> None:
    while True:
        try:
            async with session_factory() as session:
                removed = await sweep_expired(session)
                if removed:
                    logger.info("Workspace sweep removed %d folder(s)", len(removed))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Workspace sweep failed")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
