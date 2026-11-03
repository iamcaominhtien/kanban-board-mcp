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


# An agent outside a board run (Claude Code, Cursor... with only the MCP server) has no working folder: it names a file
# by its absolute path on this computer, as for docs_write(import) and diagram_create. Files that are never copied
# (keys, `.env`, anything under a dot folder such as ~/.ssh) stay refused.
OUTSIDE_RUN = "<outside-run>"


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


def never_copied(rel: Path) -> bool:
    """True for a file the board never copies out of a working folder, by its path below that folder: anything in or
    named by a dot (.git, .ssh, .env ...), build folders, key files and files named for what they hold (pictures are
    exempt from the name rule)."""
    suffix = rel.suffix.lower()
    return bool(
        set(rel.parts) & _DENIED_PARTS
        or any(part.startswith(".") for part in rel.parts)
        or suffix in _DENIED_SUFFIXES
        or (
            suffix not in uploads.SUPPORTED_IMAGE_EXTENSIONS
            and _SECRET_NAME.search(rel.name)
        )
    )


def _folders(folder: str | list[str]) -> list[Path]:
    """The run's folders, first first (its worktree, then the member's main checkout), each once."""
    raw = [folder] if isinstance(folder, str) else list(folder)
    out: list[Path] = []
    for f in raw:
        if f == OUTSIDE_RUN:
            f = os.sep
        if f:
            p = Path(os.path.realpath(os.path.expanduser(f)))
            if p not in out:
                out.append(p)
    return out


def ingest_file(raw: str, folder: str | list[str]) -> str:
    """Copy a file from `folder` into the uploads folder and return its `/uploads/…` url. `folder` may be several
    folders (a run's worktree and the member's main checkout): a relative path is looked up in each, in order, and an
    absolute one may be inside any of them.

    Raises ProofError when the file is outside the folder, missing, too big, of a type the board does not store or one
    that must never be copied (keys, `.env`, `.git`)."""
    bases = _folders(folder)
    given = Path(os.path.expanduser(raw.strip()))
    if _outside(folder):
        if not given.is_absolute():
            raise ProofError(
                f"{raw}: outside a board run a file is named by its absolute path on this computer "
                "(e.g. /Users/me/project/shots/login.png)."
            )
        if not given.is_file():
            raise ProofError(f"{raw}: no such file. Save it first, then attach it.")
    where = " or ".join(str(b) for b in bases) or "(none)"
    found: tuple[Path, Path] | None = None
    inside = False
    for base in bases:
        path = Path(os.path.realpath(given if given.is_absolute() else base / given))
        try:
            rel = path.relative_to(base)
        except ValueError:
            continue
        inside = True
        if path.is_file():
            found = (path, rel)
            break
    if not inside:
        raise ProofError(
            f"{raw}: the file is outside the working folder ({where}), so it was not attached. "
            "Save it inside that folder (e.g. qa/evidence/) and name it by its path from there."
        )
    if found is None:
        raise ProofError(
            f"{raw}: no such file in the working folder ({where}). Write the path from the folder root, "
            "e.g. qa/evidence/TC-1.png. Take the screenshot first, then write the proof."
        )
    path, rel = found
    suffix = path.suffix.lower()
    if never_copied(rel):
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


def _outside(folder: str | list[str] | None) -> bool:
    """The caller is an agent outside a board run (it names files by their absolute path)."""
    return folder == OUTSIDE_RUN or (
        isinstance(folder, list) and folder == [OUTSIDE_RUN]
    )


def _is_local(target: str) -> bool:
    """A reference to a file on this computer: not a web or uploads address, and a file type the board stores."""
    return (
        not target.startswith(("/uploads/", "#", "data:", "mailto:"))
        and "://" not in target
        and Path(target).suffix.lower() in uploads.MIME_BY_EXTENSION
    )


# Files a person reads rather than code: a link to one of these on a Docs page, a comment or a work log is attached
# when the file is in the run's working folder (a link to code or to another page stays a link)
_DOCUMENTS = {
    ".pdf", ".xlsx", ".xls", ".csv", ".tsv", ".docx", ".doc", ".pptx", ".ppt",
    ".zip", ".tar", ".gz", ".rar", ".7z", ".log", ".txt", ".mp3", ".wav", ".ogg", ".mp4", ".webm",
}  # fmt: skip


def _present(target: str, folder: str | list[str]) -> bool:
    """The target names a file inside one of the run's folders that exists (outside or missing: False)."""
    given = Path(os.path.expanduser(target.strip()))
    for base in _folders(folder):
        path = Path(os.path.realpath(given if given.is_absolute() else base / given))
        try:
            path.relative_to(base)
        except ValueError:
            continue
        if path.is_file():
            return True
    return False


def targets(markdown: str | None) -> set[str]:
    """Every link and picture target the Markdown names."""
    return {m.group(2) for m in _REF.finditer(markdown or "")}


def localize(
    markdown: str | None,
    folder: str | list[str] | None,
    *,
    pictures_only: bool = False,
    keep: set[str] | frozenset[str] = frozenset(),
) -> str | None:
    """Markdown with each picture or file named by a local path replaced by its copy in the uploads folder.

    Fenced code is left alone. Without a folder (a person, not an AI run) a local path is refused: the person attaches
    the file in the editor instead. `pictures_only` copies pictures, and of the links only those to a document (an
    Excel sheet, a PDF, a log, a zip) that is in the folder; other links stay as written (on a Docs page a link may name
    another page). A target in `keep` that cannot be copied stays as written instead of being refused (what
    a page already held before this edit, such as an imported page's `images/…`)."""
    if not markdown or "](" not in markdown:
        return markdown

    def swap(match: re.Match) -> str:
        head, target, tail = match.groups()
        if not _is_local(target):
            return match.group(0)
        if (
            _outside(folder)
            and pictures_only
            and not Path(os.path.expanduser(target)).is_absolute()
        ):
            return match.group(
                0
            )  # `images/x.png` on an imported page: not a file of this computer's
        if pictures_only and not head.startswith("!"):
            # a link: an Excel sheet or a PDF the run made is attached; anything else stays as written
            if not (
                folder
                and Path(target).suffix.lower() in _DOCUMENTS
                and _present(target, folder)
            ):
                return match.group(0)
        if not folder:
            raise ProofError(
                f"{target}: a file is attached by path only from inside an AI run; "
                "upload it in the editor instead."
            )
        try:
            return f"{head}{ingest_file(target, folder)}{tail}"
        except ProofError:
            if target in keep:
                return match.group(0)
            raise

    parts = _FENCE.split(markdown)
    return "".join(p if i % 2 else _REF.sub(swap, p) for i, p in enumerate(parts))
