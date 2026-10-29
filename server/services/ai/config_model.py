"""The shape of an AI member's configuration: normalising, validating, masking secrets, prompt variables.

Everything the Configuration tab edits lives in ``AiMember.config`` (JSON). Lists of items (skills, subagents, hooks,
custom tools, remote MCP servers) are lists of objects with an ``id``; free text such as a SKILL.md, a tool schema or a
prompt is kept as a *string*, because the UI converts JSON object keys between snake and camel case and must never see
a user's own keys (design/screens/ai-provider-config.md).
"""

import hashlib
import json
import re
import uuid
from difflib import get_close_matches

import yaml

from . import secrets
from .cli import REJECTED_FLAGS

EFFORTS = ("low", "medium", "high", "xhigh", "max")
HOOK_EVENTS = (
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SubagentStop",
    "PreCompact",
    "SessionStart",
    "SessionEnd",
)
COMMENT_FORMATS = ("short", "detailed", "plain")
PROMPT_VARIABLES = ("ticket", "project", "docs", "comments")
PROMPT_TOKEN_BUDGET = 8000
SCHEMA_TYPES = ("string", "number", "integer", "boolean", "array", "object")
HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
RESPONSE_CAP = 20 * 1024
SKILL_FOLDER_LIMIT = 2 * 1024 * 1024
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
SERVER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
TOOL_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
HEADER_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
# Names the board's own tools use: a custom tool must not shadow them
RESERVED_TOOLS = {
    "get_ticket",
    "list_tickets",
    "search_tickets",
    "add_comment",
    "update_ticket",
    "create_ticket",
    "set_test_case",
    "ask_person",
    "report",
    "list_docs",
    "read_doc",
    "create_doc",
    "update_doc",
}
RESERVED_SERVERS = {"kanban", "kanban-board"}
VAR_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
INCLUDE_RE = re.compile(r"<!--\s*kanban:include\s+([A-Za-z0-9_-]+)@v(\d+)\s*-->")
MASK = "••••"


def new_id() -> str:
    """A short id for a config item."""
    return uuid.uuid4().hex[:12]


def stable_id(kind: str, *parts: str) -> str:
    """An id derived from the item itself, for items saved before they had one (it stays the same between reads)."""
    return hashlib.sha1(("|".join((kind, *parts))).encode()).hexdigest()[:12]


def estimate_tokens(text: str | None) -> int:
    """Rough token count (4 characters per token); the provider's own count is the truth."""
    return (len(text or "") + 3) // 4


def sha(text: str) -> str:
    """Short content hash."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Front matter (SKILL.md, agents/*.md)
# ---------------------------------------------------------------------------


def split_frontmatter(text: str) -> tuple[dict, str]:
    """(front matter as a dict, the body) of a Markdown file; ({}, text) when there is none or it is not YAML."""
    # Line by line, not one regex: a lazy multi-line match backtracks badly on long input without a closing ---
    text = text or ""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return {}, text
    try:
        data = yaml.safe_load("\n".join(lines[1:end])) or {}
    except yaml.YAMLError:
        return {}, text
    return (data if isinstance(data, dict) else {}), "\n".join(lines[end + 1 :])


def skill_template(name: str, description: str = "") -> str:
    """A starter SKILL.md."""
    return f"---\nname: {name}\ndescription: {description or 'What this skill does and when to use it.'}\n---\n1. \n"


# ---------------------------------------------------------------------------
# Normalising
# ---------------------------------------------------------------------------


def _s(v) -> str:
    return v if isinstance(v, str) else ("" if v is None else str(v))


def _headers(value) -> list[dict]:
    """[{name, value, secret, enc, last4}]: secret values are only ever kept encrypted."""
    out = []
    items = (
        [{"name": k, "value": v} for k, v in value.items()]
        if isinstance(value, dict)
        else value or []
    )
    for h in items:
        if not isinstance(h, dict) or not _s(h.get("name")).strip():
            continue
        row = {
            "name": _s(h["name"]).strip(),
            "value": _s(h.get("value")),
            "secret": bool(h.get("secret")),
        }
        if h.get("enc"):
            row["enc"] = _s(h["enc"])
            row["last4"] = _s(h.get("last4"))
        out.append(row)
    return out


def _kv(value) -> list[dict]:
    from .providers import kv_pairs

    return kv_pairs(value)


def _lib(value) -> dict | None:
    if isinstance(value, dict) and value.get("id"):
        return {"id": _s(value["id"]), "version": int(value.get("version") or 1)}
    return None


def normalize_skill(raw: dict) -> dict:
    """A skill item with derived name/description (from the SKILL.md front matter when present)."""
    content = _s(raw.get("content"))
    fm, _ = split_frontmatter(content)
    name = _s(fm.get("name") or raw.get("name")).strip()
    return {
        "id": _s(raw.get("id")) or stable_id("skill", name),
        "name": name,
        "description": _s(fm.get("description") or raw.get("description")).strip(),
        "content": content,
        "files": [
            {"path": _s(f.get("path")).strip(), "content": _s(f.get("content"))}
            for f in raw.get("files") or []
            if isinstance(f, dict) and _s(f.get("path")).strip()
        ],
        "enabled": raw.get("enabled", True) is not False,
        "mode": "documented" if raw.get("mode") == "documented" else "synced",
        "library": _lib(raw.get("library")),
    }


def normalize_subagent(raw: dict) -> dict:
    """A subagent item with the model and tools read from its front matter."""
    content = _s(raw.get("content"))
    fm, _ = split_frontmatter(content)
    tools = fm.get("tools")
    if isinstance(tools, list):
        tools = ", ".join(str(t) for t in tools)
    name = _s(fm.get("name") or raw.get("name")).strip()
    return {
        "id": _s(raw.get("id")) or stable_id("agent", name),
        "name": name,
        "description": _s(fm.get("description") or raw.get("description")).strip(),
        "content": content,
        "model": _s(fm.get("model")),
        "tools": _s(tools),
        "enabled": raw.get("enabled", True) is not False,
        "library": _lib(raw.get("library")),
    }


def normalize_hook(raw: dict) -> dict:
    """A hook item."""
    event, matcher, command = (
        _s(raw.get(k)).strip() for k in ("event", "matcher", "command")
    )
    return {
        "id": _s(raw.get("id")) or stable_id("hook", event, matcher, command),
        "event": event,
        "matcher": matcher,
        "command": command,
        "enabled": raw.get("enabled", True) is not False,
    }


def normalize_server(raw: dict) -> dict:
    """A Claude Code / Antigravity MCP server item."""
    out = {
        **raw,
        "id": _s(raw.get("id")) or stable_id("server", _s(raw.get("name")).strip()),
        "name": _s(raw.get("name")).strip(),
        "type": raw.get("type") if raw.get("type") in ("stdio", "http") else "stdio",
        "enabled": raw.get("enabled", True) is not False,
        "mode": "documented" if raw.get("mode") == "documented" else "synced",
        "description": _s(raw.get("description")),
        "library": _lib(raw.get("library")),
        "env": _kv(raw.get("env")),
        "headers": _kv(raw.get("headers")),
    }
    out["args"] = [_s(a) for a in raw.get("args") or []]
    out["command"] = _s(raw.get("command"))
    out["url"] = _s(raw.get("url"))
    return out


def normalize_tool(raw: dict) -> dict:
    """A custom HTTP tool: the name, description and schema are read from the spec text."""
    spec = _s(raw.get("spec"))
    data = parse_json(spec)[0]
    name = _s((data or {}).get("name") or raw.get("name")).strip()
    return {
        "id": _s(raw.get("id")) or stable_id("tool", name),
        "name": name,
        "spec": spec,
        "headers": _headers(raw.get("headers")),
        "enabled": raw.get("enabled", True) is not False,
        "library": _lib(raw.get("library")),
    }


def normalize_remote(raw: dict) -> dict:
    """A remote MCP server of an API agent."""
    name = _s(raw.get("name")).strip()
    return {
        "id": _s(raw.get("id")) or stable_id("remote", name),
        "name": name,
        "url": _s(raw.get("url")).strip(),
        "headers": _headers(raw.get("headers")),
        "enabled": raw.get("enabled", True) is not False,
        "library": _lib(raw.get("library")),
    }


def normalize_lists(cfg: dict) -> dict:
    """Give every item list a clean, independent shape (also fills ids)."""

    def items(key, fn):
        return [fn(x) for x in cfg.get(key) or [] if isinstance(x, dict)]

    cfg["mcp_servers"] = items("mcp_servers", normalize_server)
    cfg["skills"] = items("skills", normalize_skill)
    cfg["subagents"] = items("subagents", normalize_subagent)
    cfg["hooks"] = items("hooks", normalize_hook)
    cfg["custom_tools"] = items("custom_tools", normalize_tool)
    cfg["remote_mcp"] = items("remote_mcp", normalize_remote)
    cfg["snippets"] = [
        {
            "library_id": _s(x.get("library_id")),
            "name": _s(x.get("name")),
            "version": int(x.get("version") or 1),
            "content": _s(x.get("content")),
        }
        for x in cfg.get("snippets") or []
        if isinstance(x, dict) and x.get("library_id")
    ]
    cfg["allow_rules"] = [
        _s(r).strip() for r in cfg.get("allow_rules") or [] if _s(r).strip()
    ]
    cfg["deny_rules"] = [
        _s(r).strip() for r in cfg.get("deny_rules") or [] if _s(r).strip()
    ]
    cfg["extra_flags"] = [_s(f) for f in cfg.get("extra_flags") or [] if _s(f)]
    cfg["instructions"] = _s(cfg.get("instructions"))
    cfg["user_instructions"] = _s(cfg.get("user_instructions"))
    cfg["permission_notes"] = _s(cfg.get("permission_notes"))
    return cfg


# ---------------------------------------------------------------------------
# Secrets in headers
# ---------------------------------------------------------------------------


def public_config(cfg: dict) -> dict:
    """The configuration as the UI gets it: secret header values are replaced by a mask with the last 4 characters."""
    out = json.loads(json.dumps(cfg))
    for key in ("custom_tools", "remote_mcp"):
        for item in out.get(key) or []:
            for h in item.get("headers") or []:
                if h.get("secret"):
                    has = bool(h.pop("enc", None))
                    last = h.pop("last4", "") or ""
                    h["value"] = ""
                    h["masked"] = f"{MASK}{last}" if has else ""
                else:
                    h.pop("enc", None)
                    h.pop("last4", None)
    return out


def prepare_config(old: dict, new: dict) -> dict:
    """The configuration to store: secret header values typed in are encrypted; an empty value keeps the stored one."""
    new = json.loads(json.dumps(new))
    for key in ("custom_tools", "remote_mcp"):
        before = {
            (i.get("id"), h["name"].lower()): h
            for i in old.get(key) or []
            for h in i.get("headers") or []
        }
        for item in new.get(key) or []:
            headers = []
            for h in _headers(item.get("headers")):
                prev = before.get((item.get("id"), h["name"].lower()))
                if not h["secret"]:
                    headers.append(
                        {"name": h["name"], "value": h["value"], "secret": False}
                    )
                    continue
                if h["value"].strip():
                    value = h["value"].strip()
                    headers.append(
                        {
                            "name": h["name"],
                            "value": "",
                            "secret": True,
                            "enc": secrets.encrypt(value),
                            "last4": secrets.last4(value),
                        }
                    )
                elif prev and prev.get("enc"):
                    headers.append(
                        {
                            "name": h["name"],
                            "value": "",
                            "secret": True,
                            "enc": prev["enc"],
                            "last4": prev.get("last4", ""),
                        }
                    )
                else:
                    headers.append({"name": h["name"], "value": "", "secret": True})
            item["headers"] = headers
    return new


def header_values(headers: list[dict]) -> dict[str, str]:
    """Headers as sent on the wire (secrets decrypted; never log the result)."""
    out = {}
    for h in headers or []:
        value = secrets.decrypt(h.get("enc")) if h.get("secret") else h.get("value")
        if value:
            out[h["name"]] = value
    return out


def export_config(cfg: dict) -> dict:
    """The configuration for the JSON export: no secrets (secret headers dropped, literal env values blanked)."""
    out = public_config(cfg)
    for key in ("custom_tools", "remote_mcp"):
        for item in out.get(key) or []:
            for h in item.get("headers") or []:
                if h.get("secret"):
                    h["value"] = ""
                    h.pop("masked", None)
    for s in out.get("mcp_servers") or []:
        for k in ("env", "headers"):
            for p in s.get(k) or []:
                if not re.fullmatch(
                    r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", p.get("value", "")
                ):
                    p["value"] = ""
    return out


# ---------------------------------------------------------------------------
# Prompt variables (design D1)
# ---------------------------------------------------------------------------


def check_prompt(text: str) -> list[dict]:
    """Unknown ``{{variable}}`` names, with the line they are on."""
    problems = []
    for lineno, line in enumerate((text or "").split("\n"), 1):
        for m in VAR_RE.finditer(line):
            if m.group(1) not in PROMPT_VARIABLES:
                problems.append(
                    {
                        "path": "instructions",
                        "line": lineno,
                        "message": f"Unknown variable {{{{{m.group(1)}}}}} on line {lineno}. "
                        f"Available: {', '.join(PROMPT_VARIABLES)}.",
                    }
                )
    return problems


def used_variables(text: str) -> set[str]:
    """The known variables a prompt uses."""
    return {m.group(1) for m in VAR_RE.finditer(text or "")} & set(PROMPT_VARIABLES)


def render_prompt(text: str, values: dict[str, str]) -> str:
    """Replace the known variables (unknown ones are left as they are)."""
    return VAR_RE.sub(lambda m: values.get(m.group(1), m.group(0)), text or "")


def expand_includes(text: str, snippets: list[dict]) -> str:
    """Replace ``<!-- kanban:include name@vN -->`` by the pinned snippet (unknown ones stay as the comment)."""
    pinned = {(s["name"], s["version"]): s["content"] for s in snippets or []}

    def sub(m):
        body = pinned.get((m.group(1), int(m.group(2))))
        return m.group(0) if body is None else f"{m.group(0)}\n{body.rstrip()}"

    return INCLUDE_RE.sub(sub, text or "")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def parse_json(text: str) -> tuple[dict | None, dict | None]:
    """(object, None) or (None, {line, message}) for a JSON text."""
    try:
        data = json.loads(text)
    except ValueError as exc:
        return None, {
            "line": getattr(exc, "lineno", 1),
            "message": getattr(exc, "msg", str(exc)),
        }
    if not isinstance(data, dict):
        return None, {"line": 1, "message": "The tool file must be a JSON object."}
    return data, None


def _find_line(text: str, needle: str) -> int:
    for i, line in enumerate(text.split("\n"), 1):
        if needle and needle in line:
            return i
    return 1


def check_schema(schema, path: str, spec_text: str) -> list[dict]:
    """Problems in a JSON schema for a tool input (types, required, enum), each with a line and a hint."""
    problems: list[dict] = []
    if not isinstance(schema, dict):
        return [{"path": path, "message": "must be an object.", "line": 1}]
    typ = schema.get("type")
    if typ is not None:
        if not isinstance(typ, str) or typ not in SCHEMA_TYPES:
            hint = get_close_matches(str(typ), SCHEMA_TYPES, n=1)
            problems.append(
                {
                    "path": f"{path}.type",
                    "message": f"must be one of {', '.join(SCHEMA_TYPES)}. Got “{typ}”.",
                    "hint": hint[0] if hint else None,
                    "bad": str(typ),
                    "line": _find_line(spec_text, f'"{typ}"'),
                }
            )
    props = schema.get("properties")
    if props is not None:
        if not isinstance(props, dict):
            problems.append(
                {
                    "path": f"{path}.properties",
                    "message": "must be an object.",
                    "line": 1,
                }
            )
        else:
            for k, sub in props.items():
                problems += check_schema(sub, f"{path}.properties.{k}", spec_text)
    req = schema.get("required")
    if req is not None:
        if not isinstance(req, list) or not all(isinstance(r, str) for r in req):
            problems.append(
                {
                    "path": f"{path}.required",
                    "message": "must be a list of property names.",
                    "line": 1,
                }
            )
        elif isinstance(props, dict):
            for r in req:
                if r not in props:
                    problems.append(
                        {
                            "path": f"{path}.required",
                            "message": f"“{r}” is required but is not in properties.",
                            "line": _find_line(spec_text, f'"{r}"'),
                        }
                    )
    if "enum" in schema and (
        not isinstance(schema["enum"], list) or not schema["enum"]
    ):
        problems.append(
            {
                "path": f"{path}.enum",
                "message": "must be a non-empty list.",
                "line": _find_line(spec_text, '"enum"'),
            }
        )
    if typ == "array" and "items" in schema:
        problems += check_schema(schema["items"], f"{path}.items", spec_text)
    return problems


def check_tool_spec(spec_text: str) -> dict:
    """Validate a ``*.tool.json`` text: {ok, problems[{line, path, message, hint}], tool{name, description, schema, http}}."""
    data, err = parse_json(spec_text)
    if err:
        return {"ok": False, "problems": [{"path": "spec", **err}], "tool": None}
    problems: list[dict] = []
    name = _s(data.get("name")).strip()
    if not TOOL_RE.match(name):
        problems.append(
            {
                "path": "name",
                "line": _find_line(spec_text, '"name"'),
                "message": "Name must be letters, digits and underscores, starting with a letter (max 64).",
            }
        )
    elif name in RESERVED_TOOLS:
        problems.append(
            {
                "path": "name",
                "line": _find_line(spec_text, '"name"'),
                "message": f"“{name}” is a board tool; pick another name.",
            }
        )
    if not _s(data.get("description")).strip():
        problems.append(
            {
                "path": "description",
                "line": _find_line(spec_text, '"description"')
                if "description" in data
                else 1,
                "message": "Describe what the tool does so the model knows when to call it.",
            }
        )
    schema = data.get("input_schema")
    if not isinstance(schema, dict):
        problems.append(
            {
                "path": "input_schema",
                "line": _find_line(spec_text, '"input_schema"')
                if "input_schema" in data
                else 1,
                "message": "input_schema must be a JSON schema object.",
            }
        )
    else:
        if schema.get("type") != "object":
            problems.append(
                {
                    "path": "input_schema.type",
                    "line": _find_line(spec_text, '"type"'),
                    "message": "The input schema must have type “object”.",
                }
            )
        problems += check_schema(schema, "input_schema", spec_text)
    http = data.get("http")
    if not isinstance(http, dict):
        problems.append(
            {
                "path": "http",
                "line": 1,
                "message": 'Add an http block: {"method": "GET", "url": "https://…"}.',
            }
        )
    else:
        method = _s(http.get("method") or "GET").upper()
        if method not in HTTP_METHODS:
            problems.append(
                {
                    "path": "http.method",
                    "line": _find_line(spec_text, '"method"'),
                    "message": f"must be one of {', '.join(HTTP_METHODS)}.",
                }
            )
        url = _s(http.get("url")).strip()
        if not (
            url.startswith("https://")
            or url.startswith("http://localhost")
            or url.startswith("http://127.0.0.1")
        ):
            problems.append(
                {
                    "path": "http.url",
                    "line": _find_line(spec_text, '"url"'),
                    "message": "must be an https:// URL (http:// only for localhost).",
                }
            )
    for p in problems:
        p.setdefault("hint", None)
    return {
        "ok": not problems,
        "problems": problems,
        "tool": {
            "name": name,
            "description": _s(data.get("description")),
            "input_schema": schema
            if isinstance(schema, dict)
            else {"type": "object", "properties": {}},
            "http": http if isinstance(http, dict) else {},
        },
    }


# A permission rule is ``Tool`` or ``Tool(specifier)``; MCP rules are ``mcp__server`` or ``mcp__server__tool``
# One character class with no nested repeat (no backtracking); a * may appear only after the first ``__`` (_rule_tool_ok)
_RULE_TOOL = re.compile(r"^[A-Za-z_][A-Za-z0-9_*-]*$")


def _rule_tool_ok(tool: str) -> bool:
    return bool(_RULE_TOOL.match(tool)) and "*" not in tool.split("__", 1)[0]


def rule_problem(rule: str) -> str | None:
    """Why a CLI permission rule is malformed (None when it looks fine)."""
    r = rule.strip()
    if not r:
        return "is empty."
    if "(" not in r and ")" not in r:
        return (
            None
            if _rule_tool_ok(r)
            else "tool names are letters, digits and underscores, e.g. Read or mcp__kanban__*."
        )
    if not r.endswith(")") or r.count("(") != 1 or r.count(")") != 1:
        return "needs one pair of parentheses at the end, e.g. Bash(npm run build:*)."
    tool, _, spec = r[:-1].partition("(")
    if not _rule_tool_ok(tool):
        return f"“{tool}” is not a tool name."
    if not spec.strip():
        return "has empty parentheses; write the tool name alone to match every call."
    if ":*" in spec and not spec.endswith(":*"):
        return "“:*” only works at the end of the specifier."
    return None


def validate_config(cfg: dict, provider: str = "claude-code") -> list[dict]:
    """Every problem in a configuration: [{path, message, severity, line?, hint?}]; errors block Save."""
    from .providers import adapter_of

    adapter = adapter_of(provider)
    errs: list[dict] = []

    def err(path, message, **kw):
        errs.append(
            {
                "path": path,
                "message": message,
                "severity": kw.pop("severity", "error"),
                **kw,
            }
        )

    def rng(key, label, lo, hi, cast=int):
        try:
            v = cast(cfg.get(key))
        except (TypeError, ValueError):
            return err(key, f"{label}: enter a number.")
        if not lo <= v <= hi:
            err(key, f"{label}: {lo:g} to {hi:g}.")

    rng("max_steps", "Max steps", 1, 50)
    rng("max_turns", "Max turns per run", 1, 200)
    rng("run_timeout_min", "Run timeout", 1, 240)
    rng("idle_timeout_min", "Idle timeout", 1, 120)
    rng("compact_at_pct", "Auto-compact at", 10, 95)
    rng("max_tokens_per_run", "Max tokens per run", 1000, 2_000_000)
    rng("retries", "Retries", 0, 10)
    rng("retry_base_s", "Backoff start", 0, 60, float)
    rng("retry_factor", "Backoff factor", 1, 5, float)
    rng("retry_max_s", "Backoff maximum", 1, 600, float)
    rng("temperature", "Temperature", 0, 1, float)
    try:
        if float(cfg["retry_max_s"]) < float(cfg["retry_base_s"]):
            err("retry_max_s", "Backoff maximum must be at least the start.")
    except (TypeError, ValueError, KeyError):
        pass
    ctx = cfg.get("context") or {}
    for key, label, lo, hi in (
        ("comment_limit", "Comments", 1, 50),
        ("doc_limit", "Linked docs", 0, 10),
        ("doc_tokens", "Tokens per doc", 500, 20000),
    ):
        try:
            if not lo <= int(ctx.get(key)) <= hi:
                err(f"context.{key}", f"{label}: {lo} to {hi}.")
        except (TypeError, ValueError):
            err(f"context.{key}", f"{label}: enter a number.")

    if cfg.get("effort") not in (None, "") and cfg["effort"] not in EFFORTS:
        err("effort", f"Effort must be one of {', '.join(EFFORTS)}.")
    for flag in cfg.get("extra_flags") or []:
        if any(bad in flag for bad in REJECTED_FLAGS):
            err(
                "extra_flags", f"Flags that skip permission checks are rejected: {flag}"
            )
    if (cfg.get("output") or {}).get("comment_format") not in COMMENT_FORMATS:
        err(
            "output.comment_format",
            f"Comment format must be one of {', '.join(COMMENT_FORMATS)}.",
        )

    text = cfg.get("instructions") or ""
    if adapter == "api":
        for p in check_prompt(text):
            err(p["path"], p["message"], line=p["line"])
        full = expand_includes(text, cfg.get("snippets") or [])
        if estimate_tokens(full) > PROMPT_TOKEN_BUDGET:
            err(
                "instructions",
                f"The system prompt is over its {PROMPT_TOKEN_BUDGET:,} token budget (≈ {estimate_tokens(full):,}).",
            )
    elif len(text) > 200_000:
        err("instructions", "Instructions are too long (200,000 characters at most).")
    for s in cfg.get("snippets") or []:
        if not s.get("name"):
            err("snippets", "A snippet needs a name.")

    # Permission rules (Claude Code)
    allow, deny = cfg.get("allow_rules") or [], cfg.get("deny_rules") or []
    for key, rules in (("allow_rules", allow), ("deny_rules", deny)):
        seen: set[str] = set()
        for r in rules:
            p = rule_problem(r)
            if p:
                err(key, f"“{r}” {p}")
            if r in seen:
                err(key, f"“{r}” is listed twice.", severity="warning")
            seen.add(r)
    for r in set(allow) & set(deny):
        err(
            "deny_rules",
            f"“{r}” is both allowed and denied; deny wins.",
            severity="warning",
        )

    # Skills / subagents
    for key, label in (("skills", "skill"), ("subagents", "subagent")):
        names: set[str] = set()
        for i, it in enumerate(cfg.get(key) or []):
            path = f"{key}.{i}"
            name = it.get("name") or ""
            if not NAME_RE.match(name):
                err(
                    f"{path}.name",
                    f"A {label} name is lowercase letters, digits, - or _ (max 64).",
                )
            elif name in names:
                err(f"{path}.name", f"Two {label}s are called “{name}”.")
            names.add(name)
            fm, _ = split_frontmatter(it.get("content") or "")
            if (
                key == "skills" and it.get("mode") != "documented"
            ) or key == "subagents":
                if not fm.get("description"):
                    err(
                        f"{path}.content",
                        f"The {'SKILL.md' if key == 'skills' else 'subagent file'} needs a front matter with name and description.",
                    )
            total = len((it.get("content") or "").encode()) + sum(
                len((f.get("content") or "").encode()) for f in it.get("files") or []
            )
            if total > SKILL_FOLDER_LIMIT:
                err(f"{path}.content", "A skill folder can hold 2 MB at most.")
            for f in it.get("files") or []:
                fp = f.get("path") or ""
                if (
                    fp.startswith("/")
                    or ".." in fp.split("/")
                    or "\\" in fp
                    or fp.lower() == "skill.md"
                ):
                    err(
                        f"{path}.files",
                        f"“{fp}” is not a valid file path inside the skill folder.",
                    )

    # Hooks
    for i, h in enumerate(cfg.get("hooks") or []):
        if h["event"] not in HOOK_EVENTS:
            err(f"hooks.{i}.event", f"Event must be one of {', '.join(HOOK_EVENTS)}.")
        if not h["command"]:
            err(f"hooks.{i}.command", "A hook needs a command.")
        try:
            re.compile(h["matcher"] or ".*")
        except re.error:
            err(
                f"hooks.{i}.matcher",
                "The matcher is not a valid pattern, e.g. Edit|Write.",
            )

    # MCP servers (Claude Code / Antigravity)
    names = set()
    for i, s in enumerate(cfg.get("mcp_servers") or []):
        path = f"mcp_servers.{i}"
        name = s["name"]
        if not name:
            err(f"{path}.name", "Each MCP server needs a name.")
        elif name in RESERVED_SERVERS:
            err(
                f"{path}.name",
                "“kanban” is the board's own server; it is always attached.",
            )
        elif not SERVER_RE.match(name):
            err(f"{path}.name", "A server name is letters, digits, - or _.")
        elif name in names:
            err(f"{path}.name", f"Two servers are called “{name}”.")
        names.add(name)
        if s["type"] == "http" and not re.match(r"^https?://", s["url"]):
            err(
                f"{path}.url",
                "Enter a URL starting with https:// (or http:// for localhost).",
            )
        if s["type"] == "stdio" and not s["command"].strip():
            err(f"{path}.command", "Enter the command that starts the server.")
        for p in s["env"]:
            if not ENV_RE.match(p["name"]):
                err(
                    f"{path}.env",
                    f"“{p['name']}” is not a valid environment variable name.",
                )
            elif (
                p["value"]
                and not re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", p["value"])
                and s["mode"] == "synced"
            ):
                err(
                    f"{path}.env",
                    f"{p['name']} holds a literal value that will be written to .mcp.json; use ${{{p['name']}}} instead.",
                    severity="warning",
                )
        for p in s["headers"]:
            if not HEADER_RE.match(p["name"]):
                err(f"{path}.headers", f"“{p['name']}” is not a valid header name.")

    # API agent: custom HTTP tools and remote MCP servers
    tool_names: set[str] = set()
    for i, t in enumerate(cfg.get("custom_tools") or []):
        res = check_tool_spec(t["spec"])
        for p in res["problems"]:
            err(
                f"custom_tools.{i}.spec",
                f"{p['path']} {p['message']}"
                if p["path"] not in ("spec",)
                else p["message"],
                line=p.get("line"),
                hint=p.get("hint"),
                tool=t["name"] or f"tool {i + 1}",
            )
        if t["name"] and t["name"] in tool_names:
            err(f"custom_tools.{i}.spec", f"Two custom tools are called “{t['name']}”.")
        tool_names.add(t["name"])
        for h in t["headers"]:
            if not HEADER_RE.match(h["name"]):
                err(
                    f"custom_tools.{i}.headers",
                    f"“{h['name']}” is not a valid header name.",
                )
    names = set()
    for i, s in enumerate(cfg.get("remote_mcp") or []):
        path = f"remote_mcp.{i}"
        if not SERVER_RE.match(s["name"] or ""):
            err(f"{path}.name", "A server name is letters, digits, - or _.")
        elif s["name"] in names or s["name"] in RESERVED_SERVERS:
            err(f"{path}.name", f"“{s['name']}” is already used.")
        names.add(s["name"])
        u = s["url"]
        if re.match(r"^(npx|uvx|node|python|docker|bunx?)\b", u) or (
            u and "://" not in u
        ):
            err(
                f"{path}.url",
                "stdio servers cannot run on the board server. Use a remote HTTP URL, or attach this server to a "
                "local-runner member such as Claude Code.",
            )
        elif not (
            u.startswith("https://")
            or u.startswith("http://localhost")
            or u.startswith("http://127.0.0.1")
        ):
            err(f"{path}.url", "Enter an https:// URL (http:// only for localhost).")

    ag = cfg.get("antigravity") or {}
    target = _s(ag.get("mcp_target"))
    if ag.get("sync_mcp") and (
        not target or target.startswith("/") or ".." in target.split("/")
    ):
        err(
            "antigravity.mcp_target",
            "The target file must be a path inside the working folder.",
        )
    return errs


# ---------------------------------------------------------------------------
# Items that need a tick (Documented), with a hash of what the person has to copy
# ---------------------------------------------------------------------------


def documented_items(cfg: dict, provider: str) -> list[dict]:
    """The Documented items of a member: [{key, label, group, content}], where `content` is what the person must
    set up by hand (its hash tells whether a tick is still valid)."""
    from .providers import adapter_of, capabilities

    adapter = adapter_of(provider)
    caps = capabilities(provider)
    out: list[dict] = []
    if adapter == "claude-code":
        out.append(
            {
                "key": "user_instructions",
                "label": "User CLAUDE.md",
                "group": "instructions",
                "content": cfg.get("user_instructions") or "",
                "empty": not (cfg.get("user_instructions") or "").strip(),
            }
        )
    if adapter == "antigravity":
        text = expand_includes(cfg.get("instructions") or "", cfg.get("snippets") or [])
        out.append(
            {
                "key": "instructions",
                "label": "Rules",
                "group": "instructions",
                "content": text,
                "empty": not text.strip(),
            }
        )
        out.append(
            {
                "key": "skills",
                "label": "Workflows",
                "group": "skills",
                "content": json.dumps(
                    [[s["name"], s["content"]] for s in cfg.get("skills") or []]
                ),
                "empty": not cfg.get("skills"),
            }
        )
        out.append(
            {
                "key": "permissions",
                "label": "Permissions",
                "group": "permissions",
                "content": cfg.get("permission_notes") or "",
                "empty": False,
            }
        )
        out.append(
            {
                "key": "model",
                "label": "Model",
                "group": "model",
                "content": "",
                "empty": False,
            }
        )
    for s in cfg.get("skills") or []:
        if adapter == "claude-code" and s["mode"] == "documented":
            out.append(
                {
                    "key": f"skill:{s['id']}",
                    "label": s["name"] or "skill",
                    "group": "skills",
                    "content": s["content"],
                    "empty": False,
                }
            )
    for s in cfg.get("mcp_servers") or []:
        documented = s["mode"] == "documented" or (
            adapter == "antigravity"
            and not (cfg.get("antigravity") or {}).get("sync_mcp")
        )
        if documented and caps.get("mcp_servers") != "not_supported":
            out.append(
                {
                    "key": f"mcp:{s['id']}",
                    "label": s["name"] or "server",
                    "group": "mcp_servers",
                    "content": json.dumps(
                        {k: s.get(k) for k in ("type", "command", "args", "url")}
                    ),
                    "empty": False,
                }
            )
    for o in out:
        o["hash"] = sha(o["content"])
    return out


def skipped_items(cfg: dict, provider: str) -> list[dict]:
    """Items the member's adapter ignores (attached from the library or imported): [{group, names}] (design F6)."""
    from .providers import adapter_of, capabilities

    caps = capabilities(provider)
    api = adapter_of(provider) == "api"
    # An API agent only uses remote servers; the local adapters only use the stdio/http server list
    wrong_servers = cfg.get("mcp_servers") if api else cfg.get("remote_mcp")
    found = {
        "skills": cfg.get("skills") or [],
        "subagents": cfg.get("subagents") or [],
        "hooks": cfg.get("hooks") or [],
        "tools": cfg.get("custom_tools") or [],
        "mcp_servers": wrong_servers or [],
    }
    out = []
    for group, items in found.items():
        if group == "mcp_servers" or caps.get(group) == "not_supported":
            names = [
                i.get("name") or f"{i.get('event')}: {i.get('command', '')[:40]}"
                for i in items
            ]
            if names:
                out.append({"group": group, "names": names})
    return out
