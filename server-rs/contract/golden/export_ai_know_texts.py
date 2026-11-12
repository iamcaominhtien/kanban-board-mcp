"""Copies the long texts of `services/ai/packs.py` and `services/ai/plugins.py` into `crates/kb-ai-know/src/text/`.

`packs.json` is the ready-made packs without their persona (key order kept), `personas/<key>.txt` each persona without
the closing `_rules(key)` sentence (Rust appends it from the skill table of `kb-skills`, as `_rules` does), and
`catalogue.json` the plugin catalogue. The Rust golden test proves the assembled result equal to Python.

Run from `server/` with temporary KANBAN_* folders:
    .venv/bin/python ../server-rs/contract/golden/export_ai_know_texts.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, ".")  # run from server/
from services.ai import packs, plugins  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "crates" / "kb-ai-know" / "src" / "text"


def main() -> None:
    (OUT / "personas").mkdir(parents=True, exist_ok=True)
    stripped = []
    for pack in packs.BUILTIN:
        key = pack["key"]
        rules = packs._rules(key)
        persona = pack["persona"]
        assert persona.endswith(rules), key
        (OUT / "personas" / f"{key}.txt").write_text(persona[: -len(rules)], encoding="utf-8", newline="")
        assert list(pack)[-1] == "persona", key
        stripped.append({k: v for k, v in pack.items() if k != "persona"})
    (OUT / "packs.json").write_text(json.dumps(stripped, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    (OUT / "catalogue.json").write_text(
        json.dumps(plugins.CATALOGUE, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
    )


main()
