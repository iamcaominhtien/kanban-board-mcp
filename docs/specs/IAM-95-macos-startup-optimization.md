# IAM-95: macOS Desktop App Startup Performance Improvement

## 1. Problem Statement
The current macOS desktop application experiences a noticeable delay during startup. The UI remains blocked or unresponsive while the Electron main process initializes the Python MCP server and its environment. As the project grows, heavy imports and synchronous initialization steps in the Python backend further degrade the initial user experience.

## 2. Measurable Goals
- **Time to First Paint (TTFP):** Under 1.5 seconds from app launch.
- **Python Backend Readiness:** Fully functional within 3 seconds of UI appearance.
- **Binary Size Impact:** No significant increase (>5%) in the final `.dmg` size.

## 3. Scope
- **Instrumentation:** Adding telemetry to track startup phases.
- **UI Non-blocking Startup:** Decoupling the Electron window reveal from the backend readiness.
- **Python Import Optimization:** Reducing the number of eager imports in the MCP server.
- **Optional launchd:** Evaluating background persistence for faster "warm" starts.

## 4. Non-Goals
- Complete rewrite of the backend in a compiled language (e.g., Rust/Go).
- Optimizing deep internal business logic execution (focus is on *startup*).

## 5. Acceptance Criteria
- [ ] UI displays a loading state or "Instant UI" within 1.5s on macOS.
- [ ] Python server logs show "Readiness reached" within 3s.
- [ ] No "App Not Responding" (spinning beachball) during the entire startup sequence.
- [ ] Telemetry successfully reports `startup_duration_ms` to local logs/memory.

## 6. Phased Implementation Plan

### Phase 1: Instrumentation
- Implement a `StartupProfiler` in the Electron main process and Python server.
- Log timestamps for: App Launch, IPC Init, Python Spawn, Python Ready, UI Ready.

### Phase 2: UI Non-blocking Startup
- Show the React window immediately (main process `ready-to-show` event).
- Implement a "Connecting to Backend..." overlay in the UI to handle the lag gracefully.
- Move heavy IPC setup to an async block that doesn't block the Electron event loop.

### Phase 3: Python Import Optimization
- Switch to `lazy_import` or delayed imports for heavy libraries (e.g., `alembic`, `pandas` if used, or deep sub-modules).
- Audit `server/main.py` to ensure only essential modules are imported at the top level.

### Phase 4: Launchd / Background Persistence (Optional)
- Explore a daemon-like mode where the Python server can persist as a background process controlled by `launchd` on macOS.

## 7. Risks & Mitigation
- **Race Conditions:** UI may try to call tools before Python is ready. *Mitigation: Implement a request queue/retry mechanism in the MCP client.*
- **Version Mismatch:** Background processes might be stale after an update. *Mitigation: Include a signature check/version handshake on connect.*

## 8. Test Requirements
- **Cold Boot Test:** Restart OS, launch app, measure TTFP.
- **Warm Boot Test:** Close app, wait 5s, relaunch, measure TTFP.
- **Stress Test:** Simulate slow disk I/O to ensure the UI remains responsive (no beachball).
