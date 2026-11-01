# C01 · First run and projects

**Bug file:** `bugs/01-first-run.md` · **Bug ids:** `C01-001`, `C01-002`, …

**Persona:** A new user who has never seen the app, then a user with several projects.

**Goal:** Check the very first impression and everything about creating, switching, editing and deleting projects.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/02-install.md`
- `docs/guideline/guide/chapters/03-quick-start.md`
- `design/screens/app-loading.md`
- `design/screens/splash.md`
- `design/screens/main-board.md`

## Setup

Run twice: once on an empty database, once with three projects of different sizes (empty, 5 tickets, 300 tickets).

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Splash and loading states: what shows while the server starts, and when it is slow or down (stop the server before opening). The Try again action.
- [ ] First-run project creation: empty name, duplicate key, key with lowercase or spaces, long name, Vietnamese name.
- [ ] Project sidebar: switch, rename, change colour, reorder if possible, delete (what is asked, what is lost, can it be undone).
- [ ] Which project is active after a reload, after the last project is deleted, and after opening a deep link to a ticket of another project.
- [ ] Update-required notice when the UI is older than the server (`MIN_SUPPORTED_UI_VERSION`).
- [ ] Members panel: add, rename, remove a member; what happens to their tickets and comments.
- [ ] Account menu and its items.

## Ask yourself

- Is it clear what to do on an empty board, an empty project, an empty column?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
