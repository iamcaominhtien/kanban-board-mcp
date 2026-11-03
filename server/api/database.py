"""App settings › Storage & backup › Database (design/screens/ai-databases.md B to E): which database the board uses,
a test of another one, and the move to it (check, copy, verify, switch), with an AI's help when a copy stops."""

import os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

import database
from dbkit import jobs, probe, targets
from dbkit.assist import AssistError

router = APIRouter(prefix="/database", tags=["database"])


class ConnectionBody(BaseModel):
    """A database to test or move to: the form's fields, or a connection string in `url`."""

    engine: str | None = None
    host: str | None = None
    port: int | None = None
    name: str | None = None
    user: str | None = None
    password: str | None = None
    ssl: str | None = None
    path: str | None = None
    url: str | None = None
    keep_password: bool = Field(
        default=False,
        description="Use the saved password of the database in use (Edit connection without typing it again)",
    )


def _target(body: ConnectionBody) -> targets.Target:
    data = body.model_dump(exclude_none=True)
    if (data.get("engine") or "") == "sqlite" and not data.get("path"):
        data["path"] = str(database.get_db_path())  # the file in the data folder
    try:
        target = targets.from_fields(data)
    except targets.TargetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if body.keep_password and not target.password:
        current = database.current_target()
        target = target.with_password(current.password)
    return target


def _raise(exc: jobs.JobError):
    raise HTTPException(
        status_code=exc.status,
        detail={"code": exc.code, "message": str(exc), **exc.info},
    ) from exc


async def _counts() -> dict:
    from models import AiMember, Project, Ticket

    async with database.async_session() as s:
        out = {}
        for key, model in (
            ("tickets", Ticket),
            ("projects", Project),
            ("ai_members", AiMember),
        ):
            out[key] = int(
                (await s.execute(select(func.count()).select_from(model))).scalar() or 0
            )
    return out


@router.get("")
async def get_database() -> dict:
    """The database in use: engine, where, how big, whether it answers, and what the card may offer."""
    target = database.current_target()
    sqlite_file = database.get_db_path()
    info = {
        "engine": target.engine,
        "label": target.label,
        "display": target.display(),
        "settings": target.public(),
        "source": database.target_source(),
        "locked": database.target_source() == "environment",
        "env_var": targets.ENV_URL,
        "password_store": targets.password_store(),
        "password_saved": bool(target.password),
        "data_folder": str(database.get_data_dir()),
        "sqlite_file": {
            "path": str(sqlite_file),
            "exists": sqlite_file.exists(),
            "size": sqlite_file.stat().st_size if sqlite_file.exists() else None,
            "modified": sqlite_file.stat().st_mtime if sqlite_file.exists() else None,
        },
        "unreachable": database.UNREACHABLE,
    }
    if database.UNREACHABLE is None:
        reach = await database.check_reachable()
        info["reachable"] = reach["ok"]
        info["latency_ms"] = reach.get("latency_ms")
        if reach["ok"]:
            info.update(await _counts())
            info.update(await _revision())
            try:
                info["tables"] = len(
                    [
                        t
                        for t in await _table_names()
                        if t not in ("alembic_version", "kanban_change")
                        and "_fts" not in t
                    ]
                )
            except Exception:  # noqa: BLE001 - the card still shows the rest
                info["tables"] = None
            if target.is_sqlite and sqlite_file.exists():
                info["size"] = sqlite_file.stat().st_size + _wal_size(sqlite_file)
            if not target.is_sqlite:
                report = await probe.test(target)
                info["version"] = report.version
                info["secure"] = report.secure
                info["other_apps"] = report.other_apps
            else:
                import sqlite3

                info["version"] = f"SQLite {sqlite3.sqlite_version}"
        info["unreachable"] = database.UNREACHABLE
    else:
        info["reachable"] = False
    job = await jobs.current()
    info["move"] = job.as_dict() if job else None
    return info


async def _revision() -> dict:
    try:
        async with database.engine.connect() as conn:
            state = await conn.run_sync(database.schema_state)
        head = database.head_revision()
        return {"revision": state["revision"], "at_head": state["revision"] == head}
    except Exception:  # noqa: BLE001 - the card still shows the rest
        return {"revision": None, "at_head": None}


def _wal_size(path: Path) -> int:
    wal = Path(str(path) + "-wal")
    return wal.stat().st_size if wal.exists() else 0


async def _table_names() -> list[str]:
    from sqlalchemy import inspect

    async with database.engine.connect() as conn:
        return await conn.run_sync(lambda c: inspect(c).get_table_names())


@router.get("/health")
async def get_health() -> dict:
    """Does the database answer now? (The reconnect screen asks every few seconds.)"""
    reach = await database.check_reachable()
    if reach["ok"] and database.UNREACHABLE is None:
        try:
            await database.init_db()
        except Exception:  # noqa: BLE001 - it answered; init problems show elsewhere
            pass
    return {**reach, "unreachable": database.UNREACHABLE, "retry_s": database.RETRY_S}


@router.post("/test")
async def post_test(body: ConnectionBody) -> dict:
    """Test a database: what the test found, line by line (nothing is changed)."""
    report = await probe.test(_target(body))
    return report.as_dict()


@router.post("/connection")
async def post_connection(body: ConnectionBody) -> dict:
    """Edit connection: the same server database reached another way (a new password, host or SSL setting). It must
    hold this board; the data is not copied."""
    target = _target(body)
    report = await probe.test(target)
    if not report.ok or report.state != "board":
        raise HTTPException(
            status_code=422,
            detail={
                "code": "not_this_board",
                "message": "That database does not hold this board; use Move to another database to copy it.",
                "report": report.as_dict(),
            },
        )
    try:
        await database.use(target)
    except database.SchemaError as exc:
        raise HTTPException(status_code=423, detail=str(exc)) from exc
    return await get_database()


@router.post("/use-sqlite")
async def post_use_sqlite() -> dict:
    """Use the SQLite file in the data folder again, as it was when the board left it."""
    path = database.get_db_path()
    if not path.exists():
        raise HTTPException(
            status_code=404, detail="There is no SQLite file in the data folder."
        )
    try:
        await database.use(targets.Target("sqlite", path=str(path)))
    except database.SchemaError as exc:
        raise HTTPException(status_code=423, detail=str(exc)) from exc
    return await get_database()


# ---------------------------------------------------------------------------
# The move
# ---------------------------------------------------------------------------


@router.get("/move")
async def get_move() -> dict | None:
    """The move in progress (or one an interruption left)."""
    job = await jobs.current()
    return job.as_dict() if job else None


@router.post("/move/check")
async def post_check(body: ConnectionBody) -> dict:
    """Step 2: test the target again and read what will be copied. Nothing is written."""
    target = _target(body)
    try:
        job = await jobs.new(target)
        return await job.check()
    except jobs.JobError as exc:
        _raise(exc)
    except Exception as exc:  # noqa: BLE001 - a MoveError or a database error, said plainly
        from dbkit.move import MoveError, clean_error

        if isinstance(exc, MoveError):
            raise HTTPException(
                status_code=422, detail={"code": exc.code, "message": str(exc)}
            ) from exc
        message, _ = clean_error(exc)
        raise HTTPException(
            status_code=422, detail={"code": "check", "message": message}
        ) from exc


class StartBody(BaseModel):
    """Copy my data, or start empty; `empty_first` deletes what the target holds (after typing its name)."""

    mode: str = "copy"
    empty_first: bool = False
    confirm: str | None = None


@router.post("/move/start")
async def post_start(body: StartBody) -> dict:
    """Step 3: make the tables and copy (or leave the new database empty)."""
    job = await _job()
    if body.mode not in ("copy", "empty"):
        raise HTTPException(status_code=422, detail="mode is copy or empty")
    if body.empty_first:
        expected = job.target.name or Path(job.target.path).name
        if (body.confirm or "").strip() != expected:
            raise HTTPException(
                status_code=422,
                detail={"code": "confirm", "message": f"Type {expected} to confirm."},
            )
    try:
        await job.start(mode=body.mode, empty_first=body.empty_first)
    except jobs.JobError as exc:
        _raise(exc)
    return job.as_dict()


async def _job() -> jobs.Job:
    job = await jobs.current()
    if job is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "none", "message": "No move is in progress."},
        )
    return job


@router.post("/move/pause")
async def post_pause() -> dict:
    """Pause the copy at the next batch."""
    job = await _job()
    try:
        await job.pause()
    except jobs.JobError as exc:
        _raise(exc)
    return job.as_dict()


class ResumeBody(BaseModel):
    """Resume from a table (default: the one it stopped in)."""

    start_at: str | None = None
    restart: bool = False


@router.post("/move/resume")
async def post_resume(body: ResumeBody | None = None) -> dict:
    """Resume the copy (re-reading the table it stopped in from its start), or start over."""
    job = await _job()
    body = body or ResumeBody()
    try:
        if body.restart:
            job.resume_at = None
            if job.mover is not None:
                for t in job.mover.tables:
                    t.state, t.copied = "waiting", 0
            await job.resume(start_at=job.mover.tables[0].name if job.mover else None)
        else:
            await job.resume(start_at=body.start_at)
    except jobs.JobError as exc:
        _raise(exc)
    return job.as_dict()


@router.post("/move/cancel")
async def post_cancel() -> dict:
    """Cancel and clear the new database; your data stays where it is."""
    job = await _job()
    await job.cancel()
    return job.as_dict()


class AskBody(BaseModel):
    """Ask the AI about the stop (a follow-up question is optional)."""

    question: str | None = None


@router.post("/move/ask")
async def post_ask(body: AskBody | None = None) -> dict:
    """Ask an AI member what stopped the copy and what to change (it answers in the background)."""
    job = await _job()
    try:
        await job.ask_ai((body or AskBody()).question)
    except jobs.JobError as exc:
        _raise(exc)
    return job.as_dict()


class ApplyBody(BaseModel):
    """Statements to run on the new database (the AI's, or edited by the person)."""

    statements: list[str]


@router.post("/move/apply")
async def post_apply(body: ApplyBody) -> dict:
    """Apply the fix on the new database, resume the copy and check it again."""
    job = await _job()
    try:
        await job.apply(body.statements)
    except AssistError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "refused", "message": str(exc)}
        ) from exc
    except jobs.JobError as exc:
        _raise(exc)
    return job.as_dict()


@router.post("/move/switch")
async def post_switch() -> dict:
    """Switch the board to the new database now (no restart)."""
    job = await _job()
    try:
        await job.switch()
    except jobs.JobError as exc:
        _raise(exc)
    return {"move": job.as_dict(), "database": await get_database()}


@router.delete("/move")
async def delete_move() -> dict:
    """Close a finished move (Keep SQLite, switch later)."""
    try:
        await jobs.forget()
    except jobs.JobError as exc:
        _raise(exc)
    return {"ok": True}


@router.get("/command")
async def get_command(target: str | None = None) -> dict:
    """The script that runs the same copy on a server (design D3), for the database in use as the source."""
    src = database.current_target()
    if src.is_sqlite:
        src_url = f"sqlite:///{src.path}"
    else:
        src_url = f"{src.engine}://{src.user}@{src.host}:{src.port}/{src.name}"
    to = target or "postgresql://USER@HOST:5432/DATABASE"
    exe = (
        "kanban-db"
        if os.environ.get("KANBAN_PACKAGED")
        else "uv run python -m dbkit.cli"
    )
    return {
        "dry_run": f"{exe} migrate --from {src_url} --to {to} --dry-run",
        "run": f"{exe} migrate --from {src_url} --to {to} --verify",
        "password_env": targets.ENV_PASSWORD,
        "at": time.time(),
    }
