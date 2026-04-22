---
title: "Test Plan: IAM-117 Idea Board Data Model"
type: test
status: stable
version: 1.0.1
created: 2026-04-22
updated: 2026-04-22
authors: [GitHub Copilot]
related: []
---

# Test Plan: IAM-117 Idea Board Data Model

## 1. Scope
Validate the IAM-117 data-model and database-migration changes for Idea Board support.

In scope:
- Enum definitions for board and idea fields
- Ticket model field types, defaults, and nullability
- Alembic upgrade and downgrade behavior
- Backward compatibility for tickets created before the new columns exist

Out of scope:
- API behavior outside model persistence
- UI rendering or Idea Board workflows

## 2. Test Strategy

| Layer | Approach | Tools |
|---|---|---|
| Unit | Enum and model metadata assertions | pytest |
| Integration | ORM persistence defaults on SQLite | pytest + sqlmodel |
| Migration | Alembic upgrade/downgrade round-trip on temp SQLite DB | pytest + alembic |

## 3. Test Cases

| ID | Description | Preconditions | Steps | Expected Result |
|---|---|---|---|---|
| TC-01 | Enums expose the expected values | None | Import `BoardType`, `IdeaStatus`, `IdeaColor` and compare values | All enum members match the IAM-117 spec |
| TC-02 | Ticket model exposes the new fields with correct types/defaults | None | Inspect annotations and instantiate a minimal `Ticket` | `board` defaults to `main`; other new fields default to `None`; nullability matches the spec |
| TC-03 | Persisting a new ticket applies current defaults | Temp SQLite database | Create `Project` and `Ticket` via SQLModel session | Persisted ticket has `board=main` and nullable idea fields unset |
| TC-04 | Upgrade preserves legacy rows | Temp SQLite database at revision `1e1bb4aa5fa4` | Insert a ticket before IAM-117 columns exist, then upgrade to `head` | Existing row gains `board=main`; nullable idea fields remain `NULL` |
| TC-05 | Downgrade is reversible | Temp SQLite database | Upgrade to `head`, then run `alembic downgrade -1` | IAM-117 columns are removed cleanly |

## 4. Edge Cases & Negative Tests
- [x] Pre-IAM-117 ticket row upgraded after columns are added
- [x] Nullable idea fields remain `NULL` after upgrade
- [x] Downgrade removes only the IAM-117 schema additions

## 5. Coverage Goals

| Area | Target |
|---|---|
| IAM-117 model ACs | 100% |
| IAM-117 migration ACs | 100% |

## 6. Test Data
Temporary SQLite databases created per test under pytest `tmp_path`.

## 7. Execution Result
- Targeted IAM-117 run: 5 passed, 0 failed, 0 skipped
- Full server suite: 80 passed, 3 failed, 0 skipped
- Known baseline failures remained unchanged:
	- `tests/test_database.py::test_database_uses_repo_default_path_when_env_missing`
	- `tests/test_database.py::test_database_resolves_env_path_and_creates_parent_directory`
	- `tests/test_main.py::test_main_emits_ready_signal_and_serves_health`
- No new failures were introduced by IAM-117