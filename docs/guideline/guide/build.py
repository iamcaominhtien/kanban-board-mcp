"""Builds the Kanban Board user and administrator guide from one source file per chapter.

    python3 build.py                  # the full PDF, the web version and the stand-alone PDFs into dist/
    python3 build.py --release        # as above, but a draft or "to confirm" chapter, or a "to confirm" marker, fails the build
    python3 build.py --only pdf       # only the full PDF (also: web, standalone)
    python3 build.py --facts          # print the facts read from the code and stop

Chapters are chapters/*.md (see ../README.md for the front matter). Screenshots are images/<name>.jpg (or the AI guide's
../ai/images). The version comes from server/version.py. Design: design/screens/guideline-design.md.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import markdown
from pypdf import PdfReader

import facts

HERE = Path(__file__).resolve().parent
ROOT = facts.ROOT
DIST = HERE / "dist"
VERSION = facts.fact("version")
REPO = "github.com/iamcaominhtien/kanban-board-mcp"

PARTS = {
    1: "START HERE",
    2: "WORK WITH TICKETS",
    3: "DOCS AND DRAWINGS",
    4: "IDEAS",
    5: "AI",
    6: "SETTINGS AND DESKTOP",
    7: "ADMINISTER AND CONNECT",
}
AUDIENCES = {"everyone": "Everyone", "admin": "Admin", "developer": "Developer", "desktop": "Desktop app", "ai": "AI"}
STATUSES = {"released", "draft", "to-confirm"}
IMAGE_DIRS = [HERE / "images", HERE.parent / "ai" / "images"]
MONTHS = "January February March April May June July August September October November December".split()


# chapter id -> label ("4", "A") of the chapters in this build, and the titles of all chapters (for ones left out)
LABELS: dict[str, str] = {}
ALL_TITLES: dict[str, str] = {}


class BuildError(Exception):
    pass


@dataclass
class Chapter:
    id: str
    title: str
    part: int | None  # None = appendix
    audience: list[str]
    status: str
    kind: str  # chapter | sheet
    summary: str
    reading: int
    standalone: str | None
    body: str
    file: str
    label: str = ""  # "4" or "A"
    html: str = ""
    headings: list[tuple[str, str]] = field(default_factory=list)  # (number, text)
    confirms: list[str] = field(default_factory=list)
    figures: int = 0
    facts_used: set[str] = field(default_factory=set)


# ---------------------------------------------------------------------------------------------------------------- source


def parse_chapter(path: Path) -> Chapter:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n(.*)", text, re.S)
    if not m:
        raise BuildError(f"{path.name}: front matter (--- … ---) is missing")
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if line.strip() and not line.startswith("#"):
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    audience = [a.strip() for a in meta.get("audience", "everyone").strip("[]").split(",") if a.strip()]
    for a in audience:
        if a not in AUDIENCES:
            raise BuildError(f"{path.name}: unknown audience tag {a!r} (use {', '.join(AUDIENCES)})")
    status = meta.get("status", "released")
    if status not in STATUSES:
        raise BuildError(f"{path.name}: status must be one of {', '.join(sorted(STATUSES))}")
    part = None if meta.get("part", "") == "appendix" else int(meta["part"])
    if part is not None and part not in PARTS:
        raise BuildError(f"{path.name}: part {part} is not defined")
    return Chapter(
        id=meta.get("id") or path.stem.split("-", 1)[1],
        title=meta["title"],
        part=part,
        audience=audience,
        status=status,
        kind=meta.get("kind", "chapter"),
        summary=meta.get("summary", ""),
        reading=int(meta.get("reading", "5")),
        standalone=meta.get("standalone"),
        body=m.group(2).strip(),
        file=path.name,
    )


def load_chapters(release: bool, drafts: bool) -> list[Chapter]:
    chapters = [parse_chapter(p) for p in sorted((HERE / "chapters").glob("*.md"))]
    ids = [c.id for c in chapters]
    if len(set(ids)) != len(ids):
        raise BuildError("two chapters share an id")
    kept = []
    for c in chapters:
        ALL_TITLES[c.id] = c.title
        if c.status == "draft" and not drafts:
            print(f"  left out (draft): {c.file}")
            continue
        if c.status == "to-confirm" and release:
            print(f"  left out (to confirm, not released): {c.file}")
            continue
        kept.append(c)
    n = 0
    letters = iter("ABCDEFGH")
    LABELS.clear()
    for c in kept:
        if c.part is None:
            c.label = next(letters)
        else:
            n += 1
            c.label = str(n)
        LABELS[c.id] = c.label
    return kept


# -------------------------------------------------------------------------------------------------------------- text


def find_image(name: str) -> Path:
    for d in IMAGE_DIRS:
        for ext in (".jpg", ".png"):
            if (d / (name + ext)).exists():
                return d / (name + ext)
    raise BuildError(f"figure missing: images/{name}.jpg (looked in {', '.join(str(d.relative_to(ROOT)) for d in IMAGE_DIRS)})")


def render_keys(spec: str) -> str:
    parts = [("Ctrl" if k == "Mod" else k) for k in spec.split("+")]
    return "".join(f"<kbd>{html.escape(k)}</kbd>" for k in parts)


def shortcut_sheet_html() -> str:
    data = json.loads((ROOT / "ui/src/components/shortcuts/shortcuts.json").read_text(encoding="utf-8"))
    cols = []
    for g in data["groups"]:
        rows = "".join(
            f'<div class="keyrow"><span>{html.escape(i["label"])}</span><span class="k">{render_keys("+".join(i["keys"]))}</span></div>'
            for i in g["items"]
        )
        cols.append(f'<div><h3>{html.escape(g["title"])}</h3>{rows}</div>')
    return '<div class="keygrid">' + "".join(cols) + "</div>"


def release_history_html() -> str:
    """One row per release in CHANGELOG.md: version, date and the first sentence of its summary (or first entry)."""
    log = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    rows = []
    for m in re.finditer(r"^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\n(.*?)(?=^## \[|\Z)", log, re.S | re.M):
        version, date, block = m.groups()
        lines = [ln.strip() for ln in block.splitlines() if ln.strip() and not ln.startswith(("#", "---"))]
        first = lines[0] if lines else ""
        first = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", first).lstrip("-* ").replace("**", "").replace("`", "")
        first = (first[:150].rsplit(" ", 1)[0] + "…") if len(first) > 150 else first
        rows.append(f"<tr><td><b>{version}</b></td><td>{date}</td><td>{html.escape(first)}</td></tr>")
    return '<table><thead><tr><th>Version</th><th>Date</th><th>What changed</th></tr></thead><tbody>' + "".join(rows) + "</tbody></table>"


def transform(ch: Chapter) -> str:
    """Chapter source -> HTML body: facts, keys, menu paths, figures, callouts, steps (ordered lists), tables."""
    segments = re.split(r"(```.*?```)", ch.body, flags=re.S)  # leave code blocks alone
    placeholders: dict[str, str] = {}

    def fig(m: re.Match) -> str:
        name, caption, extras = m.group(1), m.group(2), m.group(3) or ""
        mk = re.search(r"markers=([\d.,;]+)", extras)
        markers = mk.group(1) if mk else ""
        wd = re.search(r"width=(\d+)", extras)
        find_image(name)
        ch.figures += 1
        label = f"Figure {ch.label}.{ch.figures}"
        dots = ""
        if markers:
            for i, xy in enumerate(markers.split(";"), 1):
                x, y = xy.split(",")
                dots += f'<span class="mk" style="left:{x}%;top:{y}%">{i}</span>'
        width = f"{wd.group(1)}%" if wd else "86%"
        key = f"@@FIG{len(placeholders)}@@"
        placeholders[key] = (
            f'<figure id="fig-{ch.id}-{ch.figures}"><div class="shot" style="width:{width}">'
            f'<img src="images/{name}.jpg" alt="{html.escape(caption, quote=True)}"/>{dots}</div>'
            f"<figcaption>{label} {html.escape(caption)}</figcaption></figure>"
        )
        return f"\n\n{key}\n\n"

    def preset(m: re.Match) -> str:
        # a persona from the file the Add AI member dialog reads ("Start from"), so the guide never drifts from the app
        data = {p["id"]: p for p in json.loads((ROOT / "ui/src/components/ai/memberPresets.json").read_text(encoding="utf-8"))}
        text = data[m.group(1)][m.group(2)]["en"]
        ch.facts_used.add(f"preset:{m.group(1)}.{m.group(2)}")
        key = f"@@PRE{len(placeholders)}@@"
        placeholders[key] = f'<pre><code>{html.escape(text)}</code></pre><p class="caption">{len(text)} of 1000 characters</p>'
        return f"\n\n{key}\n\n"

    def fact(m: re.Match) -> str:
        ch.facts_used.add(m.group(1))
        return facts.fact(m.group(1))

    def ref(m: re.Match) -> str:
        # {ch:id} -> "chapter 4"; {Ch:id} at the start of a sentence; {num:id} -> "4". Numbers follow the chapters in this
        # build, so leaving a chapter out of a release never leaves a wrong number behind.
        kind, cid = m.group(1), m.group(2)
        if cid not in ALL_TITLES:
            raise BuildError(f"{ch.file}: reference to unknown chapter {cid!r}")
        if cid in LABELS:
            return LABELS[cid] if kind == "num" else f"{'Chapter' if kind == 'Ch' else 'chapter'} {LABELS[cid]}"
        left = f"“{ALL_TITLES[cid]}” (not in this edition)"
        return left if kind == "num" else (f"The chapter {left}" if kind == "Ch" else f"the chapter {left}")

    def confirm(m: re.Match) -> str:
        ch.confirms.append(m.group(1))
        return f'<span class="confirm-mark">TO CONFIRM</span> {m.group(1)}'

    out = []
    for seg in segments:
        if seg.startswith("```"):
            out.append(seg)
            continue
        seg = re.sub(r"^@figure\s+(\S+)\s+\"([^\"]+)\"((?:\s+(?:markers|width)=[\d.,;]+)*)\s*$", fig, seg, flags=re.M)
        seg = re.sub(r"^@preset\s+(\w+)\s+(\w+)\s*$", preset, seg, flags=re.M)
        seg = re.sub(r"\{fact:([\w]+)\}", fact, seg)
        seg = re.sub(r"\{(ch|Ch|num):([\w-]+)\}", ref, seg)
        seg = re.sub(r"\{menu:([^}]+)\}", lambda m: f'<span class="menu">{html.escape(m.group(1).strip())}</span>', seg)
        seg = re.sub(r"\{confirm:\s*([^}]+)\}", confirm, seg)
        seg = re.sub(r"\+\+([A-Za-z0-9,./\-]+(?:\+[A-Za-z0-9,./\-]+)*)\+\+", lambda m: render_keys(m.group(1)), seg)
        out.append(seg)
    text = "".join(out)
    if "{{shortcuts}}" in text:
        key = "@@SHORTCUTS@@"
        placeholders[key] = shortcut_sheet_html()
        text = text.replace("{{shortcuts}}", f"\n\n{key}\n\n")

    if "{{releases}}" in text:
        key = "@@RELEASES@@"
        placeholders[key] = release_history_html()
        text = text.replace("{{releases}}", f"\n\n{key}\n\n")

    body = markdown.markdown(text, extensions=["admonition", "tables", "fenced_code", "attr_list", "sane_lists"])
    for key, value in placeholders.items():
        body = body.replace(f"<p>{key}</p>", value).replace(key, value)
    # a directive that did not turn into anything (for example a figure in the middle of a paragraph) must not reach the page
    stray = re.search(r"@figure|@preset|\{(?:fact|menu|ch|Ch|num|confirm):", body)
    if stray:
        raise BuildError(f"{ch.file}: '{stray.group(0)}' was not understood; a directive must be alone on its line")

    k = 0

    def h2(m: re.Match) -> str:
        nonlocal k
        if ch.kind == "sheet":  # a sheet has no numbered sections
            return m.group(0)
        k += 1
        number = f"{ch.label}.{k}"
        ch.headings.append((number, html.unescape(re.sub("<[^>]+>", "", m.group(1)))))
        return f'<h2 id="sec-{ch.id}-{k}">{number} {m.group(1)}</h2>'

    body = re.sub(r"<h2[^>]*>(.*?)</h2>", h2, body)
    if "TO CONFIRM" in body or ch.status == "to-confirm":
        banner = (
            '<div class="admonition confirm"><p class="admonition-title">To confirm before release</p>'
            "<p>This chapter has not been checked against the code yet, so a release build leaves it out.</p></div>"
        )
        body = banner + body
    return body


def tags_html(ch: Chapter) -> str:
    return '<div class="tags">' + "".join(f'<span class="tag {a}">{AUDIENCES[a]}</span>' for a in ch.audience) + "</div>"


def chapter_html(ch: Chapter) -> str:
    body = transform(ch)
    ch.html = body
    part = f"PART {ch.part} · {PARTS[ch.part]}" if ch.part else "APPENDIX"
    if ch.kind == "sheet":
        return (
            f'<section class="sheet" id="ch-{ch.id}" style="page: sheet"><div class="eyebrow">{html.escape(ch.title.upper())}</div>'
            f"<h1>{html.escape(ch.summary or ch.title)}</h1>{body}</section>"
        )
    inside = "".join(
        f'<a class="row" href="#sec-{ch.id}-{i}" style="color:inherit"><b>{n}</b><span>{html.escape(t)}</span></a>'
        for i, (n, t) in enumerate(ch.headings, 1)
    )
    opener = (
        f'<div class="opener" style="page: opener"><div class="kicker">{part}</div><div class="num">{ch.label}</div>'
        f"<h1>{html.escape(ch.title)}</h1>{tags_html(ch)}"
        f'<p class="summary">{html.escape(ch.summary)}</p>'
        f'<div class="caption">{ch.reading} min read</div>'
        f'<div class="inside">{inside}</div></div>'
    )
    return f'<section class="chapter" id="ch-{ch.id}" style="page: pg-{ch.id}">{opener}<div class="chapter-body">{body}</div></section>'


# ---------------------------------------------------------------------------------------------------------- documents


def today() -> tuple[str, str]:
    import datetime

    d = datetime.date.today()
    return f"{MONTHS[d.month - 1]} {d.year}", d.isoformat()


def page_css(chapters: list[Chapter], footer: str) -> str:
    rules = [
        "@page { size: A4; margin: 20mm 17mm 22mm 17mm; }",
        "@page cover { margin: 0; } @page backcover { margin: 0; }",
        f'@page sheet {{ margin: 16mm 15mm 18mm; @bottom-left {{ content: "{footer}"; font: 8pt \'Plus Jakarta Sans\'; color: #5B6B60; }} }}',
        "@page opener { margin: 20mm 17mm 22mm 17mm; }",
    ]
    for c in chapters:
        if c.kind == "sheet":
            continue
        label = f"{c.label} · {c.title.upper()}" if c.part else f"APPENDIX {c.label} · {c.title.upper()}"
        label = label.replace('"', "")
        rules.append(
            f'@page pg-{c.id} {{ @top-left {{ content: "{label}"; font: 700 7.5pt \'Plus Jakarta Sans\'; color: #2E6F40; letter-spacing: .06em; }}'
            f' @top-right {{ content: "KANBAN BOARD USER GUIDE"; font: 700 7.5pt \'Plus Jakarta Sans\'; color: #5B6B60; letter-spacing: .06em; }}'
            f' @bottom-left {{ content: "{footer}"; font: 8pt \'Plus Jakarta Sans\'; color: #5B6B60; }}'
            f" @bottom-right {{ content: counter(page); font: 700 8pt 'Plus Jakarta Sans'; color: #1E2A22; }} }}"
        )
    rules.append(f'@page toc {{ @bottom-left {{ content: "{footer}"; font: 8pt \'Plus Jakarta Sans\'; color: #5B6B60; }} @bottom-right {{ content: counter(page); font: 700 8pt \'Plus Jakarta Sans\'; }} }}')
    return "\n".join(rules)


def cover_html() -> str:
    month, _ = today()
    logo = re.sub(r"<\?xml.*?\?>", "", (ROOT / "ui/public/logo.svg").read_text(encoding="utf-8"))
    logo = logo.replace("<svg ", '<svg class="mark" role="img" aria-label="Kanban Board" ', 1)
    return (
        f'<section class="cover" style="page: cover">{logo}<div><div class="brand">KANBAN BOARD</div>'
        f'<h1>User &amp;<br>Administrator<br>Guide</h1><div class="sub">Boards, Docs, ideas, AI members and MCP, on your own computer.</div></div>'
        f'<div><div class="meta">Version {VERSION}<br>{month}</div><p class="chips" style="margin-top:8mm"><span>Local-first</span><span>AI-ready</span></p></div></section>'
    )


def back_cover_html() -> str:
    return (
        '<section class="backcover" style="page: backcover"><h2>Kanban Board</h2>'
        "<p>A local Kanban board with Docs, ideas, AI members and an MCP server. Your data stays on your computer.</p>"
        f'<dl><dt>Source and issues</dt><dd><a href="https://{REPO}">{REPO}</a></dd>'
        "<dt>Report a mistake</dt><dd>Help › Report an Issue…</dd><dt>Licence</dt><dd>MIT</dd></dl>"
        f"<p>This guide is built from the project’s own documentation for version {VERSION}.<br>© 2026 Cao Minh Tiến</p></section>"
    )


def toc_html(chapters: list[Chapter], pages: dict[str, int]) -> str:
    rows, last = [], object()
    for c in chapters:
        if c.part != last:
            last = c.part
            rows.append(f'<div class="part">{("PART %d · %s" % (c.part, PARTS[c.part])) if c.part else "APPENDICES"}</div>')
        tags = "".join(f'<span class="tag {a}">{AUDIENCES[a]}</span>' for a in c.audience if a != "everyone")
        pg = pages.get(c.id, "")
        rows.append(
            f'<a class="row" href="#ch-{c.id}"><span class="n">{c.label}</span><span class="t">{html.escape(c.title)}</span>'
            f'<span class="tags">{tags}</span><span class="dots"></span><span class="pg">{pg}</span></a>'
        )
    legend = " ".join(f'<span class="tag {a}">{AUDIENCES[a]}</span>' for a in AUDIENCES)
    return (
        '<section class="toc" style="page: toc; break-before: page"><div class="caption" style="font-weight:800;letter-spacing:.12em">KANBAN BOARD USER GUIDE</div>'
        f'<h1>Contents</h1><p class="caption">Tags show who a chapter is for. Every line is a link, and the PDF has bookmarks. {legend}</p>'
        + "".join(rows)
        + "</section>"
    )


def document(title: str, body: str, css: str, extra_head: str = "") -> str:
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
        f'<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="kit.css">{extra_head}'
        f"<style>{css}</style></head><body>{body}</body></html>"
    )


# ------------------------------------------------------------------------------------------------------------- output


def stage_assets(out: Path, chapters: list[Chapter]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(HERE / "kit.css", out / "kit.css")
    if (out / "fonts").exists():
        shutil.rmtree(out / "fonts")
    shutil.copytree(HERE / "fonts", out / "fonts")
    (out / "images").mkdir(exist_ok=True)
    for c in chapters:
        for name in re.findall(r'src="images/([^"]+)\.jpg"', c.html):
            src = find_image(name)
            shutil.copy(src, out / "images" / (name + src.suffix))


def print_pdf(html_path: Path, pdf_path: Path) -> None:
    subprocess.run(["node", str(HERE / "print_pdf.js"), str(html_path), str(pdf_path)], check=True)


def squash(text: str) -> str:
    """A title without its spaces: a heading that wraps onto two lines loses the space in the PDF's bookmark."""
    return re.sub(r"\s+", "", text)


def outline_pages(pdf: Path) -> dict[str, int]:
    """Title -> page number (counted from 1) of every bookmark in the PDF."""
    reader = PdfReader(str(pdf))
    found: dict[str, int] = {}

    def walk(items):
        for it in items:
            if isinstance(it, list):
                walk(it)
            else:
                found.setdefault(squash(it.title), reader.get_destination_page_number(it) + 1)

    walk(reader.outline)
    return found


def bookmark(c: Chapter) -> str:
    """The text of the heading that starts a chapter (a sheet's heading is its summary)."""
    return (c.summary or c.title) if c.kind == "sheet" else c.title


def build_pdf(chapters: list[Chapter], out_pdf: Path, work: Path, *, full: bool, title: str) -> None:
    footer = f"Kanban Board {VERSION}"
    for c in chapters:
        chapter_html_cached(c)
    stage_assets(work, chapters)
    pages: dict[str, int] = {}
    for attempt in (1, 2):
        parts = [cover_html()] if full else []
        if full:
            parts.append(toc_html(chapters, pages or {c.id: "00" for c in chapters}))
        parts += [chapter_html_cached(c) for c in chapters]
        if full:
            parts.append(back_cover_html())
        (work / "guide.html").write_text(document(title, "".join(parts), page_css(chapters, footer)), encoding="utf-8")
        print_pdf(work / "guide.html", out_pdf)
        if not full:
            return
        outline = outline_pages(out_pdf)
        new = {c.id: outline[squash(bookmark(c))] for c in chapters if squash(bookmark(c)) in outline}
        missing = [c.title for c in chapters if squash(bookmark(c)) not in outline]
        if missing:
            raise BuildError(f"no bookmark for: {', '.join(missing)}")
        if new == pages:
            return
        pages = new
    print("  note: page numbers in the contents moved on the second pass; the PDF was printed again with the new numbers")


_cache: dict[str, str] = {}


def chapter_html_cached(c: Chapter) -> str:
    # chapter_html also fills c.figures/headings; calling it twice would double the figure numbers, so reuse the result
    if c.id not in _cache:
        c.figures = 0
        c.headings = []
        _cache[c.id] = chapter_html(c)
    return _cache[c.id]


def build_web(chapters: list[Chapter], out: Path) -> None:
    for c in chapters:
        chapter_html_cached(c)
    stage_assets(out, chapters)
    nav_items = "".join(f'<li><a href="{c.id}.html">{c.label}. {html.escape(c.title)}</a></li>' for c in chapters)
    index = (
        f'<nav class="web-nav"><b>Kanban Board User &amp; Administrator Guide</b> · version {VERSION}</nav>'
        f'<h1>Contents</h1><ol style="list-style:decimal;counter-reset:none;padding-left:20pt">{nav_items}</ol>'
        '<style>ol>li{padding-left:2pt}ol>li::before{display:none}</style>'
    )
    (out / "index.html").write_text(document("Kanban Board Guide", index, ""), encoding="utf-8")
    for i, c in enumerate(chapters):
        prev_l = f'<a href="{chapters[i-1].id}.html">← {html.escape(chapters[i-1].title)}</a>' if i else ""
        next_l = f'<a href="{chapters[i+1].id}.html">{html.escape(chapters[i+1].title)} →</a>' if i + 1 < len(chapters) else ""
        nav = f'<nav class="web-nav"><a href="index.html">Contents</a> · version {VERSION}</nav>'
        foot = f'<nav class="web-nav" style="display:flex;justify-content:space-between">{prev_l}{next_l}</nav>'
        (out / f"{c.id}.html").write_text(document(c.title, nav + _cache[c.id] + foot, ""), encoding="utf-8")


def build_standalone(chapters: list[Chapter], out: Path, release: bool) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    made = []
    for c in chapters:
        if not c.standalone:
            continue
        work = DIST / "work" / c.standalone
        build_pdf([c], out / f"{c.standalone}-{VERSION}.pdf", work, full=False, title=c.title)
        pdf = out / f"{c.standalone}-{VERSION}.pdf"
        n = len(PdfReader(str(pdf)).pages)
        if c.kind == "sheet" and n != 1:
            msg = f"{c.standalone} is {n} pages; a sheet must fit one page"
            if release:
                raise BuildError(msg)
            print("  WARNING:", msg)
        made.append(pdf)
    return made


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--release", action="store_true", help="fail on drafts-in-source, 'to confirm' markers and sheets over one page")
    ap.add_argument("--drafts", action="store_true", help="include chapters marked draft")
    ap.add_argument("--only", choices=["pdf", "web", "standalone"])
    ap.add_argument("--facts", action="store_true")
    args = ap.parse_args()
    if args.facts:
        print(facts.report())
        return 1 if facts.check_env_vars() else 0

    missing_env = facts.check_env_vars()
    if missing_env:
        raise BuildError("documented variables not found in the code: " + ", ".join(missing_env))
    print(f"Kanban Board guide {VERSION}")
    chapters = load_chapters(args.release, args.drafts)
    for c in chapters:  # render once to catch missing figures and unknown facts before anything is printed
        chapter_html_cached(c)
    confirms = [(c.file, t) for c in chapters for t in c.confirms]
    if args.release and confirms:
        raise BuildError("'to confirm' markers left: " + "; ".join(f"{f}: {t}" for f, t in confirms))

    DIST.mkdir(exist_ok=True)
    if args.only in (None, "pdf"):
        pdf = DIST / f"kanban-board-guide-{VERSION}.pdf"
        build_pdf(chapters, pdf, DIST / "work" / "full", full=True, title="Kanban Board User & Administrator Guide")
        print(f"  {pdf.relative_to(HERE)}: {len(PdfReader(str(pdf)).pages)} pages")
    if args.only in (None, "web"):
        build_web(chapters, DIST / "web")
        print("  dist/web/index.html")
    if args.only in (None, "standalone"):
        for pdf in build_standalone(chapters, DIST / "standalone", args.release):
            print(f"  {pdf.relative_to(HERE)}: {len(PdfReader(str(pdf)).pages)} pages")
    used = {f for c in chapters for f in c.facts_used}
    print(f"  facts from the code used: {', '.join(sorted(used)) or 'none'}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BuildError as err:
        print(f"BUILD FAILED: {err}", file=sys.stderr)
        sys.exit(1)
