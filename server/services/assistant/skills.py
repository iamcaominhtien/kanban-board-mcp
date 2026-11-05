"""The assistants' feature skills (`services/assistant/skills/<name>/SKILL.md`), shipped to a run as one plugin
(`kanban-assistant`), and the JSON schema each feature asks its answer in."""

import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

from services.ai import launch

PLUGIN = "kanban-assistant"
SOURCE = Path(__file__).resolve().parent / "skills"


def names() -> list[str]:
    """The names of the feature skills."""
    return sorted(p.name for p in SOURCE.iterdir() if (p / "SKILL.md").is_file())


def text_of(name: str) -> str:
    """A skill's SKILL.md."""
    return (SOURCE / name / "SKILL.md").read_text(encoding="utf-8")


def _version() -> str:
    h = hashlib.sha1()
    for n in names():
        h.update(n.encode())
        h.update(text_of(n).encode())
    return h.hexdigest()[:12]


def plugin_dir() -> str:
    """The plugin folder with every feature skill, written once per version of their text.

    It is built in a folder of its own and renamed into place, so two processes (the board and its runner, or two
    test runs) never see a half-written plugin and never delete each other's.
    """
    root = launch.data_root() / "assistant-skills" / _version()
    if (root / ".ready").exists():
        return str(root)
    tmp = root.with_name(f"{root.name}.tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    (tmp / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (tmp / ".claude-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": PLUGIN,
                "version": "2.0.0",
                "description": "The board's assistants: Docs, Board, Ideas, editors, sketches.",
            }
        ),
        encoding="utf-8",
    )
    for n in names():
        (tmp / "skills" / n).mkdir(parents=True, exist_ok=True)
        (tmp / "skills" / n / "SKILL.md").write_text(text_of(n), encoding="utf-8")
    (tmp / ".ready").write_text("ok", encoding="utf-8")
    try:
        os.rename(tmp, root)
    except OSError:  # another process finished first: use its copy
        shutil.rmtree(tmp, ignore_errors=True)
        if not (root / ".ready").exists():
            raise
    return str(root)


def _obj(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or []}


_S = {"type": "string"}
_A = {"type": "array", "items": {"type": "string"}}
SCHEMAS: dict[str, dict[str, Any]] = {
    "docs-check": _obj(
        {
            "findings": {
                "type": "array",
                "items": _obj(
                    {
                        "kind": _S,
                        "quote": _S,
                        "section": _S,
                        "message": _S,
                        "suggestion": _S,
                    },
                    ["kind", "quote", "message"],
                ),
            }
        },
        ["findings"],
    ),
    "docs-fix": _obj({"old": _S, "new": _S}, ["old", "new"]),
    "docs-summarise": _obj({"text": _S, "title": _S}, ["text"]),
    "docs-explain": _obj({"text": _S}, ["text"]),
    "docs-translate": _obj({"markdown": _S, "language": _S}, ["markdown"]),
    "docs-ask": _obj(
        {
            "answer": _S,
            "verdict": {
                "type": "string",
                "enum": ["answered", "not_covered", "conflict"],
            },
            "citations": {
                "type": "array",
                "items": _obj({"page_id": _S, "title": _S, "section": _S}),
            },
            "pages_read": {"type": "integer"},
        },
        ["answer", "verdict"],
    ),
    "docs-write": _obj({"page_id": _S, "title": _S, "gaps": _A}, ["page_id", "title"]),
    "docs-diagram": _obj(
        {"diagram_id": _S, "label": _S, "markdown": _S, "changed": {"type": "boolean"}},
        ["diagram_id", "markdown"],
    ),
    "docs-history": _obj({"summary": _S, "note": _S, "lines": _A}),
    "docs-tickets": _obj(
        {
            "drafts": {
                "type": "array",
                "items": _obj(
                    {"title": _S, "text": _S, "type": _S, "line": _S}, ["title"]
                ),
            },
            "skipped": {"type": "array", "items": _obj({"line": _S, "why": _S})},
        },
        ["drafts"],
    ),
    "docs-freshness": _obj(
        {
            "state": {"type": "string", "enum": ["ok", "stale"]},
            "reasons": {
                "type": "array",
                "items": _obj({"quote": _S, "source": _S, "why": _S}),
            },
        },
        ["state"],
    ),
    "docs-thread": _obj({"reply": _S, "posted": {"type": "boolean"}}, ["reply"]),
    "board-health": _obj(
        {
            "insights": {
                "type": "array",
                "items": _obj(
                    {
                        "kind": _S,
                        "ticket_id": _S,
                        "title": _S,
                        "detail": _S,
                        "score": {"type": "integer"},
                        "data": {"type": "object"},
                    },
                    ["kind", "title"],
                ),
            },
            "summary": _S,
        },
        ["insights"],
    ),
    "idea-triage": _obj(
        {
            "action": {
                "type": "string",
                "enum": ["keep", "park", "merge", "archive", "none"],
            },
            "reason": _S,
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            "target_id": _S,
            "park_days": {"type": "integer"},
            "archive_reason": _S,
        },
        ["action", "reason", "confidence"],
    ),
    "idea-shape": {"type": "object"},
    "idea-ask": _obj(
        {
            "answer": _S,
            "sources": {"type": "array", "items": _obj({"id": _S, "title": _S})},
            "actions": {
                "type": "array",
                "items": _obj({"label": _S, "kind": _S, "idea_ids": _A}),
            },
        },
        ["answer"],
    ),
    "idea-prepare-ticket": _obj(
        {"title": _S, "description": _S, "acceptance_criteria": _A, "sub_tickets": _A},
        ["title", "description"],
    ),
    "idea-digest": _obj(
        {
            "text": _S,
            "items": {
                "type": "array",
                "items": _obj({"kind": _S, "idea_ids": _A, "text": _S}),
            },
        },
        ["text"],
    ),
    "editor-write": _obj({"text": _S}, ["text"]),
    "sketch-ask": _obj(
        {
            "answer": _S,
            "ideas": _A,
            "shapes": {"type": "array", "items": {"type": "object"}},
        },
        ["answer"],
    ),
    "db-fix": _obj(
        {
            "cause": _S,
            "statements": _A,
            "affects": _S,
            "other_columns": _A,
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            "answer": _S,
        },
        ["cause", "statements"],
    ),
    "schedule-review": _obj(
        {
            "verdict": {"type": "string", "enum": ["pass", "changes"]},
            "notes": _S,
            "checks": {
                "type": "array",
                "items": _obj({"text": _S, "pass": {"type": "boolean"}, "note": _S}),
            },
            "fixes": _A,
        },
        ["verdict"],
    ),
    "schedule-dry-run": _obj({"text": _S}, ["text"]),
}


def schema_for(name: str) -> dict[str, Any] | None:
    """The JSON schema a skill's answer is asked in, or None for plain text."""
    return SCHEMAS.get(name)
