# C06 · Git branches and worktrees

**Bug file:** `bugs/06-git.md` · **Bug ids:** `C06-001`, `C06-002`, …

**Persona:** A developer who links tickets to real branches.

**Goal:** Everything that touches a real git repository. Use a throw-away repository, never a real one.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/09-branches.md`
- `design/components/branches.md`
- `design/screens/settings-pages.md`

## Setup

Create a local git repository with a `main` branch and a few commits, and a second one with no commits. Set it up in Settings › Repositories.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Link a project to a repository: a folder that is not a repository, a missing folder, a repository with no commits, a path with spaces.
- [ ] Create a branch from a ticket (naming, a name that already exists, an invalid name), link an existing branch, unlink.
- [ ] Commit graph against main: many commits, a branch that is behind, ahead, merged, deleted outside the app, a detached HEAD.
- [ ] Check out from the UI with uncommitted changes (the user must be warned and nothing lost).
- [ ] Worktrees: create, list, open, remove; the defaults in Settings.
- [ ] Windows-style paths in the messages, if visible; long error messages from git: are they readable?

## Ask yourself

- Is every destructive git action explained before it happens?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
