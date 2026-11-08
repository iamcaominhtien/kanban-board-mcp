# C14 · Upgrade and data safety

**Bug file:** `bugs/14-upgrade.md` · **Bug ids:** `C14-001`, `C14-002`, …

**Persona:** A user who already has months of data and installs the new version.

**Goal:** Nothing the user already has may be lost or changed by upgrading. This is the highest risk of a release.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/21-data.md`
- `server/alembic/versions (the newest migrations)`
- `server/tests/test_data_import_and_legacy_db.py`

## Setup

Old data: build a database with the previous release (check out its tag, run it, fill it by the UI and the MCP), plus any older database or export file the maintainer can provide. Keep a copy of every starting file.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Start the new server on a copy of the old database: it migrates once, starts, and keeps every ticket, comment, doc page and version, idea, sketch, attachment, member, setting, AI member and schedule.
- [ ] Start it again: no second migration, no error. Start the old version on the migrated copy and note what happens (a clear message is enough).
- [ ] Open the oldest data you can find, one release at a time.
- [ ] Export from the old version and import into the new; export from the new and import into a new, empty install.
- [ ] Uploads and workspace folders still resolve (images in descriptions, attachments, sketches, idea folders).
- [ ] A database that is locked, read-only, empty or corrupt: the message and what is left intact.
- [ ] The keys of AI members survive (or the user is told clearly to enter them again).
- [ ] `MIN_SUPPORTED_UI_VERSION`: an old browser tab after the server is upgraded shows the update-required notice and does not corrupt data.

## Ask yourself

- After upgrading, would the user trust the app with the rest of their data?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
