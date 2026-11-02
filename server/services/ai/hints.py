"""Say why (issue #275): every refusal tells the AI what it may do instead and tells the person what to switch on.

`explain` takes what refused (the permission action, the layer that decided, the reason code) and returns two
sentences: `instead`, appended to what the AI reads, and `switch`, appended to the notice a person gets. A rule kept on
purpose says so, so nobody hunts for a switch that does not exist.
"""

from __future__ import annotations

# What the AI may do instead, per permission action
_INSTEAD: dict[str, str] = {
    "read": "Stop and say in your report that you could not read it.",
    "comment": "Put what you wanted to say in your final report.",
    "edit_fields": "Write the change you propose as a comment on the ticket; a person applies it.",
    "change_status": "Leave the status as it is, say in your report what it is ready for, and finish.",
    "change_assignee": "Hand the work over with ai_run(action='handoff', member=<name>) or say in your report who "
    "should take it.",
    "create_tickets": "List the follow-up tickets (title and one line each) in a comment or your report; a person "
    "creates them.",
    "delete_tickets": "Say in a comment which ticket should go and why; a person deletes it.",
    "edit_docs": "Comment on the page with the change you propose (docs_write action='comment').",
    "delete_docs": "Say in a comment which page should go and why; a person moves it to the trash.",
    "manage_test_cases": "Put the results and their evidence in your report.",
    "create_branches": "Work on the branch you were given and name the branch you need in your report.",
    "manage_project": "Say in your report what should change in the project; a person does it.",
}

# What the person switches on, per deciding layer (prefix of the layer's name)
_SWITCH: list[tuple[str, str]] = [
    ("Policy", "Kept on purpose: projects and members are managed by people only."),
    ("Pause all AI", "Resume AI from the header (Pause all AI)."),
    ("Safe mode (this agent)", "Turn this AI's safe mode off on its Permissions tab."),
    ("Safe mode", "Turn Safe mode off in Settings › AI › Safety and limits."),
    (
        "Project setting · ask before Docs edits",
        "Switch “Ask before Docs edits” off (Settings › AI › Safety and limits), or answer once and remember it for "
        "the project.",
    ),
    (
        "Agent matrix",
        "This AI's own Permissions tab sets it stricter than its role template: loosen it there, or answer once and "
        "remember it.",
    ),
    (
        "Role template",
        "Change this AI's role template or its row on the Permissions tab (Custom widens it; the owner decides).",
    ),
]

_CODES: dict[str, tuple[str, str]] = {
    "status_ceiling": (
        "Leave the ticket where it is, say in your report that it is ready for the next step, and finish; a person "
        "moves it.",
        "Raise this AI's status ceiling on its Permissions tab (Done needs an extra confirmation), or move the "
        "ticket yourself.",
    ),
    "approvals_full": (
        "Do not ask again: finish what you can and list in your report what still waits.",
        "Decide the waiting requests in Inbox › Approvals; “Approve & remember” stops the same question coming back.",
    ),
    "scope": (
        "Work only on your own ticket; comment there what the other ticket needs.",
        "Widen this AI's scope to “Any ticket in these projects” on its Permissions tab (the owner confirms), or "
        "assign it the ticket.",
    ),
    "autopilot": (
        "Say in your answer what should change; Autopilot only reads and decides.",
        "Kept on purpose: Autopilot decides, it does not change the board itself.",
    ),
}


def explain(
    perm: str, layer: str | None = None, code: str = "blocked"
) -> tuple[str, str]:
    """(what the AI may do instead, what a person switches on) for a refusal."""
    if code in _CODES:
        return _CODES[code]
    instead = _INSTEAD.get(
        perm, "Carry on without it and say in your report what you could not do."
    )
    switch = next(
        (text for prefix, text in _SWITCH if layer and layer.startswith(prefix)),
        "Open “Why was this blocked?” on the notice to see which rule decided and who can change it.",
    )
    if perm in ("delete_tickets", "delete_docs") and (layer or "").startswith(
        "Role template"
    ):
        switch = (
            "Blocked by default on purpose. The owner may set it to Needs approval, or lift the lock on this AI's "
            "Permissions tab (with a warning)."
        )
    return instead, switch
