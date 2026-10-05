---
title: "Test Plan: PR-95 B&W TV Theme Toggle"
type: test
status: stable
ticket: PR-95
version: 1.1.0
created: 2026-04-18
updated: 2026-04-18
authors: [GitHub Copilot (QC Agent)]
related: []
---

# Test Plan: PR-95 B&W TV Theme Toggle

## Scope

Write black-box test coverage for the Settings-panel theme toggle that switches the Kanban Board between the default color theme and a B&W TV theme.

In scope:

- Toggle control visibility and user-facing label in both theme states.
- Visual application and removal of the grayscale effect.
- Theme persistence across page reloads.
- First-load default behavior for users with no saved preference.
- Fallback behavior when stored theme data is invalid.

Out of scope:

- Source-code inspection.
- Cross-browser differences.
- Mobile or tablet layout behavior.

## Test Approach

- Black-box UI validation on the running Kanban Board app.
- Use the Settings panel and browser storage controls only as needed to set up theme-state scenarios.
- Validate the visible page state and the applied `html` filter value from the browser environment during execution.

## Test Data Strategy

- No server-side data setup is required.
- Browser localStorage key under test: `theme`.
- Valid values under test: `default`, `bw`.
- Invalid-value scenario example: `retro`.

## Test Cases

| Test ID | Description | Steps | Expected Result |
|---|---|---|---|
| TC-BW-01 | Verify the toggle button is visible and shows the correct label when the app is in color mode. | 1. Clear the `theme` entry from browser localStorage. 2. Open or reload the Kanban Board app. 3. Open the Settings panel. 4. Locate the theme toggle control. | The toggle button is visible in the Settings panel. Its label clearly indicates the action to switch from color mode to B&W mode. The current page remains in color. |
| TC-BW-02 | Verify the toggle button label updates correctly when B&W mode is active. | 1. Start from color mode. 2. Open the Settings panel. 3. Activate the theme toggle to switch to B&W mode. 4. Observe the toggle control text after the mode changes. | The toggle remains visible after switching themes. Its label updates to indicate the action to switch back to color mode. |
| TC-BW-03 | Verify B&W mode applies the grayscale visual effect to the page. | 1. Start from color mode. 2. Open the Settings panel. 3. Enable B&W mode with the toggle. 4. Observe the board visually. 5. Inspect the computed style for the `html` element filter in the browser environment. | The full page renders in grayscale with slightly increased contrast. The `html` element has the filter value `grayscale(100%) contrast(1.05)` applied. |
| TC-BW-04 | Verify switching back to color mode removes the grayscale visual effect. | 1. Start with B&W mode active. 2. Open the Settings panel. 3. Use the toggle to switch back to color mode. 4. Observe the board visually. 5. Inspect the computed style for the `html` element filter in the browser environment. | Full color is restored across the page. The `html` element no longer has the B&W grayscale filter applied. |
| TC-BW-05 | Verify the selected theme persists across page reloads after enabling B&W mode. | 1. Start from color mode. 2. Enable B&W mode from the Settings panel. 3. Confirm the page has switched to B&W mode. 4. Reload the page. 5. Reopen the Settings panel after reload. | The app reloads directly in B&W mode without briefly showing the color theme first. The toggle label still indicates that the next action would switch back to color mode. The stored preference remains effective after reload. |
| TC-BW-06 | Verify the selected theme persists across page reloads after switching back to color mode. | 1. Start with B&W mode active. 2. Use the Settings toggle to switch back to color mode. 3. Confirm the page is back in color. 4. Reload the page. 5. Reopen the Settings panel after reload. | The app reloads directly in color mode without applying the grayscale effect. The toggle label indicates that the next action would switch to B&W mode. The stored preference remains effective after reload. |
| TC-BW-07 | Verify a first-time user sees color mode by default. | 1. Clear the `theme` entry from browser localStorage. 2. Open the app in a fresh browser context or reload the page. 3. Observe the page immediately on load. 4. Open the Settings panel. | The app loads in color mode by default. No grayscale effect is visible. The Settings panel presents the toggle in the color-mode state. |
| TC-BW-08 | Verify an invalid localStorage theme value falls back to color mode. | 1. Set browser localStorage `theme` to an invalid value such as `retro`. 2. Reload the app. 3. Observe the page immediately after load. 4. Open the Settings panel. 5. Inspect the computed style for the `html` element filter in the browser environment. | The app falls back to color mode instead of attempting an unsupported theme. No grayscale filter is applied to the `html` element. The toggle is visible and presented in the color-mode state. |

## Execution Results

Execution date: 2026-04-18

Environment:

- App URL: `http://localhost:5173`
- Browser automation: Playwright MCP
- Execution mode: black-box UI testing with runtime checks for localStorage and computed `html` filter

Summary:

- Passed: 8
- Failed: 0

| Test ID | Result | Observation |
|---|---|---|
| TC-BW-01 | ✅ Pass | With no saved theme, the Settings panel showed `📺 Switch to B&W`, localStorage resolved to `default`, and the computed `html` filter was `none`. |
| TC-BW-02 | ✅ Pass | After enabling B&W mode, the toggle remained visible and changed to `🎨 Switch to Color`. |
| TC-BW-03 | ✅ Pass | The page rendered in grayscale during the visual check. The computed `html` filter was `grayscale(1) contrast(1.05)`, which is the browser-normalized form of `grayscale(100%) contrast(1.05)`. |
| TC-BW-04 | ✅ Pass | Switching back to color removed the grayscale effect. The computed `html` filter returned to `none`, localStorage became `default`, and the toggle text returned to `📺 Switch to B&W`. |
| TC-BW-05 | ✅ Pass | After enabling B&W mode and reloading, the app reopened in B&W mode with localStorage `bw`, toggle text `🎨 Switch to Color`, and `html` filter `grayscale(1) contrast(1.05)`. Early-frame samples captured after reload all stayed in grayscale, so no color flash was observed. |
| TC-BW-06 | ✅ Pass | After switching back to color and reloading, the app reopened in color mode with localStorage `default`, toggle text `📺 Switch to B&W`, and `html` filter `none`. Early-frame samples after reload all remained `none`, so no grayscale flash was observed. |
| TC-BW-07 | ✅ Pass | Clearing the `theme` key and reloading produced the default color mode again. The Settings panel showed `📺 Switch to B&W`, and the computed `html` filter stayed `none`. |
| TC-BW-08 | ✅ Pass | Seeding localStorage with invalid value `retro` fell back to color mode on reload. The computed `html` filter was `none`, the Settings panel showed `📺 Switch to B&W`, and storage normalized back to `default`. |

## Execution Notes

- All test cases were executed against the running dev server.
- No functional failures or console errors were observed during the run.
- The computed CSS filter string was reported by the browser as `grayscale(1) contrast(1.05)`, which is the normalized computed-style equivalent of `grayscale(100%) contrast(1.05)`.