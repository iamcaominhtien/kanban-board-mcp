import os
import re
import unicodedata
from pathlib import Path
from uuid import uuid4

UPLOADS_DIR_ENV_VAR = "KANBAN_UPLOADS_DIR"
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


def get_uploads_dir(*, create: bool = True) -> Path:
    """Return the uploads directory, creating it when `create` is true."""
    env_value = os.environ.get(UPLOADS_DIR_ENV_VAR)
    if env_value:
        candidate = Path(env_value)
    else:
        import config as app_config

        configured = app_config.get_data_folder()
        if configured:
            candidate = configured / "uploads"
        else:
            db_env = os.environ.get("KANBAN_DB_PATH")
            if db_env:
                candidate = Path(db_env).resolve().parent / "uploads"
            else:
                candidate = Path(__file__).resolve().parent / "uploads"
    if create:
        candidate.mkdir(parents=True, exist_ok=True)
    return candidate.resolve()


def resolve_upload_path(file_path: str) -> Path | None:
    """Resolve a relative upload path inside the uploads directory, or None if it escapes it."""
    uploads_dir = get_uploads_dir(create=False)
    path_obj = Path(file_path)
    if path_obj.is_absolute():
        return None

    safe_parts = [part for part in path_obj.parts if part not in ("", ".")]
    if any(part == ".." for part in safe_parts):
        return None

    try:
        resolved = uploads_dir.joinpath(*safe_parts).resolve()
        resolved.relative_to(uploads_dir)
    except ValueError:
        return None

    return resolved


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
