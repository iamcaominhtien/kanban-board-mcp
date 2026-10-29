"""The schedules tool: let an AI member work on a ticket at a set time, once or on repeat (issue #153)."""

from typing import Annotated, Any, Literal

from pydantic import Field

from .. import common


async def ai_schedules(
    action: Literal[
        "list", "get", "create", "update", "pause", "resume", "delete", "run_now"
    ],
    project_id: Annotated[
        str | None, Field(description="list, create: the project UUID.")
    ] = None,
    schedule_id: Annotated[
        str | None, Field(description="Every action but list and create.")
    ] = None,
    ticket_id: Annotated[
        str | None, Field(description="create: the ticket; list: only its schedules.")
    ] = None,
    fields: Annotated[
        dict[str, Any] | None,
        Field(
            description="create, update: member_id (an AI member), kind once|repeat, run_at 'YYYY-MM-DDTHH:MM' "
            "(once), days [0-6, Mon=0] and time 'HH:MM' (repeat), tz (IANA), ends never|after|on_date, ends_after, "
            "ends_on, window_end 'HH:MM', backup_member_id, checks {criteria, tests: {on, command, cwd}, summary, "
            "branch, ai_checks: [text]}, review {on, reviewer_id, fix_rounds}, limits {stop_after_min, retries, "
            "max_cost}, catch_up run|skip|ask, catch_up_hours, instruction."
        ),
    ] = None,
) -> dict | list:
    """AI schedules: an AI member works on a ticket at a set time and a second AI may review it. At the time the
    board checks permission, budget and runner, starts a normal AI run, evaluates the "done when" checks and moves the
    ticket to Review on a pass (never further). Not available inside an AI run."""
    from services import activity as svc_activity
    from services.ai import guard
    from services.ai import schedules as svc

    if await guard.resolve() is not None:
        raise ValueError("An AI run cannot make or change schedules; a person does.")
    by = svc_activity.current_actor() or "user"
    async with common.async_session() as session:
        if action == "list":
            if not project_id:
                raise ValueError("list needs project_id.")
            return (await svc.list_for(session, project_id, ticket_id=ticket_id))[
                "items"
            ]
        if action == "create":
            if not project_id:
                raise ValueError("create needs project_id.")
            s = await svc.create(
                session,
                project_id,
                {
                    **(fields or {}),
                    "ticket_id": ticket_id or (fields or {}).get("ticket_id"),
                },
                by,
            )
            return await svc.to_dict(session, s)
        if not schedule_id:
            raise ValueError(f"{action} needs schedule_id.")
        if action == "get":
            return await svc.detail(session, schedule_id)
        if action == "update":
            s = await svc.update(session, schedule_id, fields or {}, by)
        elif action in ("pause", "resume"):
            s = await svc.set_paused(session, schedule_id, action == "pause", by)
        elif action == "delete":
            await svc.delete(session, schedule_id, by)
            return {"deleted": schedule_id}
        else:
            return svc.run_to_dict(await svc.run_now(session, schedule_id, by))
        return await svc.to_dict(session, s)
