# C09 · Sketch and diagrams

**Bug file:** `bugs/09-sketch-and-diagrams.md` · **Bug ids:** `C09-001`, `C09-002`, …

**Persona:** Someone who draws a quick picture inside a page or a ticket.

**Goal:** The paint-style sketch editor and the draw.io diagrams.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/12-diagrams-sketch.md`
- `docs/specs/sketch-tool.md`
- `design/screens/sketch-tool.md`
- `design/screens/diagrams-drawio.md`

## Setup

A Docs page, a ticket description, a comment and an idea to put sketches into.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Insert from `/draw`, from the Sketch button, from the file viewer ("Draw on it"), in every place that allows it.
- [ ] Tools: pencil, brush, eraser, fill, picker, line and arrow, shapes, text, crop. Layers (add, hide, reorder, delete, the 10 layer limit), 100+ undo and redo steps, zoom and pan, pen pressure and touch if available, the 4096 px and 10 MB limits and their messages.
- [ ] Save, reopen and edit, the save conflict card when it changed elsewhere, drafts kept in the browser, closing with unsaved work, Esc.
- [ ] The AI panel without an AI: what it shows. The "Ask AI" button on an embedded sketch.
- [ ] Diagrams: create, edit in the editor, the offline case (the editor must say so), export, embed, the settings for the editor.

## Ask yourself

- Does the editor feel like a paint program, or does something fight the user (selection, undo, zoom)?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
