import os
import re
import unicodedata
from pathlib import Path
from uuid import uuid4

UPLOADS_DIR_ENV_VAR = "KANBAN_UPLOADS_DIR"
MAX_DESCRIPTION_IMAGE_BYTES = 5 * 1024 * 1024

MIME_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

SUPPORTED_IMAGE_EXTENSIONS = tuple(MIME_BY_EXTENSION.keys())
SUPPORTED_IMAGE_MIME_TYPES = tuple(sorted(set(MIME_BY_EXTENSION.values())))


def get_uploads_dir() -> Path:
    env_value = os.environ.get(UPLOADS_DIR_ENV_VAR)
    candidate = (
        Path(env_value) if env_value else Path(__file__).resolve().parent / "uploads"
    )
    candidate.mkdir(parents=True, exist_ok=True)
    return candidate.resolve()


def resolve_upload_path(file_path: str) -> Path | None:
    uploads_dir = get_uploads_dir()
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
    original_name = Path(filename).name or "image"
    stem = Path(original_name).stem or "image"
    stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("._-") or "image"
    extension = Path(original_name).suffix.lower()
    return stem, extension


def build_upload_filename(original_filename: str) -> str:
    stem, extension = sanitize_filename(original_filename)
    return f"{stem}-{uuid4().hex[:12]}{extension}"


def build_markdown_alt_text(original_filename: str) -> str:
    stem, _ = sanitize_filename(original_filename)
    return stem.replace("[", "").replace("]", "") or "image"
