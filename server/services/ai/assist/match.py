"""Local similarity (no embeddings service): duplicate check for ticket drafts and the suggested assignee with its
reasons (design/screens/ai-board-assistant.md, C1 and C5). Scores are TF-IDF cosine over ticket words."""

import math
import re
from collections import Counter
from datetime import UTC, datetime, timedelta

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiMember, Member, Ticket

from ..context import STATUS_LABELS

_STOP = set(
    """a an the and or of to in on for with by at from as is are be was were it its this that these those into
    up out so if then than when while we you they i our your their can could should would will shall may might
    not no yes do does did done make made let lets via per all any each new add use using get set""".split()
)
MIN_MATCH = 0.35


def words(text: str) -> list[str]:
    """Normalised words of a text (lower case, light stemming, stop words out)."""
    out = []
    for w in re.findall(r"[a-zA-Z0-9]+", (text or "").lower()):
        if len(w) < 3 or w in _STOP:
            continue
        for suf in ("ing", "ed", "es", "s"):
            if len(w) > 4 and w.endswith(suf):
                w = w[: -len(suf)]
                break
        out.append(w)
    return out


def _doc(t: Ticket) -> list[str]:
    return words(t.title) * 2 + words((t.description or "")[:600])


def _vectors(docs: list[list[str]]) -> list[dict[str, float]]:
    n = len(docs)
    df: Counter = Counter()
    for d in docs:
        df.update(set(d))
    out = []
    for d in docs:
        tf = Counter(d)
        vec = {
            w: (c / max(1, len(d))) * math.log((1 + n) / (1 + df[w]) + 1)
            for w, c in tf.items()
        }
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        out.append({w: v / norm for w, v in vec.items()})
    return out


def _cos(a: dict[str, float], b: dict[str, float]) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(v * b.get(w, 0.0) for w, v in a.items())


async def similar(
    session: AsyncSession,
    project_id: str,
    text: str,
    *,
    limit: int = 3,
    exclude: str | None = None,
) -> list[dict]:
    """Tickets that look like `text`, best first, with a match % and the shared words ("Why these?")."""
    tickets = [
        t
        for t in (
            await session.exec(select(Ticket).where(Ticket.project_id == project_id))
        ).all()
        if t.id != exclude and t.status != "wont_do"
    ]
    if not tickets or not words(text):
        return []
    query = words(text) * 2
    vecs = _vectors([_doc(t) for t in tickets] + [query])
    q = vecs[-1]
    scored = sorted(
        ((_cos(q, v), t) for v, t in zip(vecs[:-1], tickets)),
        key=lambda p: p[0],
        reverse=True,
    )
    out = []
    qset = set(query)
    for score, t in scored[:limit]:
        if score < MIN_MATCH:
            break
        shared = sorted(qset & set(_doc(t)))
        out.append(
            {
                "id": t.id,
                "title": t.title,
                "status": t.status,
                "status_label": STATUS_LABELS.get(t.status, t.status),
                "match": min(99, round(score * 100)),
                "why": shared[:6],
            }
        )
    return out


async def suggest_assignee(
    session: AsyncSession,
    project_id: str,
    text: str,
    *,
    exclude_ticket: str | None = None,
) -> list[dict]:
    """People (best match first) and AI members that fit, each with reasons; nothing is assigned here."""
    from ..store import get_settings

    members = (
        await session.exec(select(Member).where(Member.project_id == project_id))
    ).all()
    tickets = (
        await session.exec(select(Ticket).where(Ticket.project_id == project_id))
    ).all()
    month_ago = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    q = set(words(text))
    out = []
    for m in members:
        if m.kind != "human":
            continue
        mine = [t for t in tickets if t.assignee == m.id and t.id != exclude_ticket]
        open_ = [t for t in mine if t.status not in ("done", "wont_do")]
        closed_recent = [
            t for t in mine if t.status == "done" and (t.updated_at or "") >= month_ago
        ]
        alike = [t for t in closed_recent if q & set(_doc(t))]
        score = len(alike) * 3 + len(closed_recent) * 0.5 - len(open_) * 1.2
        reasons = []
        if alike:
            reasons.append(
                f"Closed {len(alike)} similar ticket{'s' if len(alike) != 1 else ''} this month"
                f" ({', '.join(t.id for t in alike[:3])})."
            )
        elif closed_recent:
            reasons.append(
                f"Closed {len(closed_recent)} ticket{'s' if len(closed_recent) != 1 else ''} this month."
            )
        reasons.append(
            f"{len(open_)} open ticket{'s' if len(open_) != 1 else ''}"
            + (", so there is room." if len(open_) <= 2 else ".")
        )
        out.append(
            {
                "member_id": m.id,
                "name": m.name,
                "color": m.color,
                "kind": "human",
                "score": round(score, 2),
                "reasons": " ".join(reasons),
                "open": len(open_),
            }
        )
    out.sort(key=lambda r: r["score"], reverse=True)
    if out:
        out[0]["best"] = True
    settings = await get_settings(session, project_id)
    for m in members:
        if m.kind != "ai":
            continue
        profile = await session.get(AiMember, m.id)
        if (
            profile is None
            or profile.connection == "inbox"
            or profile.paused
            or settings.paused_all
        ):
            continue
        if profile.health in (
            "key_invalid",
            "not_logged_in",
            "runner_missing",
            "model_retired",
        ):
            continue
        where = profile.working_dir or "its project"
        out.append(
            {
                "member_id": m.id,
                "name": m.name,
                "color": m.color,
                "kind": "ai",
                "provider": profile.provider,
                "score": 0,
                "reasons": (
                    f"Works in {where}. Runs only if you press Start after assigning; it moves tickets up to "
                    f"{STATUS_LABELS.get(profile.ceiling, profile.ceiling)}."
                ),
                "online": True,
            }
        )
    return out
