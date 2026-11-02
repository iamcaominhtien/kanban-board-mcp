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
        # Developer narrowed to the fields it sorts: labels and the like without asking, nothing else it could make
        "template": "developer",
        "permissions": {
            "change_assignee": "blocked",
            "create_tickets": "blocked",
            "edit_docs": "blocked",
            "delete_docs": "blocked",
            "create_branches": "blocked",
        },
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
            # the files of a draw.io Diagram of a plan (no other shell)
            "Write",
            "Edit",
        ],
        "plugins": [],
        "mcp": ["playwright"],  # to look at a design before deciding it
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are the PM (coordinator) of this project. You get tickets ready (clarify, criteria, split), give work "
            "to the right AI, and when two AIs cannot agree you read both sides and rule: side with one, or split the "
            "ticket. You may propose a change to an acceptance criterion but never make one. You never edit code. The "
            "Board AI speaks for the people and outranks you; when you cannot decide, say so and it goes to a person. "
            + "When you split or plan work, a draw.io Diagram of the pieces and what depends on what helps the person see it. "
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
        "allow": [
            "Read",
            "Glob",
            "Grep",
            # the files of a draw.io Diagram or a Sketch, written before docs_write makes it (no shell)
            "Write",
            "Edit",
        ],
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are the BA on this project. Turn the ticket's wish into acceptance criteria a tester can check: "
            "concrete, observable, one behaviour each, edge cases named. Read the code only to understand what exists; "
            "never change it. Ask a person when the wish is ambiguous instead of guessing. "
            + "When a flow or the states of a feature are hard to follow in words, add a draw.io Diagram of it to the Docs page or ticket. "
            + _COMMON_RULES
        ),
    },
    {
        "key": "designer",
        "name": "Designer",
        "glyph": "DS",
        "tagline": "Draws before anyone builds",
        "model": "opus",
        "effort": "high",
        "template": "developer",
        "ceiling": "todo",
        "writes": "canvas",
        "hands_in": "A mock-up for you to approve",
        "allow": ["Read", "Glob", "Grep"],
        # not Anthropic's canvas-design (poster art as a PNG; its name hides the board's own guide), nor Figma (it signs
        # in through a browser, which a run cannot do): both stay in the catalogue for a person to add
        # only skills for work the guide does not teach (motion, charts) and checks run on drawn boards: rule sets
        # that pick a palette, a type scale or a layout (taste-skill, dembrandt, ui-ux-pro-max...) pulled a live
        # Designer to one flat hue and a generic dashboard, its worst run; they stay in the catalogue for a person
        "plugins": [
            "design",
            "emil-design-eng",
            "motion-design",
            "tufte-data-viz",
        ],
        "mcp": ["playwright"],
        "limits": {"max_parallel": 1, "max_runs_per_day": 10},
        "persona": (
            "You are the Designer, judged on how your work looks. First load the board's design guide (skill "
            "`kanban-board:canvas-design`, else docs_read(design_guide)), its craft.md and exemplar boards. Your "
            "work must not look machine-made: a signature only this product has, type and colour chosen for it, none "
            "of the template tells. For a new product, draw the main screen three ways on a Directions page and keep "
            "the strongest. Then a canvas that reads as a design document: a Foundations board, components, screen "
            "boards with every state side by side and a caption by each decision. Look at your "
            "boards in the browser (Playwright via `python3 -m http.server`), fix the three most template-like things, "
            "look again. Hand in the canvas, a spec per screen on Docs, a comment with screenshots. No production "
            "code; screen flow as a draw.io Diagram. " + _COMMON_RULES
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
            "not change an acceptance criterion, only propose one. When you change how the parts fit together (the "
            "architecture, a data flow), update or add the draw.io Diagram that shows it in the docs. "
            + _COMMON_RULES
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
            "Bash(python3 -m pytest:*)",
            "Bash(uv run pytest:*)",
            "Bash(uvx pytest:*)",
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
        "allow": [
            "Read",
            "Glob",
            "Grep",
            # start the app it tries (in the background) and drive it with the browser; no other shell
            "Bash(npm ci:*)",
            "Bash(npm install:*)",
            "Bash(npm run dev:*)",
            "Bash(npm run build:*)",
            "Bash(npm run preview:*)",
            "Bash(npm start:*)",
            "Bash(npx vite:*)",
            "Bash(uv run:*)",
            "Bash(python3 -m http.server:*)",
            "Bash(curl:*)",
            "Bash(lsof:*)",
            "Bash(kill:*)",
            # screenshots and notes for a demo or a report
            "Write",
        ],
        "plugins": [],
        "mcp": ["playwright"],
        "personas": ["in a hurry", "first time here", "keyboard only", "on a phone"],
        "limits": {"max_parallel": 1, "max_runs_per_day": 10},
        "persona": (
            "You are a User tester. You play one kind of person ({plays}) using the real app in a browser through "
            "Playwright, on the port of the ticket's worktree, with a fresh browser profile. Try to do what the ticket "
            "is for, the way that person would; report what you tried, where you got stuck and what confused you, with "
            "screenshots. Start the app yourself in the background on that port (e.g. `npm run dev -- --port $PORT &`), "
            "wait until it answers, and stop it when you are done. You do not read or change the code. "
            + _COMMON_RULES
        ),
    },
]

BUILTIN_KEYS = [p["key"] for p in BUILTIN]
# The ready-made packs' version: raised when their persona or tools change, so a member made from an older one is
# offered the update (v2: the Designer, BA and PM write the files of a canvas or a diagram, the User tester starts the
# app, every role knows which drawing to use)
# v3: the Designer looks at its frames in a browser and starts from tokens; the PM judges design
# v4: the Designer drops Anthropic's canvas-design (it shadows the board's guide) and Figma
# v5: the Designer presents a design document (foundations, states side by side, a spec per screen)
# v6: the Designer explores three directions, reads craft.md, critiques its own screens and gets taste-skill
# v7: the Designer gets the niche design skills (polish, UI rules, motion, charts)
BUILTIN_VERSION = 8  # v8: the Designer keeps only motion, chart and checking skills; the guide sets the look


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
                "version": BUILTIN_VERSION,
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
        {**found, "id": f"builtin:{key}", "version": BUILTIN_VERSION, "builtin": True}
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
    "permissions",
    "permission_mode",
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


_WRITES_CODE = ("worktree", "tests")
_WRITE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "Bash"]
# a canvas is made from a folder of HTML frames the Designer writes first (docs_write canvas_create): files, no shell
_FILE_TOOLS = ["Edit", "Write", "MultiEdit"]


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
    allow = list(pack.get("allow") or [])
    if pack.get("writes") in _WRITES_CODE:
        # A pack that changes code edits files and runs commands; the member's deny rules still apply
        allow += [t for t in _WRITE_TOOLS if t not in allow]
    elif pack.get("writes") == "canvas":
        allow += [t for t in _FILE_TOOLS if t not in allow]
    from . import config_model as cm, plugins

    catalogue = {c["key"]: c for c in plugins.CATALOGUE if c["kind"] == "mcp"}
    extra: dict = {}
    # the pack's MCP servers go on the member as they are (an unknown key is skipped)
    servers = [
        cm.normalize_server({**catalogue[k]["server"], "mode": "synced"})
        for k in pack.get("mcp") or []
        if k in catalogue
    ]
    if servers:
        extra["mcp_servers"] = servers
    for key in ("retry_model", "depth_models", "hands_in"):
        if pack.get(key):
            extra[key] = pack[key]
    if pack.get("plugins"):
        # marketplace plugins are installed per project by the apply step; the member only remembers which
        extra["pack_plugins"] = list(pack["plugins"])
    body = {
        "name": name,
        "provider": "claude-code",
        "working_dir": working_dir,
        "account_id": account_id,
        "model": pack.get("model"),
        "persona": persona,
        "template": pack.get("template") or "developer",
        "ceiling": pack.get("ceiling") or "review",
        "permissions": dict(pack.get("permissions") or {}) or None,
        "max_parallel": limits.get("max_parallel"),
        "max_runs_per_day": limits.get("max_runs_per_day"),
        "glyph": None,
        "description": pack.get("tagline"),
        "config": {
            # the ready-made packs run with Bypass permissions (deny rules, the status ceiling and approvals still
            # hold); Triage, which only reads and sorts, keeps the allow list
            "permission_mode": pack.get("permission_mode")
            or ("allowlist" if pack["key"] == "triage" else "bypass"),
            "effort": pack.get("effort"),
            "allow_rules": allow,
            "role": pack["key"],
            "pack": {
                "key": pack["key"],
                "version": pack.get("version") or BUILTIN_VERSION,
            },
            # the instructions as the pack wrote them: an update can tell whether a person changed them since
            "pack_persona": persona,
            **({"plays": plays} if plays else {}),
            **extra,
        },
    }
    return {k: v for k, v in body.items() if v is not None}


# what an update from the pack replaces on a member; its name, folder, account, model and paused state stay its own
_FROM_PACK = (
    "persona",
    "template",
    "ceiling",
    "permissions",
    "max_parallel",
    "max_runs_per_day",
    "description",
)
_CONFIG_FROM_PACK = (
    "permission_mode",
    "effort",
    "allow_rules",
    "role",
    "pack",
    "retry_model",
    "depth_models",
    "hands_in",
    "pack_plugins",
    "pack_persona",
)
HISTORY_DAYS = 30  # a member can go back to the version it was updated from for this long (ai-story-flow Q1)
_LABELS = {
    "persona": "Instructions",
    "template": "Template",
    "ceiling": "Ceiling",
    "permissions": "Permissions",
    "max_parallel": "Runs at a time",
    "max_runs_per_day": "Runs a day",
    "description": "Description",
    "permission_mode": "Permission mode",
    "effort": "Effort",
    "allow_rules": "Allow list",
    "retry_model": "Model for a second attempt",
    "depth_models": "Models per review depth",
    "hands_in": "What it hands in",
    "pack_plugins": "Plugins",
    "mcp_servers": "MCP servers",
}


async def member_pack(session, member_id: str) -> dict | None:
    """Which pack a member was made from and whether a newer version of it is out, or None (not made from a pack)."""
    from models import AiMember

    profile = await session.get(AiMember, member_id)
    cfg = json.loads(profile.config or "{}") if profile else {}
    made = cfg.get("pack") or {}
    if not made.get("key"):
        return None
    pack = await get_pack(session, profile.project_id, made["key"])
    if pack is None:
        return {
            "key": made["key"],
            "version": made.get("version", 1),
            "latest": None,
            "outdated": False,
        }
    latest = pack.get("version", 1)
    history = _history(cfg)
    return {
        "key": made["key"],
        "name": pack.get("name"),
        "version": made.get("version", 1),
        "latest": latest,
        "outdated": latest > made.get("version", 1),
        "edited": bool(cfg.get("pack_persona"))
        and (profile.persona or "") != cfg.get("pack_persona"),
        "history": [
            {"version": h.get("version"), "at": h.get("at"), "by": h.get("by")}
            for h in history
        ],
    }


def _history(cfg: dict) -> list[dict]:
    """The versions a member can go back to, newest first, younger than HISTORY_DAYS."""
    from datetime import UTC, datetime, timedelta

    floor = (datetime.now(UTC) - timedelta(days=HISTORY_DAYS)).isoformat()
    return [
        h
        for h in cfg.get("pack_history") or []
        if isinstance(h, dict) and (h.get("at") or "") >= floor
    ]


def _short(value) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False) if value not in (None, "") else ""


async def pack_diff(session, member_id: str) -> dict:
    """What an update to the pack's latest version would change on the member (ai-story-flow Q1): each field with
    its value now and after, and what stays the member's own."""
    from models import AiMember, Member

    profile = await session.get(AiMember, member_id)
    member = await session.get(Member, member_id)
    state = await member_pack(session, member_id)
    if profile is None or member is None or state is None:
        raise ValueError("This AI member was not made from a role pack.")
    pack = await get_pack(session, profile.project_id, state["key"])
    if pack is None:
        raise ValueError(f"The pack {state['key']} is gone.")
    cfg = json.loads(profile.config or "{}")
    body = member_body(
        pack,
        name=member.name,
        working_dir=profile.working_dir,
        account_id=profile.account_id,
        plays=cfg.get("plays"),
    )
    changes = []
    for key in _FROM_PACK:
        now = getattr(profile, key)
        if key == "permissions":
            now = json.loads(now or "{}") or None
        after = body.get(key)
        if _short(now) != _short(after):
            changes.append(
                {
                    "field": key,
                    "label": _LABELS.get(key, key),
                    "before": _short(now),
                    "after": _short(after),
                }
            )
    fresh = body["config"]
    for key in _CONFIG_FROM_PACK:
        if key in ("pack", "pack_persona", "role"):
            continue
        if _short(cfg.get(key)) != _short(fresh.get(key)):
            changes.append(
                {
                    "field": key,
                    "label": _LABELS.get(key, key),
                    "before": _short(cfg.get(key)),
                    "after": _short(fresh.get(key)),
                }
            )
    before_srv = sorted(srv.get("name", "") for srv in cfg.get("mcp_servers") or [])
    after_srv = sorted(srv.get("name", "") for srv in fresh.get("mcp_servers") or [])
    if before_srv != after_srv:
        changes.append(
            {
                "field": "mcp_servers",
                "label": _LABELS["mcp_servers"],
                "before": ", ".join(before_srv),
                "after": ", ".join(after_srv),
            }
        )
    return {
        **state,
        "to": pack.get("version", 1),
        "changes": changes,
        "kept": [
            "name",
            "working folder",
            "account",
            "model",
            "MCP servers you added yourself",
        ],
    }


async def update_member(session, member_id: str, *, by: str) -> dict:
    """Bring a member made from a pack up to the pack's latest version: its persona, tools, MCP servers, ceiling and
    permissions come from the pack; its name, folder, account and model stay as they are, and MCP servers a person
    added stay too."""
    from models import AiMember, Member

    from . import audit

    profile = await session.get(AiMember, member_id)
    member = await session.get(Member, member_id)
    state = await member_pack(session, member_id)
    if profile is None or member is None or state is None:
        raise ValueError("This AI member was not made from a role pack.")
    pack = await get_pack(session, profile.project_id, state["key"])
    if pack is None:
        raise ValueError(f"The pack {state['key']} is gone.")
    cfg = json.loads(profile.config or "{}")
    body = member_body(
        pack,
        name=member.name,
        working_dir=profile.working_dir,
        account_id=profile.account_id,
        plays=cfg.get("plays"),
    )
    # what it was, so the person can go back for HISTORY_DAYS (ai-story-flow Q1)
    snapshot = {
        "version": state["version"],
        "at": _now(),
        "by": by,
        "fields": {k: getattr(profile, k) for k in _FROM_PACK},
        "config": {k: v for k, v in cfg.items() if k != "pack_history"},
    }
    history = [snapshot, *_history(cfg)][:5]
    for key in _FROM_PACK:
        if key in body:
            value = body[key]
            setattr(profile, key, json.dumps(value) if key == "permissions" else value)
    if "permissions" not in body:
        profile.permissions = "{}"
    fresh = body["config"]
    for key in _CONFIG_FROM_PACK:
        if key in fresh:
            cfg[key] = fresh[key]
        else:
            cfg.pop(key, None)
    pack_servers = {s["name"] for s in fresh.get("mcp_servers") or []}
    catalogue = {
        c["server"]["name"] for c in plugins_catalogue() if c.get("kind") == "mcp"
    }
    # the pack's servers as the pack has them; a server a person added (not one of the catalogue's) stays
    cfg["mcp_servers"] = list(fresh.get("mcp_servers") or []) + [
        srv
        for srv in cfg.get("mcp_servers") or []
        if srv.get("name") not in pack_servers and srv.get("name") not in catalogue
    ]
    cfg["pack_history"] = history
    profile.config = json.dumps(cfg)
    session.add(profile)
    await session.commit()
    await audit.record(
        profile.project_id,
        "member_pack_updated",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
        detail={
            "pack": state["key"],
            "from": state["version"],
            "to": pack.get("version", 1),
        },
    )
    return await member_pack(session, member_id)


async def revert_member(session, member_id: str, *, by: str) -> dict:
    """Go back to the version the member was last updated from (within HISTORY_DAYS)."""
    from models import AiMember, Member

    from . import audit

    profile = await session.get(AiMember, member_id)
    member = await session.get(Member, member_id)
    if profile is None or member is None:
        raise ValueError("AI member not found.")
    cfg = json.loads(profile.config or "{}")
    history = _history(cfg)
    if not history:
        raise ValueError("There is no earlier version to go back to.")
    last, rest = history[0], history[1:]
    for key, value in (last.get("fields") or {}).items():
        if key in _FROM_PACK:
            setattr(profile, key, value)
    restored = dict(last.get("config") or {})
    restored["pack_history"] = rest
    profile.config = json.dumps(restored)
    session.add(profile)
    await session.commit()
    await audit.record(
        profile.project_id,
        "member_pack_reverted",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
        detail={"to": last.get("version")},
    )
    return await member_pack(session, member_id)


def plugins_catalogue() -> list[dict]:
    """The catalogue of plugins and MCP servers (imported late: plugins imports packs)."""
    from . import plugins

    return plugins.CATALOGUE


async def install_plugins(session, project_id: str, pack: dict, *, by: str) -> dict:
    """The catalogue plugins a pack names, installed on the project once (a member made from the pack gets them by
    its role). MCP servers ride on the member itself (member_body). Returns what was installed and what failed."""
    from models import AiPlugin

    from . import plugins

    by_key = {c["key"]: c for c in plugins.CATALOGUE}
    have = {
        p.name
        for p in (
            await session.exec(
                select(AiPlugin).where(AiPlugin.project_id == project_id)
            )
        ).all()
    }
    installed, failed = [], []
    for key in pack.get("plugins") or []:
        entry = by_key.get(key)
        if (
            entry is None
            or entry["kind"] != "plugin"
            or {key, entry["name"], entry.get("plugin")} & have
        ):
            continue
        try:
            plug = await plugins.install(
                session,
                project_id,
                source_kind="marketplace",
                source=entry["source"],
                plugin=entry.get("plugin"),
                skills=entry.get("skills"),
                roles=entry["roles"],
                by=by,
            )
            installed.append(plug.name)
            have.add(plug.name)
        except plugins.PluginError as exc:
            failed.append({"plugin": key, "why": str(exc)})
    return {"installed": installed, "failed": failed}
