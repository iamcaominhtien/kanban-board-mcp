"""Print the test files of CI shard K of N, for pytest's command line: `pytest $(python tests/shard.py 3/10)`.

Whole files go to one shard, the slowest first onto the lightest shard, so the shards take about as long. A file's
weight is its measured time in tests/durations.json (refresh it with tests/durations.py); a file not measured yet
counts as the median file. Naming the files, rather than collecting every test and dropping the other shards', means
each pytest worker imports only its own files, and the migrated database is made once for all the workers
(tests/conftest.py). Standard library only: CI runs it before installing anything.
"""

import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).parent


def files_of(shard: int, shards: int) -> list[str]:
    """The test files of one shard (1-based), as paths relative to the server folder."""
    files = sorted(f"tests/{p.name}" for p in HERE.glob("test_*.py"))
    try:
        seconds = json.loads((HERE / "durations.json").read_text())
    except (OSError, ValueError):
        seconds = {}
    median = statistics.median(seconds.values()) if seconds else 1.0
    weight = {f: seconds.get(f, median) for f in files}
    load = [0.0] * shards
    picked: list[list[str]] = [[] for _ in range(shards)]
    for f in sorted(files, key=lambda f: (-weight[f], f)):
        i = load.index(min(load))
        load[i] += weight[f]
        picked[i].append(f)
    return sorted(picked[shard - 1])


if __name__ == "__main__":
    k, n = (int(x) for x in sys.argv[1].split("/"))
    if not 1 <= k <= n:
        raise SystemExit(f"Shard {k} of {n} does not exist")
    print(" ".join(files_of(k, n)))
