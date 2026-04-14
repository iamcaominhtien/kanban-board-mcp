import io
import logging
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

import database as db
import uploads as uploads_module

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/data", tags=["data"])


@router.get("/export")
async def export_data():
    """
    Stream a ZIP file containing kanban.db and the uploads/ directory.
    """
    db_path = db.get_db_path()
    uploads_dir = uploads_module.get_uploads_dir(create=False)

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

        # Backup DB before any destructive operation
        backup_db = db_path.with_suffix(".bak")
        if db_path.exists():
            shutil.copy2(str(db_path), str(backup_db))

        import_count = 0
        try:
            # Dispose current engine before replacing the DB file
            await db.engine.dispose()

            # Write kanban.db, tracking actual bytes extracted to enforce the limit
            total_written = 0
            with zf.open("kanban.db") as src:
                db_data = src.read(MAX_UNCOMPRESSED - total_written + 1)
                if total_written + len(db_data) > MAX_UNCOMPRESSED:
                    raise HTTPException(
                        status_code=400, detail="ZIP content too large (max 2 GB)"
                    )
                total_written += len(db_data)
                db_path.write_bytes(db_data)

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
            if backup_db.exists():
                try:
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
