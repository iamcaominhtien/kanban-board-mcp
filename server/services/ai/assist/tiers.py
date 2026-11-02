"""What the Board AI may do by itself, by how hard a thing is to undo (design/screens/ai-board-wave3.md, A–E; D23).

Three tiers, decided by one question — can the board put it back by itself?

- **Just does it**: looking things up. Nothing changes, so there is nothing to undo.
- **Does it, and keeps an Undo**: reversible and small — up to three tickets, in one project. Create or edit a ticket,
  move it (not to Done), assign it, comment, put it on a workflow or set its review depth, start or stop one run,
  pause or resume one AI.
- **Asks first**: hard to put back, or big — Done, more than three tickets or more than one project, deleting
  anything, Pause all AI, permission/ceiling/bypass changes, budgets and accounts, merging, anything that posts
  outside the board.

A fixed set can never leave the ask-first tier, whatever a project setting says, and the server enforces it (this is
also what stops a standing order from reaching one). Only the middle tier can be lowered, and only to the first.
"""

BULK_TICKETS = 3

FREE, UNDO, ASK = "free", "undo", "ask"

# op -> (tier, locked). A locked op stays in the ask-first tier for ever.
TIERS: dict[str, tuple[str, bool]] = {
    "status": (UNDO, False),
    "priority": (UNDO, False),
    "tags": (UNDO, False),
    "assignee": (UNDO, False),
    "due_date": (UNDO, False),
    "estimate": (UNDO, False),
    "title": (UNDO, False),
    "comment": (UNDO, False),
    "add_criteria": (UNDO, False),
    "workflow": (UNDO, False),
    "depth": (UNDO, False),
    "run": (UNDO, False),
    "stop_run": (UNDO, False),
    "pause_member": (UNDO, False),
    "resume_member": (UNDO, False),
    "create": (
        UNDO,
        False,
    ),  # a new ticket (a piece of a split): Undo deletes it while nobody touched it
    "delegate": (UNDO, False),  # the PM coordinates the ticket (D24)
    "message": (FREE, False),  # a message to the AI working on a ticket (D20)
    # locked in the last tier
    "done": (ASK, True),
    "delete": (ASK, True),
    "pause_all": (ASK, True),
    "permission": (ASK, True),
    "budget": (ASK, True),
    "merge": (ASK, True),
    "post_outside": (ASK, True),
}
LOCKED = sorted(op for op, (_, locked) in TIERS.items() if locked)


def op_key(change: dict) -> str:
    """The tier key of one change: a move to Done is its own op."""
    if change.get("op") == "status" and change.get("to") == "done":
        return "done"
    return str(change.get("op") or "")


def tier_of(change: dict, overrides: dict | None = None) -> str:
    """The tier of one change, with the project's overrides applied where they are allowed."""
    key = op_key(change)
    tier, locked = TIERS.get(key, (ASK, False))
    want = (overrides or {}).get(key)
    if locked or want is None:
        return tier
    if tier == UNDO and want == FREE:
        return FREE  # the middle tier may be lowered to the first (no Undo is kept)
    return tier


def decide(
    changes: list[dict],
    *,
    project_ids: set[str] | None = None,
    overrides: dict | None = None,
) -> dict:
    """Whether a set of changes is done by itself or asks first, and why.

    Returns:
        {"act": bool, "tier": "free"|"undo"|"ask", "reasons": [...], "tiers": [per change]}
    """
    tiers = [tier_of(ch, overrides) for ch in changes]
    reasons = []
    for ch, t in zip(changes, tiers, strict=False):
        if t == ASK:
            key = op_key(ch)
            label = {"done": f"Moving {ch.get('ticket')} to Done"}.get(
                key, f"{key.replace('_', ' ').capitalize()}"
            )
            reasons.append(
                f"{label} asks first"
                + (" (it cannot be moved out of this tier)" if key in LOCKED else "")
            )
    tickets = {ch.get("ticket") for ch in changes if ch.get("ticket")}
    # each new ticket counts as one more ticket touched
    tickets |= {("new", i) for i, ch in enumerate(changes) if ch.get("op") == "create"}
    # pausing or resuming AIs names members, not tickets: they count toward the same limit (else pausing every AI
    # one by one would be Pause all without asking)
    members = {
        ch.get("member")
        for ch in changes
        if op_key(ch) in ("pause_member", "resume_member") and ch.get("member")
    }
    if len(tickets) + len(members) > BULK_TICKETS:
        what = (
            f"{len(tickets)} tickets"
            if not members
            else f"{len(members)} AI members"
            if not tickets
            else f"{len(tickets)} tickets and {len(members)} AI members"
        )
        reasons.append(f"{what} at once is a bulk action, which asks first")
    if project_ids and len(project_ids) > 1:
        reasons.append("Changes across more than one project ask first")
    act = not reasons and bool(changes)
    tier = ASK if reasons else (UNDO if UNDO in tiers else FREE)
    return {"act": act, "tier": tier, "reasons": reasons, "tiers": tiers}


def table(overrides: dict | None = None) -> list[dict]:
    """Every action with its tier and lock, for the settings page."""
    return [
        {
            "op": op,
            "tier": tier_of(
                {
                    "op": op if op != "done" else "status",
                    **({"to": "done"} if op == "done" else {}),
                },
                overrides,
            ),
            "default": tier,
            "locked": locked,
        }
        for op, (tier, locked) in TIERS.items()
    ]


def check_overrides(overrides: dict) -> dict:
    """Keep only allowed moves: the middle tier lowered to the first. A locked op is refused.

    Raises:
        ValueError: An override names a locked op, or moves something other than down from the middle tier.
    """
    out = {}
    for op, want in (overrides or {}).items():
        tier, locked = TIERS.get(op, (None, False))
        if tier is None:
            raise ValueError(f"Unknown action: {op}")
        if locked:
            raise ValueError(f"{op} can never leave the ask-first tier.")
        if want == tier:
            continue
        if not (tier == UNDO and want == FREE):
            raise ValueError(
                "Only an action of the middle tier can be lowered, and only to the first."
            )
        out[op] = want
    return out
