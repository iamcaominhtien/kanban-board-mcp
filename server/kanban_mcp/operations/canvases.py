"""Canvas operations: boards of HTML, pictures, Sketches and Diagrams with notes and comments on one plane.

An agent reads a canvas as data (frames, notes, arrows, comments, open proposals), comments on it, *creates* a canvas
(or adds frames to one) from local folders of web pages, and *proposes* a changed frame from a local folder. It never
changes an existing frame itself and never takes a lock from a person: a person sees before and after and accepts or
rejects (docs/specs/canvas.md).
"""

import json
import os
import re
from pathlib import Path
from typing import Annotated

import services.canvases as svc_canvases
import services.proofs as svc_proofs
from pydantic import Field

from .. import common
from ..common import ProjectId, notify_on_success

CanvasId = Annotated[
    str,
    Field(
        description="Canvas id 'cv_xxxxxxxx' (the id inside `(canvas:cv_xxxxxxxx)` in a text)."
    ),
]
MAX_INLINE = 60_000


def _error(exc: "svc_canvases.DocsError") -> ValueError:
    hint = {
        "board_locked": " A person is editing that frame; your proposal is kept for them to accept once they save.",
        "proposal_stale": " Read the canvas again and propose against the new version.",
    }.get(exc.code, "")
    return ValueError(f"{exc.message}{hint}")


async def _same_project(project_id: str | None) -> None:
    """An AI run may only touch canvases of the project it works in."""
    from services.ai import guard

    ctx = guard.current()
    if ctx is not None and project_id != ctx.project_id:
        raise ValueError(
            "That canvas belongs to another project than this run works in, so it was left alone."
        )


def _ai_folder(path: str, *, create: bool = False) -> Path:
    """The folder an AI run names for frames, checked: an absolute folder (that exists, unless `create`), and for an AI
    run not the computer's root, the home folder (or one above it) or a dot-folder in the home (.ssh, .aws, .config
    ...). A person or another client may name any folder."""
    root = Path(path)
    if not root.is_absolute() or (not create and not root.is_dir()):
        raise ValueError(f"Give an absolute folder that exists (got {path!r}).")
    from services.ai import guard

    if guard.current() is None:
        return root
    real = Path(
        os.path.realpath(root)
    )  # follows links, also of a folder that is not made yet
    home = Path(os.path.realpath(os.path.expanduser("~")))
    if real == real.parent or real == home or real in home.parents:
        raise ValueError(
            f"{path} is too wide a folder for frames: give the folder that holds the pages."
        )
    if home in real.parents and real.relative_to(home).parts[0].startswith("."):
        raise ValueError(f"{path} is a private folder, so it was left alone.")
    return root


def _ai_skips(root: Path, file: Path) -> bool:
    """True when an AI run's folder holds a file that is never taken from it (see ``proofs.never_copied``)."""
    from services.ai import guard

    return guard.current() is not None and svc_proofs.never_copied(
        file.relative_to(root)
    )


async def _not_in_safe_mode(session) -> None:
    """Writing files to a folder is a write: an AI run in safe mode only reads."""
    from services.ai import guard
    from services.ai.store import get_profile

    ctx = guard.current()
    if ctx is None:
        return
    _, profile = await get_profile(session, ctx.member_id)
    settings = await guard._settings_for(session, ctx)  # noqa: SLF001
    if settings.safe_mode or (profile is not None and profile.safe_mode):
        raise ValueError(
            "Safe mode is on, so nothing is written to a folder. Read the frame inline instead (leave out `path`)."
        )


async def _ai_may_read(session, c) -> bool:
    """A canvas that is a Docs page hidden from AI (or outside "only picked pages") is not read by any AI run."""
    from models import DocsPage
    from services.ai import guard
    from services.docs_ai import access

    if guard.current() is None or not c.page_id:
        return True
    page = await session.get(DocsPage, c.page_id)
    return page is not None and await access.ai_can_read(session, page)


async def design_guide() -> dict:
    """The whole canvas design guide: how to design frames that look like one considered product (in Claude Code it
    is also the canvas-design skill), its craft page, and the folder of its exemplar boards on this machine."""
    from services import canvas_design
    from services.ai import board_skills

    return {
        "guide": canvas_design.GUIDE,
        "craft": canvas_design.CRAFT,
        "examples": board_skills.examples_dir(),
    }


async def shared_guides() -> dict:
    """The board's shared guides for any role (in Claude Code they are its skills): {name: text} (issue #277)."""
    from services import shared_skills
    from services.ai import board_skills

    out = shared_skills.guides()
    for name in shared_skills.extra_files():
        # the scripts and themes a guide refers to are files: say where they are on this machine
        out[name] += (
            f"\n\nThis guide's folder (scripts/, themes/, examples/): {board_skills.skill_dir(name)}\n"
        )
    return out


async def role_guide(query: str | None = None) -> dict:
    """One role's guide (in Claude Code it is that role's skill, issue #273): {role, skill, guide}; without `query`,
    which roles have one: {roles: {role: what it covers}}."""
    from services import role_skills

    if not (query or "").strip():
        return {
            "roles": {r: desc for r, _n, desc, _b in role_skills.ROLE_SKILLS},
            "designer": "docs_read(action='design_guide')",
        }
    role = query.strip().lower().replace(" ", "_").replace("-", "_")
    if role == "designer":
        return {
            "role": "designer",
            "skill": "canvas-design",
            "guide": "The Designer's guide is the design guide: docs_read(action='design_guide').",
        }
    text = role_skills.guide(role)
    if text is None:
        raise ValueError(
            f"No guide for the role {query!r}. Roles: "
            + ", ".join(r for r, _n, _d, _b in role_skills.ROLE_SKILLS)
            + ", designer."
        )
    out = {"role": role, "skill": role_skills.SKILL_OF_ROLE[role], "guide": text}
    if out["skill"] in role_skills.extra_files():
        from services.ai import board_skills

        # the templates the guide refers to are files: say where they are on this machine
        out["folder"] = board_skills.skill_dir(out["skill"])
    return out


async def permissions_guide() -> dict:
    """What an AI may do on the board, what needs a person and what to do when refused, and (inside a run) what the
    calling AI may do right now (in Claude Code it is also the board-permissions skill)."""
    from services import permissions_guide as guide

    return await guide.for_caller()


async def list_project_canvases(project_id: ProjectId) -> list[dict]:
    """List a project's canvases: [{id, title, owner_kind, owner_id, page_id, version, rev, boards, updated_by, updated_at, markdown}]."""
    from models import Canvas

    await _same_project(project_id)
    async with common.async_session() as session:
        rows = await svc_canvases.list_for_project(session, project_id)
        out = []
        for r in rows:
            if await _ai_may_read(session, await session.get(Canvas, r["id"])):
                out.append(r)
        return out


async def read_canvas(
    canvas_id: CanvasId,
    board_id: Annotated[
        str | None,
        Field(
            description="A frame id 'b_xxxxxxxx' from this canvas: also returns that frame's source text."
        ),
    ] = None,
    path: Annotated[
        str | None,
        Field(
            description="With board_id: an absolute folder to write the frame's files to (edit them, then docs_write(canvas_propose))."
        ),
    ] = None,
) -> dict:
    """Read a canvas: {id, title, rev, version, markdown, pages, boards, notes, arrows, labels, comments, proposals, locks}."""
    from services import canvas_comments, canvas_proposals

    async with common.async_session() as session:
        try:
            out = await svc_canvases.get_canvas(session, canvas_id)
            await _same_project(out["project_id"])
            if not await _ai_may_read(
                session, await svc_canvases._canvas(session, canvas_id)
            ):  # noqa: SLF001
                raise ValueError(
                    "That canvas is a page hidden from AI, so it was left alone."
                )
            doc = out["doc"]
            threads = await canvas_comments.list_threads(session, canvas_id)
            props = await canvas_proposals.list_proposals(session, canvas_id)
            result = {
                "id": out["id"],
                "title": out["title"],
                "rev": out["rev"],
                "version": out["version"],
                "markdown": out["markdown"],
                "owner_kind": out["owner_kind"],
                "owner_id": out["owner_id"],
                "pages": [{"id": p["id"], "name": p["name"]} for p in doc["pages"]],
                "boards": [
                    {
                        "id": b["id"],
                        "page": b["page"],
                        "name": b["name"],
                        "kind": b["kind"],
                        "x": b["x"],
                        "y": b["y"],
                        "width": b["w"],
                        "height": b["h"],
                        "order": b.get("order", 0),
                        "ref": b.get("ref"),
                        "entry": (b.get("content") or {}).get("entry"),
                        "files": [
                            f["path"] for f in (b.get("content") or {}).get("files", [])
                        ],
                        "locked_by": next(
                            (
                                lk["holder"]
                                for lk in out["locks"]
                                if lk["board_id"] == b["id"]
                            ),
                            None,
                        ),
                    }
                    for b in doc["boards"]
                ],
                "notes": [
                    {
                        "id": n["id"],
                        "page": n["page"],
                        "text": n["text"],
                        "color": n["color"],
                        "by": n["by"],
                    }
                    for n in doc["notes"]
                ],
                "arrows": [
                    {
                        "id": a["id"],
                        "from": a["from"],
                        "to": a["to"],
                        "label": a.get("label", ""),
                    }
                    for a in doc["arrows"]
                ],
                "labels": [
                    {"id": t["id"], "page": t["page"], "text": t["text"]}
                    for t in doc["labels"]
                ],
                "comments": [
                    {
                        "thread_id": t["id"],
                        "board_id": t["board_id"],
                        "status": t["status"],
                        "number": t["number"],
                        "comments": [
                            {"author": c["author"], "body": c["body"]}
                            for c in t["comments"]
                        ],
                    }
                    for t in threads
                ],
                "proposals": [
                    {
                        "id": p["id"],
                        "author": p["author"],
                        "note": p["note"],
                        "boards": [
                            {"board_id": c["board_id"], "status": c["status"]}
                            for c in p["changes"]
                        ],
                    }
                    for p in props
                ],
                "locks": out["locks"],
            }
            if board_id:
                src = await svc_canvases.board_source(session, canvas_id, board_id)
                board = svc_canvases.board_of(doc, board_id)
                result["board"] = {
                    "id": board_id,
                    "name": board["name"],
                    "kind": board["kind"],
                    "content_rev": src["rev"],
                    "entry": src["entry"],
                }
                if path:
                    root = _ai_folder(path, create=True)
                    await _not_in_safe_mode(session)
                    written = []
                    content = board.get("content")
                    if content:
                        src_root = svc_canvases.board_dir(
                            canvas_id, board_id, content["rev"]
                        )
                        for f in content["files"]:
                            target = root / f["path"]
                            if not target.resolve().is_relative_to(root.resolve()):
                                raise ValueError(
                                    f"{f['path']} would land outside {root}."
                                )
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes((src_root / f["path"]).read_bytes())
                            written.append(str(target))
                    result["board"]["path"] = str(root)
                    result["board"]["written"] = written
                else:
                    total = 0
                    inline = []
                    for f in src["files"]:
                        total += len(f["text"])
                        if total <= MAX_INLINE:
                            inline.append(f)
                    result["board"]["files"] = inline
                    result["board"]["truncated"] = total > MAX_INLINE
            return result
        except svc_canvases.DocsError as exc:
            raise _error(exc) from exc


def _read_folder(root: Path, top: bool = False) -> dict[str, bytes]:
    """The files of a frame folder (frame.json is not a frame file; nor is canvas.json when the frame is the top folder)."""
    files: dict[str, bytes] = {}
    total = 0
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.name == "frame.json" or _ai_skips(root, p):
            continue
        if top and p.name == "canvas.json" and p.parent == root:
            continue
        total += p.stat().st_size
        if total > svc_canvases.MAX_BOARD_BYTES:
            raise ValueError(
                f"{root.name or root} is over {svc_canvases.MAX_BOARD_BYTES // (1024 * 1024)} MB, the most a frame can hold."
            )
        files[p.relative_to(root).as_posix()] = p.read_bytes()
    return files


def _json_file(p: Path) -> dict:
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise ValueError(f"{p} is not valid JSON.") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{p} must hold a JSON object.")
    return data


def _frames_of(root: Path, title: str) -> list[dict]:
    """The frames in a folder: each sub-folder with an .html page is one (named after it, or by its frame.json); loose pages at the top are one frame."""
    frames: list[dict] = []
    subs = [d for d in sorted(root.iterdir()) if d.is_dir()]
    sub_frames = [d for d in subs if any(d.rglob("*.html")) or any(d.rglob("*.htm"))]
    loose = any(
        f.suffix.lower() in (".html", ".htm") for f in root.iterdir() if f.is_file()
    )
    for d in [root] if loose and not sub_frames else sub_frames:
        meta = _json_file(d / "frame.json")
        size = meta.get("size")
        if isinstance(size, list) and len(size) == 2:
            size = (int(size[0]), int(size[1]))
        elif not isinstance(size, str):
            size = None
        shown = d.name if d != root else title
        shown = (
            re.sub(r"^\d+[-_. ]+", "", shown) or shown
        )  # "01-today" shows as "today"
        frames.append(
            {
                "key": d.name if d != root else "main",
                "name": str(meta.get("name") or shown)[:120],
                "size": size,
                "fit": bool(meta.get("fit")),
                "page": _page_name(meta.get("page")),
                "x": meta.get("x"),
                "y": meta.get("y"),
                "files": _read_folder(d, top=d == root),
            }
        )
    if not frames:
        raise ValueError(
            "Found no HTML page: put an index.html in the folder (one frame) or in each sub-folder (one frame each)."
        )
    return frames


MAX_LAYOUT_ITEMS = 200


def _page_name(value) -> str | None:
    """A page tab named in frame.json or canvas.json ("Foundations"), or None for the first one."""
    return str(value).strip()[:80] or None if isinstance(value, str) else None


async def _make_pages(session, canvas, names: list[str], fresh: bool) -> dict[str, str]:
    """``{page name: page id}`` for the pages the folder names, in the order they first appear: an existing page of
    that name is reused, the others are added. A new canvas's first page ("Page 1") takes the first name."""
    if not names:
        return {}
    pages = svc_canvases.read_doc(canvas.id)["pages"]
    by_name = {p["name"]: p["id"] for p in pages}
    ids: dict[str, str] = {}
    upsert: list[dict] = []
    for i, name in enumerate(names):
        if name in by_name:
            ids[name] = by_name[name]
        elif fresh and i == 0:
            first = pages[0]
            ids[name] = first["id"]
            upsert.append({"id": first["id"], "rev": first.get("rev"), "name": name})
        else:
            pid = svc_canvases._id("p")  # noqa: SLF001
            ids[name] = pid
            upsert.append({"id": pid, "name": name, "order": len(pages) + len(upsert)})
    if upsert:
        await svc_canvases.save(
            session, canvas.id, base_rev=canvas.rev, upsert={"pages": upsert}
        )
    return ids


def _plan_layout(root: Path, frames: list[dict]) -> dict:
    """The notes, arrows and labels of the folder's canvas.json, checked against the frames (before anything is created)."""
    data = _json_file(root / "canvas.json")
    notes = [n for n in data.get("notes", []) if isinstance(n, dict)]
    arrows = [a for a in data.get("arrows", []) if isinstance(a, dict)]
    labels = [t for t in data.get("labels", []) if isinstance(t, dict)]
    if len(notes) + len(arrows) + len(labels) > MAX_LAYOUT_ITEMS:
        raise ValueError(
            f"canvas.json holds up to {MAX_LAYOUT_ITEMS} notes, arrows and labels together."
        )
    frame_refs = {f["key"] for f in frames} | {f["name"] for f in frames}
    note_refs = {str(n["id"]) for n in notes if n.get("id")}
    for n in notes:
        if n.get("near") and n["near"] not in frame_refs:
            raise ValueError(
                f"A note says near {n['near']!r}, which is not a frame (frames: {sorted(f['key'] for f in frames)})."
            )
    for a in arrows:
        for end in ("from", "to"):
            if a.get(end) not in frame_refs | note_refs:
                raise ValueError(
                    f"An arrow {end} {a.get(end)!r} is not a frame or a note id (frames: {sorted(f['key'] for f in frames)}, notes: {sorted(note_refs)})."
                )
    return {"notes": notes, "arrows": arrows, "labels": labels}


def _layout_pages(layout: dict) -> list[str]:
    """The page names canvas.json's notes and labels give, beside the frames'."""
    names = [_page_name(i.get("page")) for i in layout["notes"] + layout["labels"]]
    return [n for n in names if n]


async def _apply_layout(
    session,
    canvas,
    layout: dict,
    placed: dict[str, dict],
    pages: dict[str, str] | None = None,
) -> dict:
    """Notes, arrows and labels from canvas.json, saved in one go (a note says `near` a frame or gives x and y)."""
    if not (layout["notes"] or layout["arrows"] or layout["labels"]):
        return {}
    pages = pages or {}
    ids: dict[str, str] = {}
    note_page: dict[str, str | None] = {}
    notes, arrows, labels = [], [], []

    def on(page: str | None) -> list[dict]:
        return (
            [b for b in placed.values() if b.get("page") == page]
            if page
            else list(placed.values())
        )

    for n in layout["notes"]:
        nid = svc_canvases._id("n")  # noqa: SLF001
        if n.get("id"):
            ids[str(n["id"])] = nid
        near = placed.get(n.get("near")) if n.get("near") else None
        page = near.get("page") if near else pages.get(_page_name(n.get("page")) or "")
        note_page[nid] = page
        low = max((b["y"] + b["h"] for b in on(page)), default=0) + 60
        x = n.get("x", near["x"] + float(n.get("dx", 0)) if near else 0)
        y = n.get("y", near["y"] + near["h"] + 60 if near else low)
        notes.append(
            {"id": nid, "x": x, "y": y, "w": n.get("w", 260), "h": n.get("h", 130),
             "text": str(n.get("text", "")), "color": n.get("color", "yellow"),
             **({"page": page} if page else {})}
        )  # fmt: skip
    for a in layout["arrows"]:
        ends = [
            placed[a[e]]["id"] if a[e] in placed else ids[str(a[e])]
            for e in ("from", "to")
        ]
        start = placed.get(a["from"])
        page = start.get("page") if start else note_page.get(ends[0])
        arrows.append(
            {
                "id": svc_canvases._id("a"),  # noqa: SLF001
                "from": ends[0],
                "to": ends[1],
                "label": str(a.get("label", "")),
                **({"page": page} if page else {}),
            }
        )
    for t in layout["labels"]:
        page = pages.get(_page_name(t.get("page")) or "")
        top = min((b["y"] for b in on(page)), default=0)
        labels.append(
            {"id": svc_canvases._id("t"), "x": t.get("x", 0), "y": t.get("y", top - 120),  # noqa: SLF001
             "text": str(t.get("text", "")), "size": t.get("size", 24),
             **({"page": page} if page else {})}
        )  # fmt: skip
    await svc_canvases.save(
        session,
        canvas.id,
        base_rev=canvas.rev,
        upsert={"notes": notes, "arrows": arrows, "labels": labels},
    )
    return {"notes": len(notes), "arrows": len(arrows), "labels": len(labels)}


@notify_on_success
async def create_canvas_from_files(
    path: Annotated[
        str,
        Field(
            description='Absolute folder: each sub-folder with an .html page is a frame (name order), or pages at the top are one frame. Optional frame.json {name, page, size: "phone"|"tablet"|"desktop"|[w,h], fit, x, y} per frame (frames with the same page share a page tab) and canvas.json {notes, arrows, labels} at the top (see the design guide).'
        ),
    ],
    owner_kind: Annotated[
        str | None,
        Field(
            description="New canvas: where it belongs, 'ticket', 'doc' (a Docs page) or 'idea'."
        ),
    ] = None,
    owner_id: Annotated[
        str | None,
        Field(description="New canvas: ticket id 'IAM-12', Docs page id or idea id."),
    ] = None,
    title: Annotated[
        str | None,
        Field(description="New canvas: its name (the alt text)."),
    ] = None,
    canvas_id: CanvasId | None = None,
) -> dict:
    """Create a canvas from folders of web pages, or add frames to an existing one (canvas_id). Returns {id, title, version, markdown, boards: [{id, name, w, h}]}: put `markdown` on its own line in the ticket, idea or Docs page."""
    root = _ai_folder(path)
    if not canvas_id and not (owner_kind and owner_id):
        raise ValueError(
            "Give owner_kind and owner_id for a new canvas, or canvas_id to add frames to one."
        )
    frames = _frames_of(root, title or "Frame")
    if len(frames) > svc_canvases.MAX_BOARDS:
        raise ValueError(f"A canvas holds up to {svc_canvases.MAX_BOARDS} frames.")
    layout = _plan_layout(root, frames)
    page_names = list(
        dict.fromkeys([f["page"] for f in frames if f["page"]] + _layout_pages(layout))
    )
    if len(page_names) > svc_canvases.MAX_PAGES:
        raise ValueError(f"A canvas has up to {svc_canvases.MAX_PAGES} page tabs.")
    async with common.async_session() as session:
        try:
            for f in frames:  # check every frame before anything is created
                svc_canvases.prepare_files(f["files"])
            if canvas_id:
                c = await svc_canvases._canvas(session, canvas_id)  # noqa: SLF001
                await _same_project(c.project_id)
                if not await _ai_may_read(session, c):
                    raise ValueError(
                        "That canvas is a page hidden from AI, so it was left alone."
                    )
                out = {"id": c.id, "title": c.title, "version": c.version}
            else:
                from services import sketches as svc_sketches

                project = await svc_sketches._project_of(  # noqa: SLF001
                    session,
                    svc_canvases._owner_for_project(owner_kind),
                    owner_id,
                    None,  # noqa: SLF001
                )
                await _same_project(project)
                out = await svc_canvases.create_canvas(
                    session,
                    owner_kind=owner_kind,
                    owner_id=owner_id,
                    title=title,
                    start="none",
                )
            pages = await _make_pages(
                session,
                await svc_canvases._canvas(session, out["id"]),  # noqa: SLF001
                page_names,
                fresh=not canvas_id,
            )
            boards = []
            placed: dict[str, dict] = {}
            for f in frames:
                made = await svc_canvases.add_board(
                    session,
                    out["id"],
                    name=f["name"],
                    kind="html",
                    page=pages.get(f["page"] or ""),
                    files=f["files"],
                    size=f["size"],
                    x=f["x"],
                    y=f["y"],
                    fit=f["fit"],
                )
                b = made["board"]
                placed[f["key"]] = placed[f["name"]] = b
                boards.append(
                    {"id": b["id"], "name": b["name"], "w": b["w"], "h": b["h"]}
                )
            fresh = await svc_canvases._canvas(session, out["id"])  # noqa: SLF001
            counts = await _apply_layout(session, fresh, layout, placed, pages)
            fresh = await svc_canvases._canvas(session, out["id"])  # noqa: SLF001
        except svc_canvases.DocsError as exc:
            raise _error(exc) from exc
    return {
        "id": fresh.id,
        "title": fresh.title,
        "version": fresh.version,
        "markdown": f"![{fresh.title}](canvas:{fresh.id})",
        "boards": boards,
        **({"pages": list(pages)} if pages else {}),
        **counts,
    }


@notify_on_success
async def comment_on_canvas(
    canvas_id: CanvasId,
    body: Annotated[
        str, Field(description="Comment text (Markdown; @Name mentions a member).")
    ],
    board_id: Annotated[
        str | None, Field(description="Pin a new comment to this frame.")
    ] = None,
    thread_id: Annotated[
        str | None,
        Field(description="Reply in this thread instead of starting a new one."),
    ] = None,
    at: Annotated[
        str | None,
        Field(
            description="Pin on this element of the frame: a CSS selector, or 'text=Add task'. The pin follows it at any width."
        ),
    ] = None,
    x: Annotated[
        float | None,
        Field(
            description="Where in the frame (0 to 1) when `at` is not given or not found; default 0.5."
        ),
    ] = None,
    y: Annotated[
        float | None,
        Field(description="Like x, down the frame."),
    ] = None,
) -> dict:
    """Comment on a canvas under your own name. Returns the thread {id, number, board_id, status, comments}. You never resolve a person's thread."""
    from services import canvas_comments
    from services.ai import guard

    async with common.async_session() as session:
        try:
            c = await svc_canvases._canvas(session, canvas_id)  # noqa: SLF001
            await _same_project(c.project_id)
            ai = (
                {"member": guard.current().member_name, "can_propose": bool(board_id)}
                if guard.current()
                else None
            )
            if not await _ai_may_read(session, c):
                raise ValueError(
                    "That canvas is a page hidden from AI, so it was left alone."
                )
            if thread_id:
                thread = await canvas_comments.thread_by_id(session, thread_id)
                if thread["canvas_id"] != canvas_id:
                    raise ValueError("That thread belongs to another canvas.")
                return await canvas_comments.reply(session, thread_id, body, ai=ai)
            anchor = None
            if at and board_id:
                anchor = {"text": at[5:]} if at.startswith("text=") else {"sel": at}
            elif at:
                raise ValueError(
                    "`at` needs board_id: it names an element of that frame."
                )
            return await canvas_comments.add_thread(
                session,
                canvas_id,
                body=body,
                board_id=board_id,
                x=0.5 if x is None else x,
                y=0.5 if y is None else y,
                anchor=anchor,
                ai=ai,
            )
        except svc_canvases.DocsError as exc:
            raise _error(exc) from exc


@notify_on_success
async def propose_canvas_change(
    canvas_id: CanvasId,
    board_id: Annotated[
        str, Field(description="The HTML frame 'b_xxxxxxxx' to change.")
    ],
    path: Annotated[
        str,
        Field(
            description="Absolute folder with the frame's new files (as written by docs_read(canvas, board_id, path)); files you leave out stay as they are."
        ),
    ],
    note: Annotated[
        str | None, Field(description="One sentence on what you changed.")
    ] = None,
    request: Annotated[
        str | None, Field(description="What you were asked to do.")
    ] = None,
) -> dict:
    """Propose a changed frame. Nothing changes until a person accepts it (they see before and after). Returns {id, status, boards, waiting_for}. If a person is editing the frame the proposal is kept and shown when they finish."""
    from services import canvas_proposals
    from services.ai import guard

    root = _ai_folder(path)
    files: dict[str, bytes] = {}
    skipped: list[str] = []
    total = 0
    for p in sorted(root.rglob("*")):
        if p.is_file():
            if _ai_skips(root, p):
                skipped.append(p.relative_to(root).as_posix())
                continue
            total += p.stat().st_size
            if total > svc_canvases.MAX_BOARD_BYTES:
                raise ValueError(
                    f"That folder is over {svc_canvases.MAX_BOARD_BYTES // (1024 * 1024)} MB, the most a frame can hold."
                )
            files[p.relative_to(root).as_posix()] = p.read_bytes()
    async with common.async_session() as session:
        try:
            c = await svc_canvases._canvas(session, canvas_id)  # noqa: SLF001
            await _same_project(c.project_id)
            if not await _ai_may_read(session, c):
                raise ValueError(
                    "That canvas is a page hidden from AI, so it was left alone."
                )
            ctx = guard.current()
            out = await canvas_proposals.create(
                session,
                canvas_id,
                changes=[{"board_id": board_id, "files": files}],
                note=note or "",
                request=request or "",
                member_id=ctx.member_id if ctx else None,
            )
        except svc_canvases.DocsError as exc:
            raise _error(exc) from exc
    return {
        "id": out["id"],
        "status": out["status"],
        "boards": [c_["name"] for c_ in out["changes"]],
        "lines_changed": sum(c_["lines"] for c_ in out["changes"]),
        "waiting_for": next(
            (c_["waiting_for"] for c_ in out["changes"] if c_["waiting_for"]), None
        ),
        "message": "Proposed. A person sees before and after and accepts or rejects it; nothing was changed.",
        **({"skipped": skipped[:20]} if skipped else {}),
    }
