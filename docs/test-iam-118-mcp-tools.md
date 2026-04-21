---
title: "Test Plan: IAM-118 MCP Tools for Idea Board"
type: test
status: stable
version: 1.0.1
created: 2026-04-22
updated: 2026-04-22
authors: [GitHub Copilot]
related:
  - docs/specs/IAM-100-idea-board-spec.md
---

# Test Plan: IAM-118 MCP Tools for Idea Board

## 1. Scope
Validate the new Idea Board MCP tool behavior in PR #99 on branch `feat/IAM-100-2-mcp-tools`.

In scope:
- `list_idea_tickets`
- `create_idea_ticket`
- `update_idea_ticket`
- `promote_idea_ticket`
- `drop_idea_ticket`
- `list_tickets` board filtering and backward compatibility

Out of scope:
- UI behavior for the Idea Board
- SSE event fanout details beyond successful tool execution
- Unrelated baseline failures in `test_database.py` and `test_main.py`

## 2. Test Strategy

| Layer | Approach | Tools |
|---|---|---|
| Unit-ish integration | Call MCP tool functions against isolated in-memory SQLite DB | pytest + sqlmodel |
| Regression | Run full server suite and compare to known baseline failures | pytest |

## 3. Test Cases

| ID | Description | Preconditions | Steps | Expected Result |
|---|---|---|---|---|
| TC-01 | `list_idea_tickets` excludes main-board tickets | Project with main + idea tickets | List ideas for the project | Only `board=idea` tickets are returned |
| TC-02 | `list_idea_tickets` filters by `idea_status` | Project with draft + approved ideas | List ideas with `status='approved'` | Only approved ideas are returned |
| TC-03 | `list_idea_tickets` rejects invalid project IDs | None | Call with unknown `project_id` | Raises `ValueError` |
| TC-04 | `create_idea_ticket` applies defaults | Valid project | Create idea without emoji/color overrides | Returns dict with `board=idea`, `idea_status=draft`, default emoji, valid color |
| TC-05 | `create_idea_ticket` validates title | Valid project | Create with blank or >255-char title | Raises `ValueError` |
| TC-06 | `create_idea_ticket` normalizes emoji and validates color | Valid project | Create with empty emoji, long emoji text, invalid color | Empty uses `💡`, long value trims to one char, invalid color raises |
| TC-07 | `update_idea_ticket` only mutates provided fields | Existing draft idea | Update one field at a time | Only provided fields change |
| TC-08 | Approved ideas lock title, description, and tags | Existing approved idea | Try editing locked content fields | Raises `ValueError` |
| TC-09 | Approved ideas still allow emoji/color edits | Existing approved idea | Update emoji and color | Styling fields update successfully |
| TC-10 | `update_idea_ticket` enforces allowed status transitions | Existing draft/approved/dropped ideas | Apply valid and invalid transitions | Valid transitions succeed; dropped cannot transition out |
| TC-11 | Legacy idea rows with `idea_status=NULL` behave like draft | Existing legacy idea row | Update title/status | Update succeeds as if status were draft |
| TC-12 | `update_idea_ticket` validates missing/non-idea tickets, title, and tags | Missing ticket, main-board ticket, invalid field values | Submit invalid updates | Raises `ValueError` |
| TC-13 | `promote_idea_ticket` requires approved status | Existing draft idea | Promote directly | Raises `ValueError` |
| TC-14 | `promote_idea_ticket` creates backlog ticket and drops source idea | Existing approved idea | Promote idea | Returns promoted ticket payload, new ticket is `board=main`, source idea becomes dropped |
| TC-15 | `promote_idea_ticket` rejects missing and non-idea tickets | Missing ticket and main-board ticket | Promote invalid ticket IDs | Raises `ValueError` |
| TC-16 | `drop_idea_ticket` drops once and rejects repeat drops | Existing draft idea | Drop twice | First call sets dropped, second raises `ValueError` |
| TC-17 | `drop_idea_ticket` rejects missing and non-idea tickets | Missing ticket and main-board ticket | Drop invalid ticket IDs | Raises `ValueError` |
| TC-18 | `list_tickets` preserves backward compatibility and board filter | Project with main + idea tickets | List without board, with `main`, with `idea`, with invalid board | Default and `main` return main only, `idea` returns idea only, invalid board raises |

## 4. Edge Cases & Negative Tests
- [x] Blank and overlength titles
- [x] Empty and multi-character emoji input
- [x] Invalid idea color values
- [x] Invalid tag payloads
- [x] Missing tickets and wrong-board tickets
- [x] Legacy idea rows with `NULL` status
- [x] Invalid board filter values

## 5. Coverage Goals

| Area | Target |
|---|---|
| IAM-118 acceptance criteria | 100% |
| Regressions outside IAM-118 | No new failures |

## 6. Test Data
Each test creates an isolated in-memory SQLite database and test project. Legacy-row coverage inserts a single `board=idea`, `idea_status=NULL` ticket directly into the temporary database.

## 7. Execution Result
- Targeted IAM-118 run: `pytest -v tests/test_idea_board_tools.py`
  - 39 passed
  - 0 failed
- Full server suite: `pytest tests/ -v`
  - 119 passed
  - 3 failed
  - 85 warnings
- Known baseline failures remained unchanged:
  - `tests/test_database.py::test_database_uses_repo_default_path_when_env_missing`
  - `tests/test_database.py::test_database_resolves_env_path_and_creates_parent_directory`
  - `tests/test_main.py::test_main_emits_ready_signal_and_serves_health`
- No new regressions were introduced by the IAM-118 test additions.