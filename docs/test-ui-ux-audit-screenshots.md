---
title: "Test Plan: UI/UX Screenshot Audit"
type: test
status: in-progress
version: 1.0.0
created: 2026-04-17
updated: 2026-04-17
authors: [GitHub Copilot]
related:
  - docs/specs/kanban-ui.md
---

# Test Plan: UI/UX Screenshot Audit

## 1. Scope
Capture a comprehensive screenshot inventory of the Kanban Board MCP UI for audit purposes, covering primary views, overlays, filters, empty states, responsive layout, and interaction states that can be reached through the running application.

Out of scope: backend failure injection, OS-native dialogs that Playwright cannot render directly, and UI states that are not implemented in the current app build.

## 2. Test Strategy

| Layer | Approach | Tools |
|---|---|---|
| Exploratory UI audit | Traverse visible screens and overlays from the running app | Playwright MCP |
| State validation | Cross-check reachable states against source components | VS Code file inspection |
| Deliverable verification | Save descriptive screenshots to the audit folder | Playwright MCP |

## 3. Screenshot Coverage Matrix

| ID | Area | Target state | Expected evidence | Status |
|---|---|---|---|---|
| TC-01 | Main board | Default board view | Full board screenshot with current project and columns | 🔄 Running |
| TC-02 | Board content | Board with populated columns and cards | Tickets visible across board columns | ⬜ Pending |
| TC-03 | Ticket card | Normal and hover state | Card screenshots showing rest and hover visuals | ⬜ Pending |
| TC-04 | Ticket modal | Create form and validation state | Create modal open, plus validation feedback if reachable | ⬜ Pending |
| TC-05 | Ticket modal | Detail and edit states | View modal and edit mode screenshots | ⬜ Pending |
| TC-06 | Sidebar and panels | Sidebar, project form, members, recycle bin, settings | Panel screenshots for each reachable overlay | ⬜ Pending |
| TC-07 | Filters and alternate views | Search, priority filters, assignee filters, list, timeline | Screenshots of active controls and alternate views | ⬜ Pending |
| TC-08 | Special states | Empty, loading, drag/drop, narrow viewport, error/unavailable states | Saved screenshots or explicit gaps documented | ⬜ Pending |

## 4. Risks / Gaps To Check
- Empty board may require creating or filtering data rather than having a dedicated seeded state.
- Loading and backend error overlays may be transient or require environment manipulation.
- Native confirm/file chooser dialogs from settings/project deletion cannot be fully screenshotted through normal DOM capture.
- Dark mode may not exist in the current build.

## 5. Output Location
All screenshots must be written to `docs/ui-audit/screenshots/` with ordered descriptive filenames.