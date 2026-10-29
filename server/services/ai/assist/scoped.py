"""State of the chat panel for one thing (a ticket, a page, an idea…): what it reads, who answers, whether the
person may ask, what an answer or a run would cost (design/screens/ai-where-you-work.md, B and E)."""

from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiChat, Ticket

from . import chat as svc_chat
from . import cost, scopes
from . import settings as svc_settings
from .settings import AssistError


def _member_card(a: dict) -> dict:
    """The answerer as the panel shows it: name, a status word, whether it is metered."""
    st = a["status"] or {}
    word = (
        "online"
        if a["state"] == "ready"
        else (st.get("label") or "unavailable").lower()
    )
    where = "Local runner" if a["connection"] == "local" else "API"
    return {
        "id": a["id"],
        "name": a["name"],
        "board_ai": a["board_ai"],
        "provider": a["provider"],
        "connection": a["connection"],
        "metered": a["metered"],
        "ready": a["state"] == "ready",
        "status_code": st.get("code"),
        "status": f"{where} · {word}",
    }


async def state(session: AsyncSession, kind: str, scope_id: str, person: str) -> dict:
    """Everything the chat panel needs before the first question.

    Returns:
        {"scope", "availability", "members", "member_id", "estimate", "work", "chat_id"}. `availability.code` is
        "ok" or the reason the person cannot ask (ai_off, viewer, not_configured, unavailable, over_budget,
        feature_off, not_shared) with its message.
    """
    provider = scopes.get(kind)
    if provider is None or kind in ("project", "all"):
        raise AssistError("invalid", f"Nothing to chat about called {kind!r}.")
    info = await provider.info(session, scope_id, person)
    cands = await svc_settings.answerers(session, info.project_id)
    prefer = None
    if kind == "ticket":
        t = await session.get(Ticket, scope_id)
        prefer = t.assignee if t else None
    existing = await svc_chat.scope_chat(session, kind, scope_id, person, create=False)
    chosen = await svc_settings.resolve_member(
        session, info.project_id, existing.member_id if existing else None, prefer
    )
    feature = "docs" if kind in ("doc", "idea") else "chat"
    availability: dict = {"code": "ok"}
    profile = None
    try:
        got = await svc_settings.guard_request(
            session,
            info.project_id,
            feature,
            person=person,
            member_id=chosen,
            require_member=True,
        )
        profile = got["profile"]
    except AssistError as exc:
        availability = {"code": exc.code, "message": str(exc), **exc.extra}
        if exc.code == "over_budget":
            # reading the thread still works; the member is still the one named
            from models import AiMember

            profile = await session.get(AiMember, chosen) if chosen else None
    built = await provider.context(
        session,
        info=info,
        person=person,
        question="",
        send_all=False,
        include_docs=[],
        doc_ids=[],
    )
    estimate = cost.estimate(profile, built.text, "answer") if profile else None
    work = {
        "allowed": bool(
            info.work
            and availability["code"] in ("ok", "over_budget")
            and profile is not None
            and profile.connection != "inbox"
        ),
        "estimate": cost.estimate(profile, built.text, "run") if profile else None,
    }
    return {
        "scope": info.describe(),
        "availability": availability,
        "members": [_member_card(a) for a in cands],
        "member_id": chosen,
        "estimate": estimate,
        "work": work,
        "chat_id": existing.id if existing else None,
    }


async def detail(session: AsyncSession, chat: AiChat, person: str) -> dict:
    """The chat with its messages (same shape as the board dock's)."""
    return await svc_chat.chat_detail(session, chat.id, person)


async def mention_estimate(
    session: AsyncSession, ticket_id: str, member_id: str, mode: str, person: str
) -> dict:
    """What @mentioning an AI member in a comment will do, before the comment is sent (design C, step 2): can it
    start, what it may do, what it would read and about what it costs. Changes nothing.

    Args:
        ticket_id: Ticket the comment is on.
        member_id: The AI member that would be mentioned.
        mode: "ask" (read and reply in a comment) or "work" (assign and run, stopping at its status ceiling).
        person: The person writing.
    """
    from models import AiMember, Member
    from services.ai import permissions as perms
    from services.ai.assist.drafts import role_of
    from services.ai.store import get_settings

    if mode not in ("ask", "work"):
        raise AssistError("invalid", "Mode: ask only, or do the work.")
    t = await session.get(Ticket, ticket_id)
    if t is None:
        raise AssistError("not_found", "Ticket not found.")
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    if (
        member is None
        or profile is None
        or member.kind != "ai"
        or member.project_id != t.project_id
    ):
        raise AssistError("not_found", "AI member not found in this project.")
    settings = await get_settings(session, t.project_id)
    info = await svc_settings._info_for(session, member, profile, settings)
    status = info["status"] or {}
    reason = None
    if not settings.ai_enabled:
        reason = "AI is turned off for this project."
    elif settings.paused_all:
        reason = "AI is paused for this project."
    elif await role_of(session, t.project_id, person) == "viewer":
        reason = "Only members can ask the AI."
    elif profile.paused:
        reason = f"{member.name} is paused."
    elif status.get("code") in ("key_invalid", "not_logged_in", "model_retired"):
        reason = f"{member.name}: {status.get('label', 'unavailable')}."
    elif status.get("code") == "over_budget" and profile.connection == "api_key":
        reason = f"{member.name} is over its budget; it resets tomorrow."
    elif mode == "work" and profile.connection == "inbox":
        reason = f"{member.name} is an inbox-only client; the board cannot start it."
    scope = scopes.get("ticket")
    sinfo = await scope.info(session, t.id, person)
    built = await scope.context(
        session,
        info=sinfo,
        person=person,
        question="",
        send_all=False,
        include_docs=[],
        doc_ids=[],
    )
    own = perms.effective(profile, "edit_fields", settings).mode != perms.BLOCKED
    runner = profile.connection == "local" and bool(profile.working_dir)
    return {
        "member_id": member.id,
        "member_name": member.name,
        "mode": mode,
        "available": reason is None,
        "reason": reason,
        "status": status.get("label"),
        "metered": profile.connection == "api_key",
        "estimate": cost.estimate(
            profile, built.text, "run" if mode == "work" else "answer"
        ),
        "reads": [c["label"] for c in sinfo.reading],
        "can_edit_code": bool(runner and own),
        "stops_at": profile.ceiling,
    }
