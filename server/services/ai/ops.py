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
    "triage_id": None,
    # Phase 8
    "knowledge_shared": False,  # also search the shared store
    "github": {"on": False, "poll_min": 5},
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
