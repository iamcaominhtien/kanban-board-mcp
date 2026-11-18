"""Facts the guide states that come from the code.

A chapter writes ``{fact:name}`` and the build puts in the value read from the code, so the text cannot drift
from the app. Every fact names its source file; ``python3 build.py --facts`` prints them all and fails when one
cannot be read (the code changed shape). Documented environment variables are checked the same way: a variable
the guide describes must still appear in the code.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def _grab(rel: str, pattern: str, group: int = 1) -> str:
    m = re.search(pattern, _read(rel), re.S)
    if not m:
        raise LookupError(f"{rel}: pattern not found: {pattern}")
    return m.group(group)


def _version() -> str:
    """The workspace version of the server (every crate and program takes it)."""
    return _grab("server/Cargo.toml", r'\[workspace\.package\][^\[]*?\nversion\s*=\s*"([^"]+)"')


def _tools(rel: str) -> list[str]:
    return [t["name"] for t in json.loads(_read(rel))["tools"]]


def _tool_names() -> list[str]:
    """The MCP tools every client sees, in the order `tools/list` gives them."""
    return _tools("server/contract/mcp-tools.json")


def _idea_tool_names() -> list[str]:
    """The Idea Space tools, listed only with KANBAN_MCP_IDEA_TOOLS=1."""
    core = set(_tool_names())
    return [t for t in _tools("server/contract/mcp-tools-ideas.json") if t not in core]


def _enum(name: str) -> list[str]:
    """The values of one of the ticket enums the MCP tools accept (`STATUSES`, `TICKET_TYPES`, `PRIORITIES`)."""
    block = _grab("server/crates/kb-mcp/src/common.rs", rf"pub const {name}: \[&str; \d+\] = \[(.*?)\];")
    return re.findall(r'"([^"]+)"', block)


def _settings_pages() -> list[str]:
    return re.findall(r"label: '([^']+)'", _read("ui/src/components/settings/settingsIndex.ts"))[:11]


# name -> (value, source file). Values are read when the module loads, so a moved or renamed thing fails the build.
FACTS: dict[str, tuple[object, str]] = {
    "version": (_version(), "server/Cargo.toml"),
    "tool_count": (len(_tool_names()), "server/contract/mcp-tools.json"),
    "tool_names": (_tool_names(), "server/contract/mcp-tools.json"),
    "idea_tool_count": (len(_idea_tool_names()), "server/contract/mcp-tools-ideas.json"),
    "ai_parallel": (
        _grab("server/crates/kb-ai-run/src/teams/edit.rs", r'truthy\(data, "max_parallel"\) \{.*?None => (\d+)'),
        "server/crates/kb-ai-run/src/teams/edit.rs",
    ),
    "ticket_statuses": (_enum("STATUSES"), "server/crates/kb-mcp/src/common.rs (STATUSES)"),
    "ticket_types": (_enum("TICKET_TYPES"), "server/crates/kb-mcp/src/common.rs (TICKET_TYPES)"),
    "ticket_priorities": (_enum("PRIORITIES"), "server/crates/kb-mcp/src/common.rs (PRIORITIES)"),
    "settings_pages": (_settings_pages(), "ui/src/components/settings/settingsIndex.ts"),
}

# Environment variables the guide describes: each must still appear in the code.
ENV_VARS: dict[str, str] = {
    "KANBAN_DB_PATH": "Where the database file is.",
    "KANBAN_UPLOADS_DIR": "Where attachments, workspace folders and sketches are stored.",
    "KANBAN_LOG_DIR": "Where the log files are written.",
    "KANBAN_AI_ROOTS": "The folders an AI member may be given as its working folder.",
    "KANBAN_MCP_IDEA_TOOLS": "Set to 1 to show the Idea Space tools to MCP agents.",
    "KANBAN_MIN_UI_VERSION": "Forces the update-required screen in a UI older than this version.",
    "KANBAN_SECRET_STORE": "Where AI API keys are kept (the desktop app uses the system keychain).",
    "KANBAN_AI_KEY_FILE": "A file holding the key that encrypts AI API keys, when no keychain is used.",
    "KANBAN_CHROME_PATH": "A Chrome, Chromium or Edge to draw diagram previews with.",
    "KANBAN_DIAGRAM_EXPORT": "off switches diagram preview drawing off; public allows diagrams.net.",
    "KANBAN_BOARD_URL": "The address the board is reached at, used in links an AI run writes.",
}


def fact(name: str) -> str:
    if name not in FACTS:
        raise KeyError(f"unknown fact {name!r}; add it to facts.py")
    value = FACTS[name][0]
    return ", ".join(value) if isinstance(value, list) else str(value)


def check_env_vars() -> list[str]:
    """Documented variables that no longer appear in the server or desktop code."""
    code = ""
    for folder in ("server", "desktop"):
        for path in (ROOT / folder).rglob("*"):
            if path.suffix in {".rs", ".js"} and not {"target", "node_modules", "tests"} & set(path.parts):
                code += path.read_text(encoding="utf-8", errors="ignore")
    return [v for v in ENV_VARS if v not in code]


def report() -> str:
    lines = ["Facts read from the code:"]
    for name, (value, source) in FACTS.items():
        shown = ", ".join(value) if isinstance(value, list) else value
        lines.append(f"  {name:<20} {shown!s:<60.60} {source}")
    missing = check_env_vars()
    lines.append("Documented environment variables: " + ("all found" if not missing else "MISSING " + ", ".join(missing)))
    return "\n".join(lines)


if __name__ == "__main__":
    print(report())
    raise SystemExit(1 if check_env_vars() else 0)
