"""AI in the Sketch tool (docs/specs/sketch-tool.md, "AI help"; rules of docs/specs/ai-where-you-work.md).

One conversation per person and sketch, on the scoped-chat engine (`sketch_scope.py`). The model sees the earlier turns,
the CURRENT flattened picture of the canvas (uploaded with every message), the pictures and files the person attached, and
the text of the ticket, page or idea the sketch is in (fenced as untrusted data). It answers in words and, when asked to
draw, also with a proposal: a small list of vector **ops** (line, arrow, rect, ellipse, text, freehand path) that this
module checks and clamps (`clean_ops`). The editor shows the proposal as a preview and draws it on a NEW layer named
"AI" as one undoable step when the person accepts. The model never writes pixels and never touches the person's layers.

This module holds what does not depend on the chat engine: the ops format, the access rules (`book`, `guard`), the
state of the panel, "What will be sent", and the recording of an accepted proposal.
"""

import json
import math
import re

from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiDraft, AiMember, Sketch

from .. import audit
from ..store import loads, now_iso
from . import cost, idea_scope, scopes
from . import drafts as svc_drafts
from . import settings as svc_settings
from .settings import AssistError

KIND = "sketch"
SWITCH = "sketch"  # the feature switch (Settings → AI); usage is booked as sketch_chat / sketch_draw
OWNER_KINDS = ("idea", "ticket", "doc", "comment")

MAX_OPS = 60
MAX_POINTS = 120
MAX_TEXT = 120
MAX_TEXT_LINES = 3
MAX_STROKE = 60
MIN_FONT, MAX_FONT = 8, 120
MAX_SIDE = 4096
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_PROMPT = 4000
MAX_TITLE = 200
MAX_IDEAS = 8
DEFAULT_COLOUR = "#2b2b2b"
LAYER_NAME = "AI"

_HEX = re.compile(r"^#([0-9a-fA-F]{6})$")
_HEX3 = re.compile(r"^#([0-9a-fA-F]{3})$")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_TAGS = re.compile(r"<[^>]{0,200}>")
_SCRIPTY = re.compile(
    r"<\s*/?\s*script|javascript\s*:|data\s*:\s*text/html|on\w+\s*=", re.I
)

# What the editor receives is exactly these shapes; nothing else the model wrote survives.
OP_KINDS = ("line", "arrow", "rect", "ellipse", "text", "path")


# --------------------------------------------------------------------------- ops


def _num(value, lo: float, hi: float) -> int | None:
    """A finite number clamped into [lo, hi] and rounded; None for anything that is not a plain number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return int(round(min(hi, max(lo, value))))


def _colour(value) -> str:
    """`#rrggbb` (lower case); `#rgb` is expanded; anything else becomes the default dark grey."""
    text = str(value or "").strip()
    if _HEX.match(text):
        return text.lower()
    m = _HEX3.match(text)
    if m:
        return "#" + "".join(c * 2 for c in m.group(1)).lower()
    return DEFAULT_COLOUR


def _text(value) -> str | None:
    """Label text for the canvas: control characters and tags removed, 3 lines of 120 characters at most. None when
    nothing is left or it contains script (the op is then dropped)."""
    raw = str(value or "")
    if _SCRIPTY.search(raw):
        return None
    lines = [
        " ".join(_TAGS.sub("", _CONTROL.sub("", ln)).split())
        for ln in raw.replace("\r", "").split("\n")
    ]
    lines = [ln for ln in lines if ln][:MAX_TEXT_LINES]
    out = "\n".join(lines)[:MAX_TEXT].strip()
    return out or None


def clean_op(raw, width: int, height: int) -> dict | None:
    """One op as the model wrote it, checked and clamped to the canvas; None when it cannot be drawn.

    Shapes the editor draws (coordinates are integers inside ``0..width`` and ``0..height``, ``color`` is `#rrggbb`,
    ``size`` is the stroke width 1 to 60, or the font size 8 to 120 for text):

    * ``line`` / ``arrow``: ``x1 y1 x2 y2`` (``arrow`` is a line with an arrow head: ``arrow: true``)
    * ``rect`` / ``ellipse``: ``x y w h`` (or the corners ``x1 y1 x2 y2``), ``fill`` true for a solid shape
    * ``text``: ``x y text`` (``bold`` optional)
    * ``path``: ``points`` ``[[x, y], ...]`` (2 to 120 points; a freehand polyline), ``closed`` optional
    """
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("op") or raw.get("type") or "").lower()
    if kind not in OP_KINDS:
        return None
    w, h = max(1, width), max(1, height)
    colour = _colour(raw.get("color") or raw.get("colour") or raw.get("stroke"))
    size = _num(raw.get("size", raw.get("width", 4)), 1, MAX_STROKE) or 4
    if kind in ("line", "arrow"):
        x1, y1 = _num(raw.get("x1"), 0, w), _num(raw.get("y1"), 0, h)
        x2, y2 = _num(raw.get("x2"), 0, w), _num(raw.get("y2"), 0, h)
        if None in (x1, y1, x2, y2) or (x1, y1) == (x2, y2):
            return None
        return {
            "op": "line",
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "color": colour,
            "size": size,
            "arrow": kind == "arrow" or raw.get("arrow") is True,
        }
    if kind in ("rect", "ellipse"):
        if raw.get("w") is not None or raw.get("width") is not None:
            x, y = _num(raw.get("x"), 0, w), _num(raw.get("y"), 0, h)
            bw = _num(raw.get("w", raw.get("width")), 0, w)
            bh = _num(raw.get("h", raw.get("height")), 0, h)
            if None in (x, y, bw, bh):
                return None
            x2, y2 = min(w, x + bw), min(h, y + bh)
        else:
            x, y = (
                _num(raw.get("x1", raw.get("x")), 0, w),
                _num(raw.get("y1", raw.get("y")), 0, h),
            )
            x2, y2 = _num(raw.get("x2"), 0, w), _num(raw.get("y2"), 0, h)
            if None in (x, y, x2, y2):
                return None
        x, y, x2, y2 = min(x, x2), min(y, y2), max(x, x2), max(y, y2)
        if x2 - x < 1 or y2 - y < 1:
            return None
        return {
            "op": kind,
            "x": x,
            "y": y,
            "w": x2 - x,
            "h": y2 - y,
            "color": colour,
            "size": size,
            "fill": raw.get("fill") is True,
        }
    if kind == "text":
        text = _text(raw.get("text"))
        x, y = _num(raw.get("x"), 0, w), _num(raw.get("y"), 0, h)
        if text is None or x is None or y is None:
            return None
        font = _num(raw.get("size", 28), MIN_FONT, MAX_FONT) or 28
        return {
            "op": "text",
            "x": x,
            "y": y,
            "text": text,
            "color": colour,
            "size": font,
            "bold": raw.get("bold") is True,
        }
    pts = raw.get("points")
    if not isinstance(pts, list):
        return None
    points: list[list[int]] = []
    for p in pts[:MAX_POINTS]:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            px, py = _num(p[0], 0, w), _num(p[1], 0, h)
        elif isinstance(p, dict):
            px, py = _num(p.get("x"), 0, w), _num(p.get("y"), 0, h)
        else:
            continue
        if px is not None and py is not None and (not points or points[-1] != [px, py]):
            points.append([px, py])
    if len(points) < 2:
        return None
    return {
        "op": "path",
        "points": points,
        "color": colour,
        "size": size,
        "closed": raw.get("closed") is True,
    }


def clean_ops(raw, width: int, height: int) -> tuple[list[dict], int]:
    """The list of ops the model wrote, validated and clamped.

    Args:
        raw: The ``ops`` value of the model's JSON (anything else yields nothing).
        width: Canvas width in px.
        height: Canvas height in px.

    Returns:
        ``(ops, dropped)``: at most 60 valid ops, and how many the model wrote that were dropped (invalid, unknown,
        script text, or over the limit).
    """
    if not isinstance(raw, list):
        return [], 0
    ops: list[dict] = []
    for item in raw:
        op = clean_op(item, width, height)
        if op is not None and len(ops) < MAX_OPS:
            ops.append(op)
    return ops, len(raw) - len(ops)


# --------------------------------------------------------------------------- access


def image_tokens(width: int, height: int) -> int:
    """About how many tokens a picture costs (providers scale a picture to about 1,600 tokens at most)."""
    return max(85, min(1600, math.ceil(width * height / 750)))


async def book(
    session: AsyncSession,
    owner_kind: str,
    owner_id: str,
    person: str,
    *,
    project_id: str | None = None,
    sketch_id: str | None = None,
    check_idea: bool = True,
) -> tuple[str, Sketch | None]:
    """The project the request is booked on, after the access rules: the person belongs to it (strangers get
    `forbidden`), the sketch (when given) is theirs to look at, and for a sketch in an idea the Idea Space's own switch
    and cap hold (unless ``check_idea`` is False: the chat panel checks them itself, to say why it cannot answer).
    Returns ``(project_id, sketch or None)``."""
    from services import sketches as svc_sketches

    if owner_kind not in OWNER_KINDS or not owner_id:
        raise AssistError("invalid", "Say which ticket, page or idea the sketch is in.")
    sketch = None
    if sketch_id:
        sketch = await session.get(Sketch, sketch_id)
        if (
            sketch is None
            or sketch.deleted_at
            or (sketch.owner_kind, sketch.owner_id) != (owner_kind, owner_id)
        ):
            raise AssistError("not_found", "Sketch not found.")
    hint = (sketch.project_id if sketch else None) or project_id
    try:
        project = await svc_sketches._project_of(session, owner_kind, owner_id, hint)
    except svc_sketches.DocsError as exc:  # an unknown project
        raise AssistError("not_found", "Project not found.") from exc
    idea = None
    if owner_kind == "idea":
        idea = await idea_scope.load(session, owner_id)
        if project is None:
            project, _ = await idea_scope.work_project(session, idea, person)
    if project is None:
        raise AssistError("not_found", "The place this sketch is in was not found.")
    await scopes.ensure_access(session, project, person)
    if idea is not None and check_idea:
        await idea_scope.check_idea_ai(session, idea.project_id)
    return project, sketch


async def guard(
    session: AsyncSession, project_id: str, person: str
) -> tuple[dict, str | None]:
    """The AI member that answers and the board's checks (AI on for the project, members only, feature switch, caps,
    kill switch). Raises `AssistError`."""
    member_id = await svc_settings.resolve_member(session, project_id, None, None)
    info = await svc_settings.guard_request(
        session,
        project_id,
        SWITCH,
        person=person,
        member_id=member_id,
        require_member=True,
    )
    return info, member_id


NEVER_SENT = [
    "Layers and the editable source (only the flattened picture)",
    "Private Docs pages, other sketches, other comments and secrets",
    "Files you did not attach to the message",
]


async def state(session: AsyncSession, data: dict, person: str) -> dict:
    """What the editor shows before anyone asks: whether the person may, who would answer, the limits and the cost of a
    typical message. Sends nothing. A refusal (viewer, AI off, stranger, no AI member...) is returned as
    ``availability`` with its code, never raised, so the editor can hide its AI button."""
    from . import attachments

    availability: dict = {"code": "ok"}
    profile = None
    member_id = None
    try:
        project_id, _ = await book(
            session,
            str(data.get("owner_kind") or ""),
            str(data.get("owner_id") or "").strip(),
            person,
            project_id=data.get("project_id") or None,
            sketch_id=data.get("sketch_id") or None,
        )
        member_id = await svc_settings.resolve_member(session, project_id, None, None)
        got = await svc_settings.guard_request(
            session,
            project_id,
            SWITCH,
            person=person,
            member_id=member_id,
            require_member=True,
        )
        profile = got["profile"]
        availability["member"] = got["member"].name
    except AssistError as exc:
        availability = {"code": exc.code, "message": str(exc), **exc.extra}
        if member_id:
            profile = await session.get(AiMember, member_id)
    typical = 900 + image_tokens(1024, 640)
    estimates = (
        {
            "answer": cost.estimate(profile, typical, "answer"),
            "draw": cost.estimate(profile, typical, "sketch_draw"),
        }
        if profile
        else None
    )
    return {
        "availability": availability,
        "member_id": member_id,
        "estimates": estimates,
        "limits": {
            "max_ops": MAX_OPS,
            "max_points": MAX_POINTS,
            "max_text": MAX_TEXT,
            "max_prompt": MAX_PROMPT,
            "max_image_bytes": MAX_IMAGE_BYTES,
            "attachments": {
                "max_images": attachments.MAX_IMAGES,
                "max_image_bytes": attachments.MAX_IMAGE_BYTES,
                "max_text_files": attachments.MAX_TEXT_FILES,
                "max_text_bytes": attachments.MAX_TEXT_BYTES,
                "image_types": list(attachments.IMAGE_TYPES),
            },
        },
        "never_sent": NEVER_SENT,
    }


# --------------------------------------------------------------------------- accept


def clean_ideas(value) -> list[str]:
    """The ideas of an answer: short single lines, no repeats, at most 8."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for x in value:
        t = " ".join(str(x or "").split())[:140]
        if len(t) >= 3 and t not in out:
            out.append(t)
    return out[:MAX_IDEAS]


async def accept(session: AsyncSession, draft_id: str, person: str) -> dict:
    """The person accepted a drawing proposal (the editor already drew the ops on the AI layer, as one undoable step).
    This records it in the audit log and closes the draft. Returns the draft."""
    d = await _own_draft(session, draft_id, person)
    if d.status != "open":
        raise AssistError("invalid", f"This draft is {d.status}.")
    if await svc_drafts.role_of(session, d.project_id, person) == "viewer":
        raise AssistError(
            "viewer", "Only members can edit with the AI. You can still read."
        )
    payload = loads(d.payload, {})
    res = payload.get("result") or {}
    inp = payload.get("input") or {}
    d.status = "applied"
    d.applied_at = now_iso()
    d.applied_by = person
    d.result = json.dumps({"kind": res.get("kind"), "ops": len(res.get("ops") or [])})
    session.add(d)
    await session.commit()
    await session.refresh(d)
    await audit.record(
        d.project_id,
        "sketch_edit",
        "allowed",
        member_id=d.member_id,
        member_name=d.member_name,
        on_behalf_of=person,
        target=inp.get("sketch_id") or inp.get("owner_id"),
        detail={
            "ops": len(res.get("ops") or []),
            "layer": LAYER_NAME,
            "cost": d.cost,
        },
    )
    await svc_drafts._publish()
    return svc_drafts.describe(d)


async def idea_added(
    session: AsyncSession, draft_id: str, person: str, index: int
) -> dict:
    """The person added idea number ``index`` of an answer as a text label (the editor did it, as one undoable step).
    Remembered on the proposal so the thread shows it as added next time. Not audited: it is the person's own edit."""
    d = await _own_draft(session, draft_id, person)
    if await svc_drafts.role_of(session, d.project_id, person) == "viewer":
        raise AssistError(
            "viewer", "Only members can edit with the AI. You can still read."
        )
    payload = loads(d.payload, {})
    res = payload.get("result") or {}
    ideas = res.get("ideas") or []
    if not isinstance(index, int) or not 0 <= index < len(ideas):
        raise AssistError("invalid", "There is no such idea.")
    added = sorted({*(res.get("added") or []), index})
    res["added"] = added
    payload["result"] = res
    d.payload = json.dumps(payload)
    session.add(d)
    await session.commit()
    await session.refresh(d)
    return svc_drafts.describe(d)


async def _own_draft(session: AsyncSession, draft_id: str, person: str) -> AiDraft:
    d = await svc_drafts._get(session, draft_id)
    if d.kind != KIND or d.owner != person:
        raise AssistError("not_found", "Draft not found.")
    return d
