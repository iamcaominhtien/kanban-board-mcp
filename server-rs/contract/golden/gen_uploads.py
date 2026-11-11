"""Golden vectors for crates/kb-files `uploads::sanitize_filename` and `build_markdown_alt_text`.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_uploads.py
Writes `uploads.json` next to this file.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, ".")  # run from server/
import uploads  # noqa: E402

OUT = Path(__file__).with_name("uploads.json")

NAMES = [
    "diagram.png", "Tiến Việt.PNG", "../../etc/pass wd.txt", "", "...", "日本語.png", ".env", "a  b__c.tar.gz",
    "ﬁle.txt", "report [final].pdf", "a/b/c.JPG", "dir/", "/", ".", "..", "file.", ".hidden.txt", "  spaced name .md",
    "x" * 300 + ".png", "Ünïcödé-Ñame.GIF", "a\\b.txt", "a\tb.txt", "-_-.png", "Ⅻ roman.txt", "ｆｕｌｌ.txt",
    "name.with.many.dots.TXT", "[a].png", "image", "nul\x00name.png",
]
rows = [
    {"name": name, "stem_ext": list(uploads.sanitize_filename(name)), "alt": uploads.build_markdown_alt_text(name)}
    for name in NAMES
]
OUT.write_text(json.dumps(rows, indent=1, ensure_ascii=True) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({len(rows)} names)")
