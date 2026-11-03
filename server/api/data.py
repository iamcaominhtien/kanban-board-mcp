import asyncio
import io
import logging
import shutil
import uuid
import sqlite3
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import text

import database as db
import uploads as uploads_module

logger = logging.getLogger(__name__)


def _remove_wal_files(db_path: Path) -> None:
    """Delete the -wal/-shm files that belong to db_path.

    They describe the *previous* database file. If they stay next to a replaced
    kanban.db, SQLite reads them as part of the new file and fails with
    "database disk image is malformed".
    """
    for suffix in ("-wal", "-shm"):
        Path(str(db_path) + suffix).unlink(missing_ok=True)


def _extract_db_member(zf: zipfile.ZipFile, dest: Path, max_bytes: int) -> None:
    """Copy kanban.db out of the ZIP into dest, refusing more than max_bytes."""
    with zf.open("kanban.db") as src, dest.open("wb") as dst:
        copied = 0
        while chunk := src.read(1024 * 1024):
            copied += len(chunk)
            if copied > max_bytes:
                raise HTTPException(
                    status_code=400, detail="ZIP content too large (max 2 GB)"
                )
            dst.write(chunk)


def _check_sqlite_file(path: Path) -> str | None:
    """Return None if path is a healthy SQLite database, else a short reason."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            row = conn.execute("PRAGMA quick_check").fetchone()
        finally:
            conn.close()
    except sqlite3.DatabaseError as exc:
        return str(exc)
    return None if row and row[0] == "ok" else (row[0] if row else "empty result")


def _scratch_db(name: str) -> Path:
    folder = db.get_data_dir() / ".db-tmp"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{name}-{uuid.uuid4().hex[:8]}.db"
    return path


async def _portable_copy() -> Path:
    """A SQLite file with every table of the database in use (export from PostgreSQL or MySQL)."""
    from dbkit import targets
    from dbkit.move import Mover

    path = _scratch_db("export")
    async with Mover(
        db.current_target(), targets.Target("sqlite", path=str(path))
    ) as m:
        await m.plan()
        await m.prepare_target()
        await m.copy()
    return path


async def _upgrade_file(path: Path) -> None:
    """Bring an imported SQLite file to the newest migration (an export from an older version)."""
    from dbkit import targets

    engine = targets.make_engine(targets.Target("sqlite", path=str(path)))
    try:
        async with engine.begin() as conn:
            await conn.run_sync(db._run_upgrade, db.alembic_config())
    finally:
        await engine.dispose()


async def _import_into_server(incoming: Path) -> None:
    """Replace the data of the PostgreSQL or MySQL database in use with the imported file. What was there is copied
    to a SQLite file first and put back if anything fails."""
    from dbkit import targets
    from dbkit.move import Mover

    current = db.current_target()
    await _upgrade_file(incoming)
    backup = _scratch_db("before-import")
    async with Mover(current, targets.Target("sqlite", path=str(backup))) as m:
        await m.plan()
        await m.prepare_target()
        await m.copy()
    await db.engine.dispose()
    try:
        async with Mover(targets.Target("sqlite", path=str(incoming)), current) as m:
            await m.plan()
            await m.prepare_target(empty_first=True)
            await m.copy()
    except Exception:
        logger.exception(
            "Import into %s failed; putting the previous data back", current.label
        )
        async with Mover(targets.Target("sqlite", path=str(backup)), current) as m:
            await m.plan()
            await m.prepare_target(empty_first=True)
            await m.copy()
        raise
    finally:
        await db.reinit_db()
        for p in (backup, incoming):
            for suffix in ("", "-wal", "-shm"):
                Path(str(p) + suffix).unlink(missing_ok=True)


MAX_UNCOMPRESSED = 2 * 1024 * 1024 * 1024  # 2 GB total uncompressed


def _replace_uploads(
    zf: zipfile.ZipFile, names: list[str], uploads_dir: Path, total_written: int
) -> int:
    """Swap in the ZIP's uploads/ folder; returns how many files were written."""
    import_count = 0
    upload_files = [
        n for n in names if n.startswith("uploads/") and not n.endswith("/")
    ]
    resolved_uploads_dir = uploads_dir.resolve()
    if upload_files:
        if uploads_dir.exists():
            shutil.rmtree(str(uploads_dir))
        uploads_dir.mkdir(parents=True, exist_ok=True)
        for name in upload_files:
            rel = name[len("uploads/") :]
            if not rel:
                continue
            # Use basename only — strips any directory components from the
            # user-supplied ZIP entry name, preventing path traversal.
            safe_name = Path(rel).name
            if not safe_name or safe_name in (".", ".."):
                logger.warning("Skipped invalid ZIP entry: %s", name)
                continue
            # ZIP Slip protection: resolve and assert containment
            dest = (uploads_dir / safe_name).resolve()
            if not dest.is_relative_to(resolved_uploads_dir):
                logger.warning("Skipped malicious ZIP entry: %s", name)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(name) as src:
                data = src.read(MAX_UNCOMPRESSED - total_written + 1)
                if total_written + len(data) > MAX_UNCOMPRESSED:
                    raise HTTPException(
                        status_code=400,
                        detail="ZIP content too large (max 2 GB)",
                    )
                total_written += len(data)
                dest.write_bytes(data)
            import_count += 1

    return import_count


router = APIRouter(prefix="/data", tags=["data"])


@router.get("/export")
async def export_data():
    """
    Stream a ZIP file containing kanban.db and the uploads/ directory.
    """
    db_path = db.get_db_path()
    uploads_dir = uploads_module.get_uploads_dir(create=False)
    portable: Path | None = None

    if db.is_sqlite():
        # Flush all WAL data into the main DB file before reading it.
        # In WAL mode recent commits live in kanban.db-wal, not in kanban.db itself.
        # Without this checkpoint the exported ZIP contains a stale snapshot.
        async with db.engine.connect() as conn:
            await conn.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
            await conn.commit()
    else:
        # PostgreSQL or MySQL: the ZIP holds the same portable file, a SQLite copy of every table made by the copy
        # code that moves between databases, so one export loads into any engine (and into older versions of the app)
        portable = await _portable_copy()
        db_path = portable

    def generate_zip():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            if db_path.exists():
                zf.write(db_path, "kanban.db")
            if uploads_dir.exists():
                for file in uploads_dir.rglob("*"):
                    if file.is_file():
                        arcname = "uploads/" + str(file.relative_to(uploads_dir))
                        zf.write(file, arcname)
        buf.seek(0)
        if portable is not None:
            for suffix in ("", "-wal", "-shm"):
                Path(str(portable) + suffix).unlink(missing_ok=True)
        yield buf.read()

    return StreamingResponse(
        generate_zip(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=kanban-export.zip"},
    )


@router.post("/import")
async def import_data(file: UploadFile = File(...)):
    """
    Accept a ZIP file (from export), fully replace kanban.db and uploads/,
    then reinit the DB engine.
    """
    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="Only .zip files are accepted")

    MAX_UPLOAD_BYTES = 500 * 1024 * 1024  # 500 MB raw cap
    MAX_FILES = 50_000

    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 500 MB)")
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        with zipfile.ZipFile(io.BytesIO(content)):
            pass
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Invalid ZIP file")

    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        if len(zf.namelist()) > MAX_FILES:
            raise HTTPException(status_code=400, detail="Too many files in ZIP")

        names = zf.namelist()
        if "kanban.db" not in names:
            raise HTTPException(status_code=400, detail="ZIP must contain kanban.db")

        db_path = db.get_db_path()
        uploads_dir = uploads_module.get_uploads_dir(create=True)

        # Read the uploaded database into a temp file first and check it, so a broken
        # backup is rejected before anything on disk is touched.
        incoming_db = db_path.with_suffix(".import")
        try:
            await asyncio.to_thread(
                _extract_db_member, zf, incoming_db, MAX_UNCOMPRESSED
            )
            problem = _check_sqlite_file(incoming_db)
            _remove_wal_files(incoming_db)  # the check can leave -wal/-shm files behind
        except Exception:
            incoming_db.unlink(missing_ok=True)
            raise
        if problem is not None:
            incoming_db.unlink(missing_ok=True)
            raise HTTPException(
                status_code=400,
                detail=f"kanban.db in the ZIP is not a valid database: {problem}",
            )

        if not db.is_sqlite():
            # PostgreSQL or MySQL: the file's tables replace the server's, with a copy of what was there to fall
            # back on (the copy code that moves between databases)
            staged = _scratch_db("import")
            incoming_db.replace(staged)
            try:
                await _import_into_server(staged)
            except Exception as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"Import failed: {exc}. Previous data restored.",
                ) from exc
            count = _replace_uploads(
                zf, names, uploads_dir, staged.stat().st_size if staged.exists() else 0
            )
            return {"status": "ok", "imported_uploads": count}

        # Backup DB before any destructive operation. Fold the WAL into the main file
        # first, otherwise recent changes would be missing from the backup.
        backup_db = db_path.with_suffix(".bak")
        if db_path.exists():
            try:
                async with db.engine.connect() as conn:
                    await conn.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
                    await conn.commit()
            except Exception:
                logger.exception("WAL checkpoint before import failed; continuing")
            shutil.copy2(str(db_path), str(backup_db))

        import_count = 0
        try:
            # Dispose current engine before replacing the DB file
            await db.engine.dispose()

            # Swap in the checked database, together with removing the old WAL files
            total_written = incoming_db.stat().st_size
            if total_written > MAX_UNCOMPRESSED:
                raise HTTPException(
                    status_code=400, detail="ZIP content too large (max 2 GB)"
                )
            _remove_wal_files(db_path)
            incoming_db.replace(db_path)

            import_count = _replace_uploads(zf, names, uploads_dir, total_written)

            # Reinit DB with same path
            await db.reinit_db(db_path)
            backup_db.unlink(missing_ok=True)

        except Exception as exc:
            # Restore DB from backup
            incoming_db.unlink(missing_ok=True)
            if backup_db.exists():
                try:
                    _remove_wal_files(db_path)
                    shutil.copy2(str(backup_db), str(db_path))
                    backup_db.unlink(missing_ok=True)
                except Exception:
                    logger.exception("Failed to restore DB backup after import error")
            try:
                await db.reinit_db(db_path)
            except Exception:
                logger.exception("Failed to reinit DB after import rollback")
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(
                status_code=500,
                detail=f"Import failed: {exc}. Previous data restored.",
            )

    return {"status": "ok", "imported_uploads": import_count}
