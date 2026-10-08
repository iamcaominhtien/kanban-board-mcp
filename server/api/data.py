import io
import logging
import shutil
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


router = APIRouter(prefix="/data", tags=["data"])


@router.get("/export")
async def export_data():
    """
    Stream a ZIP file containing kanban.db and the uploads/ directory.
    """
    db_path = db.get_db_path()
    uploads_dir = uploads_module.get_uploads_dir(create=False)

    # Flush all WAL data into the main DB file before reading it.
    # In WAL mode recent commits live in kanban.db-wal, not in kanban.db itself.
    # Without this checkpoint the exported ZIP contains a stale snapshot.
    async with db.engine.connect() as conn:
        await conn.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
        await conn.commit()

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
    MAX_UNCOMPRESSED = 2 * 1024 * 1024 * 1024  # 2 GB total uncompressed

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
            with zf.open("kanban.db") as src, incoming_db.open("wb") as dst:
                copied = 0
                while chunk := src.read(1024 * 1024):
                    copied += len(chunk)
                    if copied > MAX_UNCOMPRESSED:
                        raise HTTPException(
                            status_code=400, detail="ZIP content too large (max 2 GB)"
                        )
                    dst.write(chunk)
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

            # Replace uploads
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
