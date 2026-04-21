---
title: "Test Plan Draft: IAM-100 Idea Board"
type: test
status: draft
version: 1.0.0
created: 2026-04-21
updated: 2026-04-21
authors: [GitHub Copilot]
related: []
---

# Test Plan: IAM-100 Idea Board

## 1. Scope

This plan covers the Idea Board feature across schema and migration, MCP tools, board switching, idea board layout, drag-and-drop, idea-card rendering, modal workflows, and SSE invalidation.

Out of scope: auth or permission changes, desktop packaging concerns, analytics beyond invalidation behavior, and non-Idea Board features that are not directly touched by the feature summary.

## 2. Quality Risks and Assumptions

- Highest risk is state contamination between main-board tickets and idea-board tickets.
- Promotion must be atomic: create one main ticket, set origin_idea_id, archive the source idea, and prevent duplicate promotion.
- Live sync is high risk because create, move, approve, drop, and promote events affect both idea-board and main-board views.
- Approved idea lock semantics conflict slightly with "drop any non-promoted idea." This plan includes a decision test for approved but unpromoted ideas; product should confirm the intended rule.
- Field limits for title, description, and tags are not specified. Boundary tests below should be executed at 0, 1, max, and max+1 once the exact limits are defined.

## 3. Recommended Test Stack

| Layer | Recommendation | Purpose | Notes |
|---|---|---|---|
| Backend Python plus SQLite | pytest, pytest-cov, pytest-mock | Unit, contract, migration, and state-transition coverage for schema and tools | Prefer a fresh SQLite file per test. Test tools directly or through a thin in-process harness instead of full end-to-end networking for most backend cases. |
| Frontend React plus Vite | Vitest, React Testing Library, @testing-library/user-event, @testing-library/jest-dom | Component and interaction tests for board switcher, modal form rules, and card rendering | Drag-and-drop pointer flows should be covered mainly in E2E because DnD libraries are often brittle in jsdom. |
| Cross-layer integration and E2E | Playwright | Covers board switching, drag-and-drop, promotion lifecycle, refresh persistence, backlinks, and multi-tab sync | Run against the local UI and local backend with deterministic seed data. |
| SSE and concurrency stress | Playwright multi-page tests plus focused backend contract tests | Verifies invalidation reaches all open views, deduplicates events, and recovers after reconnect | Add network throttling and offline toggles for reconnect checks. |
| Optional property-based validation | hypothesis on backend state transitions | Useful for legal and illegal idea_status and board-transition invariants | Especially valuable once tool state rules are finalized. |

## 4. Test Strategy by Layer

| Layer | Primary focus | Secondary focus |
|---|---|---|
| Data model and migration | Schema correctness, backward compatibility, referential integrity | Migration idempotency and legacy-row defaults |
| MCP tools | Input validation, state transitions, query isolation, atomic promotion | Error messaging and duplicate-submit protection |
| Routing and board switching | Deterministic routing, state persistence, project isolation | Back and forward navigation, invalid-route fallback |
| Idea board drag-and-drop | Correct column moves, rollback on failure, lock rules | Empty states and bulk-card smoke |
| Idea-card visuals | Metadata rendering, truncation, contrast, lock cues | Focus treatment and graceful fallback |
| Modal flow | Validation, two-stage approve and promote, drop confirmation, error recovery | Unsaved-state behavior if implemented |
| SSE invalidation | Cross-tab freshness, event scoping, dedupe, reconnect recovery | Noise isolation between main board and idea board |

## 5. Test Cases by Subtask

### 5.1 Subtask 1: [BE] Data model and DB migration

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| T1.1 | P0 | Apply migration to a database containing existing main-board tickets and projects | Migration completes without data loss; pre-existing tickets remain readable and keep their original board behavior. |
| T1.2 | P0 | Create a new idea-board ticket row with board, idea_status, idea_emoji, idea_color, and no origin_idea_id | Row persists with all idea metadata intact; default state is Drafting or the documented initial state. |
| T1.3 | P0 | Promote an idea and persist origin_idea_id on the newly created main-board ticket | Main ticket stores a valid origin_idea_id reference; source idea moves to archived or promoted state exactly once. |
| T1.4 | P0 | Query legacy pre-migration tickets after migration | Legacy tickets are not surfaced as idea items; board default or backfill behavior is deterministic and documented. |
| T1.5 | P1 | Attempt to persist an unsupported board value | Storage layer or service layer rejects the write; no invalid row is committed. |
| T1.6 | P1 | Attempt to persist an unsupported idea_status value or illegal state combination | Invalid state is rejected; the DB never contains impossible combinations such as promoted without promotion origin data. |
| T1.7 | P0 | Attempt to set origin_idea_id to a non-existent idea | Write is rejected or blocked safely; no orphan backlink can exist. |
| T1.8 | P1 | Re-run the migration in an already migrated environment | Behavior is safe and non-destructive: explicit no-op, already-applied outcome, or idempotent success; never partial duplication. |

Data integrity focus:

- Enforce clear invariants for board and idea_status.
- Guarantee origin_idea_id references only valid source ideas.
- Preserve legacy ticket behavior after migration.

### 5.2 Subtask 2: [BE] MCP tools and list_tickets update

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| T2.1 | P0 | list_idea_tickets returns ideas for one project | Response contains only idea-board records for the requested project; main-board tickets and foreign-project ideas are excluded. |
| T2.2 | P0 | create_idea_ticket with emoji, color, title, description, and tags | Tool creates a Drafting idea with returned identity and normalized payload. |
| T2.3 | P0 | create_idea_ticket with missing required title | Request is rejected with a clear validation error; no partial idea is created. |
| T2.4 | P0 | create_idea_ticket includes non-idea or main-ticket-only fields | Tool rejects the payload or strips forbidden fields per contract; schema guard is explicit and testable. |
| T2.5 | P1 | update_idea_ticket edits allowed fields while idea is Drafting | Changes persist and are visible through follow-up fetches. |
| T2.6 | P0 | update_idea_ticket moves Drafting to In Review | State transition succeeds once and the idea becomes reviewable in downstream flows. |
| T2.7 | P0 | Approve an In Review idea | Idea enters approved and locked state; editable fields become immutable in the contract. |
| T2.8 | P0 | promote_idea_ticket on an approved idea | Tool atomically creates one main-board ticket, sets origin_idea_id, archives the idea, and returns enough data for UI follow-up. |
| T2.9 | P0 | promote_idea_ticket on a Drafting or unapproved idea | Request is rejected; no main ticket is created and idea state stays unchanged. |
| T2.10 | P0 | drop_idea_ticket on a non-promoted idea | Idea moves to Dropped without deletion and remains queryable in the dropped column or history. |
| T2.11 | P1 | drop_idea_ticket on a promoted idea | Request is rejected; promoted ideas cannot be dropped after board promotion. |
| T2.12 | P0 | list_tickets after idea operations | Main-board ticket listing excludes idea-board items while including promoted main tickets. |
| T2.13 | P1 | Concurrent promote requests against the same approved idea | Exactly one main ticket is created; competing requests fail safely with no duplicate promotion. |
| T2.14 | P1 | Tool error during promote after partial side-effect attempt | Entire operation rolls back or completes consistently; no split-brain state with a main ticket created but source idea not archived, or the reverse. |

Data integrity focus:

- Promotion must be atomic and idempotent.
- list_tickets and list_idea_tickets must stay mutually exclusive except for deliberate promotion results.
- Approved ideas should enforce immutability rules.

### 5.3 Subtask 3: [FE] BoardSwitcher and routing

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| T3.1 | P0 | Open a project board with no explicit idea-board route selected | Main board is the default landing view. |
| T3.2 | P0 | Switch from main board to idea board via sidebar or tab control | Idea-board view loads for the same project without failure; selected tab is visually clear. |
| T3.3 | P0 | Refresh the page while idea board is selected | User returns to the same project and the same board context; persistence mechanism is stable. |
| T3.4 | P1 | Use browser back and forward after switching boards | Navigation tracks board selection correctly and never shows stale board content under the wrong tab. |
| T3.5 | P0 | Change from Project A idea board to Project B | Board content is fully isolated to Project B; no cards from Project A bleed into the new project. |
| T3.6 | P1 | Open an invalid or unsupported board route token | App falls back predictably to the default board or shows a graceful not-found state; it does not white-screen. |
| T3.7 | P1 | Open main board in one browser tab and idea board in another | Each tab preserves its own board context; switching in one tab does not unexpectedly flip the other. |

Data integrity focus:

- Board selection should be route-driven or equivalently durable.
- Project switch and board switch must never reuse stale records from another scope.

### 5.4 Subtask 4: [FE] IdeaBoard layout, columns, and drag-and-drop

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| T4.1 | P0 | Open the idea board with no ideas | Drafting, In Review, and Dropped columns render with clear empty states. |
| T4.2 | P0 | Create a new idea and return to the board | New idea appears in Drafting immediately or after normal refresh. |
| T4.3 | P0 | Drag a Drafting idea into In Review | Card lands in In Review, status persists after refresh, and no duplicate card remains behind. |
| T4.4 | P0 | Drag a Drafting idea into Dropped | Card lands in Dropped, stays recoverable in the dropped view, and is not deleted. |
| T4.5 | P1 | Drag a non-promoted In Review idea into Dropped | Card follows the documented rule for non-promoted ideas and persists accordingly. |
| T4.6 | P0 | Attempt a drag that the backend rejects or that fails in transit | UI rolls back to the pre-drag state and surfaces a visible error or retry cue. |
| T4.7 | P0 | Attempt to move an approved or locked idea by drag-and-drop | Locked-state behavior follows the product rule consistently; either drag is blocked or the allowed exception path is explicit. |
| T4.8 | P1 | Populate each column with many cards and mixed title lengths | Layout remains readable, scrollable, and stable; cards do not overlap or collapse. |
| T4.9 | P1 | Use keyboard-only navigation across columns and cards | Focus order is usable and visible; if pointer-only drag is intentional, there is an alternative management path through the modal. |

Data integrity focus:

- UI state after drag must match server state after refresh.
- No ghost cards, duplicate renders, or silent status drift.

### 5.5 Subtask 5: [FE] IdeaCard visual component

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| T5.1 | P0 | Render an idea with emoji, color, title, description, and tags | Card displays all supplied metadata clearly and consistently. |
| T5.2 | P1 | Render an idea with only required fields | Component degrades cleanly without broken layout, placeholder glitches, or empty wrappers. |
| T5.3 | P1 | Render long title, long description, and many tags | Overflow is controlled; text wraps or truncates without breaking column layout. |
| T5.4 | P1 | Render boundary characters, punctuation, and non-English text in title and description | Text displays safely and remains readable; no broken escaping or clipping. |
| T5.5 | P1 | Render each supported color option across the palette | Contrast stays legible and the card remains visually distinct from neighboring states. |
| T5.6 | P0 | Render an approved or locked idea | Card communicates locked status clearly enough that users understand promotion is the next allowed action. |
| T5.7 | P1 | Render a malformed or unsupported emoji or color payload received from older data or a bad sync | Card falls back gracefully to a default icon or color treatment instead of crashing or going blank. |
| T5.8 | P1 | Capture visual snapshots for Drafting, In Review, Approved, and Dropped cards | State differences are visually intentional and stay stable across routine UI regressions. |

Data integrity focus:

- Card visuals must not imply the wrong state.
- Unsupported display data must fail soft, not fail broken.

### 5.6 Subtask 6: [FE] IdeaTicketModal

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| T6.1 | P0 | Open create-idea modal, fill emoji, color, title, description, and tags, then submit | Idea is created successfully and appears in Drafting with matching visible metadata. |
| T6.2 | P0 | Submit create-idea modal with empty or whitespace-only title | Save is blocked with inline validation and no idea is created. |
| T6.3 | P1 | Edit a Drafting idea and save changes | Updated fields persist and reopen accurately. |
| T6.4 | P1 | Select emoji and color, close the modal without saving, then reopen | Behavior matches product design: either unsaved changes are discarded with warning or autosaved consistently; no silent ambiguity. |
| T6.5 | P0 | Move idea to In Review and open the modal | Modal exposes the review context and the Approve action only in the expected stage. |
| T6.6 | P0 | Click Approve on an In Review idea | Idea becomes locked, editable fields become read-only, and Promote to Board becomes available. |
| T6.7 | P0 | Try to modify locked fields after approval | UI prevents edits and the backend rejects tampering if requests are forced. |
| T6.8 | P0 | Click Promote to Board on an approved idea | One main ticket is created, the source idea is archived, and the UI provides a clear success path to the created main ticket. |
| T6.9 | P0 | Double-click or rapidly repeat Promote to Board | Only one main ticket is produced; duplicate requests are debounced, disabled, or rejected safely. |
| T6.10 | P0 | Promote fails because of a tool or backend error | User sees a clear error, the original idea remains recoverable, and the app avoids a half-promoted state. |
| T6.11 | P0 | Drop a non-promoted idea from the modal | Idea moves to Dropped, the modal closes or updates correctly, and the change persists after refresh. |
| T6.12 | P1 | Open the promoted main ticket from the promotion success path | Main ticket detail shows a visible origin backlink with the source idea title. |

Data integrity focus:

- Approval is a gating step, not a cosmetic toggle.
- Promotion must be one-shot and recover cleanly on failure.
- The modal should never allow users to believe a failed promote succeeded.

### 5.7 Subtask 7: [FE] SSE invalidation for idea events

| ID | Priority | Scenario | Expected result |
|---|---|---|---|
| T7.1 | P0 | Create an idea in Browser Tab A while Idea Board is open in Browser Tab B | Tab B receives the event and shows the new Drafting card without manual refresh. |
| T7.2 | P0 | Move an idea between Drafting and In Review in one tab | Other open idea-board views for the same project update to the new column with no duplicate artifacts. |
| T7.3 | P0 | Approve an idea in one tab | Other tabs reflect approved or locked state promptly and remove edit affordances. |
| T7.4 | P0 | Promote an approved idea in one tab while another tab shows main board and a third shows idea board | Main-board tab receives the new ticket; idea-board tab archives or removes the source card from active columns. |
| T7.5 | P0 | Drop an idea in one tab | Other tabs move the card into Dropped or remove it from active columns in sync with product rules. |
| T7.6 | P1 | Receive idea events while the user is viewing the main board | Main board ignores idea-only noise except for legitimate promoted main-ticket creation events. |
| T7.7 | P0 | Keep Project A open in one tab and Project B open in another while events fire | Events are project-scoped; no cross-project contamination appears. |
| T7.8 | P1 | Simulate dropped connection and reconnect during rapid idea updates | Client recovers to the correct latest state, deduplicates missed or replayed events, and avoids stale ghost cards. |

Data integrity focus:

- SSE must preserve eventual consistency without duplicating records.
- Event filters must be scoped by project and by board semantics.

## 6. Regression Suite After All 7 Subtasks Merge

| ID | Priority | Flow | Expected result |
|---|---|---|---|
| R1.1 | P0 | Full idea lifecycle: create idea, move to In Review, approve, promote, open created main ticket | End-to-end flow succeeds, source idea is archived, created main ticket exists on the main board, and backlink data is correct. |
| R1.2 | P0 | Full drop lifecycle: create idea, drop it, refresh, reopen board | Idea remains in Dropped, is not deleted, and never appears in main-ticket queries. |
| R1.3 | P0 | Main-board isolation check after mixed idea operations | Main board never shows Drafting, In Review, or Dropped idea cards; only promoted main tickets appear. |
| R1.4 | P0 | Multi-tab sync via SSE across create, move, approve, drop, and promote | All tabs converge on the same final state with no duplicate cards or stale views. |
| R1.5 | P0 | Schema-guard regression using create and update idea tools with forbidden non-idea fields | Tool contract rejects the payload; no silent data pollution enters the system. |
| R1.6 | P0 | Backlink integrity after promotion | Promoted main ticket visibly references the correct idea title, and navigation back to the source idea resolves correctly if supported. |
| R1.7 | P0 | Board-switcher state persistence on refresh and back or forward | Selected board state survives reload and navigation without crossing into the wrong project or board. |
| R1.8 | P1 | Duplicate-promotion defense using rapid click and concurrent browser sessions | System creates exactly one main ticket and leaves the source idea in a coherent terminal state. |
| R1.9 | P1 | Legacy-data smoke on a migrated database with pre-Idea Board tickets | Existing main-board workflows continue to behave normally after migration. |
| R1.10 | P1 | Reconnect and recovery smoke after SSE disconnect | Fresh state is recovered correctly across both main-board and idea-board views. |

Recommended regression execution order:

1. R1.1
2. R1.3
3. R1.4
4. R1.5
5. R1.6
6. R1.2
7. R1.7
8. R1.8
9. R1.9
10. R1.10

## 7. Test Data and Fixtures Needed

### 7.1 Backend and DB fixtures

| Fixture | Purpose |
|---|---|
| Legacy-data fixture | Existing projects and main-board tickets created before the migration to prove backward compatibility. |
| Project A idea fixture set | Active project with at least one Drafting, one In Review, one Approved, one Dropped, and one promoted or archived source idea. |
| Project B isolation fixture set | Separate project with its own idea and main tickets for contamination checks. |
| Deterministic user fixture | Same user across tabs for sync checks; optional second collaborator if project membership matters. |
| Promotion-collision fixture | One approved idea reserved for concurrent promote tests. |
| Failure-injection fixture | Controlled backend or tool failure during promote, drop, or update to verify rollback and error handling. |

### 7.2 UI field-data fixtures

| Data set | Examples | Purpose |
|---|---|---|
| Basic valid idea | Emoji plus short title, one-line description, 1 to 2 tags, supported color | Happy-path smoke |
| Long-form idea | Very long title, multi-paragraph description, many tags | Overflow, truncation, and layout stability |
| Boundary text | Empty, whitespace-only, max, and max+1 values for title, description, and tag count | Validation limits |
| Unicode and punctuation | Accented text, CJK text, symbols, apostrophes, slashes, parentheses | Rendering and storage safety |
| Color coverage | Every supported palette value plus one unsupported value | Visual contrast and fallback behavior |
| Emoji coverage | Standard emoji, multi-codepoint emoji, and unsupported token fallback | Picker, rendering, and persistence checks |

### 7.3 Environment and orchestration setup

- Local frontend and local backend running together with a clean SQLite file per test run or per suite.
- Playwright browser-state reset between cases except explicit multi-tab sync scenarios.
- SSE tests need at least two simultaneous browser pages on the same project and one page on a second project.
- Time, generated IDs, and seed data should be deterministic where practical so promotion and backlink assertions stay stable.
- If routing persistence relies on local storage, storage reset rules must be defined and controllable in tests.

## 8. Risk-Based Priority

### P0: Run first

| Area | Why it is first |
|---|---|
| T1.1 to T1.4 | Migration or schema mistakes can corrupt existing data or misclassify all tickets. |
| T2.1 to T2.4 and T2.8 to T2.12 | API-contract correctness is the contract foundation for every UI flow and prevents board contamination. |
| T3.1 to T3.5 | If routing or switching fails, the feature is effectively unreachable or leaks project scope. |
| T4.3, T4.4, T4.6, T4.7 | Drag-state and rollback defects are highly visible and likely in a DnD-heavy UI. |
| T6.1, T6.2, and T6.5 to T6.11 | The modal owns the highest-risk business transitions: approve, promote, and drop. |
| T7.1 to T7.5 and T7.7 | Live-sync defects create visible mistrust and multi-tab inconsistency. |
| R1.1 to R1.7 | These cover the entire lifecycle plus isolation and backlink integrity. |

### P1: Run next

| Area | Why it matters |
|---|---|
| T1.5 to T1.8 | Protects against edge-case corruption and operational migration issues. |
| T2.5 to T2.7, T2.13, T2.14 | Hardens state transitions and concurrency behavior. |
| T3.6, T3.7 | Improves recoverability and multi-tab clarity. |
| T4.5, T4.8, T4.9 | Clarifies ambiguous product rules and usability resilience. |
| T5.1 to T5.8 | Prevents visual regressions and broken rendering on real-world data. |
| T6.3, T6.4, T6.12 | Covers authoring polish and post-promotion navigation. |
| T7.6, T7.8 | Hardens scoped invalidation and reconnect behavior. |
| R1.8 to R1.10 | Extends confidence into concurrency, legacy data, and reconnect scenarios. |

### P2: Optional after core confidence

- Expanded accessibility audits beyond focus visibility and keyboard escape hatches.
- Performance burn tests with large idea volumes per project.
- Visual snapshot baselining across multiple screen sizes and color themes.

## 9. Exit Criteria

- All P0 tests pass on local integration before merge to a shared branch.
- No open critical or high bugs remain in promote, isolation, or sync behavior.
- Migration is verified on both fresh and legacy datasets.
- Regression suite R1.1 through R1.7 passes on the integrated branch.
- Any product decision on approved-but-unpromoted drop behavior is documented and reflected consistently across API and UI tests.

## 10. Coverage Summary

This plan covers the full feature surface from schema and tool contracts through routing, drag-and-drop UX, modal workflows, live sync, and end-to-end regression. The highest test weight is placed on the three failure modes most likely to damage trust or data correctness: board contamination, non-atomic promotion, and multi-tab desynchronization.