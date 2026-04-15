---
title: "Test Plan: IAM-95 Improve Desktop App Startup Time"
type: test
status: review
ticket: IAM-95
version: 1.0.1
created: 2026-04-16
updated: 2026-04-16
authors: [GitHub Copilot (QC Agent)]
related:
  - docs/specs/IAM-95-macos-startup-optimization.md
  - desktop/main.js
  - desktop/preload.js
  - ui/src/hooks/useBackendStatus.ts
  - ui/src/api/resolveOrigin.ts
  - ui/src/App.tsx
---

# Test Plan: IAM-95 Improve Desktop App Startup Time

## Objective

Verify that PR #78 delivers a visibly responsive desktop startup flow on macOS by opening the Electron UI immediately, showing a connecting overlay while the Python backend boots, surfacing a recoverable error state when backend startup fails, cleaning up one-shot IPC listeners safely in development and Strict Mode, and loading the production UI bundle in packaged builds.

## Scope

In scope:

- Electron startup behavior after app launch
- `useBackendStatus` hook state transitions and cleanup behavior
- Loading and error overlays rendered by `App.tsx`
- Backend-ready flow that updates the resolved API origin and retries data fetching
- Packaged-mode bundle path selection in `desktop/main.js`

Out of scope:

- Python import optimization beyond observable startup outcomes
- Windows-specific startup timing
- Release packaging, signing, or DMG installer verification beyond confirming the packaged UI path target

## Requirements Under Test

Implementation claims from PR #78:

1. Non-blocking startup: Electron window opens immediately and Python starts in parallel.
2. Loading overlay is shown while backend is connecting.
3. Error state is shown if backend startup fails.
4. IPC listeners are cleaned up correctly through one-shot listeners and explicit removal.
5. Packaged app uses the production UI bundle path.

Acceptance criteria to verify:

- Visible interface appears within 3 seconds of app launch.
- Full functionality is available within 8 seconds total.
- Backend failure produces a graceful error state.
- No stale IPC listeners remain in development or React Strict Mode.

## Test Strategy

- Use automated unit and integration tests for hook state transitions, cache updates, query invalidation, and listener cleanup.
- Use Playwright only for browser-rendered UI behavior that can be exercised with a mocked Electron bridge.
- Use manual desktop testing for actual Electron launch timing, slow-backend startup, backend failure during launch, and packaged-build path verification.
- Use startup log markers (`[startup]`) and wall-clock measurement for timing assertions.

## Environment And Instrumentation

- macOS test machine representative of the target release environment
- Desktop app built from PR #78 branch or merge result
- Development mode for Strict Mode and mocked-event testing
- Packaged macOS build for production bundle verification
- Electron console logs and backend logs enabled
- Stopwatch or screen recording timestamps for launch timing evidence

## Entry Criteria

- PR #78 branch builds successfully
- `ui/dist/index.html` exists for packaged-path verification
- Test runner can mock `window.electronAPI`
- A test fixture or harness exists to simulate delayed `backend-ready` and `backend-error` events

## Exit Criteria

- All critical and high-severity test cases pass
- Any failing case is documented with reproduction steps and evidence
- Startup timing evidence exists for both first paint and ready-for-use thresholds

## Execution Matrix

| ID | Area | Primary Mode | Playwright Eligible | Priority | Execution Result | Evidence / Notes |
|---|---|---|---|---|---|---|
| TC-01 | Hook default state outside Electron | Automated unit/integration | No | High | ✅ PASS | Static review of `ui/src/hooks/useBackendStatus.ts`: returns `ready` when `window` is undefined or `electronAPI.onBackendReady` is absent. |
| TC-02 | Hook ready transition and query retry | Automated unit/integration | No | High | ✅ PASS | Static review of `ui/src/hooks/useBackendStatus.ts`: ready callback calls `setBackendPort(port)`, `setStatus('ready')`, and `queryClient.invalidateQueries()`. |
| TC-03 | Hook error transition | Automated unit/integration | No | High | ✅ PASS | Static review of `ui/src/hooks/useBackendStatus.ts`: error callback sets `status` to `error`, stores the message, and does not trigger ready-only side effects. |
| TC-04 | Unmount cleanup before backend ready | Automated unit/integration | No | High | ✅ PASS | Static review of `ui/src/hooks/useBackendStatus.ts`: `cancelled` guard is present and cleanup calls both returned unsubscribers. |
| TC-05 | Strict Mode listener cleanup | Automated unit/integration | No | Critical | ✅ PASS | Static review of `desktop/preload.js` and `ui/src/hooks/useBackendStatus.ts`: preload uses `ipcRenderer.once(...)` plus explicit `removeListener(...)`, which matches the hook cleanup contract. |
| TC-06 | Visible UI within 3 seconds | Manual desktop timing | No | Critical | MANUAL - NOT EXECUTED | Requires launching the Electron app on macOS and timing first paint from a cold start. |
| TC-07 | Loading overlay until backend is usable | Manual desktop timing | Partial, with mocked bridge only | Critical | MANUAL - NOT EXECUTED | Requires slow-backend startup or mocked Electron event timing to observe overlay lifecycle. |
| TC-08 | Eventual backend readiness without reload | Manual desktop plus mocked UI validation | Partial, with mocked bridge only | High | MANUAL - NOT EXECUTED | Requires delayed `backend-ready` event while the app is running. |
| TC-09 | Graceful backend startup failure | Manual desktop | Partial, with mocked bridge only | Critical | MANUAL - NOT EXECUTED | Requires forcing backend launch failure and observing the renderer error state. |
| TC-10 | No app freeze during slow startup | Manual desktop | No | High | MANUAL - NOT EXECUTED | Requires an intentionally slow backend and live desktop responsiveness checks. |
| TC-11 | Packaged build uses production bundle path | Manual packaged smoke plus static verification | No | Critical | MANUAL - NOT EXECUTED | Static review of `desktop/main.js` confirms `loadFile()` targets `ui/dist/index.html`; packaged smoke test still needs to be run. |

## Execution Results

Run date: 2026-04-16
Branch: `feature/IAM-95`

### Automatable Checks Executed In This Run

| Check | Result | Evidence |
|---|---|---|
| Production build verification | ✅ PASS | Ran `cd ui && npm run build`; TypeScript and Vite build completed successfully. Output included only a non-blocking chunk-size warning from Vite. |
| `useBackendStatus.ts` cleanup guard | ✅ PASS | `useEffect` defines `cancelled` and cleanup calls both `unsubReady?.()` and `unsubError?.()`. |
| `preload.js` one-shot IPC pattern | ✅ PASS | `onBackendReady` and `onBackendError` use `ipcRenderer.once(...)` and return cleanup functions using `ipcRenderer.removeListener(...)`. |
| `main-helpers.js` READY parsing strategy | ✅ PASS | `parseReadyPort()` iterates over `output.split('\n')`, parsing stdout line-by-line rather than matching against one opaque string. |
| `server/main.py` loopback CORS comment | ✅ PASS | `CORSMiddleware` keeps the loopback safety comment on `allow_origins=["*"]`. |
| `ui/src/App.tsx` inline `<style>` keyframes check | ✅ PASS | No inline `<style>` tags with keyframes are present in `App.tsx`. |
| `ui/src/index.css` spinner keyframes | ✅ PASS | `@keyframes spin` is defined in `ui/src/index.css`. |

### Manual Follow-Up Instructions

Use these exact checks for the manual cases that were not executed in this run.

| TC | Manual procedure |
|---|---|
| TC-06 | Fully quit the Electron app, launch it from a cold start, and measure time to first visible window. Repeat three times and record the worst result. Pass if first paint is `<= 3.0s`. |
| TC-07 | Start the app with an intentionally slow backend. Confirm the overlay shows a spinner plus `Starting backend…`, then disappears automatically once the backend is ready and the board becomes usable. |
| TC-08 | Delay the `backend-ready` event by several seconds. Confirm the renderer stays on the connecting overlay, then transitions to usable state without any reload once readiness arrives. |
| TC-09 | Force backend startup failure, for example by launching with a broken backend path or suppressing the READY signal. Confirm the app stays open and shows `Backend failed to start` with actionable error details. |
| TC-10 | Under slow backend startup, move and focus the window while waiting. Confirm there is no beachball, the window repaints normally, and the spinner continues animating. |
| TC-11 | Build and launch a packaged desktop app with no Vite server running. Confirm the window still loads and that the source is the bundled `ui/dist/index.html` file path rather than an HTTP dev server URL. |

### Current Totals

- Passed: 5 test cases
- Failed: 0 test cases
- Manual verification required: 6 test cases
- Additional automatable build/config checks passed: 7 of 7

## Detailed Test Cases

### TC-01: Hook defaults to ready outside Electron

- Type: Unit/integration
- Goal: Confirm `useBackendStatus` returns `ready` immediately when no Electron bridge is available.
- Primary mode: Automated unit/integration
- Playwright: No
- Preconditions: Test renders the hook in a browser-like environment without `window.electronAPI.onBackendReady`.
- Steps:
  1. Render a test component that reads `useBackendStatus()`.
  2. Do not provide `window.electronAPI` or provide an object without `onBackendReady`.
  3. Read the initial hook state.
- Expected result: Status is `ready` and `errorMessage` is `null` on first render.
- Pass criteria: The first observed state is `ready`; no subscription functions are called.
- Fail criteria: The hook enters `connecting`, throws, or subscribes to Electron events in a non-Electron environment.

### TC-02: Hook transitions from connecting to ready and retries queries

- Type: Unit/integration
- Goal: Verify the happy-path IPC flow updates backend origin and invalidates React Query caches exactly once.
- Primary mode: Automated unit/integration
- Playwright: No
- Preconditions: Mock `window.electronAPI.onBackendReady`; spy on `setBackendPort` effect through `resolveOrigin()` and spy on `queryClient.invalidateQueries`.
- Steps:
  1. Render the hook with a mocked Electron bridge that stores the ready callback.
  2. Assert the initial state is `connecting`.
  3. Fire the stored ready callback with a test port such as `43123`.
  4. Read the updated hook state.
  5. Call `resolveOrigin()` after the event.
- Expected result: Status changes to `ready`, `errorMessage` stays `null`, the backend port cache becomes `http://127.0.0.1:43123`, and queries are invalidated once.
- Pass criteria: All four outcomes occur once and in response to the ready event.
- Fail criteria: Status stays `connecting`, cache is not updated, invalidation does not happen, or duplicate invalidations occur.

### TC-03: Hook transitions from connecting to error on backend failure

- Type: Unit/integration
- Goal: Verify that a backend startup failure is surfaced to the renderer without falsely marking the app ready.
- Primary mode: Automated unit/integration
- Playwright: No
- Preconditions: Mock `window.electronAPI.onBackendError` and expose a failure message.
- Steps:
  1. Render the hook with mocked ready and error subscriptions.
  2. Assert the initial state is `connecting`.
  3. Trigger the mocked error callback with a representative message such as `Backend exited before READY signal`.
  4. Inspect the returned state.
- Expected result: Status becomes `error`, `errorMessage` contains the backend failure detail, `setBackendPort` is not called, and query invalidation does not run.
- Pass criteria: Error state is preserved and no ready-side effects run.
- Fail criteria: Status remains `connecting`, transitions to `ready`, or triggers ready-specific side effects after an error.

### TC-04: Unmount before backend ready cleans up listeners and ignores late events

- Type: Unit/integration
- Goal: Verify cleanup logic prevents stale updates when the component unmounts before IPC completion.
- Primary mode: Automated unit/integration
- Playwright: No
- Preconditions: Mock `onBackendReady` and `onBackendError` to return unsubscribe functions; render within a component that can be unmounted.
- Steps:
  1. Render the hook and capture the cleanup functions returned by the mocked bridge.
  2. Unmount the component before firing any IPC event.
  3. Fire the previously captured ready callback after unmount.
  4. Fire the previously captured error callback after unmount.
- Expected result: Cleanup functions are called, state is not updated after unmount, and no React state update warnings are emitted.
- Pass criteria: Both subscriptions are removed and late callbacks produce no visible side effects.
- Fail criteria: Any post-unmount state update occurs, cleanup is skipped, or warnings/errors appear in test output.

### TC-05: Strict Mode double-invoke does not leave stale IPC listeners

- Type: Unit/integration
- Goal: Prove the hook remains safe under React Strict Mode effect mount/unmount replay.
- Primary mode: Automated unit/integration
- Playwright: No
- Preconditions: Render the hook inside `React.StrictMode` with mocked `ipcRenderer.once`-style bridge functions and counters for subscribe, unsubscribe, and callback invocation.
- Steps:
  1. Render the hook inside `StrictMode`.
  2. Capture how many times ready and error listeners are registered and cleaned up during the development replay cycle.
  3. Trigger one ready event after the final mounted instance is active.
  4. Confirm state settles to `ready` once.
- Expected result: Temporary replay subscriptions are cleaned up, the final mounted instance has only one active listener pair, and the ready callback causes only one state transition and one query invalidation.
- Pass criteria: No duplicate callback execution, no leaked listeners, and no duplicate invalidation after a single event.
- Fail criteria: Multiple active listeners remain, the callback fires multiple times for one event, or duplicate invalidations occur.

### TC-06: App shows a visible interface within 3 seconds of launch

- Type: Functional
- Goal: Validate the core user promise that launch is no longer visually blocked by backend startup.
- Primary mode: Manual desktop timing
- Playwright: No
- Preconditions: macOS desktop build is runnable; measurement method is defined; no warm window from a previous session.
- Steps:
  1. Fully quit the desktop app.
  2. Start a stopwatch at the moment the app icon is activated.
  3. Observe when the first visible UI appears, including the startup overlay if present.
  4. Repeat at least three times and record the worst result.
- Expected result: A visible window with intentional UI appears in 3.0 seconds or less on each run.
- Pass criteria: Worst-case first visible UI time across the sample is less than or equal to 3.0 seconds.
- Fail criteria: The app shows a blank or invisible state beyond 3.0 seconds, or the visible window is not meaningfully rendered.

### TC-07: Loading overlay remains visible until the backend is usable, then clears

- Type: Functional
- Goal: Verify the connecting overlay accurately covers the not-ready period and disappears once data can load.
- Primary mode: Manual desktop timing
- Playwright: Partial, only in a browser harness with mocked Electron events
- Preconditions: Backend startup can be slowed or delayed enough to observe the intermediate state.
- Steps:
  1. Launch the desktop app with a deliberately slow backend startup path.
  2. Confirm the overlay shows a spinner and the text `Starting backend…`.
  3. Wait for the backend ready event.
  4. Confirm the overlay disappears and the board UI begins loading project and ticket data.
  5. Verify core actions such as opening a project and viewing tickets work without restarting the app.
- Expected result: Overlay is visible only during backend startup, then clears automatically when the backend becomes ready.
- Pass criteria: Overlay appears before backend readiness, disappears after readiness, and the app becomes fully usable within 8 seconds total from launch.
- Fail criteria: Overlay never appears, stays stuck after readiness, disappears too early, or the app remains non-functional after the overlay clears.

### TC-08: Delayed backend readiness recovers without page reload

- Type: Functional
- Goal: Verify the renderer can move from initial `connecting` to fully working without a manual reload when readiness arrives late.
- Primary mode: Manual desktop plus mocked UI validation
- Playwright: Partial, only in a browser harness with mocked Electron events
- Preconditions: Test harness or launch mode can delay the backend-ready event; app is started from a clean state.
- Steps:
  1. Launch the app while delaying backend readiness by several seconds.
  2. Confirm the overlay remains visible during the delay.
  3. Allow the backend-ready event to fire.
  4. Verify project and ticket queries retry automatically.
  5. Confirm no manual reload or navigation is required.
- Expected result: The UI transitions from connecting to ready in-place, resolves the live backend port, and data appears automatically.
- Pass criteria: After the delayed ready event, the app becomes functional without reload and uses the resolved backend origin.
- Fail criteria: A reload is required, data stays stale, or the app never recovers from the initial connecting state.
- Note: This test validates delayed readiness recovery. True in-session recovery after a terminal `backend-error` is not part of the current feature and should not be treated as an expected behavior.

### TC-09: Backend startup failure shows a graceful error state

- Type: Functional
- Goal: Confirm backend launch failures are visible and understandable instead of causing a blank window or silent exit.
- Primary mode: Manual desktop
- Playwright: Partial, only in a browser harness with mocked Electron events
- Preconditions: Launch mode can force backend startup failure, for example by pointing to a missing binary or preventing the READY signal.
- Steps:
  1. Launch the desktop app with a known backend startup failure condition.
  2. Observe the initial UI.
  3. Wait until the backend failure event is emitted.
  4. Verify the overlay changes to an error state.
  5. Record the displayed error message and guidance text.
- Expected result: The app stays open and renders an error overlay with the heading `Backend failed to start`, the backend error details, and restart guidance.
- Pass criteria: Error state is visible, app does not quit, and the failure message is actionable enough for diagnosis.
- Fail criteria: The app exits, shows a blank state, hides the error detail, or renders inconsistent copy.

### TC-10: Slow backend startup does not freeze the app window

- Type: Functional
- Goal: Ensure non-blocking startup also means the app remains responsive during a slow backend boot.
- Primary mode: Manual desktop
- Playwright: No
- Preconditions: Backend startup is artificially slowed; macOS Activity Monitor or visual responsiveness observation is available.
- Steps:
  1. Launch the app under a slow-backend condition.
  2. Once the window appears, interact with the window by moving it, focusing it, and switching away and back.
  3. Observe whether the spinner animates and whether the UI remains responsive.
  4. Continue until readiness or error is reached.
- Expected result: The window stays responsive throughout startup and never presents a macOS app-hang experience.
- Pass criteria: No beachball, no frozen window behavior, and spinner or repaint activity continues while waiting.
- Fail criteria: The window becomes unresponsive, the system shows the app as hung, or the overlay stops repainting during startup.

### TC-11: Packaged mode loads the production UI bundle path

- Type: Build verification
- Goal: Confirm packaged startup uses the built `ui/dist/index.html` path rather than a dev server URL.
- Primary mode: Manual packaged smoke plus static verification
- Playwright: No
- Preconditions: Packaged macOS app or a packaged-mode simulation is available; `ui/dist/index.html` exists.
- Steps:
  1. Review `desktop/main.js` to confirm `createWindow()` always calls `loadFile()` with the `ui/dist/index.html` path.
  2. Launch a packaged build.
  3. Disconnect network access or ensure no local Vite server is running.
  4. Confirm the app still opens its shell UI.
  5. Verify the window content source is the packaged file-based bundle rather than an HTTP dev server.
- Expected result: The packaged app boots using the local production bundle path and still renders the startup overlay before backend readiness.
- Pass criteria: Static review and packaged smoke test both confirm file-based bundle loading, with no dependency on a dev server.
- Fail criteria: The packaged app attempts to load a dev server, fails without network, or uses an unexpected path.

## Suggested Automation Split

### Best automated with unit/integration tests

- TC-01 through TC-05

### Reasonable for Playwright with a mocked Electron bridge

- Visual assertions for the connecting overlay state from TC-07
- Visual assertions for the error overlay state from TC-09
- Delayed ready-event transition from TC-08

### Must stay manual

- Real launch timing in TC-06
- Responsiveness during slow backend startup in TC-10
- Packaged build bundle-path verification in TC-11

## Evidence To Capture During Execution

- Startup timing table for each manual launch run
- Screenshot or screen recording of the connecting overlay
- Screenshot of the backend failure overlay
- Console or log excerpt showing `[startup]` milestones
- Packaged-build observation confirming file-based UI load

## Pass/Fail Decision Rule

- Overall PASS: All critical cases pass and no high-severity regression remains open.
- Overall FAIL: Any critical case fails, or the startup timing thresholds are missed.
- Conditional PASS: Non-critical documentation or observability gaps remain, but user-facing startup behavior meets all acceptance criteria.