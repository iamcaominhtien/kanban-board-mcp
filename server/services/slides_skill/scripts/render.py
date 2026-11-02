"""Render a .pptx, .xlsx, .docx or .pdf to one PNG per slide or page, with the first way this machine has, and a sheet
of thumbnails to look at side by side.

    python render.py deck.pptx --out look/              # look/page-01.png ... and look/sheet.png
    python render.py deck.pptx --out look/ --compare template.pptx    # the template's slides beside, to compare

The ways, in order (the report must say which one was used: only LibreOffice and Office are the real app):
1. LibreOffice (`soffice`, also /Applications/LibreOffice.app on a Mac, Program Files on Windows)
2. Microsoft Office from a script: PowerShell and COM on Windows, osascript on a Mac (60 s limit: Office on a Mac may
   wait on a folder-access dialog no one sees)
3. Quick Look on a Mac (`qlmanage`): the first slide or page only
Prints {"way": ..., "pages": [...], "sheet": ...}; exits 2 when no way worked, so the caller says the file was not seen.
PDF pages become PNGs with `pdftoppm` (poppler) or PyMuPDF (`pip install pymupdf`).
"""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_MAC_SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
_WIN_SOFFICE = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]


def _soffice() -> str | None:
    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found
    for p in [_MAC_SOFFICE, *_WIN_SOFFICE]:
        if Path(p).exists():
            return p
    return None


def _pdf_to_pngs(pdf: Path, out: Path, dpi: int) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob(
        "page-*.png"
    ):  # pages of an earlier, longer render would be taken for this one's
        old.unlink()
    if shutil.which("pdftoppm"):
        subprocess.run(
            ["pdftoppm", "-png", "-r", str(dpi), str(pdf), str(out / "page")],
            check=True,
        )
        pages = sorted(out.glob("page-*.png"))
        # pdftoppm pads to the page count's width: make it two digits always
        for i, p in enumerate(pages, 1):
            p.rename(out / f"page-{i:02d}.png")
        return sorted(out.glob("page-*.png"))
    import fitz  # PyMuPDF

    doc = fitz.open(pdf)
    pages = []
    for i, page in enumerate(doc, 1):
        p = out / f"page-{i:02d}.png"
        page.get_pixmap(dpi=dpi).save(p)
        pages.append(p)
    return pages


def _via_libreoffice(src: Path, tmp: Path) -> Path | None:
    exe = _soffice()
    if not exe:
        return None
    subprocess.run(
        [exe, "--headless", "--convert-to", "pdf", "--outdir", str(tmp), str(src)],
        check=True,
        capture_output=True,
        timeout=300,
    )
    pdf = tmp / (src.stem + ".pdf")
    return pdf if pdf.exists() else None


_PS = {
    ".pptx": "$a = New-Object -ComObject PowerPoint.Application; $p = $a.Presentations.Open('{src}', $true, $false, "
    "$false); $p.SaveAs('{pdf}', 32); $p.Close(); $a.Quit()",
    ".xlsx": "$a = New-Object -ComObject Excel.Application; $a.DisplayAlerts = $false; $w = $a.Workbooks.Open('{src}'); "
    "$w.ExportAsFixedFormat(0, '{pdf}'); $w.Close($false); $a.Quit()",
    ".docx": "$a = New-Object -ComObject Word.Application; $d = $a.Documents.Open('{src}'); $d.SaveAs2('{pdf}', 17); "
    "$d.Close(0); $a.Quit()",
}
_OSA = {
    ".pptx": 'tell application "Microsoft PowerPoint"\nopen POSIX file "{src}"\nsave active presentation in POSIX file '
    '"{pdf}" as save as PDF\nclose active presentation saving no\nend tell',
    ".docx": 'tell application "Microsoft Word"\nopen POSIX file "{src}"\nsave as active document file name "{pdf}" '
    "file format format PDF\nclose active document saving no\nend tell",
    ".xlsx": 'tell application "Microsoft Excel"\nopen POSIX file "{src}"\nsave active workbook in "{pdf}" as PDF file '
    "format\nclose active workbook saving no\nend tell",
}


def _via_office(src: Path, tmp: Path) -> Path | None:
    pdf = tmp / (src.stem + ".pdf")
    ext = src.suffix.lower()
    try:
        if platform.system() == "Windows" and ext in _PS:
            cmd = _PS[ext].format(src=str(src.resolve()), pdf=str(pdf.resolve()))
            subprocess.run(
                ["powershell", "-NoProfile", "-Command", cmd],
                check=True,
                capture_output=True,
                timeout=120,
            )
        elif platform.system() == "Darwin" and ext in _OSA:
            app = {".pptx": "PowerPoint", ".docx": "Word", ".xlsx": "Excel"}[ext]
            if not Path(f"/Applications/Microsoft {app}.app").exists():
                return None
            script = _OSA[ext].format(src=str(src.resolve()), pdf=str(pdf.resolve()))
            subprocess.run(
                ["osascript", "-e", script], check=True, capture_output=True, timeout=60
            )
        else:
            return None
    except (subprocess.SubprocessError, OSError):
        return None
    return pdf if pdf.exists() else None


def _via_quicklook(src: Path, out: Path) -> list[Path]:
    if platform.system() != "Darwin" or not shutil.which("qlmanage"):
        return []
    out.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["qlmanage", "-t", "-s", "1600", "-o", str(out), str(src)],
        capture_output=True,
        timeout=60,
    )
    made = sorted(out.glob(src.name + "*.png"))
    if not made:
        return []
    page = out / "page-01.png"
    made[0].rename(page)
    return [page]


def render(src: Path, out: Path, dpi: int = 80) -> tuple[str, list[Path]]:
    """``(way, pages)``: way is "libreoffice", "office", "quicklook" or "none"."""
    if src.suffix.lower() == ".pdf":
        return "pdf", _pdf_to_pngs(src, out, dpi)
    tmp = Path(tempfile.mkdtemp(prefix="render-"))
    for way, fn in (("libreoffice", _via_libreoffice), ("office", _via_office)):
        try:
            pdf = fn(src, tmp)
        except (subprocess.SubprocessError, OSError):
            pdf = None
        if pdf:
            return way, _pdf_to_pngs(pdf, out, dpi)
    pages = _via_quicklook(src, out)
    return ("quicklook", pages) if pages else ("none", [])


def sheet(
    pages: list[Path], path: Path, columns: int = 3, compare: list[Path] | None = None
) -> Path:
    """Thumbnails side by side; with ``compare``, each page sits beside the matching one of the other file."""
    from PIL import Image, ImageDraw

    width = 640
    rows = []
    if compare:
        for i, p in enumerate(pages):
            pair = [Image.open(p)] + (
                [Image.open(compare[i])] if i < len(compare) else []
            )
            rows.append(pair)
        columns = 2
    else:
        rows = [
            [Image.open(p) for p in pages[i : i + columns]]
            for i in range(0, len(pages), columns)
        ]
    if not rows:
        raise SystemExit("nothing to put on a sheet")
    thumb_h = int(width * rows[0][0].height / rows[0][0].width)
    gap = 16
    img = Image.new(
        "RGB",
        (columns * (width + gap) + gap, len(rows) * (thumb_h + gap + 18) + gap),
        "#d9d9d9",
    )
    draw = ImageDraw.Draw(img)
    n = 0
    for r, row in enumerate(rows):
        for c, im in enumerate(row):
            x, y = gap + c * (width + gap), gap + r * (thumb_h + gap + 18)
            img.paste(im.convert("RGB").resize((width, thumb_h)), (x, y + 18))
            label = (
                f"{r + 1}" + (" (compare)" if compare and c == 1 else "")
                if compare
                else f"{n + 1}"
            )
            draw.text((x, y), label, fill="#333")
            n += 1
    img.save(path)
    return path


def main() -> int:
    """Command line: render.py FILE --out DIR [--compare OTHER]."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("file", type=Path)
    ap.add_argument("--out", type=Path, default=Path("look"))
    ap.add_argument("--dpi", type=int, default=80)
    ap.add_argument(
        "--compare",
        type=Path,
        help="another file (the template) to put beside each page",
    )
    a = ap.parse_args()
    way, pages = render(a.file, a.out, a.dpi)
    result: dict = {"way": way, "pages": [str(p) for p in pages]}
    if pages:
        other = render(a.compare, a.out / "compare", a.dpi)[1] if a.compare else None
        try:
            result["sheet"] = str(sheet(pages, a.out / "sheet.png", compare=other))
        except ImportError:  # the pages are there; only the sheet needs Pillow
            result["sheet"] = None
            result["note"] = (
                "pip install pillow for sheet.png; open the pages one by one meanwhile"
            )
    print(json.dumps(result))
    return 0 if pages else 2


if __name__ == "__main__":
    sys.exit(main())
