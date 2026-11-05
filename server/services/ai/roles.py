"""The roles of a team (AI v2): the ready-made role packs become the subagents of the team's lead.

A role is `{key, name, description, prompt, model, effort, tools}`. A team picks a *team pack* (a set of roles) and
may override or add roles in its config (`config["roles"]`). `agents_json` turns the roles into what `claude --agents`
takes; `agent_markdown` writes one `agents/<key>.md` of the team's plugin.
"""

import json
from typing import Any

from . import packs

# Team packs: which roles a team brings. The lead itself is not a role: it is the team's main session.
TEAM_PACKS: dict[str, dict[str, Any]] = {
    "standard": {
        "name": "Standard feature",
        "description": "Dev, Reviewer and QA: the lead codes, a fresh Reviewer reads the diff, QA checks it.",
        "roles": ["dev", "reviewer", "qa"],
    },
    "bugfix": {
        "name": "Quick fix",
        "description": "Dev and Reviewer for a small, obvious change.",
        "roles": ["dev", "reviewer"],
    },
    "feature_ui": {
        "name": "Feature with a UI",
        "description": "PM, Designer, Dev, Reviewer, QA and a User tester.",
        "roles": ["pm", "designer", "dev", "reviewer", "qa", "user_tester"],
    },
    "research": {
        "name": "Research",
        "description": "PM, BA and Dev: find out, write it down, propose tickets.",
        "roles": ["pm", "ba", "dev"],
    },
    "docs": {
        "name": "Documentation",
        "description": "Tech writer and Reviewer.",
        "roles": ["tech_writer", "reviewer"],
    },
    "full": {
        "name": "Everyone",
        "description": "Every ready-made role except Triage.",
        "roles": [p["key"] for p in packs.BUILTIN if p["key"] != "triage"],
    },
}
DEFAULT_TEAM_PACK = "standard"

# Tools a role may use, by what it writes (None = every tool the run has)
_READ_ONLY = ["Read", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"]


def role_from_pack(pack: dict[str, Any]) -> dict[str, Any]:
    """A role (subagent definition) from a ready-made or project role pack."""
    writes = pack.get("writes") or "nothing"
    tools = (
        None
        if writes in ("worktree", "canvas", "tests", "ticket")
        else list(_READ_ONLY)
    )
    prompt = (pack.get("persona") or "").strip()
    return {
        "key": pack["key"],
        "name": pack.get("name") or pack["key"],
        "description": pack.get("tagline") or pack.get("name") or pack["key"],
        "prompt": prompt,
        "model": pack.get("model"),
        "effort": pack.get("effort"),
        "tools": tools,
        "writes": writes,
    }


def catalogue() -> list[dict[str, Any]]:
    """Every ready-made role, for the pack editor."""
    return [role_from_pack(p) for p in packs.BUILTIN]


def team_packs() -> list[dict[str, Any]]:
    """The team packs, for the team wizard."""
    return [
        {"key": key, **{k: v for k, v in tp.items()}} for key, tp in TEAM_PACKS.items()
    ]


def _builtin(key: str) -> dict[str, Any] | None:
    pack = packs.builtin(key)
    return role_from_pack(pack) if pack else None


async def roles_for(
    session, project_id: str, pack_key: str | None, config: dict
) -> list[dict[str, Any]]:
    """The roles of a team: its pack's roles (a team pack, or a project pack that lists `roles`), then the overrides
    and additions of `config["roles"]` (a list of role dicts; a dict with only `key` repeats the ready-made role).
    An override with `"off": true` drops the role."""
    base: list[dict[str, Any]] = []
    key = pack_key or DEFAULT_TEAM_PACK
    if key in TEAM_PACKS:
        base = [r for k in TEAM_PACKS[key]["roles"] if (r := _builtin(k))]
    else:
        row = (
            await packs.get_pack(session, project_id, key)
            if session is not None
            else None
        )
        listed = (row or {}).get("roles") or []
        if listed:
            base = [
                {**(_builtin(r.get("key") or "") or {}), **r}
                for r in listed
                if isinstance(r, dict) and r.get("key")
            ]
        elif row:
            base = [role_from_pack({**row, "key": row.get("key") or key})]
        else:
            base = [
                r for k in TEAM_PACKS[DEFAULT_TEAM_PACK]["roles"] if (r := _builtin(k))
            ]
    by_key = {r["key"]: r for r in base}
    order = [r["key"] for r in base]
    for item in config.get("roles") or []:
        if not isinstance(item, dict) or not item.get("key"):
            continue
        k = item["key"]
        if item.get("off"):
            by_key.pop(k, None)
            continue
        current = (
            by_key.get(k)
            or _builtin(k)
            or {
                "key": k,
                "name": k,
                "description": k,
                "prompt": "",
                "model": None,
                "effort": None,
                "tools": None,
                "writes": "nothing",
            }
        )
        by_key[k] = {**current, **{kk: v for kk, v in item.items() if kk != "off"}}
        if k not in order:
            order.append(k)
    return [by_key[k] for k in order if k in by_key]


def agents_json(roles: list[dict[str, Any]], board_rules: str = "") -> dict[str, Any]:
    """What `claude --agents` takes: {name: {description, prompt, model?, tools?}}."""
    from services import role_skills

    out: dict[str, Any] = {}
    for r in roles:
        skill = next(
            (n for k, n, _d, _b in role_skills.ROLE_SKILLS if k == r["key"]), None
        )
        guide = (
            f"Your role's guide is the skill `kanban-board:{skill}`: open it with the Skill tool before you start."
            if skill
            else ""
        )
        spec: dict[str, Any] = {
            "description": r.get("description") or r["key"],
            "prompt": "\n\n".join(
                x for x in (r.get("prompt") or "", guide, board_rules) if x
            ),
        }
        if r.get("model"):
            spec["model"] = r["model"]
        if r.get("tools"):
            spec["tools"] = list(r["tools"])
        out[r["key"]] = spec
    return out


def agent_markdown(role: dict[str, Any], board_rules: str = "") -> str:
    """One `agents/<key>.md` of a plugin: frontmatter (name, description, model, tools) and the prompt."""
    lines = [
        "---",
        f"name: {role['key']}",
        f"description: {json.dumps(role.get('description') or role['key'])}",
    ]
    if role.get("model"):
        lines.append(f"model: {role['model']}")
    if role.get("tools"):
        lines.append("tools: " + ", ".join(role["tools"]))
    lines.append("---")
    body = "\n\n".join(x for x in (role.get("prompt") or "", board_rules) if x)
    return "\n".join(lines) + "\n\n" + body + "\n"


def public(roles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The roles as the API shows them."""
    return [
        {
            "key": r["key"],
            "name": r.get("name"),
            "description": r.get("description"),
            "prompt": r.get("prompt"),
            "model": r.get("model"),
            "effort": r.get("effort"),
            "tools": r.get("tools"),
            "writes": r.get("writes"),
        }
        for r in roles
    ]
