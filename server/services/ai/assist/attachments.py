"""Pictures and files a person attaches to a chat message (the Sketch chat today).

What is accepted, checked from the bytes and not from the name or the type the browser claims:

* **pictures**: PNG, JPEG, WebP and GIF, up to 4 per message, 5 MB each (the browser scales large ones down first); they
  go to the model as pictures;
* **text files**: txt, md, csv, json, log, source code and the like, up to 200 KB each; they go to the model as text
  fenced as untrusted data.

Anything else (a PDF, an office file, an archive) is refused with a plain message that says what is accepted. There is
no PDF library among the dependencies, so a PDF is not read.

Kept files live in the uploads folder under ``_private/ai-chat/<chat id>/<turn id>/`` (never served over
``/uploads``), are readable only by the person whose chat it is, and go away with the chat.
"""

import os
import re
import shutil
import struct
from dataclasses import dataclass
from pathlib import Path

from uploads import get_private_dir

from .settings import AssistError

MAX_IMAGES = 4
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_SIDE = 8000
MAX_TEXT_FILES = 4
MAX_TEXT_BYTES = 200 * 1024
NAME_LIMIT = 80

IMAGE_TYPES = ("PNG", "JPEG", "WebP", "GIF")
TEXT_EXTENSIONS = frozenset(
    {
        "txt",
        "md",
        "markdown",
        "csv",
        "tsv",
        "json",
        "jsonl",
        "log",
        "xml",
        "yaml",
        "yml",
        "toml",
        "ini",
        "cfg",
        "conf",
        "env",
        "html",
        "htm",
        "css",
        "scss",
        "svg",
        "js",
        "mjs",
        "jsx",
        "ts",
        "tsx",
        "py",
        "rb",
        "go",
        "rs",
        "java",
        "kt",
        "swift",
        "c",
        "h",
        "cpp",
        "hpp",
        "cs",
        "php",
        "sh",
        "bash",
        "ps1",
        "bat",
        "sql",
        "graphql",
        "diff",
        "patch",
        "tex",
        "rst",
    }
)
ACCEPTED = (
    "Pictures (PNG, JPEG, WebP or GIF, 5 MB at most) and text files (txt, md, csv, json, log or source code, "
    "200 KB at most) can be attached."
)

_SAFE_CHAT = re.compile(r"^[0-9a-f-]{36}$")
_SAFE_TURN = re.compile(r"^[0-9a-f]{32}$")
_SAFE_FILE = re.compile(r"^(picture|a\d{1,2})\.(png|jpg|gif|webp|txt)$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


@dataclass
class Incoming:
    """A file as it arrived with a message."""

    name: str
    data: bytes


@dataclass
class Accepted:
    """A file that passed the checks, ready to be kept."""

    id: str  # a1, a2…
    name: str  # as the person knows it (cleaned)
    kind: str  # image | text
    mime: str
    ext: str  # png jpg gif webp txt
    data: bytes
    width: int = 0
    height: int = 0
    chars: int = 0

    def meta(self) -> dict:
        """What is stored with the message: no bytes."""
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "mime": self.mime,
            "file": f"{self.id}.{self.ext}",
            "bytes": len(self.data),
            "width": self.width,
            "height": self.height,
            "chars": self.chars,
        }


def clean_name(name: str) -> str:
    """A file name safe to show and to name in a prompt: no folders, no control characters, at most 80 characters."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    base = " ".join(_CONTROL.sub(" ", base).split())
    base = base.replace('"', "'").replace("<", "").replace(">", "")
    if len(base) > NAME_LIMIT:
        stem, dot, ext = base.rpartition(".")
        base = (
            stem[: NAME_LIMIT - len(ext) - 2] + "…" + dot + ext
            if dot and len(ext) < 10
            else base[:NAME_LIMIT]
        )
    return base or "file"


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    i = 2
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
            i += 1 if marker == 0xFF else 2
            continue
        length = struct.unpack(">H", data[i + 2 : i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5 : i + 9])
            return w, h
        i += 2 + length
    return None


def _webp_size(data: bytes) -> tuple[int, int] | None:
    kind = data[12:16]
    if kind == b"VP8X" and len(data) >= 30:
        w = 1 + int.from_bytes(data[24:27], "little")
        h = 1 + int.from_bytes(data[27:30], "little")
        return w, h
    if kind == b"VP8L" and len(data) >= 25:
        bits = int.from_bytes(data[21:25], "little")
        return 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
    if kind == b"VP8 " and len(data) >= 30:
        w, h = struct.unpack("<HH", data[26:30])
        return w & 0x3FFF, h & 0x3FFF
    return None


def sniff_image(data: bytes) -> tuple[str, str, int, int] | None:
    """``(media type, extension, width, height)`` of a PNG, JPEG, WebP or GIF, read from its bytes; None for anything
    else (or a picture whose header cannot be read)."""
    size = None
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        mime, ext = "image/png", "png"
        size = struct.unpack(">II", data[16:24])
    elif data[:3] == b"\xff\xd8\xff":
        mime, ext = "image/jpeg", "jpg"
        size = _jpeg_size(data)
    elif data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        mime, ext = "image/gif", "gif"
        size = struct.unpack("<HH", data[6:10])
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        mime, ext = "image/webp", "webp"
        size = _webp_size(data)
    else:
        return None
    if not size or size[0] < 1 or size[1] < 1:
        return None
    return mime, ext, int(size[0]), int(size[1])


def _kb(n: int) -> str:
    return (
        f"{n / (1024 * 1024):.1f} MB" if n >= 1024 * 1024 else f"{max(1, n // 1024)} KB"
    )


def _refuse(name: str, data: bytes) -> AssistError:
    """Why a file is neither a picture nor a text file, in plain words."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    what = {
        "pdf": "a PDF",
        "doc": "a Word file",
        "docx": "a Word file",
        "xls": "a spreadsheet",
        "xlsx": "a spreadsheet",
        "ppt": "a presentation",
        "pptx": "a presentation",
        "zip": "an archive",
        "gz": "an archive",
        "tar": "an archive",
        "rar": "an archive",
        "7z": "an archive",
        "mp3": "an audio file",
        "wav": "an audio file",
        "mp4": "a video",
        "webm": "a video",
        "mov": "a video",
        "bmp": "a BMP picture",
        "tif": "a TIFF picture",
        "tiff": "a TIFF picture",
        "heic": "a HEIC picture",
        "avif": "an AVIF picture",
    }.get(ext)
    if data[:5] == b"%PDF-":
        what = "a PDF"
    first = (
        f"“{name}” is {what}, which cannot be read here."
        if what
        else f"“{name}” cannot be read here."
    )
    tip = (
        " Copy its text into the message, or attach a screenshot of it."
        if what in ("a PDF", "a Word file", "a spreadsheet", "a presentation")
        else ""
    )
    return AssistError("invalid", f"{first} {ACCEPTED}{tip}")


def accept(files: list[Incoming]) -> list[Accepted]:
    """Check the files of one message and tell what each one is. Nothing is kept yet.

    Args:
        files: The files as they arrived.

    Returns:
        The accepted files in order, with ids a1, a2….

    Raises:
        AssistError: ``invalid`` (a plain message that says what is accepted) for a type that is not read, a text that
            cannot be read as text, or too many files; ``too_large`` for a file over its limit.
    """
    out: list[Accepted] = []
    images = texts = 0
    for n, f in enumerate(files, 1):
        name = clean_name(f.name)
        if not f.data:
            raise AssistError("invalid", f"“{name}” is empty.")
        info = sniff_image(f.data)
        if info is not None:
            mime, ext, w, h = info
            if len(f.data) > MAX_IMAGE_BYTES:
                raise AssistError(
                    "too_large",
                    f"“{name}” is {_kb(len(f.data))}. A picture can be {_kb(MAX_IMAGE_BYTES)} at most.",
                )
            if max(w, h) > MAX_IMAGE_SIDE:
                raise AssistError(
                    "too_large",
                    f"“{name}” is {w} × {h} px. A picture can be {MAX_IMAGE_SIDE} px on its longest side at most.",
                )
            images += 1
            if images > MAX_IMAGES:
                raise AssistError(
                    "invalid",
                    f"At most {MAX_IMAGES} pictures can be attached to one message.",
                )
            out.append(Accepted(f"a{n}", name, "image", mime, ext, f.data, w, h))
            continue
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in TEXT_EXTENSIONS or f.data[:5] == b"%PDF-":
            raise _refuse(name, f.data)
        if len(f.data) > MAX_TEXT_BYTES:
            raise AssistError(
                "too_large",
                f"“{name}” is {_kb(len(f.data))}. A text file can be {_kb(MAX_TEXT_BYTES)} at most.",
            )
        if b"\x00" in f.data:
            raise AssistError(
                "invalid", f"“{name}” is not a text file (it has binary content)."
            )
        try:
            text = f.data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise AssistError(
                "invalid", f"“{name}” is not UTF-8 text, so it cannot be read."
            ) from exc
        texts += 1
        if texts > MAX_TEXT_FILES:
            raise AssistError(
                "invalid",
                f"At most {MAX_TEXT_FILES} text files can be attached to one message.",
            )
        out.append(
            Accepted(
                f"a{n}",
                name,
                "text",
                "text/plain",
                "txt",
                f.data,
                chars=len(text),
            )
        )
    return out


# --------------------------------------------------------------------------- the kept files


def root(chat_id: str) -> Path:
    """The folder one chat keeps its files in (not created)."""
    if not _SAFE_CHAT.match(chat_id):
        raise AssistError("not_found", "Chat not found.")
    return get_private_dir() / "ai-chat" / chat_id


def turn_dir(chat_id: str, turn_id: str) -> Path:
    """The folder of one message's files."""
    if not _SAFE_TURN.match(turn_id):
        raise AssistError("not_found", "File not found.")
    return root(chat_id) / turn_id


def save(
    chat_id: str,
    turn_id: str,
    files: list[Accepted],
    picture: bytes | None,
) -> None:
    """Keep the picture of the drawing and the accepted files of one message."""
    folder = turn_dir(chat_id, turn_id)
    folder.mkdir(parents=True, exist_ok=True)
    if picture:
        (folder / "picture.png").write_bytes(picture)
    for f in files:
        (folder / f"{f.id}.{f.ext}").write_bytes(f.data)


def path_of(chat_id: str, turn_id: str, file: str) -> Path:
    """The path of one kept file; `not_found` for a name that is not one of ours."""
    if not (
        _SAFE_CHAT.match(chat_id)
        and _SAFE_TURN.match(turn_id)
        and _SAFE_FILE.match(file)
    ):
        raise AssistError("not_found", "File not found.")
    base = os.path.realpath(get_private_dir() / "ai-chat")
    full = os.path.realpath(os.path.join(base, chat_id, turn_id, file))
    if not full.startswith(base + os.sep) or not os.path.isfile(full):
        raise AssistError("not_found", "File not found.")
    return Path(full)


def forget(chat_id: str) -> None:
    """Remove everything a chat kept (it expired or was deleted)."""
    try:
        shutil.rmtree(root(chat_id), ignore_errors=True)
    except AssistError:
        return
