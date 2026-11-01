"""Notifications API (design/screens/notifications.md, docs/specs/notifications.md): the caller's rows across every
project, the bell's counts, the feed since a log id, read / dismiss / snooze / clear, the settings, follow and mute,
the day card, and the raw event log. The caller is the person of the request (X-Actor, or the board's own user)."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services import activity as svc_activity
from services import notifications as svc

router = APIRouter(prefix="/notifications", tags=["notifications"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


def _me() -> str:
    return svc.person_key(_by())


def _bad(exc: Exception, status: int = 400):
    raise HTTPException(status_code=status, detail=str(exc)) from exc


@router.get(
    "", responses={422: {"description": "`filter` is not one of the known filters"}}
)
async def list_notifications(
    session: Session,
    view: str = "page",
    tab: Optional[str] = None,
    filter: str = "all",
    q: Optional[str] = None,
    project_id: Optional[str] = None,
    kind: Annotated[Optional[list[str]], Query()] = None,
    family: Optional[str] = None,
    days: Optional[int] = None,
    limit: int = 100,
    before: Optional[str] = None,
) -> dict:
    """The caller's rows, newest activity first. `view=panel&tab=needs|updates` is the bell panel (30 days, quiet,
    cleared and snoozed rows left out); `view=page` is All notifications with `filter` all | unread | needs |
    snoozed | done | cleared, search `q`, `project_id`, `kind`, `family` (ai | people | schedules | info), `days`."""
    if filter not in svc.FILTERS:
        raise HTTPException(
            status_code=422, detail=f"filter must be one of {', '.join(svc.FILTERS)}"
        )
    await svc.reconcile()
    return await svc.list_rows(
        session,
        _me(),
        view=view,
        tab=tab,
        filter=filter,
        q=q,
        project_id=project_id,
        kinds=kind,
        family=family,
        days=days,
        limit=limit,
        before=before,
    )


@router.get("/counts")
async def get_counts(session: Session) -> dict:
    """The bell: `needs` (the red number), `updates_unread` (the blue dot), `snoozed`, `head` (the log's newest id)."""
    return await svc.counts(session, _me())


@router.get("/feed")
async def get_feed(session: Session, since: Optional[int] = None) -> dict:
    """Rows new or merged since log id `since` and rows closed since, for toasts and the desktop notifier. Without
    `since` only `head` comes back (a first load never replays old news); a cursor older than the log returns
    `cursor_too_old: true` — start from `head`."""
    await svc.reconcile()
    return await svc.feed(session, _me(), since)


@router.get("/log")
async def get_log(
    session: Session, since: int = 0, project_id: Optional[str] = None, limit: int = 200
) -> dict:
    """The event log after an id, oldest first (what an external AI waiting on the board will read). The board's own
    user reads every event; anyone else the events told to them (an AI member as `ai:<id>`, or by its name in
    `project_id`) and every event of the projects they own or administer."""
    me = _me()
    readers = None
    if me != "user":
        readers = [me]
        if project_id:
            for k in await svc.recipient_keys(session, project_id, [_by()]):
                if k not in readers:
                    readers.append(k)
    return await svc.log_since(
        session, since, project_id=project_id, limit=limit, readers=readers
    )


class ReadBody(BaseModel):
    """Rows to mark read: `ids`, or `all` (of a `tab`, and narrowed by the All notifications page's filters, with the
    same names and meaning as `GET /notifications?view=page`)."""

    ids: Optional[list[str]] = None
    all: bool = False
    tab: Optional[str] = None
    filter: Optional[str] = None
    q: Optional[str] = None
    project_id: Optional[str] = None
    kind: Optional[list[str] | str] = None
    family: Optional[str] = None
    days: Optional[int] = None


@router.post(
    "/read",
    responses={422: {"description": "`filter` is not one of the known filters"}},
)
async def post_read(body: ReadBody, session: Session) -> dict:
    """Mark rows read (`ids`), or all of a tab (`all`, `tab` needs | updates); with `all` and any of the page's
    filters (`filter`, `q`, `project_id`, `kind`, `family`, `days`) only the rows that page lists. Reading is not
    resolving."""
    kinds = [body.kind] if isinstance(body.kind, str) else body.kind
    try:
        read = await svc.mark_read(
            session,
            _me(),
            ids=body.ids,
            all=body.all,
            tab=body.tab,
            filter=body.filter,
            q=body.q,
            project_id=body.project_id,
            kinds=kinds,
            family=body.family,
            days=body.days,
        )
        return {"read": read}
    except ValueError as exc:
        _bad(exc, 422)


class OpenedBody(BaseModel):
    """What the person opened."""

    target_kind: str
    target_id: str


@router.post("/opened")
async def post_opened(body: OpenedBody, session: Session) -> dict:
    """The person opened what rows point at (a ticket, a page, a run): those rows are read, not done."""
    n = await svc.mark_target_read(session, _me(), body.target_kind, body.target_id)
    return {"read": n}


@router.post("/{row_id}/dismiss")
async def post_dismiss(row_id: str, session: Session) -> dict:
    """Dismiss resolves the thing for everyone it was addressed to ("Dismissed by you")."""
    try:
        return await svc.dismiss(session, _me(), row_id, _by())
    except LookupError as exc:
        _bad(exc, 404)
    except ValueError as exc:
        _bad(exc, 409)


class SnoozeBody(BaseModel):
    """Until when a row is hidden."""

    until: Optional[str] = None  # UTC or offset ISO time; None brings it back now


@router.post("/{row_id}/snooze")
async def post_snooze(row_id: str, body: SnoozeBody, session: Session) -> dict:
    """Hide a row until a time; `until: null` brings it back now."""
    try:
        return await svc.snooze(session, _me(), row_id, body.until)
    except LookupError as exc:
        _bad(exc, 404)
    except ValueError as exc:
        _bad(exc, 422)


class ClearBody(BaseModel):
    """Clear or put back."""

    on: bool = True


@router.post("/{row_id}/clear")
async def post_clear(
    row_id: str, session: Session, body: ClearBody | None = None
) -> dict:
    """Clear a row (it stays on the page under Cleared); `on: false` puts it back."""
    try:
        return await svc.clear(session, _me(), row_id, body.on if body else True)
    except LookupError as exc:
        _bad(exc, 404)
    except ValueError as exc:
        _bad(exc, 409)


@router.post("/clear-read")
async def post_clear_read(session: Session) -> dict:
    """Clear every read update."""
    return {"cleared": await svc.clear_read(session, _me())}


@router.get("/settings")
async def get_settings(session: Session) -> dict:
    """Settings › Notifications of the caller."""
    return await svc.settings_for(session, _me())


@router.patch(
    "/settings",
    responses={
        403: {
            "description": "`retention_days` from someone who is not an owner or admin"
        },
        422: {"description": "A value out of range, or In app off for Needs you"},
    },
)
async def patch_settings(body: dict[str, Any], session: Session) -> dict:
    """Change part of the settings: `events` [{kind, inapp?, desktop?}] (In app is locked on for Needs you),
    `quiet` {on, start, end}, `dnd`, `sound`, `day_card` {on, time, days}, `retention_days`."""
    try:
        return await svc.update_settings(session, _me(), body)
    except PermissionError as exc:
        _bad(exc, 403)
    except ValueError as exc:
        _bad(exc, 422)


class FollowBody(BaseModel):
    """A follow or a mute."""

    scope: str  # ticket | page | space | project | kind
    scope_id: str
    level: Optional[str] = None  # follow | everything | mentions | mute; None forgets
    project_id: Optional[str] = None
    minutes: Optional[int] = None  # "Mute for 1 hour"
    label: str = ""


@router.get("/follow")
async def get_follow(scope: str, scope_id: str, session: Session) -> dict:
    """What the bell on a ticket, page or space shows for the caller."""
    return await svc.follow_state(session, _me(), scope, scope_id)


@router.put("/follow")
async def put_follow(body: FollowBody, session: Session) -> dict:
    """Follow, mute or forget a ticket, page, Docs space, project or kind."""
    try:
        return await svc.set_follow(
            session,
            _me(),
            scope=body.scope,
            scope_id=body.scope_id,
            level=body.level,
            project_id=body.project_id,
            minutes=body.minutes,
            label=body.label,
        )
    except ValueError as exc:
        _bad(exc, 422)


@router.delete("/follow/{follow_id}")
async def delete_follow(follow_id: str, session: Session) -> dict:
    """Unmute (or stop following) from the Muted list."""
    try:
        await svc.unmute(session, _me(), follow_id)
    except LookupError as exc:
        _bad(exc, 404)
    return {"deleted": True}


@router.get("/day-card")
async def get_day_card(session: Session, preview: bool = False) -> dict:
    """The caller's latest day card; `preview=true` counts today so far without writing a card."""
    me = _me()
    if preview:
        from datetime import UTC, datetime

        now = datetime.now(UTC)
        since = now.astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        return {
            "card": None,
            "preview": await svc.build_day_card(session, me, since=since, until=now),
        }
    data = await svc.list_rows(session, me, view="panel", tab="updates", limit=1)
    return {"card": data["day_card"], "preview": None}


@router.post("/day-card")
async def post_day_card() -> dict:
    """Write the caller's day card now (the time is a setting; this is for "Sum up today" and tests)."""
    n = await svc.write_day_cards(force_for=_me())
    return {"written": n}
