---
title: "Test Plan: IAM-85 Use Repo Logo in Desktop App and Web UI"
type: test
status: stable
ticket: IAM-85
version: 1.0.1
created: 2026-04-11
updated: 2026-04-11
executed: 2026-04-11
authors: [GitHub Copilot (QC Agent)]
related:
  - docs/assets/logo.svg
---

# Test Plan: IAM-85 Use Repo Logo in Desktop App and Web UI

## Scope

Validate the file-based deliverables for IAM-85:

- `ui/public/logo.svg` exists and contains SVG markup suitable for reuse as the web favicon source
- `ui/index.html` points the favicon link at `/logo.svg` and no longer references `/vite.svg`
- Desktop icon outputs exist under `desktop/build/` with the expected file types and minimum size thresholds
- `desktop/scripts/generate-icons.js` exists, parses successfully, uses `execFileSync` for `iconutil`, and does not keep the removed dead `const sizes =` variable

Out of scope:

- Browser rendering of the favicon in a running Vite session
- Pixel-perfect visual review of icon artwork
- Re-running the icon generation pipeline end to end

## Risk Focus

Highest-risk failure modes for this ticket:

1. The web app still references the old Vite favicon path and silently shows the wrong icon.
2. Generated desktop icon artifacts are missing, empty, or unexpectedly small, which would break packaging.
3. `generate-icons.js` regressed to shell-string execution or still contains stale code paths.

## Test Cases

| ID | Category | Description | Steps | Expected | Status |
|---|---|---|---|---|---|
| TC-1 | File validation | Validate `ui/public/logo.svg` exists and contains SVG markup | 1. Check file exists. 2. Read contents. 3. Verify `<svg` is present. | File exists and contains SVG root markup. | ✅ Pass |
| TC-2 | Configuration | Validate `ui/index.html` references `/logo.svg` and not `/vite.svg` | 1. Read `ui/index.html`. 2. Inspect favicon `href`. 3. Confirm `/vite.svg` is absent. | Favicon link targets `/logo.svg`; no `/vite.svg` reference remains. | ✅ Pass |
| TC-3 | Artifact validation | Validate `desktop/build/icon.png` exists and is a non-empty 512×512 PNG | 1. Check file exists. 2. Verify file size is greater than 10 KB. 3. Verify PNG type and dimensions. | PNG exists, size > 10 KB, dimensions are 512×512. | ✅ Pass |
| TC-4 | Artifact validation | Validate `desktop/build/icon.icns` exists and is non-empty | 1. Check file exists. 2. Verify file size is greater than 10 KB. | ICNS exists and size > 10 KB. | ✅ Pass |
| TC-5 | Artifact validation | Validate `desktop/build/icon.ico` exists and is non-empty | 1. Check file exists. 2. Verify file size is greater than 100 KB. | ICO exists and size > 100 KB. | ✅ Pass |
| TC-6 | Script validation | Validate `desktop/scripts/generate-icons.js` exists and is syntactically valid | 1. Check file exists. 2. Run syntax check. 3. Confirm `const sizes =` is absent. 4. Confirm `execFileSync` is used for `iconutil`. | Script exists, parses successfully, has no dead `const sizes =` variable, and uses `execFileSync`. | ✅ Pass |

## Execution Notes

Executed command set:

- `test`, `stat`, `file`, and `sips` for artifact presence, size, and dimensions
- `node --check` for script syntax validation
- `rg` and direct file reads for content assertions

## Executed Results

| ID | Result | Evidence |
|---|---|---|
| TC-1 | ✅ Pass | `ui/public/logo.svg` exists, contains `<svg`, and `xmllint --noout` succeeded |
| TC-2 | ✅ Pass | `ui/index.html` contains `<link rel="icon" type="image/svg+xml" href="/logo.svg" />`; no `/vite.svg` match found |
| TC-3 | ✅ Pass | `desktop/build/icon.png` size = `14697` bytes; `file` reports `PNG image data, 512 x 512`; `sips` reports `pixelWidth: 512`, `pixelHeight: 512` |
| TC-4 | ✅ Pass | `desktop/build/icon.icns` size = `119327` bytes |
| TC-5 | ✅ Pass | `desktop/build/icon.ico` size = `370070` bytes |
| TC-6 | ✅ Pass | `node --check desktop/scripts/generate-icons.js` succeeded; `const sizes =` not present; `execFileSync('iconutil', ...)` present |

## Overall Result

Overall QC result: ✅ Pass.

All six requested file-based acceptance checks passed. No bugs were found during this QC run.

## Bug Log

| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| None | — | No bugs found during execution. | — | — |