import logging
import os
import re
import unicodedata
from pathlib import Path
from uuid import uuid4

UPLOADS_DIR_ENV_VAR = "KANBAN_UPLOADS_DIR"
# Files kept in the uploads folder (so a backup carries them) that are never served: `/uploads/...` answers "invalid
# path" for anything under it. The AI chats keep the pictures and files people attach there.
PRIVATE_DIR = "_private"
MAX_DESCRIPTION_IMAGE_BYTES = 5 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

SUPPORTED_IMAGE_EXTENSIONS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".bmp",
    ".ico",
)

MIME_BY_EXTENSION = {
    # Images
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    # Text / Document / Data
    ".txt": "text/plain",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
    ".xml": "application/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".pdf": "application/pdf",
    # Office documents
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    # Code & Scripts
    ".js": "text/javascript",
    ".ts": "text/plain",
    ".jsx": "text/plain",
    ".tsx": "text/plain",
    ".py": "text/plain",
    ".css": "text/css",
    ".html": "text/plain",  # text/plain prevents stored XSS execution in app origin
    ".sql": "text/plain",
    ".sh": "text/plain",
    ".env": "text/plain",
    # Media
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    # Archives
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".rar": "application/vnd.rar",
    ".7z": "application/x-7z-compressed",
}

VIEWABLE_INLINE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".bmp",
    ".ico",
    ".txt",
    ".log",
    ".csv",
    ".tsv",
    ".json",
    ".xml",
    ".yaml",
    ".yml",
    ".md",
    ".markdown",
    ".pdf",
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".py",
    ".css",
    ".html",
    ".sql",
    ".sh",
    ".env",
    ".mp3",
    ".wav",
    ".ogg",
    ".mp4",
    ".webm",
}

SUPPORTED_IMAGE_MIME_TYPES = tuple(
    sorted(set(MIME_BY_EXTENSION[ext] for ext in SUPPORTED_IMAGE_EXTENSIONS))
)


# Where `resolve_uploads_dir` found the folder. Only "code" is a folder the desktop app does not serve.
SOURCE_ENV = "env"  # KANBAN_UPLOADS_DIR (the app sets it for its own processes)
SOURCE_DATA_FOLDER = (
    "data_folder"  # `data_folder` of the config file: <data folder>/uploads
)
SOURCE_CONFIG = "config"  # `uploads_dir` of the config file, written by the desktop app at its start
SOURCE_DB_PATH = "db_path"  # next to KANBAN_DB_PATH
SOURCE_CODE = "code"  # `server/uploads` next to the code: the last resort

_logger = logging.getLogger(__name__)
_fallback_logged = False


def resolve_uploads_dir() -> tuple[Path, str]:
    """The uploads folder and where it came from (a SOURCE_* name). Order: KANBAN_UPLOADS_DIR, `data_folder` of the
    config file, `uploads_dir` of the config file, the folder of KANBAN_DB_PATH, then `server/uploads` next to the code."""
    env_value = os.environ.get(UPLOADS_DIR_ENV_VAR)
    if env_value:
        return Path(env_value), SOURCE_ENV
    import config as app_config

    configured = app_config.get_data_folder()
    if configured:
        return configured / "uploads", SOURCE_DATA_FOLDER
    recorded = app_config.get_uploads_dir()
    if recorded:
        return recorded, SOURCE_CONFIG
    db_env = os.environ.get("KANBAN_DB_PATH")
    if db_env:
        return Path(db_env).resolve().parent / "uploads", SOURCE_DB_PATH
    return Path(__file__).resolve().parent / "uploads", SOURCE_CODE


def get_uploads_dir(*, create: bool = True) -> Path:
    """Return the uploads directory, creating it when `create` is true."""
    global _fallback_logged
    candidate, source = resolve_uploads_dir()
    if source == SOURCE_CODE and not _fallback_logged:
        _fallback_logged = True
        _logger.warning(
            "No uploads folder is configured (no KANBAN_UPLOADS_DIR, no data folder or uploads_dir in the config "
            "file, no KANBAN_DB_PATH): files are kept in %s, next to the code, which the desktop app does not serve.",
            candidate,
        )
    if create:
        candidate.mkdir(parents=True, exist_ok=True)
    return candidate.resolve()


def storage_info() -> dict:
    """Where a stored file went, for the result of a tool that stores one: `{"stored_in": folder}`, plus a `warning`
    when the folder is the one next to the code (the desktop app serves another, so the link would not open there)."""
    folder, source = resolve_uploads_dir()
    info: dict = {"stored_in": str(folder.resolve())}
    if source == SOURCE_CODE:
        info["warning"] = (
            f"The file is stored in {info['stored_in']}, which the app does not serve: no uploads folder is "
            "configured for this MCP server. Start the desktop app once (it records its uploads folder in the "
            "config file) or set KANBAN_UPLOADS_DIR in the environment of this MCP server, then attach the file again."
        )
    return info


def resolve_upload_path(file_path: str) -> Path | None:
    """Resolve a relative upload path inside the uploads directory, or None if it escapes it."""
    uploads_dir = get_uploads_dir(create=False)
    path_obj = Path(file_path)
    if path_obj.is_absolute():
        return None

    safe_parts = [part for part in path_obj.parts if part not in ("", ".")]
    if any(part == ".." for part in safe_parts):
        return None
    if safe_parts and safe_parts[0].lower() == PRIVATE_DIR:
        return None

    try:
        resolved = uploads_dir.joinpath(*safe_parts).resolve()
        resolved.relative_to(uploads_dir)
    except ValueError:
        return None

    return resolved


def get_private_dir() -> Path:
    """The folder inside the uploads folder whose files are never served over `/uploads/...`."""
    path = get_uploads_dir() / PRIVATE_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def sanitize_filename(filename: str) -> tuple[str, str]:
    """Return a safe `(stem, extension)` pair for an uploaded filename."""
    original_name = Path(filename).name or "image"
    stem = Path(original_name).stem or "image"
    stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("._-") or "image"
    extension = Path(original_name).suffix.lower()
    return stem, extension


def build_upload_filename(original_filename: str) -> str:
    """Build a unique stored filename from the original name."""
    stem, extension = sanitize_filename(original_filename)
    return f"{stem}-{uuid4().hex[:12]}{extension}"


def build_markdown_alt_text(original_filename: str) -> str:
    """Return Markdown-safe alt text derived from the filename."""
    stem, _ = sanitize_filename(original_filename)
    return stem.replace("[", "").replace("]", "") or "image"
