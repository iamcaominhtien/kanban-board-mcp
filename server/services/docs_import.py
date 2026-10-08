"""Import Markdown files (or a folder tree) into the Docs space as draft pages.

Rules: folders become parent pages (an ``index.md`` / ``README.md`` inside a folder is that
folder page's body); a page title comes from the front matter ``title:``, else the first
``# `` heading, else the file name; ``[[links]]`` are kept as written. A dry run reports the
plan without writing anything.
"""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsDraft, DocsPage
from services import activity, docs as svc, docs_search
from services.docs_text import _FENCE, _HEADING, DocsError, parse_references

MAX_FILES = 200
MAX_FILE_BYTES = 2 * 1024 * 1024
EXTENSIONS = (".md", ".markdown")
_INDEX_NAMES = {"index", "readme"}
_SKIP_DIRS = {"node_modules", "__pycache__"}


# ---------------------------------------------------------------------------
# One file: path, front matter, title
# ---------------------------------------------------------------------------


def clean_path(raw: str) -> list[str] | None:
    """Path segments of a relative upload path, or None when it is unsafe (absolute, ``..``, empty)."""
    path = raw.replace("\\", "/").strip()
    if (
        not path
        or "\x00" in path
        or path.startswith("/")
        or re.match(r"^[A-Za-z]:", path)
    ):
        return None
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return parts


def split_front_matter(text: str) -> tuple[dict[str, Any], str, int | None]:
    """(metadata, body, error_line). ``error_line`` is the 1-based line of a YAML problem."""
    lines = text.split("\n")
    if not lines or lines[0].rstrip() != "---":
        return {}, text, None
    end = next(
        (i for i in range(1, len(lines)) if lines[i].rstrip() in ("---", "...")), None
    )
    if end is None:
        return {}, text, None
    try:
        meta = yaml.safe_load("\n".join(lines[1:end]))
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        return {}, text, (mark.line + 2) if mark is not None else 1
    if meta is None:
        meta = {}
    if not isinstance(meta, dict):
        return {}, text, 1
    return meta, "\n".join(lines[end + 1 :]).lstrip("\n"), None


def _first_h1(body: str) -> tuple[str | None, str]:
    lines = body.split("\n")
    in_fence = False
    for i, line in enumerate(lines):
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence and (m := _HEADING.match(line)) and m.group(1) == "#":
            rest = lines[:i] + lines[i + 1 :]
            while i < len(rest) and not rest[i].strip():
                rest.pop(i)  # the blank lines that followed the title
            return m.group(2).strip(), "\n".join(rest)
    return None, body


@dataclass
class Entry:
    """One uploaded file in an import: path, parsed title, size and any error."""

    index: int
    path: str
    segments: list[str] = field(default_factory=list)
    title: str | None = None
    explicit_title: bool = False
    body: str = ""
    size: int = 0
    error: str | None = None
    messages: list[str] = field(default_factory=list)
    skipped: bool = False
    page_path: list[str] | None = None
    resolved: int = 0
    unresolved: list[str] = field(default_factory=list)
    is_index: bool = False
    parent_key: tuple[str, ...] = ()


def parse_file(index: int, path: str, data: bytes) -> Entry:
    """Decode and parse one uploaded Markdown file (front matter, title)."""
    e = Entry(index=index, path=path, size=len(data))
    segs = clean_path(path)
    if segs is None:
        e.error = "Unsafe path (absolute paths and '..' are not allowed)"
        return e
    e.segments = segs
    if not segs[-1].lower().endswith(EXTENSIONS):
        e.error = "Only .md and .markdown files can be imported"
        return e
    if len(data) > MAX_FILE_BYTES:
        e.error = "File is larger than 2 MB"
        return e
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        e.error = "File is not valid UTF-8 text"
        return e
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    meta, body, err_line = split_front_matter(text)
    if err_line is not None:
        e.error = f"Front matter could not be read (line {err_line})"
        return e
    stem = re.sub(r"\.(md|markdown)$", "", segs[-1], flags=re.IGNORECASE)
    title = meta.get("title")
    title = str(title).strip() if isinstance(title, (str, int, float)) else ""
    if title:
        e.explicit_title = True
        h1, rest = _first_h1(body)
        if h1 and h1.casefold() == title.casefold():
            body = rest  # the heading just repeats the title
    else:
        h1, body2 = _first_h1(body)
        if h1:
            title, body, e.explicit_title = h1, body2, True
    e.title = (title or stem or "Untitled")[: svc.MAX_TITLE]
    e.body = body
    if len(body) > svc.MAX_MARKDOWN:
        e.error = "File is too large for a page"
        return e
    e.is_index = len(segs) > 1 and stem.lower() in _INDEX_NAMES
    return e


# ---------------------------------------------------------------------------
# The plan: which pages, under which parents, with which titles
# ---------------------------------------------------------------------------


@dataclass
class Node:
    """A page to create: a folder placeholder or a file, with its parent."""

    key: tuple[str, ...]  # folder path, or folder path + file name
    title: str
    body: str
    parent_key: tuple[str, ...] | None
    entry: Entry | None = None
    existing_id: str | None = None  # a folder that already exists is reused
    page_id: str | None = None


def _unique(title: str, taken: set[str]) -> str:
    if title.casefold() not in taken:
        return title
    n = 1
    while True:
        cand = f"{title} (copy)" if n == 1 else f"{title} (copy {n})"
        if cand.casefold() not in taken:
            return cand
        n += 1


async def build_plan(
    session: AsyncSession,
    project_id: str,
    files: list[tuple[str, bytes]],
    *,
    parent_id: str | None,
    on_conflict: str,
) -> tuple[list[Entry], list[Node], dict[str, Any]]:
    """Validate the files and plan the pages to create, folders included."""
    if on_conflict not in ("copy", "skip"):
        raise DocsError(422, "bad_conflict", "on_conflict must be copy or skip")
    await svc._project(session, project_id)
    if not files:
        raise DocsError(422, "no_files", "Choose at least one Markdown file")
    if len(files) > MAX_FILES:
        raise DocsError(
            422, "too_many_files", f"At most {MAX_FILES} files can be imported at once"
        )
    if parent_id is not None:
        parent = await svc.get_page(session, parent_id)
        if parent.project_id != project_id:
            raise DocsError(422, "bad_parent", "Parent belongs to another project")

    entries = [parse_file(i, path, data) for i, (path, data) in enumerate(files)]
    good = [e for e in entries if not e.error]

    # titles already used under each existing parent (None = top level)
    existing = await svc._all_pages(session, project_id)
    children: dict[str | None, dict[str, DocsPage]] = {}
    for p in existing:
        children.setdefault(p.parent_id, {})[p.title.casefold()] = p

    # an index.md / README.md becomes its folder's body (index.md wins over README.md)
    folder_index: dict[tuple[str, ...], Entry] = {}
    for e in sorted(
        good, key=lambda e: (e.segments[-1].lower().startswith("readme"), e.path)
    ):
        if e.is_index:
            folder_index.setdefault(tuple(e.segments[:-1]), e)

    nodes: dict[tuple[str, ...], Node] = {}
    order: list[tuple[str, ...]] = []

    def folder_chain(segs: list[str]) -> None:
        for depth in range(1, len(segs) + 1):
            key = tuple(segs[:depth])
            if key in nodes:
                continue
            idx = folder_index.get(key)
            title = (
                idx.title
                if idx is not None and idx.explicit_title and idx.title
                else key[-1]
            )
            nodes[key] = Node(
                key=key,
                title=title[: svc.MAX_TITLE],
                body=idx.body if idx is not None else "",
                parent_key=key[:-1] or None,
                entry=idx,
            )
            order.append(key)

    for e in good:
        folder_chain(e.segments[:-1])

    # resolve folders against existing pages (reuse) and decide each node's real parent id
    def children_of(parent: Node | None) -> dict[str, DocsPage]:
        pid = parent_id if parent is None else parent.existing_id
        if parent is not None and parent.existing_id is None:
            return {}
        return children.get(pid, {})

    taken_new: dict[tuple[str, ...] | None, set[str]] = {}
    for key in order:
        node = nodes[key]
        parent = nodes.get(node.parent_key) if node.parent_key else None
        hit = children_of(parent).get(node.title.casefold())
        if hit is not None:
            node.existing_id = hit.id
            if (
                node.entry is not None
            ):  # the folder already exists: its index file becomes a normal child page
                node.entry.is_index = False
                node.body = ""
                node.entry = None
        taken_new.setdefault(node.parent_key, set()).add(node.title.casefold())

    file_nodes: list[Node] = []
    for e in sorted(good, key=lambda e: [s.casefold() for s in e.segments]):
        folder_key = tuple(e.segments[:-1])
        if e.is_index and folder_key in folder_index and folder_index[folder_key] is e:
            node = nodes[folder_key]
            if node.entry is e:
                e.page_path = _titles_of(node, nodes)
                continue
        parent = nodes.get(folder_key) if folder_key else None
        taken = set(children_of(parent))
        taken |= taken_new.setdefault(folder_key or None, set())
        title = e.title or "Untitled"
        if title.casefold() in taken:
            if on_conflict == "skip":
                e.skipped = True
                e.messages.append(f"Skipped: a page titled '{title}' already exists")
                continue
            new_title = _unique(title, taken)
            e.messages.append(
                f"A page titled '{title}' already exists: imported as '{new_title}'"
            )
            title = new_title
        taken_new[folder_key or None].add(title.casefold())
        node = Node(
            key=tuple(e.segments),
            title=title,
            body=e.body,
            parent_key=folder_key or None,
            entry=e,
        )
        nodes[node.key] = node
        file_nodes.append(node)
        e.page_path = _titles_of(node, nodes)

    ordered = [nodes[k] for k in sorted(order, key=len)] + file_nodes

    # links: resolved when a page with that title exists or is created by this import
    known = {p.title.casefold() for p in existing}
    known |= {n.title.casefold() for n in ordered if n.existing_id is None}
    for e in good:
        if e.skipped:
            continue
        unresolved: list[str] = []
        for ref in parse_references(e.body):
            if ref["kind"] != "page":
                continue
            target = ref["title"].split("/")[-1].strip().casefold()
            if target in known:
                e.resolved += 1
            elif ref["title"] not in unresolved:
                unresolved.append(ref["title"])
        e.unresolved = unresolved
        if unresolved:
            n = len(unresolved)
            e.messages.append(f"{n} link{'s' if n != 1 else ''} not found yet")
    # folder pages created from an index file carry their links to the file entry too
    summary = {
        "pages": sum(1 for n in ordered if n.existing_id is None),
        "links_resolved": sum(e.resolved for e in good),
        "links_unresolved_total": sum(len(e.unresolved) for e in good),
        "skipped": sum(1 for e in entries if e.skipped),
        "errors": sum(1 for e in entries if e.error),
        "bytes": sum(e.size for e in entries if not e.error and not e.skipped),
    }
    return entries, ordered, summary


def _titles_of(node: Node, nodes: dict[tuple[str, ...], Node]) -> list[str]:
    titles = [node.title]
    cur = node
    while cur.parent_key and cur.parent_key in nodes:
        cur = nodes[cur.parent_key]
        titles.insert(0, cur.title)
    return titles


def _file_report(e: Entry) -> dict[str, Any]:
    if e.error:
        return {
            "path": e.path,
            "page_path": None,
            "title": None,
            "status": "error",
            "links_resolved": 0,
            "links_unresolved": [],
            "message": e.error,
        }
    status = "warning" if e.messages else "ok"
    return {
        "path": e.path,
        "page_path": None if e.skipped else e.page_path,
        "title": None if e.skipped else (e.page_path[-1] if e.page_path else e.title),
        "status": status,
        "links_resolved": e.resolved,
        "links_unresolved": e.unresolved,
        "message": "; ".join(e.messages) or None,
    }


async def dry_run(
    session: AsyncSession,
    project_id: str,
    files: list[tuple[str, bytes]],
    *,
    parent_id: str | None = None,
    on_conflict: str = "copy",
) -> dict[str, Any]:
    """Report what an import would create without writing anything."""
    entries, _nodes, summary = await build_plan(
        session, project_id, files, parent_id=parent_id, on_conflict=on_conflict
    )
    return {"files": [_file_report(e) for e in entries], **summary}


async def run_import(
    session: AsyncSession,
    project_id: str,
    files: list[tuple[str, bytes]],
    *,
    parent_id: str | None = None,
    on_conflict: str = "copy",
    publish: bool = False,
) -> dict[str, Any]:
    """Create the planned pages as drafts, or publish them when `publish` is set."""
    entries, nodes, _summary = await build_plan(
        session, project_id, files, parent_id=parent_id, on_conflict=on_conflict
    )
    actor = activity.current_actor()
    by_key = {n.key: n for n in nodes}
    created: list[dict[str, Any]] = []
    pages: list[tuple[DocsPage, str, DocsDraft]] = []
    for node in nodes:
        if node.existing_id is not None:
            node.page_id = node.existing_id
            continue
        parent_page_id = parent_id
        if node.parent_key:
            parent_page_id = by_key[node.parent_key].page_id
        page = DocsPage(
            project_id=project_id,
            parent_id=parent_page_id,
            position=await svc._next_position(session, project_id, parent_page_id),
            title=node.title,
            slug=await svc._unique_slug(session, project_id, node.title),
            created_by=actor,
            updated_by=actor,
        )
        session.add(page)
        draft = DocsDraft(
            page_id=page.id,
            author=actor,
            title=node.title,
            markdown=node.body,
            base_version=0,
        )
        session.add(draft)
        await session.flush()
        node.page_id = page.id
        pages.append((page, node.body, draft))
        path = "/".join(node.key)
        created.append({"path": path, "page_id": page.id, "title": node.title})
    if publish:
        for page, markdown, draft in pages:
            await svc._commit_version(
                session,
                page,
                markdown,
                page.title,
                actor,
                "Imported",
                draft,
                commit=False,
            )
        await svc.refresh_link_targets(session, project_id)
    await docs_search.reindex(session, [c["page_id"] for c in created])
    await session.commit()
    return {
        "created": created,
        "failed": [{"path": e.path, "message": e.error} for e in entries if e.error],
        "skipped": [
            {"path": e.path, "message": "; ".join(e.messages)}
            for e in entries
            if e.skipped
        ],
    }


async def resolve_pages(
    session: AsyncSession, project_id: str, page_ids: list[str]
) -> dict[str, int]:
    """Post-pass after an import: rebuild the link index of these pages and re-point pending links."""
    await svc._project(session, project_id)
    resolved = unresolved = pages = 0
    contents: dict[str, str] = {}
    live = []
    for pid in page_ids:
        page = await session.get(DocsPage, pid)
        if page is None or page.deleted_at or page.project_id != project_id:
            continue
        live.append(page)
    contents = await docs_search._contents(session, live)
    for page in live:
        markdown = contents.get(page.id, "")
        pages += 1
        if page.version > 0:
            await svc.reindex_links(session, page, markdown)
        refs = [r for r in parse_references(markdown) if r["kind"] == "page"]
        results = await svc.resolve_refs(session, project_id, refs) if refs else []
        for res in results:
            if res["status"] in ("ok", "ambiguous", "section_missing"):
                resolved += 1
            else:
                unresolved += 1
    await session.flush()
    await svc.refresh_link_targets(session, project_id)
    await session.commit()
    return {"pages": pages, "links_resolved": resolved, "links_unresolved": unresolved}


# ---------------------------------------------------------------------------
# Reading from the server's own disk (MCP)
# ---------------------------------------------------------------------------


def collect_local(path: str) -> list[tuple[str, bytes]]:
    """(relative path, bytes) for one Markdown file or every .md/.markdown file under a folder."""
    root = Path(os.path.expanduser(path))
    if not root.exists():
        raise DocsError(404, "path_not_found", f"Path not found: {path}")
    if root.is_file():
        return [(root.name, root.read_bytes())]
    out: list[tuple[str, bytes]] = []
    base = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames if not d.startswith(".") and d not in _SKIP_DIRS
        )
        for name in sorted(filenames):
            if name.startswith(".") or not name.lower().endswith(EXTENSIONS):
                continue
            full = Path(dirpath) / name
            if not full.resolve().is_relative_to(base):
                continue  # a symlink pointing outside the folder
            if len(out) >= MAX_FILES + 1:
                raise DocsError(
                    422,
                    "too_many_files",
                    f"At most {MAX_FILES} files can be imported at once",
                )
            out.append((full.relative_to(root).as_posix(), full.read_bytes()))
    if not out:
        raise DocsError(422, "no_files", f"No .md or .markdown files found in {path}")
    return out
