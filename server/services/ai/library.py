"""The board's shared library of skills, instruction snippets, MCP servers and tools (design/screens/ai-provider-config.md, E).

An item is defined once and attached to many AI members. Every edit makes a new version; a member keeps the version
it was attached at until a person updates it ("updates never apply on their own").
"""

import json
import re

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiLibraryItem, AiMember, Member

from . import audit
from . import config_model as cm
from . import config_service as svc
from .config_sync import diff_lines
from .providers import adapter_of, merged_config
from .store import loads, now_iso

TYPES = ("skill", "snippet", "mcp_server", "tool")
TYPE_LABEL = {
    "skill": "Skill",
    "snippet": "Instructions",
    "mcp_server": "MCP server",
    "tool": "Tool",
}
_LIST_KEY = {"skill": "skills", "mcp_server": "mcp_servers", "tool": "custom_tools"}


class LibraryError(ValueError):
    """A library request was refused; the message is shown as is."""


def _check_content(type_: str, name: str, content: str) -> None:
    if not name.strip():
        raise LibraryError("Give the item a name.")
    if not content.strip():
        raise LibraryError("The item has no content.")
    if type_ == "skill":
        fm, _ = cm.split_frontmatter(content)
        if not fm.get("description"):
            raise LibraryError(
                "A skill needs front matter with a description (--- name / description ---)."
            )
        if not cm.NAME_RE.match(name):
            raise LibraryError(
                "A skill name is lowercase letters, digits, - or _ (max 64)."
            )
    elif type_ == "snippet":
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
            raise LibraryError(
                "A snippet name is letters, digits, - or _ (max 64), so it can be used in an include marker."
            )
    elif type_ == "mcp_server":
        data, err = cm.parse_json(content)
        if err:
            raise LibraryError(f"The server must be a JSON object: {err['message']}")
        if data.get("type") == "http" and not str(data.get("url", "")).startswith(
            ("http://", "https://")
        ):
            raise LibraryError("An http server needs a url.")
        if (
            data.get("type", "stdio") == "stdio"
            and not str(data.get("command", "")).strip()
        ):
            raise LibraryError("A stdio server needs a command.")
        if not cm.SERVER_RE.match(name):
            raise LibraryError("A server name is letters, digits, - or _.")
    elif type_ == "tool":
        res = cm.check_tool_spec(content)
        if not res["ok"]:
            p = res["problems"][0]
            raise LibraryError(
                f"The tool file has a problem: {p['path']} {p['message']}"
            )
    else:
        raise LibraryError(f"Type must be one of {', '.join(TYPES)}.")


def _links(cfg: dict) -> list[tuple[str, dict, dict]]:
    """Every library link in a configuration: (type, item, {id, version})."""
    out = []
    for type_, key in _LIST_KEY.items():
        for it in cfg.get(key) or []:
            if it.get("library"):
                out.append((type_, it, it["library"]))
    for it in cfg.get("remote_mcp") or []:
        if it.get("library"):
            out.append(("mcp_server", it, it["library"]))
    for sn in cfg.get("snippets") or []:
        out.append(("snippet", sn, {"id": sn["library_id"], "version": sn["version"]}))
    return out


async def _members(
    session: AsyncSession, project_id: str
) -> list[tuple[Member, AiMember, dict]]:
    return [
        (m, p, merged_config(loads(p.config, {})))
        for m, p in await svc.members_of(session, project_id)
    ]


def _row(item: AiLibraryItem, users: list[dict]) -> dict:
    behind = [u for u in users if u["version"] < item.version]
    return {
        "id": item.id,
        "type": item.type,
        "type_label": TYPE_LABEL[item.type],
        "name": item.name,
        "description": item.description,
        "version": item.version,
        "used_by": len(users),
        "behind": len(behind),
        "updated_at": item.updated_at,
        "created_by": item.created_by,
    }


async def usage(session: AsyncSession, item: AiLibraryItem) -> list[dict]:
    """The members using an item: [{member_id, name, provider, version, mode, behind}]."""
    from .providers import capabilities

    out = []
    for m, p, cfg in await _members(session, item.project_id):
        for type_, it, link in _links(cfg):
            if link["id"] != item.id:
                continue
            adapter = adapter_of(p.provider)
            group = {
                "skill": "skills",
                "snippet": "instructions",
                "mcp_server": "mcp_servers",
                "tool": "tools",
            }[type_]
            cap = capabilities(p.provider).get(group)
            mode = (
                "skipped"
                if cap == "not_supported"
                else (
                    "documented"
                    if cap == "documented" or it.get("mode") == "documented"
                    else "synced"
                )
            )
            out.append(
                {
                    "member_id": m.id,
                    "name": m.name,
                    "provider": p.provider,
                    "adapter": adapter,
                    "version": int(link["version"]),
                    "mode": mode,
                    "behind": int(link["version"]) < item.version,
                }
            )
    return out


async def list_items(
    session: AsyncSession,
    project_id: str,
    type_: str | None = None,
    q: str | None = None,
) -> dict:
    """The library list (E1) with counts per type."""
    items = (
        await session.exec(
            select(AiLibraryItem)
            .where(AiLibraryItem.project_id == project_id)
            .order_by(col(AiLibraryItem.name))
        )
    ).all()
    counts = {t: 0 for t in TYPES}
    rows = []
    members = await _members(session, project_id)
    for it in items:
        counts[it.type] += 1
        users = []
        for m, p, cfg in members:
            for _, item_cfg, link in _links(cfg):
                if link["id"] == it.id:
                    users.append({"member_id": m.id, "version": int(link["version"])})
        if type_ and it.type != type_:
            continue
        if q and q.lower() not in f"{it.name} {it.description}".lower():
            continue
        rows.append(_row(it, users))
    return {"items": rows, "counts": {"all": len(items), **counts}}


async def get_item(session: AsyncSession, item_id: str) -> AiLibraryItem:
    """One item (raises when it does not exist)."""
    item = await session.get(AiLibraryItem, item_id)
    if item is None:
        raise LibraryError("Library item not found.")
    return item


async def describe(session: AsyncSession, item: AiLibraryItem) -> dict:
    """An item with its content, history and users."""
    users = await usage(session, item)
    history = [
        {k: h.get(k) for k in ("version", "at", "by", "note")}
        for h in loads(item.history, [])
    ]
    return {
        **_row(item, users),
        "content": item.content,
        "history": history[::-1],
        "users": users,
    }


def content_at(item: AiLibraryItem, version: int) -> str | None:
    """The content of a version (None when unknown)."""
    if version == item.version:
        return item.content
    for h in loads(item.history, []):
        if h["version"] == version:
            return h["content"]
    return None


async def create(
    session: AsyncSession,
    project_id: str,
    *,
    type_: str,
    name: str,
    description: str,
    content: str,
    by: str,
) -> AiLibraryItem:
    """Add an item (version 1)."""
    name = name.strip()
    _check_content(type_, name, content)
    dup = (
        await session.exec(
            select(AiLibraryItem).where(
                AiLibraryItem.project_id == project_id,
                AiLibraryItem.type == type_,
                AiLibraryItem.name == name,
            )
        )
    ).first()
    if dup:
        raise LibraryError(
            f"There is already a {TYPE_LABEL[type_].lower()} called “{name}” in the library."
        )
    item = AiLibraryItem(
        project_id=project_id,
        type=type_,
        name=name,
        description=description.strip()[:300],
        content=content,
        created_by=by,
    )
    session.add(item)
    await session.commit()
    await session.refresh(item)
    await audit.record(
        project_id,
        "library_item_created",
        "info",
        on_behalf_of=by,
        target=item.id,
        detail={"name": name, "type": type_},
    )
    return item


async def new_version(
    session: AsyncSession,
    item_id: str,
    *,
    content: str,
    description: str | None,
    note: str | None,
    by: str,
) -> AiLibraryItem:
    """Save an edit as the next version (the old one is kept in the history)."""
    item = await get_item(session, item_id)
    _check_content(item.type, item.name, content)
    if content == item.content and (
        description is None or description == item.description
    ):
        raise LibraryError("Nothing changed.")
    history = loads(item.history, [])
    history.append(
        {
            "version": item.version,
            "content": item.content,
            "description": item.description,
            "at": item.updated_at,
            "by": item.created_by,
            "note": note,
        }
    )
    item.history = json.dumps(history)
    item.version += 1
    item.content = content
    if description is not None:
        item.description = description.strip()[:300]
    item.created_by = by
    item.updated_at = now_iso()
    session.add(item)
    await session.commit()
    await session.refresh(item)
    await audit.record(
        item.project_id,
        "library_item_versioned",
        "info",
        on_behalf_of=by,
        target=item.id,
        detail={"name": item.name, "version": item.version},
    )
    return item


async def delete(session: AsyncSession, item_id: str, by: str) -> None:
    """Remove an item that no member uses."""
    item = await get_item(session, item_id)
    users = await usage(session, item)
    if users:
        raise LibraryError(
            f"{len(users)} member(s) use “{item.name}”. Detach it from them first."
        )
    await session.delete(item)
    await session.commit()
    await audit.record(
        item.project_id,
        "library_item_deleted",
        "info",
        on_behalf_of=by,
        target=item_id,
        detail={"name": item.name},
    )


def version_diff(item: AiLibraryItem, from_version: int) -> dict:
    """The change between a version and the latest, for “Review changes”."""
    old = content_at(item, from_version)
    if old is None:
        raise LibraryError("That version no longer exists.")
    return {
        "from_version": from_version,
        "to_version": item.version,
        "changes": diff_lines(old, item.content, context=3),
    }


# ---------------------------------------------------------------------------
# Attach / update inside a configuration (pure: the caller saves the result)
# ---------------------------------------------------------------------------


def _server_from(item: AiLibraryItem) -> dict:
    data = json.loads(item.content)
    return {
        "name": item.name,
        "type": data.get("type") or "stdio",
        "command": data.get("command", ""),
        "args": data.get("args") or [],
        "url": data.get("url", ""),
        "env": data.get("env") or [],
        "headers": data.get("headers") or [],
        "description": item.description,
    }


def attach(item: AiLibraryItem, cfg: dict, provider: str) -> dict:
    """The configuration with the library item attached at its latest version.

    Raises:
        LibraryError: Already attached, or the item cannot run on this adapter at all (a stdio server on an API agent).
    """
    cfg = json.loads(json.dumps(cfg))
    link = {"id": item.id, "version": item.version}
    adapter = adapter_of(provider)
    if any(lk["id"] == item.id for _, _, lk in _links(cfg)):
        raise LibraryError(f"“{item.name}” is already attached to this member.")
    if item.type == "skill":
        content = item.content
        fm, _ = cm.split_frontmatter(content)
        s = cm.normalize_skill(
            {
                "content": content,
                "name": item.name,
                "library": link,
                "mode": "documented" if adapter == "antigravity" else "synced",
            }
        )
        if any(x["name"] == s["name"] for x in cfg["skills"]):
            raise LibraryError(f"This member already has a skill called “{s['name']}”.")
        cfg["skills"].append(s)
    elif item.type == "snippet":
        cfg["snippets"].append(
            {
                "library_id": item.id,
                "name": item.name,
                "version": item.version,
                "content": item.content,
            }
        )
        marker = f"<!-- kanban:include {item.name}@v{item.version} -->"
        cfg["instructions"] = (
            (cfg.get("instructions") or "").rstrip()
            + ("\n\n" if (cfg.get("instructions") or "").strip() else "")
            + marker
        )
    elif item.type == "mcp_server":
        srv = _server_from(item)
        if adapter == "api":
            if srv["type"] != "http":
                raise LibraryError(
                    "stdio servers cannot run on the board server. Use a remote HTTP URL, or attach this server to a local-runner member such as Claude Code."
                )
            if any(x["name"] == srv["name"] for x in cfg["remote_mcp"]):
                raise LibraryError(
                    f"This member already has a server called “{srv['name']}”."
                )
            cfg["remote_mcp"].append(
                cm.normalize_remote(
                    {
                        "name": srv["name"],
                        "url": srv["url"],
                        "headers": srv["headers"],
                        "library": link,
                    }
                )
            )
        else:
            if any(x["name"] == srv["name"] for x in cfg["mcp_servers"]):
                raise LibraryError(
                    f"This member already has a server called “{srv['name']}”."
                )
            cfg["mcp_servers"].append(
                cm.normalize_server(
                    {
                        **srv,
                        "library": link,
                        "mode": "documented" if adapter == "antigravity" else "synced",
                    }
                )
            )
    elif item.type == "tool":
        t = cm.normalize_tool({"spec": item.content, "library": link})
        if any(x["name"] == t["name"] for x in cfg["custom_tools"]):
            raise LibraryError(f"This member already has a tool called “{t['name']}”.")
        cfg["custom_tools"].append(t)
    return merged_config(cfg)


def update_in(item: AiLibraryItem, cfg: dict) -> dict:
    """The configuration with every copy of the item brought to its latest version (local on/off and secrets stay)."""
    cfg = json.loads(json.dumps(cfg))
    link = {"id": item.id, "version": item.version}
    if item.type == "skill":
        for s in cfg["skills"]:
            if (s.get("library") or {}).get("id") == item.id:
                s.update(
                    cm.normalize_skill(
                        {**s, "content": item.content, "name": "", "library": link}
                    )
                )
    elif item.type == "snippet":
        for sn in cfg["snippets"]:
            if sn["library_id"] == item.id:
                old = f"{sn['name']}@v{sn['version']}"
                sn.update(
                    {
                        "name": item.name,
                        "version": item.version,
                        "content": item.content,
                    }
                )
                cfg["instructions"] = (cfg.get("instructions") or "").replace(
                    old, f"{item.name}@v{item.version}"
                )
    elif item.type == "mcp_server":
        srv = _server_from(item)
        for s in cfg["mcp_servers"]:
            if (s.get("library") or {}).get("id") == item.id:
                s.update(
                    {
                        k: srv[k]
                        for k in (
                            "type",
                            "command",
                            "args",
                            "url",
                            "env",
                            "headers",
                            "description",
                        )
                    }
                )
                s["library"] = link
        for s in cfg["remote_mcp"]:
            if (s.get("library") or {}).get("id") == item.id:
                s["url"] = srv["url"]
                s["library"] = link
    elif item.type == "tool":
        for t in cfg["custom_tools"]:
            if (t.get("library") or {}).get("id") == item.id:
                t["spec"] = item.content
                t["library"] = link
    return merged_config(cfg)


def detach(item_id: str, cfg: dict) -> dict:
    """Remove every copy of a library item from a configuration."""
    cfg = json.loads(json.dumps(cfg))
    for key in ("skills", "mcp_servers", "custom_tools", "remote_mcp"):
        cfg[key] = [
            x for x in cfg[key] if (x.get("library") or {}).get("id") != item_id
        ]
    gone = [s for s in cfg["snippets"] if s["library_id"] == item_id]
    cfg["snippets"] = [s for s in cfg["snippets"] if s["library_id"] != item_id]
    for s in gone:
        cfg["instructions"] = re.sub(
            rf"\n*<!--\s*kanban:include\s+{re.escape(s['name'])}@v\d+\s*-->",
            "",
            cfg.get("instructions") or "",
        )
    return merged_config(cfg)


async def propagate(
    session: AsyncSession, item_id: str, member_ids: list[str], by: str
) -> dict:
    """Update the saved configuration of the given members to the item's latest version (E2: “Update N members”)."""
    item = await get_item(session, item_id)
    done, failed = [], []
    for mid in member_ids:
        p = await session.get(AiMember, mid)
        if p is None or p.project_id != item.project_id:
            continue
        cfg = update_in(item, merged_config(loads(p.config, {})))
        errors = [
            e for e in cm.validate_config(cfg, p.provider) if e["severity"] == "error"
        ]
        if errors:
            failed.append({"member_id": mid, "message": errors[0]["message"]})
            continue
        p.config = json.dumps(cfg)
        p.updated_at = now_iso()
        session.add(p)
        await session.commit()
        await svc.bump_version(session, mid)
        done.append(mid)
    if done:
        await audit.record(
            item.project_id,
            "library_item_propagated",
            "info",
            on_behalf_of=by,
            target=item.id,
            detail={"name": item.name, "version": item.version, "members": len(done)},
        )
    return {"updated": done, "failed": failed}
