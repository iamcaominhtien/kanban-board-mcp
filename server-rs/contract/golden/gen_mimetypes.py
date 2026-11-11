"""The built-in tables of Python's `mimetypes`, for crates/kb-files (Starlette's `FileResponse` guesses a content type
with `mimetypes.guess_type` when none is given).

Only the built-in tables are written: the files of the machine (`/etc/mime.types`, the Windows registry) vary by
computer and are not reproducible.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_mimetypes.py
Writes `mimetypes.json` next to this file.
"""

import json
import mimetypes
from pathlib import Path

OUT = Path(__file__).with_name("mimetypes.json")

mimetypes.init(files=[])
data = {
    "python": __import__("sys").version.split()[0],
    "suffix_map": mimetypes._suffix_map_default,
    "encodings_map": mimetypes._encodings_map_default,
    "types_map": mimetypes._types_map_default,
}
# a few guesses the Rust port must repeat (file name -> what `guess_type` answers on the built-in tables)
samples = [
    "a.js", "a.JS", "a.css", "a.html", "a.svg", "a.svgz", "a.png", "a.woff2", "a.json", "a.map", "a.tar.gz",
    "a.tgz", "a.txt.gz", "a.unknown", "noext", "dir.d/noext", ".hidden", "a.b.c.mp4", "/x/y/index.HTM",
]
data["samples"] = {name: mimetypes.guess_type(name)[0] for name in samples}
OUT.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({len(data['types_map'])} types)")
