"""Role packs: everything that makes an AI a role, in one object you can export, import and version
(design/screens/ai-team-process.md, C; plan D15).

A pack is: who it is (persona), model and effort, its tools (allow rules, plugins, MCP servers from the catalog), its
permission template and status ceiling, where it may write, what it must hand in, and its limits. Eight are
ready-made; the four presets of ``memberPresets.json`` are the first four. A project can add its own, and every edit
makes a new version so a member keeps the version it was made from until someone updates it.
"""

import copy
import json
from datetime import UTC, datetime

from sqlmodel import col, select

from models import AiRolePack

FORMAT = "kanban-role-pack/1"

_COMMON_RULES = (
    "Work only on what the ticket asks. Report with ai_run(action='report') before your final message. "
    "Ask a person with ai_run(action='ask') when a decision is theirs."
)

BUILTIN: list[dict] = [
    {
        "key": "triage",
        "name": "Triage",
        "glyph": "TR",
        "tagline": "Reads a new ticket and sorts it",
        "model": "haiku",
        "effort": "low",
        "template": "reviewer",
        "ceiling": "todo",
        "writes": "nothing",
        "hands_in": "Labels, the workflow, the review depth: a ticket with a process on it",
        "allow": ["Read", "Glob", "Grep"],
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 2, "max_runs_per_day": 40},
        "persona": (
            "You are Triage on this project. For a new ticket: read it, decide its kind (bug, feature, chore, research), "
            "set labels, pick the workflow template that fits and the review depth (light for a small obvious change, "
            "standard for most, deep for migrations, money, permissions or anything marked risky). Change nothing in the "
            "repository. Say in one sentence why you chose them; a person may change any of it. "
            + _COMMON_RULES
        ),
    },
    {
        "key": "pm",
        "name": "PM",
        "glyph": "PM",
        "tagline": "PM / coordinator: plans, splits, and settles disagreements",
        "model": "opus",
        "effort": "high",
        "template": "developer",
        "ceiling": "todo",
        "writes": "nothing",
        "hands_in": "A plan, or a verdict",
        "allow": [
            "Read",
            "Glob",
            "Grep",
            "Bash(git status:*)",
            "Bash(git diff:*)",
            "Bash(git log:*)",
        ],
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are the PM (coordinator) of this project. You get tickets ready (clarify, criteria, split), give work "
            "to the right AI, and when two AIs cannot agree you read both sides and rule: side with one, or split the "
            "ticket. You may propose a change to an acceptance criterion but never make one. You never edit code. The "
            "Board AI speaks for the people and outranks you; when you cannot decide, say so and it goes to a person. "
            + _COMMON_RULES
        ),
    },
    {
        "key": "ba",
        "name": "BA",
        "glyph": "BA",
        "tagline": "Turns a wish into criteria",
        "model": "sonnet",
        "effort": "medium",
        "template": "developer",
        "ceiling": "todo",
        "writes": "ticket",
        "hands_in": "Acceptance criteria",
        "allow": ["Read", "Glob", "Grep"],
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are the BA on this project. Turn the ticket's wish into acceptance criteria a tester can check: "
            "concrete, observable, one behaviour each, edge cases named. Read the code only to understand what exists; "
            "never change it. Ask a person when the wish is ambiguous instead of guessing. "
            + _COMMON_RULES
        ),
    },
    {
        "key": "designer",
        "name": "Designer",
        "glyph": "DS",
        "tagline": "Draws before anyone builds",
        "model": "opus",
        "effort": "medium",
        "template": "developer",
        "ceiling": "todo",
        "writes": "canvas",
        "hands_in": "A mock-up for you to approve",
        "allow": ["Read", "Glob", "Grep"],
        "plugins": ["design", "ui-ux-pro-max", "frontend-design", "canvas-design"],
        "mcp": ["figma"],
        "limits": {"max_parallel": 1, "max_runs_per_day": 10},
        "persona": (
            "You are the Designer on this project. Before anyone builds, draw what the ticket asks on a canvas frame "
            "(responsive, real copy, every state: empty, loading, error, many items) and hand it in for a person to "
            "approve. Follow the project's design system. You do not write production code. "
            + _COMMON_RULES
        ),
    },
    {
        "key": "dev",
        "name": "Dev (TDD)",
        "glyph": "DV",
        "tagline": "A failing test before the fix",
        "model": "sonnet",
        "retry_model": "opus",
        "effort": "medium",
        "template": "developer",
        "ceiling": "review",
        "writes": "worktree",
        "hands_in": "A run where the test failed, and a later run where it passed",
        "allow": [],
        "plugins": ["tdd"],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 10},
        "persona": (
            "You are Dev on this project. Write the failing test first and run it, then make the smallest change that "
            "makes it pass, then run the suite. Keep the change as small as the criteria allow; never reformat a file "
            "you did not touch; commit on your ticket's branch. You are not the reviewer of your own work and you may "
            "not change an acceptance criterion, only propose one. " + _COMMON_RULES
        ),
    },
    {
        "key": "reviewer",
        "name": "Reviewer",
        "glyph": "RV",
        "tagline": "Reads the diff, never the transcript",
        "model": "sonnet",
        "effort": "medium",
        "depth_models": {"light": "haiku", "standard": "sonnet", "deep": "opus"},
        "template": "reviewer",
        "ceiling": "review",
        "writes": "nothing",
        "hands_in": "Pass, or what to change",
        "allow": [
            "Read",
            "Glob",
            "Grep",
            "Bash(git status:*)",
            "Bash(git diff:*)",
            "Bash(git log:*)",
            "Bash(npm test:*)",
            "Bash(npm run test:*)",
            "Bash(npm run lint:*)",
            "Bash(pytest:*)",
            "Bash(python -m pytest:*)",
            "Bash(uv run pytest:*)",
        ],
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 2, "max_runs_per_day": 30},
        "persona": (
            "You are the Reviewer. You get the diff, the acceptance criteria and the hand-over note, never the other "
            "AI's transcript, so you judge the change fresh. Check every criterion against the code, run the tests the "
            "depth asks for, and answer: pass, or exactly what to change and why. Do not repeat an objection you already "
            "made once it was answered; you never change code. " + _COMMON_RULES
        ),
    },
    {
        "key": "qa",
        "name": "QA",
        "glyph": "QA",
        "tagline": "Runs it, does not read it",
        "model": "sonnet",
        "effort": "low",
        "template": "developer",
        "ceiling": "review",
        "writes": "tests",
        "hands_in": "What passed, what did not",
        "allow": [],
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are QA on this project. You check that the product works; you do not fix it. Turn the criteria into "
            "test cases, run the suite and the app, attach proof (output, screenshots) to each test case, and report "
            "exactly what passed and what did not. A failure gets a clear repro, not a guess at the cause. "
            + _COMMON_RULES
        ),
    },
    {
        "key": "user_tester",
        "name": "User tester",
        "glyph": "UT",
        "tagline": "Plays one kind of person",
        "model": "sonnet",
        "effort": "medium",
        "template": "reviewer",
        "ceiling": "review",
        "writes": "nothing",
        "hands_in": "What it tried, and where it got stuck",
        "allow": ["Read", "Glob", "Grep"],
        "plugins": [],
        "mcp": ["playwright"],
        "personas": ["in a hurry", "first time here", "keyboard only", "on a phone"],
        "limits": {"max_parallel": 1, "max_runs_per_day": 10},
        "persona": (
            "You are a User tester. You play one kind of person ({plays}) using the real app in a browser through "
            "Playwright, on the port of the ticket's worktree, with a fresh browser profile. Try to do what the ticket "
            "is for, the way that person would; report what you tried, where you got stuck and what confused you, with "
            "screenshots. You do not read or change the code. " + _COMMON_RULES
        ),
    },
]

BUILTIN_KEYS = [p["key"] for p in BUILTIN]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def builtin(key: str) -> dict | None:
    """A ready-made pack by key."""
    found = next((p for p in BUILTIN if p["key"] == key), None)
    return copy.deepcopy(found) if found else None


def to_dict(row: AiRolePack) -> dict:
    """A stored pack for the API."""
    body = json.loads(row.body or "{}")
    return {
        **body,
        "id": row.id,
        "key": row.key,
        "name": row.name,
        "project_id": row.project_id,
        "version": row.version,
        "builtin": False,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "updated_by": row.updated_by,
    }


async def list_packs(session, project_id: str) -> list[dict]:
    """The ready-made packs and the project's own, the project's version winning when it reuses a key."""
    own = (
        await session.exec(
            select(AiRolePack).where(AiRolePack.project_id == project_id)
        )
    ).all()
    by_key = {r.key: to_dict(r) for r in own}
    out = []
    for p in BUILTIN:
        out.append(
            by_key.pop(p["key"], None)
            or {
                **copy.deepcopy(p),
                "id": f"builtin:{p['key']}",
                "version": 1,
                "builtin": True,
            }
        )
    return out + sorted(by_key.values(), key=lambda p: p["name"].lower())


async def get_pack(session, project_id: str, key: str) -> dict | None:
    """One pack by key: the project's own version, else the ready-made one."""
    row = (
        await session.exec(
            select(AiRolePack).where(
                AiRolePack.project_id == project_id, AiRolePack.key == key
            )
        )
    ).first()
    if row is not None:
        return to_dict(row)
    found = builtin(key)
    return (
        {**found, "id": f"builtin:{key}", "version": 1, "builtin": True}
        if found
        else None
    )


_FIELDS = (
    "name",
    "glyph",
    "tagline",
    "model",
    "retry_model",
    "effort",
    "depth_models",
    "template",
    "ceiling",
    "writes",
    "hands_in",
    "allow",
    "plugins",
    "mcp",
    "personas",
    "limits",
    "persona",
)


def clean(body: dict) -> dict:
    """Only a pack's known fields, checked."""
    out = {k: copy.deepcopy(body[k]) for k in _FIELDS if k in body}
    if not str(out.get("name") or "").strip():
        raise ValueError("A pack needs a name.")
    if (
        out.get("model")
        and out["model"] not in ("haiku", "sonnet", "opus")
        and "-" not in str(out["model"])
    ):
        raise ValueError("The model is haiku, sonnet, opus or a full model id.")
    if out.get("effort") and out["effort"] not in (
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ):
        raise ValueError("The effort is low, medium, high, xhigh or max.")
    for key in ("allow", "plugins", "mcp", "personas"):
        if key in out and not isinstance(out[key], list):
            raise ValueError(f"{key} must be a list.")
    return out


async def save_pack(session, project_id: str, key: str, body: dict, *, by: str) -> dict:
    """Create or edit the project's pack `key` (editing a ready-made one makes the project's own copy). Every save is
    a new version; the earlier one goes into the history."""
    import re

    key = re.sub(r"[^a-z0-9_]+", "_", (key or "").lower()).strip("_")
    if not key:
        raise ValueError("A pack needs a key.")
    fields = clean(body)
    row = (
        await session.exec(
            select(AiRolePack).where(
                AiRolePack.project_id == project_id, AiRolePack.key == key
            )
        )
    ).first()
    if row is None:
        base = builtin(key) or {}
        row = AiRolePack(
            project_id=project_id,
            key=key,
            name=fields.get("name") or base.get("name") or key,
        )
        merged = {**{k: v for k, v in base.items() if k in _FIELDS}, **fields}
    else:
        history = json.loads(row.history or "[]")
        history.append(
            {
                "version": row.version,
                "body": json.loads(row.body or "{}"),
                "at": row.updated_at,
                "by": row.updated_by,
            }
        )
        row.history = json.dumps(history[-20:])
        row.version += 1
        merged = {**json.loads(row.body or "{}"), **fields}
    row.name = merged.get("name") or row.name
    row.body = json.dumps(merged)
    row.updated_at = _now()
    row.updated_by = by
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return to_dict(row)


async def delete_pack(session, project_id: str, key: str) -> bool:
    """Remove the project's own pack (a ready-made one comes back in its place)."""
    row = (
        await session.exec(
            select(AiRolePack).where(
                AiRolePack.project_id == project_id, AiRolePack.key == key
            )
        )
    ).first()
    if row is None:
        return False
    await session.delete(row)
    await session.commit()
    return True


def export(pack: dict) -> dict:
    """One file that carries the whole pack."""
    return {
        "format": FORMAT,
        "key": pack["key"],
        "version": pack.get("version", 1),
        "pack": {k: pack[k] for k in _FIELDS if k in pack},
    }


async def import_pack(session, project_id: str, data: dict, *, by: str) -> dict:
    """Import a pack file into the project. Returns {pack, missing}: the plugins and MCP servers it names that the
    project does not have yet, so the screen can say what it could not find."""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise ValueError("This is not a role pack file.")
    pack = await save_pack(
        session,
        project_id,
        data.get("key") or (data.get("pack") or {}).get("name", ""),
        data.get("pack") or {},
        by=by,
    )
    from models import AiPlugin

    installed = {
        p.name
        for p in (
            await session.exec(
                select(AiPlugin).where(col(AiPlugin.project_id).in_([project_id, None]))
            )  # type: ignore[arg-type]
        ).all()
    }
    missing = [p for p in pack.get("plugins") or [] if p not in installed]
    return {"pack": pack, "missing": missing}


def member_body(
    pack: dict,
    *,
    name: str,
    working_dir: str | None,
    account_id: str | None,
    plays: str | None = None,
) -> dict:
    """The body of a new AI member made from a pack (the existing member API takes it as it is)."""
    persona = pack.get("persona") or ""
    if "{plays}" in persona:
        persona = persona.replace(
            "{plays}", plays or (pack.get("personas") or ["a typical user"])[0]
        )
    limits = pack.get("limits") or {}
    body = {
        "name": name,
        "provider": "claude-code",
        "working_dir": working_dir,
        "account_id": account_id,
        "model": pack.get("model"),
        "persona": persona,
        "template": pack.get("template") or "developer",
        "ceiling": pack.get("ceiling") or "review",
        "max_parallel": limits.get("max_parallel"),
        "max_runs_per_day": limits.get("max_runs_per_day"),
        "glyph": None,
        "description": pack.get("tagline"),
        "config": {
            "effort": pack.get("effort"),
            "allow_rules": list(pack.get("allow") or []),
            "role": pack["key"],
            "pack": {"key": pack["key"], "version": pack.get("version", 1)},
            **({"plays": plays} if plays else {}),
        },
    }
    return {k: v for k, v in body.items() if v is not None}
