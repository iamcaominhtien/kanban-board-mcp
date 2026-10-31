"""AI in every editor (design/screens/ai-where-you-work.md, D): the /ai menu, the selection bar and "Ask AI to write".

A request is never automatic: the person selects text or types /ai. The result is a draft kept outside the text
until the person accepts it. What is sent is built in one place (`build`) and listed to the person before sending
("What will be sent"), so the list and the call cannot differ. Calls go to the Board AI (or the first AI member that
can answer), count toward that member's daily budget and the board's, and an accepted edit is recorded in Activity.

Draft kind `editor` (ticket text: description, comment, criteria, Debug notes, test case notes) uses the "drafting"
feature switch; `editor_doc` (Docs pages and ideas) uses "docs". The result of a draft is `payload.result`:
`{"kind": "replace" | "insert" | "answer" | "list" | "diagram", "text", "items", "diagram", "cut_short"}`.
"""

import asyncio
import json
import re
import uuid
import xml.sax.saxutils as xml_escape
from dataclasses import dataclass, field

from sqlmodel.ext.asyncio.session import AsyncSession

import database
import services.activity as act
import services.tickets as svc_tickets
from models import AiDraft, AiMember, DocsPage, IdeaTicket, Ticket

from .. import audit, llm
from ..store import loads, now_iso
from . import context as ctxb
from . import cost, idea_scope, prompts, scopes
from . import drafts as svc_drafts
from . import settings as svc_settings
from .settings import AssistError

KINDS = ("editor", "editor_doc")
TICKET_SURFACES = (
    "ticket_description",
    "acceptance_criteria",
    "comment",
    "debug_note",
    "test_case",
)
DOC_SURFACES = ("doc", "idea")

# action: (label, hint, what the result is)
ACTIONS: dict[str, tuple[str, str, str]] = {
    "improve": ("Improve", "Clearer and tighter, same meaning", "replace"),
    "shorten": ("Shorten", "The same, in fewer words", "replace"),
    "fix_spelling": ("Fix spelling", "Spelling and grammar only", "replace"),
    "explain": ("Explain", "In plain words, as an answer", "answer"),
    "ask": ("Ask AI…", "Write from a prompt, with this page as context", "replace"),
    "continue": ("Continue writing", "Carry on from the cursor", "insert"),
    "summarise": ("Summarise", "The text above, as a short list", "insert"),
    "criteria": (
        "Draft acceptance criteria",
        "From this description (tickets only)",
        "list",
    ),
    "diagram": (
        "Draw a diagram",
        "From a description, as an editable draw.io diagram",
        "diagram",
    ),
    "translate": ("Translate…", "The paragraph above", "replace"),
    "split": ("Split", "One criterion into several", "list"),
    "more_criteria": ("Draft more", "Criteria that are not covered yet", "list"),
}

# Where it works (design D5). `menu` is what /ai and Ctrl+J offer, `bar` the selection bar.
BAR = ["improve", "shorten", "fix_spelling", "explain", "ask"]
SURFACES: dict[str, dict] = {
    "ticket_description": {
        "label": "Ticket description",
        "menu": ["ask", "continue", "summarise", "criteria", "translate"],
        "bar": BAR,
        "context": "ticket",
    },
    "acceptance_criteria": {
        "label": "Acceptance criteria",
        "menu": ["improve", "split", "more_criteria"],
        "bar": ["improve", "split"],
        "context": "ticket",
    },
    "comment": {
        "label": "Comment box",
        "menu": ["improve", "translate", "summarise"],
        "bar": BAR,
        "context": "ticket",
    },
    "doc": {
        "label": "Docs page",
        "menu": ["ask", "continue", "summarise", "diagram", "translate"],
        "bar": BAR,
        "context": "page",
    },
    "idea": {
        "label": "Idea page",
        "menu": ["ask", "continue", "summarise", "diagram", "translate"],
        "bar": BAR,
        "context": "page",
    },
    "debug_note": {
        "label": "Debug notes",
        "menu": ["improve", "summarise", "translate"],
        "bar": ["improve", "summarise", "translate"],
        "context": "ticket",
    },
    "test_case": {
        "label": "Test case note",
        "menu": ["ask", "continue", "summarise", "translate"],
        "bar": BAR,
        "context": "ticket",
    },
}

MAX_SELECTION = 12000
MAX_AROUND = 2000
MAX_PAGE = 12000
MAX_TICKET = 6000
MAX_PROMPT = 2000


@dataclass
class Request:
    """What the person asked for."""

    surface: str
    action: str
    selection: str = ""
    before: str = ""
    after: str = ""
    prompt: str = ""
    language: str = ""
    ticket_id: str | None = None
    doc_id: str | None = None
    idea_id: str | None = None
    # the "This ticket / This page / Selected text" chips: what the person lets the AI read besides the instruction
    include: dict = field(default_factory=dict)
    continue_from: str = ""

    @classmethod
    def of(cls, data: dict) -> "Request":
        """From the API body, with limits."""
        return cls(
            surface=str(data.get("surface") or ""),
            action=str(data.get("action") or ""),
            selection=str(data.get("selection") or "")[:MAX_SELECTION],
            before=str(data.get("before") or "")[-MAX_AROUND:],
            after=str(data.get("after") or "")[:MAX_AROUND],
            prompt=str(data.get("prompt") or "")[:MAX_PROMPT],
            language=str(data.get("language") or "")[:40],
            ticket_id=data.get("ticket_id") or None,
            doc_id=data.get("doc_id") or None,
            idea_id=data.get("idea_id") or None,
            include=dict(data.get("include") or {}),
            continue_from=str(data.get("continue_from") or "")[:20000],
        )

    def as_input(self) -> dict:
        """What is stored with the draft (so Try again asks the same thing)."""
        return {
            "surface": self.surface,
            "action": self.action,
            "selection": self.selection,
            "before": self.before,
            "after": self.after,
            "prompt": self.prompt,
            "language": self.language,
            "ticket_id": self.ticket_id,
            "doc_id": self.doc_id,
            "idea_id": self.idea_id,
            "include": self.include,
            "continue_from": self.continue_from,
        }

    def wants(self, key: str, default: bool) -> bool:
        """Whether a context chip is on."""
        return bool(self.include.get(key, default))


@dataclass
class Built:
    """The text sent, and the list shown to the person before sending."""

    task: str
    body: str = ""
    pieces: list[dict] = field(default_factory=list)
    private_skipped: list[str] = field(default_factory=list)

    @property
    def tokens(self) -> int:
        """Rough size of what is sent."""
        return llm.estimate_tokens(self.task + self.body)


def _piece(kind: str, label: str, text: str) -> dict:
    return {
        "kind": kind,
        "label": label,
        "chars": len(text),
        "tokens": llm.estimate_tokens(text),
        "preview": " ".join(text.split())[:160],
    }


def check(req: Request) -> None:
    """Refuse a request the surface does not offer (the table in design D5)."""
    spec = SURFACES.get(req.surface)
    if spec is None:
        raise AssistError("invalid", f"Unknown place: {req.surface}.")
    if req.action not in ACTIONS:
        raise AssistError("invalid", f"Unknown action: {req.action}.")
    if req.action not in {*spec["menu"], *spec["bar"]}:
        raise AssistError(
            "invalid",
            f"“{ACTIONS[req.action][0]}” is not offered in the {spec['label'].lower()}.",
        )
    if req.action in (
        "improve",
        "shorten",
        "fix_spelling",
        "explain",
        "split",
    ) and not (req.selection.strip() or req.before.strip()):
        raise AssistError("invalid", "Select some text first.")
    if req.action == "ask" and not req.prompt.strip():
        raise AssistError("invalid", "Write what you want first.")
    if req.action == "translate" and not (req.selection.strip() or req.before.strip()):
        raise AssistError("invalid", "There is no text to translate yet.")
    if req.action in ("summarise", "continue") and not (
        req.selection.strip() or req.before.strip()
    ):
        raise AssistError("invalid", "There is no text yet. Write a little first.")
    if req.action == "diagram" and not (
        req.prompt.strip() or req.selection.strip() or req.before.strip()
    ):
        raise AssistError("invalid", "Describe the diagram first.")
    if req.action in ("criteria", "more_criteria") and not req.ticket_id:
        raise AssistError("invalid", "Acceptance criteria belong to a ticket.")


async def _ticket(
    session: AsyncSession, project_id: str, ticket_id: str, person: str
) -> Ticket:
    t = await session.get(Ticket, ticket_id)
    if t is None or t.project_id != project_id:
        raise AssistError("not_found", "Ticket not found in this project.")
    await scopes.ensure_access(session, project_id, person)
    return t


async def build(
    session: AsyncSession, project_id: str, req: Request, person: str
) -> Built:
    """Assemble exactly what the model gets, as a task plus fenced material, and the list of pieces."""
    check(req)
    spec = SURFACES[req.surface]
    pieces: list[dict] = []
    private: list[str] = []
    material: list[str] = []
    label, hint, _ = ACTIONS[req.action]
    selection = req.selection if req.wants("selection", True) else ""
    pieces.append(
        {
            "kind": "instruction",
            "label": f"Your request: {label.rstrip('…')}"
            + (f" · {req.language}" if req.language else ""),
            "chars": len(req.prompt),
            "tokens": llm.estimate_tokens(req.prompt) if req.prompt else 0,
            "preview": " ".join(req.prompt.split())[:160],
        }
    )
    if selection.strip():
        material.append("Selected text:\n" + ctxb.fence("selected text", selection))
        pieces.append(_piece("selection", "Selected text", selection))
    around_ok = req.action in ("continue", "summarise", "translate", "ask", "diagram")
    if around_ok or not selection.strip():
        if req.before.strip():
            name = "Text above the cursor" if not selection.strip() else "Text above"
            material.append(
                f"{name}:\n" + ctxb.fence("text before the cursor", req.before)
            )
            pieces.append(_piece("before", name, req.before))
    if req.after.strip() and (req.action in ("continue", "ask") or selection.strip()):
        material.append("Text below:\n" + ctxb.fence("text after", req.after))
        pieces.append(_piece("after", "Text below", req.after))
    row = await svc_settings.get(session)
    excluded = svc_settings.excluded_docs(row)
    wants_context = req.action in (
        "ask",
        "continue",
        "criteria",
        "more_criteria",
        "diagram",
        "summarise",
        "split",
    )
    if (
        spec["context"] == "ticket"
        and req.ticket_id
        and req.wants("ticket", wants_context)
    ):
        t = await _ticket(session, project_id, req.ticket_id, person)
        acs = [
            a.get("text", "")
            for a in loads(t.acceptance_criteria, [])
            if isinstance(a, dict)
        ]
        text = f"{t.id} {t.title}\nType: {t.type}. Status: {t.status}.\n"
        if req.surface != "ticket_description":
            text += "Description:\n" + (t.description or "(empty)")[:MAX_TICKET] + "\n"
        else:
            # the description being edited is the selection / text around it; the title and criteria give context
            text += (
                "Description (current, for context):\n"
                + (t.description or "")[:MAX_TICKET]
                + "\n"
            )
        if acs:
            text += "Acceptance criteria:\n" + "\n".join(f"- {a}" for a in acs) + "\n"
        material.append("This ticket:\n" + ctxb.fence(f"ticket {t.id}", text.strip()))
        pieces.append(
            _piece(
                "ticket",
                f"This ticket ({t.id}): title, description"
                + (f", {len(acs)} criteria" if acs else ""),
                text,
            )
        )
    if (
        spec["context"] == "page"
        and req.surface == "idea"
        and req.idea_id
        and req.wants("page", wants_context)
    ):
        title, text = await idea_scope.editor_context(
            session, project_id, req.idea_id, person
        )
        material.append(
            f"This idea ({req.idea_id}):\n"
            + ctxb.fence(f"idea {req.idea_id}", text[:MAX_PAGE])
        )
        pieces.append(
            _piece(
                "page",
                f"This idea: {title} (page, assumptions, comments)",
                text[:MAX_PAGE],
            )
        )
    elif (
        spec["context"] == "page"
        and req.surface != "idea"
        and req.doc_id
        and req.wants("page", wants_context)
    ):
        page = await session.get(DocsPage, req.doc_id)
        if page is None or page.project_id != project_id or page.deleted_at:
            raise AssistError("not_found", "Page not found in this project.")
        await scopes.ensure_access(session, project_id, person)
        if page.id in excluded:
            private.append(page.title or "This page")
        else:
            text = await ctxb.doc_text(session, page)
            material.append(
                f"This page ({page.title}):\n"
                + ctxb.fence(f"doc {page.title}", text[:MAX_PAGE])
            )
            pieces.append(_piece("page", f"This page: {page.title}", text[:MAX_PAGE]))
    tasks = {
        "improve": "Improve the selected text: clearer and tighter, same meaning, same language, same Markdown structure.",
        "shorten": "Shorten the selected text to about half its length. Keep every fact and the Markdown structure.",
        "fix_spelling": "Fix spelling, grammar and punctuation in the selected text. Change nothing else: do not rephrase.",
        "translate": f"Translate the text into {req.language or 'English'}. Keep Markdown, links, code, numbers and"
        " @mentions exactly as they are.",
        "summarise": "Summarise the text as a short Markdown bullet list: at most 5 bullets, each one line.",
        "continue": "Carry on writing from the cursor in the same voice and format. Write about 100 words at most."
        " Do not repeat the text above.",
        "explain": "Explain the selected text in plain words for a teammate, in 2 to 4 sentences. This is an answer to"
        " the person, not text for the document.",
        "ask": (
            "Follow the person's instruction and write the text. "
            + (
                "It replaces the selected text, so return the whole new version of it."
                if selection.strip()
                else "It is inserted at the cursor, so return only the new text."
            )
            + "\nInstruction:\n"
            + ctxb.fence("instruction", req.prompt)
        ),
        "criteria": "Write acceptance criteria for this ticket that its description implies and that are not listed yet:"
        ' at most 6, one short testable sentence each. JSON only: {"items": ["..."]}',
        "more_criteria": "Write more acceptance criteria for this ticket that are not listed yet: at most 5, one short"
        ' testable sentence each. JSON only: {"items": ["..."]}',
        "split": "Split the selected acceptance criterion into 2 to 4 smaller, separately testable criteria, one"
        ' sentence each. JSON only: {"items": ["..."]}',
        "diagram": (
            "Draw a diagram of what the person describes. JSON only: "
            '{"title": "...", "nodes": [{"id": "n1", "label": "...", "shape": "box|decision|start"}], '
            '"edges": [{"from": "n1", "to": "n2", "label": "optional"}]}. At most 14 nodes, short labels.'
            + (
                "\nDescription:\n" + ctxb.fence("description", req.prompt)
                if req.prompt.strip()
                else ""
            )
        ),
    }
    task = tasks[req.action]
    if req.continue_from:
        task += (
            "\nYour previous reply was cut short at the length limit. Continue it exactly where it stopped,"
            " without repeating anything."
        )
        material.append("Your reply so far:\n" + req.continue_from[-3000:])
        pieces.append(_piece("partial", "The part already written", req.continue_from))
    return Built(
        task=task, body="\n\n".join(material), pieces=pieces, private_skipped=private
    )


SYSTEM_RULES = (
    "You are a writing helper inside an editor. The person selects text or types /ai; you only ever produce a draft"
    " that they accept or discard.\n"
    "Return only the requested text, with no introduction, no sign-off and no code fences around it (unless the text"
    " itself is code). Keep Markdown, [[page links]], ticket keys such as KAN-12 and @[Name](member:id) mentions"
    " exactly as they are. Do not add facts that are not in the text or the context."
)


def _unfence(text: str) -> str:
    """A reply wrapped in one code fence loses it; leading chatter such as 'Here is…' is not removed."""
    t = text.strip("\n")
    m = re.fullmatch(r"```[a-zA-Z]*\n(.*)\n```", t.strip(), re.DOTALL)
    return m.group(1) if m else t.strip("\n")


def _items(value) -> list[str]:
    out: list[str] = []
    raw = value.get("items") if isinstance(value, dict) else value
    for x in raw or []:
        t = " ".join(str(x or "").split())[:500]
        if t and t not in out:
            out.append(t)
    return out[:8]


def diagram_xml(title: str, nodes: list[dict], edges: list[dict]) -> str:
    """draw.io XML for a flow: nodes in layers from the first node, boxes, decisions as diamonds, arrows."""
    ids = [str(n["id"]) for n in nodes]
    level: dict[str, int] = {}
    for n in ids:
        level.setdefault(n, 0)
    incoming: dict[str, list[str]] = {n: [] for n in ids}
    for e in edges:
        if e["from"] in incoming and e["to"] in incoming and e["from"] != e["to"]:
            incoming[e["to"]].append(e["from"])
    for _ in range(
        len(ids)
    ):  # relax: a node sits below its deepest parent (cycles stop after n rounds)
        moved = False
        for n in ids:
            want = max((level[p] + 1 for p in incoming[n]), default=0)
            if want > level[n] and want <= len(ids):
                level[n], moved = want, True
        if not moved:
            break
    rows: dict[int, list[str]] = {}
    for n in ids:
        rows.setdefault(level[n], []).append(n)
    w, h, gx, gy = 140, 56, 60, 70
    cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>']
    pos: dict[str, tuple[int, int]] = {}
    for lv, row in sorted(rows.items()):
        total = len(row) * w + (len(row) - 1) * gx
        for i, n in enumerate(row):
            pos[n] = (
                40 + i * (w + gx) + max(0, (900 - total) // 2),
                40 + lv * (h + gy),
            )
    for n in nodes:
        nid = str(n["id"])
        shape = n.get("shape")
        style = {
            "decision": "rhombus;whiteSpace=wrap;html=1;fillColor=#FFF2CC;strokeColor=#D6B656;",
            "start": "ellipse;whiteSpace=wrap;html=1;fillColor=#D5E8D4;strokeColor=#82B366;",
        }.get(
            shape,
            "rounded=1;whiteSpace=wrap;html=1;fillColor=#DAE8FC;strokeColor=#6C8EBF;",
        )
        x, y = pos[nid]
        label = xml_escape.quoteattr(str(n.get("label") or nid)[:80])
        cells.append(
            f'<mxCell id="n-{xml_escape.escape(nid)}" value={label} style="{style}" vertex="1" parent="1">'
            f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
        )
    for i, e in enumerate(edges):
        if e["from"] not in pos or e["to"] not in pos:
            continue
        label = xml_escape.quoteattr(str(e.get("label") or "")[:60])
        cells.append(
            f'<mxCell id="e-{i}" value={label} style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;"'
            f' edge="1" parent="1" source="n-{xml_escape.escape(str(e["from"]))}"'
            f' target="n-{xml_escape.escape(str(e["to"]))}"><mxGeometry relative="1" as="geometry"/></mxCell>'
        )
    name = xml_escape.quoteattr(str(title or "Diagram")[:80])
    return (
        f'<mxfile><diagram id="d1" name={name}><mxGraphModel dx="1000" dy="700" grid="1" gridSize="10" page="1">'
        f"<root>{''.join(cells)}</root></mxGraphModel></diagram></mxfile>"
    )


def _diagram(value) -> dict | None:
    """The model's nodes and edges, checked, as {title, nodes, edges, xml}."""
    if not isinstance(value, dict):
        return None
    nodes, seen = [], set()
    for n in value.get("nodes") or []:
        if not isinstance(n, dict) or not str(n.get("id") or "").strip():
            continue
        nid = re.sub(r"[^A-Za-z0-9_-]", "", str(n["id"]))[:20]
        if not nid or nid in seen:
            continue
        seen.add(nid)
        nodes.append(
            {
                "id": nid,
                "label": " ".join(str(n.get("label") or nid).split())[:80],
                "shape": n.get("shape")
                if n.get("shape") in ("decision", "start")
                else "box",
            }
        )
    if len(nodes) < 2:
        return None
    edges = []
    for e in value.get("edges") or []:
        if not isinstance(e, dict):
            continue
        a = re.sub(r"[^A-Za-z0-9_-]", "", str(e.get("from") or ""))[:20]
        b = re.sub(r"[^A-Za-z0-9_-]", "", str(e.get("to") or ""))[:20]
        if a in seen and b in seen and a != b:
            edges.append(
                {
                    "from": a,
                    "to": b,
                    "label": " ".join(str(e.get("label") or "").split())[:60],
                }
            )
    nodes = nodes[:14]
    keep = {n["id"] for n in nodes}
    edges = [e for e in edges if e["from"] in keep and e["to"] in keep][:30]
    title = " ".join(str(value.get("title") or "Diagram").split())[:80]
    return {
        "title": title,
        "nodes": nodes,
        "edges": edges,
        "xml": diagram_xml(title, nodes, edges),
    }


async def _check_idea(
    session: AsyncSession, project_id: str, idea_id: str, person: str
) -> None:
    """An idea page is edited with AI only where the Idea Space allows AI (its switch and daily cap), by someone who
    belongs to the project the request is booked on. A project-less idea is booked on a project of the caller."""
    idea = await idea_scope.load(session, idea_id)
    if idea.project_id not in (None, project_id):
        raise AssistError("not_found", "Idea not found in this project.")
    await scopes.ensure_access(session, project_id, person)
    await idea_scope.check_idea_ai(session, idea.project_id)


def _feature(surface: str) -> str:
    return "docs" if surface in DOC_SURFACES else "drafting"


async def _member(session: AsyncSession, project_id: str, ticket_id: str | None):
    prefer = None
    if ticket_id:
        t = await session.get(Ticket, ticket_id)
        prefer = t.assignee if t else None
    return await svc_settings.resolve_member(session, project_id, None, prefer)


async def state(
    session: AsyncSession,
    project_id: str,
    surface: str,
    person: str,
    ticket_id: str | None = None,
    idea_id: str | None = None,
) -> dict:
    """What the editor shows before anyone asks: whether the person may, the /ai menu, the selection bar and the cost
    of a typical request. Nothing is sent."""
    spec = SURFACES.get(surface)
    if spec is None:
        raise AssistError("invalid", f"Unknown place: {surface}.")
    member_id = await _member(session, project_id, ticket_id)
    availability: dict = {"code": "ok"}
    profile = None
    try:
        got = await svc_settings.guard_request(
            session,
            project_id,
            _feature(surface),
            person=person,
            member_id=member_id,
            require_member=True,
        )
        profile = got["profile"]
        availability["member"] = got["member"].name
        if surface == "idea" and idea_id:
            await _check_idea(session, project_id, idea_id, person)
    except AssistError as exc:
        availability = {"code": exc.code, "message": str(exc), **exc.extra}
        profile = await session.get(AiMember, member_id) if member_id else None

    def entry(a: str) -> dict:
        label, hint, kind = ACTIONS[a]
        if a == "ask" and surface not in DOC_SURFACES:
            hint = "Write from a prompt, with this ticket as context"
        if a == "diagram" and surface == "idea":
            hint = "From a description, as an editable draw.io diagram"
        return {"action": a, "label": label, "hint": hint, "result": kind}

    est = cost.estimate(profile, 600, "draft") if profile else None
    return {
        "surface": surface,
        "label": spec["label"],
        "availability": availability,
        "menu": [entry(a) for a in spec["menu"]],
        "bar": [entry(a) for a in spec["bar"]],
        "estimate": est,
        "member_id": member_id,
    }


async def preview(
    session: AsyncSession, project_id: str, data: dict, person: str
) -> dict:
    """ "What will be sent": the pieces of the request, their sizes, what is never sent and the cost. Sends nothing."""
    req = Request.of(data)
    built = await build(session, project_id, req, person)
    member_id = await _member(session, project_id, req.ticket_id)
    profile = await session.get(AiMember, member_id) if member_id else None
    return {
        "pieces": built.pieces,
        "tokens": built.tokens,
        "estimate": cost.estimate(profile, built.tokens, "draft") if profile else None,
        "private_skipped": built.private_skipped,
        "never_sent": [
            "Private Docs and tickets you cannot see",
            "Attachments and secrets",
            "Other comments, unless you pick them",
        ],
    }


async def start(
    session: AsyncSession, project_id: str, data: dict, person: str
) -> AiDraft:
    """Ask for a draft. It is written in the background (poll it); nothing in the text changes."""
    req = Request.of(data)
    check(req)
    member_id = await _member(session, project_id, req.ticket_id)
    info = await svc_settings.guard_request(
        session,
        project_id,
        _feature(req.surface),
        person=person,
        member_id=member_id,
        require_member=True,
    )
    if req.surface == "idea" and req.idea_id:
        await _check_idea(session, project_id, req.idea_id, person)
    await build(
        session, project_id, req, person
    )  # refuses an unknown ticket or page before anything is written
    member = info["member"]
    d = AiDraft(
        id=str(uuid.uuid4()),
        project_id=project_id,
        kind="editor_doc" if req.surface in DOC_SURFACES else "editor",
        owner=person,
        member_id=member.id,
        member_name=member.name,
        ticket_id=req.ticket_id,
        doc_id=req.doc_id,
        payload=json.dumps({"input": req.as_input()}),
        status="pending",
        created_at=now_iso(),
    )
    session.add(d)
    await session.commit()
    await session.refresh(d)
    svc_drafts._spawn(d.id)
    await svc_drafts._publish()
    return d


async def _set_partial(draft_id: str, text: str) -> None:
    async with database.async_session() as session:
        d = await session.get(AiDraft, draft_id)
        if d is None or d.status != "pending":
            return
        payload = loads(d.payload, {})
        payload["partial"] = text
        d.payload = json.dumps(payload)
        session.add(d)
        await session.commit()


async def generate(d: AiDraft, profile: AiMember, row, project, allow_more: bool):
    """The generator of `editor` and `editor_doc` drafts (see `drafts.GENERATORS`)."""
    await svc_drafts._remember_name(profile)
    inp = loads(d.payload, {}).get("input") or {}
    req = Request.of(inp)
    async with database.async_session() as session:
        built = await build(session, d.project_id, req, d.owner)
    action = req.action
    kind = ACTIONS[action][2]
    system = prompts.system(
        svc_drafts.profile_name(profile),
        project.name if project else "",
        row,
        SYSTEM_RULES,
    )
    prompt = (
        f"{built.body}\n\nTask: {built.task}" if built.body else f"Task: {built.task}"
    )
    buf: list[str] = []
    loop = asyncio.get_running_loop()
    last = [0.0]

    async def on_delta(piece: str) -> None:
        buf.append(piece)
        now = loop.time()
        if kind in ("replace", "insert", "answer") and now - last[0] > 0.25:
            last[0] = now
            await _set_partial(d.id, req.continue_from + "".join(buf))

    size = max(len(req.selection), len(req.before) if action == "translate" else 0)
    want = {
        "improve": size // 3 * 2 + 200,
        "shorten": size // 4 + 200,
        "fix_spelling": size // 3 * 2 + 200,
        "translate": size // 2 + 300,
        "explain": 500,
        "continue": 400,
        "summarise": 400,
        "ask": max(600, size // 2),
        "diagram": 1200,
    }.get(action, 700)
    max_tokens = svc_settings.max_tokens_for(row, profile, max(300, min(3000, want)))
    out = await llm.complete(
        profile,
        system=system,
        prompt=prompt,
        max_tokens=max_tokens,
        timeout=60.0 * (3 if profile.connection == "local" else 1),
        on_delta=on_delta,
    )
    cut = out.stop_reason == "max_tokens"
    if kind == "list":
        value, complete = prompts.parse_json(out.text)
        items = _items(value)
        if not items:
            raise AssistError(
                "invalid_output", "The draft did not come back in a usable form."
            )
        result = {"kind": "list", "items": items, "cut_short": cut or not complete}
    elif kind == "diagram":
        value, _ = prompts.parse_json(out.text)
        dg = _diagram(value)
        if dg is None:
            raise AssistError(
                "invalid_output", "The diagram did not come back in a usable form."
            )
        result = {"kind": "diagram", "diagram": dg, "cut_short": False}
    else:
        text = (
            req.continue_from + _unfence(out.text)
            if req.continue_from
            else _unfence(out.text)
        )
        if not text.strip():
            raise AssistError("invalid_output", "The draft came back empty.")
        shape = kind
        if action == "ask" and not req.selection.strip():
            shape = "insert"
        result = {"kind": shape, "text": text, "cut_short": cut}
    return {"result": result}, out, out.text


async def continue_draft(session: AsyncSession, draft_id: str, person: str) -> AiDraft:
    """ "Continue" on a draft cut short: the model goes on from where it stopped and the draft keeps what it had."""
    d = await svc_drafts._get(session, draft_id)
    if d.kind not in KINDS or d.owner != person:
        raise AssistError("not_found", "Draft not found.")
    payload = loads(d.payload, {})
    res = payload.get("result") or {}
    if d.status != "open" or not res.get("cut_short") or res.get("kind") == "list":
        raise AssistError("invalid", "Only a draft that was cut short can continue.")
    await svc_settings.guard_request(
        session,
        d.project_id,
        "docs" if d.kind == "editor_doc" else "drafting",
        person=person,
        member_id=d.member_id,
        require_member=True,
    )
    inp = dict(payload.get("input") or {})
    inp["continue_from"] = res.get("text") or ""
    d.payload = json.dumps({"input": inp})
    d.status = "pending"
    session.add(d)
    await session.commit()
    await session.refresh(d)
    svc_drafts._spawn(d.id)
    await svc_drafts._publish()
    return d


async def accept(
    session: AsyncSession, draft_id: str, person: str, body: dict | None = None
) -> dict:
    """The person accepted a draft (the editor already put the text in, as one undoable step). This records it:
    Activity says "edited with AI by <person>", the audit log gets an entry, and a list of criteria is added to the
    ticket as that person. Returns what was recorded."""
    body = body or {}
    d = await svc_drafts._get(session, draft_id)
    if d.kind not in KINDS or d.owner != person:
        raise AssistError("not_found", "Draft not found.")
    if d.status != "open":
        raise AssistError("invalid", f"This draft is {d.status}.")
    from .drafts import role_of

    if await role_of(session, d.project_id, person) == "viewer":
        raise AssistError(
            "viewer", "Only members can edit with the AI. You can still read."
        )
    payload = loads(d.payload, {})
    res = payload.get("result") or {}
    inp = payload.get("input") or {}
    surface = inp.get("surface") or ""
    out: dict = {"surface": surface, "action": inp.get("action")}
    ticket_id = d.ticket_id
    if res.get("kind") == "list":
        if not ticket_id:
            raise AssistError("invalid", "Acceptance criteria belong to a ticket.")
        items = body.get("items")
        picked = (
            [str(x).strip() for x in items if str(x).strip()]
            if items is not None
            else list(res.get("items") or [])
        )
        if not picked:
            raise AssistError("invalid", "Pick at least one criterion.")
        ids: list[str] = []
        with svc_drafts._As(person, d.member_name):
            for text in picked:
                t = await svc_tickets.add_acceptance_criterion(session, ticket_id, text)
                if t is not None:
                    ids.append(loads(t.acceptance_criteria, [])[-1]["id"])
        out["created"] = ids
    elif ticket_id and surface in TICKET_SURFACES:
        t = await session.get(Ticket, ticket_id)
        if t is not None:
            what = SURFACES[surface]["label"].lower()
            with svc_drafts._As(person, d.member_name):
                act.record(t, "ai_edit", None, what, actor=person)
            session.add(t)
            await session.commit()
        out["ticket_id"] = ticket_id
    elif surface == "idea" and inp.get("idea_id"):
        from services import idea_tickets

        idea = await session.get(IdeaTicket, inp["idea_id"])
        if idea is not None:
            idea_tickets.add_trail(
                idea,
                f"Page edited with AI by {person}",
                now_iso(),
                person,
                kind="page",
                ai=True,
            )
            session.add(idea)
            await session.commit()
        out["idea_id"] = inp["idea_id"]
    d.status = "applied"
    d.applied_at = now_iso()
    d.applied_by = person
    d.result = json.dumps(out)
    session.add(d)
    await session.commit()
    await session.refresh(d)
    await audit.record(
        d.project_id,
        "editor_help",
        "allowed",
        member_id=d.member_id,
        member_name=d.member_name,
        on_behalf_of=person,
        target=ticket_id or d.doc_id or inp.get("idea_id"),
        detail={
            "surface": surface,
            "action": inp.get("action"),
            "kind": res.get("kind"),
            "chars": len(res.get("text") or ""),
            "cost": d.cost,
        },
    )
    await svc_drafts._publish()
    return {"draft": svc_drafts.describe(d), **out}
