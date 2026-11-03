"""Write tests/durations.json, the measured time of each test file that conftest uses to split CI's shards evenly.

    uv run pytest -q -n auto --durations=0 --durations-min=0 > /tmp/durations.log
    python tests/durations.py /tmp/durations.log

A file's time is the setup, call and teardown of all its tests, summed (over the workers, so the shards compare
like with like). Files the log does not name keep no entry and count at the average time per test.
"""

import collections
import json
import re
import sys
from pathlib import Path

LINE = re.compile(r"^([0-9.]+)s (setup|call|teardown)\s+(tests/[^:]+)::")


def main(log: str) -> None:
    """Sum the log's durations per file and write them next to this script."""
    seconds: collections.Counter = collections.Counter()
    for line in Path(log).read_text().splitlines():
        m = LINE.match(line)
        if m:
            seconds[m.group(3)] += float(m.group(1))
    if not seconds:
        raise SystemExit(
            f"No durations in {log}: run pytest with --durations=0 --durations-min=0"
        )
    out = Path(__file__).with_name("durations.json")
    out.write_text(
        json.dumps({k: round(v, 2) for k, v in sorted(seconds.items())}, indent=1)
        + "\n"
    )
    print(f"{len(seconds)} files, {sum(seconds.values()):.0f} s in all -> {out}")


if __name__ == "__main__":
    main(sys.argv[1])
