"""What an AI's CLI may run without stopping (issue #275): presets, what each role needs, web search, and the rule a
refused tool call becomes when a person allows it once.

The board writes the CLI's allow and deny rules before every run (`runs.cli_tool_rules`). A headless run cannot ask
mid-call, so a tool nothing allows is refused and the AI either works around it or stops. Three things cut the needless
stops while what is risky stays with a person:

- **What the role needs** (`ROLE_TOOLS`): a Dev installs packages and runs its tests, QA starts the app, a Designer
  serves its files and uses the browser. These rules are added to the member's own allow list in every run that is not
  in safe mode. Never `git push`, `sudo` or a delete: those stay with a person.
- **Web search** (`web_search`): off, by role (the roles that look things up: PM, BA, Designer, Dev), or on. Web
  pages (WebFetch) stay limited to the allowed domains unless the run is in Bypass.
- **Presets** (`PRESETS`): Careful, Normal and Trusted set the switches above in one go, each explained in a line.

What a person allowed once for a tool (`rule_for`) is kept as a grant (services/ai/safety.py) and added to the
next runs it covers: this ticket, this project, or every member with the role.
"""

from __future__ import annotations

import re
import shlex
from urllib.parse import urlparse

from models import AiProjectSettings

from . import ops

# ---------------------------------------------------------------------------
# What each role needs
# ---------------------------------------------------------------------------

READ = ["Read", "Glob", "Grep"]
WRITE = ["Edit", "Write", "MultiEdit"]
MKDIR = ["Bash(mkdir:*)", "Bash(ls:*)"]
GIT_READ = [
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git branch:*)",
]
GIT_COMMIT = [
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(git restore:*)",
    "Bash(git stash:*)",
    "Bash(git mv:*)",
    "Bash(git rm:*)",
]
# Moving to the ticket's branch when the run has no worktree of its own: the Dev guide says commit on the ticket's
# branch, and a live Dev's `git checkout <branch>` was refused, so its work stayed on main (issue #274). Only creating
# and switching; the forms that throw away changes stay refused (BRANCH_DENY).
BRANCH_SWITCH = ["Bash(git switch:*)", "Bash(git checkout -b:*)"]
BRANCH_DENY = [
    "Bash(git switch -f:*)",
    "Bash(git switch --force:*)",
    "Bash(git switch --discard-changes:*)",
]
INSTALL = [
    "Bash(npm ci:*)",
    "Bash(npm install:*)",
    "Bash(npm i:*)",
    "Bash(pnpm install:*)",
    "Bash(pnpm add:*)",
    "Bash(yarn install:*)",
    "Bash(yarn add:*)",
    "Bash(pip install:*)",
    "Bash(python -m pip install:*)",
    "Bash(python3 -m pip install:*)",
    "Bash(uv sync:*)",
    "Bash(uv add:*)",
    "Bash(uv pip install:*)",
    "Bash(poetry install:*)",
    "Bash(go mod download:*)",
    "Bash(cargo fetch:*)",
]
TESTS = [
    "Bash(npm test:*)",
    "Bash(npm run test:*)",
    "Bash(npm run lint:*)",
    "Bash(npm run build:*)",
    "Bash(npm run typecheck:*)",
    "Bash(pnpm test:*)",
    "Bash(pnpm run:*)",
    "Bash(yarn test:*)",
    "Bash(npx vitest:*)",
    "Bash(npx jest:*)",
    "Bash(npx tsc:*)",
    "Bash(npx eslint:*)",
    "Bash(pytest:*)",
    "Bash(python -m pytest:*)",
    "Bash(python3 -m pytest:*)",
    # a repository tested with the standard library: a live Dev's `python3 -m unittest` was refused (issue #274)
    "Bash(python -m unittest:*)",
    "Bash(python3 -m unittest:*)",
    "Bash(uv run pytest:*)",
    "Bash(uv run ruff:*)",
    "Bash(uvx pytest:*)",
    "Bash(go test:*)",
    "Bash(go build:*)",
    "Bash(go vet:*)",
    "Bash(cargo test:*)",
    "Bash(cargo build:*)",
    "Bash(make test:*)",
]
START_APP = [
    "Bash(npm run dev:*)",
    "Bash(npm start:*)",
    "Bash(npm run start:*)",
    "Bash(npm run preview:*)",
    "Bash(npx vite:*)",
    "Bash(uv run:*)",
    "Bash(curl:*)",
    "Bash(lsof:*)",
    "Bash(kill:*)",
]
SERVE = [
    "Bash(python -m http.server:*)",
    "Bash(python3 -m http.server:*)",
    "Bash(npx serve:*)",
    "Bash(npx http-server:*)",
    "Bash(curl:*)",
]
BROWSER = ["Bash(npx playwright:*)", "mcp__playwright"]

ROLE_TOOLS: dict[str, list[str]] = {
    "triage": READ,
    "pm": READ + WRITE + GIT_READ,
    "ba": READ + WRITE + GIT_READ,
    "designer": READ + WRITE + MKDIR + SERVE + BROWSER,
    "dev": READ
    + WRITE
    + ["NotebookEdit"]
    + MKDIR
    + GIT_READ
    + GIT_COMMIT
    + INSTALL
    + TESTS,
    "reviewer": READ + GIT_READ + ["Bash(npm ci:*)", "Bash(uv sync:*)"] + TESTS,
    "qa": READ + ["Write"] + MKDIR + GIT_READ + INSTALL + TESTS + START_APP + BROWSER,
    "user_tester": READ + ["Write"] + MKDIR + INSTALL[:3] + START_APP + SERVE + BROWSER,
    # the four roles of issue #273
    "tech_writer": READ
    + WRITE
    + MKDIR
    + GIT_READ
    + GIT_COMMIT
    + INSTALL
    + TESTS
    + START_APP,
    "devops": READ + WRITE + MKDIR + GIT_READ + GIT_COMMIT + INSTALL + TESTS,
    "security": READ
    + ["Write"]
    + GIT_READ
    + TESTS
    + ["Bash(npm audit:*)", "Bash(pip-audit:*)"],
    "data_analyst": READ
    + WRITE
    + MKDIR
    + ["Bash(python3:*)", "Bash(python:*)", "Bash(uv run:*)"],
}
# What each role's defaults are, in words (Settings › AI › Safety, the permissions guide)
ROLE_WORDS: dict[str, str] = {
    "triage": "reads the code",
    "pm": "reads the code and git history, writes the files of a plan's diagram",
    "ba": "reads the code, writes the files of a diagram or a sketch",
    "designer": "writes its frames, serves them on a local port and looks at them in the browser",
    "dev": "edits files, installs packages, runs the tests, lint and build, commits on its branch",
    "reviewer": "reads the diff and runs the tests",
    "qa": "installs, runs the tests, starts the app, drives the browser, saves evidence",
    "user_tester": "installs, starts the app and drives the browser, saves screenshots",
    "tech_writer": "edits docs, runs the commands it documents, commits on its branch",
    "devops": "edits CI and build config, installs, runs the build and tests, commits on its branch",
    "security": "reads the diff, writes and runs proof tests it does not commit, audits dependencies",
    "data_analyst": "writes and runs analysis scripts with the machine's Python",
}
# Never added by a role, a preset or a remembered answer: these stay with a person every time
NEVER = re.compile(
    r"^Bash\((git push|git reset --hard|git clean|sudo|rm -rf|rm -fr|chmod -R|chown|curl .*\|\s*(sh|bash))",
    re.I,
)

# ---------------------------------------------------------------------------
# Web search and presets
# ---------------------------------------------------------------------------

WEB_SEARCH = ("off", "roles", "on")
# The roles that look things up as part of their job: references, a library's docs, an error message
WEB_SEARCH_ROLES = ("pm", "ba", "designer", "dev", "devops", "security")
BYPASS = ("never", "member", "always")

PRESETS: dict[str, dict] = {
    "careful": {
        "label": "Careful",
        "line": "Each AI runs only its role's tools and its own allow list, never in Bypass; no web search; Docs edits "
        "wait for you. Anything else is asked once.",
        "values": {"bypass": "never", "web_search": "off", "docs_ask": True},
    },
    "normal": {
        "label": "Normal",
        "line": "Each role gets what its job needs, the ready-made roles run in Bypass, the roles that look things up "
        "may search the web. Anything else is asked once and remembered.",
        "values": {"bypass": "member", "web_search": "roles", "docs_ask": False},
    },
    "trusted": {
        "label": "Trusted",
        "line": "Every work run of a local CLI runs in Bypass with the web open. The board still holds the status "
        "ceiling, deletes, approvals and safe mode.",
        "values": {"bypass": "always", "web_search": "on", "docs_ask": False},
    },
}
DEFAULT_PRESET = "normal"


def settings_of(settings: AiProjectSettings | None) -> dict:
    """The project's permission switches over their defaults: {preset, bypass, web_search, ask_cli}."""
    raw = ops.get(settings).get("permissions") or {}
    out = {**ops.DEFAULTS["permissions"], **(raw if isinstance(raw, dict) else {})}
    if out.get("preset") not in (*PRESETS, "custom"):
        out["preset"] = DEFAULT_PRESET
    if out.get("bypass") not in BYPASS:
        out["bypass"] = "member"
    if out.get("web_search") not in WEB_SEARCH:
        out["web_search"] = "roles"
    out["ask_cli"] = bool(out.get("ask_cli", True))
    return out


def preset_matching(values: dict, docs_ask: bool) -> str:
    """The preset these switches are, or "custom"."""
    for key, p in PRESETS.items():
        want = p["values"]
        if (
            values.get("bypass") == want["bypass"]
            and values.get("web_search") == want["web_search"]
            and bool(docs_ask) == want["docs_ask"]
        ):
            return key
    return "custom"


def web_search_for(role: str | None, mode: str) -> bool:
    """Whether a run of this role may use WebSearch."""
    if mode == "on":
        return True
    if mode == "roles":
        return (role or "") in WEB_SEARCH_ROLES
    return False


def role_tools(role: str | None) -> list[str]:
    """The allow rules the role needs for its job (empty for a member without a role)."""
    return list(ROLE_TOOLS.get(role or "", []))


def bypass_for(policy: str, member_bypass: bool, provider: str) -> bool:
    """Whether a work run skips the CLI's permission checks: the member's own choice, never, or always (Trusted) for
    the CLIs that can. Safe mode and question runs are checked by the caller."""
    from .config_model import BYPASS_PROVIDERS

    if policy == "never":
        return False
    if policy == "always":
        return provider in BYPASS_PROVIDERS
    return member_bypass


# ---------------------------------------------------------------------------
# A refused tool call → the rule that allows it
# ---------------------------------------------------------------------------

# Commands whose second word is what they do (npm install, git commit, uv run): the rule keeps both words
_TWO_WORD = {
    "npm",
    "pnpm",
    "yarn",
    "npx",
    "git",
    "uv",
    "uvx",
    "pip",
    "pip3",
    "poetry",
    "go",
    "cargo",
    "make",
    "docker",
    "python",
    "python3",
    "node",
    "bun",
    "deno",
    "gh",
    "dotnet",
}


def _command_rule(command: str) -> str | None:
    command = (command or "").strip()
    if not command:
        return None
    # the first command of a chain: what the AI was trying to do
    first = re.split(r"\s*(?:&&|\|\||;|\|)\s*", command, maxsplit=1)[0]
    try:
        words = shlex.split(first, posix=True)
    except ValueError:
        words = first.split()
    # skip `cd x &&` and leading VAR=value assignments
    words = [w for w in words if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w)]
    if not words:
        return None
    head = words[0].rsplit("/", 1)[-1]
    if head in ("python", "python3") and len(words) > 2 and words[1] == "-m":
        return f"Bash({head} -m {words[2]}:*)"
    if head in _TWO_WORD and len(words) > 1 and not words[1].startswith("-"):
        sub = words[1]
        if head in ("npm", "pnpm", "yarn") and sub == "run" and len(words) > 2:
            return f"Bash({head} run {words[2]}:*)"
        return f"Bash({head} {sub}:*)"
    return f"Bash({head}:*)"


def rule_for(tool: str, tool_input: dict | None) -> str | None:
    """The narrowest allow rule that covers a refused call: `Bash(npm install:*)` for `npm install left-pad`,
    `WebFetch(domain:docs.python.org)` for a page there, the tool's name for the rest. None when there is nothing to
    allow (an unknown shape)."""
    tool = (tool or "").strip()
    data = tool_input if isinstance(tool_input, dict) else {}
    if not tool:
        return None
    if tool == "Bash":
        return _command_rule(str(data.get("command") or ""))
    if tool == "WebFetch":
        host = urlparse(str(data.get("url") or "")).hostname
        return f"WebFetch(domain:{host})" if host else "WebFetch"
    return tool


def never_remembered(rule: str) -> bool:
    """A rule a person must allow every time (push, sudo, a forced delete): offered once, never kept."""
    return bool(NEVER.match(rule or ""))


def risk_of_rule(rule: str) -> str:
    """How risky allowing a tool is: high for what is never remembered, medium for a shell command or the web, low
    for the rest (reading, editing files in the working folder, an MCP tool)."""
    if never_remembered(rule):
        return "high"
    if rule.startswith(("Bash", "WebFetch", "WebSearch")):
        return "medium"
    return "low"


def describe_call(tool: str, tool_input: dict | None) -> str:
    """A refused call in a line, for the request a person answers."""
    data = tool_input if isinstance(tool_input, dict) else {}
    if tool == "Bash":
        return f"run `{str(data.get('command') or '')[:160]}`"
    if tool == "WebFetch":
        return f"open {str(data.get('url') or '')[:160]}"
    if tool == "WebSearch":
        return f"search the web for “{str(data.get('query') or '')[:120]}”"
    if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return f"{tool.lower()} {str(data.get('file_path') or data.get('notebook_path') or '')[:160]}"
    return f"use {tool}"
