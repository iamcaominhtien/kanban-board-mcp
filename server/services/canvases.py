"""Canvases: boards (HTML pages, images, Sketches, Diagrams), notes, arrows and labels on one large plane.

A canvas is one record (owner, revision, latest version) plus one file, ``uploads/canvases/<id>/canvas.json``, that holds
the page tabs, boards, notes, arrows and labels. A board's content is stored as attachment files next to it (an HTML
board is a folder); every change of a board's content is a new, never rewritten revision folder, so a version (a frozen
copy of ``canvas.json``) can always be shown or restored. It sits in a markdown field as ``![Name](canvas:cv_8f3a1c2d)``.

Rules the design (design/screens/canvas.md) asks for, and where they live:

* Layout changes (move, resize, notes, arrows, labels) need no lock and merge **per item**: every item carries the
  canvas revision it was last changed in, a save names the revision of each item it changes, and only an item changed
  twice conflicts (``save``).
* A board's content changes under a **lock** (``canvas_locks``); an AI member only ever *proposes* (``canvas_proposals``).
* Boards render in a locked frame; their files are cleaned on the way in (``canvas_html``).
* Versions are made on Done, on accepting a proposal, and every 10 minutes for a canvas that is a Docs page.
"""

import difflib
import io
import json
import os
import re
import shutil
import struct
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import Canvas, CanvasVersion, Sketch
from services import activity, canvas_html, canvas_locks, canvas_png
from services import sketches as svc_sketches
from services.docs_text import DocsError
from uploads import get_uploads_dir

FORMAT = "kanban-canvas"
FORMAT_VERSION = 1

MAX_BOARDS = 60
MAX_BOARD_BYTES = 5 * 1024 * 1024
MAX_CANVAS_BYTES = 50 * 1024 * 1024
MAX_PAGES = 10
MAX_FILES = 300
MAX_NOTES = 500
MAX_ARROWS = 500
MAX_LABELS = 300
MAX_TITLE = 200
MIN_W, MAX_W = 320, 1920
MIN_H, MAX_H = 120, 6000
AUTO_VERSION_SECONDS = 10 * 60
OWNER_KINDS = ("idea", "ticket", "doc", "comment", "page")
BOARD_KINDS = ("html", "image", "sketch", "diagram", "empty")
NOTE_COLORS = ("yellow", "green", "blue", "pink", "purple", "grey")
SIZE_PRESETS = {
    "desktop": (1280, 800),
    "laptop": (1440, 900),
    "wide": (1920, 1080),
    "tablet": (820, 1180),
    "phone": (390, 844),
}

CANVAS_REF = re.compile(r"\(canvas:(cv_[0-9a-f]{8})(?:#((?:b|p)_[0-9a-f]{8}))?\)")
_ALLOWED_EXT = {
    ".html", ".htm", ".css", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".otf", ".txt", ".json", ".md",
}  # fmt: skip
_SCRIPT_EXT = {".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".wasm", ".map"}
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}
MEDIA = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff",
    ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain; charset=utf-8",
    ".json": "application/json", ".md": "text/plain; charset=utf-8",
}  # fmt: skip


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def refs_in(markdown: str) -> list[str]:
    """The canvas ids a markdown text references, in order, without repeats."""
    seen: dict[str, None] = {}
    for m in CANVAS_REF.finditer(markdown or ""):
        seen.setdefault(m.group(1), None)
    return list(seen)


def embed_line(canvas_id: str, title: str, board_id: str | None = None) -> str:
    """The markdown line that shows a canvas (or one board of it)."""
    name = re.sub(r"[\[\]\n\r]+", " ", title).strip() or "Canvas"
    return f"![{name}](canvas:{canvas_id}{'#' + board_id if board_id else ''})"


# --- files -----------------------------------------------------------------------------------------------------


def canvas_dir(canvas_id: str) -> Any:
    """The folder one canvas keeps everything in (inside the uploads folder, so a backup carries it)."""
    p = get_uploads_dir() / "canvases" / canvas_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def doc_path(canvas_id: str) -> Any:
    """Path of the canvas file."""
    return canvas_dir(canvas_id) / "canvas.json"


def board_dir(canvas_id: str, board_id: str, rev: int) -> Any:
    """Folder of one revision of a board's content."""
    return canvas_dir(canvas_id) / "boards" / board_id / f"r{rev}"


def proposal_dir(canvas_id: str, proposal_id: str) -> Any:
    """Folder of the files an AI member proposed."""
    return canvas_dir(canvas_id) / "proposals" / proposal_id


def safe_path(raw: str) -> str:
    """A file path inside a board folder, normalised.

    Raises:
        DocsError: 422 for an absolute path, ``..``, or odd characters.
    """
    text = (raw or "").replace("\\", "/").strip().lstrip("/")
    p = PurePosixPath(text)
    if (
        not text
        or any(part in ("..", "", ".") for part in text.split("/"))
        or len(text) > 240
        or any(ord(ch) < 32 for ch in text)
    ):
        raise DocsError(422, "invalid_file", f"“{raw}” is not a usable file name.")
    return p.as_posix()


def write_doc(canvas_id: str, doc: dict[str, Any]) -> None:
    """Write the canvas file (atomically)."""
    path = doc_path(canvas_id)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), "utf-8")
    os.replace(tmp, path)


def read_doc(canvas_id: str) -> dict[str, Any]:
    """Read the canvas file.

    Raises:
        DocsError: 404 if the file is missing from the data folder.
    """
    try:
        return normalize(json.loads(doc_path(canvas_id).read_text("utf-8")))
    except (OSError, ValueError) as e:
        raise DocsError(
            404,
            "canvas_file_missing",
            "The canvas file is missing from the data folder.",
        ) from e


def blank_doc() -> dict[str, Any]:
    """An empty canvas file with one page tab."""
    return {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "pages": [{"id": _id("p"), "name": "Page 1", "rev": 1}],
        "boards": [],
        "notes": [],
        "arrows": [],
        "labels": [],
    }


def normalize(doc: Any) -> dict[str, Any]:
    """Make sure a canvas file has every list and at least one page tab."""
    if not isinstance(doc, dict) or doc.get("format") != FORMAT:
        raise DocsError(
            422, "invalid_canvas", "This is not a canvas file (wrong format)."
        )
    for key in ("pages", "boards", "notes", "arrows", "labels"):
        if not isinstance(doc.get(key), list):
            doc[key] = []
    if not doc["pages"]:
        doc["pages"] = [{"id": _id("p"), "name": "Page 1", "rev": 1}]
    return doc


# --- items -----------------------------------------------------------------------------------------------------


def _num(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def _text(value: Any, limit: int) -> str:
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value or ""))[:limit]


def _find(items: list[dict[str, Any]], item_id: str) -> dict[str, Any] | None:
    return next((i for i in items if i.get("id") == item_id), None)


def board_of(doc: dict[str, Any], board_id: str) -> dict[str, Any]:
    """A board of the canvas.

    Raises:
        DocsError: 404 if there is no such board.
    """
    b = _find(doc["boards"], board_id)
    if b is None:
        raise DocsError(
            404, "board_not_found", "That frame is not on this canvas any more."
        )
    return b


def clean_board_layout(
    src: dict[str, Any], old: dict[str, Any] | None
) -> dict[str, Any]:
    """The layout fields of a board a client may set: name, position, size, order and page tab."""
    base = old or {}
    return {
        "name": _text(src.get("name", base.get("name", "Frame")), MAX_TITLE).strip()
        or "Frame",
        "x": _num(src.get("x"), base.get("x", 0), -100000, 100000),
        "y": _num(src.get("y"), base.get("y", 0), -100000, 100000),
        "w": _num(src.get("w"), base.get("w", 1280), MIN_W, MAX_W),
        "h": _num(src.get("h"), base.get("h", 800), MIN_H, MAX_H),
        "order": int(_num(src.get("order"), base.get("order", 0), -1, 100000)),
        "page": src.get("page", base.get("page")),
    }


def _clean_note(
    src: dict[str, Any], old: dict[str, Any] | None, actor: str
) -> dict[str, Any]:
    base = old or {}
    color = src.get("color", base.get("color", "yellow"))
    return {
        "x": _num(src.get("x"), base.get("x", 0), -100000, 100000),
        "y": _num(src.get("y"), base.get("y", 0), -100000, 100000),
        "w": _num(src.get("w"), base.get("w", 160), 80, 600),
        "h": _num(src.get("h"), base.get("h", 100), 60, 600),
        "text": _text(src.get("text", base.get("text", "")), 1000),
        "color": color if color in NOTE_COLORS else "yellow",
        "by": base.get("by") or _initials(actor),
        "page": src.get("page", base.get("page")),
    }


def _clean_label(src: dict[str, Any], old: dict[str, Any] | None) -> dict[str, Any]:
    base = old or {}
    return {
        "x": _num(src.get("x"), base.get("x", 0), -100000, 100000),
        "y": _num(src.get("y"), base.get("y", 0), -100000, 100000),
        "text": _text(src.get("text", base.get("text", "")), 200),
        "size": int(_num(src.get("size"), base.get("size", 20), 10, 96)),
        "page": src.get("page", base.get("page")),
    }


def _clean_arrow(src: dict[str, Any], old: dict[str, Any] | None) -> dict[str, Any]:
    base = old or {}
    return {
        "from": _text(src.get("from", base.get("from")), 40),
        "to": _text(src.get("to", base.get("to")), 40),
        "label": _text(src.get("label", base.get("label", "")), 120),
        "page": src.get("page", base.get("page")),
    }


def _initials(name: str) -> str:
    parts = [p for p in re.split(r"[\s._-]+", name or "") if p]
    return ("".join(p[0] for p in parts[:2]) or "?").upper()


def _arrow_ends_exist(doc: dict[str, Any], arrow: dict[str, Any]) -> bool:
    return all(
        _find(doc["boards"], arrow[end]) is not None
        or _find(doc["notes"], arrow[end]) is not None
        for end in ("from", "to")
    )


# --- permissions, rows ---------------------------------------------------------------------------------------


def _need_member(role: str) -> None:
    if role == "viewer":
        raise DocsError(
            403,
            "read_only",
            "Viewers can look at a canvas, open it large, present it and read comments, but cannot edit it.",
        )


async def _canvas(
    session: AsyncSession, canvas_id: str, *, deleted_ok: bool = False
) -> Canvas:
    c = await session.get(Canvas, canvas_id)
    if c is None or (c.deleted_at and not deleted_ok):
        raise DocsError(
            404,
            "canvas_not_found",
            "Canvas not found. It was deleted, or you do not have access.",
        )
    return c


def _owner_for_project(kind: str) -> str:
    return "doc" if kind == "page" else kind


async def role_for(session: AsyncSession, c: Canvas) -> str:
    """The caller's role for a canvas: viewer, member or admin (the owner's access)."""
    return await svc_sketches.role_of(session, c.project_id)


async def member_role(session: AsyncSession, c: Canvas) -> str:
    """Like ``role_for`` but raises for viewers."""
    role = await role_for(session, c)
    _need_member(role)
    return role


def summary(c: Canvas, role: str) -> dict[str, Any]:
    """The canvas record as the API returns it (no file bodies)."""
    return {
        "id": c.id,
        "project_id": c.project_id,
        "owner_kind": c.owner_kind,
        "owner_id": c.owner_id,
        "page_id": c.page_id,
        "title": c.title,
        "rev": c.rev,
        "version": c.version,
        "board_count": c.board_count,
        "total_bytes": c.total_bytes,
        "created_by": c.created_by,
        "created_at": c.created_at,
        "updated_by": c.updated_by,
        "updated_at": c.updated_at,
        "deleted_at": c.deleted_at,
        "role": role,
        "can_edit": role != "viewer" and not c.deleted_at,
        "markdown": embed_line(c.id, c.title),
        "limits": limits(),
    }


def limits() -> dict[str, int]:
    """The numbers the editor needs to explain a refusal."""
    return {
        "boards": MAX_BOARDS,
        "board_bytes": MAX_BOARD_BYTES,
        "canvas_bytes": MAX_CANVAS_BYTES,
        "pages": MAX_PAGES,
        "lock_idle_seconds": canvas_locks.IDLE_SECONDS,
        "min_width": MIN_W,
        "max_width": MAX_W,
    }


def _totals(doc: dict[str, Any]) -> tuple[int, int]:
    boards = doc["boards"]
    return len(boards), sum(
        int((b.get("content") or {}).get("bytes", 0)) for b in boards
    )


def _touch(c: Canvas, doc: dict[str, Any]) -> None:
    """Bump the revision and the counters after the file changed."""
    c.rev += 1
    c.board_count, c.total_bytes = _totals(doc)
    c.updated_by = activity.current_actor()
    c.updated_at = _now()


# --- create, read, list, delete ---------------------------------------------------------------------------------


async def create_canvas(
    session: AsyncSession,
    *,
    owner_kind: str,
    owner_id: str,
    title: str | None,
    project_id: str | None = None,
    page_id: str | None = None,
    start: str = "blank",
    size: str | tuple[int, int] = "desktop",
) -> dict[str, Any]:
    """Create a canvas, with its first (empty) board when ``start`` is ``blank``.

    Args:
        owner_kind: ``idea``, ``ticket``, ``doc``, ``comment`` or ``page`` (a canvas that is its own Docs page).
        owner_id: Id of the ticket, page or idea that holds it.
        title: Name; becomes the alt text.
        project_id: Project, when the owner does not say (a comment still being written).
        page_id: The Docs page of a canvas that lives in Docs.
        start: ``blank`` (one empty board) or ``none`` (no board; boards come from files).
        size: Size of the first board.

    Returns:
        The saved canvas with its file.

    Raises:
        DocsError: 403 for viewers; 422 for a bad owner.
    """
    if owner_kind not in OWNER_KINDS:
        raise DocsError(
            422, "invalid_owner", f"owner_kind must be one of {OWNER_KINDS}"
        )
    if not owner_id.strip():
        raise DocsError(422, "invalid_owner", "owner_id is required")
    project = await svc_sketches._project_of(
        session, _owner_for_project(owner_kind), owner_id, project_id
    )  # noqa: SLF001
    _need_member(await svc_sketches.role_of(session, project))
    actor = activity.current_actor()
    name = svc_sketches._title(title, "Canvas")  # noqa: SLF001
    c = Canvas(
        project_id=project,
        owner_kind=owner_kind,
        owner_id=owner_id,
        page_id=page_id,
        title=name,
        created_by=actor,
        updated_by=actor,
    )
    session.add(c)
    await session.flush()
    doc = blank_doc()
    doc["pages"][0]["rev"] = 1
    if start == "blank":
        w, h = SIZE_PRESETS[size] if isinstance(size, str) else size
        doc["boards"].append(
            {
                "id": _id("b"), "page": doc["pages"][0]["id"], "name": "Frame 1", "kind": "empty",
                "x": 0, "y": 0, "w": w, "h": h, "order": 0, "ref": None, "content": None,
                "rev": 1, "created_by": actor,
            }
        )  # fmt: skip
    c.board_count, c.total_bytes = _totals(doc)
    write_doc(c.id, doc)
    await session.commit()
    await _version(session, c, "create", note="Created")
    await session.commit()
    return await get_canvas(session, c.id)


async def get_canvas(session: AsyncSession, canvas_id: str) -> dict[str, Any]:
    """The canvas with its file, the live locks and the number of open comments."""
    from services import canvas_comments, canvas_proposals

    c = await _canvas(session, canvas_id)
    role = await role_for(session, c)
    out = summary(c, role)
    out["doc"] = read_doc(c.id)
    out["locks"] = canvas_locks.locks_of(c.id)
    out["open_comments"] = await canvas_comments.open_count(session, c.id)
    out["proposals_open"] = await canvas_proposals.open_count(session, c.id)
    return out


async def list_canvases(
    session: AsyncSession, owner_kind: str, owner_id: str
) -> list[dict[str, Any]]:
    """The canvases of one page, ticket, idea or comment's ticket, newest change first."""
    rows = await session.exec(
        select(Canvas)
        .where(
            Canvas.owner_kind == owner_kind,
            Canvas.owner_id == owner_id,
            Canvas.deleted_at.is_(None),  # type: ignore[union-attr]
        )
        .order_by(Canvas.updated_at.desc())  # type: ignore[attr-defined]
    )
    out = []
    for c in rows.all():
        out.append(summary(c, await role_for(session, c)))
    return out


async def list_for_project(
    session: AsyncSession, project_id: str
) -> list[dict[str, Any]]:
    """A project's canvases in brief, newest change first."""
    rows = await session.exec(
        select(Canvas)
        .where(
            Canvas.project_id == project_id,
            Canvas.deleted_at.is_(None),  # type: ignore[union-attr]
        )
        .order_by(Canvas.updated_at.desc())  # type: ignore[attr-defined]
    )
    return [
        {
            "id": c.id,
            "title": c.title,
            "owner_kind": c.owner_kind,
            "owner_id": c.owner_id,
            "page_id": c.page_id,
            "version": c.version,
            "rev": c.rev,
            "boards": c.board_count,
            "updated_by": c.updated_by,
            "updated_at": c.updated_at,
            "markdown": embed_line(c.id, c.title),
        }
        for c in rows.all()
    ]


async def delete_canvas(session: AsyncSession, canvas_id: str) -> dict[str, Any]:
    """Unlink a canvas: it stops resolving but its row and files are kept and it can be restored."""
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    c.deleted_at = _now()
    c.deleted_by = activity.current_actor()
    session.add(c)
    await session.commit()
    canvas_locks.release_all(c.id)
    return {"id": c.id, "deleted_at": c.deleted_at}


async def restore_canvas(session: AsyncSession, canvas_id: str) -> dict[str, Any]:
    """Bring an unlinked canvas back."""
    c = await _canvas(session, canvas_id, deleted_ok=True)
    await member_role(session, c)
    c.deleted_at = None
    c.deleted_by = None
    session.add(c)
    await session.commit()
    return await get_canvas(session, c.id)


async def rename_canvas(session: AsyncSession, canvas_id: str, title: str) -> Canvas:
    """Change a canvas's name (not a new revision)."""
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    c.title = svc_sketches._title(title, c.title)  # noqa: SLF001
    session.add(c)
    return c


# --- save with a per-item merge ----------------------------------------------------------------------------------

KINDS = {"pages": "p", "boards": "b", "notes": "n", "arrows": "a", "labels": "t"}


def _conflict(c: Canvas, ids: list[str]) -> DocsError:
    return DocsError(
        409,
        "canvas_conflict",
        f"{c.updated_by} saved a newer version of the same frame or note while you were working.",
        latest_rev=c.rev,
        latest_author=c.updated_by,
        latest_at=c.updated_at,
        conflicts=ids,
    )


async def save(
    session: AsyncSession,
    canvas_id: str,
    *,
    base_rev: int,
    upsert: dict[str, list[dict[str, Any]]] | None = None,
    remove: list[str] | None = None,
    title: str | None = None,
    force: bool = False,
    checkpoint: bool = False,
    name: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Save layout changes, merged per item.

    Args:
        canvas_id: Canvas to change.
        base_rev: The revision the editor loaded (kept for the error message; the check is per item).
        upsert: ``{pages|boards|notes|arrows|labels: [item]}``. An item that exists must carry the ``rev`` the editor
            saw; a new note, arrow, label or page has no ``rev``. Boards are only moved/renamed here; their content
            and creation have their own calls.
        remove: Ids of items to delete (each with the editor's ``rev`` in ``remove_revs`` is not needed: removing an
            item that changed meanwhile conflicts through ``upsert`` only when it also moved).
        title: New canvas name.
        force: Overwrite items somebody else changed ("Replace theirs").
        checkpoint: Make a version of the whole canvas (Done).
        name: Name for that version.
        note: Note for that version.

    Returns:
        ``{rev, version, doc, saved}``.

    Raises:
        DocsError: 403 for viewers; 409 ``canvas_conflict`` if the same item was changed by both; 422 for limits.
    """
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    doc = read_doc(c.id)
    actor = activity.current_actor()
    upsert = upsert or {}
    remove = list(remove or [])
    new_rev = c.rev + 1
    conflicts: list[str] = []
    changed = 0

    for key, items in upsert.items():
        if key not in KINDS:
            raise DocsError(422, "invalid_canvas", f"Unknown list “{key}”.")
        for src in items:
            item_id = _text(src.get("id"), 40)
            existing = _find(doc[key], item_id) if item_id else None
            if existing is not None:
                if src.get("rev") != existing.get("rev") and not force:
                    conflicts.append(item_id)
                    continue
                before = json.dumps(existing, sort_keys=True)
                _apply(doc, key, existing, src, actor)
                if json.dumps(existing, sort_keys=True) != before:
                    existing["rev"] = new_rev
                    changed += 1
                continue
            if key == "boards":
                raise DocsError(
                    422,
                    "invalid_canvas",
                    "A frame is added with its content (POST /canvases/{id}/boards).",
                )
            if src.get("rev") is not None and not force:
                conflicts.append(
                    item_id
                )  # it existed when the editor loaded it, and somebody deleted it
                continue
            item = {
                "id": item_id
                if re.fullmatch(KINDS[key] + r"_[0-9a-f]{8}", item_id or "")
                else _id(KINDS[key])
            }
            doc[key].append(item)
            _apply(doc, key, item, src, actor)
            item["rev"] = new_rev
            changed += 1

    for item_id in remove:
        key = next((k for k, p in KINDS.items() if item_id.startswith(p + "_")), None)
        if key is None:
            continue
        existing = _find(doc[key], item_id)
        if existing is None:
            continue
        doc[key].remove(existing)
        if key == "pages":
            for k in ("boards", "notes", "labels", "arrows"):
                doc[k] = [i for i in doc[k] if i.get("page") != item_id]
        changed += 1

    if conflicts:
        raise _conflict(c, conflicts)

    _check_doc(doc)
    removed_boards = {i for i in remove if i.startswith("b_")}
    if removed_boards:
        canvas_locks.release_all(c.id, list(removed_boards))
    if title is not None:
        c.title = svc_sketches._title(title, c.title)  # noqa: SLF001
    if changed or title is not None or checkpoint:
        c.rev = new_rev - 1
        _touch(c, doc)
        write_doc(c.id, doc)
        session.add(c)
        await session.commit()
        if checkpoint:
            await _version(session, c, "done", name=name, note=note)
        elif c.page_id and _older_than(
            await _last_version_time(session, c.id), AUTO_VERSION_SECONDS
        ):
            await _version(session, c, "auto")
        await session.commit()
    return {"rev": c.rev, "version": c.version, "doc": doc, "saved": changed}


def _apply(
    doc: dict[str, Any], key: str, item: dict[str, Any], src: dict[str, Any], actor: str
) -> None:
    if key == "boards":
        item.update(clean_board_layout(src, item))
        if item.get("page") not in {p["id"] for p in doc["pages"]}:
            item["page"] = doc["pages"][0]["id"]
    elif key == "notes":
        item.update(_clean_note(src, item, actor))
    elif key == "labels":
        item.update(_clean_label(src, item))
    elif key == "arrows":
        item.update(_clean_arrow(src, item))
        if not _arrow_ends_exist(doc, item) or item["from"] == item["to"]:
            raise DocsError(
                422,
                "invalid_canvas",
                "An arrow joins two different frames or notes on this canvas.",
            )
    elif key == "pages":
        item["name"] = (
            _text(src.get("name", item.get("name", "Page")), 80).strip() or "Page"
        )
        item["order"] = int(
            _num(src.get("order"), item.get("order", len(doc["pages"])), 0, 1000)
        )


def _check_doc(doc: dict[str, Any]) -> None:
    if len(doc["pages"]) > MAX_PAGES:
        raise DocsError(
            422,
            "too_many_pages",
            f"A canvas has up to {MAX_PAGES} page tabs.",
            limit_pages=MAX_PAGES,
        )
    if not doc["pages"]:
        raise DocsError(422, "invalid_canvas", "A canvas needs at least one page tab.")
    if len(doc["boards"]) > MAX_BOARDS:
        raise DocsError(
            422,
            "too_many_boards",
            f"A canvas holds up to {MAX_BOARDS} frames.",
            limit_boards=MAX_BOARDS,
        )
    if (
        len(doc["notes"]) > MAX_NOTES
        or len(doc["arrows"]) > MAX_ARROWS
        or len(doc["labels"]) > MAX_LABELS
    ):
        raise DocsError(
            422, "too_many_items", "This canvas has too many notes, arrows or labels."
        )
    page_ids = {p["id"] for p in doc["pages"]}
    for k in ("boards", "notes", "labels", "arrows"):
        for i in doc[k]:
            if i.get("page") not in page_ids:
                i["page"] = doc["pages"][0]["id"]
    ends = {i["id"] for i in doc["boards"]} | {i["id"] for i in doc["notes"]}
    doc["arrows"] = [a for a in doc["arrows"] if a["from"] in ends and a["to"] in ends]


# --- versions ---------------------------------------------------------------------------------------------------


def _older_than(iso: str | None, seconds: int) -> bool:
    if not iso:
        return True
    try:
        return (
            datetime.now(UTC) - datetime.fromisoformat(iso)
        ).total_seconds() >= seconds
    except ValueError:
        return True


async def _last_version_time(session: AsyncSession, canvas_id: str) -> str | None:
    row = (
        await session.exec(
            select(CanvasVersion)
            .where(CanvasVersion.canvas_id == canvas_id)
            .order_by(CanvasVersion.version.desc())  # type: ignore[attr-defined]
            .limit(1)
        )
    ).first()
    return row.created_at if row else None


def diff_docs(old: dict[str, Any] | None, new: dict[str, Any]) -> dict[str, Any]:
    """What changed between two canvas files: boards added, removed and changed (content or name), and whether notes,
    arrows, labels or the layout moved."""
    old_b = {b["id"]: b for b in (old or {}).get("boards", [])}
    new_b = {b["id"]: b for b in new.get("boards", [])}
    added = [i for i in new_b if i not in old_b]
    removed = [i for i in old_b if i not in new_b]
    changed = [
        i
        for i in new_b
        if i in old_b
        and (
            (old_b[i].get("content") or {}).get("rev")
            != (new_b[i].get("content") or {}).get("rev")
            or old_b[i].get("ref") != new_b[i].get("ref")
            or old_b[i].get("name") != new_b[i].get("name")
        )
    ]
    layout = any(
        {k: old_b[i].get(k) for k in ("x", "y", "w", "h", "page")}
        != {k: new_b[i].get(k) for k in ("x", "y", "w", "h", "page")}
        for i in new_b
        if i in old_b
    )

    def strip(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{k: v for k, v in i.items() if k != "rev"} for i in items]

    extras = {
        k: strip((old or {}).get(k, [])) != strip(new.get(k, []))
        for k in ("notes", "arrows", "labels", "pages")
    }
    return {
        "added": added,
        "removed": removed,
        "changed": changed,
        "layout": layout,
        **extras,
    }


def describe_changes(ch: dict[str, Any], names: dict[str, str]) -> str:
    """A short sentence for History: "Sign in edited, 1 board added"."""
    parts = []
    if ch["changed"]:
        shown = ", ".join(names.get(i, "a frame") for i in ch["changed"][:2])
        parts.append(
            f"{shown} edited"
            + (f" and {len(ch['changed']) - 2} more" if len(ch["changed"]) > 2 else "")
        )
    if ch["added"]:
        parts.append(
            f"{len(ch['added'])} frame{'s' if len(ch['added']) != 1 else ''} added"
        )
    if ch["removed"]:
        parts.append(
            f"{len(ch['removed'])} frame{'s' if len(ch['removed']) != 1 else ''} removed"
        )
    if not parts:
        extra = [
            w
            for w, k in (("Notes", "notes"), ("Arrows", "arrows"), ("Labels", "labels"))
            if ch.get(k)
        ]
        if extra:
            parts.append(" and ".join(extra).lower().capitalize())
        elif ch.get("layout") or ch.get("pages"):
            parts.append("Layout changed")
    return ", ".join(parts)


async def _version(
    session: AsyncSession,
    c: Canvas,
    reason: str,
    *,
    name: str | None = None,
    note: str | None = None,
    author: str | None = None,
) -> CanvasVersion:
    """Freeze the current file as the next version."""
    doc = read_doc(c.id)
    prev = (
        await session.exec(
            select(CanvasVersion)
            .where(CanvasVersion.canvas_id == c.id)
            .order_by(CanvasVersion.version.desc())  # type: ignore[attr-defined]
            .limit(1)
        )
    ).first()
    old = json.loads(prev.doc) if prev else None
    ch = diff_docs(old, doc)
    names = {b["id"]: b["name"] for b in doc["boards"]} | {
        b["id"]: b["name"] for b in (old or {}).get("boards", [])
    }
    c.version += 1
    v = CanvasVersion(
        canvas_id=c.id,
        version=c.version,
        name=(name or None) and _text(name, 80),
        reason=reason,
        author=author or activity.current_actor(),
        note=note,
        changes=json.dumps(ch),
        summary=describe_changes(ch, names) if prev else (note or "Created"),
        doc=json.dumps(doc, ensure_ascii=False),
    )
    session.add(v)
    session.add(c)
    return v


def _version_out(v: CanvasVersion, *, with_doc: bool = False) -> dict[str, Any]:
    out = {
        "version": v.version,
        "name": v.name,
        "reason": v.reason,
        "author": v.author,
        "note": v.note,
        "summary": v.summary,
        "changes": json.loads(v.changes or "{}"),
        "created_at": v.created_at,
    }
    if with_doc:
        out["doc"] = json.loads(v.doc)
    return out


async def list_versions(session: AsyncSession, canvas_id: str) -> list[dict[str, Any]]:
    """The canvas's versions, newest first."""
    await _canvas(session, canvas_id)
    rows = await session.exec(
        select(CanvasVersion)
        .where(CanvasVersion.canvas_id == canvas_id)
        .order_by(CanvasVersion.version.desc())  # type: ignore[attr-defined]
    )
    return [_version_out(v) for v in rows.all()]


async def _get_version(session: AsyncSession, canvas_id: str, n: int) -> CanvasVersion:
    v = (
        await session.exec(
            select(CanvasVersion).where(
                CanvasVersion.canvas_id == canvas_id, CanvasVersion.version == n
            )
        )
    ).first()
    if v is None:
        raise DocsError(
            404, "version_not_found", f"There is no version {n} of this canvas."
        )
    return v


async def get_version(session: AsyncSession, canvas_id: str, n: int) -> dict[str, Any]:
    """One version with the canvas file as it was."""
    await _canvas(session, canvas_id)
    return _version_out(await _get_version(session, canvas_id, n), with_doc=True)


async def name_version(
    session: AsyncSession, canvas_id: str, n: int, name: str | None
) -> dict[str, Any]:
    """Name (or unname) a version."""
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    v = await _get_version(session, canvas_id, n)
    v.name = _text(name, 80).strip() or None
    session.add(v)
    await session.commit()
    return _version_out(v)


async def make_version(
    session: AsyncSession,
    canvas_id: str,
    *,
    name: str | None = None,
    note: str | None = None,
    reason: str = "named",
) -> dict[str, Any]:
    """Make a version of the canvas as it is now."""
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    v = await _version(session, c, reason, name=name, note=note)
    await session.commit()
    return _version_out(v)


async def restore_version(
    session: AsyncSession, canvas_id: str, n: int
) -> dict[str, Any]:
    """Restore a version. Restoring makes a *new* version; nothing is lost.

    Raises:
        DocsError: 403 for viewers; 423 ``board_locked`` while somebody is editing a frame.
    """
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    live = canvas_locks.locks_of(c.id)
    if live:
        raise DocsError(
            423,
            "board_locked",
            f"{live[0]['holder']} is editing a frame. Restore once they save or leave.",
            locks=live,
        )
    old = json.loads((await _get_version(session, canvas_id, n)).doc)
    doc = normalize(old)
    new_rev = c.rev + 1
    for k in KINDS:
        for item in doc[k]:
            item["rev"] = (
                new_rev  # everybody still working on the old state conflicts on their next save
            )
    c.rev = new_rev - 1
    _touch(c, doc)
    write_doc(c.id, doc)
    session.add(c)
    await session.commit()
    await _version(session, c, "restore", note=f"Restored version {n}")
    await session.commit()
    return await get_canvas(session, c.id)


async def compare(
    session: AsyncSession, canvas_id: str, a: int, b: int
) -> dict[str, Any]:
    """Compare two versions board by board: ``same``, ``changed``, ``added`` or ``removed`` (``b`` against ``a``)."""
    await _canvas(session, canvas_id)
    da = json.loads((await _get_version(session, canvas_id, a)).doc)
    db = json.loads((await _get_version(session, canvas_id, b)).doc)
    ba = {x["id"]: x for x in da["boards"]}
    bb = {x["id"]: x for x in db["boards"]}
    rows = []
    for bid in list(bb) + [i for i in ba if i not in bb]:
        x, y = ba.get(bid), bb.get(bid)
        if x is None:
            state = "added"
        elif y is None:
            state = "removed"
        elif (x.get("content") or {}).get("rev") != (y.get("content") or {}).get(
            "rev"
        ) or x.get("ref") != y.get("ref"):
            state = "changed"
        else:
            state = "same"
        rows.append(
            {
                "board_id": bid,
                "name": (y or x)["name"],
                "state": state,
                "kind": (y or x)["kind"],
                "a": x,
                "b": y,
            }
        )
    return {"a": a, "b": b, "boards": rows}


async def source_diff(
    session: AsyncSession, canvas_id: str, board_id: str, a: int, b: int
) -> dict[str, Any]:
    """Line diff of a board's source between two versions (the entry file, then other text files)."""
    await _canvas(session, canvas_id)
    da = json.loads((await _get_version(session, canvas_id, a)).doc)
    db = json.loads((await _get_version(session, canvas_id, b)).doc)
    xa = _find(da["boards"], board_id)
    xb = _find(db["boards"], board_id)
    files: list[dict[str, Any]] = []
    paths = {
        f["path"]
        for bd in (xa, xb)
        if bd and bd.get("content")
        for f in bd["content"]["files"]
    }
    for path in sorted(paths):
        if PurePosixPath(path).suffix.lower() not in (
            ".html",
            ".htm",
            ".css",
            ".txt",
            ".md",
            ".json",
        ):
            continue
        before = _read_text(canvas_id, board_id, xa, path)
        after = _read_text(canvas_id, board_id, xb, path)
        if before == after:
            continue
        diff = list(
            difflib.unified_diff(
                before.splitlines(),
                after.splitlines(),
                f"v{a}/{path}",
                f"v{b}/{path}",
                lineterm="",
                n=2,
            )
        )
        files.append({"path": path, "diff": "\n".join(diff[:2000])})
    return {"board_id": board_id, "a": a, "b": b, "files": files}


def _read_text(
    canvas_id: str, board_id: str, board: dict[str, Any] | None, path: str
) -> str:
    if not board or not board.get("content"):
        return ""
    try:
        return (
            board_dir(canvas_id, board_id, board["content"]["rev"]) / path
        ).read_text("utf-8", errors="replace")
    except OSError:
        return ""


# --- boards: content -----------------------------------------------------------------------------------------


def _magic_image(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    head = data[:1024].lstrip().lower()
    if head.startswith(b"<svg") or (
        head.startswith(b"<?xml") and b"<svg" in data[:2048].lower()
    ):
        return ".svg"
    return None


def image_size(data: bytes) -> tuple[int, int] | None:
    """Width and height of a PNG, JPEG, GIF, WebP or SVG, read from the header."""
    try:
        if data.startswith(b"\x89PNG"):
            return struct.unpack(">II", data[16:24])
        if data[:3] == b"GIF":
            return struct.unpack("<HH", data[6:10])
        if data.startswith(b"\xff\xd8"):
            i = 2
            while i < len(data) - 9:
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                    return w, h
                i += 2 + struct.unpack(">H", data[i + 2 : i + 4])[0]
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            kind = data[12:16]
            if kind == b"VP8X":
                return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(
                    data[27:30], "little"
                )
            if kind == b"VP8 ":
                return struct.unpack("<HH", data[26:30])[0] & 0x3FFF, struct.unpack(
                    "<HH", data[26:30]
                )[1] & 0x3FFF
            if kind == b"VP8L":
                bits = int.from_bytes(data[21:25], "little")
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        text = data[:4096].decode("utf-8", "ignore")
        m = re.search(r"<svg[^>]*>", text, re.I | re.S)
        if m:
            tag = m.group(0)
            wm = re.search(r'\bwidth="([\d.]+)', tag)
            hm = re.search(r'\bheight="([\d.]+)', tag)
            if wm and hm:
                return int(float(wm.group(1))), int(float(hm.group(1)))
            vb = re.search(
                r'viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"', tag
            )
            if vb:
                return int(float(vb.group(1))), int(float(vb.group(2)))
    except (struct.error, IndexError, ValueError):
        return None
    return None


def prepare_files(
    files: dict[str, bytes], entry: str | None = None
) -> tuple[dict[str, bytes], dict[str, Any]]:
    """Check and clean the files of an HTML board.

    Args:
        files: ``{path: bytes}``.
        entry: The page to show (``index.html`` or the first ``.html`` file when omitted).

    Returns:
        ``(clean files, content info {entry, files, bytes, blocked, title})``.

    Raises:
        DocsError: 413 over the size limit, 422 for no page, too many files or a bad path.
    """
    if len(files) > MAX_FILES:
        raise DocsError(
            422, "too_many_files", f"A frame holds up to {MAX_FILES} files."
        )
    blocked = canvas_html.Blocked()
    clean: dict[str, bytes] = {}
    skipped: list[str] = []
    title = ""
    for raw, data in files.items():
        path = safe_path(raw)
        ext = PurePosixPath(path).suffix.lower()
        if ext in _SCRIPT_EXT:
            blocked.script += 1
            skipped.append(path)
            continue
        if ext not in _ALLOWED_EXT:
            skipped.append(path)
            continue
        if ext in (".html", ".htm"):
            text, b = canvas_html.clean_html(data.decode("utf-8", errors="replace"))
            blocked.merge(b)
            clean[path] = text.encode("utf-8")
        elif ext == ".css":
            clean[path] = canvas_html.clean_css(
                data.decode("utf-8", errors="replace"), blocked
            ).encode("utf-8")
        else:
            clean[path] = data
    total = sum(len(v) for v in clean.values())
    if total > MAX_BOARD_BYTES:
        raise _too_large_board(total)
    pages = sorted(p for p in clean if p.lower().endswith((".html", ".htm")))
    if not pages:
        raise DocsError(
            422, "no_page", "A frame needs an HTML page (for example index.html)."
        )
    if entry:
        entry = safe_path(entry)
        if entry not in clean:
            raise DocsError(
                422, "no_page", f"The page “{entry}” is not among the files."
            )
    else:
        entry = "index.html" if "index.html" in clean else pages[0]
    title = canvas_html.title_of(clean[entry].decode("utf-8", errors="replace"))
    info = {
        "entry": entry,
        "files": [{"path": p, "bytes": len(clean[p])} for p in sorted(clean)],
        "bytes": total,
        "blocked": blocked.as_list(),
        "blocked_total": blocked.total(),
        "skipped": skipped,
        "title": title,
    }
    return clean, info


def _too_large_board(size: int) -> DocsError:
    return DocsError(
        413,
        "board_too_large",
        f"This frame is {size / (1024 * 1024):.1f} MB. A frame can hold up to {MAX_BOARD_BYTES // (1024 * 1024)} MB, "
        f"and a canvas {MAX_BOARDS} frames and {MAX_CANVAS_BYTES // (1024 * 1024)} MB. Remove embedded images or split the page, then save again.",
        size_bytes=size,
        limit_bytes=MAX_BOARD_BYTES,
        limit_boards=MAX_BOARDS,
        limit_canvas_bytes=MAX_CANVAS_BYTES,
    )


def _check_canvas_bytes(
    doc: dict[str, Any], replacing: str | None, new_bytes: int
) -> None:
    total = sum(
        int((b.get("content") or {}).get("bytes", 0))
        for b in doc["boards"]
        if b["id"] != replacing
    )
    if total + new_bytes > MAX_CANVAS_BYTES:
        raise DocsError(
            413,
            "canvas_too_large",
            f"This canvas would be {(total + new_bytes) / (1024 * 1024):.1f} MB. A canvas can hold up to {MAX_CANVAS_BYTES // (1024 * 1024)} MB.",
            limit_canvas_bytes=MAX_CANVAS_BYTES,
        )


def write_revision(
    canvas_id: str, board_id: str, rev: int, files: dict[str, bytes]
) -> None:
    """Write a board's files as revision ``rev`` (never over an earlier one)."""
    root = board_dir(canvas_id, board_id, rev)
    if root.exists():
        shutil.rmtree(root)
    for path, data in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def _free_spot(
    doc: dict[str, Any], page: str, w: float, h: float
) -> tuple[float, float]:
    """To the right of the last frame, never on top of another."""
    same = [b for b in doc["boards"] if b.get("page") == page]
    if not same:
        return 0.0, 0.0
    last = max(same, key=lambda b: (b["x"] + b["w"], -b["y"]))
    x, y = last["x"] + last["w"] + 80, min(b["y"] for b in same)
    while any(
        x < b["x"] + b["w"]
        and x + w > b["x"]
        and y < b["y"] + b["h"]
        and y + h > b["y"]
        for b in same
    ):
        x += 80
    return float(x), float(y)


async def add_board(
    session: AsyncSession,
    canvas_id: str,
    *,
    name: str | None = None,
    kind: str = "empty",
    page: str | None = None,
    files: dict[str, bytes] | None = None,
    entry: str | None = None,
    ref: str | None = None,
    size: str | tuple[int, int] | None = None,
    x: float | None = None,
    y: float | None = None,
) -> dict[str, Any]:
    """Add a frame to the canvas.

    Args:
        canvas_id: Canvas to add to.
        name: Name of the frame (the page title, or "Frame n").
        kind: ``html`` (needs ``files``), ``image`` (one picture in ``files``), ``sketch`` / ``diagram`` (``ref``)
            or ``empty``.
        page: Page tab; the first when omitted.
        files: ``{path: bytes}`` of an HTML or image frame.
        entry: The page of an HTML frame to show.
        ref: Id of the Sketch (``sk_…``) or Diagram (``dg_…``) a frame holds; it always shows its latest version.
        size: A preset name (``desktop``…) or ``(width, height)``.
        x: Position; placed to the right of the last frame when omitted.
        y: Position.

    Returns:
        ``{board, rev}``.

    Raises:
        DocsError: 403, 413/422 for limits and bad files.
    """
    if kind not in BOARD_KINDS:
        raise DocsError(422, "invalid_board", f"kind must be one of {BOARD_KINDS}")
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    doc = read_doc(c.id)
    if len(doc["boards"]) >= MAX_BOARDS:
        raise DocsError(
            422,
            "too_many_boards",
            f"A canvas holds up to {MAX_BOARDS} frames.",
            limit_boards=MAX_BOARDS,
        )
    page = page if page in {p["id"] for p in doc["pages"]} else doc["pages"][0]["id"]
    board_id = _id("b")
    new_rev = c.rev + 1
    content: dict[str, Any] | None = None
    written: dict[str, bytes] = {}
    w, h = (
        SIZE_PRESETS.get(size, SIZE_PRESETS["desktop"])
        if isinstance(size, str) or size is None
        else size
    )
    title = ""
    if kind == "html":
        if not files:
            raise DocsError(422, "no_page", "A frame needs an HTML page.")
        written, content = prepare_files(files, entry)
        title = content["title"]
    elif kind == "image":
        if not files or len(files) != 1:
            raise DocsError(422, "invalid_file", "An image frame holds one picture.")
        ((raw_name, data),) = files.items()
        ext = _magic_image(data)
        if ext is None:
            raise DocsError(
                422, "invalid_file", "Pictures can be PNG, JPEG, GIF, WebP or SVG."
            )
        if len(data) > MAX_BOARD_BYTES:
            raise _too_large_board(len(data))
        file_name = f"image{ext}"
        written = {file_name: data}
        content = {
            "entry": file_name, "files": [{"path": file_name, "bytes": len(data)}], "bytes": len(data),
            "blocked": [], "blocked_total": 0, "skipped": [], "title": PurePosixPath(raw_name).stem,
        }  # fmt: skip
        title = content["title"]
        dims = image_size(data)
        if dims and size is None:
            w = min(MAX_W, max(MIN_W, dims[0]))
            h = min(MAX_H, max(MIN_H, round(dims[1] * w / max(dims[0], 1))))
    elif kind in ("sketch", "diagram"):
        title, dims = await _check_ref(session, c, kind, ref)
        if dims and size is None:
            w = min(MAX_W, max(MIN_W, dims[0]))
            h = min(MAX_H, max(MIN_H, round(dims[1] * w / max(dims[0], 1))))
    if content is not None:
        _check_canvas_bytes(doc, None, content["bytes"])
        content["rev"] = new_rev
    px, py = _free_spot(doc, page, w, h)
    actor = activity.current_actor()
    n_same = len([b for b in doc["boards"] if b.get("page") == page])
    board = {
        "id": board_id,
        "page": page,
        "name": (
            _text(name, MAX_TITLE).strip() or title or f"Frame {len(doc['boards']) + 1}"
        ),
        "kind": kind,
        "x": px if x is None else float(x),
        "y": py if y is None else float(y),
        "w": float(w),
        "h": float(h),
        "order": n_same,
        "ref": ref if kind in ("sketch", "diagram") else None,
        "content": content,
        "rev": new_rev,
        "created_by": actor,
    }
    if written:
        write_revision(c.id, board_id, new_rev, written)
    doc["boards"].append(board)
    c.rev = new_rev - 1
    _touch(c, doc)
    write_doc(c.id, doc)
    session.add(c)
    await session.commit()
    return {"board": board, "rev": c.rev}


async def _check_ref(
    session: AsyncSession, c: Canvas, kind: str, ref: str | None
) -> tuple[str, tuple[int, int] | None]:
    """The Sketch or Diagram a frame holds must exist and belong to the same project."""
    if kind == "sketch":
        s = await session.get(Sketch, ref or "")
        if s is None or s.deleted_at:
            raise DocsError(404, "sketch_not_found", "That sketch was not found.")
        if s.project_id != c.project_id:
            raise DocsError(
                422, "other_project", "That sketch belongs to another project."
            )
        return s.title, (s.width, s.height)
    from models import Diagram

    d = await session.get(Diagram, ref or "")
    if d is None or d.deleted_at:
        raise DocsError(404, "diagram_not_found", "That diagram was not found.")
    if d.project_id != c.project_id:
        raise DocsError(
            422, "other_project", "That diagram belongs to another project."
        )
    return d.label, None


async def put_board_content(
    session: AsyncSession,
    canvas_id: str,
    board_id: str,
    *,
    files: dict[str, bytes],
    entry: str | None = None,
    base_content_rev: int | None = None,
    release: bool = True,
    author: str | None = None,
    reason: str = "board",
) -> dict[str, Any]:
    """Save a frame's new content (the person editing it holds the lock).

    Args:
        canvas_id: Canvas.
        board_id: Frame to change.
        files: The whole new set of files.
        entry: The page to show.
        base_content_rev: The content revision the editor started from; a different one means somebody saved meanwhile.
        release: Let go of the lock after saving (Save to canvas).
        author: Who is credited (an accepted AI proposal credits the person who accepted it).
        reason: Internal tag for the audit trail.

    Raises:
        DocsError: 423 ``board_locked`` if somebody else holds the frame; 409 ``board_conflict``; 413/422.
    """
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    doc = read_doc(c.id)
    board = board_of(doc, board_id)
    if board["kind"] not in ("html", "empty"):
        raise DocsError(
            422,
            "not_editable_here",
            "Images, Sketches and Diagrams are changed in their own editors.",
        )
    actor = activity.current_actor()
    taken, lock = canvas_locks.acquire(c.id, board_id, actor)
    if not taken:
        raise _locked(board, lock)
    cur_rev = (board.get("content") or {}).get("rev")
    if (
        base_content_rev is not None
        and cur_rev is not None
        and base_content_rev != cur_rev
    ):
        raise DocsError(
            409,
            "board_conflict",
            f"{c.updated_by} saved a newer version of {board['name']} while you were editing it.",
            latest_content_rev=cur_rev,
            latest_author=c.updated_by,
        )
    written, content = prepare_files(files, entry)
    _check_canvas_bytes(doc, board_id, content["bytes"])
    new_rev = c.rev + 1
    content["rev"] = new_rev
    write_revision(c.id, board_id, new_rev, written)
    board["kind"] = "html"
    board["content"] = content
    board["rev"] = new_rev
    c.rev = new_rev - 1
    _touch(c, doc)
    write_doc(c.id, doc)
    session.add(c)
    await session.commit()
    if release:
        canvas_locks.release(c.id, board_id, actor)
    return {"board": board, "rev": c.rev}


def _locked(board: dict[str, Any], lock: canvas_locks.Lock) -> DocsError:
    return DocsError(
        423,
        "board_locked",
        f"{lock.holder} is editing {board['name']}. You can still look, comment and move it.",
        holder=lock.holder,
        since=lock.since_iso,
        board_id=board["id"],
    )


async def lock_board(
    session: AsyncSession, canvas_id: str, board_id: str
) -> dict[str, Any]:
    """Take the lock on a frame so its content can be changed.

    Raises:
        DocsError: 423 ``board_locked`` if somebody else holds it; 422 for a frame that is not edited as source.
    """
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    board = board_of(read_doc(c.id), board_id)
    if board["kind"] not in ("html", "empty"):
        raise DocsError(
            422,
            "not_editable_here",
            "Images, Sketches and Diagrams are changed in their own editors.",
        )
    taken, lock = canvas_locks.acquire(c.id, board_id, activity.current_actor())
    if not taken:
        raise _locked(board, lock)
    return canvas_locks.describe(c.id, board_id) or {}


async def heartbeat_board(
    session: AsyncSession, canvas_id: str, board_id: str
) -> dict[str, Any]:
    """Show you are still editing. ``{alive: False}`` when the lock was lost."""
    await _canvas(session, canvas_id)
    ok = canvas_locks.heartbeat(canvas_id, board_id, activity.current_actor())
    return {"alive": ok, "lock": canvas_locks.describe(canvas_id, board_id)}


async def unlock_board(
    session: AsyncSession, canvas_id: str, board_id: str
) -> dict[str, Any]:
    """Let go of the lock (Cancel, or closing the editor)."""
    await _canvas(session, canvas_id)
    return {
        "released": canvas_locks.release(canvas_id, board_id, activity.current_actor())
    }


async def duplicate_board(
    session: AsyncSession, canvas_id: str, board_id: str
) -> dict[str, Any]:
    """Copy a frame next to the original."""
    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    doc = read_doc(c.id)
    src = board_of(doc, board_id)
    if len(doc["boards"]) >= MAX_BOARDS:
        raise DocsError(
            422,
            "too_many_boards",
            f"A canvas holds up to {MAX_BOARDS} frames.",
            limit_boards=MAX_BOARDS,
        )
    new_rev = c.rev + 1
    copy = json.loads(json.dumps(src))
    copy["id"] = _id("b")
    copy["name"] = f"{src['name']} copy"[:MAX_TITLE]
    copy["x"], copy["y"] = _free_spot(doc, src["page"], src["w"], src["h"])
    copy["order"] = len([b for b in doc["boards"] if b.get("page") == src["page"]])
    copy["rev"] = new_rev
    copy["created_by"] = activity.current_actor()
    if src.get("content"):
        _check_canvas_bytes(doc, None, src["content"]["bytes"])
        old = board_dir(c.id, src["id"], src["content"]["rev"])
        files = {
            p.relative_to(old).as_posix(): p.read_bytes()
            for p in old.rglob("*")
            if p.is_file()
        }
        copy["content"]["rev"] = new_rev
        write_revision(c.id, copy["id"], new_rev, files)
    doc["boards"].append(copy)
    c.rev = new_rev - 1
    _touch(c, doc)
    write_doc(c.id, doc)
    session.add(c)
    await session.commit()
    return {"board": copy, "rev": c.rev}


async def board_binary_files(
    session: AsyncSession, canvas_id: str, board_id: str
) -> dict[str, bytes]:
    """The pictures and fonts of a frame (everything the source editor does not show), kept when its text is saved."""
    c = await _canvas(session, canvas_id)
    content = board_of(read_doc(c.id), board_id).get("content")
    if not content:
        return {}
    root = board_dir(c.id, board_id, content["rev"])
    return {
        f["path"]: (root / f["path"]).read_bytes()
        for f in content["files"]
        if PurePosixPath(f["path"]).suffix.lower()
        not in (".html", ".htm", ".css", ".txt", ".md", ".json")
        and (root / f["path"]).is_file()
    }


async def copy_canvas(
    session: AsyncSession, canvas_id: str, title: str | None = None
) -> dict[str, Any]:
    """Save a copy: a second canvas of the same owner with the same frames, notes, arrows and labels. Comments and
    history stay with the original."""
    src = await _canvas(session, canvas_id)
    await member_role(session, src)
    doc = read_doc(src.id)
    actor = activity.current_actor()
    c = Canvas(
        project_id=src.project_id,
        owner_kind="doc" if src.owner_kind == "page" else src.owner_kind,
        owner_id=src.owner_id,
        title=svc_sketches._title(title, f"{src.title} copy"),  # noqa: SLF001
        created_by=actor,
        updated_by=actor,
    )
    session.add(c)
    await session.flush()
    for k in KINDS:
        for item in doc[k]:
            item["rev"] = 1
    for b in doc["boards"]:
        if b.get("content"):
            b["content"]["rev"] = 1
    # copy each frame's current files as revision 1
    src_doc = read_doc(src.id)
    for b, sb in zip(doc["boards"], src_doc["boards"], strict=True):
        if sb.get("content"):
            root = board_dir(src.id, sb["id"], sb["content"]["rev"])
            write_revision(
                c.id,
                b["id"],
                1,
                {
                    p.relative_to(root).as_posix(): p.read_bytes()
                    for p in root.rglob("*")
                    if p.is_file()
                },
            )
    c.board_count, c.total_bytes = _totals(doc)
    write_doc(c.id, doc)
    await session.commit()
    await _version(session, c, "create", note=f"Copy of {src.title}")
    await session.commit()
    return await get_canvas(session, c.id)


async def read_board_file(
    session: AsyncSession, canvas_id: str, board_id: str, rev: int, path: str
) -> tuple[bytes, str]:
    """A file of one revision of a frame: ``(bytes, media type)``.

    Raises:
        DocsError: 404 if the frame or file does not exist.
    """
    c = await _canvas(session, canvas_id)
    root = board_dir(c.id, board_id, rev)
    target = (root / safe_path(path)).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as e:
        raise DocsError(404, "file_not_found", "That file is not in the frame.") from e
    if not target.is_file():
        raise DocsError(404, "file_not_found", "That file is not in the frame.")
    ext = target.suffix.lower()
    return target.read_bytes(), MEDIA.get(ext, "application/octet-stream")


async def board_source(
    session: AsyncSession, canvas_id: str, board_id: str
) -> dict[str, Any]:
    """The text files of an HTML frame, for the source editor."""
    c = await _canvas(session, canvas_id)
    board = board_of(read_doc(c.id), board_id)
    content = board.get("content")
    if not content:
        return {"board_id": board_id, "rev": None, "entry": "index.html", "files": []}
    root = board_dir(c.id, board_id, content["rev"])
    files = []
    for f in content["files"]:
        if PurePosixPath(f["path"]).suffix.lower() in (
            ".html",
            ".htm",
            ".css",
            ".txt",
            ".md",
            ".json",
        ):
            try:
                files.append(
                    {
                        "path": f["path"],
                        "text": (root / f["path"]).read_text("utf-8", errors="replace"),
                    }
                )
            except OSError:
                continue
    return {
        "board_id": board_id,
        "rev": content["rev"],
        "entry": content["entry"],
        "files": files,
    }


async def board_snapshot(
    session: AsyncSession, canvas_id: str, board_id: str, rev: int | None = None
) -> bytes:
    """A PNG wireframe of an HTML or empty frame (what is drawn below 40% zoom)."""
    c = await _canvas(session, canvas_id)
    board = board_of(read_doc(c.id), board_id)
    content = board.get("content")
    html_text = None
    if content and board["kind"] == "html":
        r = rev if rev is not None else content["rev"]
        try:
            html_text = (board_dir(c.id, board_id, r) / content["entry"]).read_text(
                "utf-8", errors="replace"
            )
        except OSError:
            html_text = None
    return canvas_png.board_snapshot(html_text, int(board["w"]), int(board["h"]))


async def overview_png(
    session: AsyncSession, canvas_id: str, page: str | None = None
) -> bytes:
    """A PNG wireframe of one page tab (what an export writes where the canvas stood)."""
    c = await _canvas(session, canvas_id)
    return canvas_png.overview(read_doc(c.id), page)


# --- import and export -----------------------------------------------------------------------------------------


def _unzip(data: bytes) -> dict[str, bytes]:
    """The files of a ZIP, safely: no absolute paths or ``..``, a size cap on what it unpacks to."""
    out: dict[str, bytes] = {}
    total = 0
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise DocsError(422, "invalid_file", "That ZIP file could not be read.") from e
    with z:
        infos = [
            i
            for i in z.infolist()
            if not i.is_dir() and not i.filename.startswith("__MACOSX/")
        ]
        if len(infos) > MAX_FILES * 4:
            raise DocsError(422, "too_many_files", "That ZIP holds too many files.")
        for info in infos:
            total += info.file_size
            if total > MAX_CANVAS_BYTES:
                raise DocsError(
                    413,
                    "canvas_too_large",
                    "That ZIP unpacks to more than the canvas can hold.",
                )
            try:
                out[safe_path(info.filename)] = z.read(info)
            except DocsError:
                continue
    return out


def _strip_common_root(files: dict[str, bytes]) -> dict[str, bytes]:
    tops = {p.split("/", 1)[0] for p in files}
    if len(tops) == 1 and all("/" in p for p in files):
        return {p.split("/", 1)[1]: v for p, v in files.items()}
    return files


async def import_files(
    session: AsyncSession,
    canvas_id: str,
    uploads: list[tuple[str, bytes]],
    *,
    page: str | None = None,
    size: str | tuple[int, int] | None = None,
) -> dict[str, Any]:
    """Make a frame of each file: an HTML file, a picture, or a ZIP of a built page. Each is placed to the right of
    the last one. (``.sketch`` and ``.drawio`` files are turned into a Sketch or Diagram by the editor, which then adds
    a frame that points at it.)

    Returns:
        ``{boards: [...], failed: [{name, message}], rev}``.
    """
    boards, failed = [], []
    for name, data in uploads:
        stem = PurePosixPath(name.replace("\\", "/")).name
        ext = PurePosixPath(stem).suffix.lower()
        try:
            if ext == ".zip":
                files = _strip_common_root(_unzip(data))
                out = await add_board(
                    session,
                    canvas_id,
                    kind="html",
                    files=files,
                    page=page,
                    size=size or "desktop",
                )
            elif ext in (".html", ".htm"):
                stem_name = PurePosixPath(stem).stem
                out = await add_board(
                    session,
                    canvas_id,
                    kind="html",
                    files={"index.html": data},
                    name=None if stem_name.lower() == "index" else stem_name,
                    page=page,
                    size=size or "desktop",
                )
            elif ext in _IMAGE_EXT:
                out = await add_board(
                    session,
                    canvas_id,
                    kind="image",
                    files={stem: data},
                    page=page,
                    size=size,
                )
            else:
                raise DocsError(
                    422,
                    "invalid_file",
                    f"“{stem}” cannot become a frame. Use an HTML file, a picture, or a ZIP of a built page.",
                )
            boards.append(out["board"])
        except DocsError as e:
            failed.append({"name": stem, "message": e.message, "code": e.code})
    c = await _canvas(session, canvas_id)
    return {"boards": boards, "failed": failed, "rev": c.rev}


def _slug(text: str, fallback: str) -> str:
    return re.sub(r"[^\w.-]+", "-", text, flags=re.ASCII).strip("-._") or fallback


async def export_zip(
    session: AsyncSession,
    canvas_id: str,
    board_id: str | None = None,
    version: int | None = None,
) -> tuple[bytes, str]:
    """A ZIP of the canvas (``canvas.json`` and a folder per frame) or of one frame.

    Returns:
        ``(zip bytes, file name)``.
    """
    c = await _canvas(session, canvas_id)
    doc = (
        json.loads((await _get_version(session, canvas_id, version)).doc)
        if version
        else read_doc(c.id)
    )
    buf = io.BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for b in doc["boards"]:
            if board_id and b["id"] != board_id:
                continue
            folder = _slug(b["name"], b["id"])
            while folder in used:
                folder += "-2"
            used.add(folder)
            prefix = "" if board_id else f"{folder}/"
            if b.get("content"):
                root = board_dir(c.id, b["id"], b["content"]["rev"])
                for f in b["content"]["files"]:
                    p = root / f["path"]
                    if p.is_file():
                        z.write(p, prefix + f["path"])
            elif b["kind"] == "sketch" and b.get("ref"):
                p = svc_sketches.png_path(b["ref"])
                if p.exists():
                    z.write(p, f"{prefix}{folder}.png")
            elif b["kind"] == "diagram" and b.get("ref"):
                from services import diagrams as svc_diagrams

                try:
                    svg, _, _ = await svc_diagrams.read_file(
                        session, b["ref"], kind="svg"
                    )
                    z.writestr(f"{prefix}{folder}.svg", svg)
                except DocsError:
                    pass
        if not board_id:
            z.writestr("canvas.json", json.dumps(doc, indent=2, ensure_ascii=False))
    stem = _slug(c.title, "canvas")
    if board_id:
        stem = _slug(board_of(doc, board_id)["name"], "frame")
    return buf.getvalue(), f"{stem}.zip"


# --- Docs: a canvas as a page ------------------------------------------------------------------------------------


async def create_docs_canvas(
    session: AsyncSession, project_id: str, title: str, *, parent_id: str | None = None
) -> dict[str, Any]:
    """Docs › New page › Canvas: a Docs page of kind ``canvas`` with its canvas (one empty frame)."""
    from models import DocsPage
    from services import docs as svc_docs

    page = await svc_docs.create_page(
        session, project_id, title, parent_id=parent_id, markdown=""
    )
    row = await session.get(DocsPage, page["id"])
    row.kind = "canvas"
    session.add(row)
    await session.commit()
    canvas = await create_canvas(
        session,
        owner_kind="page",
        owner_id=row.id,
        title=title,
        project_id=project_id,
        page_id=row.id,
    )
    await _publish_page_line(session, row.id, canvas)
    return {"page": {**page, "kind": "canvas"}, "canvas": canvas}


async def _publish_page_line(
    session: AsyncSession, page_id: str, canvas: dict[str, Any]
) -> None:
    """The text of a canvas page is its embed line, so search, exports and backlinks see it like any page."""
    from services import docs as svc_docs

    await svc_docs.publish_page(
        session,
        page_id,
        base_version=0,
        markdown=embed_line(canvas["id"], canvas["title"]),
        note="Canvas",
    )


async def move_to_docs(
    session: AsyncSession,
    canvas_id: str,
    title: str | None = None,
    parent_id: str | None = None,
) -> dict[str, Any]:
    """Give an inline canvas its own Docs page. It keeps its boards, comments and history, and the text it came from
    keeps showing it (the id does not change).

    Raises:
        DocsError: 422 for a canvas without a project (a free idea) or one that is already a page.
    """
    from models import DocsPage

    c = await _canvas(session, canvas_id)
    await member_role(session, c)
    if c.page_id:
        raise DocsError(422, "already_page", "This canvas is already a Docs page.")
    if not c.project_id:
        raise DocsError(
            422, "no_project", "Only a canvas in a project can move to Docs."
        )
    out = await create_docs_canvas_page(session, c, title or c.title, parent_id)
    row = await session.get(DocsPage, out["id"])
    c.owner_kind, c.owner_id, c.page_id = "page", row.id, row.id
    if title:
        c.title = svc_sketches._title(title, c.title)  # noqa: SLF001
    session.add(c)
    await session.commit()
    await _publish_page_line(session, row.id, summary(c, "member"))
    return {"page": out, "canvas": await get_canvas(session, c.id)}


async def create_docs_canvas_page(
    session: AsyncSession, c: Canvas, title: str, parent_id: str | None
) -> dict[str, Any]:
    """Create the Docs page row for an existing canvas."""
    from models import DocsPage
    from services import docs as svc_docs

    page = await svc_docs.create_page(
        session, c.project_id, title, parent_id=parent_id, markdown=""
    )
    row = await session.get(DocsPage, page["id"])
    row.kind = "canvas"
    session.add(row)
    await session.commit()
    return {**page, "kind": "canvas"}
