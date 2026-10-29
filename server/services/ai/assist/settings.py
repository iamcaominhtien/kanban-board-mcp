"""Board AI settings, availability, feature switches, cost limits and per-feature metering
(design/screens/ai-board-assistant.md, H and I)."""

from datetime import datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    AiAssistSettings,
    AiMember,
    AiUsage,
    DocsPage,
    Member,
    Project,
    Ticket,
)

from .. import budget
from ..llm import Completion
from ..store import get_settings, loads, now_iso

FEATURES = {
    "chat": ("Chatbot", "Ask AI dock, ⌘J, answers with sources"),
    "drafting": ("Ticket drafting", "Draft with AI, Improve description"),
    "split": ("Sub-task split", "Split with AI on a parent ticket"),
    "test_cases": ("Test case suggestions", "Suggest cases and coverage gaps"),
    "health": ("Board health and digest", "Daily insights"),
    "docs": ("Docs AI", "Summaries, sections, link suggestions"),
}
DEFAULT_FEATURES = {k: True for k in FEATURES}
DEFAULT_HEALTH = {
    "time": "09:00",
    "days": [0, 1, 2, 3, 4],  # Mon to Fri
    "stuck_days": 3,
    "wip_limit": 3,
    "max_insights": 5,
    "return_if_worse": True,
    "weekend": False,
    "badge_toast": True,
    "offer_draft": True,
}
TONES = ("neutral", "friendly", "concise")
STYLE_GUIDE_MAX = 1000
# Readiness of the Board AI: statuses in which it can answer
READY = ("online", "idle", "running")


class AssistError(Exception):
    """A request the Board AI cannot take; `code` tells the UI which state to show."""

    def __init__(self, code: str, message: str, **extra):
        """Keep the code and any details for the response."""
        super().__init__(message)
        self.code = code
        self.extra = extra


async def get(session: AsyncSession) -> AiAssistSettings:
    """The board-wide assistant settings, created with defaults on first use."""
    row = await session.get(AiAssistSettings, 1)
    if row is None:
        row = AiAssistSettings(id=1)
        session.add(row)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            return await session.get(AiAssistSettings, 1)
        await session.refresh(row)
    return row


def features(row: AiAssistSettings) -> dict[str, bool]:
    """Feature switches with defaults filled in."""
    return {**DEFAULT_FEATURES, **loads(row.features, {})}


def health_config(row: AiAssistSettings) -> dict:
    """Board-health schedule and noise controls with defaults filled in."""
    return {**DEFAULT_HEALTH, **loads(row.health, {})}


def project_shared(row: AiAssistSettings, project_id: str) -> bool:
    """Whether the Board AI may read this project (data scope)."""
    return bool(loads(row.data_scope, {}).get(project_id, True))


def excluded_docs(row: AiAssistSettings) -> set[str]:
    """Docs never sent to the provider (private), unless their owner includes one for a chat."""
    return set(loads(row.excluded_docs, []))


async def _info_for(
    session: AsyncSession, member: Member | None, profile: AiMember | None, settings
) -> dict:
    """{"state": "ready" | "not_configured" | "unavailable", "member", "profile", "status"} for one AI member."""
    from .. import members as svc_members

    if member is None or profile is None or member.kind != "ai":
        return {
            "state": "not_configured",
            "member": None,
            "profile": None,
            "status": None,
        }
    described = await svc_members.describe(session, member, profile, settings)
    status = described["status"]
    ready = status["code"] in READY or (
        status["code"] == "over_budget" and profile.connection == "local"
    )
    if profile.connection == "inbox" or (
        profile.connection == "local" and profile.provider != "claude-code"
    ):
        ready = False
        status = {
            "code": "unsupported",
            "label": "Can't answer questions here",
            "detail": "Only Claude Code and API-key members answer chat and editor requests; "
            "an MCP client or another local runner can be asked in a comment instead.",
        }
    return {
        "state": "ready" if ready else "unavailable",
        "member": member,
        "profile": profile,
        "status": status,
    }


async def board_ai(session: AsyncSession, project_id: str) -> dict:
    """The project's Board AI and whether it can answer now.

    Returns:
        {"state": "ready" | "not_configured" | "unavailable", "member", "profile", "status"}
    """
    settings = await get_settings(session, project_id)
    if not settings.board_ai_id:
        return await _info_for(session, None, None, settings)
    member = await session.get(Member, settings.board_ai_id)
    profile = await session.get(AiMember, settings.board_ai_id)
    return await _info_for(session, member, profile, settings)


async def member_ai(session: AsyncSession, project_id: str, member_id: str) -> dict:
    """Same as `board_ai` for a chosen AI member of the project (the member a chat or ticket asks)."""
    settings = await get_settings(session, project_id)
    member = await session.get(Member, member_id)
    if member is not None and member.project_id != project_id:
        member = None
    profile = await session.get(AiMember, member_id) if member else None
    return await _info_for(session, member, profile, settings)


async def answerers(session: AsyncSession, project_id: str) -> list[dict]:
    """AI members of the project that can answer one-shot requests (Claude Code, API-key), with their state, the
    Board AI first. Used by the chat header's picker and the @ list."""
    settings = await get_settings(session, project_id)
    rows = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    out = []
    for m in rows:
        profile = await session.get(AiMember, m.id)
        info = await _info_for(session, m, profile, settings)
        if (
            info["state"] == "not_configured"
            or (info["status"] or {}).get("code") == "unsupported"
        ):
            continue
        out.append(
            {
                "id": m.id,
                "name": m.name,
                "state": info["state"],
                "status": info["status"],
                "board_ai": m.id == settings.board_ai_id,
                "provider": profile.provider,
                "connection": profile.connection,
                "metered": profile.connection == "api_key",
            }
        )
    out.sort(key=lambda x: (not x["board_ai"], x["state"] != "ready", x["name"]))
    return out


async def month_spend(session: AsyncSession, feature: str | None = None) -> float:
    """Board AI spend this month (all projects), optionally for one feature."""
    stmt = select(func.coalesce(func.sum(AiUsage.cost), 0.0)).where(
        col(AiUsage.created_at) >= budget.month_start().isoformat()
    )
    if feature:
        stmt = stmt.where(AiUsage.feature == feature)
    return float((await session.exec(stmt)).one() or 0.0)


def next_month_label() -> str:
    """'Nov 1': when a monthly cap resets."""
    now = datetime.now().astimezone()
    first = (now.replace(day=1) + timedelta(days=32)).replace(day=1)
    return f"{first:%b} {first.day}"  # not strftime with a dash flag: Windows does not know it


async def resolve_member(
    session: AsyncSession,
    project_id: str,
    requested: str | None = None,
    prefer: str | None = None,
) -> str | None:
    """The AI member a chat or editor request goes to: the one asked for, else `prefer` (a ticket's AI assignee),
    else the Board AI, else the first AI member that can answer. None when the project has no AI member that can."""
    cands = await answerers(session, project_id)
    for want in (requested, prefer):
        if want and any(a["id"] == want and a["state"] == "ready" for a in cands):
            return want
    if requested and any(a["id"] == requested for a in cands):
        return requested  # not available now: the guard says why
    return cands[0]["id"] if cands else None


async def guard_request(
    session: AsyncSession,
    project_id: str,
    feature: str,
    *,
    person: str | None = None,
    member_id: str | None = None,
    require_member: bool = False,
) -> dict:
    """Everything that must hold before an AI member is called for a one-shot request: AI is on for the project,
    the feature is on, the member (the Board AI, or `member_id`) answers, no cap is reached, the project is shared.
    With `require_member` a viewer is refused. Returns the `board_ai`-style info; raises `AssistError`."""
    row = await get(session)
    project_settings = await get_settings(session, project_id)
    if not project_settings.ai_enabled:
        raise AssistError(
            "ai_off",
            "AI is turned off for this project (Settings → AI). Nothing was sent.",
        )
    if require_member and person:
        from .drafts import role_of

        if await role_of(session, project_id, person) == "viewer":
            raise AssistError(
                "viewer",
                "Only members can ask the AI. You can still read answers posted on this ticket.",
            )
    if not features(row).get(feature, True):
        label = FEATURES.get(feature, (feature,))[0]
        raise AssistError(
            "feature_off",
            f"{label} is turned off for this board. Turned off in Settings → AI; other features keep working.",
        )
    if not project_shared(row, project_id):
        raise AssistError(
            "not_shared",
            "This project is not shared with the Board AI (Settings → AI · data scope).",
        )
    info = (
        await member_ai(session, project_id, member_id)
        if member_id
        else await board_ai(session, project_id)
    )
    if info["state"] == "not_configured":
        raise AssistError(
            "not_configured",
            "Board AI isn't set up. Pick the AI that answers board-wide questions in Settings → AI.",
        )
    if (
        row.monthly_cap is not None
        and row.over_cap == "pause"
        and info["profile"].connection == "api_key"
    ):
        spent = await month_spend(session)
        if spent >= row.monthly_cap:
            raise AssistError(
                "over_budget",
                f"Monthly cap reached · ${spent:.2f} of ${row.monthly_cap:.2f}",
                spent=round(spent, 4),
                cap=row.monthly_cap,
                resets=next_month_label(),
            )
    if info["state"] == "unavailable":
        st = info["status"] or {}
        if st.get("code") == "over_budget":
            raise AssistError(
                "over_budget",
                f"{info['member'].name} is over budget. AI is paused until tomorrow.",
                daily=True,
                detail=st.get("detail"),
                resets="tomorrow",
                status=st,
                member_id=info["member"].id,
            )
        raise AssistError(
            "unavailable",
            f"{info['member'].name}: {st.get('label', 'unavailable')}.",
            status=st,
            member_id=info["member"].id,
        )
    return info


def max_tokens_for(row: AiAssistSettings, profile: AiMember, default: int) -> int:
    """Output tokens allowed by the per-request cap (API-key members; a local runner is not metered)."""
    from ..providers import price_for

    if row.per_request_cap is None or profile.connection != "api_key":
        return default
    _, out_price = price_for(profile.model)
    if out_price <= 0:
        return default
    allowed = int(row.per_request_cap / out_price * 1_000_000 * 0.8)
    return max(256, min(default, allowed))


async def record_usage(
    session: AsyncSession,
    project_id: str,
    feature: str,
    member_id: str | None,
    person: str | None,
    out: Completion,
) -> AiUsage:
    """Meter one call (cost counts toward the Board AI's monthly cap)."""
    row = AiUsage(
        project_id=project_id,
        feature=feature,
        member_id=member_id,
        person=person,
        cost=out.cost,
        tokens_in=out.tokens_in,
        tokens_out=out.tokens_out,
        metered=out.metered,
        created_at=now_iso(),
    )
    session.add(row)
    profile = await session.get(AiMember, member_id) if member_id else None
    if profile is not None:
        profile.last_call_at = row.created_at  # "Last call 2 min ago" on its row
        session.add(profile)
    await session.commit()
    return row


async def describe(session: AsyncSession, project_id: str) -> dict:
    """Settings → AI for the UI: Board AI, features with cost this month, language and style, data scope,
    excluded docs, limits and usage."""
    row = await get(session)
    info = await board_ai(session, project_id)
    feats = features(row)
    costs = {}
    for key in FEATURES:
        costs[key] = round(await month_spend(session, key), 4)
    projects = (await session.exec(select(Project))).all()
    scope = []
    excluded = excluded_docs(row)
    for p in projects:
        docs = (
            await session.exec(
                select(func.count()).where(
                    DocsPage.project_id == p.id, col(DocsPage.deleted_at).is_(None)
                )
            )
        ).one()
        shared_docs = (
            await session.exec(
                select(func.count()).where(
                    DocsPage.project_id == p.id,
                    col(DocsPage.deleted_at).is_(None),
                    col(DocsPage.id).not_in(list(excluded) or [""]),
                )
            )
        ).one()
        scope.append(
            {
                "project_id": p.id,
                "name": p.name,
                "shared": project_shared(row, p.id),
                "docs": int(docs or 0),
                "shared_docs": int(shared_docs or 0),
            }
        )
    excl = []
    if excluded:
        pages = (
            await session.exec(
                select(DocsPage).where(col(DocsPage.id).in_(list(excluded)))
            )
        ).all()
        excl = [
            {"id": d.id, "title": d.title, "project_id": d.project_id} for d in pages
        ]
    used = await month_spend(session)
    member = info["member"]
    profile = info["profile"]
    provider_label = None
    if profile is not None:
        from ..providers import PROVIDERS

        provider_label = PROVIDERS.get(profile.provider, {}).get(
            "label", profile.provider
        )
    return {
        "board_ai": {
            "state": info["state"],
            "id": member.id if member else None,
            "name": member.name if member else None,
            "provider": profile.provider if profile else None,
            "provider_label": provider_label,
            "connection": profile.connection if profile else None,
            "metered": bool(profile and profile.connection == "api_key"),
            "status": info["status"],
        },
        "features": [
            {
                "key": k,
                "label": FEATURES[k][0],
                "description": FEATURES[k][1],
                "on": feats[k],
                "cost_month": costs[k],
            }
            for k in FEATURES
        ],
        "language": row.language,
        "tone": row.tone,
        "style_guide": row.style_guide,
        "style_guide_max": STYLE_GUIDE_MAX,
        "data_scope": scope,
        "excluded_docs": excl,
        "monthly_cap": row.monthly_cap,
        "per_request_cap": row.per_request_cap,
        "over_cap": row.over_cap,
        "used_month": round(used, 4),
        "resets": next_month_label(),
        "health": health_config(row),
        "sent": {
            "ticket_text": True,
            "comments": True,
            "docs": True,
            "secrets": False,
            "attachments": False,
            "private_docs": False,
        },
    }


async def update(session: AsyncSession, data: dict) -> AiAssistSettings:
    """Change the board-wide settings (validated)."""
    import json

    row = await get(session)
    if "features" in data and data["features"] is not None:
        feats = features(row)
        for k, v in data["features"].items():
            if k not in FEATURES:
                raise AssistError("invalid", f"Unknown feature: {k}")
            feats[k] = bool(v)
        row.features = json.dumps(feats)
    if data.get("tone") is not None:
        if data["tone"] not in TONES:
            raise AssistError("invalid", "Tone: Neutral, Friendly or Concise.")
        row.tone = data["tone"]
    if data.get("language") is not None:
        lang = " ".join(str(data["language"]).split())[:40]
        if not lang:
            raise AssistError("invalid", "Pick a language.")
        row.language = lang
    if data.get("style_guide") is not None:
        text = str(data["style_guide"])
        if len(text) > STYLE_GUIDE_MAX:
            raise AssistError(
                "invalid", f"Style guide: at most {STYLE_GUIDE_MAX} characters."
            )
        row.style_guide = text
    for key in ("monthly_cap", "per_request_cap"):
        if key in data:
            v = data[key]
            if v is not None and (not isinstance(v, int | float) or v < 0):
                raise AssistError(
                    "invalid", "Caps are amounts of 0 or more (empty: no cap)."
                )
            setattr(row, key, v)
    if (
        row.monthly_cap is not None
        and row.per_request_cap is not None
        and row.per_request_cap > row.monthly_cap
    ):
        raise AssistError(
            "invalid", "The per-request cap cannot be above the monthly cap."
        )
    if data.get("over_cap") is not None:
        if data["over_cap"] not in ("pause", "warn"):
            raise AssistError("invalid", "Over the cap: pause or warn.")
        row.over_cap = data["over_cap"]
    if data.get("data_scope") is not None:
        scope = loads(row.data_scope, {})
        items = data["data_scope"]
        # A list of {project_id, shared} (UUID keys would not survive the UI's key case conversion) or a dict
        pairs = (
            [
                (x.get("project_id"), x.get("shared"))
                for x in items
                if isinstance(x, dict)
            ]
            if isinstance(items, list)
            else list(items.items())
        )
        for pid, shared in pairs:
            if pid:
                scope[str(pid)] = bool(shared)
        row.data_scope = json.dumps(scope)
    if data.get("excluded_docs") is not None:
        row.excluded_docs = json.dumps(sorted({str(x) for x in data["excluded_docs"]}))
    if data.get("health") is not None:
        cfg = health_config(row)
        h = data["health"]
        if "time" in h:
            try:
                datetime.strptime(str(h["time"]), "%H:%M")
            except ValueError as exc:
                raise AssistError("invalid", "Time as HH:MM, e.g. 09:00.") from exc
            cfg["time"] = str(h["time"])
        if "days" in h:
            days = sorted({int(d) for d in h["days"] if 0 <= int(d) <= 6})
            if not days:
                raise AssistError("invalid", "Pick at least one day.")
            cfg["days"] = days
        for key, lo, hi in (
            ("stuck_days", 1, 60),
            ("wip_limit", 1, 20),
            ("max_insights", 1, 20),
        ):
            if key in h:
                v = int(h[key])
                if not lo <= v <= hi:
                    raise AssistError(
                        "invalid",
                        f"{key.replace('_', ' ').capitalize()}: {lo} to {hi}.",
                    )
                cfg[key] = v
        for key in ("return_if_worse", "weekend", "badge_toast", "offer_draft"):
            if key in h:
                cfg[key] = bool(h[key])
        row.health = json.dumps(cfg)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def ticket_count(session: AsyncSession, project_id: str) -> int:
    """Tickets in a project (the empty-board state)."""
    return int(
        (
            await session.exec(
                select(func.count()).where(Ticket.project_id == project_id)
            )
        ).one()
        or 0
    )
