"""Project settings of the AI team v2 (docs/specs/ai-v2.md), in one JSON column
(`AiProjectSettings.ops`) merged over defaults, so a project that never touched them reads the defaults."""

import copy
import json

from models import AiProjectSettings

DEFAULTS: dict = {
    "lessons_in_prompt": 20,  # at most this many kept lessons go into a run's prompt
    # A run keeps its own notes across runs (its role's, and on its ticket) and reads them back (issue #274)
    "ai_notes": True,
    # Start Claude Code with its input open (stream-json), so a message reaches a running AI at its next turn (D20,
    # spike S6). Off: a message rides on the AI's next board call.
    "live_messages": True,
    # The board's own skills (services/ai/board_skills.py) switched off for every member or for one (issue #277):
    # [{skill, on, members_on, members_off}]; a skill not listed is on for everyone. A list, as above.
    "board_skills": [],
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
    # Commands saved but not run as checks yet (a repository whose own tests already fail would otherwise send every
    # ticket back to Dev): names out of test, lint, build (design/screens/ai-repo-commands.md, D2/D5)
    "checks_off": [],
    # Extra folders put in front of the PATH for everything this project runs: the wizard's trial, a ticket's prepare,
    # the checks and the AI members' runs (services/ai/project_env.py). An app opened from the Dock does not see
    # Homebrew or nvm without them.
    "env_path": [],
    "knowledge_shared": False,  # also search the shared store
    # auto: red CI the PR's own change caused, and review comments on it, go to the ticket's Dev by themselves (D21)
    "github": {"on": False, "poll_min": 5, "auto": True},
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
