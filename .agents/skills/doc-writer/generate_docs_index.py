#!/usr/bin/env python3
"""
generate_docs_index.py — Auto-generate docs/_index.md.

Scans all .md files in docs/ (excluding _index.md and archive/),
parses YAML frontmatter, groups by 'type', and writes a Markdown
table per group to docs/_index.md.

Usage:
    python .github/skills/doc-writer/generate_docs_index.py
    uv run .github/skills/doc-writer/generate_docs_index.py
    python .github/skills/doc-writer/generate_docs_index.py --docs-dir path/to/docs
"""

import argparse
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------------------
# Type → section heading mapping (order matters for output)
# ---------------------------------------------------------------------------

TYPE_ORDER = ["arch", "adr", "api", "ba", "test", "ops", "guide"]
TYPE_LABELS: dict[str, str] = {
    "arch": "Architecture",
    "adr": "ADRs",
    "api": "API Reference",
    "ba": "Business Analysis",
    "test": "Test Plans",
    "ops": "Operations",
    "guide": "Developer Guides",
}


# ---------------------------------------------------------------------------
# Frontmatter parser (no external deps — avoids PyYAML requirement)
# ---------------------------------------------------------------------------

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_KV_RE = re.compile(r"^(\w+)\s*:\s*(.*)$", re.MULTILINE)


def _parse_frontmatter(text: str) -> dict[str, str]:
    """Return a flat dict of frontmatter key→value strings, or {} if none."""
    m = _FM_RE.match(text)
    if not m:
        return {}
    return {k: v.strip().strip('"').strip("'") for k, v in _KV_RE.findall(m.group(1))}


# ---------------------------------------------------------------------------
# Scanner
# ---------------------------------------------------------------------------


def scan_docs(docs_dir: Path) -> dict[str, list[dict[str, str]]]:
    """Return docs grouped by type, each entry is a dict of frontmatter fields + 'file'."""
    groups: dict[str, list[dict[str, str]]] = defaultdict(list)

    for path in sorted(docs_dir.glob("**/*.md")):
        # Exclude _index.md and anything inside archive/
        if path.name == "_index.md":
            continue
        if "archive" in path.parts:
            continue

        fm = _parse_frontmatter(path.read_text(encoding="utf-8"))
        doc_type = fm.get("type", "guide").lower()

        rel = path.relative_to(docs_dir)
        groups[doc_type].append(
            {
                "file": str(rel),
                "title": fm.get("title", path.stem),
                "status": fm.get("status", "—"),
                "version": fm.get("version", "—"),
                "updated": fm.get("updated", "—"),
            }
        )

    return groups


# ---------------------------------------------------------------------------
# Index writer
# ---------------------------------------------------------------------------

_TABLE_HEADER = "| File | Title | Status | Version | Updated |\n|---|---|---|---|---|\n"


def _table_row(doc: dict[str, str]) -> str:
    f = doc["file"]
    # For links, make the href relative to _index.md (same dir = just the filename)
    href = Path(f).name if "/" not in f else f
    return (
        f"| [{f}]({href}) "
        f"| {doc['title']} "
        f"| {doc['status']} "
        f"| {doc['version']} "
        f"| {doc['updated']} |"
    )


def write_index(groups: dict[str, list[dict[str, str]]], docs_dir: Path) -> None:
    lines: list[str] = [
        "# Documentation Index",
        "_Auto-generated. Do not edit manually. "
        "Run `python .github/skills/doc-writer/generate_docs_index.py` to refresh._",
        "",
        f"_Last updated: {date.today().isoformat()}_",
        "",
    ]

    # Emit sections in defined order, then any unknown types alphabetically
    known = list(TYPE_ORDER)
    unknown = sorted(t for t in groups if t not in TYPE_ORDER)
    for doc_type in known + unknown:
        docs = groups.get(doc_type)
        if not docs:
            continue
        label = TYPE_LABELS.get(doc_type, doc_type.title())
        lines.append(f"## {label}")
        lines.append("")
        lines.append(_TABLE_HEADER.rstrip())
        for doc in docs:
            lines.append(_table_row(doc))
        lines.append("")

    index_path = docs_dir / "_index.md"
    index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(
        f"Written: {index_path} ({len(groups)} type(s), {sum(len(v) for v in groups.values())} doc(s))"
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Regenerate docs/_index.md from frontmatter."
    )
    parser.add_argument(
        "--docs-dir",
        type=Path,
        default=Path("docs"),
        help="Path to the docs/ directory (default: docs/)",
    )
    args = parser.parse_args()

    docs_dir: Path = args.docs_dir
    if not docs_dir.is_dir():
        print(
            f"Error: docs directory not found: {docs_dir}",
            file=__import__("sys").stderr,
        )
        raise SystemExit(1)

    groups = scan_docs(docs_dir)
    write_index(groups, docs_dir)


if __name__ == "__main__":
    main()
