"""Skills and plugins installed from a source (design/screens/ai-team-process.md, B; plan D1–D3).

A plugin comes from a git URL, a marketplace (a repository with ``.claude-plugin/marketplace.json``) or a folder on
this computer. Installing has no review step (D1): the board records the source and the commit, shows what changed
before an update, and one button puts the previous version back. The installed copy lives in the board's data folder
(``plugin-cache/<id>/<commit>``) and reaches a run as ``--plugin-dir`` (spike S1: skills are used under ``-p``; S3:
hooks run; S4: ten plugins cost no start-up time).

Layouts understood, as found in the catalogue's repositories:
- a plugin at the root (``.claude-plugin/plugin.json``), e.g. ``nextlevelbuilder/ui-ux-pro-max-skill``;
- a marketplace whose entry is a folder (``"source": "./design"``), e.g. ``anthropics/knowledge-work-plugins``;
- a marketplace whose entry lists skills of the repository (``"source": "./", "skills": [...]``), e.g.
  ``anthropics/skills`` — a subset of those skills can be installed as a plugin of its own;
- a folder with ``skills/`` and no manifest, or a single ``SKILL.md``.

Who gets it: the project default (on or off), the roles it is suggested for, and a switch per member.
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import col, select

import database
from models import AiMember, AiPlugin, AiSkillUse

from .store import loads

# The "Suggested for a role" catalogue (D2, D16): what each role is suggested to install.
CATALOGUE: list[dict] = [
    {
        "key": "design",
        "name": "design",
        "kind": "plugin",
        "source": "https://github.com/anthropics/knowledge-work-plugins",
        "plugin": "design",
        "roles": ["designer"],
        "what": "Anthropic's design plugin: design-handoff, design-critique, accessibility-review, ux-copy, design-system, user-research, research-synthesis.",
    },
    {
        "key": "ui-ux-pro-max",
        "name": "ui-ux-pro-max",
        "kind": "plugin",
        "source": "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
        "plugin": "ui-ux-pro-max",
        "roles": ["designer"],
        "what": "UI/UX design intelligence: styles, palettes, font pairings, charts and stack guidelines.",
    },
    {
        "key": "frontend-design",
        "name": "frontend-design",
        "kind": "plugin",
        "source": "https://github.com/anthropics/skills",
        "plugin": "example-skills",
        "skills": ["frontend-design"],
        "roles": ["designer"],
        "what": "Distinctive, production-grade frontend interfaces (Anthropic skills).",
    },
    {
        "key": "canvas-design",
        "name": "canvas-design",
        "kind": "plugin",
        "source": "https://github.com/anthropics/skills",
        "plugin": "example-skills",
        "skills": ["canvas-design"],
        "roles": ["designer"],
        "what": "Visual art and design on a canvas (Anthropic skills).",
    },
    {
        "key": "webapp-testing",
        "name": "webapp-testing",
        "kind": "plugin",
        "source": "https://github.com/anthropics/skills",
        "plugin": "example-skills",
        "skills": ["webapp-testing"],
        "roles": ["designer", "user_tester", "qa"],
        "what": "Testing a local web app with Playwright (Anthropic skills).",
    },
    {
        "key": "figma",
        "name": "Figma MCP",
        "kind": "mcp",
        "server": {"name": "figma", "type": "http", "url": "https://mcp.figma.com/mcp"},
        "roles": ["designer"],
        "what": "Read Figma files and frames (Figma's remote MCP server; signs in through the browser).",
    },
    {
        "key": "chrome-devtools",
        "name": "Chrome DevTools MCP",
        "kind": "mcp",
        "server": {
            "name": "chrome-devtools",
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "chrome-devtools-mcp@latest"],
        },
        "roles": ["dev"],
        "what": "Performance and network debugging in a real Chrome.",
    },
    {
        "key": "playwright",
        "name": "Playwright MCP",
        "kind": "mcp",
        "server": {
            "name": "playwright",
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@playwright/mcp@latest", "--isolated"],
        },
        "roles": ["user_tester", "qa"],
        "what": "A fresh browser per run, driven through the page's structure; can emulate a phone.",
    },
]


class PluginError(RuntimeError):
    """A plugin could not be read, installed or updated."""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def cache_root() -> Path:
    """``plugin-cache`` beside the database."""
    base = database.get_db_path().parent / "plugin-cache"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _run(
    args: list[str], cwd: str | None = None, timeout: float = 300
) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )


def _clone(url: str, ref: str | None, into: str) -> str:
    """Shallow clone of `url` at `ref` (a tag, branch or commit); returns the commit."""
    if ref and re.fullmatch(r"[0-9a-f]{7,40}", ref):
        out = _run(["git", "clone", "-q", url, into])
        if out.returncode == 0:
            out = _run(["git", "checkout", "-q", ref], cwd=into)
    else:
        out = _run(
            [
                "git",
                "clone",
                "-q",
                "--depth",
                "1",
                *(["--branch", ref] if ref else []),
                url,
                into,
            ]
        )
    if out.returncode != 0:
        raise PluginError(
            f"Could not get {url}{'@' + ref if ref else ''}: {out.stderr.strip()[:240]}"
        )
    return _run(["git", "rev-parse", "HEAD"], cwd=into).stdout.strip()


def _manifest(folder: Path, name: str) -> dict:
    try:
        return json.loads(
            (folder / ".claude-plugin" / name).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return {}


def _skill_dirs(folder: Path) -> list[Path]:
    out = []
    for skill_md in folder.rglob("SKILL.md"):
        if ".git" in skill_md.parts or "node_modules" in skill_md.parts:
            continue
        out.append(skill_md.parent)
    return sorted(out)


def _copy(src: Path, dst: Path) -> None:
    shutil.copytree(
        src,
        dst,
        ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__"),
        dirs_exist_ok=True,
    )


def build(
    checkout: Path,
    *,
    plugin: str | None = None,
    skills: list[str] | None = None,
    into: Path,
) -> dict:
    """Make an installable plugin folder `into` from a checkout (see the layouts in the module doc).

    Returns:
        {name, version, description, skills: [names], hooks, mcp, size_bytes, choices: [marketplace entries]}
    """
    market = _manifest(checkout, "marketplace.json")
    entries = market.get("plugins") or []
    root_manifest = _manifest(checkout, "plugin.json")
    source_dir: Path | None = None
    picked_skills: list[Path] | None = None
    meta: dict = {}
    if plugin and entries:
        entry = next((e for e in entries if e.get("name") == plugin), None)
        if entry is None:
            raise PluginError(
                f"The marketplace has no plugin called {plugin}. It has: {', '.join(e.get('name', '?') for e in entries)[:200]}"
            )
        meta = {
            "name": entry.get("name"),
            "version": entry.get("version"),
            "description": entry.get("description"),
        }
        src = entry.get("source")
        if isinstance(src, dict):
            raise PluginError(
                f"{plugin} lives in another repository ({src.get('url')}); install it from there."
            )
        base = (checkout / (src or "./")).resolve()
        if not str(base).startswith(str(checkout.resolve())):
            raise PluginError("The marketplace points outside its own repository.")
        listed = entry.get("skills")
        if isinstance(listed, list) and listed:
            picked_skills = [(checkout / s).resolve() for s in listed]
        elif (base / ".claude-plugin" / "plugin.json").is_file() or (
            base / "skills"
        ).is_dir():
            source_dir = base
        else:
            picked_skills = _skill_dirs(base)
    elif root_manifest:
        source_dir = checkout
        meta = {k: root_manifest.get(k) for k in ("name", "version", "description")}
    elif entries and not plugin:
        return {
            "choices": [
                {"name": e.get("name"), "description": e.get("description")}
                for e in entries
            ]
        }
    elif (checkout / "skills").is_dir():
        picked_skills = _skill_dirs(checkout / "skills")
    elif (checkout / "SKILL.md").is_file():
        picked_skills = [checkout]
    else:
        raise PluginError("No plugin, marketplace or skill was found there.")
    if skills:
        wanted = set(skills)
        pool = (
            picked_skills
            if picked_skills is not None
            else _skill_dirs(source_dir or checkout)
        )
        picked_skills = [p for p in pool if p.name in wanted]
        source_dir = None
        if not picked_skills:
            raise PluginError(f"None of {', '.join(skills)} was found there.")
        if len(skills) == 1:
            meta["name"] = skills[0]
    into.mkdir(parents=True, exist_ok=True)
    if source_dir is not None:
        _copy(source_dir, into)
    else:
        for skill in picked_skills or []:
            _copy(skill, into / "skills" / skill.name)
    name = (
        re.sub(
            r"[^a-z0-9-]+", "-", (meta.get("name") or plugin or into.name).lower()
        ).strip("-")
        or "plugin"
    )
    manifest_path = into / ".claude-plugin" / "plugin.json"
    if not manifest_path.is_file():
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps(
                {
                    "name": name,
                    "version": meta.get("version") or "0.0.0",
                    "description": meta.get("description") or "",
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    final = _manifest(into, "plugin.json")
    hooks = 0
    try:
        hooks_data = json.loads(
            (into / "hooks" / "hooks.json").read_text(encoding="utf-8")
        )
        hooks = sum(len(v) for v in (hooks_data.get("hooks") or {}).values())
    except (OSError, ValueError, AttributeError):
        pass
    mcp = 0
    try:
        mcp = len(
            (
                json.loads((into / ".mcp.json").read_text(encoding="utf-8")).get(
                    "mcpServers"
                )
                or {}
            )
        )
    except (OSError, ValueError):
        pass
    size = sum(f.stat().st_size for f in into.rglob("*") if f.is_file())
    return {
        "name": final.get("name") or name,
        "version": final.get("version") or meta.get("version"),
        "description": final.get("description") or meta.get("description"),
        "skills": sorted({d.name for d in _skill_dirs(into)}),
        "hooks": hooks,
        "mcp": mcp,
        "size_bytes": size,
    }


def _fetch(
    source_kind: str, source: str, ref: str | None, workdir: str
) -> tuple[Path, str | None]:
    """The source as a local checkout: (folder, commit or None for a plain folder)."""
    if source_kind == "folder":
        folder = Path(os.path.expanduser(source))
        if not folder.is_dir():
            raise PluginError(f"No such folder: {source}")
        commit = None
        if (folder / ".git").exists():
            commit = (
                _run(["git", "rev-parse", "HEAD"], cwd=str(folder)).stdout.strip()
                or None
            )
        return folder, commit
    dest = Path(workdir) / "checkout"
    return dest, _clone(source, ref, str(dest))


async def preview(
    source_kind: str,
    source: str,
    *,
    ref: str | None = None,
    plugin: str | None = None,
    skills: list[str] | None = None,
) -> dict:
    """What would be installed, without installing: name, version, skills, hooks, MCP servers, size, the commit."""

    def go() -> dict:
        with tempfile.TemporaryDirectory(prefix="kanban-plugin-") as tmp:
            checkout, commit = _fetch(source_kind, source, ref, tmp)
            info = build(
                checkout, plugin=plugin, skills=skills, into=Path(tmp) / "built"
            )
            return {**info, "commit": commit}

    return await asyncio.to_thread(go)


async def install(
    session,
    project_id: str,
    *,
    source_kind: str,
    source: str,
    ref: str | None = None,
    plugin: str | None = None,
    skills: list[str] | None = None,
    roles: list[str] | None = None,
    default_on: bool = False,
    by: str,
) -> AiPlugin:
    """Install a plugin for the project (no review step, D1): copied into the board's cache at its commit."""
    if source_kind not in ("git", "marketplace", "folder"):
        raise PluginError("A source is a git URL, a marketplace or a folder.")

    with tempfile.TemporaryDirectory(prefix="kanban-plugin-") as tmp:
        checkout, commit = await asyncio.to_thread(
            _fetch, source_kind, source, ref, tmp
        )
        staging_path = Path(tmp) / "built"
        info = await asyncio.to_thread(
            build, checkout, plugin=plugin, skills=skills, into=staging_path
        )
        if info.get("choices"):
            raise PluginError("This is a marketplace: pick which plugin to install.")
        same = (
            await session.exec(
                select(AiPlugin).where(
                    AiPlugin.project_id == project_id, AiPlugin.name == info["name"]
                )
            )
        ).first()
        if same is not None:
            raise PluginError(f"{info['name']} is already installed on this project.")
        row = AiPlugin(
            project_id=project_id,
            name=info["name"],
            source_kind=source_kind,
            source=source,
            ref=ref,
            plugin=plugin,
            skills_wanted=json.dumps(skills or []),
            commit=commit,
            version=info.get("version"),
            description=info.get("description"),
            skills=json.dumps(info["skills"]),
            hooks=info["hooks"],
            mcp=info["mcp"],
            size_bytes=info["size_bytes"],
            default_on=default_on,
            roles=json.dumps(roles or []),
            installed_by=by,
            pinned=bool(ref and re.fullmatch(r"[0-9a-f]{7,40}", ref)),
        )
        dest = cache_root() / row.id / (commit or "folder")
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        await asyncio.to_thread(shutil.copytree, staging_path, dest)
        row.path = str(dest)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def _reinstall(
    session, row: AiPlugin, *, ref: str | None, keep_previous: bool
) -> AiPlugin:
    with tempfile.TemporaryDirectory(prefix="kanban-plugin-") as tmp:
        checkout, commit = await asyncio.to_thread(
            _fetch, row.source_kind, row.source, ref, tmp
        )
        staging_path = Path(tmp) / "built"
        wanted = json.loads(row.skills_wanted or "[]") or None
        info = await asyncio.to_thread(
            build, checkout, plugin=row.plugin, skills=wanted, into=staging_path
        )
        dest = (
            cache_root()
            / row.id
            / (commit or f"folder-{int(datetime.now(UTC).timestamp())}")
        )
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        await asyncio.to_thread(shutil.copytree, staging_path, dest)
    if keep_previous and row.path:
        row.previous = json.dumps(
            {
                "path": row.path,
                "commit": row.commit,
                "version": row.version,
                "skills": loads(row.skills, []),
            }
        )
    elif row.path and row.path != str(dest):
        shutil.rmtree(row.path, ignore_errors=True)
    row.path = str(dest)
    row.commit = commit
    row.version = info.get("version")
    row.skills = json.dumps(info["skills"])
    row.hooks = info["hooks"]
    row.mcp = info["mcp"]
    row.size_bytes = info["size_bytes"]
    row.updated_at = _now()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def latest_commit(row: AiPlugin) -> str | None:
    """The source's newest commit (on its ref, or the default branch), or None for a folder or when it cannot tell."""
    if row.source_kind == "folder":
        return None
    out = await asyncio.to_thread(
        _run, ["git", "ls-remote", row.source, row.ref or "HEAD"], None, 60
    )
    first = out.stdout.split()
    return first[0] if out.returncode == 0 and first else None


async def check_update(row: AiPlugin) -> dict:
    """Whether a newer version is out (never applied on its own); a pinned plugin is never offered one."""
    if row.pinned:
        return {"update": False, "pinned": True}
    newest = await latest_commit(row)
    return {
        "update": bool(newest and row.commit and newest != row.commit),
        "latest": newest,
        "current": row.commit,
    }


async def changes(row: AiPlugin) -> dict:
    """What an update would change: files added, removed and changed between the installed copy and the newest."""
    with tempfile.TemporaryDirectory(prefix="kanban-plugin-") as tmp:
        checkout, commit = await asyncio.to_thread(
            _fetch,
            row.source_kind,
            row.source,
            None if not row.pinned else row.ref,
            tmp,
        )
        built = Path(tmp) / "built"
        wanted = json.loads(row.skills_wanted or "[]") or None
        await asyncio.to_thread(
            build, checkout, plugin=row.plugin, skills=wanted, into=built
        )
        old = (
            {
                str(p.relative_to(row.path)): p.read_bytes()
                for p in Path(row.path).rglob("*")
                if p.is_file()
            }
            if row.path and Path(row.path).is_dir()
            else {}
        )
        new = {
            str(p.relative_to(built)): p.read_bytes()
            for p in built.rglob("*")
            if p.is_file()
        }
    return {
        "commit": commit,
        "added": sorted(set(new) - set(old)),
        "removed": sorted(set(old) - set(new)),
        "changed": sorted(k for k in set(new) & set(old) if new[k] != old[k]),
    }


async def update(session, row: AiPlugin) -> AiPlugin:
    """Install the newest version; the previous one is kept so one button can put it back."""
    if row.pinned:
        raise PluginError(f"{row.name} is pinned: unpin it to update.")
    return await _reinstall(session, row, ref=row.ref, keep_previous=True)


async def rollback(session, row: AiPlugin) -> AiPlugin:
    """Put the previous version back."""
    prev = loads(row.previous, None)
    if not prev or not Path(prev.get("path", "")).is_dir():
        raise PluginError("There is no previous version to put back.")
    current = {
        "path": row.path,
        "commit": row.commit,
        "version": row.version,
        "skills": loads(row.skills, []),
    }
    row.path, row.commit, row.version = (
        prev["path"],
        prev.get("commit"),
        prev.get("version"),
    )
    row.skills = json.dumps(prev.get("skills") or [])
    row.previous = json.dumps(current)
    row.updated_at = _now()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def reload(session, row: AiPlugin) -> AiPlugin:
    """Re-read the source (a folder's current files, or the same commit of a repository)."""
    return await _reinstall(
        session,
        row,
        ref=row.commit if row.source_kind != "folder" else None,
        keep_previous=False,
    )


async def reset(session, row: AiPlugin) -> AiPlugin:
    """Back to the catalogue version: the recorded commit, freshly copied, dropping anything changed locally."""
    return await reload(session, row)


async def pin(session, row: AiPlugin, on: bool) -> AiPlugin:
    """Pin to the installed commit (no update is offered until unpinned)."""
    row.pinned = on
    if on and row.commit:
        row.ref = row.commit
    elif not on and row.ref and re.fullmatch(r"[0-9a-f]{7,40}", row.ref):
        row.ref = None
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def remove(session, row: AiPlugin) -> None:
    """Uninstall: the row and every cached copy."""
    shutil.rmtree(cache_root() / row.id, ignore_errors=True)
    await session.delete(row)
    await session.commit()


def role_of(profile: AiMember) -> str | None:
    """The member's role pack key (set when it was made from a pack), or None."""
    cfg = loads(profile.config, {}) or {}
    return cfg.get("role") or (cfg.get("pack") or {}).get("key")


def on_for(row: AiPlugin, profile: AiMember) -> bool:
    """Whether a member gets the plugin: its own switch, else the project default, else its role."""
    overrides = loads(row.members, {}) or {}
    if profile.id in overrides:
        return bool(overrides[profile.id])
    if row.default_on:
        return True
    return role_of(profile) in (loads(row.roles, []) or [])


async def dirs_for(session, profile: AiMember) -> list[str]:
    """The plugin folders a member's run loads."""
    rows = (
        await session.exec(
            select(AiPlugin).where(col(AiPlugin.project_id).in_([profile.project_id]))
        )
    ).all()
    return [
        r.path for r in rows if r.path and Path(r.path).is_dir() and on_for(r, profile)
    ]


async def set_member(
    session, row: AiPlugin, member_id: str, on: bool | None
) -> AiPlugin:
    """A member's own switch (None: follow the project default again)."""
    overrides = loads(row.members, {}) or {}
    if on is None:
        overrides.pop(member_id, None)
    else:
        overrides[member_id] = on
    row.members = json.dumps(overrides)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def usage(session, project_id: str) -> dict[str, dict]:
    """Real use of each plugin's skills, from the run stream: {plugin name: {uses, by_member: {id: n}, last}}."""
    out: dict[str, dict] = {}
    for use in (
        await session.exec(
            select(AiSkillUse).where(AiSkillUse.project_id == project_id)
        )
    ).all():
        name = use.plugin or use.name
        row = out.setdefault(name, {"uses": 0, "by_member": {}, "last": None})
        row["uses"] += 1
        if use.member_id:
            row["by_member"][use.member_id] = row["by_member"].get(use.member_id, 0) + 1
        row["last"] = max(row["last"] or "", use.at)
    return out


def to_dict(row: AiPlugin, used: dict | None = None) -> dict:
    """A plugin for the API."""
    return {
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "source_kind": row.source_kind,
        "source": row.source,
        "ref": row.ref,
        "plugin": row.plugin,
        "commit": row.commit,
        "version": row.version,
        "description": row.description,
        "skills": loads(row.skills, []),
        "hooks": row.hooks,
        "mcp": row.mcp,
        "size_bytes": row.size_bytes,
        "pinned": row.pinned,
        "default_on": row.default_on,
        "roles": loads(row.roles, []),
        "members": loads(row.members, {}),
        "has_previous": bool(loads(row.previous, None)),
        "installed_by": row.installed_by,
        "installed_at": row.installed_at,
        "updated_at": row.updated_at,
        "used": used or {"uses": 0, "by_member": {}, "last": None},
    }
