"""Sketches: paint-style drawings kept as a PNG plus an editable source (JSON with layers).

A sketch sits in any markdown field as ``![Name](sketch:sk_8f2a1c3d)``. Both files live in the uploads
folder (``uploads/sketches/<id>.png`` and ``<id>.sketch.json``), so a backup or export of the data folder
carries them like any attachment; the ``sketch`` table only holds the owner, the size and a version.
Saving needs the version you started from (``base_version``), so two people cannot silently overwrite
each other. Deleting only *unlinks*: the row and the files stay.
"""

import base64
import json
import os
import re
import struct
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsPage, IdeaTicket, Member, Project, Sketch, Ticket
from services import activity, docs_access
from services.docs_text import DocsError
from uploads import get_uploads_dir

MAX_SIDE = 4096  # px, width and height
MAX_BYTES = 10 * 1024 * 1024  # per file: the PNG and the source each
MAX_LAYERS = 10
MAX_TITLE = 200
OWNER_KINDS = ("idea", "ticket", "doc", "comment")
SOURCE_FORMAT = "kanban-sketch"
SOURCE_VERSION = 1

SKETCH_REF = re.compile(r"\(sketch:(sk_[0-9a-f]{8})\)")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def refs_in(markdown: str) -> list[str]:
    """Return the sketch ids a markdown text references, in order, without repeats."""
    seen: dict[str, None] = {}
    for m in SKETCH_REF.finditer(markdown or ""):
        seen.setdefault(m.group(1), None)
    return list(seen)


# --- files -----------------------------------------------------------------------


def sketches_dir() -> Path:
    """The folder both files of every sketch are kept in (inside the uploads folder)."""
    path = get_uploads_dir() / "sketches"
    path.mkdir(parents=True, exist_ok=True)
    return path


def png_path(sketch_id: str) -> Path:
    """Path of a sketch's PNG."""
    return sketches_dir() / f"{sketch_id}.png"


def source_path(sketch_id: str) -> Path:
    """Path of a sketch's editable source."""
    return sketches_dir() / f"{sketch_id}.sketch.json"


def _stage(sketch_id: str, png: bytes, source: bytes) -> list[tuple[Path, Path]]:
    """Write both files under temporary names; `_publish` moves them in once the row is saved."""
    staged = []
    for final, content in (
        (png_path(sketch_id), png),
        (source_path(sketch_id), source),
    ):
        tmp = final.with_name(final.name + ".tmp")
        tmp.write_bytes(content)
        staged.append((tmp, final))
    return staged


def _publish(staged: list[tuple[Path, Path]]) -> None:
    for tmp, final in staged:
        os.replace(tmp, final)


def _discard(staged: list[tuple[Path, Path]]) -> None:
    for tmp, _ in staged:
        tmp.unlink(missing_ok=True)


# --- validation ------------------------------------------------------------------


def _too_large(what: str, size: int | None = None, **extra: Any) -> DocsError:
    return DocsError(
        413,
        "sketch_too_large",
        f"This drawing is too large to save. The limit is {MAX_SIDE} × {MAX_SIDE} px and "
        f"{MAX_BYTES // (1024 * 1024)} MB. Crop it or shrink the canvas.",
        part=what,
        size_bytes=size,
        limit_bytes=MAX_BYTES,
        limit_px=MAX_SIDE,
        **extra,
    )


def png_size(png: bytes) -> tuple[int, int]:
    """Width and height of a PNG read from its header, without decoding it.

    Raises:
        DocsError: 413 if the file is over the size limit; 422 if it is not a PNG.
    """
    if len(png) > MAX_BYTES:
        raise _too_large("png", len(png))
    if len(png) < 33 or not png.startswith(_PNG_SIGNATURE) or png[12:16] != b"IHDR":
        raise DocsError(422, "invalid_sketch", "The picture is not a PNG image.")
    width, height = struct.unpack(">II", png[16:24])
    return width, height


def validate(png: bytes, source: bytes) -> dict[str, Any]:
    """Check a PNG and its source belong together and are within the limits.

    Args:
        png: The flattened picture.
        source: The editable source, a JSON document (see docs/specs/sketch-tool.md).

    Returns:
        ``{width, height, layer_count}`` of the drawing.

    Raises:
        DocsError: 413 if a file is too large or the canvas is over 4096 px; 422 if the source is
            malformed, has more than 10 layers, or does not match the PNG.
    """
    width, height = png_size(png)
    if len(source) > MAX_BYTES:
        raise _too_large("source", len(source))
    if width > MAX_SIDE or height > MAX_SIDE:
        raise _too_large("canvas", width=width, height=height)
    if width < 1 or height < 1:
        raise DocsError(422, "invalid_sketch", "The picture is empty.")
    try:
        doc = json.loads(source.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise DocsError(
            422, "invalid_sketch", f"The editable source is not valid JSON ({e})."
        ) from e
    if (
        not isinstance(doc, dict)
        or doc.get("format") != SOURCE_FORMAT
        or not isinstance(doc.get("layers"), list)
    ):
        raise DocsError(
            422, "invalid_sketch", "This is not a sketch source (wrong format)."
        )
    if doc.get("version") != SOURCE_VERSION:
        raise DocsError(
            422,
            "invalid_sketch",
            f"Unsupported sketch source version {doc.get('version')!r}.",
        )
    layers = doc["layers"]
    if not 1 <= len(layers) <= MAX_LAYERS:
        raise DocsError(
            422,
            "too_many_layers",
            f"A drawing has 1 to {MAX_LAYERS} layers (this one has {len(layers)}). Merge some layers.",
            layer_count=len(layers),
            limit_layers=MAX_LAYERS,
        )
    if doc.get("width") != width or doc.get("height") != height:
        raise DocsError(
            422, "invalid_sketch", "The size in the source does not match the picture."
        )
    return {"width": width, "height": height, "layer_count": len(layers)}


def _title(title: str | None, fallback: str = "Sketch") -> str:
    text = re.sub(r"[\[\]\n\r]+", " ", (title or "")).strip()[:MAX_TITLE]
    return text or fallback


# --- permissions and owners ------------------------------------------------------


async def _project_of(
    session: AsyncSession, owner_kind: str, owner_id: str, hint: str | None
) -> str | None:
    """The project a drawing belongs to: the one given, else the owner's own (None for a free idea)."""
    if hint:
        if await session.get(Project, hint) is None:
            raise DocsError(404, "project_not_found", "Project not found")
        return hint
    order = {
        "ticket": (Ticket, DocsPage, IdeaTicket),
        "doc": (DocsPage, Ticket, IdeaTicket),
        "idea": (IdeaTicket, Ticket, DocsPage),
        # a comment belongs to the ticket or page it is written on
        "comment": (Ticket, DocsPage, IdeaTicket),
    }[owner_kind]
    for model in order:
        row = await session.get(model, owner_id)
        if row is not None:
            return getattr(row, "project_id", None)
    return None


async def role_of(session: AsyncSession, project_id: str | None) -> str:
    """The caller's role for a drawing: viewer, member or admin.

    A drawing of an idea that belongs to no project uses the caller's best role in any project.
    """
    actor = activity.current_actor()
    if project_id is not None:
        return docs_access.role_in(
            await docs_access.members_of(session, project_id), actor
        )
    if actor == activity.HUMAN_ACTOR:
        return "admin"
    if actor == activity.AGENT_ACTOR:
        return "member"
    rows = await session.exec(select(Member))
    roles = [
        m.role
        for m in rows.all()
        if m.name.casefold() == actor.casefold() and m.role in docs_access.ROLES
    ]
    for best in ("admin", "member"):
        if best in roles:
            return best
    return "viewer"


def _need_member(role: str) -> None:
    if role == "viewer":
        raise DocsError(
            403,
            "read_only",
            "Viewers can look at drawings and open them large but cannot edit them.",
        )


async def _sketch(
    session: AsyncSession, sketch_id: str, *, deleted_ok: bool = False
) -> Sketch:
    s = await session.get(Sketch, sketch_id)
    if s is None or (s.deleted_at and not deleted_ok):
        raise DocsError(
            404,
            "sketch_not_found",
            "Sketch not found. It was deleted, or you do not have access.",
        )
    return s


async def _out(session: AsyncSession, s: Sketch) -> dict[str, Any]:
    """The sketch as the API returns it (no file bodies)."""
    role = await role_of(session, s.project_id)
    return {
        "id": s.id,
        "project_id": s.project_id,
        "owner_kind": s.owner_kind,
        "owner_id": s.owner_id,
        "title": s.title,
        "width": s.width,
        "height": s.height,
        "layer_count": s.layer_count,
        "version": s.version,
        "png_bytes": s.png_bytes,
        "source_bytes": s.source_bytes,
        "png_url": f"/uploads/sketches/{s.id}.png",
        "source_url": f"/uploads/sketches/{s.id}.sketch.json",
        "created_by": s.created_by,
        "created_at": s.created_at,
        "updated_by": s.updated_by,
        "updated_at": s.updated_at,
        "deleted_at": s.deleted_at,
        "role": role,
        "can_edit": role != "viewer" and not s.deleted_at,
    }


# --- create, read, update, copy, delete ----------------------------------------------


async def create_sketch(
    session: AsyncSession,
    *,
    owner_kind: str,
    owner_id: str,
    title: str | None,
    png: bytes,
    source: bytes,
    project_id: str | None = None,
) -> dict[str, Any]:
    """Save a new sketch (version 1).

    Args:
        owner_kind: ``idea``, ``ticket``, ``doc`` or ``comment``.
        owner_id: Id of the page, ticket or idea that holds it (for a comment, of the ticket or page).
        title: Name; becomes the alt text.
        png: The flattened picture.
        source: The editable source.
        project_id: Project, when the owner does not say (a comment still being written).

    Returns:
        The saved sketch.

    Raises:
        DocsError: 403 for viewers; 413 / 422 for a bad file.
    """
    if owner_kind not in OWNER_KINDS:
        raise DocsError(
            422, "invalid_owner", f"owner_kind must be one of {OWNER_KINDS}"
        )
    if not owner_id.strip():
        raise DocsError(422, "invalid_owner", "owner_id is required")
    project = await _project_of(session, owner_kind, owner_id, project_id)
    _need_member(await role_of(session, project))
    info = validate(png, source)
    actor = activity.current_actor()
    s = Sketch(
        project_id=project,
        owner_kind=owner_kind,
        owner_id=owner_id,
        title=_title(title),
        width=info["width"],
        height=info["height"],
        layer_count=info["layer_count"],
        png_bytes=len(png),
        source_bytes=len(source),
        created_by=actor,
        updated_by=actor,
    )
    session.add(s)
    await session.flush()
    staged = _stage(s.id, png, source)
    try:
        await session.commit()
    except Exception:
        _discard(staged)
        raise
    _publish(staged)
    return await _out(session, s)


async def get_sketch(session: AsyncSession, sketch_id: str) -> dict[str, Any]:
    """Read a sketch's details."""
    return await _out(session, await _sketch(session, sketch_id))


async def read_file(
    session: AsyncSession, sketch_id: str, *, kind: str
) -> tuple[bytes, str, str, Sketch]:
    """Return ``(content, media_type, file_name, sketch)`` of a sketch's ``png`` or editable ``source``."""
    s = await _sketch(session, sketch_id)
    stem = re.sub(r"[^\w.-]+", "-", s.title, flags=re.ASCII).strip("-._") or "sketch"
    path = png_path(s.id) if kind == "png" else source_path(s.id)
    try:
        content = path.read_bytes()
    except OSError as e:
        raise DocsError(
            404,
            "sketch_file_missing",
            "The drawing's file is missing from the data folder.",
        ) from e
    if kind == "png":
        return content, "image/png", f"{stem}.png", s
    return content, "application/json", f"{stem}.sketch.json", s


async def update_sketch(
    session: AsyncSession,
    sketch_id: str,
    *,
    base_version: int,
    png: bytes,
    source: bytes,
    title: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Save a new version of a sketch.

    Args:
        sketch_id: Sketch to change.
        base_version: The version the edit started from; must be the latest unless ``force``.
        png: The flattened picture.
        source: The editable source.
        title: New name, if changed.
        force: Replace a newer version ("Replace theirs").

    Returns:
        The saved sketch.

    Raises:
        DocsError: 403 for viewers; 409 ``sketch_conflict`` if someone saved a newer version.
    """
    s = await _sketch(session, sketch_id)
    _need_member(await role_of(session, s.project_id))
    if base_version != s.version and not force:
        raise DocsError(
            409,
            "sketch_conflict",
            f"{s.updated_by} saved this drawing while you were drawing.",
            latest_version=s.version,
            latest_author=s.updated_by,
            latest_at=s.updated_at,
        )
    info = validate(png, source)
    s.version += 1
    s.updated_by = activity.current_actor()
    s.updated_at = _now()
    s.width, s.height = info["width"], info["height"]
    s.layer_count = info["layer_count"]
    s.png_bytes, s.source_bytes = len(png), len(source)
    if title is not None:
        s.title = _title(title, s.title)
    session.add(s)
    staged = _stage(s.id, png, source)
    try:
        await session.commit()
    except Exception:
        _discard(staged)
        raise
    _publish(staged)
    return await _out(session, s)


async def copy_sketch(
    session: AsyncSession,
    sketch_id: str,
    *,
    png: bytes | None = None,
    source: bytes | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    """Make a second sketch next to the first and leave the first alone.

    Args:
        sketch_id: Sketch to copy.
        png: The copy's picture (the unsaved state of the editor); the original's when omitted.
        source: The copy's source; the original's when omitted.
        title: Name of the copy; "<name> copy" by default.

    Returns:
        The new sketch (new id, version 1, same owner).
    """
    s = await _sketch(session, sketch_id)
    _need_member(await role_of(session, s.project_id))
    if png is None or source is None:
        png = (await read_file(session, sketch_id, kind="png"))[0]
        source = (await read_file(session, sketch_id, kind="source"))[0]
    return await create_sketch(
        session,
        owner_kind=s.owner_kind,
        owner_id=s.owner_id,
        title=_title(title, f"{s.title} copy"),
        png=png,
        source=source,
        project_id=s.project_id,
    )


async def delete_sketch(session: AsyncSession, sketch_id: str) -> dict[str, Any]:
    """Unlink a sketch: it stops resolving but its row and files are kept."""
    s = await _sketch(session, sketch_id)
    _need_member(await role_of(session, s.project_id))
    s.deleted_at = _now()
    s.deleted_by = activity.current_actor()
    session.add(s)
    await session.commit()
    return {"id": s.id, "deleted_at": s.deleted_at}


async def restore_sketch(session: AsyncSession, sketch_id: str) -> dict[str, Any]:
    """Bring an unlinked sketch back."""
    s = await _sketch(session, sketch_id, deleted_ok=True)
    _need_member(await role_of(session, s.project_id))
    s.deleted_at = None
    s.deleted_by = None
    session.add(s)
    await session.commit()
    return await _out(session, s)


async def list_sketches(
    session: AsyncSession, owner_kind: str, owner_id: str
) -> list[dict[str, Any]]:
    """List the sketches of one page, ticket, idea or comment's ticket, newest change first."""
    rows = await session.exec(
        select(Sketch)
        .where(
            Sketch.owner_kind == owner_kind,
            Sketch.owner_id == owner_id,
            Sketch.deleted_at.is_(None),  # type: ignore[union-attr]
        )
        .order_by(Sketch.updated_at.desc())  # type: ignore[attr-defined]
    )
    return [await _out(session, s) for s in rows.all()]


# --- files for an agent (MCP: docs_read sketch(es), docs_write sketch_create / sketch_save) --------------------


def _file_error(message: str) -> DocsError:
    return DocsError(422, "invalid_file", message)


def _read_local(path: str, what: str) -> bytes:
    """Read a local file the agent named: an absolute path to a regular file of at most 10 MB."""
    p = Path(path)
    if not p.is_absolute():
        raise _file_error(f"Give an absolute path for the {what} (got {path!r}).")
    if not p.is_file():
        raise _file_error(f"The {what} is not a file: {path}.")
    try:
        if p.stat().st_size > MAX_BYTES:
            raise _too_large(what, p.stat().st_size)
        return p.read_bytes()
    except OSError as e:
        raise _file_error(f"The {what} could not be read ({e.strerror}).") from e


def flat_source(png: bytes) -> bytes:
    """A source for a picture that came without one: the white page and the picture on a layer of its own. Used when an
    agent saves only a PNG; the drawing then opens in the editor as one picture layer that can be drawn over."""
    width, height = png_size(png)
    doc = {
        "format": SOURCE_FORMAT,
        "version": SOURCE_VERSION,
        "width": width,
        "height": height,
        "background": "white",
        "activeLayer": "l2",
        "layers": [
            {
                "id": "l1",
                "name": "Background",
                "kind": "paper",
                "visible": True,
                "opacity": 1,
                "locked": True,
                "png": None,
                "texts": [],
            },
            {
                "id": "l2",
                "name": "Picture",
                "kind": "picture",
                "visible": True,
                "opacity": 1,
                "locked": False,
                "png": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
                "texts": [],
            },
        ],
    }
    return json.dumps(doc).encode()


async def list_for_agent(
    session: AsyncSession, project_id: str
) -> list[dict[str, Any]]:
    """A project's sketches in brief, newest change first: ``[{id, title, owner_kind, owner_id, version, width, height,
    layers, updated_by, updated_at, markdown}]``."""
    rows = await session.exec(
        select(Sketch)
        .where(
            Sketch.project_id == project_id,
            Sketch.deleted_at.is_(None),  # type: ignore[union-attr]
        )
        .order_by(Sketch.updated_at.desc())  # type: ignore[attr-defined]
    )
    return [
        {
            "id": s.id,
            "title": s.title,
            "owner_kind": s.owner_kind,
            "owner_id": s.owner_id,
            "version": s.version,
            "width": s.width,
            "height": s.height,
            "layers": s.layer_count,
            "updated_by": s.updated_by,
            "updated_at": s.updated_at,
            "markdown": f"![{s.title}](sketch:{s.id})",
        }
        for s in rows.all()
    ]


async def export_to_files(
    session: AsyncSession, sketch_id: str, path: str
) -> dict[str, Any]:
    """Write a sketch's PNG and its editable source to local paths.

    Args:
        sketch_id: ``sk_xxxxxxxx``.
        path: A folder (or a path ending in ``/``): ``<name>.png`` and ``<name>.sketch.json`` are written inside it. A
            path ending in ``.png`` names the picture; the source goes next to it as ``<same name>.sketch.json``.

    Returns:
        ``{png_path, source_path, id, title, version, width, height, layers, markdown}``; send ``version`` back as
        ``base_version`` when saving.
    """
    s = await _sketch(session, sketch_id)
    target = Path(path)
    if not target.is_absolute():
        raise _file_error(f"Give an absolute path (got {path!r}).")
    if target.is_dir() or path.endswith(("/", "\\")) or target.suffix.lower() != ".png":
        stem = (
            re.sub(r"[^\w.-]+", "-", s.title, flags=re.ASCII).strip("-._") or "sketch"
        )
        png_target = target / f"{stem}.png"
    else:
        png_target = target
    source_target = png_target.with_name(png_target.stem + ".sketch.json")
    png = png_path(s.id).read_bytes() if png_path(s.id).exists() else None
    src = source_path(s.id).read_bytes() if source_path(s.id).exists() else None
    if png is None or src is None:
        raise DocsError(
            404,
            "sketch_file_missing",
            "The drawing's file is missing from the data folder.",
        )
    try:
        png_target.parent.mkdir(parents=True, exist_ok=True)
        png_target.write_bytes(png)
        source_target.write_bytes(src)
    except OSError as e:
        raise _file_error(
            f"{png_target.parent} could not be written ({e.strerror})."
        ) from e
    return {
        "png_path": str(png_target),
        "source_path": str(source_target),
        "id": s.id,
        "title": s.title,
        "version": s.version,
        "width": s.width,
        "height": s.height,
        "layers": s.layer_count,
        "markdown": f"![{s.title}](sketch:{s.id})",
    }


async def create_from_files(
    session: AsyncSession,
    *,
    owner_kind: str,
    owner_id: str,
    title: str,
    path: str,
    source_path: str | None = None,
) -> dict[str, Any]:
    """Create a sketch from a local PNG and (optionally) its ``.sketch.json`` source. Without a source the picture
    becomes one picture layer on a white page. The owner (a ticket or a Docs page) must exist."""
    if owner_kind not in ("ticket", "doc"):
        raise DocsError(422, "invalid_owner", "owner_kind must be 'ticket' or 'doc'.")
    if await _project_of(session, owner_kind, owner_id, None) is None:
        raise DocsError(
            404,
            "owner_not_found",
            f"No {'ticket' if owner_kind == 'ticket' else 'Docs page'} with id {owner_id!r}.",
        )
    png = _read_local(path, "picture")
    source = _read_local(source_path, "source") if source_path else flat_source(png)
    out = await create_sketch(
        session,
        owner_kind=owner_kind,
        owner_id=owner_id,
        title=title,
        png=png,
        source=source,
    )
    return out


async def save_from_files(
    session: AsyncSession,
    sketch_id: str,
    *,
    path: str,
    base_version: int,
    source_path: str | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    """Save a local PNG (and its ``.sketch.json``) as a new version of a sketch; a stale ``base_version`` is refused
    (409 ``sketch_conflict``) before the files are read. Without a source the picture becomes one picture layer."""
    s = await _sketch(session, sketch_id)
    if base_version != s.version:
        return await update_sketch(
            session, sketch_id, base_version=base_version, png=b"", source=b""
        )
    png = _read_local(path, "picture")
    source = _read_local(source_path, "source") if source_path else flat_source(png)
    return await update_sketch(
        session,
        sketch_id,
        base_version=base_version,
        png=png,
        source=source,
        title=title,
    )
