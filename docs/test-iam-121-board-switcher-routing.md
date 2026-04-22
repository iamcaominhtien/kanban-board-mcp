---
title: "Test Plan: IAM-121 BoardSwitcher + Routing"
type: test
status: review
version: 1.0.1
created: 2026-04-22
updated: 2026-04-22
authors: [GitHub Copilot]
related:
  - docs/specs/IAM-100-idea-board-spec.md
---

# Test Plan: IAM-121 BoardSwitcher + Routing

## 1. Scope
Validate the BoardSwitcher and board-selection routing behavior in PR #100 on branch `feat/IAM-100-5-board-switcher`.

In scope:
- Default board selection for new or missing project context
- Per-project localStorage restore and persistence
- Project-switch synchronization without stale board state
- BoardSwitcher rendering, active-state styling, click behavior, keyboard navigation, and roving tabindex
- App-level view swap between the main board and the idea placeholder

Out of scope:
- Idea Board CRUD flows beyond the placeholder view
- Server-side persistence or MCP tool behavior
- Unrelated project sidebar interactions

## 2. Test Strategy

| Layer | Approach | Tools |
|---|---|---|
| Manual functional | Exercise board selection from the running UI using project changes, clicks, and keyboard navigation | Browser + localStorage inspection |
| Build validation | Confirm the UI compiles successfully without adding a test runner | `npm run build` |

## 3. Test Cases

| ID | Description | Preconditions | Steps | Expected Result |
|---|---|---|---|---|
| TC-01 | Default board is `main` for a new or null project | App loads with no saved board value for the current project, or no active project selected | 1. Clear any stored board key for the target project. 2. Open the app with that project selected, then repeat with no project selected if the UI supports it. | The main board is shown by default. The BoardSwitcher highlights `📋 Board`. |
| TC-02 | Stored value is restored on initial load | A saved board value exists in localStorage for the active project | 1. Save `idea` for the active project key. 2. Reload the app. | The UI opens on `💡 Ideas`, and the switcher shows Ideas as selected. |
| TC-03 | Changing boards persists the selection | Active project selected and switcher visible | 1. Click `💡 Ideas`. 2. Reload the page. 3. Click `📋 Board`. 4. Reload again. | Each reload restores the last chosen board for that project from localStorage. |
| TC-04 | Switching projects reads the correct per-project key without stale state | At least two projects exist with different stored board values | 1. Store `idea` for Project A and `main` for Project B. 2. Select Project A. 3. Switch to Project B. 4. Switch back to Project A. | Each project shows its own saved board immediately after selection. The previous project's board does not leak into the next project. |
| TC-05 | BoardSwitcher renders both tabs with the expected labels | Active project selected | 1. Open the sidebar area below the active project. | Exactly two tabs are visible: `📋 Board` and `💡 Ideas`. |
| TC-06 | Active styling follows the selected tab | Active project selected | 1. Observe the default selected tab. 2. Switch to the other tab. | Only the selected tab has the active visual treatment at any time. |
| TC-07 | Clicking a tab changes the board | Active project selected | 1. Click `💡 Ideas`. 2. Click `📋 Board`. | The displayed content switches accordingly, proving `onBoardChange` is wired to the UI interaction. |
| TC-08 | Left and right arrow keys change selection | Keyboard focus placed on the selected tab | 1. Tab into the switcher. 2. Press Right Arrow. 3. Press Left Arrow. | Selection moves between the two tabs and the displayed content updates with each key press. |
| TC-09 | Roving tabindex follows the selected tab | Keyboard focus placed on the switcher | 1. Inspect focus order by tabbing into the control. 2. Change selection with arrows. 3. Shift focus away and back. | Only the selected tab is in the tab order (`tabIndex=0` behavior), while the other tab is skipped until it becomes selected. |

## 4. Edge Cases & Exploratory Checks
- Rapidly switch between projects with different saved boards and watch for flicker or one-frame stale content.
- Refresh the page while `💡 Ideas` is selected and confirm the placeholder still matches the restored board.
- Verify keyboard navigation still works after clicking with the mouse first.
- Verify the switcher remains usable when returning to a project with no saved value.

## 5. Coverage Goals

| Area | Target |
|---|---|
| IAM-121 acceptance criteria | 100% |
| Regression coverage outside board switching | Smoke only via production build |

## 6. Test Data
- Two existing projects with distinct IDs
- Local browser storage entries for each project's selected board

## 7. Execution Result
- Existing UI test framework: none detected in `ui/package.json` (no `test` script and no Vitest/Jest dependencies)
- Automated tests written: none, per ticket instruction not to set up a new test runner for this branch
- Manual UI cases above are documented for browser verification against the acceptance criteria
- Build verification: `npm run build` succeeded on 2026-04-22
- Build output summary:
  - `tsc && vite build`
  - 428 modules transformed
  - Output assets emitted successfully under `dist/`
  - Vite reported one bundle-size warning: JS chunk `dist/assets/index-Bs8GVrLe.js` is 528.99 kB after minification