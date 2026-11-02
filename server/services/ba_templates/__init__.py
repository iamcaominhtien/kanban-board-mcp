"""The BA's templates (issue #273): one kind of document per situation, as a developer picks an architecture.

Researched with the owner: BABOK lists about 50 techniques and leaves the choice to the analyst; AI spec tools
(GitHub Spec Kit, Kiro) converge on prioritised stories with Given/When/Then, numbered requirements, edge cases and
"needs clarification" marks; EARS gives five sentence patterns for requirements; Cockburn's use cases, decision
tables, example mapping and a Shape Up style one-pager each fit one situation. Studies of AI-written requirements
found them well-formed but failing quality checks more often, and long: hence the quality checklist.

The files ride beside the `role-ba` skill (``templates/``) and, except the checklist, are page templates on Docs
(``services/docs_templates.py``), so a person can start from them too.
"""

from pathlib import Path

ROOT = Path(__file__).parent

# key -> (name, what it is for); the order the BA's skill and the New page dialog list them
DOCS: dict[str, tuple[str, str]] = {
    "feature-spec": (
        "Feature spec",
        "Stories, scenarios, numbered requirements, edge cases",
    ),
    "bugfix-spec": ("Bugfix spec", "Current, expected and unchanged behaviour"),
    "decision-table": ("Decision table", "One row per combination of conditions"),
    "use-case": ("Use case", "Main scenario and what can go differently"),
    "example-map": ("Example map", "Rules, their examples, open questions"),
    "one-pager": ("One-pager", "Problem, appetite, solution, no-gos"),
    "data-dictionary": ("Data dictionary", "Fields, types, examples, rules"),
    "nfr-checklist": ("Quality requirements", "Speed, safety, access, formats"),
}


def text(name: str) -> str:
    """A template's Markdown (``name`` without ``.md``, or a path such as ``examples/feature-spec-example``)."""
    return (ROOT / f"{name}.md").read_text(encoding="utf-8")


def files() -> dict[str, bytes]:
    """Every file the BA's skill carries, by its path under ``templates/``."""
    return {
        f"templates/{p.relative_to(ROOT).as_posix()}": p.read_bytes()
        for p in sorted(ROOT.rglob("*.md"))
    }


def docs_templates() -> dict[str, dict[str, str]]:
    """The page templates for Docs: ``{key: {name, description, markdown}}``."""
    return {
        key: {"name": name, "description": desc, "markdown": text(key)}
        for key, (name, desc) in DOCS.items()
    }
