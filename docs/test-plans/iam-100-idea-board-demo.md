---
title: "Test Plan: IAM-100 Idea Board Live Demo"
type: test
status: review
version: 1.1.0
created: 2026-04-22
updated: 2026-04-22
authors: [GitHub Copilot]
related:
  - docs/specs/IAM-100-idea-board-spec.md
---

# Test Plan: IAM-100 Idea Board Live Demo

## 1. Scope
Validate the shipped Idea Board flow in the live UI at http://localhost:5173 using black-box end-to-end checks.

In scope:
- BoardSwitcher navigation between Board and Idea Board
- Create, view, edit, approve, promote, drop, and drag interactions for idea cards
- User-visible validation behavior for missing required data and locked approved ideas
- Browser console health during the exercised flows

Out of scope:
- Source-code inspection
- API contract verification beyond what the UI exposes
- Non-Idea Board project management flows

## 2. Environment

| Item | Value |
|---|---|
| Target URL | http://localhost:5173 |
| Feature | IAM-100 Idea Board |
| Test data rule | All created ideas must use the `[TEST]` title prefix |
| Execution method | Playwright MCP, manual black-box validation |

## 3. Test Cases

| ID | Category | Description | Steps | Expected Result | Status |
|---|---|---|---|---|---|
| TC-01 | Happy Path | Switch from the main board to the Idea Board and back | 1. Open the app. 2. Select a project. 3. Use BoardSwitcher to open Ideas. 4. Switch back to Board. | Both views open from the same project context, active state changes correctly, and no console errors appear. | ✅ Pass |
| TC-02 | Happy Path | Create a draft idea card | 1. Open Idea Board. 2. Start a new idea. 3. Enter title `[TEST] Demo idea A` with optional metadata. 4. Submit. | A new draft card appears in the draft column with the entered title and visible card styling. | ✅ Pass |
| TC-03 | Negative | Prevent creating an idea without a required title | 1. Start a new idea. 2. Leave title empty. 3. Try to submit. | Creation is blocked, a validation cue appears, and no new idea card is created. | ✅ Pass |
| TC-04 | Happy Path | Open the IdeaTicketModal from a draft card | 1. Click a draft idea card. 2. Inspect the modal content. | The modal opens with title, description, tags, emoji/color metadata, and actions appropriate for a draft idea. | ✅ Pass |
| TC-05 | Happy Path | Edit draft idea title, description, and tags, then save | 1. Open `[TEST] Demo idea A`. 2. Update title, description, and tags. 3. Save. 4. Reopen the idea. | The updated values persist on the card and in the modal after reopening. | ❌ Fail |
| TC-06 | Happy Path | Approve an idea from the modal flow | 1. Open an editable idea. 2. Move it through the approval action. 3. Confirm the new state. | The idea moves to the Approved column or equivalent approved state and shows approved/locked UI treatment. | ✅ Pass |
| TC-07 | Negative | Prevent editing locked content on an approved idea | 1. Open an approved idea. 2. Attempt to change title, description, or tags. 3. Try to save. | Locked content cannot be edited or saved, and the UI communicates the read-only restriction. | ✅ Pass |
| TC-08 | Happy Path | Promote an approved idea to the main board | 1. Open an approved idea. 2. Start promotion. 3. Confirm promotion. 4. Follow the resulting board state. | Promotion succeeds, the idea shows a promoted state or linked main-board ticket, and the promoted item appears on the main board/backlog. | ❌ Fail |
| TC-09 | Happy Path | Drop a draft idea | 1. Create a second idea titled `[TEST] Demo idea B`. 2. Open it. 3. Trigger Drop and confirm if prompted. | The idea moves to the Dropped column or equivalent dropped state and is no longer treated as active draft work. | ✅ Pass |
| TC-10 | Boundary | Drag a draft card to the Approved column | 1. Create a third idea titled `[TEST] Demo idea C`. 2. Drag it from Draft to Approved. 3. Observe the resulting state. | The card either lands in Approved successfully with visible status change, or the UI rejects the action clearly without data corruption. | ❌ Fail |

## 4. Bug Log

| Bug ID | TC | Description | Severity | Evidence | Ticket |
|---|---|---|---|---|---|
| BUG-01 | TC-05 | Tags entered on a draft idea do not persist after save and reopen. | Medium | Reopened approved modal showed `No tags.` even after saving `qc-demo,iam100`; title and description persisted, tags did not. | Not created |
| BUG-02 | TC-08 | Promoting one approved idea produced duplicate outcomes: the idea remained as a draft copy, moved a dropped copy to Idea Board, and created two backlog tickets with the same title on the main board. | High | After confirmation, Idea Board showed the same title in both Draft and Dropped; main board backlog showed two `[TEST] Demo idea A edited` tickets. | Not created |
| BUG-03 | TC-10 | Dragging a draft card to Approved performed a visible drag gesture but left the card in Draft without moving it or showing a rejection message. | Medium | `[TEST] Demo idea C` remained in Draft with Approved count still `0` after drag. | Not created |

## 5. Execution Notes
- Capture screenshots before and after each major interaction.
- Review browser console after each test case.
- Clean up any created `[TEST]` ideas if the UI supports deletion or archival cleanup.

## 6. Execution Result

| Metric | Result |
|---|---|
| Total test cases executed | 10 |
| Passed | 7 |
| Failed | 3 |
| Bugs identified | 3 |

Run notes:
- Browser console checks during the exercised flows returned no new error-level messages.
- Board switching worked in both directions, but the view change back to the main board required an additional settle delay before it became visible.
- Test data created during execution: `[TEST] Demo idea A`, `[TEST] Demo idea B`, `[TEST] Demo idea C` and their derived promoted artifacts.