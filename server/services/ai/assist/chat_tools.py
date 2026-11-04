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

from .. import accounts, config_service, guard, llm, runs, tool_rules
from .. import plugins as ai_plugins
from ..context import RunContext
from ..providers import merged_config
from ..store import get_settings, loads

log = logging.getLogger(__name__)

# Scopes that answer from the board, a Docs page included (the others, such as a sketch, keep their own rules)
SCOPES = ("project", "all", "ticket", "doc")


def applies(chat: AiChat, profile: AiMember) -> bool:
    """Whether this chat answers with the member's configured tools."""
    return (
        chat.scope in SCOPES
        and profile.connection == "local"
        and profile.provider == "claude-code"
    )


async def build(
    chat: AiChat, profile: AiMember, member: Member, *, acts_by_tier: bool = False
) -> tuple[llm.ChatTools, str]:
    """The tools of one answer and the token its board calls carry (give it back with `guard.revoke_chat_token`)."""
    return await build_for(
        project_id=chat.project_id,
        ticket_id=chat.ticket_id or "",
        owner=chat.owner,
        key=f"chat_{chat.id}",
        profile=profile,
        member=member,
        acts_by_tier=acts_by_tier,
    )


async def build_for(
    *,
    project_id: str,
    ticket_id: str,
    owner: str,
    key: str,
    profile: AiMember,
    member: Member,
    acts_by_tier: bool = False,
) -> tuple[llm.ChatTools, str]:
    """The member's tools for one answer outside a run (a chat, a Docs answer), and the token its board calls carry.
    `acts_by_tier`: its board tools only read (a Docs answer changes the page through a proposal, never directly)."""
    async with database.async_session() as session:
        if profile.working_dir and os.path.isdir(profile.working_dir):
            # the synced files (CLAUDE.md, skills, .mcp.json, settings.json) are what a run would start from
            synced = await config_service.sync_for_run(session, profile)
            if not synced["ok"]:
                log.warning("%s: configuration not written: %s", key, synced["message"])
        settings = await get_settings(session, project_id)
    config = merged_config(loads(profile.config, {}))
    token = guard.issue_chat_token(
        RunContext(
            run_id=key,
            member_id=member.id,
            member_name=member.name,
            project_id=project_id,
            ticket_id=ticket_id,
            on_behalf_of=owner,
            mode="work",
            acts_by_tier=acts_by_tier,
        )
    )
    async with database.async_session() as db:
        config_dir = await accounts.config_dir_for_member(db, member.id)
    mcp = runs.mcp_config(config, token, profile.working_dir, config_dir)
    allowed = list(config.get("allow_rules") or []) + ["mcp__kanban"]
    allowed += [f"mcp__{name}" for name in mcp["mcpServers"] if name != "kanban"]
    safe = bool(settings.safe_mode or profile.safe_mode)
    switches = tool_rules.settings_of(settings)
    allowed, denied = runs.cli_tool_rules(
        allowed,
        list(config.get("deny_rules") or []),
        safe=safe,
        domains=loads(settings.allowed_domains, []),
        # web search follows the project's switch, as for a run of the member
        role=ai_plugins.role_of(profile),
        web_search=switches["web_search"],
    )
    # "Bypass permissions" as for a work run of the member: its own choice or the project's preset, never in safe
    # mode. Deny rules and the board's own checks still apply; the blanket web denial is lifted (a run does the same)
    bypass = (
        tool_rules.bypass_for(
            switches["bypass"],
            config.get("permission_mode") == "bypass",
            profile.provider,
        )
        and not safe
    )
    if bypass:
        denied = [d for d in denied if d not in runs._WEB_TOOLS]
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
