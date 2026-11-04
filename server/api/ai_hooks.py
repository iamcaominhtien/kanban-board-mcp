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
    if name == "SubagentStart" and agent_id:
        # the stream names subagents by the lead's Agent call; the hook knows Claude's own id for the role
        agents.append(
            {
                "id": _agent_key(ctx.run_id, agent_id, agent_type),
                "agent_type": agent_type or "",
                "claude_id": agent_id,
            }
        )
    elif name == "SubagentStop" and agent_id:
        agents.append(
            {
                "id": _agent_key(ctx.run_id, agent_id, agent_type),
                "agent_type": agent_type or "",
                "claude_id": agent_id,
                "ended": True,
            }
        )
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


def _agent_key(run_id: str, claude_id: str, agent_type: str | None) -> str:
    """The row the stream made for this subagent (keyed by the lead's Agent call), when it can be matched: the newest
    agent of the same type without a Claude id; else the Claude id itself."""
    key = _CLAUDE_IDS.get((run_id, claude_id))
    if key:
        return key
    return claude_id
