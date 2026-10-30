"""Docs AI for people who read a page: Summarise, Explain a selection, Translate view
(design/screens/docs-ai.md E; docs-ai-care.md G for the "too long" state).

None of these changes the page: the answer is a dashed block, a small card or a view that can be switched off. The page
is read through `access` (a page hidden from AI is refused with `hidden`), its text goes into the prompt fenced, and
every ticket key or `[[link]]` in AI text is checked with `engine.verify_refs`.
"""

import re
from dataclasses import dataclass
from typing import Any

from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import DocsPage
from services.ai.assist import settings as assist
from services.ai.store import loads
from services.docs_text import _FENCE, _HEADING, heading_anchors

from . import access, engine, jobs
from .errors import DocsAiError

MAX_MARKDOWN = 200_000
READ_BUDGET = 24_000  # characters of page text one summary / explain request reads
TRANSLATE_BUDGET = 12_000  # characters of page text one translation request sends
MAX_LANGUAGE = 40
MARK = "⟦"  # ⟦ n ⟧ stands for a protected span while the model translates
MARK_END = "⟧"


# ---------------------------------------------------------------------------
# Reading a page for an AI
# ---------------------------------------------------------------------------


async def load_page(
    session: AsyncSession, page_id: str, *, markdown: str | None = None
) -> tuple[DocsPage, str]:
    """The page and the text an AI reads: the caller's own draft when it was sent, else the published text.

    Raises:
        DocsAiError: `not_found`, or `hidden` when the page is hidden from AI, deleted or outside "only picked".
    """
    page = await session.get(DocsPage, page_id)
    if page is None:
        raise DocsAiError("not_found", "Page not found.")
    if not await access.ai_can_read(session, page):
        raise DocsAiError(
            "hidden",
            "This page is hidden from AI. Ask, summaries and AI runs skip it. People can still read and edit it.",
        )
    if markdown is not None:
        if len(markdown) > MAX_MARKDOWN:
            raise DocsAiError("invalid", "That draft is too long to send.")
        return page, markdown
    return page, await access.published_text(session, page)


async def page_path(session: AsyncSession, page: DocsPage) -> list[str]:
    """Titles from the top of the tree down to the page ("Architecture", "API")."""
    titles = [page.title]
    cur, seen = page, {page.id}
    while cur.parent_id and cur.parent_id not in seen:
        parent = await session.get(DocsPage, cur.parent_id)
        if parent is None:
            break
        titles.insert(0, parent.title)
        seen.add(parent.id)
        cur = parent
    return titles


def job_input(job: Any) -> dict[str, Any]:
    """What the request stored on the job (kept off the job afterwards: a draft can be long)."""
    return dict((loads(job.result, {}) or {}).get("input") or {})


async def start_system(project_id: str, extra: str = "") -> tuple[engine.Resolved, str]:
    """Who answers and the system prompt of a Docs AI call."""
    who = await engine.resolve(project_id)
    async with database.async_session() as session:
        row = await assist.get(session)
    return who, engine.system_prompt(who, row, extra)


def cost_of(out: Any) -> dict[str, Any]:
    """Cost fields every result carries (`costLabel` in the UI turns them into "About $0.01")."""
    return {"cost": round(float(out.cost or 0), 6), "metered": bool(out.metered)}


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------


@dataclass
class Section:
    """A heading and the text under it (offsets into the Markdown)."""

    slug: str
    title: str
    start: int
    end: int


def split_sections(text: str) -> list[Section]:
    """Sections of a Markdown page in order; text before the first heading is a section called `_top`."""
    slugs = [h["slug"] for h in heading_anchors(text)]
    heads: list[tuple[int, str]] = []
    in_fence, offset = False, 0
    for line in text.splitlines(keepends=True):
        bare = line.rstrip("\r\n")
        if _FENCE.match(bare):
            in_fence = not in_fence
        elif not in_fence:
            m = _HEADING.match(bare)
            if m:
                heads.append((offset, m.group(2)))
        offset += len(line)
    out: list[Section] = []
    if not heads or text[: heads[0][0]].strip():
        out.append(Section("_top", "", 0, heads[0][0] if heads else len(text)))
    for i, (start, title) in enumerate(heads):
        end = heads[i + 1][0] if i + 1 < len(heads) else len(text)
        out.append(
            Section(slugs[i] if i < len(slugs) else f"section-{i}", title, start, end)
        )
    return out


def cut_at_paragraph(text: str, limit: int) -> str:
    """`text` cut at the last blank line before `limit` characters."""
    if len(text) <= limit:
        return text
    head = text[:limit]
    at = head.rfind("\n\n")
    return (head[:at] if at > limit // 3 else head).rstrip()


def read_slice(text: str, budget: int) -> tuple[str, dict[str, int] | None]:
    """Whole sections from the top while they fit: `(text, None)` or `(text, {read_sections, total_sections})`."""
    if len(text) <= budget:
        return text, None
    sections = split_sections(text)
    used, read = 0, 0
    for s in sections:
        size = s.end - s.start
        if read and used + size > budget:
            break
        used += size
        read += 1
        if used >= budget:
            break
    chunk = cut_at_paragraph(text[: sections[read - 1].end] if read else text, budget)
    return chunk, {"read_sections": read, "total_sections": len(sections)}


def section_listing(text: str) -> list[dict[str, str]]:
    """`[{slug, title}]` for "Choose a section"."""
    return [
        {"slug": s.slug, "title": s.title or "Top of the page"}
        for s in split_sections(text)
    ]


# ---------------------------------------------------------------------------
# Matching a selection to the page
# ---------------------------------------------------------------------------

_INLINE = [
    (
        re.compile(r"!?\[\[([^\][|#\n]*)(?:#[^\][|\n]*)?(?:\|([^\][\n]*))?\]\]"),
        lambda m: m.group(2) or m.group(1),
    ),
    (re.compile(r"!?\[([^\][\n]*)\]\([^()\n]*\)"), lambda m: m.group(1)),
]


def plain_text(markdown: str) -> str:
    """The words of a Markdown page as a reader sees them (no marks, link targets or fences)."""
    out: list[str] = []
    in_fence = False
    for line in markdown.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            out.append(line)
            continue
        for pat, rep in _INLINE:
            line = pat.sub(rep, line)
        out.append(line)
    return re.sub(r"[`*_~|>#]", " ", "\n".join(out))


def loose(text: str) -> str:
    """Letters and digits only, lower case: a selection copied from the screen matches the page whatever marks,
    chips and spacing lie between its words."""
    return re.sub(r"[\W_]+", "", text.casefold())


def selection_section(text: str, selection: str) -> str:
    """The heading of the section the selection is in ('' when it is above the first heading or not found)."""
    want = loose(selection)
    for s in split_sections(text):
        if want and want in loose(plain_text(text[s.start : s.end])):
            return s.title
    return ""


# ---------------------------------------------------------------------------
# Summarise
# ---------------------------------------------------------------------------


@jobs.handler("summary")
async def summary_job(job: Any) -> dict[str, Any]:
    """Short summary of the published text (or the draft the editor sent). Not saved anywhere."""
    inp = job_input(job)
    await jobs.update(job.id, result={})
    async with database.async_session() as session:
        page, text = await load_page(session, job.page_id, markdown=inp.get("markdown"))
    if not text.strip():
        raise DocsAiError("invalid", "There is nothing on this page to summarise yet.")
    chunk, cut = read_slice(text, READ_BUDGET)
    await jobs.set_reads(
        job.id,
        [
            {
                "page_id": page.id,
                "title": page.title,
                "why": "this page",
                "cut": bool(cut),
            }
        ],
    )
    who, system = await start_system(
        job.project_id,
        "Summarise the page in 2 or 3 plain sentences. No headings, no lists, no preamble. Use only what the page says.",
    )
    flagged = engine.injection_in(text)
    out = await engine.call(
        job.project_id,
        system=system,
        prompt=f"{engine.fenced('page ' + page.title, chunk)}\n\nSummarise this page.",
        who=who,
        job_id=job.id,
        person=job.started_by,
        max_tokens=500,
        timeout=60,
    )
    checked = await engine.verify_refs(job.project_id, out.text.strip())
    result: dict[str, Any] = {
        "text": checked.text,
        "title": page.title,
        **cost_of(out),
    }
    if cut:
        result["too_long"] = cut
    if flagged:
        result["flagged"] = flagged
    return result


# ---------------------------------------------------------------------------
# Explain
# ---------------------------------------------------------------------------


def selection_in_page(text: str, selection: str) -> bool:
    """Whether the selected words really are on the page."""
    want = loose(selection)
    return bool(want) and want in loose(plain_text(text))


@jobs.handler("explain")
async def explain_job(job: Any) -> dict[str, Any]:
    """Plain-language explanation of text selected on the page, from the page only."""
    inp = job_input(job)
    await jobs.update(job.id, result={})
    selection = str(inp.get("selection") or "")
    async with database.async_session() as session:
        page, text = await load_page(session, job.page_id)
        path = await page_path(session, page)
    if not selection_in_page(text, selection):
        raise DocsAiError("invalid", "That text is not on the published page.")
    section = str(inp.get("section") or "").strip() or selection_section(
        text, selection
    )
    context = text
    if len(text) > READ_BUDGET:
        # a long page: read the section the selection is in
        for s in split_sections(text):
            if loose(selection) in loose(plain_text(text[s.start : s.end])):
                context = cut_at_paragraph(text[s.start : s.end], READ_BUDGET)
                break
        else:
            context = cut_at_paragraph(text, READ_BUDGET)
    await jobs.set_reads(
        job.id, [{"page_id": page.id, "title": page.title, "why": "this page"}]
    )
    who, system = await start_system(
        job.project_id,
        "Explain the selected text in plain language, in 2 to 4 sentences, using only what the page says. If the page"
        " does not explain it, say so instead of guessing.",
    )
    flagged = engine.injection_in(text) or engine.injection_in(selection)
    out = await engine.call(
        job.project_id,
        system=system,
        prompt=(
            f"{engine.fenced('page ' + page.title, context)}\n\n"
            f"Selected text:\n{engine.fenced('selection', selection[:2000])}\n\nExplain the selected text."
        ),
        who=who,
        job_id=job.id,
        person=job.started_by,
        max_tokens=500,
        timeout=60,
    )
    checked = await engine.verify_refs(job.project_id, out.text.strip())
    result: dict[str, Any] = {
        "text": checked.text,
        "from": " › ".join(path),
        "section": section,
        **cost_of(out),
    }
    if flagged:
        result["flagged"] = flagged
    return result


# ---------------------------------------------------------------------------
# Translate
# ---------------------------------------------------------------------------

_LANGUAGE = re.compile(r"^[^\W\d_][\w \-().,']{1,38}$")
_PROTECT = re.compile(
    "|".join(
        [
            r"`+[^`\n]+`+",  # inline code
            r"\[\[[^\][\n]{1,400}\]\]",  # [[page links]]
            r"\]\([^()\n]{0,500}\)",  # the target of a link, image or diagram
            r"https?://[^\s)>\]]+",  # bare URLs
            r"</?[A-Za-z][^>\n]{0,200}>",  # inline HTML
            r"\b[A-Z][A-Z0-9]{1,5}-\d+\b",  # ticket keys
        ]
    )
)
_MARKER = re.compile(
    r"^\s*(?:>\s*)*(?:#{1,6}(?=\s)|[-*+](?=\s)(?:\s+\[[ xX]\])?|\d{1,9}[.)](?=\s))?"
)
_ANSWER_BLOCK = re.compile(r"^@@@ (\d+) @@@[ \t]*$", re.MULTILINE)


def check_language(language: str) -> str:
    """A language name for the prompt ("Vietnamese"), or `invalid`."""
    name = " ".join((language or "").split())
    if not _LANGUAGE.match(name):
        raise DocsAiError("invalid", "Pick a language to translate into.")
    return name


@dataclass
class Block:
    """A paragraph, list, table or code block of a page; `spans` are the protected pieces of a text block."""

    raw: str
    code: bool = False
    masked: str = ""
    spans: list[str] | None = None


def parse_blocks(text: str) -> list[Block]:
    """Split Markdown into blocks at blank lines; a fenced code block is one block that is never translated."""
    blocks: list[Block] = []
    cur: list[str] = []
    fence: str | None = None

    def flush() -> None:
        if cur:
            blocks.append(Block("\n".join(cur)))
            cur.clear()

    for line in text.splitlines():
        m = _FENCE.match(line)
        if fence is None and m:
            flush()
            fence = m.group(1)
            cur.append(line)
        elif fence is not None:
            cur.append(line)
            if m and m.group(1) == fence:
                blocks.append(Block("\n".join(cur), code=True))
                cur.clear()
                fence = None
        elif not line.strip():
            flush()
        else:
            cur.append(line)
    if fence is not None:
        blocks.append(Block("\n".join(cur), code=True))
    else:
        flush()
    return blocks


def mask(block: Block) -> None:
    """Replace the protected pieces of a text block (inline code, `[[links]]`, link targets, URLs, ticket keys) with
    ⟦n⟧ so the model cannot change them."""
    spans: list[str] = []

    def hide(m: re.Match[str]) -> str:
        spans.append(m.group(0))
        return f"{MARK}{len(spans) - 1}{MARK_END}"

    block.masked = _PROTECT.sub(hide, block.raw)
    block.spans = spans


def needs_translation(block: Block) -> bool:
    """Whether a text block has words to translate (a table rule or a block of only code and keys has none)."""
    if block.code or MARK in block.raw or "@@@" in block.raw:
        return False
    left = re.sub(rf"{MARK}\d+{MARK_END}", "", block.masked)
    return bool(re.search(r"[^\W\d_]", left))


def _shape(text: str) -> list[tuple[str, int]]:
    """Per line: its list / heading / quote marker and its number of table cells. A translation keeps both."""
    return [
        (re.sub(r"\s+", " ", _MARKER.match(ln).group(0)).strip(), ln.count("|"))  # type: ignore[union-attr]
        for ln in text.split("\n")
    ]


def restore(block: Block, answer: str) -> str | None:
    """The translated block with its protected pieces put back, or None when the answer lost, added or moved a piece
    or changed the block's line structure (the caller keeps the original text then)."""
    spans = block.spans or []
    found = re.findall(rf"{MARK}(\d+){MARK_END}", answer)
    if sorted(int(n) for n in found) != list(range(len(spans))):
        return None
    out = re.sub(
        rf"{MARK}(\d+){MARK_END}", lambda m: spans[int(m.group(1))], answer.strip("\n")
    )
    if _shape(out) != _shape(block.raw):
        return None
    # protected pieces must come back byte for byte, in the same multiset
    if sorted(m.group(0) for m in _PROTECT.finditer(out)) != sorted(spans):
        return None
    return out


def parse_answer(text: str) -> dict[int, str]:
    """`{n: translated text}` from an answer in the `@@@ n @@@` format (a block the model dropped is just missing)."""
    text = re.sub(r"</?untrusted[^>]*>", "", text)
    parts = _ANSWER_BLOCK.split(text)
    return {
        int(parts[i]): parts[i + 1].strip("\n") for i in range(1, len(parts) - 1, 2)
    }


def translate_blocks(blocks: list[Block], answers: dict[int, str]) -> tuple[str, int]:
    """Join the blocks, using each translated block that kept its protected pieces and the original text otherwise.
    Returns the Markdown and how many blocks were left as written."""
    out: list[str] = []
    kept = 0
    for i, b in enumerate(blocks):
        if not needs_translation(b):
            out.append(b.raw)
            continue
        new = restore(b, answers[i]) if i in answers else None
        if new is None:
            kept += 1
            out.append(b.raw)
        else:
            out.append(new)
    return "\n\n".join(out), kept


@jobs.handler("translate")
async def translate_job(job: Any) -> dict[str, Any]:
    """The published page translated into another language, as a view. Code blocks, links, `[[refs]]` and ticket keys
    are kept byte for byte (checked here); a long page is cut by section. The page is never changed."""
    inp = job_input(job)
    await jobs.update(job.id, result={})
    language = check_language(str(inp.get("language") or ""))
    async with database.async_session() as session:
        page, text = await load_page(session, job.page_id)
    if not text.strip():
        raise DocsAiError("invalid", "There is nothing on this page to translate yet.")
    sections = split_sections(text)
    cut: dict[str, int] | None = None
    wanted = str(inp.get("section") or "").strip()
    if wanted:
        pick = next((s for s in sections if s.slug == wanted), None)
        if pick is None:
            raise DocsAiError("invalid", "That section is not on the page.")
        part = text[pick.start : pick.end]
        if len(part) > TRANSLATE_BUDGET:
            part, _ = read_slice(part, TRANSLATE_BUDGET)
    else:
        part, cut = read_slice(text, TRANSLATE_BUDGET)
    await jobs.set_reads(
        job.id,
        [
            {
                "page_id": page.id,
                "title": page.title,
                "why": "this page",
                "cut": bool(cut),
            }
        ],
    )
    blocks = parse_blocks(part)
    send: list[str] = []
    for i, b in enumerate(blocks):
        if b.code:
            continue
        mask(b)
        if needs_translation(b):
            send.append(f"@@@ {i} @@@\n{b.masked}")
    answers: dict[int, str] = {}
    cost: dict[str, Any] = {"cost": 0.0, "metered": False}
    if send:
        who, system = await start_system(
            job.project_id,
            f"This request is a translation into {language}: write in {language} whatever language was set above."
            f" Translate only the words. Keep every {MARK}n{MARK_END} marker exactly as it is and in its place, keep"
            " the Markdown marks (#, -, [ ], |, >) and the number of lines of each block. Do not add, remove or merge"
            " blocks. Answer in the same format: a line `@@@ n @@@` and then the block.",
        )
        body = "\n\n".join(send)
        out = await engine.call(
            job.project_id,
            system=system,
            prompt=f"{engine.fenced('page ' + page.title + ' to translate', body)}\n\nTranslate into {language}.",
            who=who,
            job_id=job.id,
            person=job.started_by,
            max_tokens=min(8000, max(1200, len(body))),
            timeout=180,
        )
        answers = parse_answer(out.text)
        cost = cost_of(out)
    markdown, kept = translate_blocks(blocks, answers)
    result: dict[str, Any] = {
        "markdown": markdown,
        "language": language,
        "kept_original_blocks": kept,
        **cost,
    }
    if cut:
        result["too_long"] = cut
        result["sections"] = section_listing(text)
    flagged = engine.injection_in(part)
    if flagged:
        result["flagged"] = flagged
    return result


__all__ = [
    "load_page",
    "page_path",
    "job_input",
    "plain_text",
    "selection_in_page",
    "split_sections",
    "summary_job",
    "explain_job",
    "translate_job",
]
