# C07 · Docs space

**Bug file:** `bugs/07-docs.md` · **Bug ids:** `C07-001`, `C07-002`, …

**Persona:** A writer who keeps project pages and a team that reads them.

**Goal:** The page tree, the editor, versions, references, comments, search, import and export.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/10-docs.md`
- `docs/guideline/guide/chapters/11-references.md`
- `design/screens/docs-page.md`
- `design/screens/docs-editor.md`
- `design/screens/docs-actions.md`
- `design/screens/docs-references.md`
- `design/screens/docs-comments.md`
- `design/screens/docs-search.md`
- `design/screens/docs-empty.md`
- `docs/specs (any docs spec)`

## Setup

A project with a tree three levels deep, a page with 30 sections and a table, and a page with ten versions.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Page tree: create, nest, move by drag, rename, duplicate, delete (and the Recycle Bin), collapse and expand and whether it is remembered, a very long title, a deep tree.
- [ ] Editor: the same checks as the ticket description plus slash commands, `[[page#section]]` links and their picker, `/draw`, diagrams, tables, callouts if any, drag handle, find in page (Ctrl/⌘+F), autosave, drafts, closing with unsaved changes, two tabs editing one page (the conflict).
- [ ] Versions: save, list, diff, restore, the "Changes since you last viewed" banner, the eye switch for the change markers, a restore that is then undone.
- [ ] References: ticket keys in a page, backlinks on the page and on the ticket, a link to a deleted page, a renamed page.
- [ ] Comments on a page: threads on a selection, resolve, reply, mention.
- [ ] Follow a page, Hide from AI.
- [ ] Who can edit: viewers versus members, what a viewer sees and cannot do.
- [ ] Search: titles, body, ranking, zero results, special characters, Vietnamese diacritics with and without marks.
- [ ] Import and export: markdown files, a folder, a bad file, a huge file; export and read it back.
- [ ] Empty states: empty project, empty page.

## Ask yourself

- Is it safe to type? Could anything the user typed disappear?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
