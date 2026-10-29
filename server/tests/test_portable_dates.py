"""Dates are formatted the same way on every platform: Windows strftime has no `%-d` (no leading zero), and the
desktop app on Windows failed every request that used it (Ask AI disappeared from the board)."""

import pathlib
import re

from services.ai.assist import settings

_UNPORTABLE = re.compile(r"%-[A-Za-z]")


def test_no_platform_specific_strftime_codes():
    root = pathlib.Path(__file__).resolve().parent.parent
    found = [
        f"{p.relative_to(root)}:{i}"
        for folder in ("api", "services", "kanban_mcp")
        for p in (root / folder).rglob("*.py")
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
        if _UNPORTABLE.search(line)
    ]
    assert found == []


def test_next_month_label_has_no_leading_zero():
    label = settings.next_month_label()
    month, day = label.split()
    assert day == "1" and len(month) == 3
