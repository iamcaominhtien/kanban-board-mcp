"""Write a page with AI (design/screens/docs-ai.md, D; docs-ai-care.md, D).

The AI writes only from the sources a person picks (a ticket and its comments, linked pages, the ticket's code changes
when asked for, an idea, pasted notes or a prompt). Where the sources do not say something it leaves a visible
`[Needs input: what is missing]` marker. The page is created unpublished and the text is stored as the requester's
**private draft** with `ai_source`; nothing is published by AI. `preview` answers "What will be sent" before anything
is asked.
"""

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import DocsDraft, DocsPage, IdeaTicket, Ticket
from services import activity
from services import docs as svc_docs
from services import git_repo
from services.ai import llm, providers
from services.ai.assist import settings as assist
from services.ai.store import loads

from . import access, engine, jobs
from . import settings as svc_settings
from .errors import DocsAiError

# the editor may save the brackets escaped (\[ ... \]); the marker is the same
MARKER = re.compile(r"\\?\[Needs input:[^\]\n]*\]")
PAGE_KINDS = {
    "spec": "a spec: what it is for, how it works, limits and rules, who it concerns, open questions",
    "howto": "a how-to: what it does, the steps, limits and rules, who can do it",
    "release_note": "a release note: what changed, who it affects, what to do, known limits",
    "decision": "a decision record: context, the decision, the options considered, consequences",
    "meeting_notes": (
        "meeting notes: a Summary, Decisions, and Action items as a task list (- [ ] item — owner, due date if said)"
    ),
}
SOURCE_KINDS = ("ticket", "idea", "notes", "prompt")
MAX_NOTES = 20000
MAX_PAGES = 5
MAX_PAGE_CHARS = 6000
MAX_STYLE_CHARS = 4000
MAX_CODE_CHARS = 6000
EXPECTED_OUTPUT_TOKENS = 1200
SOURCES_DELIMITER = "===SOURCES==="

FORMAT = f"""Write the page as Markdown. Do not write a top-level title (the page has one); start with ## headings.
Write only what the numbered sources below say. Cite a claim with its source number in square brackets, like [1].
Where the sources do not say something the page needs, do not guess: write a marker exactly like
[Needs input: maximum rows per export] at that place, on the same line as the sentence it belongs to.
After the page, write a line with exactly {SOURCES_DELIMITER} and then one JSON object and nothing else:
{{"gaps": ["what is missing, in a few words", ...],
  "sources": [{{"n": 1, "quote": "a short phrase copied word for word from source 1 that supports the page"}}]}}"""


# ---------------------------------------------------------------------------
# Markers
# ---------------------------------------------------------------------------


def find_markers(markdown: str) -> list[dict[str, Any]]:
    """The `[Needs input: ...]` markers in a text: `[{text, label, line}]` (`line` is 1-based).

    A marker inside a fenced code block is not a marker.
    """
    out: list[dict[str, Any]] = []
    fenced = False
    for no, line in enumerate((markdown or "").splitlines(), 1):
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            continue
        if fenced:
            continue
        for m in MARKER.finditer(line):
            text = m.group(0).replace("\\", "")
            out.append(
                {
                    "text": text,
                    "label": text[len("[Needs input:") : -1].strip(),
                    "line": no,
                }
            )
    return out


# ---------------------------------------------------------------------------
# What will be sent
# ---------------------------------------------------------------------------


@dataclass
class Source:
    """One numbered source the page is written from."""

    n: int
    kind: str  # description | comments | page | code | idea | notes | prompt
    label: str
    text: str
    page_id: str | None = None


@dataclass
class Gathered:
    """Everything a request sends: the prompt pieces, what they are made of and what was left out."""

    sources: list[Source] = field(default_factory=list)
    parts: list[str] = field(default_factory=list)
    pages: list[dict[str, str]] = field(default_factory=list)
    reads: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    injections: list[dict[str, str]] = field(default_factory=list)
    comments: int = 0
    ticket: dict[str, str] | None = None
    from_label: str = ""
    suggested_title: str = ""
    code: bool = False
    style: str = ""
    style_title: str = ""

    @property
    def prompt(self) -> str:
        """The data part of the prompt."""
        return "\n\n".join(self.parts)

    def add(
        self, kind: str, label: str, text: str, page_id: str | None = None
    ) -> Source:
        """Add a numbered source (its text is fenced as data)."""
        src = Source(len(self.sources) + 1, kind, label, text, page_id)
        self.sources.append(src)
        flagged = engine.injection_in(text)
        if flagged:
            self.injections.append({"source": label, "quote": flagged})
        self.parts.append(f"Source [{src.n}] {label}:\n{engine.fenced(label, text)}")
        return src


def normalize(params: dict[str, Any]) -> dict[str, Any]:
    """Validate the body of preview / write (source, page kind, include flags)."""
    source = params.get("source") or {}
    kind = source.get("kind")
    if kind not in SOURCE_KINDS:
        raise DocsAiError(
            "invalid", "Pick what to write from: a ticket, an idea, notes or a prompt."
        )
    if kind == "ticket" and not source.get("ticket_id"):
        raise DocsAiError("invalid", "Pick a ticket.")
    if kind == "idea" and not source.get("idea_id"):
        raise DocsAiError("invalid", "Pick an idea.")
    if kind in ("notes", "prompt") and not (source.get("text") or "").strip():
        raise DocsAiError(
            "invalid",
            "Paste your notes." if kind == "notes" else "Write what the page is about.",
        )
    page_kind = params.get("page_kind") or (
        "meeting_notes" if kind == "notes" else "spec"
    )
    if page_kind not in PAGE_KINDS:
        raise DocsAiError("invalid", f"Unknown kind of page: {page_kind}.")
    inc = params.get("include") or {}
    return {
        "source": {
            "kind": kind,
            "ticket_id": source.get("ticket_id"),
            "idea_id": source.get("idea_id"),
            "text": (source.get("text") or "")[:MAX_NOTES],
        },
        "page_kind": page_kind,
        "include": {
            "comments": bool(inc.get("comments", True)),
            "linked_pages": bool(inc.get("linked_pages", True)),
            "code_changes": bool(
                inc.get("code_changes", False)
            ),  # off unless asked for
        },
        "title": (params.get("title") or "").strip(),
        "parent_id": params.get("parent_id") or None,
    }


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + "\n…"


def _branch_changes(repo_path: str, branch: str, base_hint: str) -> str:
    """The branch's commits and diff against its base, capped (a blocking call: run it in a thread)."""
    repo = git_repo.open_repo(repo_path)
    if not git_repo.branch_exists(repo, branch):
        raise git_repo.GitRepoError(f"Branch {branch} is not in the repository.")
    base = ""
    for cand in (base_hint, "main", "master", "develop"):
        if cand and cand != branch:
            try:
                git_repo._resolve_ref(repo, cand)  # noqa: SLF001 - the same ref check the branch helpers use
                base = cand
                break
            except git_repo.GitRepoError:
                continue
    if not base:
        raise git_repo.GitRepoError("The branch has no base to compare with.")
    span = f"{base}...{branch}"
    log = repo.git.log("--oneline", "-n", "20", f"{base}..{branch}")
    stat = repo.git.diff("--stat", "--no-color", span)
    patch = repo.git.diff("-U1", "--no-color", span)
    return _clip(
        f"Commits on {branch} (not in {base}):\n{log}\n\nFiles:\n{stat}\n\nChanges:\n{patch}",
        MAX_CODE_CHARS,
    )


async def _ticket_sources(
    session: AsyncSession,
    project_id: str,
    ticket_id: str,
    inc: dict[str, bool],
    g: Gathered,
) -> None:
    t = await session.get(Ticket, ticket_id)
    if t is None or t.project_id != project_id:
        raise DocsAiError("not_found", f"{ticket_id} is not a ticket in this project.")
    g.ticket = {"id": t.id, "title": t.title}
    g.from_label = t.id
    g.suggested_title = t.title
    lines = [
        f"{t.id}: {t.title}",
        f"Type {t.type}, status {t.status}",
        "",
        t.description or "(no description)",
    ]
    acs = [a for a in _json_list(t.acceptance_criteria) if isinstance(a, dict)]
    if acs:
        lines += ["", "Acceptance criteria:"] + [f"- {a.get('text', '')}" for a in acs]
    g.add("description", f"{t.id} description", "\n".join(lines))
    if inc["comments"]:
        comments = [
            c
            for c in _json_list(t.comments)
            if isinstance(c, dict) and not c.get("deleted_at") and c.get("text")
        ]
        if comments:
            body = "\n\n".join(
                f"{c.get('author') or 'user'}: {c['text']}" for c in comments
            )
            g.add("comments", f"{t.id} comments", body)
            g.comments = len(comments)
    if inc["linked_pages"]:
        linked = await svc_docs.docs_for_ticket(session, t.id)
        seen: set[str] = set()
        ordered = [
            r for r in linked if not (r["page_id"] in seen or seen.add(r["page_id"]))
        ]
        await _page_sources(session, project_id, [r["page_id"] for r in ordered], g)
    if inc["code_changes"]:
        await _code_source(session, t, g)


async def _page_sources(
    session: AsyncSession, project_id: str, page_ids: list[str], g: Gathered
) -> None:
    """Add linked pages an AI may read; hidden or never published pages are listed as skipped, not read."""
    hidden = await access.hidden_page_ids(session, project_id)
    readable = {p.id: p for p in await access.readable_pages(session, project_id)}
    for pid in page_ids:
        page = await session.get(DocsPage, pid)
        if page is None or page.deleted_at or page.project_id != project_id:
            continue
        if pid in hidden:
            g.skipped.append(
                {"page_id": pid, "title": page.title, "reason": "hidden from AI"}
            )
            continue
        if pid not in readable:
            g.skipped.append(
                {"page_id": pid, "title": page.title, "reason": "not published yet"}
            )
            continue
        if len(g.pages) >= MAX_PAGES:
            g.skipped.append(
                {
                    "page_id": pid,
                    "title": page.title,
                    "reason": f"more than {MAX_PAGES} pages",
                }
            )
            continue
        text = _clip(await access.published_text(session, page), MAX_PAGE_CHARS)
        g.add("page", page.title, text, page_id=pid)
        g.pages.append({"id": pid, "title": page.title})
        g.reads.append({"page_id": pid, "title": page.title, "why": "linked"})


async def _code_source(session: AsyncSession, t: Ticket, g: Gathered) -> None:
    """The ticket's branch diff summary; skipped with a note when there is no repo or branch."""
    from services.tickets import _project_repo_path

    branches = [
        b for b in _json_list(t.branches) if isinstance(b, dict) and b.get("name")
    ]
    repo_path = await _project_repo_path(session, t)
    if not repo_path or not branches:
        g.notes.append(
            f"{t.id} has no repository or branch, so code changes were left out."
        )
        return
    br = branches[0]
    try:
        text = await asyncio.to_thread(
            _branch_changes,
            repo_path,
            str(br["name"]),
            str(br.get("branch_from") or br.get("branchFrom") or ""),
        )
    except git_repo.GitRepoError as exc:
        g.notes.append(f"Code changes were left out: {exc}")
        return
    except Exception:  # noqa: BLE001 - git is optional context, never a reason to fail the page
        g.notes.append("Code changes were left out: the repository could not be read.")
        return
    g.add("code", f"Code changes on {br['name']}", text)
    g.code = True


async def gather(
    session: AsyncSession, project_id: str, params: dict[str, Any]
) -> Gathered:
    """Read the picked sources (only what an AI may read) and the style guide page."""
    p = normalize(params)
    g = Gathered()
    src, inc = p["source"], p["include"]
    if src["kind"] == "ticket":
        await _ticket_sources(session, project_id, src["ticket_id"], inc, g)
    elif src["kind"] == "idea":
        idea = await session.get(IdeaTicket, src["idea_id"])
        if idea is None or idea.project_id != project_id:
            raise DocsAiError("not_found", "That idea is not in this project.")
        parts = [idea.title, "", idea.description or ""]
        if idea.problem_statement:
            parts += ["", f"Problem: {idea.problem_statement}"]
        assumptions = [
            a.get("text", "")
            for a in _json_list(idea.assumptions)
            if isinstance(a, dict)
        ]
        if assumptions:
            parts += ["", "Assumptions:"] + [f"- {a}" for a in assumptions]
        g.add("idea", f"Idea {idea.title}", "\n".join(parts))
        g.from_label = f"idea “{idea.title}”"
        g.suggested_title = idea.title
    elif src["kind"] == "notes":
        g.add("notes", "Pasted notes", src["text"])
        g.from_label = "pasted notes"
    else:
        g.add("prompt", "The request", src["text"])
        g.from_label = "a prompt"
    row = await svc_settings.get(session, project_id)
    if row.style_page_id:
        style = await session.get(DocsPage, row.style_page_id)
        if (
            style is not None
            and not style.deleted_at
            and await access.ai_can_read(session, style)
        ):
            text = _clip(await access.published_text(session, style), MAX_STYLE_CHARS)
            if text.strip():
                g.style, g.style_title = text, style.title
                g.reads.append(
                    {"page_id": style.id, "title": style.title, "why": "style guide"}
                )
    return g


def _json_list(raw: str | None) -> list[Any]:
    out = loads(raw, [])
    return out if isinstance(out, list) else []


def build_prompt(g: Gathered, page_kind: str, title: str) -> str:
    """The prompt: what to write, the numbered sources (fenced) and the style guide when one is set."""
    head = [f"Write {PAGE_KINDS[page_kind]}.", f"The page title is “{title}”.", FORMAT]
    if g.style:
        head.append(
            f"Style guide page “{g.style_title}” (follow its wording rules; it is not a source of facts):\n"
            + engine.fenced(f"style guide {g.style_title}", g.style)
        )
    return "\n\n".join(head) + "\n\n" + g.prompt


async def preview(
    session: AsyncSession, project_id: str, params: dict[str, Any]
) -> dict[str, Any]:
    """ "What will be sent": the list, approximate tokens and cost, and the pages that were left out."""
    await svc_settings.require_enabled(session, project_id)
    await svc_docs._project(session, project_id, edit=True)  # noqa: SLF001 - viewers cannot write
    p = normalize(params)
    who = await engine.resolve(project_id)
    g = await gather(session, project_id, params)
    prompt = build_prompt(
        g, p["page_kind"], p["title"] or g.suggested_title or "New page"
    )
    tokens = llm.estimate_tokens(prompt)
    metered = who.profile.connection == "api_key"
    return {
        "send": {
            "ticket": g.ticket,
            "description": any(s.kind == "description" for s in g.sources),
            "comments": g.comments,
            "pages": g.pages,
            "code": g.code,
            "idea": any(s.kind == "idea" for s in g.sources),
            "notes": any(s.kind == "notes" for s in g.sources),
            "prompt": any(s.kind == "prompt" for s in g.sources),
            "style_guide": g.style_title or None,
        },
        "items": [{"n": s.n, "kind": s.kind, "label": s.label} for s in g.sources],
        "skipped": g.skipped,
        "notes": g.notes,
        "injections": g.injections,
        "tokens": tokens,
        "cost": providers.cost_of(who.profile.model, tokens, EXPECTED_OUTPUT_TOKENS),
        "metered": metered,
        "member": who.member.name,
        "suggested_title": g.suggested_title,
        "from": g.from_label,
    }


# ---------------------------------------------------------------------------
# Writing the draft
# ---------------------------------------------------------------------------


def _strip_fence(text: str) -> str:
    m = re.match(r"^\s*```(?:markdown|md)?\s*\n(.*?)\n```\s*$", text, re.S)
    return m.group(1) if m else text


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _same_gap(label: str, gap: str) -> bool:
    """A marker and a listed gap name the same thing when their words mostly overlap."""
    a, b = set(_norm(label).split()), set(_norm(gap).split())
    return bool(a and b) and len(a & b) / min(len(a), len(b)) >= 0.6


def parse_answer(text: str, g: Gathered) -> tuple[str, list[str], list[dict[str, Any]]]:
    """Split the model's answer into the page, the gaps and the verified sources.

    A quote is kept only when it really appears in its source; a source the model made up is dropped.
    """
    body, _, tail = text.partition(SOURCES_DELIMITER)
    body = _strip_fence(body.strip()).strip()
    meta: dict[str, Any] = {}
    m = re.search(r"\{.*\}", tail, re.S)
    if m:
        try:
            parsed = json.loads(m.group(0))
            meta = parsed if isinstance(parsed, dict) else {}
        except ValueError:
            meta = {}
    gaps = (
        [str(x).strip() for x in meta.get("gaps", []) if str(x).strip()]
        if isinstance(meta.get("gaps"), list)
        else []
    )
    known = {s.n: s for s in g.sources}
    sources: list[dict[str, Any]] = []
    for raw in meta.get("sources", []) if isinstance(meta.get("sources"), list) else []:
        if not isinstance(raw, dict):
            continue
        try:
            n = int(raw.get("n"))
        except (TypeError, ValueError):
            continue
        src = known.get(n)
        if src is None or any(s["n"] == n for s in sources):
            continue
        quote = str(raw.get("quote") or "").strip()
        verified = bool(quote) and _norm(quote) in _norm(src.text)
        sources.append(
            {
                "n": n,
                "kind": src.kind,
                "label": src.label,
                "page_id": src.page_id,
                "quote": quote[:300] if verified else "",
            }
        )
    sources.sort(key=lambda s: s["n"])
    for marker in find_markers(
        body
    ):  # every marker is a gap, even when the model forgot to list it
        if not any(_same_gap(marker["label"], x) for x in gaps):
            gaps.append(marker["label"])
    return body, gaps, sources


async def _store_draft(
    session: AsyncSession, page_id: str, person: str, ai_source: dict[str, Any]
) -> None:
    draft = await svc_docs._draft_for(session, page_id, person)  # noqa: SLF001
    if draft is None:
        raise DocsAiError("not_found", "The draft could not be stored.")
    draft.ai_source = json.dumps(ai_source)
    session.add(draft)
    await session.commit()


@jobs.handler("write")
async def write_handler(job: Any) -> dict[str, Any]:
    """Read the sources, ask the AI member, create the page and store the text as the requester's private draft."""
    params = loads(job.result, {}).get("params") or {}
    await jobs.update(job.id, result={})
    person = job.started_by
    token = activity.set_actor(person)
    try:
        p = normalize(params)
        who = await engine.resolve(job.project_id)
        async with database.async_session() as session:
            g = await gather(session, job.project_id, params)
            row = await assist.get(session)
        title = p["title"] or g.suggested_title or "New page"
        what = [s.label for s in g.sources]
        await jobs.add_step(job.id, "Reading " + ", ".join(what)[:200])
        if g.skipped:
            await jobs.add_step(
                job.id,
                "Left out: "
                + ", ".join(f"{s['title']} ({s['reason']})" for s in g.skipped),
            )
        await jobs.set_reads(job.id, g.reads)
        if g.injections:
            await jobs.add_step(
                job.id,
                "Some source text reads like instructions. It was treated as data, not followed.",
            )
        out = await engine.call(
            job.project_id,
            system=engine.system_prompt(
                who, row, "Write a draft page only from the sources you were given."
            ),
            prompt=build_prompt(g, p["page_kind"], title),
            who=who,
            job_id=job.id,
            person=person,
            max_tokens=3000,
            timeout=180.0,
        )
        body, gaps, sources = parse_answer(out.text, g)
        if not body:
            raise DocsAiError("unavailable", "The AI answered with no page. Try again.")
        checked = await engine.verify_refs(job.project_id, body)
        body = checked.text
        async with database.async_session() as session:
            created = await svc_docs.create_page(
                session, job.project_id, title, parent_id=p["parent_id"], markdown=body
            )
            ai_source = {
                "kind": p["source"]["kind"],
                "page_kind": p["page_kind"],
                "from": g.from_label,
                "ticket_id": (g.ticket or {}).get("id"),
                "member_id": who.member.id,
                "gaps": gaps,
                "sources": sources,
                "accepted": False,
            }
            await _store_draft(session, created["id"], person, ai_source)
        await jobs.update(job.id, page_id=created["id"])
        return {
            "page_id": created["id"],
            "title": created["title"],
            "gaps": gaps,
            "sources": sources,
            "markers": len(find_markers(body)),
            "cost": round(out.cost, 6),
            "skipped": g.skipped,
            "notes": g.notes + checked.problems,
            "injections": g.injections,
        }
    finally:
        activity.reset_actor(token)


async def _check_source(
    session: AsyncSession, project_id: str, src: dict[str, Any]
) -> None:
    if src["kind"] == "ticket":
        t = await session.get(Ticket, src["ticket_id"])
        if t is None or t.project_id != project_id:
            raise DocsAiError(
                "not_found", f"{src['ticket_id']} is not a ticket in this project."
            )
    elif src["kind"] == "idea":
        idea = await session.get(IdeaTicket, src["idea_id"])
        if idea is None or idea.project_id != project_id:
            raise DocsAiError("not_found", "That idea is not in this project.")


async def start(
    session: AsyncSession, project_id: str, params: dict[str, Any], person: str
) -> Any:
    """Check the request (Docs AI on, the person can edit, the sources exist) and start the `write` job."""
    await svc_settings.require_enabled(session, project_id)
    await svc_docs._project(session, project_id, edit=True)  # noqa: SLF001
    p = normalize(params)
    if p["parent_id"]:
        parent = await session.get(DocsPage, p["parent_id"])
        if parent is None or parent.project_id != project_id or parent.deleted_at:
            raise DocsAiError("invalid", "The page to put it under does not exist.")
    await engine.resolve(project_id)  # no_member before any work
    await _check_source(
        session, project_id, p["source"]
    )  # an unknown ticket / idea answers now
    return await jobs.start(
        session,
        project_id=project_id,
        kind="write",
        started_by=person,
        instruction=f"Write a {p['page_kind']} from {p['source']['kind']}"[:200],
        result={"params": p},
    )


# ---------------------------------------------------------------------------
# The caller's draft: markers, accepted AI text
# ---------------------------------------------------------------------------


async def markers_of_draft(session: AsyncSession, page_id: str) -> dict[str, Any]:
    """Markers still in the caller's draft (a person who can edit the page; used before publishing)."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    draft = await svc_docs._draft_for(session, page.id, activity.current_actor())  # noqa: SLF001
    markers = find_markers(draft.markdown) if draft else []
    return {
        "count": len(markers),
        "markers": markers,
        "with_ai": bool(draft and draft.ai_source),
    }


async def mark_accepted(session: AsyncSession, page_id: str) -> dict[str, Any]:
    """The editor accepted AI text: mark the caller's draft so History shows "with AI" once it is published."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    actor = activity.current_actor()
    draft = await svc_docs._draft_for(session, page.id, actor)  # noqa: SLF001
    if draft is None:
        draft = DocsDraft(
            page_id=page.id,
            author=actor,
            title=page.title,
            markdown=await access.published_text(session, page),
            base_version=page.version,
        )
    source = loads(draft.ai_source, None) if draft.ai_source else None
    if not isinstance(source, dict):
        source = {"kind": "accepted", "from": "/ai", "gaps": [], "sources": []}
    source["accepted"] = True
    draft.ai_source = json.dumps(source)
    session.add(draft)
    await session.commit()
    return {"accepted": True}


async def draft_of(session: AsyncSession, page_id: str) -> DocsDraft | None:
    """The caller's own draft of a page (never anyone else's)."""
    return (
        await session.exec(
            select(DocsDraft).where(
                DocsDraft.page_id == page_id,
                DocsDraft.author == activity.current_actor(),
            )
        )
    ).first()
