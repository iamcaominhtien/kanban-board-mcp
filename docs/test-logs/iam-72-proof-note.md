---
title: "Test Plan: IAM-72 Test Case Proof and Note Rendering"
type: test
status: stable
version: 1.0.1
created: 2026-04-09
updated: 2026-04-09
authors: [qc-agent]
related:
  - docs/test-iam-71-mcp-e2e.md
  - docs/ba-kanban-ui-spec.md
ticket: IAM-72
---

# Test Plan: IAM-72 Test Case Proof and Note Rendering

## Scope

Verify the IAM-72 UI fix for Test Cases rendering after MCP-driven `update_test_case` mutations. The regression target is the earlier IAM-71 failure where the UI showed the test case row and PASS state but did not render the updated `proof` and `note` values.

In scope:
- Ticket modal rendering for MCP-updated test cases
- Visibility of `status`, `proof`, and `note` values in the Test Cases section
- Regression of IAM-71-TC-028 on existing project `M71`

Out of scope:
- Creating or mutating test cases through the UI
- Re-running the full IAM-71 MCP tool suite
- Backend data validation beyond the UI's rendered state

## Test Strategy

| Layer | Goal | Tools |
|---|---|---|
| E2E regression | Re-run the previously failing IAM-71 test against the fixed UI | Playwright MCP |
| Visual verification | Confirm the row visibly renders all updated fields in the modal | Playwright snapshot |

## Preconditions

1. Local UI is reachable at `http://localhost:5173`.
2. Backend data already contains project `[TEST][IAM-71] MCP E2E Project` with ticket `M71-1`.
3. Ticket `M71-1` contains an MCP-created test case updated with:
   - `status = pass`
   - `proof = playwright://iam-71-proof.png`
   - `note = [TEST][IAM-71] Test case updated via MCP`

## Test Data

| Item | Value |
|---|---|
| Project | `[TEST][IAM-71] MCP E2E Project` |
| Ticket ID | `M71-1` |
| Source regression case | `IAM-71-TC-028` |
| Expected proof | `playwright://iam-71-proof.png` |
| Expected note | `[TEST][IAM-71] Test case updated via MCP` |

## Test Cases

| ID | Category | Description | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|
| IAM-72-TC-001 | Regression | Re-run IAM-71-TC-028 against the IAM-72 fix | Preconditions met | 1. Open the UI. 2. Select project `[TEST][IAM-71] MCP E2E Project`. 3. Open ticket `M71-1`. 4. Expand the Test Cases section and inspect the MCP-created test case row. | The test case appears exactly once, shows `PASS`, and visibly renders both `playwright://iam-71-proof.png` and `[TEST][IAM-71] Test case updated via MCP`. | ✅ Pass |

## Evidence

| TC | Evidence | Notes |
|---|---|---|
| IAM-72-TC-001 | Playwright accessibility snapshot captured with the expanded test-case row visible. The snapshot shows the row in `PASS` state plus visible `Proof` and `Note` textboxes containing the expected values. | No screenshot was needed because the accessibility snapshot was sufficient and no failure had to be documented. |

## Findings

| ID | Severity | Summary | Evidence | Status |
|---|---|---|---|---|
| — | — | No defects found in this regression run. | Playwright accessibility snapshot of the expanded Test Cases row. | Closed |

## Execution Result

- Result: Pass
- Observed project: `[TEST][IAM-71] MCP E2E Project`
- Observed ticket: `M71-1`
- Observed test case title: `[TEST][IAM-71] Test case added via MCP`
- Observed status: `PASS`
- Observed proof: `playwright://iam-71-proof.png`
- Observed note: `[TEST][IAM-71] Test case updated via MCP`

The Test Cases section now auto-expands the MCP-updated row and renders both metadata fields as visible form values under `Proof` and `Note`. This resolves the earlier IAM-71 regression where those values were not visible in the UI.