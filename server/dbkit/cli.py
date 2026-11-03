"""kanban-db: move the board's data between SQLite, PostgreSQL and MySQL/MariaDB from a terminal (design D3).

    kanban-db test postgresql://kanban@db.internal/kanban
    kanban-db migrate --from sqlite:///~/kanban-data/kanban.db --to postgresql://kanban@db.internal/kanban --dry-run
    kanban-db migrate --from sqlite:///~/kanban-data/kanban.db --to postgresql://kanban@db.internal/kanban --verify
    kanban-db use postgresql://kanban@db.internal/kanban

The same copy code as App settings › Storage & backup. KANBAN_DB_PASSWORD gives the target's password, so it is not
in your shell history (KANBAN_DB_FROM_PASSWORD the source's).

Exit codes: 0 done · 1 verify failed · 2 cannot connect · 3 target not empty · 4 stopped (resume it).
"""

import argparse
import asyncio
import os
import sys
import time

from . import probe, targets
from .move import CopyStopped, Mover, MoveError, summary_line

EXIT_OK, EXIT_VERIFY, EXIT_CONNECT, EXIT_NOT_EMPTY, EXIT_STOPPED = 0, 1, 2, 3, 4
GREEN, AMBER, RED, DIM, RESET = "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[0m"


def _color(code: str, text: str) -> str:
    return f"{code}{text}{RESET}" if sys.stdout.isatty() else text


def _target(url: str, env: str) -> targets.Target:
    target = targets.from_url(url)
    if not target.is_sqlite and not target.password and os.environ.get(env):
        target = target.with_password(os.environ[env])
    return target


def _line(label: str, value: str) -> None:
    print(f"{label:<9}{value}")


async def _test(url: str) -> int:
    report = await probe.test(_target(url, targets.ENV_PASSWORD))
    marks = {
        "ok": _color(GREEN, "ok  "),
        "warn": _color(AMBER, "note"),
        "info": _color(DIM, "info"),
        "error": _color(RED, "FAIL"),
    }
    for f in report.findings:
        print(f"{marks[f.level]}  {f.title}")
        if f.level in ("warn", "error") and f.detail:
            print(f"      {f.detail}")
        if f.fix:
            for line in f.fix.splitlines():
                print(f"      {_color(DIM, line)}")
    return EXIT_OK if report.ok else EXIT_CONNECT


async def _first_unfinished(m: Mover) -> str | None:
    """The table an interrupted copy stopped in: tables are copied in order and each one completely or not at all."""
    from sqlalchemy import func, select

    from .move import app_tables

    async with m.dst.connect() as conn:
        for t, state in zip(app_tables(), m.tables):
            n = int(
                (await conn.execute(select(func.count()).select_from(t))).scalar() or 0
            )
            if n != state.rows:
                return t.name
    return None


async def _migrate(args) -> int:
    source = _target(args.source, "KANBAN_DB_FROM_PASSWORD")
    target = _target(args.target, targets.ENV_PASSWORD)
    report = await probe.test(target)
    if not report.ok:
        for f in report.findings:
            if f.level == "error":
                print(_color(RED, f"FAIL  {f.title}"))
                if f.fix:
                    print(f"      {f.fix}")
        return EXIT_CONNECT
    started = time.monotonic()
    last = {"t": 0.0}

    def progress(event: dict) -> None:
        if event["type"] == "table_done":
            state = next(s for s in m.tables if s.name == event["table"])
            print(f"{event['table']:<26}{state.rows:,} / {state.rows:,}")
        elif (
            event["type"] == "rows"
            and sys.stdout.isatty()
            and time.monotonic() - last["t"] > 0.5
        ):
            last["t"] = time.monotonic()
            print(
                f"{event['table']:<26}{event['copied']:,} / {event['rows']:,}",
                end="\r",
                flush=True,
            )

    try:
        m = Mover(source, target, on_progress=progress)
    except MoveError as exc:
        print(_color(RED, str(exc)))
        return EXIT_CONNECT
    async with m:
        try:
            plan = await m.plan()
        except MoveError as exc:
            print(_color(RED, str(exc)))
            return EXIT_CONNECT
        _line("Source", f"{plan.source['label']}, {summary_line(plan)}, schema at head")
        _line("Target", f"{report.version}, {report.state}")
        if report.state != "empty" and not (args.resume or args.empty_first):
            print(_color(RED, f"The target is not empty ({report.tables} tables)."))
            print(
                "Pass --empty-first to delete what it holds, or --resume to go on with an interrupted copy."
            )
            return EXIT_NOT_EMPTY
        print(f"{_color(GREEN, 'ok')}  target can create tables")
        print(
            f"{_color(GREEN, 'ok')}  copy order resolved from foreign keys ({len(plan.tables)} tables)"
        )
        for p in plan.problems:
            print(f"{_color(AMBER, 'note')}  {p['title']}")
        for n in plan.notes:
            print(f"{_color(DIM, 'note')}  {n['title']}")
        if args.dry_run:
            print("Dry run: nothing was written.  Exit 0")
            return EXIT_OK
        if args.empty_first and report.state != "empty":
            name = target.name or target.path
            typed = (
                args.yes_empty
                or input(f"Type {name} to delete every table in it: ").strip()
            )
            if typed != name:
                print("Not confirmed; nothing was written.")
                return EXIT_NOT_EMPTY
        start_at = None
        try:
            await m.prepare_target(empty_first=args.empty_first, resume=args.resume)
            if args.resume:
                start_at = await _first_unfinished(m)
                if start_at:
                    print(f"Resuming from {start_at}")
            await m.copy(start_at=start_at)
        except MoveError as exc:
            print(_color(RED, str(exc)))
            return EXIT_NOT_EMPTY if exc.code == "target_not_empty" else EXIT_CONNECT
        except CopyStopped as stopped:
            s = stopped.stop
            print()
            print(
                _color(
                    RED,
                    f"The copy stopped at table {s.table}, row {s.row:,} of {s.total:,}.",
                )
            )
            print(f"error      {s.error}")
            if s.column:
                print(
                    f"column     {s.table}.{s.column}  ({s.source_type} → {s.target_type})"
                )
            if s.value_length is not None:
                print(f"value      {s.value_length:,} characters")
            print(
                f"{s.tables_done} of {s.tables_total} tables are done. Fix the target, then run again with --resume."
            )
            return EXIT_STOPPED
        took = time.monotonic() - started
        rows = sum(s.rows for s in m.tables)
        print(
            f"copied    {len(m.tables)} tables, {rows:,} rows, {int(took // 60)} min {int(took % 60)} s"
        )
        if args.verify:
            result = await m.verify()
            for c in result["checks"]:
                print(
                    f"{_color(GREEN, 'ok') if c['ok'] else _color(RED, 'FAIL')}  {c['title']}"
                )
            if not result["ok"]:
                return EXIT_VERIFY
            print("verified  counts, samples, links, counters")
    shown = (
        target.display()
        if target.is_sqlite
        else f"{target.engine}://{target.user}@{target.host}/{target.name}"
    )
    print(
        f'Next: point the app at it with "kanban-db use {shown}" or from Settings.  Exit 0'
    )
    return EXIT_OK


async def _use(url: str) -> int:
    target = _target(url, targets.ENV_PASSWORD)
    report = await probe.test(target)
    if not report.ok:
        print(_color(RED, "The database did not pass the test:"))
        for f in report.findings:
            if f.level == "error":
                print(f"  {f.title}")
        return EXIT_CONNECT
    if report.state not in ("board", "empty"):
        print(_color(RED, "That database holds something that is not a Kanban board."))
        return EXIT_NOT_EMPTY
    targets.save_choice(target)
    print(f"The app now uses {target.label} at {target.display()}.")
    print(
        "A running board and its MCP processes switch within a few seconds; nothing needs a restart."
    )
    if os.environ.get(targets.ENV_URL):
        print(
            _color(
                AMBER,
                f"Note: {targets.ENV_URL} is set here and wins over this setting.",
            )
        )
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    """Run the command line."""
    parser = argparse.ArgumentParser(
        prog="kanban-db", description=__doc__.split("\n\n")[0]
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser(
        "test", help="Test a database: reach, sign in, version, rights, empty?"
    )
    t.add_argument("url")
    mig = sub.add_parser("migrate", help="Copy the board from one database to another")
    mig.add_argument(
        "--from", dest="source", required=True, help="The database to read"
    )
    mig.add_argument(
        "--to", dest="target", required=True, help="The database to write (empty)"
    )
    mig.add_argument(
        "--dry-run",
        action="store_true",
        help="Check both ends and print the plan; write nothing",
    )
    mig.add_argument(
        "--verify",
        action="store_true",
        help="Compare counts, samples, links and counters after",
    )
    mig.add_argument(
        "--resume", action="store_true", help="Continue an interrupted copy"
    )
    mig.add_argument(
        "--empty-first", action="store_true", help="Delete what the target holds first"
    )
    mig.add_argument(
        "--yes-empty", metavar="NAME", help="Confirm --empty-first without a prompt"
    )
    use = sub.add_parser(
        "use", help="Point the app at a database (saved in ~/.kanban-board/config.json)"
    )
    use.add_argument("url")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "test":
            return asyncio.run(_test(args.url))
        if args.cmd == "migrate":
            return asyncio.run(_migrate(args))
        return asyncio.run(_use(args.url))
    except targets.TargetError as exc:
        print(_color(RED, str(exc)))
        return EXIT_CONNECT
    except KeyboardInterrupt:
        print("\nStopped. Run again with --resume to go on.")
        return EXIT_STOPPED


if __name__ == "__main__":
    sys.exit(main())
