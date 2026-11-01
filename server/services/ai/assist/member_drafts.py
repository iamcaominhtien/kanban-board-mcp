"""The Board AI proposes new AI members; a person edits and approves them; only then are they created.

The model only writes a proposal (name, role text, template, ceiling, limits). Everything it writes is checked here
before it is shown, and again when a person presses Create: a proposal can never carry a key, Bypass permissions, a
status ceiling past Review or any other power the Add AI member dialog guards with a person's confirmation. The
members are created by the same `members.create` the dialog uses, as the person who approved."""

import re

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiDraft, AiMember, Member

from .. import audit
from .. import members as svc_members
from ..store import loads

MAX_MEMBERS = 5
MAX_PERSONA = svc_members.MAX_PERSONA
TEMPLATES_OK = ("developer", "reviewer", "read_only")
CEILINGS_OK = ("none", "backlog", "todo", "in-progress", "review")
# What a member that never edits files may run; the same lists as the PM and Reviewer of the Add dialog
READ_ONLY_ALLOW = [
    "Read",
    "Glob",
    "Grep",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
]
REVIEW_ALLOW = READ_ONLY_ALLOW + [
    "Bash(python -m pytest:*)",
    "Bash(python3 -m pytest:*)",
    "Bash(pytest:*)",
    "Bash(npm test:*)",
    "Bash(npm run test:*)",
    "Bash(npm run lint:*)",
]
# Keys a proposal must never carry: ignored, and said so
FORBIDDEN_KEYS = (
    "api_key",
    "key",
    "token",
    "permission_mode",
    "bypass",
    "confirm_bypass",
    "confirm_done",
    "provider",
    "working_dir",
    "cli_path",
    "permissions",
    "config",
)
_MODEL_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,59}$")


def _int(value, lo: int, hi: int, default: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def check_ai_members(raw: list, taken: set[str]) -> tuple[list[dict], list[str]]:
    """Validate proposed members.

    Args:
        raw: What the model (or the person's edit) wrote.
        taken: Lower-case names already used in the project.

    Returns:
        (members ready to show or create, notes about what was changed or dropped)
    """
    out: list[dict] = []
    notes: list[str] = []
    used = set(taken)
    for item in (raw or [])[:MAX_MEMBERS]:
        if not isinstance(item, dict):
            continue
        for key in FORBIDDEN_KEYS:
            if key in item:
                notes.append(f"Ignored “{key}”: a proposal cannot set it.")
        name = " ".join(str(item.get("name") or "").split())[:40]
        if not name:
            notes.append("A proposal without a name was dropped.")
            continue
        if name.lower() in used:
            n = 2
            while f"{name} {n}".lower() in used:
                n += 1
            notes.append(f"“{name}” is already taken; proposed “{name} {n}”.")
            name = f"{name} {n}"
        used.add(name.lower())
        template = str(item.get("template") or "developer").strip().lower()
        if template not in TEMPLATES_OK:
            notes.append(
                f"{name}: unknown role template {template!r}; using Developer."
            )
            template = "developer"
        ceiling = str(item.get("ceiling") or "review").strip().lower().replace(" ", "-")
        ceiling = {"to-do": "todo", "in_progress": "in-progress"}.get(ceiling, ceiling)
        if ceiling not in CEILINGS_OK:
            notes.append(
                f"{name}: moving tickets past Review needs an owner's confirmation in the Add dialog; using Review."
            )
            ceiling = "review"
        persona = str(item.get("persona") or "").strip()
        if len(persona) > MAX_PERSONA:
            notes.append(f"{name}: the persona was cut to {MAX_PERSONA} characters.")
            persona = persona[:MAX_PERSONA].rstrip()
        model = str(item.get("model") or "").strip()
        if model and not _MODEL_OK.match(model):
            model = ""
        read_only = item.get("read_only_cli")
        out.append(
            {
                "name": name,
                "description": " ".join(str(item.get("description") or "").split())[
                    :200
                ],
                "persona": persona,
                "template": template,
                "ceiling": ceiling,
                "max_parallel": _int(item.get("max_parallel"), 1, 10, 1),
                "max_runs_per_day": _int(item.get("max_runs_per_day"), 1, 500, 10),
                "read_only_cli": (
                    bool(read_only)
                    if read_only is not None
                    else template != "developer"
                ),
                "model": model,
                "why": " ".join(str(item.get("why") or "").split())[:300],
            }
        )
    if len(raw or []) > MAX_MEMBERS:
        notes.append(f"Only the first {MAX_MEMBERS} members are shown.")
    return out, notes


async def taken_names(session: AsyncSession, project_id: str) -> set[str]:
    """Names the project's members use now, lower case. A removed AI member keeps its row (its history) but gives its
    name back: the Add dialog's own name check (`members.check_name`) skips it too."""
    rows = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id, Member.kind != "ai_removed"
            )
        )
    ).all()
    return {m.name.strip().lower() for m in rows}


def create_body(spec: dict, base: AiMember) -> dict:
    """What `members.create` gets for one proposal: the connection of the AI that wrote it, the proposal's role."""
    body = {
        "name": spec["name"],
        "provider": base.provider,
        "working_dir": base.working_dir,
        "cli_path": base.cli_path or None,
        "model": spec["model"] or base.model,
        "description": spec["description"],
        "persona": spec["persona"],
        "max_parallel": spec["max_parallel"],
        "max_runs_per_day": spec["max_runs_per_day"],
        "ceiling": spec["ceiling"],
        "template": spec["template"],
        "permissions": {},
    }
    if spec["read_only_cli"]:
        body["config"] = {
            "allow_rules": REVIEW_ALLOW
            if spec["template"] == "reviewer"
            else READ_ONLY_ALLOW
        }
    return body


def refusal(base: AiMember | None) -> str | None:
    """Why members cannot be created from this AI's connection, or None."""
    if base is None:
        return "The AI that wrote this proposal no longer exists."
    if base.connection != "local" or base.provider != "claude-code":
        return (
            "New members copy the connection of the AI that proposes them, and an API key is never copied. "
            "Add them in the Add AI member dialog instead."
        )
    return None


async def apply(
    session: AsyncSession,
    d: AiDraft,
    person: str,
    *,
    selected: list[int] | None,
    edited: list[dict] | None,
) -> dict:
    """Create the chosen members as `person`. Returns {"created": [{id, name}], "failed": [{name, message}]}.

    Raises:
        svc_members.AiPermissionDenied: `person` cannot add AI members.
    """
    from .drafts import AssistError, role_of

    if await role_of(session, d.project_id, person) != "admin":
        raise AssistError("forbidden", "Only an admin or the owner can add AI members.")
    base = await session.get(AiMember, d.member_id) if d.member_id else None
    why = refusal(base)
    if why:
        raise AssistError("invalid", why)
    payload = loads(d.payload, {})
    items = edited if edited is not None else payload.get("members") or []
    taken = await taken_names(session, d.project_id)
    specs, _ = check_ai_members(items, taken)
    chosen = (
        [specs[i] for i in selected if 0 <= i < len(specs)]
        if selected is not None
        else specs
    )
    if not chosen:
        raise AssistError("invalid", "Pick at least one member to create.")
    created, failed = [], []
    for spec in chosen:
        try:
            m = await svc_members.create(
                session, d.project_id, create_body(spec, base), by=person
            )
        except svc_members.AiMemberError as exc:
            failed.append({"name": spec["name"], "message": str(exc)})
            continue
        created.append({"id": m.id, "name": m.name})
        await audit.record(
            d.project_id,
            "ai_member_created_via_assistant",
            "info",
            member_id=m.id,
            member_name=m.name,
            on_behalf_of=person,
            detail={"draft": d.id, "proposed_by": d.member_name},
        )
    return {"created": created, "failed": failed}


async def undo(session: AsyncSession, d: AiDraft, person: str) -> tuple[int, list[str]]:
    """Remove the members this draft created (their open tickets, if any, are unassigned)."""
    undone, skipped = 0, []
    for c in loads(d.result, {}).get("created") or []:
        try:
            await svc_members.remove(session, c["id"], by=person)
            undone += 1
        except svc_members.AiMemberError as exc:
            skipped.append(f"{c['name']}: {exc}")
    return undone, skipped
