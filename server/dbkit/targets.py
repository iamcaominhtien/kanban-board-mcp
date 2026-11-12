"""A database the board can use: which engine, where it is, and how to open it with the right settings.

Three engines: SQLite (a file in the data folder, the default), PostgreSQL 14+ and MySQL 8 / MariaDB 10.6+. The one in
use comes from, in this order: the environment (``KANBAN_DATABASE_URL``, which locks the Settings card), the choice
saved in Settings (``~/.kanban-board/config.json``, the password encrypted), or SQLite in the data folder.

The password is never in the settings file as text: it is encrypted with the app's own key, which the desktop app
keeps in the system keychain (``services.ai.secrets``); on a server it stays in the environment variable.
"""

import os
import ssl as ssl_lib
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.engine import URL, make_url
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

import config as app_config

from . import sqlite_gate

ENGINES = ("sqlite", "postgresql", "mysql")
SSL_MODES = ("off", "prefer", "require", "verify-full")
DEFAULT_PORTS = {"postgresql": 5432, "mysql": 3306}
LABELS = {"sqlite": "SQLite", "postgresql": "PostgreSQL", "mysql": "MySQL / MariaDB"}
ENV_URL = "KANBAN_DATABASE_URL"
ENV_PASSWORD = "KANBAN_DB_PASSWORD"
CONFIG_KEY = "database"

# Which process this is, in the connection's name on PostgreSQL ("kanban-board app 1a2b3c4d"): the board can then
# tell another app on the same database from its own MCP process. `main` keeps "app"; the stdio MCP server sets "mcp".
# The AI runner gets its token from the API that starts it (services/ai/runner_link.py), so the API can tell the
# runner's rows of the change log from another app's. Taken out of the environment so the runner's children don't share it.
PROCESS_TOKEN = os.environ.pop("KANBAN_PROCESS_TOKEN", "") or uuid.uuid4().hex
ROLE = "app"
APP_NAME_PREFIX = "kanban-board"

# How long a writer waits for SQLite's write lock before it gives up. The board and the stdio MCP process (what
# editors launch) write to the same file; with WAL, readers never wait, and a writer waits this long for the other.
SQLITE_BUSY_TIMEOUT_S = 30


class TargetError(ValueError):
    """A connection setting that cannot be used; the message says what to change."""


@dataclass(frozen=True)
class Target:
    """Where a database is. `password` is never printed (`display`, `public` and `repr` leave it out)."""

    engine: str
    path: str = ""  # SQLite: the file
    host: str = ""
    port: int | None = None
    name: str = ""
    user: str = ""
    password: str | None = field(default=None, repr=False, compare=False)
    ssl: str = "prefer"

    @property
    def is_sqlite(self) -> bool:
        """Whether this is a SQLite file."""
        return self.engine == "sqlite"

    @property
    def label(self) -> str:
        """The engine's name for people."""
        return LABELS[self.engine]

    def display(self) -> str:
        """Where it is, without the password: the file, or user@host:port/database."""
        if self.is_sqlite:
            return self.path
        user = f"{self.user}@" if self.user else ""
        return (
            f"{user}{self.host}:{self.port or DEFAULT_PORTS[self.engine]}/{self.name}"
        )

    def url(self) -> URL:
        """The SQLAlchemy URL of the async driver (with the password)."""
        if self.is_sqlite:
            return URL.create("sqlite+aiosqlite", database=self.path)
        driver = (
            "postgresql+asyncpg" if self.engine == "postgresql" else "mysql+aiomysql"
        )
        query = {"charset": "utf8mb4"} if self.engine == "mysql" else {}
        return URL.create(
            driver,
            username=self.user or None,
            password=self.password or None,
            host=self.host or None,
            port=self.port or DEFAULT_PORTS[self.engine],
            database=self.name or None,
            query=query,
        )

    def public(self) -> dict:
        """The settings people may see and the settings file may hold (no password)."""
        if self.is_sqlite:
            return {"engine": "sqlite", "path": self.path}
        return {
            "engine": self.engine,
            "host": self.host,
            "port": self.port or DEFAULT_PORTS[self.engine],
            "name": self.name,
            "user": self.user,
            "ssl": self.ssl,
        }

    def with_password(self, password: str | None) -> "Target":
        """The same target with this password."""
        return replace(self, password=password)


def _ssl_from_query(engine: str, query: dict) -> str:
    raw = str(
        query.get("sslmode") or query.get("ssl-mode") or query.get("ssl_mode") or ""
    ).lower()
    if not raw:
        return "prefer"
    mapping = {
        "disable": "off",
        "disabled": "off",
        "off": "off",
        "allow": "prefer",
        "prefer": "prefer",
        "preferred": "prefer",
        "require": "require",
        "required": "require",
        "verify-ca": "verify-full",
        "verify_ca": "verify-full",
        "verify-full": "verify-full",
        "verify_identity": "verify-full",
    }
    if raw not in mapping:
        raise TargetError(f"Unknown SSL mode “{raw}” in the connection string.")
    return mapping[raw]


def from_url(text: str) -> Target:
    """Read a connection string: ``sqlite:///path``, ``postgresql://user@host:5432/db?sslmode=require``,
    ``mysql://user@host/db`` or ``mariadb://…``. Driver suffixes (``+asyncpg``, ``+pymysql``…) are accepted."""
    text = (text or "").strip()
    if not text:
        raise TargetError("The connection string is empty.")
    try:
        url = make_url(text)
    except Exception as exc:  # noqa: BLE001 - SQLAlchemy raises several kinds
        raise TargetError(f"This is not a connection string: {exc}") from exc
    scheme = url.drivername.split("+")[0].lower()
    if scheme == "sqlite":
        if not url.database or url.database == ":memory:":
            raise TargetError("A SQLite connection string needs a file path.")
        return Target("sqlite", path=str(Path(url.database).expanduser()))
    if scheme in ("postgres", "postgresql"):
        engine = "postgresql"
    elif scheme in ("mysql", "mariadb"):
        engine = "mysql"
    elif scheme in ("redis", "rediss", "mongodb", "mongodb+srv"):
        raise TargetError(
            "Redis and MongoDB cannot hold the board: it is relational (tables that refer to each other). "
            "Use SQLite, PostgreSQL or MySQL/MariaDB."
        )
    else:
        raise TargetError(
            f"“{scheme}” is not supported. Use SQLite, PostgreSQL or MySQL/MariaDB."
        )
    if not url.host:
        raise TargetError("The connection string has no host.")
    if not url.database:
        raise TargetError("The connection string has no database name.")
    return Target(
        engine,
        host=url.host,
        port=url.port or DEFAULT_PORTS[engine],
        name=url.database,
        user=url.username or "",
        password=url.password,
        ssl=_ssl_from_query(engine, dict(url.query)),
    )


def from_fields(data: dict) -> Target:
    """A target from the Settings form (engine, host, port, name, user, password, ssl, or a connection string)."""
    if data.get("url"):
        target = from_url(str(data["url"]))
        if data.get("password") and not target.password:
            target = target.with_password(str(data["password"]))
        return target
    engine = str(data.get("engine") or "").lower()
    if engine == "mariadb":
        engine = "mysql"
    if engine not in ENGINES:
        raise TargetError("Choose SQLite, PostgreSQL or MySQL/MariaDB.")
    if engine == "sqlite":
        path = str(data.get("path") or "").strip()
        if not path:
            raise TargetError("A SQLite database needs a file path.")
        return Target("sqlite", path=str(Path(path).expanduser()))
    host = str(data.get("host") or "").strip()
    name = str(data.get("name") or "").strip()
    if not host:
        raise TargetError("Enter the server’s host name.")
    if not name:
        raise TargetError("Enter the database name.")
    port = data.get("port") or DEFAULT_PORTS[engine]
    try:
        port = int(port)
    except (TypeError, ValueError) as exc:
        raise TargetError("The port must be a number.") from exc
    ssl = str(data.get("ssl") or "prefer")
    if ssl not in SSL_MODES:
        raise TargetError(f"The secure connection setting must be one of {SSL_MODES}.")
    return Target(
        engine,
        host=host,
        port=port,
        name=name,
        user=str(data.get("user") or "").strip(),
        password=(str(data["password"]) if data.get("password") else None),
        ssl=ssl,
    )


# ---------------------------------------------------------------------------
# The database in use, and the saved choice
# ---------------------------------------------------------------------------


def env_target() -> Target | None:
    """The database set by ``KANBAN_DATABASE_URL``, with ``KANBAN_DB_PASSWORD`` when the URL has no password."""
    raw = os.environ.get(ENV_URL, "").strip()
    if not raw:
        return None
    target = from_url(raw)
    if not target.is_sqlite and not target.password and os.environ.get(ENV_PASSWORD):
        target = target.with_password(os.environ[ENV_PASSWORD])
    return target


def saved_target() -> Target | None:
    """The server database chosen in Settings, with its password; None when Settings say SQLite."""
    data = app_config.get_section(CONFIG_KEY)
    if not data or data.get("engine") in (None, "sqlite"):
        return None
    try:
        target = from_fields(data)
    except TargetError:
        return None
    password = _decrypt(data.get("password_enc"))
    if password is None and os.environ.get(ENV_PASSWORD):
        password = os.environ[ENV_PASSWORD]
    return target.with_password(password)


def resolve(sqlite_path: Path) -> tuple[Target, str]:
    """The database to use and where that came from: "environment", "settings" or "default" (SQLite)."""
    env = env_target()
    if env is not None:
        return env, "environment"
    saved = saved_target()
    if saved is not None:
        return saved, "settings"
    return Target("sqlite", path=str(sqlite_path)), "default"


def save_choice(target: Target) -> None:
    """Remember the database in Settings. The password is stored encrypted, never as text; SQLite clears it."""
    if target.is_sqlite:
        app_config.set_section(CONFIG_KEY, {"engine": "sqlite"})
        return
    data = target.public()
    if target.password:
        data["password_enc"] = _encrypt(target.password)
    app_config.set_section(CONFIG_KEY, data)


def password_store() -> str:
    """Where a saved password is kept: "keychain" (desktop) or "file" (the app's key file, readable by you only)."""
    from services.ai import secrets

    return secrets.store_kind()


def _encrypt(value: str) -> str:
    from services.ai import secrets

    return secrets.encrypt(value)


def _decrypt(token: str | None) -> str | None:
    if not token:
        return None
    from services.ai import secrets

    return secrets.decrypt(token)


# ---------------------------------------------------------------------------
# Engines
# ---------------------------------------------------------------------------


def _mysql_ssl(mode: str):
    if mode in ("off", "prefer"):
        return (
            None  # aiomysql has no "prefer": a plain connection, and the test says so
        )
    ctx = ssl_lib.create_default_context()
    if mode == "require":
        ctx.check_hostname = False
        ctx.verify_mode = ssl_lib.CERT_NONE
    return ctx


_PG_SSL = {
    "off": "disable",
    "prefer": "prefer",
    "require": "require",
    "verify-full": "verify-full",
}


def application_name(role: str | None = None) -> str:
    """This process's name on a PostgreSQL server."""
    return f"{APP_NAME_PREFIX} {role or ROLE} {PROCESS_TOKEN[:8]}"


def _tune_sqlite(sync_engine) -> None:
    @event.listens_for(sync_engine, "connect")
    def _on_connect(dbapi_conn, _record):  # noqa: ANN001 - DB-API connection
        cur = dbapi_conn.cursor()
        try:
            # WAL is a property of the file (set once by init_db); these are per connection.
            # NORMAL is safe with WAL (a crash can lose the last commit, never corrupt the file) and saves an fsync
            # on every commit, which is most of the cost of a small write.
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_S * 1000}")
            cur.execute("PRAGMA temp_store=MEMORY")
            cur.execute("PRAGMA cache_size=-16000")  # 16 MB of pages per connection
        finally:
            cur.close()


def make_engine(target: Target, *, role: str | None = None) -> AsyncEngine:
    """An async engine for `target`, with the settings each engine needs to share the database well.

    SQLite: one writer at a time across every process, so a writer waits for the lock (busy timeout) instead of
    failing at once. PostgreSQL and MySQL: a pool that checks a connection before use (a server restart or an idle
    timeout does not surface as an error in the board) and renews connections every 30 minutes.
    """
    if target.is_sqlite:
        # One SQLite call at a time in the process, and writers in line (dbkit/sqlite_gate.py).
        engine = create_async_engine(
            target.url(),
            echo=False,
            async_creator=sqlite_gate.connector(
                target.path, timeout=SQLITE_BUSY_TIMEOUT_S
            ),
        )
        _tune_sqlite(engine.sync_engine)
        return engine
    common = {
        "echo": False,
        "pool_pre_ping": True,
        "pool_recycle": 1800,
        "pool_size": 5,
        "max_overflow": 10,
        "pool_timeout": 30,
    }
    if target.engine == "postgresql":
        engine = create_async_engine(
            target.url(),
            connect_args={"ssl": _PG_SSL[target.ssl], "timeout": 10},
            **common,
        )

        @event.listens_for(engine.sync_engine, "do_connect")
        def _name(_dialect, _rec, _cargs, cparams):  # noqa: ANN001
            cparams["server_settings"] = {"application_name": application_name(role)}

        return engine
    engine = create_async_engine(
        target.url(),
        # Each statement sees what was committed before it, as on PostgreSQL; MySQL's default (REPEATABLE READ)
        # takes gap locks that make two writers wait on each other for rows neither touches.
        isolation_level="READ COMMITTED",
        connect_args={"ssl": _mysql_ssl(target.ssl), "connect_timeout": 10},
        **common,
    )
    # SQLAlchemy reads PyMySQL's ping() signature to decide whether to pass reconnect=False; PyMySQL 1.2 changed it,
    # and the aiomysql adapter then gets no argument (TypeError on every pre-ping). The adapter always takes one.
    engine.dialect._send_false_to_ping = True
    return engine
