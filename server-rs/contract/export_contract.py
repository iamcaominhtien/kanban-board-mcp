"""Export the parity contract from the Python reference server (docs/specs/rust-migration.md).

Run from `server/` with its virtualenv, against a reference server started on temporary folders:

    .venv/bin/python ../server-rs/contract/export_contract.py http://127.0.0.1:PORT /path/to/its/kanban.db

Writes next to this file: openapi.json, mcp-initialize.json, mcp-tools.json, schema-sqlite.sql, schema-postgres.sql,
schema-mysql.sql. Start the server once more with KANBAN_MCP_IDEA_TOOLS=1 and pass `--ideas` to write
mcp-initialize-ideas.json and mcp-tools-ideas.json. The script only reads; it is deleted with the Python server.
"""

import json
import sqlite3
import sys
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent


def get(url: str) -> bytes:
    with urllib.request.urlopen(url) as resp:  # noqa: S310 - a local reference server
        return resp.read()


def rpc(base: str, method: str, params: dict) -> dict:
    """One MCP call over streamable HTTP; the reply is one SSE `message` event."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(  # noqa: S310
        f"{base}/mcp/",
        data=body,
        headers={"content-type": "application/json", "accept": "application/json, text/event-stream"},
    )
    with urllib.request.urlopen(req) as resp:  # noqa: S310
        raw = resp.read().decode()
    for line in raw.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    return json.loads(raw)


def write_json(name: str, value) -> None:
    (OUT / name).write_text(json.dumps(value, indent=1, ensure_ascii=False, sort_keys=False) + "\n", encoding="utf-8")


def export_http(base: str, suffix: str) -> None:
    if not suffix:
        write_json("openapi.json", json.loads(get(f"{base}/openapi.json")))
    init = rpc(
        base,
        "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "contract", "version": "0"}},
    )
    write_json(f"mcp-initialize{suffix}.json", init["result"])
    write_json(f"mcp-tools{suffix}.json", rpc(base, "tools/list", {})["result"])


def export_sqlite_schema(db_path: str) -> None:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY "
        "CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, tbl_name, name"
    ).fetchall()
    head = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    out = [f"-- SQLite schema at Alembic head {head}, as the migrations leave it (exported from the Python server)."]
    for kind, name, _table, sql in rows:
        # FTS5 shadow tables are made by their virtual table; an auto-index has no SQL
        if sql is None or any(name.endswith(s) for s in ("_data", "_idx", "_content", "_docsize", "_config")):
            continue
        out.append(sql.strip() + ";")
    (OUT / "schema-sqlite.sql").write_text("\n\n".join(out) + "\n", encoding="utf-8")
    (OUT / "alembic-head.txt").write_text(head + "\n", encoding="utf-8")


def export_server_schema() -> None:
    """The DDL `database.create_schema` runs on an empty PostgreSQL or MySQL database."""
    sys.path.insert(0, str(Path.cwd()))
    from sqlalchemy.dialects import mysql, postgresql
    from sqlalchemy.schema import CreateIndex, CreateTable
    from sqlmodel import SQLModel

    import models  # noqa: F401 - registers every table
    from dbkit import changes
    from dbkit.types import server_metadata

    for name, dialect in (("postgres", postgresql.dialect()), ("mysql", mysql.dialect())):
        meta = server_metadata(SQLModel.metadata, "postgresql" if name == "postgres" else "mysql")
        out = [f"-- {name} schema as `database.create_schema` makes it from the models (exported from the Python server)."]
        for table in list(meta.sorted_tables) + [changes.kanban_change]:
            out.append(str(CreateTable(table).compile(dialect=dialect)).strip() + ";")
            for index in sorted(table.indexes, key=lambda i: i.name or ""):
                out.append(str(CreateIndex(index).compile(dialect=dialect)).strip() + ";")
        (OUT / f"schema-{name}.sql").write_text("\n\n".join(out) + "\n", encoding="utf-8")


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    base = args[0].rstrip("/")
    if "--ideas" in sys.argv:
        export_http(base, "-ideas")
        return
    export_http(base, "")
    export_sqlite_schema(args[1])
    export_server_schema()


if __name__ == "__main__":
    main()
