"""What a run's hooks tell the board (AI v2): `POST /ai/hooks` with the run's bearer token and the hook's JSON.

The board's plugin (services/ai/launch.py) runs on PostToolUse (edits, plans), SubagentStart, SubagentStop and
Stop; each posts the hook input here. The stream is the main source of steps; hooks add what it lacks (a subagent's
own Claude id, the plan the lead keeps) and never block the AI.
"""

import logging
from typing import Any

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse

from services.ai import guard, steps

logger = logging.getLogger("kanban.ai.hooks")
router = APIRouter(tags=["ai"])


@router.post("/ai/hooks")
async def post_hook(
    request: Request, authorization: str | None = Header(default=None)
) -> JSONResponse:
    """A hook event of a run. Unknown events and bad tokens answer 200 with `ignored`, so a hook never fails."""
    token = (
        (authorization or "").split(None, 1)[1].strip()
        if (authorization or "").lower().startswith("bearer ")
        else ""
    )
    if not token.startswith("kbr_"):
        return JSONResponse({"ignored": "no token"})
    try:
        ctx = await guard.context_for_token(token)
    except guard.AiActionError:
        return JSONResponse({"ignored": "run ended"})
    try:
        body: Any = await request.json()
    except ValueError:
        return JSONResponse({"ignored": "not json"})
    if not isinstance(body, dict):
        return JSONResponse({"ignored": "not an object"})
    name = str(body.get("hook_event_name") or "")
    agent_id = body.get("agent_id")
    agent_type = body.get("agent_type")
    tool = body.get("tool_name")
    inp = body.get("tool_input") if isinstance(body.get("tool_input"), dict) else {}
    rows: list[dict] = []
    agents: list[dict] = []
    if name in ("SubagentStart", "SubagentStop") and agent_id:
        # The stream names a subagent by the lead's Agent call; the hook knows Claude's own id for the role. The hook
        # often comes first (before the stream's Agent step), and a row made from it alone would be a second row for
        # the same role: so a hook that matches no row is dropped. The stream's Agent result names Claude's id, and
        # that links the two; the Stop hook, which comes later, then finds its row.
        key = await _agent_key(ctx.run_id, agent_id, agent_type)
        if key is None:
            return JSONResponse({"ignored": f"{name}: no row yet"})
        entry = {"id": key, "agent_type": agent_type or "", "claude_id": agent_id}
        if name == "SubagentStop":
            entry["ended"] = True
        agents.append(entry)
    elif name == "PostToolUse" and tool in ("TaskCreate", "TaskUpdate", "TodoWrite"):
        rows.append(
            {
                "kind": "plan",
                "title": str(
                    inp.get("subject")
                    or inp.get("description")
                    or inp.get("status")
                    or tool
                )[:200],
                "tool": tool,
                "detail": {"input": inp, "hook": True},
            }
        )
    elif name == "Stop":
        rows.append(
            {
                "kind": "hook",
                "title": "The lead ended its turn",
                "detail": {"hook_event_name": name},
            }
        )
    else:
        return JSONResponse({"ignored": name or "unknown"})
    try:
        await steps.append(ctx.run_id, rows, agents=agents)
    except Exception:  # noqa: BLE001 - a hook never fails the run
        logger.exception("hook of run %s not recorded", ctx.run_id)
    return JSONResponse({"ok": True})


_CLAUDE_IDS: dict[tuple[str, str], str] = {}


async def _agent_key(run_id: str, claude_id: str, agent_type: str | None) -> str | None:
    """The row the stream made for this subagent (keyed by the lead's Agent call), when it can be matched: the row
    that already has this Claude id, else the oldest open agent of the same type without one; else None (the hook
    came first: the stream's row does not exist yet)."""
    key = _CLAUDE_IDS.get((run_id, claude_id))
    if key:
        return key
    import database
    from models import AiRunAgent
    from sqlmodel import col, select

    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiRunAgent)
                .where(AiRunAgent.run_id == run_id)
                .order_by(col(AiRunAgent.started_at).asc())
            )
        ).all()
    found = next((a.id for a in rows if a.claude_id == claude_id), None)
    if found is None and agent_type:
        found = next(
            (
                a.id
                for a in rows
                if not a.claude_id and not a.ended_at and a.agent_type == agent_type
            ),
            None,
        )
    if found is None:
        return None
    if len(_CLAUDE_IDS) > 5000:
        _CLAUDE_IDS.clear()
    _CLAUDE_IDS[(run_id, claude_id)] = found
    return found


@router.post("/internal/ai/events")
async def post_internal_event(
    request: Request, x_kanban_internal: str | None = Header(default=None)
) -> JSONResponse:
    """An event from the runner process, broadcast to the SSE subscribers of this API."""
    import hmac

    import events as board_events
    from services.ai import runner_link

    if not x_kanban_internal or not hmac.compare_digest(
        x_kanban_internal, runner_link.TOKEN
    ):
        return JSONResponse({"detail": "Not the runner"}, status_code=403)
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"ignored": "not json"})
    event = body.get("event") if isinstance(body, dict) else None
    if not isinstance(event, str):
        return JSONResponse({"ignored": "no event"})
    board_events.broadcast_raw(event)
    return JSONResponse({"ok": True})


@router.get("/ai/runner")
async def get_runner_status() -> dict:
    """Where the CLIs run (this process or the runner process) and whether the runner is alive."""
    from services.ai import runner_link

    return runner_link.status()
