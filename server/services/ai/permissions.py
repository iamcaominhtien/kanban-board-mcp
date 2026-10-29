"""What an AI member may do: role templates, stricter-only overrides, the status ceiling and safe mode.

The effective mode of an action is the most restrictive of every layer (design/screens/ai-safety-cost.md, A and I6):
role template → the member's own overrides → safe mode → the project kill switch. Nothing an AI reads or writes
can change these; only people do, through the REST API.
"""

import json
from dataclasses import dataclass

ALLOWED = "allowed"
APPROVAL = "approval"
BLOCKED = "blocked"
MODES = (ALLOWED, APPROVAL, BLOCKED)
_RANK = {ALLOWED: 0, APPROVAL: 1, BLOCKED: 2}

# action: (label, description, risk)
ACTIONS: dict[str, tuple[str, str, str]] = {
    "read": ("Read tickets", "Fields, comments, relations, linked docs", "low"),
    "comment": ("Comment", "Replies carry the AI badge and run link", "low"),
    "edit_fields": (
        "Edit fields",
        "Title, description, estimate, tags, criteria, sub-tasks",
        "low",
    ),
    "change_status": ("Change status", "Within the status ceiling", "medium"),
    "change_assignee": ("Change assignee", "Posts an approval request", "medium"),
    "create_tickets": ("Create tickets", "Sub-tickets and follow-ups", "low"),
    "delete_tickets": (
        "Delete tickets",
        "Blocked by default; owners may allow with approval only",
        "high",
    ),
    "edit_docs": ("Edit docs", "Doc edits wait for approval", "medium"),
    "manage_test_cases": (
        "Manage test cases",
        "Create, edit, link; results from runs",
        "low",
    ),
    "create_branches": (
        "Create branches",
        "Link ai/… branches to the ticket",
        "medium",
    ),
}
# Never available to an AI, whatever a template or override says: an AI can never widen anyone's permissions.
FORBIDDEN = {"manage_project": "Projects and members are managed by people only."}

TEMPLATES: dict[str, dict[str, str]] = {
    "developer": {
        "read": ALLOWED,
        "comment": ALLOWED,
        "edit_fields": ALLOWED,
        "change_status": ALLOWED,
        "change_assignee": APPROVAL,
        "create_tickets": ALLOWED,
        "delete_tickets": BLOCKED,
        "edit_docs": APPROVAL,
        "manage_test_cases": ALLOWED,
        "create_branches": ALLOWED,
    },
    "reviewer": {
        "read": ALLOWED,
        "comment": ALLOWED,
        "edit_fields": APPROVAL,
        "change_status": ALLOWED,
        "change_assignee": BLOCKED,
        "create_tickets": APPROVAL,
        "delete_tickets": BLOCKED,
        "edit_docs": BLOCKED,
        "manage_test_cases": ALLOWED,
        "create_branches": BLOCKED,
    },
    "read_only": {
        "read": ALLOWED,
        "comment": ALLOWED,
        "edit_fields": BLOCKED,
        "change_status": BLOCKED,
        "change_assignee": BLOCKED,
        "create_tickets": BLOCKED,
        "delete_tickets": BLOCKED,
        "edit_docs": BLOCKED,
        "manage_test_cases": BLOCKED,
        "create_branches": BLOCKED,
    },
    # Custom unlocks wider settings (it starts from Developer); changing it is an owner's decision.
    "custom": {
        "read": ALLOWED,
        "comment": ALLOWED,
        "edit_fields": ALLOWED,
        "change_status": ALLOWED,
        "change_assignee": ALLOWED,
        "create_tickets": ALLOWED,
        "delete_tickets": APPROVAL,
        "edit_docs": ALLOWED,
        "manage_test_cases": ALLOWED,
        "create_branches": ALLOWED,
    },
}
# Hard locks: the least restrictive mode an action can ever have.
LOCKS = {"delete_tickets": APPROVAL}
# Actions an owner may loosen from Blocked to Needs approval on a stricter template (A1).
OWNER_ENABLEABLE = ("delete_tickets",)
SAFE_MODE_ALLOWED = {"read", "comment"}

STATUS_ORDER = ["backlog", "todo", "in-progress", "review", "testing", "done"]
CEILINGS = ["none", *STATUS_ORDER]
DEFAULT_CEILING = "review"


def status_rank(status: str) -> int:
    """Position of a status on the ceiling scale; Won't Do counts as Done (a closing decision)."""
    if status == "wont_do":
        return STATUS_ORDER.index("done")
    return STATUS_ORDER.index(status) if status in STATUS_ORDER else -1


def ceiling_rank(ceiling: str) -> int:
    """Rank of a ceiling: 'none' is below every status."""
    return -1 if ceiling == "none" else status_rank(ceiling)


def stricter(a: str, b: str) -> str:
    """The more restrictive of two modes."""
    return a if _RANK[a] >= _RANK[b] else b


def _raw(member) -> dict:
    try:
        raw = json.loads(member.permissions or "{}")
    except ValueError:
        return {}
    return raw if isinstance(raw, dict) else {}


def overrides_of(member) -> dict[str, str]:
    """The member's own overrides, ignoring anything malformed."""
    return {k: v for k, v in _raw(member).items() if k in ACTIONS and v in MODES}


def owner_enabled_of(member) -> dict[str, dict]:
    """Actions an owner loosened past the template (only Delete tickets, and only to 'approval'), with who and
    when. Stored beside the overrides under `_owner`."""
    raw = _raw(member).get("_owner")
    if not isinstance(raw, dict):
        return {}
    return {
        k: v
        for k, v in raw.items()
        if k in OWNER_ENABLEABLE and isinstance(v, dict) and (v.get("mode") == APPROVAL)
    }


def validate_overrides(
    template: str, overrides: dict[str, str], *, owner: bool = False
) -> dict[str, str]:
    """Check an override set: modes must exist and, except for Custom, only make the template stricter.
    An owner may set Delete tickets to 'approval' on any template (never to 'allowed').

    Raises:
        ValueError: With a message the UI shows as is.
    """
    if template not in TEMPLATES:
        raise ValueError(f"Unknown role template '{template}'.")
    base = TEMPLATES[template]
    out: dict[str, str] = {}
    for action, mode in overrides.items():
        if action.startswith("_"):
            continue
        if action not in ACTIONS:
            raise ValueError(f"Unknown action '{action}'.")
        if mode not in MODES:
            raise ValueError(f"Mode must be one of {', '.join(MODES)}.")
        lock = LOCKS.get(action)
        if lock and _RANK[mode] < _RANK[lock]:
            raise ValueError(
                f"{ACTIONS[action][0]} can be at most '{lock}' for an AI member."
            )
        if (
            owner
            and action in OWNER_ENABLEABLE
            and mode == APPROVAL
            and base[action] == BLOCKED
        ):
            out[action] = mode
            continue
        if template != "custom" and _RANK[mode] < _RANK[base[action]]:
            raise ValueError(
                f"Overrides can only make the template stricter: {ACTIONS[action][0]} is "
                f"'{base[action]}' in {template}. Switch to Custom (owner) to widen it."
            )
        if mode != base[action]:
            out[action] = mode
    return out


@dataclass
class Decision:
    """The effective mode of one action, and which layer decided it."""

    action: str
    mode: str
    reason: str
    layers: list[dict]


def effective(member, action: str, settings=None) -> Decision:
    """The effective mode of `action` for `member`: the most restrictive layer wins (an owner-enabled Delete
    tickets replaces the template's Blocked)."""
    if action in FORBIDDEN:
        return Decision(
            action, BLOCKED, FORBIDDEN[action], [{"layer": "Policy", "mode": BLOCKED}]
        )
    template = member.template if member.template in TEMPLATES else "developer"
    own = overrides_of(member).get(action)
    owner_set = action in owner_enabled_of(member) and own == APPROVAL
    layers = [
        {
            "layer": f"Role template · {template}",
            "mode": APPROVAL if owner_set else TEMPLATES[template].get(action, BLOCKED),
        }
    ]
    if own:
        layers.append({"layer": "Agent matrix", "mode": own})
    if action not in SAFE_MODE_ALLOWED:
        if settings is not None and settings.safe_mode:
            layers.append({"layer": "Safe mode", "mode": BLOCKED})
        elif getattr(member, "safe_mode", False):
            layers.append({"layer": "Safe mode (this agent)", "mode": BLOCKED})
    if settings is not None and settings.paused_all:
        layers.append({"layer": "Pause all AI", "mode": BLOCKED})
    mode = ALLOWED
    decider = layers[0]
    for layer in layers:
        if _RANK[layer["mode"]] > _RANK[mode]:
            mode, decider = layer["mode"], layer
    lock = LOCKS.get(action)
    if lock and _RANK[mode] < _RANK[lock]:
        mode = lock
    reason = (
        f"{ACTIONS.get(action, (action,))[0]} is '{mode}' ({decider['layer']})."
        if mode != ALLOWED
        else "Allowed."
    )
    return Decision(action, mode, reason, layers)


def matrix(member, settings=None) -> list[dict]:
    """Every action with its template mode, override and effective mode (Permissions tab)."""
    template = member.template if member.template in TEMPLATES else "developer"
    own = overrides_of(member)
    enabled = owner_enabled_of(member)
    rows = []
    for action, (label, description, risk) in ACTIONS.items():
        d = effective(member, action, settings)
        owner_set = enabled.get(action) if own.get(action) == APPROVAL else None
        if owner_set:
            source = "Owner-enabled"
        elif own.get(action):
            source = "Override · stricter" if template != "custom" else "Override"
        else:
            source = f"Template · {template}"
        rows.append(
            {
                "action": action,
                "label": label,
                "description": description,
                "risk": risk,
                "template_mode": TEMPLATES[template][action],
                "override": own.get(action),
                "mode": d.mode,
                "locked_min": LOCKS.get(action),
                "source": source,
                "source_by": owner_set.get("by") if owner_set else None,
                "source_at": owner_set.get("at") if owner_set else None,
                "owner_enabled": bool(owner_set),
                "ceiling_note": (member.ceiling or DEFAULT_CEILING)
                if action == "change_status"
                else None,
            }
        )
    return rows


def check_status_move(member, current: str, target: str) -> str | None:
    """Why the status ceiling forbids moving a ticket from `current` to `target`, or None when it is allowed."""
    ceiling = member.ceiling or DEFAULT_CEILING
    limit = ceiling_rank(ceiling)
    if limit < 0:
        return "This AI member may not change ticket status (ceiling: None)."
    if status_rank(target) > limit:
        label = "Won't Do" if target == "wont_do" else target
        return (
            f"{label} is above the status ceiling ({ceiling}). The ticket stays where it is; "
            "a person decides beyond the ceiling."
        )
    if status_rank(current) > limit:
        return f"The ticket is in {current}, above the ceiling ({ceiling}); only a person can move it."
    return None
