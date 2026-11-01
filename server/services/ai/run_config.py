"""A member's configuration loaded per run through CLI flags, not written into the repository (plan D5; design
wave 2 B3 "Leaving the synced folder").

Spikes S1–S4 (docs/specs/ai-claude-code-plan.md §4) showed that with Claude Code 2.1.316 a plugin folder passed with
``--plugin-dir`` works under ``-p``: its skills are used (the ``Skill`` tool), its hooks run, ``--resume`` accepts a
changed list, and ten plugins cost no measurable start-up time. So the member's synced skills, subagents and confirmed
hooks become one plugin folder of its own in the board's data folder, and its instructions go into the system prompt.
The MCP servers already travel by ``--mcp-config``, the allow and deny rules by ``--allowedTools``/``--disallowedTools``.

The same units the board would have written (``config_sync.desired_specs``) are used, so what a member gets does not
depend on where it is delivered.
"""

import json
import re
import shutil
import uuid
from pathlib import Path

import database
from models import AiMember

from . import config_model as cm
from . import config_sync as cs
from .providers import merged_config
from .store import loads


def root() -> Path:
    """``ai-plugins`` beside the database (a folder per member, and in it one per run)."""
    base = database.get_db_path().parent / "ai-plugins"
    base.mkdir(parents=True, exist_ok=True)
    return base


def plugin_name(name: str) -> str:
    """A plugin name Claude Code accepts: lowercase letters, digits and hyphens."""
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return f"kanban-{s or 'member'}"[:60]


def _safe(rel: str) -> bool:
    return not (rel.startswith("/") or ".." in Path(rel).parts)


def _unchanged(entry, now: str) -> bool:
    """Whether a file still holds exactly what the board last wrote (its recorded text, or its hash)."""
    if isinstance(entry, str):
        return now == entry
    if not isinstance(entry, dict):
        return False
    text = (entry.get("units") or {}).get("text")
    if text is not None and now == text:
        return True
    return bool(entry.get("sha")) and cm.sha(now) == entry["sha"]


async def build(
    session,
    profile: AiMember,
    member_name: str,
    board_url: str,
    run_id: str | None = None,
) -> dict:
    """The member's plugin folder (built from its configuration) and the text for the system prompt. The folder is
    the run's own (``ai-plugins/<member>/<run>``): two runs of one member on two tickets at once never rewrite or
    delete each other's; the caller removes it when the run ends.

    Returns:
        {"plugin_dir": str | None, "system": str | None, "skills": [...], "agents": [...], "hooks": int,
        "hooks_pending": bool}
    """
    from . import config_service

    cfg = merged_config(loads(profile.config, {}))
    state = await config_service.get_state(session, profile.id)
    specs, notes = cs.desired_specs(cfg, board_url, loads(state.hooks_ok, None), set())
    folder = root() / profile.id / (run_id or uuid.uuid4().hex)
    if folder.exists():  # a restart inside the same run builds it again
        shutil.rmtree(folder, ignore_errors=True)
    system = None
    skills: set[str] = set()
    agents: list[str] = []
    hooks: dict[str, list] = {}
    files: dict[str, str] = {}
    for spec in specs:
        if spec.path == "CLAUDE.md":
            system = (spec.units or {}).get("block")
        elif spec.path.startswith(".claude/skills/"):
            text = (spec.units or {}).get("text")
            rel = spec.path[len(".claude/") :]
            if text is not None and _safe(rel):
                files[rel] = text
                skills.add(rel.split("/")[1])
        elif spec.path.startswith(".claude/agents/"):
            text = (spec.units or {}).get("text")
            rel = spec.path[len(".claude/") :]
            if text is not None and _safe(rel):
                files[rel] = text
                agents.append(Path(rel).stem)
        elif spec.path == ".claude/settings.json":
            for key in spec.units or {}:
                if not key.startswith("hook:"):
                    continue
                event, matcher, command = key[len("hook:") :].split(cs.SEP, 2)
                entry = {"hooks": [{"type": "command", "command": command}]}
                if matcher:
                    entry["matcher"] = matcher
                hooks.setdefault(event, []).append(entry)
    if not files and not hooks:
        return {
            "plugin_dir": None,
            "system": system,
            "skills": [],
            "agents": [],
            "hooks": 0,
            "hooks_pending": notes.get("hooks_pending", False),
        }
    (folder / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (folder / ".claude-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": plugin_name(member_name),
                "version": "1.0.0",
                "description": f"The skills, subagents and hooks of the AI member {member_name}, loaded by the Kanban board for each run.",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    for rel, text in files.items():
        target = folder / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    if hooks:
        (folder / "hooks").mkdir(parents=True, exist_ok=True)
        (folder / "hooks" / "hooks.json").write_text(
            json.dumps({"hooks": hooks}, indent=2), encoding="utf-8"
        )
    return {
        "plugin_dir": str(folder),
        "system": system,
        "skills": sorted(skills),
        "agents": agents,
        "hooks": sum(len(v) for v in hooks.values()),
        "hooks_pending": notes.get("hooks_pending", False),
    }


async def migration(session, profile: AiMember) -> dict:
    """What the board once wrote into the member's working folder (skills, agents, the CLAUDE.md block, settings,
    .mcp.json), to remove after switching to per-run loading (design B3 "Leaving the synced folder"). Only files whose
    content is still exactly what the board wrote are offered; a person's own files are never listed."""
    from . import config_service

    state = await config_service.get_state(session, profile.id)
    written = loads(state.files, {}) or {}
    folder = Path(profile.working_dir or "").expanduser()
    out = []
    for rel, entry in written.items():
        target = folder / rel
        if not target.is_file():
            continue
        try:
            now = target.read_text(encoding="utf-8")
        except OSError:
            continue
        kind = (entry.get("kind") if isinstance(entry, dict) else None) or _MERGED.get(
            rel
        )
        out.append(
            {
                "path": rel,
                "unchanged": _unchanged(entry, now),
                # only the board's part leaves: its block, or its entries in a JSON file it shares with the person
                "block_only": rel == "CLAUDE.md" or kind in ("mcp", "settings"),
            }
        )
    return {"member_id": profile.id, "folder": str(folder), "files": out}


# the JSON files the board shares with the person, by the kind of units it keeps in them (config_sync)
_MERGED = {".mcp.json": "mcp", ".claude/settings.json": "settings"}


def _empty(value) -> bool:
    """Whether a JSON value holds nothing (empty objects and lists all the way down)."""
    if isinstance(value, dict):
        return all(_empty(v) for v in value.values())
    if isinstance(value, list):
        return all(_empty(v) for v in value)
    return False


def _remove_units(target: Path, rel: str, kind: str, entry, now: str) -> bool:
    """Take the board's own units (the ones still as the board wrote them) out of a merged JSON file. True when the
    file changed or went."""
    base = dict((entry.get("units") if isinstance(entry, dict) else None) or {})
    if not base:
        return False
    spec = cs.Spec(rel, kind, {})
    try:
        cur = cs.read_units(spec, now, set(base))
        mine = {k: None for k, v in base.items() if v is not None and cur.get(k) == v}
        if not mine:
            return False
        text = cs.build_text(spec, now, mine)
        data = json.loads(text) if text else {}
    except (cs._Bad, ValueError):
        return False  # not valid JSON any more: the person's to fix, nothing is touched
    if _empty(data):
        target.unlink()
    else:
        target.write_text(text, encoding="utf-8")
    return True


async def remove_written(session, profile: AiMember) -> list[str]:
    """Remove what the board wrote and nobody changed since; the CLAUDE.md block is cut out and the board's entries
    leave ``.mcp.json`` and ``.claude/settings.json``, the rest of each file stays. Returns the paths removed."""
    from . import config_service

    state = await config_service.get_state(session, profile.id)
    written = loads(state.files, {}) or {}
    folder = Path(profile.working_dir or "").expanduser()
    removed = []
    for rel, entry in written.items():
        target = folder / rel
        if not target.is_file():
            continue
        try:
            now = target.read_text(encoding="utf-8")
        except OSError:
            continue
        kind = (entry.get("kind") if isinstance(entry, dict) else None) or _MERGED.get(
            rel
        )
        if kind in ("mcp", "settings"):
            # a file the board merged its units into (the person's own servers, rules and hooks sit beside them):
            # only the board's units leave, and the file goes only when nothing else is left in it
            if _remove_units(target, rel, kind, entry, now):
                removed.append(rel)
            continue
        if rel == "CLAUDE.md":
            cut = re.sub(
                re.escape(cs.BEGIN) + r".*?" + re.escape(cs.END) + r"\n?",
                "",
                now,
                flags=re.DOTALL,
            )
            if cut != now:
                target.write_text(cut, encoding="utf-8")
                removed.append(rel)
            continue
        if _unchanged(entry, now):
            target.unlink()
            removed.append(rel)
            parent = target.parent
            while parent != folder and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()  # the emptied skill folder goes too
                parent = parent.parent
    state.files = json.dumps({})
    session.add(state)
    await session.commit()
    return removed
