"""The adapters an AI member can use, what each one needs, and the sample price table.

Local runners launch the official CLI the person already signed in to; the board never reads or stores its login.
API-key members run the agent loop on the board itself.
"""

PROVIDERS: dict[str, dict] = {
    "claude-code": {
        "label": "Claude Code",
        "connection": "local",
        "binary": "claude",
        "models": ["sonnet", "haiku"],
        "default_model": "sonnet",
        "install": "npm install -g @anthropic-ai/claude-code",
        "npm_package": "@anthropic-ai/claude-code",
        "guide_url": "https://docs.claude.com/en/docs/claude-code/setup",
    },
    "codex": {
        "label": "Codex",
        "connection": "local",
        "binary": "codex",
        "models": [],
        "default_model": None,
        "install": "npm install -g @openai/codex",
        "npm_package": "@openai/codex",
        "guide_url": "https://developers.openai.com/codex/cli",
    },
    "opencode": {
        "label": "opencode",
        "connection": "local",
        "binary": "opencode",
        "models": [],
        "default_model": None,
        "install": "npm install -g opencode-ai",
        "npm_package": "opencode-ai",
        "guide_url": "https://opencode.ai/docs",
    },
    "antigravity": {
        "label": "Antigravity",
        "connection": "local",
        "binary": "agy",
        "models": [],
        "default_model": None,
        "install": "Install the Antigravity command line tool (agy)",
        "install_steps": [
            "Install Antigravity from its website.",
            "Open it once and sign in with your account, or add an AI account for it and sign in there.",
            "Enable its command line tool so that “agy” works in a terminal.",
        ],
        "guide_url": "https://antigravity.google",
    },
    "anthropic": {
        "label": "Anthropic",
        "connection": "api_key",
        "base_url": "https://api.anthropic.com",
        "models": ["claude-sonnet-5-5", "claude-haiku-5-5"],
        "default_model": "claude-sonnet-5-5",
    },
    "openai": {
        "label": "OpenAI",
        "connection": "api_key",
        "base_url": "https://api.openai.com/v1",
        "models": ["gpt-4.1", "gpt-4.1-mini"],
        "default_model": "gpt-4.1-mini",
    },
    "gemini": {
        "label": "Gemini",
        "connection": "api_key",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "models": ["gemini-2.5-pro", "gemini-2.5-flash"],
        "default_model": "gemini-2.5-flash",
    },
    "custom": {
        "label": "Custom",
        "connection": "api_key",
        "base_url": None,
        "models": [],
        "default_model": None,
    },
    "mcp-client": {
        "label": "Other MCP client",
        "connection": "inbox",
        "models": [],
        "default_model": None,
    },
}

# What an AI member's avatar shows when nobody picked: a glyph and a colour per provider (neutral drawings)
DEFAULT_LOOK: dict[str, tuple[str, str]] = {
    "claude-code": ("asterisk", "#2E6F40"),
    "anthropic": ("asterisk", "#B4791E"),
    "antigravity": ("peak", "#2F6FB0"),
    "codex": ("hex", "#244E78"),
    "opencode": ("braces", "#5B3AA6"),
    "openai": ("hex", "#6D5DD3"),
    "gemini": ("spark", "#B0446E"),
    "custom": ("braces", "#5B6B60"),
    "mcp-client": ("plug", "#5B6B60"),
}

# USD per million tokens (input, output). Sample prices for the cost estimate; the provider invoice is the truth.
PRICES: dict[str, tuple[float, float]] = {
    "claude-sonnet": (3.0, 15.0),
    "claude-haiku": (1.0, 5.0),
    "claude-opus": (5.0, 25.0),
    "gpt-4.1-mini": (0.4, 1.6),
    "gpt-4.1": (2.0, 8.0),
    "gemini-2.5-flash": (0.3, 2.5),
    "gemini-2.5-pro": (1.25, 10.0),
}
DEFAULT_PRICE = (3.0, 15.0)
PRICES_UPDATED = "2026-10-01"

# Context window in tokens (longest matching prefix, like PRICES): when an API agent's chat fills a share of it
# (`compact_at_pct`) the board summarises the oldest tool turns
CONTEXT_WINDOWS: dict[str, int] = {
    "claude": 200_000,
    "gpt-4.1": 1_000_000,
    "gemini": 1_000_000,
}
DEFAULT_WINDOW = 128_000

# The nine option groups of the Configuration tab and how each adapter handles them (design/screens/ai-provider-config.md,
# A2): "synced" = the board stores it and writes it (for the API agent: uses it directly), "documented" = the board
# only shows steps, "not_supported" = hidden for this adapter.
GROUPS: list[tuple[str, str]] = [
    ("instructions", "Instructions"),
    ("skills", "Skills"),
    ("tools", "Tools"),
    ("mcp_servers", "MCP servers"),
    ("subagents", "Subagents"),
    ("hooks", "Hooks"),
    ("permissions", "Permissions"),
    ("model", "Model"),
    ("limits", "Limits"),
]

# adapter -> group -> (mode, short note)
MATRIX: dict[str, dict[str, tuple[str, str]]] = {
    "claude-code": {
        "instructions": ("synced", "CLAUDE.md, project + user"),
        "skills": ("synced", "SKILL.md folders"),
        "tools": ("not_supported", "Use MCP servers"),
        "mcp_servers": ("synced", ".mcp.json, incl. Kanban"),
        "subagents": ("synced", ".claude/agents"),
        "hooks": ("synced", "Runs shell on your machine"),
        "permissions": ("synced", "Allow / deny tool rules"),
        "model": ("synced", "Model + effort, flags"),
        "limits": ("synced", "Max turns, run timeout"),
    },
    "antigravity": {
        "instructions": ("documented", "Rules, pasted by hand"),
        "skills": ("documented", "Workflows, set up by hand"),
        "tools": ("not_supported", ""),
        "mcp_servers": ("documented", "Experimental file sync"),
        "subagents": ("not_supported", ""),
        "hooks": ("not_supported", ""),
        "permissions": ("documented", "Set in its own settings"),
        "model": ("documented", "Picked in the app"),
        "limits": ("synced", "Run timeout only"),
    },
    "api": {
        "instructions": ("synced", "System prompt, used directly"),
        "skills": ("not_supported", "Use prompt snippets"),
        "tools": ("synced", "Board tools + custom HTTP"),
        "mcp_servers": ("synced", "Remote HTTP only"),
        "subagents": ("not_supported", ""),
        "hooks": ("not_supported", ""),
        "permissions": ("synced", "Tool toggles by group"),
        "model": ("synced", "Model, temperature"),
        "limits": ("synced", "Steps, tokens, retry"),
    },
    "mcp-client": {
        g: ("not_supported", "Is the endpoint itself" if g == "mcp_servers" else "")
        for g, _ in GROUPS
    },
}
# Codex and opencode members: the board writes nothing into their folders; the run is configured on the command line
MATRIX["codex"] = MATRIX["opencode"] = {g: ("not_supported", "") for g, _ in GROUPS}

ADAPTER_COLUMNS = [
    ("claude-code", "Claude Code", "local runner"),
    ("antigravity", "Antigravity", "local runner"),
    ("api", "API agent", "API key"),
    ("mcp-client", "Other MCP client", "inbox only"),
]


def adapter_of(provider: str) -> str:
    """Column of the capability matrix a provider belongs to."""
    if provider in ("anthropic", "openai", "gemini", "custom"):
        return "api"
    return provider if provider in MATRIX else "mcp-client"


def capabilities(provider: str) -> dict[str, str]:
    """All nine option groups with the mode the member's adapter gives each (synced | documented | not_supported)."""
    return {g: MATRIX[adapter_of(provider)][g][0] for g, _ in GROUPS}


def capability_matrix() -> dict:
    """The A2 matrix for the UI: groups as rows, adapters as columns."""
    return {
        "groups": [{"key": k, "label": lbl} for k, lbl in GROUPS],
        "adapters": [
            {
                "key": key,
                "label": label,
                "sub": sub,
                "cells": {
                    g: {"mode": MATRIX[key][g][0], "note": MATRIX[key][g][1]}
                    for g, _ in GROUPS
                },
            }
            for key, label, sub in ADAPTER_COLUMNS
        ],
    }


def price_for(model: str | None) -> tuple[float, float]:
    """Sample price of a model (longest matching prefix)."""
    name = (model or "").lower()
    best = None
    for key in PRICES:
        if name.startswith(key) or key in name:
            if best is None or len(key) > len(best):
                best = key
    return PRICES[best] if best else DEFAULT_PRICE


def context_window(model: str | None) -> int:
    """Context window of a model in tokens (a conservative default for an unknown one)."""
    name = (model or "").lower()
    best = None
    for key in CONTEXT_WINDOWS:
        if name.startswith(key) or key in name:
            if best is None or len(key) > len(best):
                best = key
    return CONTEXT_WINDOWS[best] if best else DEFAULT_WINDOW


def cheap_model(provider: str, model: str | None) -> str | None:
    """The cheapest model the provider lists when it is cheaper than `model` (for small helper calls such as
    summarising a long session), else `model` itself."""
    listed = PROVIDERS.get(provider, {}).get("models") or []
    if not listed:
        return model
    best = min(listed, key=lambda m: sum(price_for(m)))
    return best if sum(price_for(best)) < sum(price_for(model)) else model


def cost_of(model: str | None, tokens_in: int, tokens_out: int) -> float:
    """Estimated USD cost of a call."""
    pin, pout = price_for(model)
    return round(tokens_in / 1_000_000 * pin + tokens_out / 1_000_000 * pout, 6)


DEFAULT_CONFIG: dict = {
    # Instructions: written to the run's system prompt; for Claude Code also appended with --append-system-prompt
    "instructions": "",
    # Extra MCP servers (Claude Code: stdio or http; API agents: none), the board's own server is always added
    "mcp_servers": [],
    # Claude Code tool rules (B6). Flags that skip permission checks are never passed.
    "allow_rules": [
        "Read",
        "Glob",
        "Grep",
        "Edit",
        "Write",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git log:*)",
        "Bash(python -m pytest:*)",
        "Bash(python3 -m pytest:*)",
        "Bash(pytest:*)",
        "Bash(npm test:*)",
        "Bash(npm run test:*)",
        "Bash(npm run lint:*)",
    ],
    "deny_rules": ["Bash(rm -rf:*)", "Bash(git push --force:*)", "Read(./.env)"],
    "effort": None,
    # Extra command-line flags for the CLI (flags that skip permission checks are rejected)
    "extra_flags": [],
    "max_turns": 40,
    "run_timeout_min": 30,
    "idle_timeout_min": 10,
    # What the CLI may do without asking: "allowlist" (only the Allow rules, the default) or "bypass" (every tool
    # except what the Deny rules and the board's own checks stop; owner-only, typed confirmation)
    "permission_mode": "allowlist",
    # Claude Code compacts a long session by itself once it fills this share of its context window
    "compact_at_pct": 60,
    # API agents (D5–D7)
    "max_steps": 12,
    "max_tokens_per_run": 60000,
    "temperature": 0.2,
    "retries": 3,
    # Exponential backoff between retries: base seconds × factor per attempt, capped (design D6)
    "retry_base_s": 2.0,
    "retry_factor": 2.0,
    "retry_max_s": 30.0,
    # At the budget cap: "pause" (new runs wait, the running one finishes) | "stop" (end it now)
    "at_cap": "pause",
    "context": {
        "comments": True,
        "criteria": True,
        "sub_tickets": False,
        "linked_docs": False,
        "comment_limit": 20,
        "doc_limit": 3,
        "doc_tokens": 4000,
    },
    "tool_groups": {
        "read": True,
        "update": True,
        "comment": True,
        "create": False,
        "test_cases": True,
        "docs_read": True,
        "docs_write": False,
    },
    # User-scope CLAUDE.md text: always Documented, the board never writes into the home folder (B1)
    "user_instructions": "",
    # Library snippets attached to the instructions: [{library_id, name, version, content}]
    "snippets": [],
    # Skills: [{id, name, description, content, files[{path, content}], enabled, mode, library}]
    "skills": [],
    # Claude Code subagents: [{id, name, description, content, enabled, library}]
    "subagents": [],
    # Claude Code hooks: [{id, event, matcher, command, enabled}]
    "hooks": [],
    # API agent: custom HTTP tools [{id, name, spec, headers[{name, value, secret}], enabled, library}]
    "custom_tools": [],
    # API agent: remote MCP servers [{id, name, url, headers[...], enabled, library}]
    "remote_mcp": [],
    # API agent: what the board does with the result (D7)
    "output": {
        "include_usage": True,
        "move_back_on_failure": False,
        "comment_format": "short",
    },
    # Antigravity: experimental file sync of the MCP server list (C4, placeholder paths: TODO verify)
    "antigravity": {"sync_mcp": False, "mcp_target": ".agents/mcp_config.json"},
    # Antigravity permissions are documented: free text the person follows in the app
    "permission_notes": "",
}


def kv_pairs(value) -> list[dict]:
    """Env vars / headers as [{name, value}]: the UI converts object keys between snake and camel case, so
    names such as GITHUB_TOKEN are never used as JSON keys."""
    if isinstance(value, dict):
        return [{"name": str(k), "value": str(v)} for k, v in value.items()]
    out = []
    for item in value or []:
        if isinstance(item, dict) and str(item.get("name") or "").strip():
            out.append(
                {
                    "name": str(item["name"]).strip(),
                    "value": str(item.get("value") or ""),
                }
            )
    return out


def kv_dict(value) -> dict:
    """[{name, value}] (or a dict) as a plain dict, for the CLI's MCP config."""
    return {p["name"]: p["value"] for p in kv_pairs(value)}


def merged_config(raw: dict | None) -> dict:
    """A member's configuration with defaults filled in."""
    out = {**DEFAULT_CONFIG, **(raw or {})}
    out["context"] = {**DEFAULT_CONFIG["context"], **((raw or {}).get("context") or {})}
    out["tool_groups"] = {
        **DEFAULT_CONFIG["tool_groups"],
        **((raw or {}).get("tool_groups") or {}),
    }
    for key in ("output", "antigravity"):
        out[key] = {**DEFAULT_CONFIG[key], **((raw or {}).get(key) or {})}
    out["mcp_servers"] = [
        {
            **srv,
            **{k: kv_pairs(srv.get(k)) for k in ("env", "headers") if k in srv},
        }
        for srv in out.get("mcp_servers") or []
        if isinstance(srv, dict)
    ]
    from .config_model import normalize_lists

    return normalize_lists(out)
