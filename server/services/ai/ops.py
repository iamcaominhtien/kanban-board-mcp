"""Project settings of the AI team v2 (docs/specs/ai-claude-code-implementation.md), in one JSON column
(`AiProjectSettings.ops`) merged over defaults, so a project that never touched them reads the defaults."""

import copy
import json

from models import AiProjectSettings

DEFAULTS: dict = {
    # Phase 2 — reliability
    "hang_after_min": 10,  # no stream event for this long while running: the watchdog looks at it
    "diagnose_with_model": True,  # a light model reads the last steps when the code cannot tell
    # Phase 3 — knowledge
    "propose_lessons": True,  # a light model proposes lessons at the end of a ticket
    "lessons_in_prompt": 20,  # at most this many kept lessons go into a run's prompt
    # Load a member's skills, subagents and hooks per run through CLI flags instead of writing them into its folder
    # (D5). Always on for a project that uses worktrees; for the rest, a switch (a migration removes what was written).
    "per_run_config": False,
    # Start Claude Code with its input open (stream-json), so a message reaches a running AI at its next turn (D20,
    # spike S6). Off: a message rides on the AI's next board call.
    "live_messages": False,
    # Load the person's own Claude Code plugins (installed for their user in ~/.claude) in every Claude Code run, so an
    # AI on the board has what the same model has in their terminal (services/ai/own_claude.py)
    "own_claude": True,
    # Which roles load each of those plugins (ai-story-flow Q2): [{plugin, roles}]; a plugin not listed loads for
    # every role. A list, not a dict keyed by plugin name: the UI camel-cases keys.
    "own_claude_roles": [],
    # Phase 4 — worktrees and hand-over
    "worktrees": {
        "on": False,
        "repo": None,  # the main checkout; None: the member's working folder
        "prepare": "",  # e.g. "npm ci" or "uv sync", run once in a new worktree
        "base_port": 5180,
        "handover": "auto",  # auto | pr | local | branch
        "base_branch": None,  # None: the repository's current branch
    },
    "commands": {
        "test": "",
        "lint": "",
        "build": "",
    },  # the project's checks (the Checks step, the scan)
    # Phase 6 — workflows
    "workflow_default": "standard",  # a template key, or "" for none (hand work straight to one AI)
    "coordinator_id": None,  # the PM member that arbitrates (D12, D24)
    "triage_id": None,  # the Triage that takes new tickets; None: any member with the Triage role
    # D8: a new ticket in this column, assigned to nobody, is put on `workflow_default` and Triage takes it. A ticket
    # given straight to one AI stays an odd job; one given to a person is theirs.
    "intake": {"on": False, "status": "todo"},
    # How far the team goes without a person. done: "person" (D7: a person moves it to Done, which merges) or
    # "after_review" (the board moves it to Done itself once Checks passed, the test went red first and the review
    # said pass)
    # approve: who decides a step that waits for a person before the last one (the design): "person" (D10) or "pm"
    # (the coordinator looks at the hand-in, comments on it and approves or sends it back)
    "autonomy": {"done": "person", "approve": "person"},
    # D24: the coordinator (the PM) runs the team. A step that failed twice, an AI's question or permission request
    # nobody picked up, and a ticket Triage says is several pieces of work go to it before they go to a person.
    "manager": {
        "on": False,
        "grace_min": 0,  # minutes a question waits for a person before the PM takes it
        "max_risk": "medium",
        "per_hour_limit": 20,
    },
    # Design I: a Dev step hands in a failing test run and a passing one; without them it is not done
    "tdd": {"required": True},
    "ticket_token_cap": 0,  # tokens one ticket's workflow may use before it stops for a person (D11); 0: no cap
    # Phase 7 — the Board AI acts as the person by risk tier (D23); `tiers` lowers middle-tier actions to "free"
    "board_ai": {"acts": True, "tiers": {}},
    # Phase 8
    "knowledge_shared": False,  # also search the shared store
    # auto: red CI the PR's own change caused, and review comments on it, go to the ticket's Dev by themselves (D21)
    "github": {"on": False, "poll_min": 5, "auto": True},
    # Issue #275 — what a CLI run may do without stopping (services/ai/tool_rules.py). preset: careful | normal |
    # trusted | custom; bypass: never | member (each member's own choice) | always; web_search: off | roles | on;
    # ask_cli: a tool the CLI refused becomes a request a person answers once ("this ticket / project / role")
    "permissions": {
        "preset": "normal",
        "bypass": "member",
        "web_search": "roles",
        "ask_cli": True,
    },
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def get(settings: AiProjectSettings | None) -> dict:
    """The project's settings over the defaults."""
    try:
        stored = json.loads(settings.ops) if settings and settings.ops else {}
    except ValueError:
        stored = {}
    return _merge(DEFAULTS, stored if isinstance(stored, dict) else {})


def update(settings: AiProjectSettings, patch: dict) -> dict:
    """Merge `patch` into the stored settings (only known keys); returns the full result."""
    try:
        stored = json.loads(settings.ops) if settings.ops else {}
    except ValueError:
        stored = {}
    clean = {k: v for k, v in (patch or {}).items() if k in DEFAULTS}
    merged = _merge(stored if isinstance(stored, dict) else {}, clean)
    settings.ops = json.dumps(merged)
    return _merge(DEFAULTS, merged)
