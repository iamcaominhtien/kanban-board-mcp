"""Test a database before anything is written to it: can the board reach it, sign in, create tables, store every
character, and is it empty? Each finding says what was found and, for a problem, how to fix it, with the statement
ready to copy (design C2, C3, E2).

Levels: "ok" (green), "warn" (amber: you may go on), "error" (red: Next stays off), "info".
A test never changes the database: the table it creates to check the rights is dropped again (and on PostgreSQL it
is made inside a transaction that is rolled back).
"""

import asyncio
import os
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from sqlalchemy import text

from . import targets

PG_MIN = 140000
MYSQL_MIN = (8, 0)
MARIADB_MIN = (10, 6)
SQLITE_MIN = (3, 35)  # UPDATE … RETURNING
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}


@dataclass
class Finding:
    """One line of "What the test found"."""

    key: str
    level: str  # ok | warn | error | info
    title: str
    detail: str = ""
    fix: str = ""  # a statement to copy
    fix_label: str = ""


@dataclass
class Report:
    """What a test found, and a summary the next steps use."""

    target: dict
    findings: list[Finding] = field(default_factory=list)
    reached: bool = False
    version: str = ""
    latency_ms: int | None = None
    state: str = "unknown"  # empty | board | foreign | newer | unknown
    tables: int = 0
    revision: str | None = None
    tickets: int | None = None  # tickets of a board already there
    secure: bool | None = None
    other_apps: int = 0

    @property
    def ok(self) -> bool:
        """No red line: the person may go on."""
        return self.reached and not any(f.level == "error" for f in self.findings)

    def add(self, *args, **kwargs) -> Finding:
        """Add a finding."""
        f = Finding(*args, **kwargs)
        self.findings.append(f)
        return f

    def as_dict(self) -> dict:
        """For the API."""
        out = asdict(self)
        out["ok"] = self.ok
        return out


def _version_tuple(text_version: str) -> tuple[int, ...]:
    nums = []
    for part in text_version.split("-")[0].split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        if not digits:
            break
        nums.append(int(digits))
    return tuple(nums)


def _classify(exc: BaseException, target: targets.Target) -> tuple[str, str, str, str]:
    """(key, title, detail, fix) for a connection that failed."""
    raw = str(getattr(exc, "orig", None) or exc)
    msg = raw.lower()
    where = f"{target.host}:{target.port}"
    name = type(getattr(exc, "orig", None) or exc).__name__
    if (
        "password authentication failed" in msg
        or "access denied" in msg
        or name
        in (
            "InvalidPasswordError",
            "InvalidAuthorizationSpecificationError",
        )
    ):
        return (
            "signin",
            f"Cannot sign in · as {target.user or '(no user)'}",
            "The server refused the user name or the password. Check both; the password is case-sensitive.",
            "",
        )
    if ("does not exist" in msg and "database" in msg) or "unknown database" in msg:
        if target.engine == "postgresql":
            fix = f'CREATE DATABASE "{target.name}" OWNER "{target.user}" ENCODING \'UTF8\';'
        else:
            fix = (
                f"CREATE DATABASE `{target.name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;\n"
                f"GRANT ALL PRIVILEGES ON `{target.name}`.* TO '{target.user}'@'%';"
            )
        return (
            "database",
            f"No database “{target.name}” on {where}",
            "Create it on the server (as an administrator), then test again.",
            fix,
        )
    if "ssl" in msg or "certificate" in msg or "tls" in msg:
        return (
            "ssl",
            "The secure connection failed",
            f"{raw.strip()[:300]} · Choose “Require” to encrypt without checking the certificate, or install the "
            "server’s certificate authority on this computer.",
            "",
        )
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or "timeout" in msg:
        return (
            "reach",
            f"No answer from {where}",
            "Nothing answered within 10 seconds: check the host name, the port and any firewall between "
            "this computer and the server.",
            "",
        )
    return (
        "reach",
        f"Cannot reach the server · {where}",
        f"{raw.strip()[:300]} · Check the host name and the port, and that the server is running and accepts "
        "connections from this computer.",
        "",
    )


async def _schema(conn, report: Report) -> None:
    import database

    state = await conn.run_sync(database.schema_state)
    report.state, report.tables, report.revision = (
        state["state"],
        state["tables"],
        state["revision"],
    )
    if state["state"] == "empty":
        report.add(
            "empty",
            "ok",
            "Database is empty · 0 tables, so a copy can go straight in",
        )
        return
    if state["state"] == "foreign":
        report.add(
            "empty",
            "warn",
            f"Not empty · {state['tables']} tables that are not a Kanban board",
            "The board will not write into a database that already holds something, because it cannot tell what "
            "is yours. Choose another database, or empty this one in the next step.",
        )
        return
    rev = state["revision"] or ""
    if rev and not database.known_revision(rev):
        report.state = "newer"
        report.add(
            "newer",
            "error",
            f"A newer database · made by a newer version of the app (migration {rev[:8]}…)",
            "Update the app first; the board will not touch it.",
        )
        return
    rows = None
    try:
        rows = int(
            (await conn.execute(text("SELECT COUNT(*) FROM ticket"))).scalar() or 0
        )
    except Exception:  # noqa: BLE001 - a partial board may not have the table yet
        rows = None
    report.tickets = rows
    report.add(
        "empty",
        "warn",
        f"Already holds a Kanban board · {state['tables']} tables"
        + (f", {rows:,} tickets" if rows is not None else ""),
        "Use it as it is (Use this database), or empty it in the next step to copy your data in.",
    )


async def _probe_sqlite(target: targets.Target, report: Report) -> None:
    path = Path(target.path)
    report.target = target.public()
    report.version = f"SQLite {sqlite3.sqlite_version}"
    if _version_tuple(sqlite3.sqlite_version) < SQLITE_MIN:
        report.add(
            "version",
            "error",
            f"SQLite {sqlite3.sqlite_version} is too old (needs 3.35 or newer)",
        )
    folder = path.parent
    if not folder.exists():
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            report.add("reach", "error", f"Cannot create the folder {folder}", str(exc))
            return
    if not os.access(folder, os.W_OK):
        report.add("reach", "error", f"Cannot write to {folder}")
        return
    report.reached = True
    report.latency_ms = 0
    report.secure = True
    report.add("reach", "ok", f"A file on this computer · {path}")
    if not path.exists() or path.stat().st_size == 0:
        report.state = "empty"
        report.add("empty", "ok", "No file yet · the board will create it")
        return
    probe_target = targets.Target("sqlite", path=str(path))
    engine = targets.make_engine(probe_target)
    try:
        async with engine.connect() as conn:
            check = (await conn.execute(text("PRAGMA quick_check"))).scalar()
            if check != "ok":
                report.add("integrity", "error", "The file is damaged", str(check))
                return
            await _schema(conn, report)
    except Exception as exc:  # noqa: BLE001 - not a database file
        report.add("integrity", "error", "This file is not a SQLite database", str(exc))
    finally:
        await engine.dispose()


async def _can_create_pg(conn, target, report: Report) -> None:
    name = f"kanban_probe_{uuid.uuid4().hex[:8]}"
    trans = (
        await conn.begin_nested()
    )  # a savepoint in the transaction the SHOW queries began
    try:
        await conn.execute(text(f"CREATE TABLE {name} (id INTEGER PRIMARY KEY)"))
        report.add(
            "create",
            "ok",
            "Can create tables · tried a table in a transaction and rolled it back",
        )
    except Exception:  # noqa: BLE001 - no rights
        report.add(
            "create",
            "error",
            f"Cannot create tables · {target.user} has no CREATE right on the schema",
            "Run this as the owner of the database, or use a user that owns it.",
            fix=f'GRANT CREATE ON SCHEMA public TO "{target.user}";',
            fix_label="Copy the statement",
        )
    finally:
        await trans.rollback()


async def _probe_pg(conn, target: targets.Target, report: Report) -> None:
    num = int((await conn.execute(text("SHOW server_version_num"))).scalar() or 0)
    ver = str((await conn.execute(text("SHOW server_version"))).scalar() or "")
    report.version = f"PostgreSQL {ver.split(' ')[0]}"
    if num < PG_MIN:
        report.add(
            "version",
            "error",
            f"Server too old · {report.version}. The board needs 14 or newer.",
            "Nothing can be done from here; upgrade the server.",
        )
    else:
        report.add("version", "ok", f"Version · {report.version} (needs 14 or newer)")
    enc = str((await conn.execute(text("SHOW server_encoding"))).scalar() or "")
    if enc.upper() not in ("UTF8", "UTF-8"):
        report.add(
            "encoding",
            "error",
            f"Encoding is {enc} · the board needs UTF8",
            "Create the database with UTF8; an existing database cannot change its encoding.",
            fix=f'CREATE DATABASE "{target.name}_utf8" OWNER "{target.user}" ENCODING \'UTF8\' TEMPLATE template0;',
            fix_label="Copy the statement",
        )
    else:
        report.add("encoding", "ok", "Encoding · UTF8")
    await _can_create_pg(conn, target, report)
    try:
        ssl_on = (
            await conn.execute(
                text("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
            )
        ).scalar()
    except Exception:  # noqa: BLE001 - the view may be hidden
        ssl_on = None
    report.secure = bool(ssl_on) if ssl_on is not None else None
    try:
        others = (
            await conn.execute(
                text(
                    "SELECT COUNT(DISTINCT application_name) FROM pg_stat_activity "
                    "WHERE datname = current_database() AND application_name LIKE :p "
                    "AND application_name NOT LIKE :me"
                ),
                {
                    "p": f"{targets.APP_NAME_PREFIX} app %",
                    "me": f"%{targets.PROCESS_TOKEN[:8]}",
                },
            )
        ).scalar()
        report.other_apps = int(others or 0)
    except Exception:  # noqa: BLE001 - not allowed to read it
        report.other_apps = 0


async def _probe_mysql(conn, target: targets.Target, report: Report) -> None:
    ver = str((await conn.execute(text("SELECT VERSION()"))).scalar() or "")
    maria = "mariadb" in ver.lower()
    nums = _version_tuple(ver)
    label = "MariaDB" if maria else "MySQL"
    report.version = f"{label} {'.'.join(str(n) for n in nums[:3])}"
    need = MARIADB_MIN if maria else MYSQL_MIN
    if nums[:2] < need:
        report.add(
            "version",
            "error",
            f"Server too old · {report.version}. The board needs {label} {'.'.join(map(str, need))} or newer.",
            "Nothing can be done from here; upgrade the server.",
        )
    else:
        report.add(
            "version",
            "ok",
            f"Version · {report.version} (needs {'.'.join(map(str, need))} or newer)",
        )
    charset, collation = (
        await conn.execute(
            text("SELECT @@character_set_database, @@collation_database")
        )
    ).one()
    if str(charset).lower() != "utf8mb4":
        report.add(
            "charset",
            "warn",
            f"Character set is {charset} · the board needs utf8mb4, or emoji and non-Latin text will be damaged.",
            "The board makes its own tables in utf8mb4 either way; set it on the database so anything else made "
            "there is too.",
            fix=f"ALTER DATABASE `{target.name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;",
            fix_label="Copy the statement",
        )
    else:
        report.add("charset", "ok", f"Character set · utf8mb4 ({collation})")
    name = f"kanban_probe_{uuid.uuid4().hex[:8]}"
    try:
        await conn.execute(text(f"CREATE TABLE `{name}` (id INT PRIMARY KEY)"))
        await conn.execute(text(f"DROP TABLE `{name}`"))
        report.add(
            "create",
            "ok",
            "Can create tables · created a test table and dropped it again",
        )
    except Exception:  # noqa: BLE001 - no rights
        report.add(
            "create",
            "error",
            f"Cannot create tables · {target.user} has no CREATE privilege on {target.name}.",
            "Run this as an administrator, then test again.",
            fix=(
                "GRANT CREATE, ALTER, DROP, INDEX, SELECT, INSERT, UPDATE, DELETE, REFERENCES "
                f"ON `{target.name}`.* TO '{target.user}'@'%';"
            ),
            fix_label="Copy the statement",
        )
    try:
        cipher = (
            await conn.execute(text("SHOW SESSION STATUS LIKE 'Ssl_cipher'"))
        ).one()
        report.secure = bool(cipher[1])
    except Exception:  # noqa: BLE001
        report.secure = None


async def test(target: targets.Target) -> Report:
    """Test `target` and say what was found. Never raises for a database problem: the report says it."""
    report = Report(target=target.public())
    if target.is_sqlite:
        await _probe_sqlite(target, report)
        return report
    engine = targets.make_engine(target, role="probe")
    started = time.monotonic()
    try:
        try:
            conn = engine.connect()
            await asyncio.wait_for(conn.start(), 12)
        except Exception as exc:  # noqa: BLE001 - every way a connection fails
            key, title, detail, fix = _classify(exc, target)
            if key in ("signin", "database"):
                report.add(
                    "reach",
                    "ok",
                    f"Reached the server · {target.host}:{target.port}",
                )
            report.add(
                key,
                "error",
                title,
                detail,
                fix=fix,
                fix_label="Copy the statement" if fix else "",
            )
            report.reached = False
            return report
        report.latency_ms = int((time.monotonic() - started) * 1000)
        report.reached = True
        try:
            report.add(
                "reach",
                "ok",
                f"Reached the server · {target.host}:{target.port} · {report.latency_ms} ms",
            )
            report.add("signin", "ok", f"Signed in · as {target.user}")
            if target.engine == "postgresql":
                await _probe_pg(conn, target, report)
            else:
                await _probe_mysql(conn, target, report)
            if report.secure is False:
                local = target.host.lower() in LOCAL_HOSTS
                report.add(
                    "ssl",
                    "info" if local else "warn",
                    "No secure connection · this connection is not encrypted",
                    "Fine on the same computer, not across a network: choose Require or Verify the server.",
                )
            elif report.secure:
                report.add("ssl", "ok", "Secure connection · encrypted (TLS)")
            await _schema(conn, report)
            if report.other_apps:
                report.add(
                    "others",
                    "info",
                    f"Another board is connected · {report.other_apps} other app(s) use this database",
                    "Several apps may share one database; live updates between them can take a moment.",
                )
        finally:
            await conn.close()
    finally:
        await engine.dispose()
    return report
