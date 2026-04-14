---
title: "Test Plan: Data Folder Settings and Import/Export"
type: test
status: review
version: 1.0.2
created: 2026-04-14
updated: 2026-04-14
authors: [GitHub Copilot]
related: []
---

# Test Plan: Data Folder Settings and Import/Export

## 1. Scope
This plan covers the Settings modal behavior for data folder management and the import/export controls exposed from the sidebar in the Vite UI.

Out of scope: backend persistence semantics beyond what is directly observable from the UI and the download/upload HTTP responses used by the tested flows.

## 2. Test Strategy

| Layer | Approach | Tools |
|---|---|---|
| E2E | Browser interaction against a fresh Vite URL with the current dev proxy config | Playwright MCP |
| HTTP verification | Inspect proxied responses for `/settings` and `/data/export` | Playwright network tools, curl |

## 3. Test Cases

| ID | Description | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|
| TC-01 | App loads at the target UI URL | UI available at fresh Vite URL | Navigate to the app | Board UI renders with project data | ✅ Pass |
| TC-02 | Open settings modal from sidebar | App is loaded | Click the sidebar settings button | Settings modal opens | ✅ Pass |
| TC-03 | Show current data folder path | Settings modal open | Inspect the Current row | Current path is visible and non-empty | ❌ Fail |
| TC-04 | Enable Apply for valid absolute path | Settings modal open | Enter a valid absolute path | Apply button becomes enabled | ✅ Pass |
| TC-05 | Disable Apply when input is cleared | Settings modal open after TC-04 | Clear the path input | Apply button becomes disabled | ✅ Pass |
| TC-06 | Clear status message on input edit | Successful apply status is visible | Edit the path input | Status message clears immediately | ✅ Pass |
| TC-07 | Export triggers a download | Settings modal open | Click Export Data | Download begins | ✅ Pass |
| TC-08 | Export download is a real ZIP | Export initiated | Inspect response headers and saved file | Download is ZIP content, not HTML | ❌ Fail |
| TC-09 | Import opens file picker | Settings modal open | Click Import Data | File picker opens | ✅ Pass |
| TC-10 | Non-ZIP import is rejected | File chooser requested | Select a non-.zip file | UI rejects the file and does not proceed | ✅ Pass |
| TC-11 | Valid ZIP import requires confirmation | File chooser requested | Select a valid .zip file | Confirmation dialog appears before import proceeds | ✅ Pass |

## 4. Edge Cases & Negative Tests
- [x] Empty path input disables submission
- [x] Status feedback clears when the user resumes editing
- [x] Export response was checked for silent HTML fallback
- [x] Non-`.zip` import shows an explicit rejection message
- [x] Valid `.zip` import triggers a confirmation step before any request is sent

## 5. Coverage Goals

| Area | Target |
|---|---|
| Sidebar settings entry point | 100% of requested checks |
| Data import/export controls | 100% of requested checks |

## 6. Test Data
Path input candidate: `/tmp/kanban-test-folder`

Valid ZIP import fixture: temporary local archive created at `.tmp/qc/import-sample.zip`

Invalid import fixture: `.tmp/qc/not-a-zip.txt`

## 7. Execution Notes
- Target UI URL: `http://127.0.0.1:5173`
- Target backend URL: `http://127.0.0.1:8000`
- Branch under test: `feat/data-folder-and-import-export`
- Dev server restart needed: no
- Browser evidence: settings modal screenshot captured during execution and removed after the run per QC cleanup rules

## 8. Results

Overall result: review required.

Observed behaviors:

- The app loaded normally at `http://127.0.0.1:5173`, and the Settings modal opened from the sidebar.
- The `Current:` row rendered with an empty value, so the current data folder path was not visible in the UI.
- Entering `/tmp/kanban-test-folder` enabled Apply. Clicking Apply returned `POST /settings/data-path => 200 OK` and showed a success message. Editing the field afterward cleared the status message. Clearing the field disabled Apply again.
- `GET /settings` from the Vite origin returned `200 OK` with `text/html`, and the body started with `<!doctype html>`, which matches the blank current-path behavior.
- Clicking Export Data started a browser download, but `GET /data/export` from the Vite origin returned `200 OK` with `content-type: text/html; charset=utf-8`, and the saved `kanban-export.zip` file contained the Vite HTML shell instead of ZIP bytes.
- Import UI behavior was correct: clicking Import Data opened a file chooser, selecting `.tmp/qc/not-a-zip.txt` showed `Error: Only .zip files are accepted.`, and selecting `.tmp/qc/import-sample.zip` triggered the native confirmation prompt before any import request was sent.

## 9. Findings

| ID | Severity | Finding |
|---|---|---|
| F-01 | High | The Settings modal opens, but the current data folder path is blank because `GET /settings` from the UI origin returns the Vite HTML shell instead of settings data. |
| F-02 | High | Export initiates a browser download, but the downloaded artifact is HTML rather than a ZIP file because `GET /data/export` from the UI origin is serving the Vite HTML shell. |