"""The Board AI sets up the AI team for the person: makes AI members from role packs, gives them a role, edits them,
installs plugins, switches the board's skills, adds MCP servers, hooks and skills, and says what each member could
use (issue: the Board AI manages the AI team, after #273).

The owner asked for full rights with no approval card. So these actions sit in the tiers like any other: with the
project's switch on (`ops.board_ai.manages_team`) the Board AI does them by itself and keeps an Undo; with it off they
ask first. Every one goes through the same services as the settings screens (members.update, plugins.install, the
project's ops), so their checks, versions and audit entries hold. An MCP server or a hook runs a command on this
machine, so its change says that command in so many words, on the card, in the receipt and in the audit log.
"""

import copy
import re

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiMember, AiPlugin, AiRun, Member, Project

from .. import audit, ops
from ..store import get_settings, loads

OPS = (
    "ai_from_pack",
    "ai_role",
    "ai_edit",
    "ai_pack_update",
    "plugin_install",
    "plugin_switch",
    "board_skill",
    "mcp_add",
    "mcp_remove",
    "hook_add",
    "hook_remove",
    "skill_add",
    "skill_remove",
)
# what runs a command on the machine: said in full wherever the change shows
COMMAND_OPS = ("mcp_add", "hook_add")
MAX_PERSONA = 1000

FORMAT = """Setting up the AI team (members, their role, skills, plugins, MCP servers and hooks), each one of:
  {"op": "ai_from_pack", "pack": "<role pack key: pm, ba, dev, ...>", "name": "<new member's name>", "model": "sonnet|haiku|opus or null", "plays": "<for user_tester: who it plays, or null>"}
  {"op": "ai_role", "member": "<exact AI member name>", "role": "<role pack key>"}
  {"op": "ai_edit", "member": "...", "persona": "<new text, at most 1000 characters>", "model": "...", "effort": "low|medium|high|xhigh|max", "description": "..."}  (only the keys that change)
  {"op": "ai_pack_update", "member": "..."}  (bring it to its role pack's latest version)
  {"op": "plugin_install", "key": "<catalogue key>"}  or  {"op": "plugin_install", "source": "<git URL>", "plugin": "<name in a marketplace or null>"}
  {"op": "plugin_switch", "plugin": "<installed plugin name>", "member": "...", "on": true|false|null}  (null: follow the project's default)
  {"op": "board_skill", "skill": "<board skill name>", "on": true|false, "member": "<name, or null for the whole project>"}
  {"op": "mcp_add", "member": "...", "key": "<catalogue MCP key>"}  or  {"op": "mcp_add", "member": "...", "server": {"name": "...", "type": "stdio|http|sse", "command": "...", "args": ["..."], "url": "..."}}
  {"op": "mcp_remove", "member": "...", "name": "<server name>"}
  {"op": "hook_add", "member": "...", "event": "PreToolUse|PostToolUse|UserPromptSubmit|Notification|Stop|SubagentStop|PreCompact|SessionStart|SessionEnd", "matcher": "<tool pattern or empty>", "command": "<shell command>"}
  {"op": "hook_remove", "member": "...", "command": "<the hook's command>"}
  {"op": "skill_add", "member": "...", "name": "<skill-name>", "description": "<what it covers and when to use it>", "content": "<the SKILL.md body, Markdown>"}
  {"op": "skill_remove", "member": "...", "name": "<skill-name>"}
The team as it is now, the role packs, the catalogue and the board's skills are in the context under <ai-team>. When
asked what an AI could use, read them and the project (its repository, its tickets) and say what you would add and why,
one line each; when asked to set it up, list the changes in the block. Pick from the catalogue first; a source that is
not in it, a hook or an MCP server you write yourself runs a command on this machine: name exactly what it runs in your
answer. A new AI from a role pack gets that role's skill and tools; prefer it to a member written by hand."""


class TeamError(ValueError):
    """A team change that cannot be made; the message is what the person reads."""


# --------------------------------------------------------------------------------------------- checking a proposal


def _text(value, n: int = 300) -> str:
    return " ".join(str(value or "").split())[:n]


def check(
    ch: dict, members: dict[str, str], names: dict[str, str], problems: list[str]
) -> dict | None:
    """A proposed team change, normalised with its words (`label`), or None with a problem written down.

    Args:
        members: lower-case name -> member id (people and AI members).
        names: member id -> name.
    """
    op = ch.get("op")
    out: dict = {"op": op, "ticket": None}

    def member() -> str | None:
        mid = members.get(_text(ch.get("member")).lower())
        if not mid:
            problems.append(f"{op}: unknown AI member {ch.get('member')!r}")
        return mid

    if op == "ai_from_pack":
        pack, name = _text(ch.get("pack"), 40).lower(), _text(ch.get("name"), 80)
        if not pack or not name:
            problems.append("ai_from_pack: which role pack, and what name?")
            return None
        out.update(
            pack=pack,
            name=name,
            model=_text(ch.get("model"), 60) or None,
            plays=_text(ch.get("plays"), 80) or None,
            label=f"New AI “{name}” from the {pack} role pack",
        )
        return out
    if op in ("ai_role", "ai_edit", "ai_pack_update"):
        mid = member()
        if not mid:
            return None
        out.update(
            member=mid, member_name=(_text(ch.get("member"), 80) or names.get(mid))
        )
        who = out["member_name"]
        if op == "ai_role":
            role = _text(ch.get("role"), 40).lower()
            if not role:
                problems.append("ai_role: which role?")
                return None
            out.update(role=role, label=f"{who} takes the {role} role")
        elif op == "ai_edit":
            fields = {
                k: str(ch[k])
                for k in ("persona", "model", "effort", "description")
                if ch.get(k) not in (None, "")
            }
            if "persona" in fields:
                fields["persona"] = fields["persona"].strip()[:MAX_PERSONA]
            if not fields:
                problems.append(f"ai_edit: what should change on {who}?")
                return None
            out.update(
                fields=fields, label=f"Change {who}: {', '.join(sorted(fields))}"
            )
        else:
            out.update(label=f"Bring {who} to its role pack's latest version")
        return out
    if op == "plugin_install":
        key, source = _text(ch.get("key"), 80), _text(ch.get("source"), 400)
        if not key and not source:
            problems.append("plugin_install: a catalogue key or a git URL")
            return None
        out.update(
            key=key or None,
            source=source or None,
            plugin=_text(ch.get("plugin"), 80) or None,
            label=f"Install the plugin {key or source}",
        )
        return out
    if op == "plugin_switch":
        mid = member()
        plugin = _text(ch.get("plugin"), 80)
        if not mid or not plugin:
            if mid:
                problems.append("plugin_switch: which plugin?")
            return None
        on = ch.get("on")
        on = None if on is None else bool(on)
        who = _text(ch.get("member"), 80) or names.get(mid)
        state = "follows the project default" if on is None else ("on" if on else "off")
        out.update(
            member=mid,
            member_name=who,
            plugin=plugin,
            on=on,
            label=f"Plugin {plugin} {state} for {who}",
        )
        return out
    if op == "board_skill":
        skill = _text(ch.get("skill"), 80)
        if not skill:
            problems.append("board_skill: which skill?")
            return None
        mid = None
        if _text(ch.get("member")):
            mid = member()
            if not mid:
                return None
        on = bool(ch.get("on", True))
        who = (_text(ch.get("member"), 80) or names.get(mid)) if mid else "every member"
        out.update(
            skill=skill,
            on=on,
            member=mid,
            member_name=who if mid else None,
            label=f"Board skill {skill} {'on' if on else 'off'} for {who}",
        )
        return out
    if op in (
        "mcp_add",
        "mcp_remove",
        "hook_add",
        "hook_remove",
        "skill_add",
        "skill_remove",
    ):
        mid = member()
        if not mid:
            return None
        who = _text(ch.get("member"), 80) or names.get(mid)
        out.update(member=mid, member_name=who)
        if op == "mcp_add":
            key = _text(ch.get("key"), 80)
            server = ch.get("server") if isinstance(ch.get("server"), dict) else None
            if not key and not server:
                problems.append("mcp_add: a catalogue key or a server")
                return None
            if server:
                server = {
                    k: server[k]
                    for k in (
                        "name",
                        "type",
                        "command",
                        "args",
                        "url",
                        "env",
                        "headers",
                    )
                    if k in server
                }
                if not _text(server.get("name"), 80):
                    problems.append("mcp_add: the server needs a name")
                    return None
            out.update(key=key or None, server=server)
            if key and not server:
                from .. import plugins as svc_plugins

                entry = next(
                    (
                        c
                        for c in svc_plugins.CATALOGUE
                        if c["key"] == key and c["kind"] == "mcp"
                    ),
                    None,
                )
                if entry is None:
                    problems.append(f"mcp_add: no MCP server {key!r} in the catalogue")
                    return None
            runs = _runs(server or entry["server"])
            out["runs"] = runs
            out["label"] = (
                f"Add the MCP server {key or server['name']} to {who}: runs {runs}"
            )
            return out
        if op == "mcp_remove":
            name = _text(ch.get("name"), 80)
            if not name:
                problems.append("mcp_remove: which server?")
                return None
            out.update(name=name, label=f"Remove the MCP server {name} from {who}")
            return out
        if op == "hook_add":
            from .. import config_model as cm

            event, command = (
                _text(ch.get("event"), 40),
                str(ch.get("command") or "").strip(),
            )
            if event not in cm.HOOK_EVENTS or not command:
                problems.append(
                    f"hook_add: an event ({', '.join(cm.HOOK_EVENTS)}) and a command"
                )
                return None
            matcher = _text(ch.get("matcher"), 200)
            out.update(
                event=event,
                matcher=matcher,
                command=command[:2000],
                runs=command[:2000],
                label=f"Add a {event}{f' ({matcher})' if matcher else ''} hook to {who}: runs {command[:2000]}",
            )
            return out
        if op == "hook_remove":
            command = str(ch.get("command") or "").strip()
            if not command:
                problems.append("hook_remove: which hook (its command)?")
                return None
            out.update(
                command=command, label=f"Remove the hook “{command[:120]}” from {who}"
            )
            return out
        name = re.sub(r"[^a-z0-9-]+", "-", _text(ch.get("name"), 64).lower()).strip("-")
        if not name:
            problems.append(f"{op}: the skill needs a name")
            return None
        if op == "skill_remove":
            out.update(name=name, label=f"Remove the skill {name} from {who}")
            return out
        description = _text(ch.get("description"), 1024)
        content = str(ch.get("content") or "").strip()
        if not description or not content:
            problems.append("skill_add: a description (when to use it) and its content")
            return None
        out.update(
            name=name,
            description=description,
            content=content[:20000],
            label=f"Add the skill {name} to {who}",
        )
        return out
    problems.append(f"Unknown change {op!r}")
    return None


def _runs(server: dict) -> str:
    """What an MCP server runs, in one line: its command and arguments, or its URL."""
    if server.get("url"):
        return str(server["url"])
    args = server.get("args") or []
    return " ".join([str(server.get("command") or "")] + [str(a) for a in args]).strip()


# --------------------------------------------------------------------------------------------- applying it


async def _profile(session: AsyncSession, mid: str) -> tuple[Member, AiMember]:
    member = await session.get(Member, mid)
    profile = await session.get(AiMember, mid)
    if member is None or profile is None or member.kind != "ai":
        raise TeamError("That is not an AI member of this project.")
    return member, profile


def _config(profile: AiMember) -> dict:
    from ..providers import merged_config

    return merged_config(loads(profile.config, {}))


async def _set_config(session, mid: str, patch: dict, person: str) -> None:
    from .. import config_service
    from .. import members as svc_members

    try:
        await svc_members.update(session, mid, {"config": patch}, by=person)
    except (svc_members.AiMemberError, config_service.ConfigError) as exc:
        raise TeamError(str(exc)) from exc


async def _record(project_id: str | None, ch: dict, person: str, ai_name: str) -> None:
    """One audit entry per change, as a warning when it runs a command on this machine."""
    await audit.record(
        project_id or "",
        "board_ai_team",
        "warning" if ch["op"] in COMMAND_OPS else "info",
        member_id=ch.get("member"),
        member_name=ch.get("member_name") or "",
        on_behalf_of=person,
        target=ch.get("member_name") or ch.get("name"),
        detail={
            "op": ch["op"],
            "change": ch.get("label"),
            "by": ai_name or "Board AI",
            **({"runs": ch["runs"]} if ch.get("runs") else {}),
        },
    )


async def apply(
    session: AsyncSession,
    ch: dict,
    person: str,
    project_id: str | None,
    ai_name: str = "",
) -> dict:
    """Make one team change as the person; returns what Undo needs (with `label` for the receipt)."""
    op = ch["op"]
    done = await _apply(session, ch, person, project_id)
    await _record(project_id, {**ch, **done}, person, ai_name)
    return {"op": op, "ticket": None, "label": ch.get("label"), **done}


async def _apply(session, ch: dict, person: str, project_id: str | None) -> dict:
    from .. import members as svc_members
    from .. import packs
    from .. import plugins as svc_plugins

    op = ch["op"]
    if op == "ai_from_pack":
        pack = await packs.get_pack(session, project_id, ch["pack"])
        if pack is None:
            keys = [p["key"] for p in await packs.list_packs(session, project_id)]
            raise TeamError(f"No role pack {ch['pack']!r}. Packs: {', '.join(keys)}.")
        project = await session.get(Project, project_id)
        body = packs.member_body(
            pack,
            name=ch["name"],
            working_dir=project.repo_path if project else None,
            account_id=None,
            plays=ch.get("plays"),
        )
        if ch.get("model"):
            body["model"] = ch["model"]
        try:
            m = await svc_members.create(session, project_id, body, by=person)
        except (svc_members.AiMemberError, ValueError) as exc:
            await session.rollback()
            raise TeamError(str(exc)) from exc

        async def plugins_of_pack() -> None:
            import database

            async with database.async_session() as s:
                await packs.install_plugins(s, project_id, pack, by=person)

        # the pack's plugins clone in the background, as from the packs screen; a run waits for them
        svc_plugins.installing(project_id, plugins_of_pack())
        return {"member": m.id, "member_name": m.name}
    if op == "ai_role":
        _m, profile = await _profile(session, ch["member"])
        if await packs.get_pack(session, profile.project_id, ch["role"]) is None:
            raise TeamError(f"No role pack {ch['role']!r} to take the role of.")
        before = loads(profile.config, {}).get("role")
        await _set_config(session, ch["member"], {"role": ch["role"]}, person)
        return {"member": ch["member"], "before": before, "after": ch["role"]}
    if op == "ai_edit":
        _m, profile = await _profile(session, ch["member"])
        fields = dict(ch["fields"])
        before = {
            k: getattr(profile, k) if k != "effort" else _config(profile).get("effort")
            for k in fields
        }
        data = {k: v for k, v in fields.items() if k != "effort"}
        if "effort" in fields:
            data["config"] = {"effort": fields["effort"]}
        try:
            await svc_members.update(session, ch["member"], data, by=person)
        except (
            Exception
        ) as exc:  # the member service's own message is what the person reads
            raise TeamError(str(exc)) from exc
        return {"member": ch["member"], "before": before, "after": fields}
    if op == "ai_pack_update":
        try:
            state = await packs.update_member(session, ch["member"], by=person)
        except ValueError as exc:
            raise TeamError(str(exc)) from exc
        return {"member": ch["member"], "after": state.get("version")}
    if op == "plugin_install":
        entry = None
        if ch.get("key"):
            entry = next(
                (c for c in svc_plugins.CATALOGUE if c["key"] == ch["key"]), None
            )
            if entry is None or entry["kind"] != "plugin":
                keys = [
                    c["key"] for c in svc_plugins.CATALOGUE if c["kind"] == "plugin"
                ]
                raise TeamError(
                    f"No plugin {ch['key']!r} in the catalogue. Plugins: {', '.join(keys)}."
                )
        try:
            row = await svc_plugins.install(
                session,
                project_id,
                source_kind="marketplace" if entry else "git",
                source=entry["source"] if entry else ch["source"],
                plugin=(entry or {}).get("plugin") or ch.get("plugin"),
                skills=(entry or {}).get("skills"),
                roles=(entry or {}).get("roles") or [],
                by=person,
            )
        except svc_plugins.PluginError as exc:
            raise TeamError(str(exc)) from exc
        return {"plugin_id": row.id, "name": row.name}
    if op == "plugin_switch":
        row = (
            await session.exec(
                select(AiPlugin).where(
                    AiPlugin.project_id == project_id, AiPlugin.name == ch["plugin"]
                )
            )
        ).first()
        if row is None:
            raise TeamError(f"No plugin {ch['plugin']!r} is installed on this project.")
        before = (loads(row.members, {}) or {}).get(ch["member"])
        await svc_plugins.set_member(session, row, ch["member"], ch["on"])
        return {"member": ch["member"], "plugin_id": row.id, "before": before}
    if op == "board_skill":
        from .. import board_skills

        if ch["skill"] not in {s["name"] for s in board_skills.catalog()}:
            names = ", ".join(s["name"] for s in board_skills.catalog())
            raise TeamError(f"No board skill {ch['skill']!r}. Skills: {names}.")
        settings = await get_settings(session, project_id)
        rows = copy.deepcopy(ops.get(settings).get("board_skills") or [])
        before = copy.deepcopy(rows)
        rows = _switch_skill(rows, ch["skill"], ch["on"], ch.get("member"))
        ops.update(settings, {"board_skills": rows})
        session.add(settings)
        await session.commit()
        return {"before": before, "after": rows, "project_id": project_id}
    # the lists of one member's configuration: MCP servers, hooks, skills
    _m, profile = await _profile(session, ch["member"])
    cfg = _config(profile)
    if op in ("mcp_add", "mcp_remove"):
        from .. import config_model as cm

        servers = list(cfg.get("mcp_servers") or [])
        before = copy.deepcopy(servers)
        if op == "mcp_add":
            if ch.get("key"):
                entry = next(
                    (
                        c
                        for c in svc_plugins.CATALOGUE
                        if c["key"] == ch["key"] and c["kind"] == "mcp"
                    ),
                    None,
                )
                if entry is None:
                    keys = [
                        c["key"] for c in svc_plugins.CATALOGUE if c["kind"] == "mcp"
                    ]
                    raise TeamError(
                        f"No MCP server {ch['key']!r} in the catalogue. MCP servers: {', '.join(keys)}."
                    )
                raw = dict(entry["server"])
            else:
                raw = dict(ch["server"])
            server = cm.normalize_server({**raw, "mode": "synced"})
            runs = _runs(server)
            servers = [s for s in servers if s.get("name") != server.get("name")] + [
                server
            ]
            await _set_config(session, ch["member"], {"mcp_servers": servers}, person)
            return {
                "member": ch["member"],
                "name": server.get("name"),
                "runs": runs,
                "before": before,
            }
        if not any(s.get("name") == ch["name"] for s in servers):
            raise TeamError(f"{ch['member_name']} has no MCP server {ch['name']!r}.")
        servers = [s for s in servers if s.get("name") != ch["name"]]
        await _set_config(session, ch["member"], {"mcp_servers": servers}, person)
        return {"member": ch["member"], "name": ch["name"], "before": before}
    if op in ("hook_add", "hook_remove"):
        from .. import config_model as cm

        hooks = list(cfg.get("hooks") or [])
        before = copy.deepcopy(hooks)
        if op == "hook_add":
            hook = cm.normalize_hook(
                {
                    "event": ch["event"],
                    "matcher": ch["matcher"],
                    "command": ch["command"],
                }
            )
            hooks = [h for h in hooks if h.get("id") != hook["id"]] + [hook]
        else:
            if not any(h.get("command") == ch["command"] for h in hooks):
                raise TeamError(
                    f"{ch['member_name']} has no hook that runs {ch['command']!r}."
                )
            hooks = [h for h in hooks if h.get("command") != ch["command"]]
        await _set_config(session, ch["member"], {"hooks": hooks}, person)
        return {"member": ch["member"], "before": before}
    if op in ("skill_add", "skill_remove"):
        from .. import config_model as cm

        skills = list(cfg.get("skills") or [])
        before = copy.deepcopy(skills)
        if op == "skill_add":
            content = (
                f"---\nname: {ch['name']}\ndescription: {ch['description']}\n---\n\n"
                + ch["content"]
            )
            skill = cm.normalize_skill({"name": ch["name"], "content": content})
            skills = [s for s in skills if s.get("name") != ch["name"]] + [skill]
        else:
            if not any(s.get("name") == ch["name"] for s in skills):
                raise TeamError(
                    f"{ch['member_name']} has no skill {ch['name']!r} of its own."
                )
            skills = [s for s in skills if s.get("name") != ch["name"]]
        await _set_config(session, ch["member"], {"skills": skills}, person)
        return {"member": ch["member"], "before": before}
    raise TeamError(f"Unknown change {op!r}")


def _switch_skill(
    rows: list[dict], skill: str, on: bool, member_id: str | None
) -> list[dict]:
    """The project's board-skill switches after one change (the UI's `withBoardSkill`, on the server)."""
    rows = [r for r in rows if isinstance(r, dict)]
    row = next((r for r in rows if r.get("skill") == skill), None)
    if row is None:
        row = {"skill": skill, "on": True, "members_on": [], "members_off": []}
        rows.append(row)
    if member_id is None:
        row["on"] = on
    else:
        on_list = [m for m in row.get("members_on") or [] if m != member_id]
        off_list = [m for m in row.get("members_off") or [] if m != member_id]
        (on_list if on else off_list).append(member_id)
        row["members_on"], row["members_off"] = on_list, off_list
    return rows


# --------------------------------------------------------------------------------------------- undo


async def undo(session: AsyncSession, a: dict, person: str) -> str | None:
    """Put one team change back; returns what could not be (None when it was)."""
    from .. import members as svc_members
    from .. import packs
    from .. import plugins as svc_plugins

    op = a["op"]
    try:
        if op == "ai_from_pack":
            used = (
                await session.exec(select(AiRun).where(AiRun.member_id == a["member"]))
            ).first()
            if used is not None:
                return f"{a.get('member_name')} has worked since, so it stays"
            await svc_members.remove(session, a["member"], by=person)
            return None
        if op == "ai_role":
            await _set_config(session, a["member"], {"role": a.get("before")}, person)
            return None
        if op == "ai_edit":
            before = dict(a.get("before") or {})
            data = {k: v for k, v in before.items() if k != "effort"}
            if "effort" in before:
                data["config"] = {"effort": before["effort"]}
            await svc_members.update(session, a["member"], data, by=person)
            return None
        if op == "ai_pack_update":
            await packs.revert_member(session, a["member"], by=person)
            return None
        if op == "plugin_install":
            row = await session.get(AiPlugin, a["plugin_id"])
            if row is not None:
                await svc_plugins.remove(session, row)
            return None
        if op == "plugin_switch":
            row = await session.get(AiPlugin, a["plugin_id"])
            if row is None:
                return "The plugin was removed since"
            await svc_plugins.set_member(session, row, a["member"], a.get("before"))
            return None
        if op == "board_skill":
            settings = await get_settings(session, (await _project_of(session, a)))
            if (ops.get(settings).get("board_skills") or []) != a.get("after"):
                return "The board's skills were switched again since, so they stay as they are"
            ops.update(settings, {"board_skills": a.get("before") or []})
            session.add(settings)
            await session.commit()
            return None
        key = {
            "mcp_add": "mcp_servers",
            "mcp_remove": "mcp_servers",
            "hook_add": "hooks",
            "hook_remove": "hooks",
            "skill_add": "skills",
            "skill_remove": "skills",
        }.get(op)
        if key:
            await _set_config(
                session, a["member"], {key: a.get("before") or []}, person
            )
            return None
    except (TeamError, ValueError) as exc:
        return str(exc)
    return None


async def _project_of(session, a: dict) -> str:
    return a.get("project_id") or ""


# --------------------------------------------------------------------------------------------- what the AI reads


async def context_block(session: AsyncSession, project_id: str) -> str:
    """The AI team as it is set up, what it could add and the switches, for the Board AI to advise from."""
    from .. import board_skills, packs
    from .. import plugins as svc_plugins

    settings = await get_settings(session, project_id)
    cfg_ops = ops.get(settings)
    manages = bool((cfg_ops.get("board_ai") or {}).get("manages_team"))
    members = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    installed = (
        await session.exec(select(AiPlugin).where(AiPlugin.project_id == project_id))
    ).all()
    pack_rows = await packs.list_packs(session, project_id)
    lines = [
        "<ai-team>",
        (
            "The project lets you set up the team yourself: the team changes you list in the block are made by the board "
            'as soon as you answer, with an Undo, so say what you set up ("I added…"), not that it waits for approval.'
            if manages
            else "Team changes you list in the block wait for the person to press Apply (the project's switch “Board AI "
            "manages the AI team” is off): say so."
        ),
        "Members:",
    ]
    for m in members:
        profile = await session.get(AiMember, m.id)
        if profile is None or getattr(profile, "removed_at", None):
            continue
        c = _config(profile)
        role = svc_plugins.role_of(profile) or "no role"
        pack = loads(profile.config, {}).get("pack") or {}
        plug = [p.name for p in installed if svc_plugins.on_for(p, profile)]
        servers = [s.get("name") for s in c.get("mcp_servers") or []]
        hooks = [f"{h.get('event')}: {h.get('command')}" for h in c.get("hooks") or []]
        skills = [s.get("name") for s in c.get("skills") or []]
        on = board_skills.enabled_for(cfg_ops, m.id, svc_plugins.role_of(profile))
        lines.append(
            f"- {m.name} · role {role}"
            + (f" (pack v{pack.get('version')})" if pack.get("key") else "")
            + f" · {profile.provider} {profile.model or ''} · effort {c.get('effort') or '-'}"
            + (" · paused" if profile.paused else "")
            + f" · plugins: {', '.join(plug) or 'none'} · MCP: {', '.join(servers) or 'none'}"
            + f" · hooks: {'; '.join(hooks) or 'none'} · own skills: {', '.join(skills) or 'none'}"
            + f" · board skills on: {len(on)}"
        )
    if not members:
        lines.append("- (none yet)")
    lines.append(
        "Role packs (ai_from_pack, ai_role): "
        + "; ".join(
            f"{p['key']} ({p.get('name')}: {p.get('tagline') or ''})" for p in pack_rows
        )
    )
    lines.append(
        "Installed plugins: " + (", ".join(p.name for p in installed) or "none")
    )
    lines.append(
        "Catalogue (plugin_install key / mcp_add key; for which roles; what for):"
    )
    for c in svc_plugins.CATALOGUE:
        lines.append(
            f"- {c['key']} [{c['kind']}] roles {','.join(c.get('roles') or [])}: {_text(c.get('what'), 140)}"
            + (f" Runs: {_runs(c['server'])}" if c["kind"] == "mcp" else "")
        )
    lines.append(
        "The board's skills (board_skill; a role skill only reaches its role):"
    )
    off = {
        r.get("skill")
        for r in cfg_ops.get("board_skills") or []
        if isinstance(r, dict) and r.get("on") is False
    }
    for s in board_skills.catalog():
        lines.append(
            f"- {s['name']}{' [' + s['role'] + ']' if s.get('role') else ''}{' (off)' if s['name'] in off else ''}"
        )
    lines.append("</ai-team>")
    return "\n".join(lines)
