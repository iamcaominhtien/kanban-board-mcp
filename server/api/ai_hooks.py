"""What a run's hooks tell the board (AI v2): `POST /ai/hooks` with the run's bearer token and the hook's JSON.

The board's plugin (services/ai/launch.py) runs on PreToolUse (the one safety rule), PostToolUse (the plan the lead
keeps) and Stop; each posts the hook input here. The stream is the source of steps and of the roles' starts and ends
(its `task_*` events); hooks add what it lacks and never block the AI.
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
    tool = body.get("tool_name")
    inp = body.get("tool_input") if isinstance(body.get("tool_input"), dict) else {}
    rows: list[dict] = []
    agents: list[dict] = []
    if name in ("SubagentStart", "SubagentStop"):
        # A role's start, work and end come from the stream's own task events (services/ai/stream.py), which need no hook.
        return JSONResponse({"ignored": "roles come from the stream"})
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


@router.post("/internal/ai/events")
async def post_internal_event(
    request: Request, x_kanban_internal: str | None = Header(default=None)
) -> JSONResponse:
    """An event from the runner process, broadcast to the SSE subscribers of this API; or `{"own_change": true}`: the
    runner wrote to the database, so the database watcher does not announce that commit as another app's."""
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
    if isinstance(body, dict) and body.get("own_change"):
        # The runner committed changes it announces itself (or that need no announcement), at these times: not
        # another app's
        at = body.get("at")
        times = (
            [t for t in at[-500:] if isinstance(t, (int, float))]
            if isinstance(at, list)
            else None
        )
        board_events.mark_own_change(times)
        return JSONResponse({"ok": True})
    event = body.get("event") if isinstance(body, dict) else None
    if not isinstance(event, str):
        return JSONResponse({"ignored": "no event"})
    board_events.broadcast_raw(event)
    return JSONResponse({"ok": True})


@router.get("/ai/runner")
async def get_runner_status(request: Request) -> dict:
    """Where the CLIs run (this process or the runner process), whether the runner is alive, and what computer it is:
    the name, the system and the app version, whether this request comes from it, and whether Claude Code is there."""
    import socket
    import sys

    from services.ai import cli, runner_link
    from version import APP_VERSION

    host = request.client.host if request.client else ""
    path, _ = cli.find_cli("claude")
    return {
        **runner_link.status(),
        "host": socket.gethostname(),
        "local": host in ("127.0.0.1", "::1", "localhost")
        or host.startswith("::ffff:127."),
        "platform": {"darwin": "macOS", "win32": "Windows", "linux": "Linux"}.get(
            sys.platform, sys.platform
        ),
        "app_version": APP_VERSION,
        "claude_found": bool(path),
    }
