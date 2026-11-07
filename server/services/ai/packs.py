"""Role packs: everything that makes an AI a role, in one object you can export, import and version
(design/screens/ai-team-process.md, C; plan D15).

A pack is: who it is (persona), model and effort, its plugins and MCP servers from the catalog, where it may write,
what it must hand in, and its limits. There is no permission template, status ceiling or tool list (AI v2: bypass
plus a short deny list). Twelve are ready-made; the four presets of ``memberPresets.json`` are the first four. A project can add its own, and every edit
makes a new version so a member keeps the version it was made from until someone updates it.
"""

import copy
import json
from datetime import UTC, datetime

from sqlmodel import col, select

from models import AiRolePack

FORMAT = "kanban-role-pack/1"


# How every role works a ticket (stay in it, report the truth, ask, prove it) is in the board's rules and its shared
# skills (services/shared_skills.py, issue #277), and each role's craft in its own skill (services/role_skills.py,
# issue #273): a persona says who the role is and points to them
def _rules(key: str) -> str:
    from services import role_skills

    shared = "How to work a ticket, prove it, ask and work with the other roles: the board's shared skills (`kanban-board:*`)."
    if key == "designer":
        return shared  # its persona opens with its guide already
    return f"Your craft: the skill `kanban-board:{role_skills.SKILL_OF_ROLE[key]}`. {shared}"


BUILTIN: list[dict] = [
    {
        "key": "triage",
        "name": "Triage",
        "glyph": "TR",
        "tagline": "Reads a new ticket and sorts it",
        "model": "haiku",
        "effort": "low",
        "writes": "nothing",
        "hands_in": "Labels and the review depth: a ticket sorted for the team",
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 2, "max_runs_per_day": 40},
        "persona": (
            "You are Triage on this project. For a new ticket: read it, decide its kind (bug, feature, chore, research), "
            "set labels and the review depth (light for a small obvious change, "
            "standard for most, deep for migrations, money, permissions or anything marked risky). Change nothing in the "
            "repository. Say in one sentence why you chose them; a person may change any of it. "
            + _rules("triage")
        ),
    },
    {
        "key": "pm",
        "name": "PM",
        "glyph": "PM",
        "tagline": "PM: plans, splits, and settles disagreements",
        "model": "opus",
        "effort": "high",
        "writes": "nothing",
        "hands_in": "A plan, or a verdict",
        "plugins": [],
        "mcp": ["playwright"],  # to look at a design before deciding it
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are the PM of this team. You get tickets ready (clarify, criteria, split), say which role should take "
            "each piece, and when two roles cannot agree you read both sides and rule: side with one, or split the "
            "ticket. You may propose a change to an acceptance criterion but never make one. You never edit code. The "
            "lead decides who does what; when you cannot decide, say so and the lead asks a person. "
            + "When you split or plan work, a draw.io Diagram of the pieces and what depends on what helps the person see it "
            "(skill `kanban-board:drawio-diagrams`, else docs_read(diagram_guide)). "
            + _rules("pm")
        ),
    },
    {
        "key": "ba",
        "name": "BA",
        "glyph": "BA",
        "tagline": "Turns a wish into criteria",
        "model": "sonnet",
        "effort": "medium",
        "writes": "ticket",
        "hands_in": "Acceptance criteria",
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are the BA on this project. Turn the ticket's wish into acceptance criteria a tester can check: "
            "concrete, observable, one behaviour each, edge cases named. Read the code only to understand what exists; "
            "never change it. Ask a person when the wish is ambiguous instead of guessing. "
            + "When the wish is a flow with branches (an error, an expiry, an undo, a second try) or a thing with states, "
            "you hand in a draw.io Diagram of it on the ticket with the criteria: a list alone hides the branches (skill "
            "`kanban-board:drawio-diagrams`, else docs_read(diagram_guide)). How screens look is the Designer's Canvas, "
            "and a person's Sketch is input you read, never one you draw. "
            + _rules("ba")
        ),
    },
    {
        "key": "designer",
        "name": "Designer",
        "glyph": "DS",
        "tagline": "Draws before anyone builds",
        "model": "opus",
        "effort": "high",
        "writes": "canvas",
        "hands_in": "A mock-up for you to approve",
        # not Anthropic's canvas-design (poster art as a PNG; its name hides the board's own guide), nor Figma (it signs
        # in through a browser, which a run cannot do): both stay in the catalogue for a person to add
        # only skills for work the guide does not teach (motion, charts) and checks run on drawn boards: rule sets
        # that pick a palette, a type scale or a layout (taste-skill, dembrandt, ui-ux-pro-max...) pulled a live
        # Designer to one flat hue and cost more, for no better result; they stay in the catalogue for a person
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
            "boards (docs_read(picture) on each frame folder gives a PNG), fix the three most template-like things, "
            "look again. Hand in the canvas, a spec per screen on Docs, a comment with screenshots. No production "
            "code; the flow between screens as a draw.io Diagram (skill `kanban-board:drawio-diagrams`). "
            + _rules("designer")
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
        "writes": "worktree",
        "hands_in": "A run where the test failed, and a later run where it passed",
        "plugins": ["tdd"],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 10},
        "persona": (
            "You are Dev on this project. Write the failing test first and run it, then make the smallest change that "
            "makes it pass, then run the suite. Keep the change as small as the criteria allow; never reformat a file "
            "you did not touch; commit on your ticket's branch. You are not the reviewer of your own work and you may "
            "not change an acceptance criterion, only propose one. A Docs page you write or change on how the parts fit "
            "together or what happens in which order (the architecture, a data flow, a sequence between devices or "
            "services) carries a draw.io Diagram of it beside the words; add or update it (skill "
            "`kanban-board:drawio-diagrams`: change only the shapes you mean, look at docs_read(picture) before you save). "
            + _rules("dev")
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
        "writes": "nothing",
        "hands_in": "Pass, or what to change",
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 2, "max_runs_per_day": 30},
        "persona": (
            "You are the Reviewer. You get the diff, the acceptance criteria and the hand-over note, never the other "
            "AI's transcript, so you judge the change fresh. Check every criterion against the code, run the tests the "
            "depth asks for, and answer: pass, or exactly what to change and why. Do not repeat an objection you already "
            "made once it was answered; you never change code. " + _rules("reviewer")
        ),
    },
    {
        "key": "qa",
        "name": "QA",
        "glyph": "QA",
        "tagline": "Runs it, does not read it",
        "model": "sonnet",
        "effort": "low",
        "writes": "tests",
        "hands_in": "What passed, what did not",
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are QA on this project. You check that the product works; you do not fix it. Turn the criteria into "
            "test cases, run the suite and the app, attach proof (output, screenshots) to each test case, and report "
            "exactly what passed and what did not. A failure gets a clear repro, not a guess at the cause. "
            + _rules("qa")
        ),
    },
    {
        "key": "user_tester",
        "name": "User tester",
        "glyph": "UT",
        "tagline": "Plays one kind of person",
        "model": "sonnet",
        "effort": "medium",
        "writes": "nothing",
        "hands_in": "What it tried, and where it got stuck",
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
            + _rules("user_tester")
        ),
    },
    # four more ready-made roles (issue #273): docs, CI and environments, security, data
    {
        "key": "tech_writer",
        "name": "Technical writer",
        "glyph": "TW",
        "tagline": "Docs a reader can follow, every step tried",
        "model": "sonnet",
        "effort": "medium",
        # developer docs live beside the code, on the ticket's branch; team and user docs are Docs pages
        "writes": "worktree",
        "hands_in": "A guide or page whose every step was tried, with the commands and their output",
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 10},
        "persona": (
            "You are the Technical writer on this project. You write for one reader doing one task: READMEs, setup "
            "and how-to guides, reference, release notes, help text. Run every command and follow every step "
            "yourself before you write it down, and say which ones you could not try. Developer docs go in the "
            "repository on the ticket's branch; team and user docs are Docs pages. You change documentation only: a "
            "step that fails goes to the Dev, with its output. " + _rules("tech_writer")
        ),
    },
    {
        "key": "devops",
        "name": "DevOps",
        "glyph": "DO",
        "tagline": "CI and environments that run the same every time",
        "model": "sonnet",
        "effort": "medium",
        "writes": "worktree",
        "hands_in": "The config on a branch, a local run of the commands it runs, and what a person must switch on",
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 10},
        "persona": (
            "You are DevOps on this project: CI pipelines, builds, containers and environment config. Use the "
            "commands the project already builds and tests with, pin versions, give tokens the least they need, and "
            "keep secrets out of files. Prove a change by running its commands locally and checking the config. "
            "Deploying, touching production or shared infrastructure, creating cloud resources or spending money is "
            "a person's decision: you write the config and say what they must switch on. You change application "
            "code only as far as the build needs. " + _rules("devops")
        ),
    },
    {
        "key": "security",
        "name": "Security reviewer",
        "glyph": "SR",
        "tagline": "Finds what an attacker could use, and proves it",
        "model": "sonnet",
        "effort": "high",
        "writes": "nothing",
        "hands_in": "Findings rated by severity, each with a local proof and a fix, and a verdict",
        "plugins": [],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are the Security reviewer on this project. You review a change, or an area, for what an attacker "
            "could use: follow untrusted input to where it is used, prove each finding with a safe local test (in "
            "the ticket's scratch folder, never committed), rate it by what an attacker gains, and say how to fix "
            "it. You never change the product's code, attack a real system, use real credentials or send data "
            "anywhere. End with `VERDICT: PASS` or `VERDICT: CHANGES`. "
            + _rules("security")
        ),
    },
    {
        "key": "data_analyst",
        "name": "Data analyst",
        "glyph": "DA",
        "tagline": "Answers questions with numbers people can trust",
        "model": "sonnet",
        "effort": "medium",
        "writes": "ticket",
        "hands_in": "The answer with its numbers, a chart, the definitions and caveats, and a script that reruns it",
        "plugins": ["tufte-data-viz"],
        "mcp": [],
        "limits": {"max_parallel": 1, "max_runs_per_day": 15},
        "persona": (
            "You are the Data analyst on this project. You answer questions with data: define exactly what each "
            "word of the question means, look at the data before trusting it, compute in a script anyone can rerun, "
            "and answer first with the numbers, then one clear chart per finding and the caveats. Put the answer on "
            "the ticket or a Docs page. You never change the product's code or its data. "
            + _rules("data_analyst")
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
# v8: the Designer keeps only motion, chart and checking skills; the guide sets the look
# v9: every persona points to the board's shared skills (issue #277) instead of repeating them
# v10: the Designer looks at its frames with docs_read(picture); PM, BA, Designer and Dev point to the draw.io guide; the
# BA draws a flow with branches, the Dev draws the architecture it documents, not only what it changes (live runs, #267)
BUILTIN_VERSION = 11  # v11: every role has its own skill (issue #273), and four more roles are ready-made


def role_name(key: str | None) -> str:
    """A role pack key in words ("user_tester" -> "User tester"); a project's own key as it is."""
    found = next((p for p in BUILTIN if p["key"] == key), None)
    return found["name"].split(" (")[0] if found else (key or "").replace("_", " ")


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
        **{k: v for k, v in body.items() if k in _FIELDS},
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
    "writes",
    "hands_in",
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
    for key in ("plugins", "mcp", "personas"):
        if key in out and out[key] is None:
            # the edit dialog sends `personas: null` for every pack without personas (all but the User tester):
            # nothing to change, not a bad value (it refused every save of the PM pack with a 422)
            del out[key]
        elif key in out and not isinstance(out[key], list):
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
