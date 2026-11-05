"""Pictures and files in what an AI reads, as files it can open.

A comment, a description or a Docs page shows a pasted picture as ``![name](/uploads/…)``: a web path, not a file on
this computer, and the uploads folder is outside the folders a run may read (it also holds people's private chat
files, so it is never opened to an AI as a whole). Before a prompt goes out, each upload it names is copied into a
folder of that call only, which the CLI is allowed to read (``--add-dir``), and the prompt ends with where each one is,
to open with Read (Claude reads images).
"""

from __future__ import annotations

import re
import shutil
import tempfile
from pathlib import Path

from uploads import PRIVATE_DIR, resolve_upload_path

_UPLOAD = re.compile(r"/uploads/([^\s)\"'\]<>\\|?#]{1,300})")


def folder_for(key: str) -> Path:
    """The folder of one call's copies (a run, a chat answer, a Docs answer)."""
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", key)[:80]
    return Path(tempfile.gettempdir()) / "kanban-ai-pictures" / safe


def stage(text: str, key: str) -> tuple[str, str | None]:
    """Copy the uploads `text` names into the call's folder and add where they are. Returns (the text with a note at
    its end, or as it was; the folder to let the CLI read, or None)."""
    found: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for rel in _UPLOAD.findall(text or ""):
        if rel in seen or rel.split("/", 1)[0].lower() == PRIVATE_DIR:
            continue
        seen.add(rel)
        path = resolve_upload_path(rel)
        if path is not None and path.is_file():
            found.append((rel, path))
    if not found:
        return text, None
    folder = folder_for(key)
    folder.mkdir(parents=True, exist_ok=True)
    lines = []
    for rel, path in found:
        copy = folder / Path(rel).name
        if not copy.exists():
            shutil.copy2(path, copy)
        lines.append(f"- /uploads/{rel} → {copy}")
    note = (
        "Pictures and files in the text above, as files on this computer: open each with Read to see it (Read shows "
        "images) before you answer about it.\n" + "\n".join(lines)
    )
    return f"{text}\n\n{note}", str(folder)
