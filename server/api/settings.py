import logging
import os
import shutil
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

import config as app_config
import database as db
import uploads as uploads_module

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


class DataPathRequest(BaseModel):
    path: str  # absolute path to new data folder


@router.get("")
async def get_settings():
    """Return current data folder and uploads folder paths."""
    db_path = db.get_db_path()
    uploads_dir = uploads_module.get_uploads_dir(create=False)
    return {
        "db_path": str(db_path),
        "data_folder": str(db_path.parent),
        "uploads_dir": str(uploads_dir),
    }


@router.post("/data-path")
async def set_data_path(req: DataPathRequest):
    """
    Move kanban.db and uploads/ to a new folder.
    1. Resolve and validate the path is absolute.
    2. Move kanban.db to new_folder/kanban.db.
    3. Move uploads/ to new_folder/uploads/.
    4. Persist new folder to config.
    5. Reinit DB engine.
    """
    from fastapi import HTTPException

    raw = req.path.strip()
    if not raw or not Path(raw).is_absolute():
        raise HTTPException(status_code=400, detail="Path must be absolute")
    new_folder = Path(raw).resolve()

    # Restrict to within the user's home directory to prevent path traversal
    home = Path.home().resolve()
    if not new_folder.is_relative_to(home):
        raise HTTPException(
            status_code=400,
            detail="Data folder must be within your home directory",
        )

    new_folder.mkdir(parents=True, exist_ok=True)

    old_db_path = db.get_db_path()
    new_db_check = new_folder / "kanban.db"
    current_db_check = old_db_path
    if (
        new_db_check.exists()
        and new_db_check.stat().st_size > 0
        and current_db_check != new_db_check
    ):
        raise HTTPException(
            status_code=409,
            detail=f"A database already exists at {new_db_check}. Remove it first or choose a different folder.",
        )
    old_uploads = uploads_module.get_uploads_dir(create=False)
    old_config_folder = app_config.get_data_folder()

    current_db = old_db_path
    current_uploads = old_uploads

    new_db = new_folder / "kanban.db"
    new_uploads = new_folder / "uploads"

    try:
        # Move DB file
        if current_db.exists() and current_db != new_db:
            shutil.move(str(current_db), str(new_db))

        # Move uploads dir
        if current_uploads.exists() and current_uploads != new_uploads:
            if new_uploads.exists():
                for item in current_uploads.iterdir():
                    shutil.move(str(item), str(new_uploads / item.name))
                shutil.rmtree(str(current_uploads), ignore_errors=True)
            else:
                shutil.move(str(current_uploads), str(new_uploads))

        # Update KANBAN_UPLOADS_DIR env var in process
        os.environ[uploads_module.UPLOADS_DIR_ENV_VAR] = str(new_uploads)

        # Persist config
        app_config.set_data_folder(new_folder)

        # Reinit DB to point to new location
        await db.reinit_db(new_db)

    except Exception:
        # Best-effort rollback
        try:
            if new_db.exists() and not old_db_path.exists():
                shutil.move(str(new_db), str(old_db_path))
            if new_uploads.exists() and not old_uploads.exists():
                shutil.move(str(new_uploads), str(old_uploads))
            if old_config_folder:
                app_config.set_data_folder(old_config_folder)
            os.environ[uploads_module.UPLOADS_DIR_ENV_VAR] = str(old_uploads)
            await db.reinit_db(old_db_path)
        except Exception:
            logger.exception("Rollback failed during data folder move")
        from fastapi import HTTPException

        raise HTTPException(
            status_code=500, detail="Failed to move data folder. Attempted rollback."
        )

    return {
        "db_path": str(new_db),
        "data_folder": str(new_folder),
        "uploads_dir": str(new_uploads),
        "warning": "If you use VS Code MCP integration, restart the MCP server to pick up the new data path.",
    }
