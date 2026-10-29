"""Static markdown starters for new Docs pages."""

TEMPLATES: dict[str, dict[str, str]] = {
    "blank": {
        "name": "Blank",
        "description": "Start from an empty page",
        "markdown": "",
    },
    "requirements": {
        "name": "Requirements",
        "description": "Goals, scope and criteria",
        "markdown": (
            "## Summary\n\nOne or two sentences on what this is and why it matters.\n\n"
            "## Goals\n\n- Goal one\n- Goal two\n\n"
            "## Requirements\n\n"
            "| ID | Requirement | Priority |\n|---|---|---|\n"
            "| R1 | Describe the requirement | Must |\n"
            "| R2 | Describe the requirement | Should |\n\n"
            "## Acceptance criteria\n\n- [ ] Given / when / then…\n"
        ),
    },
    "meeting-notes": {
        "name": "Meeting notes",
        "description": "Attendees, notes, action items",
        "markdown": (
            "## Attendees\n\n- Name\n\n## Notes\n\n- Topic\n\n"
            "## Action items\n\n- [ ] Owner: task\n"
        ),
    },
    "decision-log": {
        "name": "Decision log",
        "description": "Context, options, outcome",
        "markdown": (
            "## Context\n\nWhat made this decision necessary?\n\n"
            "## Options\n\n1. Option A\n2. Option B\n\n"
            "## Outcome\n\nThe chosen option and why.\n"
        ),
    },
    "technical-design": {
        "name": "Technical design",
        "description": "Overview, diagram, API, rollout",
        "markdown": (
            "## Overview\n\nWhat are we building and why?\n\n"
            "## Diagram\n\n```text\nclient -> api -> db\n```\n\n"
            "## API\n\n| Method | Path | Description |\n|---|---|---|\n"
            "| GET | `/resource` | Describe it |\n\n"
            "## Rollout\n\n- [ ] Ship behind a flag\n- [ ] Announce\n"
        ),
    },
}
