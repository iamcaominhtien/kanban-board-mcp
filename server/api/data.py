import io
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

import database as db
import uploads as uploads_module

router = APIRouter(prefix="/data", tags=["data"])


@router.get("/export")
async def export_data():
    """
    Stream a ZIP file containing kanban.db and the uploads/ directory.
    """
    db_path = Path(db.DATABASE_URL.replace("sqlite+aiosqlite:///", ""))
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

    content = await file.read()
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Invalid ZIP file")

    names = zf.namelist()
    if "kanban.db" not in names:
        raise HTTPException(status_code=400, detail="ZIP must contain kanban.db")

    db_path = Path(db.DATABASE_URL.replace("sqlite+aiosqlite:///", ""))
    uploads_dir = uploads_module.get_uploads_dir(create=True)

    # Dispose current engine before replacing the DB file
    await db.engine.dispose()

    # Replace DB
    db_path.write_bytes(zf.read("kanban.db"))

    # Replace uploads
    upload_files = [
        n for n in names if n.startswith("uploads/") and not n.endswith("/")
    ]
    if upload_files:
        if uploads_dir.exists():
            shutil.rmtree(str(uploads_dir))
        uploads_dir.mkdir(parents=True, exist_ok=True)
        for name in upload_files:
            rel = name[len("uploads/") :]
            if not rel:
                continue
            dest = uploads_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(name))

    # Reinit DB with same path
    await db.reinit_db(db_path)

    return {"status": "ok", "imported_uploads": len(upload_files)}
