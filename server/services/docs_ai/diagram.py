"""Draw a diagram (`/ai` > Draw a diagram): the AI member draws the section or selection as an editable draw.io
diagram, or changes a diagram the page already shows.

The model answers with draw.io XML; the server checks it is well-formed, can be drawn and is small enough before
anything is saved, then saves it as a diagram of the project (version 1, or a new version of the one being changed). The
page itself is not touched: the person puts the diagram in their draft with the `[name](diagram:dg_xxx)` line the job
returns, and every earlier version stays in the diagram's history.
"""

import re
from typing import Any

import database
from services import activity
from services import diagram_model
from services import diagrams as svc_diagrams
from services.docs_text import DocsError

from . import engine, jobs
from .errors import DocsAiError
from .reader import READ_BUDGET, cost_of, job_input, load_page, read_slice, start_system

MAX_SELECTION = 8000
MAX_INSTRUCTION = 1000
_XML = re.compile(r"<mxfile\b.*?</mxfile>|<mxGraphModel\b.*?</mxGraphModel>", re.DOTALL)

RULES = (
    "You draw diagrams as draw.io XML. Reply with ONE <mxGraphModel> element and nothing else: no explanation, no "
    "code fence. Use only what the text says; do not invent steps or systems.\n"
    'Format: <mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/> then one <mxCell id="n" '
    'value="label" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x=".." '
    'y=".." width="140" height="50" as="geometry"/></mxCell> for each box, and <mxCell id="n" value="" '
    'style="endArrow=classic;html=1;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" '
    'as="geometry"/></mxCell> for each arrow. Give every box an explicit x, y, width and height, laid out left to '
    "right or top to bottom with at least 60 px between boxes, and short labels (under 6 words). At most 25 boxes."
)


def extract_source(text: str) -> str | None:
    """The draw.io XML in a model reply (it may be wrapped in a code fence or prose), or None."""
    m = _XML.search(text or "")
    return m.group(0).strip() if m else None


def drawable(source: str) -> str | None:
    """Why this XML cannot be saved as a diagram (None when it can)."""
    try:
        if svc_diagrams.is_empty(svc_diagrams.validate_source(source)):
            return "it has no boxes"
        diagram_model.render_svg(source)
    except DocsError as exc:
        return str(exc)
    return None


def build_prompt(text: str, instruction: str, current: str | None) -> str:
    """The fenced prompt: the text to draw (and the diagram to change), then the request."""
    parts = [engine.fenced("text to draw", text)]
    if current:
        parts.append(
            "The diagram to change (draw.io XML, data):\n"
            + engine.fenced("current diagram", current)
        )
    parts.append(
        (
            "Change the diagram as asked and reply with the whole new diagram."
            if current
            else "Draw this text as a diagram."
        )
        + (
            "\nThe person asks:\n" + engine.fenced("request", instruction)
            if instruction
            else ""
        )
    )
    return "\n\n".join(parts)


@jobs.handler("diagram")
async def diagram_job(job: Any) -> dict[str, Any]:
    """Draw (or change) a diagram. Result: `{diagram_id, label, version, markdown, changed, cost, metered}`."""
    token = activity.set_actor(job.started_by)
    try:
        return await _draw(job)
    finally:
        activity.reset_actor(token)


async def _draw(job: Any) -> dict[str, Any]:
    inp = job_input(job)
    await jobs.update(job.id, result={})
    selection = (inp.get("selection") or "").strip()[:MAX_SELECTION]
    instruction = (inp.get("request") or "").strip()[:MAX_INSTRUCTION]
    async with database.async_session() as session:
        page, text = await load_page(session, job.page_id, markdown=inp.get("markdown"))
        current, base_version, diagram = None, None, None
        if inp.get("diagram_id"):
            diagram = await svc_diagrams.get_diagram(
                session, inp["diagram_id"], include_source=True
            )
            if diagram["project_id"] != page.project_id:
                raise DocsAiError("invalid", "That diagram belongs to another project.")
            current, base_version = diagram["source"], diagram["version"]
    body = selection or read_slice(text, READ_BUDGET)[0]
    if not body.strip() and not current:
        raise DocsAiError("invalid", "There is nothing on this page to draw yet.")
    await jobs.set_reads(
        job.id,
        [
            {
                "page_id": page.id,
                "title": page.title,
                "why": "this section" if selection else "this page",
            }
        ],
    )
    who, system = await start_system(job.project_id, RULES)
    out = await engine.call(
        job.project_id,
        system=system,
        prompt=build_prompt(body, instruction, current),
        who=who,
        job_id=job.id,
        person=job.started_by,
        max_tokens=4000,
        timeout=120,
    )
    source = extract_source(out.text)
    why = drawable(source) if source else "the reply had no diagram in it"
    if why:
        raise DocsAiError(
            "invalid",
            f"The AI did not return a diagram that can be drawn ({why}). Try again, or say what the boxes should be.",
        )
    try:
        async with database.async_session() as session:
            svg, kind = await svc_diagrams._preview(session, source, None)  # noqa: SLF001
            if diagram is not None:
                saved = await svc_diagrams.update_diagram(
                    session,
                    diagram["id"],
                    base_version=base_version,
                    source=source,
                    svg=svg,
                    note=f"Changed by {who.member.name}: {instruction or 'redrawn'}"[
                        :200
                    ],
                    preview_kind=kind,
                )
            else:
                label = (inp.get("label") or page.title).strip()[:80] or "Diagram"
                saved = await svc_diagrams.create_diagram(
                    session,
                    page.project_id,
                    label=label,
                    source=source,
                    svg=svg,
                    summary=f"Drawn by {who.member.name} from “{page.title}”",
                    item_kind="doc",
                    item_id=page.id,
                    preview_kind=kind,
                )
    except DocsError as exc:
        raise DocsAiError("invalid", str(exc)) from exc
    return {
        "diagram_id": saved["id"],
        "label": saved["label"],
        "version": saved["version"],
        "markdown": f"[{saved['label']}](diagram:{saved['id']})",
        "changed": diagram is not None,
        "preview": kind,
        **cost_of(out),
    }
