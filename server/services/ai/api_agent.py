"""The agent loop the board runs itself for API-key AI members (Anthropic, OpenAI, Gemini, custom endpoints).

Every board tool the model calls goes through the same guard as an MCP call from a CLI run. A run stops at the first
limit it reaches (steps, tokens, wall clock, daily budget) and says which one. Keys are decrypted only for the call
and never logged.
"""

import asyncio
import json
import time
from dataclasses import dataclass, field

import httpx

import database
from models import AiRun

from . import api_tools, budget, cli, guard, secrets
from .providers import cost_of, merged_config
from .store import get_profile, get_settings, loads, now_iso

BACKOFF_SCALE = 1.0  # tests set it to 0 so a retry does not wait


class ProviderError(Exception):
    """A provider call failed. `kind`: auth | rate | model | outage | bad_request."""

    def __init__(
        self,
        kind: str,
        message: str,
        status: int | None = None,
        retry_after: float | None = None,
    ):
        """Classify the failure; `retry_after` is the wait the provider asked for, in seconds."""
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.retry_after = retry_after


@dataclass
class Reply:
    """One model turn."""

    text: str = ""
    tool_calls: list[dict] = field(default_factory=list)  # {id, name, input}
    tokens_in: int = 0
    tokens_out: int = 0


def _classify(status: int, body: str, retry_after: str | None = None) -> ProviderError:
    low = body.lower()
    if status in (401, 403):
        return ProviderError(
            "auth", f"{status} from provider: the key was rejected.", status
        )
    if status == 429:
        try:
            wait = float(retry_after) if retry_after else None
        except ValueError:
            wait = None
        return ProviderError(
            "rate", "429 from provider (rate limited).", status, retry_after=wait
        )
    # A retired model: 404 everywhere, or 400 naming the model as unknown / deprecated (OpenAI-compatible
    # endpoints and Gemini word it differently)
    if (status == 404 and "model" in low) or (
        status == 400
        and "model" in low
        and any(
            w in low
            for w in (
                "not found",
                "does not exist",
                "deprecated",
                "decommissioned",
                "retired",
            )
        )
    ):
        return ProviderError(
            "model",
            "The provider does not know this model (retired or misspelt).",
            status,
        )
    if status >= 500:
        return ProviderError("outage", f"The provider answered {status}.", status)
    return ProviderError(
        "bad_request",
        f"The provider answered {status}: {secrets.redact(body)[:200]}",
        status,
    )


class AnthropicChat:
    """Messages API with tool use."""

    def __init__(self, base_url: str, key: str, model: str, temperature: float):
        """Keep the connection settings; the key is only sent in headers."""
        self.url = base_url.rstrip("/") + "/v1/messages"
        self.headers = {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        self.model, self.temperature = model, temperature
        self.messages: list[dict] = []
        self.system = ""
        self.tools: list[dict] = []

    def start(self, system: str, user: str, tools: list[dict]) -> None:
        """First user turn."""
        self.system = system
        self.tools = [
            {
                "name": t["name"],
                "description": t["description"],
                "input_schema": t["parameters"],
            }
            for t in tools
        ]
        self.messages = [{"role": "user", "content": user}]

    async def call(self, max_tokens: int) -> Reply:
        """One model call."""
        body = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": self.system,
            "messages": self.messages,
            "temperature": self.temperature,
        }
        if self.tools:
            body["tools"] = self.tools
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(self.url, headers=self.headers, json=body)
        if r.status_code >= 400:
            raise _classify(r.status_code, r.text, r.headers.get("retry-after"))
        data = r.json()
        content = data.get("content") or []
        self.messages.append({"role": "assistant", "content": content})
        usage = data.get("usage") or {}
        return Reply(
            text="".join(b.get("text", "") for b in content if b.get("type") == "text"),
            tool_calls=[
                {"id": b["id"], "name": b["name"], "input": b.get("input") or {}}
                for b in content
                if b.get("type") == "tool_use"
            ],
            tokens_in=int(usage.get("input_tokens") or 0),
            tokens_out=int(usage.get("output_tokens") or 0),
        )

    def add_results(self, results: list[tuple[str, str, bool]]) -> None:
        """Tool results for the next call."""
        self.messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": i,
                        "content": c,
                        "is_error": e,
                    }
                    for i, c, e in results
                ],
            }
        )

    def add_user(self, text: str) -> None:
        """A follow-up user message."""
        self.messages.append({"role": "user", "content": text})


class OpenAIChat:
    """Chat Completions with function calling (OpenAI, Gemini's OpenAI-compatible endpoint, custom servers)."""

    def __init__(self, base_url: str, key: str, model: str, temperature: float):
        """Keep the connection settings."""
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.headers = {
            "Authorization": f"Bearer {key}",
            "content-type": "application/json",
        }
        self.model, self.temperature = model, temperature
        self.messages: list[dict] = []
        self.tools: list[dict] = []

    def start(self, system: str, user: str, tools: list[dict]) -> None:
        """System and first user turn."""
        self.tools = [{"type": "function", "function": t} for t in tools]
        self.messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

    async def call(self, max_tokens: int) -> Reply:
        """One model call."""
        body = {
            "model": self.model,
            "messages": self.messages,
            "temperature": self.temperature,
            "max_tokens": max_tokens,
        }
        if self.tools:
            body["tools"] = self.tools
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(self.url, headers=self.headers, json=body)
        if r.status_code >= 400:
            raise _classify(r.status_code, r.text, r.headers.get("retry-after"))
        data = r.json()
        msg = ((data.get("choices") or [{}])[0]).get("message") or {}
        self.messages.append(
            {k: v for k, v in msg.items() if k in ("role", "content", "tool_calls")}
        )
        calls = []
        for c in msg.get("tool_calls") or []:
            fn = c.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            calls.append({"id": c.get("id"), "name": fn.get("name"), "input": args})
        usage = data.get("usage") or {}
        return Reply(
            text=msg.get("content") or "",
            tool_calls=calls,
            tokens_in=int(usage.get("prompt_tokens") or 0),
            tokens_out=int(usage.get("completion_tokens") or 0),
        )

    def add_results(self, results: list[tuple[str, str, bool]]) -> None:
        """Tool results for the next call."""
        for i, c, _ in results:
            self.messages.append({"role": "tool", "tool_call_id": i, "content": c})

    def add_user(self, text: str) -> None:
        """A follow-up user message."""
        self.messages.append({"role": "user", "content": text})


def make_chat(provider: str, base_url: str, key: str, model: str, temperature: float):
    """The chat client for a provider (tests replace this)."""
    if provider == "anthropic":
        return AnthropicChat(base_url, key, model, temperature)
    return OpenAIChat(base_url, key, model, temperature)


# ---------------------------------------------------------------------------
# Board tools offered to the model
# ---------------------------------------------------------------------------

_S = {"type": "string"}


def board_tools(mode: str, groups: dict) -> list[dict]:
    """Tool definitions for the model, by enabled group (D2). Writes still obey the permission layer."""
    tools = [
        {
            "name": "get_ticket",
            "description": "Read a ticket: fields, criteria, comments, test cases.",
            "parameters": {
                "type": "object",
                "properties": {"ticket_id": _S},
                "required": ["ticket_id"],
            },
        },
        {
            "name": "list_tickets",
            "description": "List tickets of the project (compact).",
            "parameters": {"type": "object", "properties": {"status": _S, "q": _S}},
        },
    ]
    tools.append(
        {
            "name": "search_tickets",
            "description": "Search the project's tickets by words (compact results).",
            "parameters": {
                "type": "object",
                "properties": {"q": _S},
                "required": ["q"],
            },
        }
    )
    tools += api_tools.docs_defs(mode, groups)
    if mode == "ask":
        return tools
    if groups.get("comment", True):
        tools.append(
            {
                "name": "add_comment",
                "description": "Post a comment on the run's ticket (Markdown).",
                "parameters": {
                    "type": "object",
                    "properties": {"text": _S},
                    "required": ["text"],
                },
            }
        )
    if groups.get("update", True):
        tools.append(
            {
                "name": "update_ticket",
                "description": "Change fields of a ticket; status only up to your ceiling.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "ticket_id": _S,
                        "title": _S,
                        "description": _S,
                        "status": _S,
                        "priority": _S,
                        "estimate": {"type": "number"},
                        "tags": {"type": "array", "items": _S},
                    },
                    "required": ["ticket_id"],
                },
            }
        )
    if groups.get("create", False):
        tools.append(
            {
                "name": "create_ticket",
                "description": "Create a ticket (optionally a sub-ticket).",
                "parameters": {
                    "type": "object",
                    "properties": {"title": _S, "description": _S, "parent_id": _S},
                    "required": ["title"],
                },
            }
        )
    if groups.get("test_cases", True):
        tools.append(
            {
                "name": "set_test_case",
                "description": "Add a test case (title) or set the result of one "
                "(code like TC-2, status pass|fail|running|pending, notes).",
                "parameters": {
                    "type": "object",
                    "properties": {"code": _S, "title": _S, "status": _S, "notes": _S},
                },
            }
        )
    tools += [
        {
            "name": "ask_person",
            "description": "Ask the person you act for a question you cannot decide; then stop.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": _S,
                    "options": {"type": "array", "items": _S},
                },
                "required": ["question"],
            },
        },
        {
            "name": "report",
            "description": "Record your summary and which criteria you believe are met.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": _S,
                    "criteria": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": _S,
                                "met": {"type": "boolean"},
                                "evidence": _S,
                            },
                        },
                    },
                },
                "required": ["summary"],
            },
        },
    ]
    return tools


async def run_tool(ctx, name: str, args: dict, extra: dict | None = None) -> str:
    """Execute one tool call as the AI member; errors come back as text the model can read."""
    from kanban_mcp import operations as ops
    from kanban_mcp.tools.items import ITEM_OPS
    from kanban_mcp.tools.routing import route
    from kanban_mcp.tools.tickets import TICKET_OPS

    from . import runs

    async def call(tool, action, op, params):
        return await guard.guarded(
            tool, action, params, lambda g: route(f"{tool}.{action}", op, g)
        )

    try:
        if extra and name in extra:  # custom HTTP tool or remote MCP tool
            return await api_tools.run_extra(extra[name], name, args)
        if name in api_tools.DOC_TOOLS:
            return await api_tools.run_docs(ctx, name, args, call)
        if name == "search_tickets":
            data = await ops.list_tickets(project_id=ctx.project_id, q=args.get("q"))
            return json.dumps(data)[:20000]
        if name == "get_ticket":
            data = await ops.get_ticket(
                args.get("ticket_id") or ctx.ticket_id, activity_limit=0
            )
            return json.dumps(secrets.redact_obj(data))[:20000]
        if name == "list_tickets":
            data = await ops.list_tickets(
                project_id=ctx.project_id, status=args.get("status"), q=args.get("q")
            )
            return json.dumps(data)[:20000]
        if name == "add_comment":
            await call(
                "ticket_items",
                "comment.add",
                ITEM_OPS[("comment", "add")],
                {
                    "ticket_id": ctx.ticket_id,
                    "text": args.get("text", ""),
                    "author": ctx.member_name,
                },
            )
            return "Comment posted."
        if name == "update_ticket":
            params = {
                k: v
                for k, v in args.items()
                if v is not None
                and k
                in (
                    "ticket_id",
                    "title",
                    "description",
                    "status",
                    "priority",
                    "estimate",
                    "tags",
                )
            }
            params.setdefault("ticket_id", ctx.ticket_id)
            data = await call("manage_ticket", "update", TICKET_OPS["update"], params)
            return f"Updated {data.get('id')}: status {data.get('status')}."
        if name == "create_ticket":
            params = {
                "project_id": ctx.project_id,
                "title": args.get("title", ""),
                "description": args.get("description") or "",
                "parent_id": args.get("parent_id"),
            }
            data = await call(
                "manage_ticket",
                "create",
                TICKET_OPS["create"],
                {k: v for k, v in params.items() if v is not None},
            )
            return f"Created {data.get('id')}."
        if name == "set_test_case":
            if args.get("code"):
                params = {
                    "ticket_id": ctx.ticket_id,
                    "item_id": args["code"],
                    **{k: args[k] for k in ("status", "notes", "title") if args.get(k)},
                }
                await call(
                    "ticket_items",
                    "test_case.update",
                    ITEM_OPS[("test_case", "update")],
                    params,
                )
                return f"Test case {args['code']} updated."
            params = {
                "ticket_id": ctx.ticket_id,
                "title": args.get("title") or "Test",
                **{k: args[k] for k in ("status", "notes") if args.get(k)},
            }
            await call(
                "ticket_items", "test_case.add", ITEM_OPS[("test_case", "add")], params
            )
            return "Test case added."
        if name == "ask_person":
            await runs.record_question(
                ctx, args.get("question", ""), args.get("options")
            )
            return "Question posted. Stop now."
        if name == "report":
            await runs.record_report(
                ctx, args.get("summary", ""), args.get("criteria"), args.get("tests")
            )
            return "Report recorded. End with a short final message."
        return f"Unknown tool {name}."
    except ValueError as exc:
        return f"ERROR: {exc}"


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------


async def _call_with_retry(
    chat,
    max_tokens: int,
    retries: int,
    run_id: str,
    backoff: tuple[float, float, float] = (2.0, 2.0, 30.0),
) -> Reply:
    """One model call; 429 and 5xx wait `base × factor^n` seconds (capped at `max`) and try again (design P D6)."""
    from . import runs

    base, factor, cap = backoff

    def delay_for(attempt: int) -> float:
        return BACKOFF_SCALE * min(cap, base * (factor**attempt))

    attempt = 0
    while True:
        try:
            return await chat.call(max_tokens)
        except ProviderError as exc:
            if exc.kind not in ("rate", "outage") or attempt >= retries:
                raise
            delay = delay_for(attempt)
            attempt += 1
            await runs._append(
                run_id,
                steps=[
                    {
                        "kind": "retry",
                        "text": f"{exc} Retrying in {int(delay)} s "
                        f"(attempt {attempt} of {retries}).",
                    }
                ],
            )
            await asyncio.sleep(delay)
        except httpx.HTTPError as exc:
            if attempt >= retries:
                raise ProviderError(
                    "outage", f"Could not reach the provider: {type(exc).__name__}"
                ) from exc
            attempt += 1
            await asyncio.sleep(delay_for(attempt - 1))


async def execute(run_id: str, token: str, resume_note: str | None = None) -> None:
    """Run the loop to its end (finished, needs input, failed or stopped by a limit)."""
    from . import runs

    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        member, profile = await get_profile(session, run.member_id)
        config = merged_config(loads(profile.config, {}))
        system, prompt, _ = await runs._build_prompt(
            session, run, profile, member, resume_note=None
        )
        ctx = await runs._ctx_for(session, run)
        key = secrets.decrypt(profile.key_enc)
    if not key:
        await runs._end(
            run_id,
            "failed",
            "No readable API key is stored for this AI member; enter it again.",
        )
        return
    chat = make_chat(
        profile.provider,
        profile.base_url or "",
        key,
        profile.model or "",
        float(config["temperature"]),
    )
    extra_defs, extra, notes = await api_tools.load_extra_tools(config, run.mode)
    chat.start(
        system,
        prompt if not resume_note else f"{prompt}\n\n{resume_note}",
        board_tools(run.mode, config["tool_groups"]) + extra_defs,
    )
    await runs._append(
        run_id,
        state="running",
        steps=[{"kind": "start", "text": "Built the prompt"}]
        + [{"kind": "note", "text": n} for n in notes],
    )
    max_steps = int(config["max_steps"])
    max_tokens_run = int(config["max_tokens_per_run"])
    deadline = (
        time.monotonic()
        + float(run.limit_min or config.get("run_timeout_min") or 5) * 60
    )
    tokens_in = tokens_out = 0
    cost = 0.0
    final_text = ""
    tokens = guard.enter(ctx)
    try:
        for step in range(1, max_steps + 1):
            deadline += await runs.wait_while_paused(run_id)  # a paused run waits here
            async with database.async_session() as session:
                cur = await session.get(AiRun, run_id)
                if (
                    cur is None
                    or cur.state not in ("starting", "running")
                    or run_id in runs.RT.cancelled
                ):
                    return
            edited = await runs.take_context_notes(run_id)
            if (
                edited
            ):  # a person edited the ticket: the model sees it before its next call
                chat.add_user(edited)
            if time.monotonic() > deadline:
                await runs._end(run_id, "timed_out", "Wall-clock limit reached.")
                return
            if tokens_in + tokens_out >= max_tokens_run:
                await runs._end(
                    run_id,
                    "failed",
                    f"Stopped: token limit per run reached ({max_tokens_run:,}).",
                )
                return
            # At the cap the default is "pause new runs, the running one finishes"; only the
            # "Stop everything now" policy ends a run mid-way (design/screens/ai-safety-cost.md, C5).
            if config.get("at_cap") == "stop":
                async with database.async_session() as session:
                    settings = await get_settings(session, profile.project_id)
                    over = await budget.blocked(session, profile, settings)
                if over:
                    await runs._end(
                        run_id,
                        "failed",
                        f"Stopped · budget at step {step}: {over[1]}. Work so far is kept and the hold is released.",
                    )
                    return
            try:
                reply = await _call_with_retry(
                    chat,
                    2048,
                    int(config["retries"]),
                    run_id,
                    (
                        float(config["retry_base_s"]),
                        float(config["retry_factor"]),
                        float(config["retry_max_s"]),
                    ),
                )
            except ProviderError as exc:
                if exc.kind == "rate" and await runs.requeue_rate_limited(
                    run_id, exc.retry_after or cli.RATE_WAIT_DEFAULT, str(exc)
                ):
                    return  # back in the queue; it retries after the wait
                health = {
                    "auth": "key_invalid",
                    "rate": "rate_limited",
                    "model": "model_retired",
                }.get(exc.kind)
                if health:
                    async with database.async_session() as session:
                        _, p = await get_profile(session, profile.id)
                        p.health, p.health_detail = health, str(exc)
                        session.add(p)
                        await session.commit()
                await runs._end(run_id, "failed", f"{exc} Nothing more was changed.")
                return
            tokens_in += reply.tokens_in
            tokens_out += reply.tokens_out
            call_cost = cost_of(profile.model, reply.tokens_in, reply.tokens_out)
            cost += call_cost
            names = ", ".join(c["name"] for c in reply.tool_calls) or "final answer"
            await runs._append(
                run_id,
                steps=[
                    {
                        "kind": "model",
                        "text": f"Model call → {names}",
                        "detail": f"{reply.tokens_in} in · {reply.tokens_out} out",
                    }
                ],
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                cost_usd=round(cost, 6),
            )
            if profile.cap_per_run and cost >= profile.cap_per_run:
                await runs._end(
                    run_id,
                    "failed",
                    f"Stopped: cap per run reached (${cost:.2f} of ${profile.cap_per_run:.2f}). Work so far is kept.",
                )
                return
            async with database.async_session() as session:
                _, p = await get_profile(session, profile.id)
                p.last_call_at = now_iso()
                if p.health in ("unknown", "rate_limited"):
                    p.health, p.health_detail = "ok", None
                session.add(p)
                await session.commit()
            if not reply.tool_calls:
                final_text = reply.text
                break
            results = []
            asked = False
            for call in reply.tool_calls:
                out = await run_tool(ctx, call["name"], call["input"], extra)
                kind = (
                    "blocked"
                    if out.startswith("ERROR: BLOCKED")
                    else ("approval" if "NEEDS_APPROVAL" in out else "board")
                )
                await runs._append(
                    run_id,
                    steps=[
                        {"kind": kind, "text": f"board.{call['name']} → {out[:160]}"}
                    ],
                )
                results.append((call["id"], out, out.startswith("ERROR")))
                asked = asked or call["name"] == "ask_person"
            chat.add_results(results)
            if asked:
                break
        else:
            await runs._end(
                run_id, "failed", f"Stopped: step limit reached ({max_steps} steps)."
            )
            return
    finally:
        guard.leave(tokens)
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        question = loads(run.question, None) if run else None
    if question and not question.get("answered_at"):
        await runs._needs_input(run_id)
        return
    await runs._finish(run_id, final_text)
