"""Dry run of an API agent on a sample ticket with the *unsaved* configuration (design/screens/ai-provider-config.md, D8).

The model is really called (so it costs tokens); reads hit real data; every write is only shown, never applied; the
status ceiling and the permissions are checked the way a real run would, and a blocked write comes back to the model
as an error. Keys, secret headers and tool results containing secrets never reach the trace.
"""

import json
import time

import httpx

from models import AiMember, Member, Project, Ticket

from . import api_agent, api_prompt, api_tools, secrets
from . import config_model as cm
from . import permissions as perms
from .context import RunContext
from .providers import cost_of
from .store import get_settings

READS = {
    "get_ticket",
    "list_tickets",
    "search_tickets",
    "list_docs",
    "read_doc",
    "search_docs",
}
WRITE_ACTION = {
    "add_comment": "comment",
    "update_ticket": "edit_fields",
    "create_ticket": "create_tickets",
    "set_test_case": "manage_test_cases",
    "create_doc": "edit_docs",
    "update_doc": "edit_docs",
}


def _short(value, n: int = 90) -> str:
    text = secrets.redact(
        json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    )
    return text if len(text) <= n else text[: n - 1] + "…"


def estimate_max_cost(model: str | None, max_tokens: int) -> float:
    """A ceiling for the cost of one run: the whole token limit, nine tenths of it input."""
    return round(cost_of(model, int(max_tokens * 0.9), int(max_tokens * 0.1)), 2)


async def run(
    session,
    profile: AiMember,
    member: Member,
    config: dict,
    ticket_id: str,
    by: str,
) -> dict:
    """Simulate a run; see the module docstring.

    Raises:
        ValueError: The member cannot be dry-run (no key, wrong ticket).
    """
    if profile.connection != "api_key":
        raise ValueError(
            "Dry run is for API agents; Claude Code runs on your computer."
        )
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None or ticket.project_id != profile.project_id:
        raise ValueError("Pick a ticket of this project.")
    key = secrets.decrypt(profile.key_enc)
    if not key:
        raise ValueError(
            "No readable API key is stored for this AI member; enter it again."
        )
    project = await session.get(Project, ticket.project_id)
    settings = await get_settings(session, ticket.project_id)
    ctx = RunContext(
        run_id="dry-run",
        member_id=member.id,
        member_name=member.name,
        project_id=ticket.project_id,
        ticket_id=ticket.id,
        on_behalf_of=by,
        mode="work",
    )
    t0 = time.monotonic()
    built = await api_prompt.compose(
        session, profile, member, ticket, project, config, ctx=ctx
    )
    extra_defs, extra, notes = await api_tools.load_extra_tools(config, "work")
    tools = api_agent.board_tools("work", config["tool_groups"]) + extra_defs
    chat = api_agent.make_chat(
        profile.provider,
        profile.base_url or "",
        key,
        profile.model or "",
        float(config["temperature"]),
    )
    chat.start(built["system"], built["user"], tools)

    rows: list[dict] = []
    max_steps = int(config["max_steps"])
    max_tokens = int(config["max_tokens_per_run"])
    sys_tok, ctx_tok = (
        cm.estimate_tokens(built["system"]),
        cm.estimate_tokens(built["user"]),
    )
    rows.append(
        {
            "step": 1,
            "name": "Build prompt",
            "detail": f"System {sys_tok} tok + context {ctx_tok} tok"
            + (f" · {len(notes)} server note(s)" if notes else ""),
            "tokens_in": sys_tok + ctx_tok,
            "tokens_out": None,
            "seconds": round(time.monotonic() - t0, 1),
            "tone": "plain",
        }
    )
    tok_in = tok_out = 0
    state, final_text = "finished", ""
    steps_used = 0
    deadline = time.monotonic() + float(config.get("run_timeout_min") or 5) * 60
    ext_steps = 0
    for _ in range(max_steps):
        if time.monotonic() > deadline:
            state = "timed_out"
            break
        if tok_in + tok_out >= max_tokens:
            state = "token_limit"
            break
        started = time.monotonic()
        try:
            reply = await chat.call(2048)
        except api_agent.ProviderError as exc:
            rows.append(
                {
                    "step": len(rows) + 1,
                    "name": "Model call failed",
                    "detail": str(exc)[:160],
                    "tokens_in": None,
                    "tokens_out": None,
                    "seconds": round(time.monotonic() - started, 1),
                    "tone": "error",
                }
            )
            state = "error"
            break
        except httpx.HTTPError as exc:
            rows.append(
                {
                    "step": len(rows) + 1,
                    "name": "Model call failed",
                    "detail": f"Could not reach the provider: {type(exc).__name__}",
                    "tokens_in": None,
                    "tokens_out": None,
                    "seconds": 0,
                    "tone": "error",
                }
            )
            state = "error"
            break
        steps_used += 1
        tok_in += reply.tokens_in
        tok_out += reply.tokens_out
        names = ", ".join(
            f"{c['name']}({_short(c['input'], 40)})" for c in reply.tool_calls
        )
        rows.append(
            {
                "step": len(rows) + 1,
                "name": "Model call" if reply.tool_calls else "Model call → final",
                "detail": f"tool_use → {names}"
                if reply.tool_calls
                else _short(reply.text or "(empty)", 100),
                "tokens_in": reply.tokens_in,
                "tokens_out": reply.tokens_out,
                "seconds": round(time.monotonic() - started, 1),
                "tone": "plain",
            }
        )
        if not reply.tool_calls:
            final_text = reply.text
            break
        results = []
        stop = False
        for call in reply.tool_calls:
            name, args = call["name"], call["input"] or {}
            started = time.monotonic()
            if name in READS or (
                name in extra and extra[name].kind == "http" and extra[name].reads_only
            ):
                out = await api_agent.run_tool(ctx, name, args, extra)
                rows.append(
                    {
                        "step": len(rows) + 1,
                        "name": "Tool · read",
                        "detail": f"{name} → {cm.estimate_tokens(out)} tokens",
                        "tokens_in": None,
                        "tokens_out": None,
                        "seconds": round(time.monotonic() - started, 1),
                        "tone": "plain",
                    }
                )
                results.append((call["id"], out[:20000], out.startswith("ERROR")))
                continue
            # Writes: shown, never applied
            action = WRITE_ACTION.get(name)
            if name == "update_ticket" and args.get("status"):
                reason = perms.check_status_move(profile, ticket.status, args["status"])
                if reason:
                    rows.append(
                        {
                            "step": len(rows) + 1,
                            "name": "Blocked by ceiling",
                            "detail": reason,
                            "tokens_in": None,
                            "tokens_out": None,
                            "seconds": 0.0,
                            "tone": "blocked",
                        }
                    )
                    results.append(
                        (call["id"], f"ERROR: BLOCKED (status_ceiling): {reason}", True)
                    )
                    continue
                action = "change_status"
            mode = (
                perms.effective(profile, action, settings).mode if action else "allowed"
            )
            if mode == "blocked":
                rows.append(
                    {
                        "step": len(rows) + 1,
                        "name": "Blocked by permissions",
                        "detail": f"{name}: not allowed for this member",
                        "tokens_in": None,
                        "tokens_out": None,
                        "seconds": 0.0,
                        "tone": "blocked",
                    }
                )
                results.append(
                    (
                        call["id"],
                        f"ERROR: BLOCKED (permissions): {name} is not allowed for this member.",
                        True,
                    )
                )
                continue
            if name in extra:
                ext_steps += 1
                label = "Tool · simulated call"
                text = f"Simulated {extra[name].label}; nothing was sent."
            elif name in ("ask_person", "report"):
                label, text = "Tool · simulated", "Recorded (simulated)."
                stop = stop or name == "ask_person"
            else:
                label = "Tool · simulated write"
                text = f"Simulated: {name} (not applied)."
            note = " · would wait for approval" if mode == "approval" else ""
            rows.append(
                {
                    "step": len(rows) + 1,
                    "name": label,
                    "detail": f"{name}({_short(args, 70)}) (simulated, not applied){note}",
                    "tokens_in": None,
                    "tokens_out": None,
                    "seconds": 0.0,
                    "tone": "simulated",
                }
            )
            results.append((call["id"], text, False))
        chat.add_results(results)
        if stop:
            break
    else:
        state = "step_limit"
    return {
        "ticket_id": ticket.id,
        "state": state,
        "steps_used": steps_used,
        "max_steps": max_steps,
        "seconds": round(time.monotonic() - t0, 1),
        "rows": rows,
        "tokens_in": tok_in,
        "tokens_out": tok_out,
        "max_tokens": max_tokens,
        "cost_usd": round(cost_of(profile.model, tok_in, tok_out), 4),
        "estimate_max_usd": estimate_max_cost(profile.model, max_tokens),
        "final_text": secrets.redact(final_text)[:2000],
        "notes": notes,
        "simulated": True,
        "external_calls_simulated": ext_steps,
    }
