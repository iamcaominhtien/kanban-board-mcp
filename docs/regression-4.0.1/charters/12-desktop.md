# C12 · Desktop app

**Bug file:** `bugs/12-desktop.md` · **Bug ids:** `C12-001`, `C12-002`, …

**Persona:** A desktop user. Needs a packaged build.

**Goal:** The Electron shell. A cloud AI cannot run this; the tester must have a packaged app, or else test only `desktop/tests` and say so.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/19-desktop.md`
- `design/screens/desktop-menu.md`
- `desktop/build/README.md`

## Setup

A packaged build on the target system. If none is available, mark the whole charter `not run` in the first line of its bug file and stop.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Start, splash, "Connecting…", Try again, the backend failing to start, closing and reopening.
- [ ] The menu bar: every item, the accelerators, the greyed items while the backend is off, what changes on macOS with no window open.
- [ ] The four small windows: Keyboard Shortcuts, What's New, Report an Issue (it must send nothing), About.
- [ ] Check for Updates (manual and automatic), the corner notice, Settings › Updates.
- [ ] Logs: open the folder, export; Copy Diagnostics Info has no tickets, paths, keys or logs.
- [ ] Data folder, import and export, an upgrade over an older install keeps the data.
- [ ] Windows: a long prompt to AI by stdin, paths with spaces and non-ASCII names.

## Ask yourself

- Does it feel like a desktop app, or like a web page in a frame?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
