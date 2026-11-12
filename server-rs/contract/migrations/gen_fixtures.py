"""Fixtures for the migration differential (docs/specs/rust-migration.md, "How parity is checked", point 5).

For each of the 80 revisions R of the Alembic chain this builds a SQLite database at R with the Python server's own
migrations, fills every table that exists at R with sample rows (the cases the later data migrations branch on,
NULLs, empty strings, Unicode, JSON lists and objects, rows whose parent is missing), saves that file as the fixture,
then lets Alembic upgrade a copy to the head and saves what the database holds afterwards as the expected result.
`kb-db/tests/migrations_differential.rs` upgrades the same fixtures with `kb_db::migrations` and compares.

Run from `server/` with its virtualenv:

    .venv/bin/python ../server-rs/contract/migrations/gen_fixtures.py sqlite
    .venv/bin/python ../server-rs/contract/migrations/gen_fixtures.py servers   # needs KANBAN_TEST_POSTGRES_URL / KANBAN_TEST_MYSQL_URL
    .venv/bin/python ../server-rs/contract/migrations/gen_fixtures.py expect <fixture.db or .db.gz>   # prints the expected result

The script always works in its own temporary folders (`KANBAN_CONFIG_DIR`, `KANBAN_DB_PATH`, `KANBAN_LOG_DIR`), never
the developer's. `servers` makes its own databases named `kanban_dbkit_migfix`, and builds the old states from the
Python sources of the app versions that made them (git worktrees under /var/tmp, removed afterwards). The script only
reads the Python server; it is deleted with it.
"""

import gzip
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="kanban-migration-fixtures-"))
os.environ["KANBAN_CONFIG_DIR"] = str(_TMP / "config")
os.environ["KANBAN_DB_PATH"] = str(_TMP / "data" / "kanban.db")
os.environ["KANBAN_LOG_DIR"] = str(_TMP / "logs")
_SERVER_URLS = {
    "postgresql": os.environ.pop("KANBAN_TEST_POSTGRES_URL", ""),
    "mysql": os.environ.pop("KANBAN_TEST_MYSQL_URL", ""),
}
os.environ.pop("KANBAN_DATABASE_URL", None)
sys.path.insert(0, os.getcwd())

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from alembic.script import ScriptDirectory  # noqa: E402
from sqlalchemy import create_engine, inspect, text  # noqa: E402

HERE = Path(__file__).resolve().parent
QUERIES = json.loads((HERE / "dump_queries.json").read_text())
FIXTURES = HERE / "fixtures"
EXPECTED = HERE / "expected"

LEGACY_REVISIONS = {"f6a7b8c9d0e1": "1e1bb4aa5fa4"}  # database.LEGACY_REVISIONS
# The first revision a PostgreSQL or MySQL database can be stamped with (app 3.37.0, commit 287f197f) and the app
# versions whose sources make the old server databases
SERVER_BASE = "e8b0d2f4a6c9"
SERVER_SOURCES = {
    "e8b0d2f4a6c9": "287f197f18e586f83bc45d65ff04d214054bbccd",  # 3.37.0
    "f1c3e5a7b9d2": "7482165",  # 3.37.1
}

# Times in the sample rows are in 2025: a time the migrations take from the clock is later and can be told apart
T0 = "2025-03-01T10:00:00.000000+00:00"
SHADOW = ("_data", "_idx", "_content", "_docsize", "_config")


def log(*parts) -> None:
    print(*parts, file=sys.stderr, flush=True)


def alembic_cfg() -> Config:
    return Config("alembic.ini")


def script_dir() -> ScriptDirectory:
    return ScriptDirectory.from_config(alembic_cfg())


def chain() -> list[str]:
    """Every revision, in the order Alembic applies them to an empty database."""
    return [step.revision.revision for step in script_dir()._upgrade_revs("head", ())]


def chain_file() -> list[str]:
    path = HERE.parent.parent / "crates" / "kb-db" / "schema" / "revisions.txt"
    return [line.split()[0] for line in path.read_text().splitlines() if line.strip()]


def upgrade(conn, revision: str) -> None:
    """`alembic upgrade <revision>` on an open connection, as `database._run_upgrade` does."""
    cfg = alembic_cfg()
    cfg.attributes["connection"] = conn
    current = conn.execute(text("SELECT version_num FROM alembic_version")).scalars().all() if inspect(conn).has_table("alembic_version") else []
    for old, new in LEGACY_REVISIONS.items():
        if old in current:
            conn.execute(text("UPDATE alembic_version SET version_num = :new WHERE version_num = :old"), {"new": new, "old": old})
    command.upgrade(cfg, revision)


# ---------------------------------------------------------------------------
# Sample rows
# ---------------------------------------------------------------------------

UNICODE = "Tên ô 💡 日本語 'quote' \"double\" \\ back"
JSON_LIST = '[{"a": 1, "b": "\\u00e9t\\u00e9", "c": [1, 2.5, null, true]}, "x"]'
JSON_OBJECT = '{"k": [1, 2.5, null, true], "u": "ü", "nested": {"z": {}}}'

_MICRO = json.dumps(
    [
        {"id": "mt-1", "text": "  a thought  ", "at": "2025-01-02T00:00:00+00:00"},
        {"text": "no id, no time é"},
        {"id": "mt-3", "text": "   "},
        "not an object",
        {"id": 7, "text": 12.5},
        {"id": "mt-null", "text": None},
        {"id": "mt-bool", "text": True, "at": ""},
        {"id": "", "text": "empty id"},
        {"id": "mt-missing-text"},
    ]
)
_ASSUME = json.dumps(
    [
        {"id": "as-1", "text": "users want it", "status": "validated", "at": "2025-01-03T00:00:00+00:00"},
        {"text": " cheap to build ", "status": "invalidated"},
        {"id": "as-3", "text": "x", "status": "untested"},
        {"id": "as-4", "text": "y", "status": "weird"},
        {"id": "as-5", "text": "z"},
        {"id": "as-6", "text": ""},
        5,
        {"id": "as-7", "text": "status is a number", "status": 3},
        {"id": "as-8", "text": 0, "status": None, "at": 0},
    ]
)


def _trail(n: int) -> str:
    return json.dumps([{"id": f"tr-{i}", "label": f"Step {i} — ✓", "at": "2025-01-01T00:00:00+00:00", "author": "Minh"} for i in range(n)])


def _idea(id_: str, status: str, **more) -> dict:
    return {
        "id": id_,
        "project_id": "p-1",
        "title": f"Idea {id_}",
        "idea_status": status,
        "activity_trail": _trail(2),
        "microthoughts": "[]",
        "assumptions": "[]",
        "revisit_date": None,
        "promoted_to_ticket_id": None,
        "promoted_at": None,
        "created_at": T0,
        "updated_at": "2025-03-02T10:00:00.000000+00:00",
        **more,
    }


# Rows written into a table when it exists; a row only gets the columns the table has at that revision. They cover
# the branches of the migrations that change rows (see each file's upgrade()).
SCENARIOS: dict[str, list[dict]] = {
    "project": [
        {"id": "p-1", "name": "One", "prefix": "ONE"},
        {"id": "p-2", "name": "Two ü", "prefix": "TWO"},
    ],
    "member": [
        {"id": "m-human", "project_id": "p-1", "name": "Ann", "kind": "human", "color": "#111111"},
        {"id": "m-ai", "project_id": "p-1", "name": "Bot", "kind": "ai", "color": "#222222"},
        {"id": "m-ai-removed", "project_id": "p-1", "name": "Old bot", "kind": "ai_removed", "color": "#333333"},
        # one AI member per provider (d3e4f5a6b7c8 gives each the look of its provider)
        *[
            {"id": f"m-{p}", "project_id": "p-2", "name": p, "kind": "ai", "color": "#000000"}
            for p in ("claude-code", "anthropic", "antigravity", "openai", "gemini", "custom", "mcp-client", "unknown")
        ],
        {"id": "m-human-with-profile", "project_id": "p-2", "name": "Not AI", "kind": "human", "color": "#444444"},
    ],
    "ai_member": [
        *[
            {"id": f"m-{p}", "project_id": "p-2", "provider": p, "glyph": "spark"}
            for p in ("claude-code", "antigravity", "openai", "gemini", "custom", "mcp-client", "unknown")
        ],
        {"id": "m-anthropic", "project_id": "p-2", "provider": "anthropic", "glyph": "hex"},  # a glyph already chosen
        {"id": "m-human-with-profile", "project_id": "p-2", "provider": "openai", "glyph": "spark"},
        {"id": "m-no-member-row", "project_id": "p-2", "provider": "gemini", "glyph": "spark"},
    ],
    "ticket": [
        {"id": "t-done", "project_id": "p-1", "status": "done", "assignee": "m-human"},
        {"id": "t-wontdo", "project_id": "p-1", "status": "wont_do", "assignee": "m-ai"},
        {"id": "t-wontdo2", "project_id": "p-1", "status": "wont_do", "assignee": "m-ai-removed"},
        {"id": "t-open", "project_id": "p-1", "status": "in-progress", "assignee": "m-gone"},
        {"id": "t-nobody", "project_id": "p-2", "status": "todo", "assignee": None},
    ],
    "idea_ticket": [
        _idea("i-dropped", "dropped"),
        _idea("i-dropped-revisit", "dropped", revisit_date="2025-12-01"),
        _idea("i-approved-none", "approved"),
        _idea("i-approved-empty", "approved", promoted_to_ticket_id=""),
        _idea("i-approved-gone", "approved", promoted_to_ticket_id="t-missing", promoted_at=T0),
        _idea("i-approved-done", "approved", promoted_to_ticket_id="t-done", promoted_at=T0),
        _idea("i-approved-wontdo", "approved", promoted_to_ticket_id="t-wontdo", promoted_at=T0),
        _idea("i-approved-open", "approved", promoted_to_ticket_id="t-open", promoted_at=T0),
        _idea("i-approved-none-revisit", "approved", revisit_date=" 2025-12-02 "),
        _idea("i-approved-nobody-revisit", "approved", promoted_to_ticket_id="t-nobody", revisit_date="2025-12-03"),
        _idea("i-draft-fresh", "draft", activity_trail=_trail(1)),
        _idea("i-draft-no-trail", "draft", activity_trail="[]", updated_at=""),
        _idea("i-draft-touched", "draft"),
        _idea("i-draft-micro", "draft", activity_trail=_trail(1), microthoughts=_MICRO),
        _idea("i-draft-assume", "draft", activity_trail=_trail(1), assumptions=_ASSUME),
        _idea("i-draft-revisit", "draft", activity_trail=_trail(1), revisit_date="2025-12-04"),
        _idea("i-review", "in_review", microthoughts=_MICRO.replace("mt-", "mu-").replace("7", "8"), assumptions=_ASSUME.replace("as-", "at-")),
        _idea("i-review-revisit", "in_review", revisit_date="   "),
        _idea("i-review-wontdo", "in_review", promoted_to_ticket_id="t-wontdo2"),
        _idea("i-old-raw", "raw", idea_color="#F5C518"),
        _idea("i-old-brewing", "brewing", idea_color="orange"),
        _idea("i-old-validated", "validated", idea_color="teal"),
        _idea("i-unknown", "something else", idea_color="yellow"),
        _idea("i-bad-json", "draft", activity_trail="not json", microthoughts='{"a": 1}', assumptions="null"),
        _idea("i-empty-json", "draft", activity_trail="", microthoughts="", assumptions=""),
        _idea(
            "i-body",
            "in_review",
            idea_energy="high",
            ice_impact=5,
            ice_effort=1,
            ice_confidence=4,
            problem_statement="  Why it matters ü  ",
            description="  What it is\nsecond line  ",
            activity_trail=json.dumps([{"id": "u1", "label": "Tạo ý tưởng 💡", "at": "2025-01-01", "author": None, "n": 1.0, "f": 0.1, "big": 12345678901234567890, "neg": -1.5e-7, "nested": {"b": [True, False, None], "a": "é"}}]),
        ),
        _idea("i-problem-only", "in_review", problem_statement="Only a problem", description=""),
        _idea("i-description-only", "in_review", problem_statement=None, description="Only a description", idea_energy=""),
        _idea("i-no-project", "draft", project_id="p-missing"),
    ],
    "docs_page": [
        {"id": "pg-published", "project_id": "p-1", "title": "Published page", "version": 2, "deleted_at": None},
        {"id": "pg-draft", "project_id": "p-1", "title": "Only a draft", "version": 0, "deleted_at": None},
        {"id": "pg-empty", "project_id": "p-2", "title": "Nothing written ü", "version": 0, "deleted_at": None},
        {"id": "pg-deleted", "project_id": "p-1", "title": "In the bin", "version": 1, "deleted_at": T0},
        {"id": "pg-wrong-version", "project_id": "p-1", "title": "Version row missing", "version": 7, "deleted_at": None},
    ],
    "docs_version": [
        {"id": "v-1", "page_id": "pg-published", "version": 1, "markdown": "# Old title\n\nold"},
        {
            "id": "v-2",
            "page_id": "pg-published",
            "version": 2,
            "markdown": "# One *big* title #\ntext\n```\n# not a heading\n```\n## [[Other page#part|shown]] and [a link](http://x)\r\n#nospace\n### ==mark== `code` ~~gone~~\n   ~~~\n## in a fence\n~~~\n###### Tiêu đề sâu 日本語 ##\n####### seven\n#\t Tabbed\n## \n## [[Plain]] __bold__\n",
        },
        {"id": "v-3", "page_id": "pg-deleted", "version": 1, "markdown": "# Deleted"},
        {"id": "v-4", "page_id": "pg-wrong-version", "version": 1, "markdown": "# Not the current version"},
    ],
    "docs_draft": [
        {"id": "d-1", "page_id": "pg-draft", "markdown": "## Draft heading\nbody"},
        {"id": "d-2", "page_id": "pg-published", "markdown": "## Draft of a published page"},
        {"id": "d-3", "page_id": "pg-wrong-version", "markdown": "# From the draft ## after a line separator"},
    ],
    "ai_project_settings": [
        {
            "project_id": "p-1",
            "runs_per_ticket_per_day": 6,
            "board_runs_per_day": 60,
            "notify": json.dumps(
                {
                    "approval_requested": {"desktop": False, "email": True},
                    "budget": {"desktop": 1},
                    "unknown_event": {"desktop": True},
                    "offline": "yes",
                    "question": {"email": True},
                    "blocked": {"desktop": None},
                }
            ),
        },
        {"project_id": "p-2", "runs_per_ticket_per_day": 9, "board_runs_per_day": None, "notify": '{"budget": {"desktop": 0}, "auto_trip": {"desktop": "no"}}'},
        {"project_id": "p-bad-json", "runs_per_ticket_per_day": 6, "board_runs_per_day": 100, "notify": "not json"},
        {"project_id": "p-empty", "runs_per_ticket_per_day": 15, "board_runs_per_day": 60, "notify": ""},
        {"project_id": "p-null", "notify": "null"},
        {"project_id": "p-list", "notify": "[]"},
        {"project_id": "p-last", "notify": '{"run_restarted": {"desktop": true}, "run_stopped_memory": {"desktop": []}}'},
    ],
    "ai_chat": [
        {"id": "c-ticket", "project_id": "p-1", "scope": "ticket", "ticket_id": "t-open", "doc_id": None},
        {"id": "c-doc", "project_id": "p-1", "scope": "doc", "ticket_id": None, "doc_id": "pg-published"},
        {"id": "c-project", "project_id": "p-1", "scope": "project", "ticket_id": "t-done", "doc_id": "pg-draft"},
    ],
    "docs_follow": [
        {"id": "f-1", "project_id": "p-1", "follower": "You"},
        {"id": "f-2", "project_id": "p-1", "follower": "  Alice  "},
        {"id": "f-3", "project_id": "p-2", "follower": ""},
        {"id": "f-4", "project_id": "p-2", "follower": "user"},
        {"id": "f-5", "project_id": "p-missing", "follower": "ÉMILE Σ"},
    ],
    "notification": [
        {"id": f"n-{kind}", "kind": kind, "recipient": "user"}
        for kind in ("page_proposal", "approval", "blocked", "run_restarted", "story_plan", "story_blocked", "story_done", "mention", "ai_done")
    ],
    "notify_event": [
        {"id": f"e-{kind}", "kind": kind}
        for kind in ("page_proposal", "approval", "blocked", "run_restarted", "story_plan", "story_blocked", "story_done", "mention")
    ],
    "notify_follow": [
        {"id": "nf-1", "recipient": "user", "scope": "kind", "scope_id": "approval"},
        {"id": "nf-2", "recipient": "user", "scope": "kind", "scope_id": "mention"},
        {"id": "nf-3", "recipient": "user", "scope": "space", "scope_id": "approval"},
        {"id": "nf-4", "recipient": "ann", "scope": "kind", "scope_id": "story_done"},
    ],
}

GENERIC_ROWS = 3


def _kind(type_) -> str:
    name = str(type_).upper()
    if "BOOL" in name or name.startswith("TINYINT"):
        return "bool"
    if "INT" in name or "SERIAL" in name:
        return "int"
    if any(k in name for k in ("FLOAT", "REAL", "DOUBLE", "NUMERIC", "DECIMAL")):
        return "float"
    return "text"


def _generic(table: str, column: dict, i: int):
    """The value of one column in the i-th generic row of a table."""
    name, kind = column["name"], _kind(column["type"])
    nullable, default, pk = column["nullable"], column.get("default"), column.get("primary_key")
    if kind == "bool":
        return bool(i % 2)
    if kind == "int":
        if pk:
            return i + 1
        return None if (nullable and i == 1) else i * 7
    if kind == "float":
        return None if (nullable and i == 1) else i * 1.5 + 0.25
    if pk:
        return f"{table}-{i}"
    if name == "project_id":
        return ["p-1", "p-2", "p-missing"][i]
    if name.endswith("_id"):
        return [f"{name[:-3]}-0", None if nullable else f"{name[:-3]}-1", "missing-parent"][i]
    if name == "prefix":
        return f"GEN{i}"
    if default is not None and ("[" in str(default) or "{" in str(default)):
        is_list = "[" in str(default)
        return [("[]" if is_list else "{}"), (JSON_LIST if is_list else JSON_OBJECT), ("[]" if is_list else "{}")][i]
    if name == "at" or name.endswith("_at") or name.endswith("_date") or name == "day":
        return [T0, None if nullable else "2025-04-01T00:00:00.000000+00:00", "2025-05-05T05:05:05.555555+00:00"][i]
    return [f"{name} {i}", None if nullable else UNICODE, UNICODE if nullable else ""][i]


def fill(conn) -> int:
    """Write the sample rows into every table the database has. Returns how many rows went in."""
    dialect = conn.dialect.name
    insp = inspect(conn)
    names = sorted(insp.get_table_names())
    quote = (lambda n: f"`{n}`") if dialect == "mysql" else (lambda n: f'"{n}"')
    ignore = {"sqlite": "INSERT OR IGNORE INTO", "mysql": "INSERT IGNORE INTO", "postgresql": "INSERT INTO"}[dialect]
    tail = " ON CONFLICT DO NOTHING" if dialect == "postgresql" else ""
    virtual = set()
    if dialect == "sqlite":
        virtual = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'"))}
    count = 0
    for table in names:
        if table in ("alembic_version", "kanban_change") or table.startswith("sqlite_"):
            continue
        if any(table == v + s for v in virtual for s in SHADOW):
            continue
        if table in virtual:
            columns = [{"name": r[1], "type": "TEXT", "nullable": False, "default": None, "primary_key": False} for r in conn.execute(text(f"PRAGMA table_info({table})"))]
        else:
            columns = insp.get_columns(table)
            pk = set(insp.get_pk_constraint(table).get("constrained_columns") or [])
            for c in columns:
                c["primary_key"] = c["name"] in pk
        rows = [{c["name"]: _generic(table, c, i) for c in columns} for i in range(GENERIC_ROWS)]
        for n, scenario in enumerate(SCENARIOS.get(table, [])):
            row = {c["name"]: _generic(f"{table}-s{n}", c, 0) for c in columns}
            for c in columns:
                if c["primary_key"] and _kind(c["type"]) == "int":
                    row[c["name"]] = 100 + n
            kinds = {c["name"]: _kind(c["type"]) for c in columns}
            # a scenario's text id does not go into a numbered key
            row.update({k: v for k, v in scenario.items() if k in row and not (kinds[k] == "int" and isinstance(v, str))})
            rows.append(row)
        cols = [c["name"] for c in columns]
        sql = f"{ignore} {quote(table)} ({', '.join(quote(c) for c in cols)}) VALUES ({', '.join(':p' + str(i) for i in range(len(cols)))}){tail}"
        for row in rows:
            result = conn.execute(text(sql), {f"p{i}": row[c] for i, c in enumerate(cols)})
            count += max(result.rowcount, 0)
    return count


# ---------------------------------------------------------------------------
# What a database holds, written down
# ---------------------------------------------------------------------------


def dump(conn) -> dict:
    """The schema and every row, as text, through the queries of dump_queries.json."""
    q = QUERIES[conn.dialect.name]

    def run(sql: str) -> list[list]:
        return [[None if v is None else str(v) for v in row] for row in conn.execute(text(sql))]

    out = {"schema": {name: run(sql) for name, sql in q["schema"].items()}, "data": {}}
    for (table,) in run(q["tables"]):
        columns = [r[0] for r in run(q["columns"].replace("{table}", table))]
        cells = ", ".join(q["cell"].replace("{column}", c) for c in columns)
        out["data"][table] = {"columns": columns, "rows": run(f"SELECT {cells} FROM {q['from'].replace('{table}', table)}")}
    return out


def write_gz(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 and no file name in the header: the same content gives the same bytes
    with open(path, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as f:
        f.write(data)


def write_json_gz(path: Path, value) -> None:
    write_gz(path, json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------

# Databases that are not what the chain makes: stamped with a removed revision, or left half-made by a pre-release
# build. Each is the schema at a revision plus a few statements, then sample rows. They exercise the "only what is
# missing" branches of the migrations.
VARIANTS: dict[str, tuple[str, list[str]]] = {
    "legacy-f6a7b8c9d0e1": (
        "1e1bb4aa5fa4",
        [
            "UPDATE alembic_version SET version_num = 'f6a7b8c9d0e1'",
            "ALTER TABLE ticket ADD COLUMN board TEXT NOT NULL DEFAULT 'main'",
            "ALTER TABLE ticket ADD COLUMN idea_status TEXT",
        ],
    ),
    "blocks-already-there": (
        "d4e5f6a7b8c9",
        [
            "ALTER TABLE ticket ADD COLUMN blocked_by VARCHAR DEFAULT '[]' NOT NULL",
            "ALTER TABLE ticket ADD COLUMN block_done_if_tcs_incomplete BOOLEAN DEFAULT 0 NOT NULL",
        ],
    ),
    "docs-ai-ignore-missing": ("a3c5e7f9b1d4", ["DROP TABLE docs_ai_ignore"]),
    "ai-team-v2-half-made": (
        "e6611f7871e7",
        [
            "DROP TABLE ai_eval_mark",
            "DROP TABLE ai_knowledge_doc",
            "DROP TABLE kb_fts",
            "DROP INDEX ix_ai_lesson_state",
            "DROP INDEX ix_ai_skill_use_plugin",
            "ALTER TABLE ai_run DROP COLUMN model_override",
            "ALTER TABLE ai_run DROP COLUMN retries",
            "ALTER TABLE ai_project_settings DROP COLUMN ops",
        ],
    ),
    "workflow-meta-already-there": ("b3e1c9d7a5f2", ["ALTER TABLE ai_ticket_workflow ADD COLUMN meta VARCHAR DEFAULT '{}' NOT NULL"]),
    "lookup-indexes-already-there": (
        "c4e6a8b0d2f1",
        ["CREATE INDEX ix_member_project_id ON member (project_id)", "CREATE INDEX ix_ticket_assignee ON ticket (assignee)"],
    ),
    "ai-v2-reset-pre-release": (
        "a2b4c6d8e0f1",
        [
            "ALTER TABLE ai_run DROP COLUMN live",
            "ALTER TABLE ai_run DROP COLUMN waiting_reason",
            "ALTER TABLE ai_run_agent DROP COLUMN claude_id",
            "DROP INDEX ix_ai_run_step_tool_id",
            "ALTER TABLE ai_run_step DROP COLUMN tool_id",
        ],
    ),
    "made-from-the-models": (
        "f1c3e5a7b9d2",
        [
            # a database whose tables came from newer models than its stamp: the v2 tables and columns are there
            "ALTER TABLE ai_role_pack ADD COLUMN roles VARCHAR DEFAULT '[]' NOT NULL",
            "CREATE TABLE ai_session_history (id VARCHAR NOT NULL, project_id VARCHAR NOT NULL, ticket_id VARCHAR NOT NULL, member_id VARCHAR NOT NULL, title VARCHAR NOT NULL, summary VARCHAR NOT NULL, session_ids VARCHAR NOT NULL, run_ids VARCHAR NOT NULL, started_at VARCHAR, ended_at VARCHAR NOT NULL, created_by VARCHAR NOT NULL, summarised_by VARCHAR NOT NULL, PRIMARY KEY (id))",
            "CREATE INDEX ix_ai_session_history_ticket_id ON ai_session_history (ticket_id)",
            'CREATE TABLE ai_touch_mark ("key" VARCHAR NOT NULL, project_id VARCHAR NOT NULL, mark VARCHAR NOT NULL, marked_by VARCHAR, marked_at VARCHAR NOT NULL, lesson_id VARCHAR, PRIMARY KEY ("key"))',
            "ALTER TABLE ai_chat ADD COLUMN seen_at VARCHAR",
            "ALTER TABLE docs_ai_settings DROP COLUMN read_scope",
            "ALTER TABLE docs_page DROP COLUMN ai_guidance",
            "CREATE TABLE ai_run_command (id INTEGER NOT NULL, run_id VARCHAR NOT NULL, command VARCHAR NOT NULL, payload VARCHAR NOT NULL, created_at VARCHAR NOT NULL, taken_at VARCHAR, PRIMARY KEY (id))",
        ],
    ),
}


def expected_sqlite(fixture: Path) -> dict:
    """What a copy of `fixture` holds after `alembic upgrade head`."""
    work = Path(tempfile.mkdtemp(prefix="expect-", dir=_TMP))
    copy = work / "kanban.db"
    if fixture.suffix == ".gz":
        copy.write_bytes(gzip.decompress(fixture.read_bytes()))
    else:
        shutil.copyfile(fixture, copy)
    engine = create_engine(f"sqlite:///{copy}")
    with engine.begin() as conn:
        upgrade(conn, "head")
    with engine.connect() as conn:
        out = dump(conn)
    engine.dispose()
    shutil.rmtree(work)
    return out


def _save_sqlite(name: str, source: Path, extra: list[str]) -> None:
    work = Path(tempfile.mkdtemp(prefix=f"fx-{name}-", dir=_TMP))
    db = work / "kanban.db"
    shutil.copyfile(source, db)
    engine = create_engine(f"sqlite:///{db}")
    with engine.begin() as conn:
        for statement in extra:
            conn.execute(text(statement))
        rows = fill(conn)
    with engine.connect() as conn:
        conn.exec_driver_sql("VACUUM")
    engine.dispose()
    write_gz(FIXTURES / "sqlite" / f"{name}.db.gz", db.read_bytes())
    write_json_gz(EXPECTED / "sqlite" / f"{name}.json.gz", expected_sqlite(db))
    log(f"sqlite {name}: {rows} rows")
    shutil.rmtree(work)


def gen_sqlite() -> None:
    order = chain()
    assert order == chain_file(), "kb-db/schema/revisions.txt is not the chain in Alembic's order"
    for folder in (FIXTURES / "sqlite", EXPECTED / "sqlite"):
        shutil.rmtree(folder, ignore_errors=True)
    # one database walked up the chain a revision at a time; each stop is copied, filled and saved
    schema_db = _TMP / "schema.db"
    engine = create_engine(f"sqlite:///{schema_db}")
    # an empty file: the whole chain from the first revision
    sqlite3.connect(_TMP / "empty.db").close()
    _save_sqlite("empty", _TMP / "empty.db", [])
    # only Alembic's own table, with no stamp: the chain runs from its first revision
    _save_sqlite(
        "unstamped",
        _TMP / "empty.db",
        ["CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL, CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"],
    )
    for revision in order:
        with engine.begin() as conn:
            upgrade(conn, revision)
        engine.dispose()
        _save_sqlite(revision, schema_db, [])
        for name, (at, statements) in VARIANTS.items():
            if at == revision:
                _save_sqlite(f"{revision}+{name}", schema_db, statements)
    # the order Alembic applies the pending revisions in, from every revision and from the states with two branches
    # open, for the runner's plan
    script = script_dir()
    plans = {}
    starts: list[tuple[str, ...]] = [(), *[(r,) for r in order]]
    ai_branch = ["e7f1a2b3c4d5", "b8c2d4e6f801", "c3d5e7f9a012", "d4e6f8a0b123", "e5f7a9b1c234", "f6a8b0c2d345", "a7c9e1f3b567", "b8d0f2a4c678", "03a006e7b66e"]
    canvas_branch = ["a7c1e3f5b9d2", "b8c9d0e1f2a3", "c1d2e3f4a5b7"]
    starts += [(a, c) for a in ai_branch for c in canvas_branch if not (a == "03a006e7b66e" and c == "a7c1e3f5b9d2")]
    starts += [("e5f6a7b8c9d0", "9a4b5c6d7e8f"), ("e5f6a7b8c9d0", "a1b2c3d4e5f6")]
    for start in starts:
        plans[",".join(start)] = [step.revision.revision for step in script._upgrade_revs("head", start)]
    (HERE / "plans.json").write_text(json.dumps(plans, indent=0, sort_keys=True) + "\n")
    log(f"plans: {len(plans)}")


# ---------------------------------------------------------------------------
# PostgreSQL and MySQL/MariaDB
# ---------------------------------------------------------------------------

SERVER_DB = "kanban_dbkit_migfix"


def _server_url(base: str) -> str:
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(base)
    return urlunsplit((parts.scheme, parts.netloc, "/" + SERVER_DB, parts.query, parts.fragment))


def _admin(dialect: str, base: str, statement: str) -> None:
    from urllib.parse import urlsplit

    parts = urlsplit(base)
    if dialect == "postgresql":
        subprocess.run(["psql", base.split("?")[0], "-q", "-v", "ON_ERROR_STOP=1", "-c", statement], check=True, capture_output=True)
    else:
        subprocess.run(
            ["mariadb", f"-u{parts.username}", f"-p{parts.password or ''}", f"-h{parts.hostname}", f"-P{parts.port or 3306}", "-e", statement],
            check=True,
            capture_output=True,
        )


def _dump_sql(dialect: str, base: str) -> bytes:
    """The database as SQL statements (tables, indexes, rows), one statement after another."""
    from urllib.parse import urlsplit

    parts = urlsplit(_server_url(base))
    if dialect == "postgresql":
        out = subprocess.run(
            ["pg_dump", "--no-owner", "--no-privileges", "--inserts", "--rows-per-insert=200", _server_url(base).split("?")[0]],
            check=True,
            capture_output=True,
        ).stdout.decode()
        # psql commands and the search_path switch are not SQL the test can send; names are written with their schema
        keep = [line for line in out.split("\n") if not line.startswith("\\") and not line.startswith("--") and "set_config('search_path'" not in line]
        return "\n".join(keep).replace("public.", "").encode()
    out = subprocess.run(
        ["mariadb-dump", "--compact", "--skip-comments", "--hex-blob", f"-u{parts.username}", f"-p{parts.password or ''}", f"-h{parts.hostname}", f"-P{parts.port or 3306}", SERVER_DB],
        check=True,
        capture_output=True,
    ).stdout.decode()
    keep = [line for line in out.split("\n") if not line.startswith("/*M!999999")]
    return "\n".join(keep).encode()


def _init_with_sources(commit: str | None, url: str) -> None:
    """Let the app of `commit` (or this checkout) set up the empty database at `url`, as it did on first start."""
    env = {**os.environ, "KANBAN_DATABASE_URL": url}
    code = "import sys, os, asyncio; sys.path.insert(0, os.getcwd()); import database; asyncio.run(database.init_db())"
    if commit is None:
        subprocess.run([sys.executable, "-c", code], check=True, env=env, capture_output=True)
        return
    repo = subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip()
    tree = Path("/var/tmp") / f"kanban-migration-src-{commit[:8]}"
    if not tree.exists():
        subprocess.run(["git", "-C", repo, "worktree", "add", "--detach", str(tree), commit], check=True, capture_output=True)
    subprocess.run([sys.executable, "-c", code], check=True, env=env, cwd=tree / "server", capture_output=True)


def _remove_sources() -> None:
    repo = subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip()
    for commit in SERVER_SOURCES.values():
        tree = Path("/var/tmp") / f"kanban-migration-src-{commit[:8]}"
        if tree.exists():
            subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", str(tree)], check=True, capture_output=True)


async def _on_server(url: str, fn):
    from dbkit import targets

    engine = targets.make_engine(targets.from_url(url))
    try:
        async with engine.begin() as conn:
            return await conn.run_sync(fn)
    finally:
        await engine.dispose()


def gen_servers() -> None:
    import asyncio

    order = chain()
    revisions = order[order.index(SERVER_BASE) :]
    try:
        for dialect, base in _SERVER_URLS.items():
            if not base:
                log(f"SKIPPED {dialect}: its KANBAN_TEST_*_URL is not set")
                continue
            folder = "postgres" if dialect == "postgresql" else "mysql"
            for target in (FIXTURES / folder, EXPECTED / folder):
                shutil.rmtree(target, ignore_errors=True)
            url = _server_url(base)
            for revision in revisions:
                _admin(dialect, base, f"DROP DATABASE IF EXISTS {SERVER_DB}")
                _admin(dialect, base, f"CREATE DATABASE {SERVER_DB}")
                # 3.37.0 made databases at e8b0d2f4a6c9 and 3.37.1 at f1c3e5a7b9d2; the revisions between that and
                # the head were only ever reached by upgrading, so they are a 3.37.1 database upgraded that far
                if revision == order[-1]:
                    _init_with_sources(None, url)
                else:
                    made_at = revision if revision in SERVER_SOURCES else "f1c3e5a7b9d2"
                    _init_with_sources(SERVER_SOURCES[made_at], url)
                    if revision != made_at:
                        asyncio.run(_on_server(url, lambda conn, r=revision: upgrade(conn, r)))
                rows = asyncio.run(_on_server(url, fill))
                write_gz(FIXTURES / folder / f"{revision}.sql.gz", _dump_sql(dialect, base))
                asyncio.run(_on_server(url, lambda conn: upgrade(conn, "head")))
                write_json_gz(EXPECTED / folder / f"{revision}.json.gz", asyncio.run(_on_server(url, dump)))
                log(f"{dialect} {revision}: {rows} rows")
            _admin(dialect, base, f"DROP DATABASE IF EXISTS {SERVER_DB}")
    finally:
        _remove_sources()


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if mode == "sqlite":
            gen_sqlite()
        elif mode == "servers":
            gen_servers()
        elif mode == "expect":
            json.dump(expected_sqlite(Path(sys.argv[2])), sys.stdout, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        else:
            raise SystemExit(__doc__)
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
