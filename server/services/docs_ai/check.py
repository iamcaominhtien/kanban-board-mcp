"""Check this page (design/screens/docs-ai.md F): unclear text, gaps, unknown links and style problems.

It reads the page (the caller's draft when the editor sent it, else the published text) and the project's style guide
page, and changes nothing. Unknown `[[links]]` are found without a model, by resolving them like the editor does; the
other findings come from the model and are kept only when their quote really occurs in the text. A fix is a
`{old, new}` pair the editor applies as an ordinary draft change the person accepts.
"""

import difflib
import hashlib
import re
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import DocsAiIgnore, DocsPage, Ticket
from services import docs as svc_docs
from services.ai.assist import prompts
from services.ai.store import loads, now_iso
from services.docs_text import _FENCE, _REF, _TICKET, heading_anchors

from . import access, engine, jobs
from . import settings as svc_settings
from .errors import DocsAiError
from .reader import (
    READ_BUDGET,
    cost_of,
    cut_at_paragraph,
    job_input,
    load_page,
    loose,
    split_sections,
    start_system,
)

KINDS = ("unclear", "missing", "unknown_link", "style")
MODEL_KINDS = ("unclear", "missing", "style")
MAX_MODEL_FINDINGS = 8
MAX_QUOTE = 300
STYLE_BUDGET = 6000


def finding_id(kind: str, quote: str) -> str:
    """A finding's id (also the key "Ignore" stores): the same kind and quote on a page is the same finding."""
    return hashlib.sha1(f"{kind}\0{quote}".encode()).hexdigest()[:10]


def mask_code(text: str) -> str:
    """The text with code (fenced blocks and inline code) blanked out, offsets unchanged."""
    out: list[str] = []
    in_fence = False
    for line in text.splitlines(keepends=True):
        if _FENCE.match(line):
            in_fence = not in_fence
            out.append(re.sub(r"[^\r\n]", " ", line))
        elif in_fence:
            out.append(re.sub(r"[^\r\n]", " ", line))
        else:
            out.append(re.sub(r"`[^`\n]*`", lambda m: " " * len(m.group(0)), line))
    return "".join(out)


def section_at(text: str, pos: int) -> str:
    """The heading of the section a character offset is in ('' above the first heading)."""
    title = ""
    for s in split_sections(text):
        if s.start <= pos < s.end:
            return s.title if s.title else title
        title = s.title
    return title


def locate(text: str, quote: str) -> tuple[str, int] | None:
    """`(exact text, offset)` of the quote in the page, tolerating other spacing between words, or None."""
    quote = quote.strip()
    if not quote or len(quote) > MAX_QUOTE:
        return None
    at = text.find(quote)
    if at >= 0:
        return quote, at
    words = quote.split()
    if not words:
        return None
    m = re.search(r"\s+".join(re.escape(w) for w in words), text)
    return (m.group(0), m.start()) if m else None


# ---------------------------------------------------------------------------
# Unknown links (no model)
# ---------------------------------------------------------------------------


def _closest(wanted: str, options: list[str], cutoff: float) -> str | None:
    """The option that contains the wanted words (or is contained in them), else the most similar one."""
    by_fold = {o.casefold(): o for o in options}
    want = wanted.casefold().strip()
    if want:
        for fold, option in by_fold.items():
            if want in fold or (len(fold) > 2 and fold in want):
                return option
    hit = difflib.get_close_matches(want, list(by_fold), n=1, cutoff=cutoff)
    return by_fold[hit[0]] if hit else None


def _link(title: str, anchor: str | None, display: str | None) -> str:
    return (
        f"[[{title}{'#' + anchor if anchor else ''}{'|' + display if display else ''}]]"
    )


async def unknown_links(
    session: AsyncSession, project_id: str, text: str
) -> list[dict[str, Any]]:
    """Findings for `[[links]]` that do not resolve (no page, page in the Recycle Bin, no such section), each with the
    closest page or heading as the suggestion. A hidden page's headings are never suggested."""
    masked = mask_code(text)
    refs = [
        {
            "title": m.group(1).strip(),
            "anchor": (m.group(2) or "").strip() or None,
            "display": (m.group(3) or "").strip() or None,
            "quote": text[m.start() : m.end()],
            "pos": m.start(),
        }
        for m in _REF.finditer(masked)
    ]
    if not refs:
        return []
    resolved = await svc_docs.resolve_refs(
        session,
        project_id,
        [{"kind": "page", "title": r["title"], "anchor": r["anchor"]} for r in refs],
    )
    readable = await access.readable_pages(session, project_id)
    hidden = await access.hidden_page_ids(session, project_id)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for ref, res in zip(refs, resolved, strict=True):
        status = res.get("status")
        if (
            status not in ("missing", "in_bin", "section_missing")
            or ref["quote"] in seen
        ):
            continue
        seen.add(ref["quote"])
        suggestion: str | None = None
        if status == "section_missing":
            if res.get("page_id") in hidden:
                message = f"No section {ref['anchor']} in {res['title']}."
            else:
                target = next((p for p in readable if p.id == res.get("page_id")), None)
                heads = (
                    [
                        h["text"]
                        for h in heading_anchors(
                            await access.published_text(session, target)
                        )
                    ]
                    if target
                    else []
                )
                best = _closest(ref["anchor"] or "", heads, 0.4)
                message = f"No section {ref['anchor']} in {res['title']}."
                if best:
                    suggestion = _link(res["title"], best, ref["display"])
                    message += f" Closest: {res['title']} › {best}."
        else:
            message = (
                f"“{ref['title']}” is in the Recycle Bin."
                if status == "in_bin"
                else f"No page called “{ref['title']}”."
            )
            best = _closest(ref["title"], [p.title for p in readable], 0.5)
            if best:
                suggestion = _link(best, ref["anchor"], ref["display"])
                message += f" Closest: {best}."
        out.append(
            {
                "kind": "unknown_link",
                "quote": ref["quote"],
                "section": section_at(text, ref["pos"]),
                "message": message,
                **({"suggestion": suggestion} if suggestion else {}),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Ignore
# ---------------------------------------------------------------------------


async def ignored_keys(session: AsyncSession, page_id: str) -> set[str]:
    """Finding ids a person chose to ignore on this page."""
    rows = (
        await session.exec(select(DocsAiIgnore).where(DocsAiIgnore.page_id == page_id))
    ).all()
    return {r.key for r in rows}


async def ignore(session: AsyncSession, page_id: str, key: str, by: str) -> None:
    """Hide a finding for the page (idempotent)."""
    key = key.strip()
    if not re.fullmatch(r"[0-9a-f]{6,40}", key):
        raise DocsAiError("invalid", "That is not a finding.")
    if await session.get(DocsAiIgnore, (page_id, key)) is None:
        session.add(DocsAiIgnore(page_id=page_id, key=key, by=by, at=now_iso()))
        await session.commit()


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------

CHECK_TASK = (
    "Check the page for problems a reader would hit. Report at most {n} findings, each one of:\n"
    '- "unclear": a passage that is vague or ambiguous ("as described elsewhere" without saying where);\n'
    '- "missing": something the page mentions (a ticket, a checklist item, a term) but never explains;\n'
    '- "style": a passage that breaks the style guide page, when one was given.\n'
    "`quote` must be copied exactly from the page, at most 200 characters. `message` is one short sentence for the"
    " author. `suggestion` is optional short wording. Report only what the page and the style guide show; if the page"
    " is fine, return an empty list.\n"
    'JSON only: {{"findings": [{{"kind": "unclear|missing|style", "quote": "...", "message": "...", "suggestion": "..."}}]}}'
)


async def _ticket_lines(session: AsyncSession, project_id: str, text: str) -> str:
    keys = list(dict.fromkeys(_TICKET.findall(mask_code(text))))[:20]
    if not keys:
        return ""
    rows = (
        await session.exec(
            select(Ticket).where(Ticket.project_id == project_id, Ticket.id.in_(keys))  # type: ignore[attr-defined]
        )
    ).all()
    return "\n".join(f"- {t.id}: {t.title} [{t.status}]" for t in rows)


def _model_findings(value: Any, text: str) -> list[dict[str, Any]]:
    """Findings from the model's answer, kept only when the quote occurs in the page."""
    raw = value.get("findings") if isinstance(value, dict) else value
    out: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "")
        found = locate(text, str(item.get("quote") or ""))
        message = " ".join(str(item.get("message") or "").split())[:300]
        if kind not in MODEL_KINDS or found is None or not message:
            continue
        quote, pos = found
        suggestion = " ".join(str(item.get("suggestion") or "").split())[:300]
        out.append(
            {
                "kind": kind,
                "quote": quote,
                "section": "Whole page" if kind == "missing" else section_at(text, pos),
                "message": message,
                **({"suggestion": suggestion} if suggestion else {}),
            }
        )
        if len(out) >= MAX_MODEL_FINDINGS:
            break
    return out


@jobs.handler("check")
async def check_job(job: Any) -> dict[str, Any]:
    """Findings for a page: `{findings: [{id, kind, quote, section, message, suggestion?}], style_page, cost}`."""
    inp = job_input(job)
    await jobs.update(job.id, result={})
    async with database.async_session() as session:
        page, text = await load_page(session, job.page_id, markdown=inp.get("markdown"))
        row = await svc_settings.get(session, job.project_id)
        style: DocsPage | None = None
        style_text = ""
        if row.style_page_id and row.style_page_id != page.id:
            sp = await session.get(DocsPage, row.style_page_id)
            if sp is not None and await access.ai_can_read(session, sp):
                style, style_text = sp, await access.published_text(session, sp)
        ignored = await ignored_keys(session, page.id)
        links = await unknown_links(session, job.project_id, text)
        tickets = await _ticket_lines(session, job.project_id, text)
    if not text.strip():
        raise DocsAiError("invalid", "There is nothing on this page to check yet.")
    reads = [{"page_id": page.id, "title": page.title, "why": "this page"}]
    if style is not None:
        reads.append({"page_id": style.id, "title": style.title, "why": "style guide"})
    await jobs.set_reads(job.id, reads)
    chunk = cut_at_paragraph(text, READ_BUDGET)
    parts = [engine.fenced("page " + page.title, chunk)]
    if style_text.strip():
        parts.append(
            "Style guide page, the rules for this page:\n"
            + engine.fenced(
                "style guide " + (style.title if style else ""),
                cut_at_paragraph(style_text, STYLE_BUDGET),
            )
        )
    if tickets:
        parts.append("Tickets the page mentions:\n" + engine.fenced("tickets", tickets))
    who, system = await start_system(
        job.project_id,
        "You review one documentation page for its author. You never rewrite it; you point at problems.",
    )
    flagged = engine.injection_in(text) or (
        engine.injection_in(style_text) if style_text else None
    )
    out = await engine.call(
        job.project_id,
        system=system,
        prompt="\n\n".join(parts) + "\n\n" + CHECK_TASK.format(n=MAX_MODEL_FINDINGS),
        who=who,
        job_id=job.id,
        person=job.started_by,
        max_tokens=1500,
        timeout=90,
    )
    value, _complete = prompts.parse_json(out.text)
    found = _model_findings(value, text)
    findings: list[dict[str, Any]] = []
    seen: set[str] = set()
    skipped = 0
    for f in links + found:
        if "suggestion" in f and f["kind"] != "unknown_link":
            f["suggestion"] = (
                await engine.verify_refs(job.project_id, f["suggestion"])
            ).text
        if f["kind"] != "unknown_link":
            f["message"] = (await engine.verify_refs(job.project_id, f["message"])).text
        f["id"] = finding_id(f["kind"], f["quote"])
        if f["id"] in ignored:
            skipped += 1
            continue
        if f["id"] in seen:
            continue
        seen.add(f["id"])
        findings.append(f)
    result: dict[str, Any] = {
        "findings": findings,
        "ignored": skipped,
        "style_page": {"id": style.id, "title": style.title} if style else None,
        **cost_of(out),
    }
    if flagged:
        result["flagged"] = flagged
    return result


# ---------------------------------------------------------------------------
# Fix as draft
# ---------------------------------------------------------------------------


async def find_finding(
    session: AsyncSession,
    project_id: str,
    page_id: str,
    finding_id_: str,
    by: str,
    job_id: str | None,
) -> dict[str, Any]:
    """The finding with this id from the person's latest check of the page (or from the given check job)."""
    if job_id:
        candidates = [await jobs.get(session, job_id)]
    else:
        candidates = await jobs.list_jobs(
            session,
            project_id,
            page_id=page_id,
            kind="check",
            state="finished",
            limit=10,
        )
    for j in candidates:
        if j.page_id != page_id or j.kind != "check" or j.started_by != by:
            continue
        for f in (loads(j.result, {}) or {}).get("findings") or []:
            if f.get("id") == finding_id_:
                return dict(f)
    raise DocsAiError(
        "not_found", "That finding is not in your latest check. Check the page again."
    )


@jobs.handler("check_fix")
async def check_fix_job(job: Any) -> dict[str, Any]:
    """`{old, new}` for one finding: the editor swaps `old` for `new` as a draft change the person accepts."""
    inp = job_input(job)
    await jobs.update(job.id, result={})
    finding = inp.get("finding") or {}
    async with database.async_session() as session:
        page, text = await load_page(session, job.page_id, markdown=inp.get("markdown"))
        sp = None
        row = await svc_settings.get(session, job.project_id)
        style_text = ""
        if row.style_page_id and row.style_page_id != page.id:
            sp = await session.get(DocsPage, row.style_page_id)
            if sp is not None and await access.ai_can_read(session, sp):
                style_text = await access.published_text(session, sp)
    quote = str(finding.get("quote") or "")
    found = locate(text, quote)
    if found is None:
        raise DocsAiError(
            "stale",
            "That part of the page changed since the check. Check the page again.",
        )
    exact, _pos = found
    await jobs.set_reads(
        job.id, [{"page_id": page.id, "title": page.title, "why": "this page"}]
    )
    if finding.get("kind") == "unknown_link" and finding.get("suggestion"):
        return {
            "finding_id": finding.get("id"),
            "old": exact,
            "new": str(finding["suggestion"]),
            "cost": 0.0,
            "metered": False,
        }
    who, system = await start_system(
        job.project_id,
        "You fix one problem on a documentation page by rewording the smallest passage that fixes it.",
    )
    parts = [engine.fenced("page " + page.title, cut_at_paragraph(text, READ_BUDGET))]
    if style_text.strip():
        parts.append(
            "Style guide:\n"
            + engine.fenced("style guide", cut_at_paragraph(style_text, STYLE_BUDGET))
        )
    task = (
        f"Problem ({finding.get('kind')}): {finding.get('message')}\nQuoted text: {exact}\n"
        + (f"Idea: {finding.get('suggestion')}\n" if finding.get("suggestion") else "")
        + "Fix it. `old` is a passage copied exactly from the page (the quote, or the sentence or line around it);"
        " `new` replaces it, in the same Markdown. Do not invent facts, ticket keys or page links: where the page does"
        " not give the answer, write `Needs input: <what is missing>`.\n"
        'JSON only: {"old": "...", "new": "..."}'
    )
    out = await engine.call(
        job.project_id,
        system=system,
        prompt="\n\n".join(parts) + "\n\n" + task,
        who=who,
        job_id=job.id,
        person=job.started_by,
        max_tokens=900,
        timeout=60,
    )
    value, _ok = prompts.parse_json(out.text)
    old = str(value.get("old") or "") if isinstance(value, dict) else ""
    new = str(value.get("new") or "") if isinstance(value, dict) else ""
    if old and old not in text:
        located = locate(text, old)
        old = located[0] if located else ""
    if not old or not new.strip() or new == old or loose(exact) not in loose(old):
        raise DocsAiError(
            "invalid",
            "The AI could not make a usable fix for this one. Edit it by hand.",
        )
    new = (await engine.verify_refs(job.project_id, new)).text
    return {"finding_id": finding.get("id"), "old": old, "new": new, **cost_of(out)}
