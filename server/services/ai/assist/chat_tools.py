"""A Board AI chat answer with the member's own Claude Code configuration (MCP servers, tool rules, limits).

Without it the answer runs with no tools and only reads the context the board sends. With it the member answers the
way one of its runs would: its configured MCP servers are attached, the board's own server is reached through a token
that lasts one answer, and every board call goes through the same permission guard as a run (design: the chat uses the
member's configuration as it is).
"""

import logging
import os

import database
from models import AiChat, AiMember, Member

from .. import config_service, guard, llm, runs
from ..context import RunContext
from ..providers import merged_config
from ..store import get_settings, loads

log = logging.getLogger(__name__)

# Scopes that answer from the board (the others, such as a Docs page or a sketch, keep their own rules)
SCOPES = ("project", "all", "ticket")


def applies(chat: AiChat, profile: AiMember) -> bool:
    """Whether this chat answers with the member's configured tools."""
    return (
        chat.scope in SCOPES
        and profile.connection == "local"
        and profile.provider == "claude-code"
    )


async def build(
    chat: AiChat, profile: AiMember, member: Member
) -> tuple[llm.ChatTools, str]:
    """The tools of one answer and the token its board calls carry (give it back with `guard.revoke_chat_token`)."""
    async with database.async_session() as session:
        if profile.working_dir and os.path.isdir(profile.working_dir):
            # the synced files (CLAUDE.md, skills, .mcp.json, settings.json) are what a run would start from
            synced = await config_service.sync_for_run(session, profile)
            if not synced["ok"]:
                log.warning(
                    "Board AI chat %s: configuration not written: %s",
                    chat.id,
                    synced["message"],
                )
        settings = await get_settings(session, chat.project_id)
    config = merged_config(loads(profile.config, {}))
    token = guard.issue_chat_token(
        RunContext(
            run_id=f"chat_{chat.id}",
            member_id=member.id,
            member_name=member.name,
            project_id=chat.project_id,
            ticket_id=chat.ticket_id or "",
            on_behalf_of=chat.owner,
            mode="work",
        )
    )
    mcp = runs.mcp_config(config, token, profile.working_dir)
    allowed = list(config.get("allow_rules") or []) + ["mcp__kanban"]
    allowed += [f"mcp__{name}" for name in mcp["mcpServers"] if name != "kanban"]
    safe = bool(settings.safe_mode or profile.safe_mode)
    allowed, denied = runs.cli_tool_rules(
        allowed,
        list(config.get("deny_rules") or []),
        safe=safe,
        domains=loads(settings.allowed_domains, []),
    )
    # an owner's "Bypass permissions", as for a run of the member: never in safe mode; deny rules and the board's own
    # checks still apply, and the web stays off (its domain list needs the allow list the mode skips)
    bypass = config.get("permission_mode") == "bypass" and not safe
    if bypass:
        denied += [d for d in runs._WEB_TOOLS if d not in denied]
    return (
        llm.ChatTools(
            mcp=mcp,
            allowed=allowed,
            denied=denied,
            max_turns=None,
            effort=config.get("effort"),
            extra_flags=[
                f for f in (config.get("extra_flags") or []) if isinstance(f, str)
            ],
            bypass=bypass,
        ),
        token,
    )
