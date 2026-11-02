"""Look at what you drew: a PNG of a diagram, a canvas frame, a sketch or a local file (issue #267).

An agent with only the board's MCP server has no browser of its own, so it could not see the diagram or the frame it
made before handing it in. ``docs_read(action='picture')`` draws one with the browser the board finds on the machine
(``services/screenshots.py``), writes it where the agent can open it, and keeps a copy on the board so the picture can
go straight into a comment (``markdown``). Without any browser it says so and gives a wireframe.
"""

import os
import re
import struct
import tempfile
from pathlib import Path
from typing import Annotated, Any

from pydantic import Field

import uploads
from services import canvas_png, diagram_model, screenshots

from .. import common

FRAME_WIDTHS = {"phone": 390, "tablet": 820, "desktop": 1280, "laptop": 1440}
NO_BROWSER = (
    "No browser on this machine, so this is a wireframe (boxes and lines, no text): check the words with "
    "docs_read(diagram) or the frame's source. Install Chrome or Chromium (or set KANBAN_CHROME_PATH) for a real "
    "picture; the desktop app draws one with its own browser."
)


def _size(png: bytes) -> tuple[int, int]:
    if png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) >= 24:
        return struct.unpack(">II", png[16:24])
    return 0, 0


def _stem(text: str) -> str:
    return re.sub(r"[^\w.-]+", "-", text, flags=re.ASCII).strip("-._") or "picture"


def _target(path: str | None, name: str) -> Path:
    """Where the PNG goes: ``path`` (a folder gets ``<name>.png``), else a folder of the board's in the temp folder."""
    if not path:
        folder = Path(tempfile.gettempdir()) / "kanban-pictures"
        folder.mkdir(parents=True, exist_ok=True)
        return folder / f"{_stem(name)}.png"
    p = Path(path)
    if not p.is_absolute():
        raise ValueError(f"Give an absolute path for the picture (got {path!r}).")
    if p.suffix.lower() != ".png":
        p.mkdir(parents=True, exist_ok=True)
        p = p / f"{_stem(name)}.png"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


async def _check_run(project_id: str | None, local: Path | None = None) -> bool:
    """Inside an AI run: the item is of the run's project and a local source is in the run's folder. Returns whether
    the run may write (False in safe mode)."""
    from services.ai import guard

    ctx = guard.current()
    if ctx is None:
        return True
    if project_id is not None and project_id != ctx.project_id:
        raise ValueError(
            "That belongs to another project than this run works in, so it was left alone."
        )
    if local is not None:
        folders = await common.run_folder() or []
        real = Path(os.path.realpath(local))
        if not any(
            real == Path(os.path.realpath(f))
            or Path(os.path.realpath(f)) in real.parents
            for f in folders
        ):
            raise ValueError(
                f"{local} is outside your working folder: look at files you made there."
            )
    from services.ai.store import get_profile

    async with common.async_session() as session:
        _, profile = await get_profile(session, ctx.member_id)
        settings = await guard._settings_for(session, ctx)  # noqa: SLF001
    return not (settings.safe_mode or (profile is not None and profile.safe_mode))


def _frame_width(folder: Path) -> int:
    """The width a frame folder is drawn at: its frame.json ``size``, else desktop."""
    import json

    try:
        size = json.loads((folder / "frame.json").read_text("utf-8")).get("size")
    except (OSError, ValueError, AttributeError):
        size = None
    if isinstance(size, list) and size and isinstance(size[0], (int, float)):
        return int(size[0])
    return FRAME_WIDTHS.get(str(size or "desktop"), 1280)


async def _diagram_png(source: str, svg: str | None = None) -> tuple[bytes, str, str]:
    """``(png, drawn_by, note)`` of a drawing: the editor's own SVG when there is one, else the server's plain one."""
    from services import diagram_export
    from services import diagrams as svc_diagrams

    note = ""
    if svg is None:
        async with common.async_session() as session:
            settings = await svc_diagrams.get_settings(session)
        if diagram_export.enabled(settings["mode"]) and settings["effective_url"]:
            svg = await diagram_export.export_svg(source, settings["effective_url"])
    if svg is None:
        svg = diagram_model.render_svg(source)
        note = (
            "Drawn by the board's plain renderer (boxes, ellipses, diamonds, cylinders, arrows, text); other shapes "
            "show as boxes and the editor draws them exactly."
        )
    png = await screenshots.svg_png(svg)
    if png is None:
        return diagram_model.wireframe_png(source), "wireframe", NO_BROWSER
    return png, "browser", note


async def _frame_png(folder: Path, entry: str, width: int) -> tuple[bytes, str, str]:
    png = await screenshots.page_png(folder, entry, width)
    if png is not None:
        return png, "browser", ""
    try:
        text = (folder / entry).read_text("utf-8", errors="replace")
    except OSError:
        text = None
    return (
        canvas_png.board_snapshot(text, width, 800, max_side=800),
        "wireframe",
        (NO_BROWSER.replace("(boxes and lines, no text)", "(bars for text, boxes)")),
    )


async def _local(src: Path, width: int | None) -> tuple[bytes, str, str, str]:
    """``(png, drawn_by, note, name)`` of a local file or frame folder."""
    from services import diagrams as svc_diagrams

    if src.is_dir():
        entry = "index.html" if (src / "index.html").is_file() else None
        if entry is None:
            pages = sorted(p.name for p in src.glob("*.htm*"))
            if not pages:
                raise ValueError(
                    f"{src} has no index.html: give a frame folder, an .html, .svg or .drawio file."
                )
            entry = pages[0]
        png, by, note = await _frame_png(src, entry, width or _frame_width(src))
        return png, by, note, src.name
    if not src.is_file():
        raise ValueError(f"{src} does not exist: write the file first, then look.")
    suffix = src.suffix.lower()
    name = src.parent.name if src.name == "index.html" else src.stem
    if suffix in (".html", ".htm"):
        png, by, note = await _frame_png(
            src.parent, src.name, width or _frame_width(src.parent)
        )
        return png, by, note, name
    if suffix == ".svg":
        png = await screenshots.svg_png(src.read_text("utf-8"), width)
        if png is None:
            raise ValueError(
                NO_BROWSER.split(":", 1)[0] + ", so an SVG cannot be drawn."
            )
        return png, "browser", "", name
    if suffix in (".drawio", ".xml"):
        source = svc_diagrams._read_file(str(src), "path")  # noqa: SLF001
        svc_diagrams.validate_source(source)
        png, by, note = await _diagram_png(source)
        return png, by, note, name
    raise ValueError(
        f"{src.name}: a picture is drawn of a frame folder or an .html, .svg or .drawio file."
    )


async def picture(
    path: Annotated[
        str | None,
        Field(
            description="Without an id: the local file to look at (.drawio, .svg, .html or a frame folder); the PNG is written beside it. With an id: where to write the PNG (a folder or a .png path; default a temp folder)."
        ),
    ] = None,
    diagram_id: Annotated[
        str | None, Field(description="A diagram 'dg_xxxxxxxx'.")
    ] = None,
    version: Annotated[
        int | None, Field(description="diagram_id: an older version.")
    ] = None,
    canvas_id: Annotated[
        str | None, Field(description="A canvas 'cv_xxxxxxxx'.")
    ] = None,
    board_id: Annotated[
        str | None,
        Field(
            description="canvas_id: the frame 'b_xxxxxxxx' to draw (without it, a wireframe of the page)."
        ),
    ] = None,
    sketch_id: Annotated[
        str | None, Field(description="A sketch 'sk_xxxxxxxx'.")
    ] = None,
    width: Annotated[
        int | None,
        Field(
            description="A frame or page: the width to draw it at (390 phone, 820 tablet, 1280 desktop); default the frame's own."
        ),
    ] = None,
) -> dict[str, Any]:
    """A PNG of what you drew, to look at before you hand it in: {path, width, height, drawn_by, markdown}."""
    import services.canvases as svc_canvases
    import services.diagrams as svc_diagrams
    import services.sketches as svc_sketches

    given = [x for x in (diagram_id, canvas_id, sketch_id) if x]
    if len(given) > 1:
        raise ValueError("Give one of diagram_id, canvas_id or sketch_id.")
    if not given and not path:
        raise ValueError(
            "Give diagram_id, canvas_id (+ board_id) or sketch_id, or `path` of a local .drawio, .svg, .html file or "
            "frame folder to look at."
        )
    note = ""
    try:
        if diagram_id:
            async with common.async_session() as session:
                d = await svc_diagrams._diagram(session, diagram_id)  # noqa: SLF001
                v = await svc_diagrams._version(session, d.id, version, d.version)  # noqa: SLF001
                project_id, name = d.project_id, d.label
                source, svg, kind = v.source, v.svg, v.preview_kind
            may_write = await _check_run(project_id)
            png, drawn_by, note = await _diagram_png(
                source, svg if kind in ("editor", "agent") else None
            )
        elif sketch_id:
            async with common.async_session() as session:
                s = await svc_sketches.get_sketch(session, sketch_id)
            may_write = await _check_run(s["project_id"])
            png, drawn_by, name = (
                svc_sketches.png_path(s["id"]).read_bytes(),
                "stored",
                s["title"],
            )
        elif canvas_id:
            from .canvases import _ai_may_read

            async with common.async_session() as session:
                c = await svc_canvases._canvas(session, canvas_id)  # noqa: SLF001
                if not await _ai_may_read(session, c):
                    raise ValueError(
                        "That canvas is a page hidden from AI, so it was left alone."
                    )
                doc = svc_canvases.read_doc(c.id)
                project_id, name = c.project_id, c.title
            may_write = await _check_run(project_id)
            if not board_id:
                png, drawn_by = canvas_png.overview(doc), "wireframe"
                note = "The page's layout only: frames as boxes, notes as squares. Pass board_id for a real picture of a frame."
            else:
                board = svc_canvases.board_of(doc, board_id)
                name = f"{c.title}-{board['name']}"
                png, drawn_by, note = await _board_png(board, c.id, width)
        else:
            src = Path(path or "")
            if not src.is_absolute():
                raise ValueError(f"Give an absolute path (got {path!r}).")
            may_write = await _check_run(None, src)
            png, drawn_by, note, name = await _local(src, width)
            # beside the file; a frame's picture beside its folder, so it never becomes a file of the frame
            frame = (
                src
                if src.is_dir()
                else src.parent
                if src.name == "index.html"
                else None
            )
            path = str(
                frame.parent / f"{_stem(frame.name)}.png"
                if frame is not None
                else src.with_suffix(".png")
            )
    except (
        svc_diagrams.DocsError,
        svc_sketches.DocsError,
        svc_canvases.DocsError,
    ) as exc:
        raise ValueError(exc.message) from exc
    # safe mode writes nothing beside your files and nothing on the board: only a PNG in the temp folder
    target = _target(path if may_write else None, name)
    target.write_bytes(png)
    w, h = _size(png)
    out: dict[str, Any] = {
        "path": str(target),
        "width": w,
        "height": h,
        "drawn_by": drawn_by,
    }
    if note:
        out["note"] = note
    if may_write:
        stored = uploads.build_upload_filename(target.name)
        (uploads.get_uploads_dir() / stored).write_bytes(png)
        out["markdown"] = f"![{name}](/uploads/{stored})"
    out["look"] = "Open the PNG and check it before you hand it in" + (
        "; to show it, put `markdown` in a ticket comment or Docs page."
        if may_write
        else "."
    )
    return out


async def _board_png(
    board: dict[str, Any], canvas_id: str, width: int | None
) -> tuple[bytes, str, str]:
    """``(png, drawn_by, note)`` of one frame of a canvas."""
    import services.canvases as svc_canvases
    import services.diagrams as svc_diagrams
    import services.sketches as svc_sketches

    kind, content = board["kind"], board.get("content")
    if kind == "sketch" and board.get("ref"):
        return svc_sketches.png_path(board["ref"]).read_bytes(), "stored", ""
    if kind == "diagram" and board.get("ref"):
        async with common.async_session() as session:
            d = await svc_diagrams._diagram(session, board["ref"])  # noqa: SLF001
            v = await svc_diagrams._version(session, d.id, None, d.version)  # noqa: SLF001
            source, svg, pk = v.source, v.svg, v.preview_kind
        return await _diagram_png(source, svg if pk in ("editor", "agent") else None)
    if not content:
        raise ValueError("That frame is empty: there is nothing to draw yet.")
    root = svc_canvases.board_dir(canvas_id, board["id"], content["rev"])
    if kind == "image":
        data = svc_canvases.file_in(root, content["entry"]).read_bytes()
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return data, "stored", ""
        with tempfile.TemporaryDirectory(prefix="kanban-pic-") as tmp:
            ext = Path(content["entry"]).suffix
            Path(tmp, f"picture{ext}").write_bytes(data)
            Path(tmp, "index.html").write_text(
                f"<!doctype html><style>body{{margin:0}}img{{display:block;width:100%}}</style><img src='picture{ext}'>",
                encoding="utf-8",
            )
            png, by, note = await _frame_png(Path(tmp), "index.html", int(board["w"]))
            return png, by, note
    with tempfile.TemporaryDirectory(prefix="kanban-pic-") as tmp:
        for f in content["files"]:
            dest = Path(tmp) / f["path"]
            if not dest.resolve().is_relative_to(Path(tmp).resolve()):
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(svc_canvases.file_in(root, f["path"]).read_bytes())
        return await _frame_png(Path(tmp), content["entry"], width or int(board["w"]))
