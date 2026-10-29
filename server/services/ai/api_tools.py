"""Tools an API agent gets besides the ticket tools: Docs read / Docs write, the member's custom HTTP tools and the
tools of its remote MCP servers (design/screens/ai-provider-config.md, D2, D3, D4).

Docs go through the same guard as an MCP call from a CLI run. Custom and remote tools reach out to other systems, so
what they return is fenced as untrusted text, and they are left out of read-only (ask) runs unless they only read.
"""

import json
from dataclasses import dataclass, field

from . import config_model as cm
from . import custom_tools, mcp_remote

_S = {"type": "string"}

DOC_READ = {
    "list_docs": {
        "name": "list_docs",
        "description": "List the project's Docs pages as a flat tree (id, parent_id, title, version).",
        "parameters": {"type": "object", "properties": {}},
    },
    "read_doc": {
        "name": "read_doc",
        "description": "Read a Docs page: markdown, version and headings. Pass its version to update_doc as base_version.",
        "parameters": {
            "type": "object",
            "properties": {"page_id": _S},
            "required": ["page_id"],
        },
    },
    "search_docs": {
        "name": "search_docs",
        "description": "Full-text search over the project's Docs pages.",
        "parameters": {
            "type": "object",
            "properties": {"query": _S},
            "required": ["query"],
        },
    },
}
DOC_WRITE = {
    "create_doc": {
        "name": "create_doc",
        "description": "Create and publish a Docs page (body headings start at '##').",
        "parameters": {
            "type": "object",
            "properties": {"title": _S, "markdown": _S, "parent_id": _S},
            "required": ["title"],
        },
    },
    "update_doc": {
        "name": "update_doc",
        "description": "Replace a Docs page's Markdown (the full new body). base_version is the version you read.",
        "parameters": {
            "type": "object",
            "properties": {
                "page_id": _S,
                "markdown": _S,
                "base_version": {"type": "integer"},
                "note": _S,
            },
            "required": ["page_id", "markdown", "base_version"],
        },
    },
}
DOC_TOOLS = set(DOC_READ) | set(DOC_WRITE)


def docs_defs(mode: str, groups: dict) -> list[dict]:
    """Tool definitions of the enabled Docs groups (writes only in work runs)."""
    out = []
    if groups.get("docs_read", True):
        out += list(DOC_READ.values())
    if groups.get("docs_write", False) and mode != "ask":
        out += list(DOC_WRITE.values())
    return out


async def run_docs(ctx, name: str, args: dict, call) -> str:
    """Execute a Docs tool through the guard (`call(tool, action, op, params)` from api_agent.run_tool)."""
    from kanban_mcp.tools.docs import DOCS_READ_OPS, DOCS_WRITE_OPS

    if name == "list_docs":
        data = await call(
            "docs_read", "list", DOCS_READ_OPS["list"], {"project_id": ctx.project_id}
        )
        return json.dumps(data)[:20000]
    if name == "read_doc":
        data = await call(
            "docs_read", "get", DOCS_READ_OPS["get"], {"page_id": args.get("page_id")}
        )
        return json.dumps(data)[:20000]
    if name == "search_docs":
        data = await call(
            "docs_read",
            "search",
            DOCS_READ_OPS["search"],
            {"project_id": ctx.project_id, "query": args.get("query", "")},
        )
        return json.dumps(data)[:20000]
    if name == "create_doc":
        params = {"project_id": ctx.project_id, "title": args.get("title", "")}
        for k in ("markdown", "parent_id"):
            if args.get(k):
                params[k] = args[k]
        data = await call("docs_write", "create", DOCS_WRITE_OPS["create"], params)
        return f"Created page {data.get('id')} (v{data.get('version')})."
    if name == "update_doc":
        params = {
            "page_id": args.get("page_id"),
            "markdown": args.get("markdown", ""),
            "base_version": int(args.get("base_version") or 0),
        }
        if args.get("note"):
            params["note"] = args["note"]
        data = await call("docs_write", "update", DOCS_WRITE_OPS["update"], params)
        return f"Updated page {data.get('id')} to v{data.get('version')}."
    return f"Unknown tool {name}."


@dataclass
class Extra:
    """A custom or remote tool offered to the model."""

    kind: str  # http | mcp
    label: str
    spec: str = ""  # http: the tool file text
    headers: dict = field(default_factory=dict)
    url: str = ""  # mcp: the server URL
    tool: str = ""  # mcp: the tool's own name
    reads_only: bool = False


async def load_extra_tools(
    config: dict, mode: str
) -> tuple[list[dict], dict[str, Extra], list[str]]:
    """(definitions for the model, registry by tool name, notes about servers that could not be reached)."""
    defs: list[dict] = []
    registry: dict[str, Extra] = {}
    notes: list[str] = []
    for t in config.get("custom_tools") or []:
        if not t["enabled"]:
            continue
        check = cm.check_tool_spec(t["spec"])
        if not check["ok"]:
            notes.append(
                f"Custom tool {t['name'] or '?'} is disabled until its file is fixed."
            )
            continue
        tool = check["tool"]
        method = (tool["http"].get("method") or "GET").upper()
        if mode == "ask" and method != "GET":
            continue
        defs.append(
            {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["input_schema"],
            }
        )
        registry[tool["name"]] = Extra(
            "http",
            tool["name"],
            spec=t["spec"],
            headers=cm.header_values(t["headers"]),
            reads_only=method == "GET",
        )
    if mode != "ask":
        for s in config.get("remote_mcp") or []:
            if not s["enabled"]:
                continue
            headers = cm.header_values(s["headers"])
            try:
                tools = await mcp_remote.list_tools_http(s["url"], headers)
            except mcp_remote.McpError as exc:
                notes.append(f"MCP server {s['name']} could not be reached: {exc}")
                continue
            for tl in tools:
                name = mcp_remote.safe_tool_name(s["name"], tl["name"])
                if name in registry:
                    continue
                defs.append(
                    {
                        "name": name,
                        "description": f"[{s['name']}] {tl['description']}"[:1000],
                        "parameters": tl["input_schema"],
                    }
                )
                registry[name] = Extra(
                    "mcp",
                    f"{s['name']} · {tl['name']}",
                    url=s["url"],
                    headers=headers,
                    tool=tl["name"],
                )
    return defs, registry, notes


async def run_extra(extra: Extra, name: str, args: dict) -> str:
    """Execute a custom or remote tool; errors come back as text the model can read."""
    if extra.kind == "http":
        res = await custom_tools.call(extra.spec, extra.headers, args)
        return custom_tools.as_model_text(name, res)
    try:
        text = await mcp_remote.call_tool_http(
            extra.url, extra.headers, extra.tool, args
        )
    except mcp_remote.McpError as exc:
        return f"ERROR: the MCP server did not answer: {exc}"
    safe = text.replace("</untrusted>", "<\\/untrusted>")
    err = "ERROR: " if safe.startswith("ERROR: ") else ""
    safe = safe.removeprefix("ERROR: ")
    return f'{err}<untrusted source="mcp · {extra.label}">\n{safe}\n</untrusted>'
