# Code navigation

This repo has a CodeGraph index (symbols, calls, imports for the Python server and the TS/React UI), exposed as the `codegraph` MCP server (`.mcp.json`, `.vscode/mcp.json`).

- To find callers, callees, or the blast radius of a symbol, or to explore an unfamiliar area, use `codegraph_explore` before reading files or grepping.
- Several symbols share names (for example `_clean_title` exists in both `server/services/tickets.py` and `server/services/docs.py`); the results list each definition separately, so check the file before editing.
- If the MCP tool is not available, use the same index from the shell: `.claude/scripts/codegraph.sh run callers <symbol>` (also `callees`, `impact`, `query`, `node`, `context`).
- The index is local (`.codegraph/`, git-ignored) and is synced by `.claude/scripts/codegraph.sh`; the CLI version is pinned there.

# Subagents and models

Do not spawn subagents by reflex. Each one costs tokens, often has to gather context you already have, and loses detail in the handoff. A subagent gives you parallelism, a clean context or a fresh pair of eyes, not a smarter answer.

- **Do it yourself** when the task is quick: a handful of tool calls, a lookup whose target you already know, one edit, or a check you can run inline.
- **Delegate** only when it pays: a wide search or a long test run whose output would otherwise fill your context, independent pieces that can run in parallel, or a review by an agent that has not seen how the code was written.
- **Split by context, not by type of work.** Good cuts: independent search paths, components with clean interfaces, checking a finished result. Do not chain agents by role (plan → implement → test → review), and do not split sequential steps of one change or tightly coupled code; do those yourself.
- **At most 3 subagents at a time.** If there are more pieces, run them in waves or do the small ones yourself. If the user asked for a specific number, spawn exactly that many.
- **Brief each one fully**: the goal, the files, what is already ruled out, and what done looks like. No two agents edit the same files, and none waits on another's result. Ask for a short summary back, not raw output.
- **Check what comes back** before relying on it, and do not redo a delegated task yourself. A verifier must run the whole test suite (not a few tests), check against concrete criteria, and report only what affects correctness, not style.

Pick the model and effort for each subagent from the task, not by default:

| Task | Model | Effort |
|---|---|---|
| Mechanical, read-only work: find files or symbols, list callers, grep, read logs, run tests and report the output | `haiku` (often with the `Explore` agent type) | `low` |
| Routine work with a clear spec: implement a well-defined change, write or fix tests, small refactors, review a narrow diff | `sonnet` | `medium` |
| Work that needs the same judgment as you: design-heavy changes, cross-cutting refactors, tricky debugging | the same model as the main session (or a `fork`) | `medium`; `high` or `xhigh` when getting it right depends on cases that are easy to miss (a bug in unfamiliar code, a flaky test, a schema change with many readers) |
| Stuck, no clear way forward, or a decision that needs a second opinion | first the same model at higher effort; only if that still falls short, one tier up (`haiku` → `sonnet` → `opus` → `fable`) | `high` or `xhigh` |

- **Start cheap and escalate on evidence.** Raise the effort first and the model second, and only when a cheaper run came back wrong or thin. When the result can be checked (tests, a verifier), run at low effort and re-run only the failures at `high`.
- Keep `max` for a hard problem worked through without the user (a security hunt); on ordinary work it overthinks.
- An escalation agent is a consultant: give it the code and the facts, ask for a recommendation, and do the implementation yourself (or with a cheaper agent) once the way forward is clear.
