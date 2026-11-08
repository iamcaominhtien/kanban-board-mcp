# Commit under test

Phase 0 fills this in. Testers check out this commit and test nothing else.

```
SHA: 7b2c120d31eeb07251f075f458e24450c75cc71f
Gate: all checks of .github/workflows/ci.yml pass; no code fix was needed
```

Product code (`server`, `ui`, `desktop`) at this SHA is the code under test. The PR that records this file changes only `PINNED.md`, so product code is the same before and after it. Check with `git diff 7b2c120d31eeb07251f075f458e24450c75cc71f -- server ui desktop` (must print nothing).

## Gate results

| Job | Command (working directory) | Result |
| --- | --- | --- |
| server | `uv sync` (`server`) | pass |
| server | `uv run ruff check .` (`server`) | pass, all checks passed |
| server | `uv run ruff format --check .` (`server`) | pass, 291 files already formatted |
| server | `uv run pytest -q -n auto` (`server`) | pass, 1062 passed, 1 skipped, 0 failed |
| ui | `npm ci` (`ui`) | pass |
| ui | `npm run format:check` (`ui`) | pass |
| ui | `npm run lint -- --max-warnings=40` (`ui`) | pass, 0 errors, 36 warnings (limit 40) |
| ui | `npm test` (`ui`) | pass, 16 test files, 138 tests passed, 0 failed |
| ui | `npm run build` (`ui`) | pass (only the usual chunk-size warning) |
| desktop | `npm ci --ignore-scripts` (`desktop`) | pass |
| desktop | `npm test` (`desktop`) | pass, 55 tests passed, 0 failed |
