"""Proof of a test case result: Markdown, so it can hold text, links, code blocks, pictures and files.

The `proof` of a test case is written like its expected result: `![login](qa/evidence/TC-1.png)` for a screenshot, a
fenced block for a command and its output, a link for a CI run. An AI names a picture or file by its path in the
run's working folder; the board copies it into its uploads folder and rewrites the reference to `/uploads/…`, so the
picture shows on the ticket and survives a cleaned folder.

A result that cannot be shown is written as "Not provable: <why>" (no iPhone, needs a real account, a matter of
taste). That is an honest answer, not a gap; it is shown apart from a proof.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import uploads

MAX_FILE_BYTES = 25 * 1024 * 1024
# Never copied out of a working folder, whatever the AI asks for: any folder or file whose name starts with a dot (.git,
# .ssh, .claude, .config, .npmrc ...), build folders, and files named for what they hold
_DENIED_PARTS = {"node_modules", "__pycache__"}
_DENIED_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".keystore", ".env"}
_SECRET_NAME = re.compile(
    r"(credential|secret|password|passwd|token|private[-_]?key|id_rsa|id_ed25519)", re.I
)
# [text](target) and ![alt](target), the target without spaces, an optional "title"
_REF = re.compile(r'(!?\[[^\]\n]*\]\()([^)\s]+)((?:\s+"[^"\n]*")?\))')
_FENCE = re.compile(
    r"(```.*?```|~~~.*?~~~|`[^`\n]+`)", re.S
)  # code is shown as written
_UNPROVABLE = re.compile(r"^\s*(not provable|không chứng minh được)\b", re.I)


class ProofError(ValueError):
    """A proof was refused; the message tells the AI or the person what to fix."""


def has_proof(tc: dict) -> bool:
    """True when a test case has anything written as its proof (a reason it cannot be shown counts too)."""
    return bool(str(tc.get("proof") or "").strip())


def is_unprovable(tc: dict) -> bool:
    """True when the proof says the result cannot be shown, and why."""
    return bool(_UNPROVABLE.match(str(tc.get("proof") or "")))


def gaps(test_cases: list[dict]) -> list[str]:
    """Codes of the test cases marked pass or fail with nothing written as proof."""
    return [
        str(tc.get("code") or tc.get("title") or "")
        for tc in test_cases
        if tc.get("status") in ("pass", "fail") and not has_proof(tc)
    ]


def unprovable(test_cases: list[dict]) -> list[str]:
    """Codes of the test cases marked pass or fail whose proof says it cannot be shown."""
    return [
        str(tc.get("code") or tc.get("title") or "")
        for tc in test_cases
        if tc.get("status") in ("pass", "fail") and is_unprovable(tc)
    ]


def ingest_file(raw: str, folder: str) -> str:
    """Copy a file from `folder` into the uploads folder and return its `/uploads/…` url.

    Raises ProofError when the file is outside the folder, missing, too big, of a type the board does not store or one
    that must never be copied (keys, `.env`, `.git`)."""
    base = Path(os.path.realpath(os.path.expanduser(folder)))
    given = Path(os.path.expanduser(raw.strip()))
    path = Path(os.path.realpath(given if given.is_absolute() else base / given))
    try:
        rel = path.relative_to(base)
    except ValueError:
        raise ProofError(
            f"{raw}: the file is outside the working folder, so it was not attached."
        ) from None
    if not path.is_file():
        raise ProofError(
            f"{raw}: no such file in the working folder (write the path from the folder root, "
            "e.g. qa/evidence/TC-1.png). Take the screenshot first, then write the proof."
        )
    suffix = path.suffix.lower()
    if (
        set(rel.parts) & _DENIED_PARTS
        or any(part.startswith(".") for part in rel.parts)
        or suffix in _DENIED_SUFFIXES
        or (
            suffix not in uploads.SUPPORTED_IMAGE_EXTENSIONS
            and _SECRET_NAME.search(path.name)
        )
    ):
        raise ProofError(f"{raw}: this kind of file is never attached.")
    if suffix not in uploads.MIME_BY_EXTENSION:
        raise ProofError(
            f"{raw}: {suffix or 'a file without an extension'} is not a type the board stores "
            "(png, jpg, webp, gif, pdf, txt, log, json, csv, md, mp4 …)."
        )
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ProofError(f"{raw}: larger than {MAX_FILE_BYTES // (1024 * 1024)} MB.")
    stored = uploads.build_upload_filename(path.name)
    (uploads.get_uploads_dir() / stored).write_bytes(path.read_bytes())
    return f"/uploads/{stored}"


def _is_local(target: str) -> bool:
    """A reference to a file on this computer: not a web or uploads address, and a file type the board stores."""
    return (
        not target.startswith(("/uploads/", "#", "data:", "mailto:"))
        and "://" not in target
        and Path(target).suffix.lower() in uploads.MIME_BY_EXTENSION
    )


def localize(markdown: str | None, folder: str | None) -> str | None:
    """Markdown with each picture or file named by a local path replaced by its copy in the uploads folder.

    Fenced code is left alone. Without a folder (a person, not an AI run) a local path is refused: the person attaches
    the file in the editor instead."""
    if not markdown or "](" not in markdown:
        return markdown

    def swap(match: re.Match) -> str:
        head, target, tail = match.groups()
        if not _is_local(target):
            return match.group(0)
        if not folder:
            raise ProofError(
                f"{target}: a file is attached by path only from inside an AI run; "
                "upload it in the editor instead."
            )
        return f"{head}{ingest_file(target, folder)}{tail}"

    parts = _FENCE.split(markdown)
    return "".join(p if i % 2 else _REF.sub(swap, p) for i, p in enumerate(parts))
