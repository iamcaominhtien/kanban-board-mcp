# Wave 3 fixes — docs (Docs, Canvas, Diagrams)

Report: [docs.md](../docs.md). Before (5174) and after (5173) screenshots: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w3/docs/` (`<ID>-before.jpg` / `<ID>-after.jpg`; not in the repo).
Data added for the checks: the draft page **[docs] W3 editor check** (KAN, An Nguyen's draft). Nothing existing was changed; no AI action was pressed (the new "AI" item of the selection bar was opened, none of its actions).

## Docs — page view
- DP-1 · Fixed — the breadcrumb has its own row (with "On this page" at narrow widths); the page actions sit beside the title and wrap under it when they do not fit, as drawn (`docs/DocsPageView.tsx`).
- DP-2 · Already fixed (wave 1); re-checked at 1100 px with the new layout: breadcrumb whole, ··· visible.
- DP-3 · Fixed (wave 4) — the last item reads "Delete page" (`docs/PageMenu.tsx`). Copy as Markdown and Page history stay in the tree row menu: one menu serves every page and removing them would lose a feature, so only the label changed.
- DP-4 · Fixed — the draft marker in the tree is the 7 px square (radius 2) (`docs/DocsTree.tsx`).

## Docs — editor
- ED-1 · Fixed — headings in the editor keep the reading view's top margins (the `* + *` reset zeroed them) and the first-child 6 px override is gone (`docs/editor/editor.css`).
- ED-2 · Fixed — one bar on a selection: the formatting bar gets an "AI ▾" item that swaps it for the AI selection bar (Improve, Shorten, Fix spelling, Explain, Ask…); the AI bar closes on a new selection or Esc (`docs/editor/BubbleToolbar.tsx`, `docs/editor/DocsEditor.tsx`). The AI bar component itself (`components/ai/editor/useEditorAi.tsx`) was not touched.
- ED-3 · Already fixed (wave 1).
- ED-4 · Fixed — UI serializer only: the editor's Markdown is written with compact tables (`| GET | /tickets |`, `| --- |`, alignment and `\|` kept) and single blank lines, fenced code untouched (`docs/editor/compactMarkdown.ts`, used in `DocsEditor.tsx`; test `compactMarkdown.test.ts`). No stored-data migration: pages saved before keep their padding until next edited.
- ED-5 · Fixed (wave 4) — Visual has an eye icon, Markdown a page icon, 14 px (`docs/DocsEditScreen.tsx`; no `<>` icon exists in LineIcon).
- ED-6 · Skipped — Low (wave 4): needs a trailing empty paragraph node added to the document, which changes what is saved.
- ED-7 · Skipped — Low (wave 4): not done.
- ED-10 · Skipped — Low (wave 4): not done.
- ED-8 · Fixed — the "Enter inserts" preview is part of the suggester card, above its footer, instead of a strip over the page (`docs/editor/RefSuggester.tsx`).
- ED-9 · Partly fixed — not reproduced (three "/dia" runs, no error); an error boundary now keeps an editor failure inside the edit screen with "Reload the editor" (the draft is kept) instead of blanking the app (`docs/editor/EditorErrorBoundary.tsx`, `DocsEditScreen.tsx`). Root cause still unknown.

## Docs — references
- RF-1 · Fixed (wave 4) — the summary counts distinct ticket ids; the list still shows every mention (`docs/ReferencedBy.tsx`).

## Docs — empty, loading and errors
- EM-1 · Fixed — the example key uses the project prefix ("tickets like MOB-12" in Mobile App) (`docs/DocsHero.tsx`, `docs/DocsView.tsx`).
- EM-2 · Skipped — Low (wave 4): the page has no admin name for the request; needs a server field. — Already fixed: the access state already names the first admin with an avatar ("Admin: Hoa Mai gets the request") from `admins` of `/docs/access`, and keeps "The board owner gets the request" when the project has no admin; the audit project had none. Test added (wave 5, `docs/NoAccess.admin.test.tsx`).

## Docs — page actions and history
- AC-1 · Fixed — a shared blank line no longer makes a new section "Changed": only unchanged text does, so "Example request" reads "Added" (`docs/DiffView.tsx`; test `DiffView.test.ts`).
- AC-2 · Fixed — an edited callout is marked as a whole: bar and "Changed in vN" outside its box, the inner paragraph's mark hidden (`docs/DocsMarkdown.tsx`, `docs/docs.css`). Tables were already marked on a wrapper outside the table.
- AC-3 · Fixed (wave 4) — Move to: title matches are listed before path-only matches (`docs/MoveToDialog.tsx`). The highlight was already an inline span with no padding.
- AC-4 · Fixed (wave 5) — A page has a slug path from its tree titles (`architecture/api`, `slug_path` on the page detail; `server/services/docs.py`). Share shows `?proj=<id>&docs=architecture/api` when the path is the page's own (two pages with the same path keep the id link), and keeps "Copy the link by page id" (`SharePopover.tsx`). Opening a slug link resolves it (`GET /projects/{id}/docs/by-path`, `DocsView.tsx`); `?docs=<uuid>` links open as before. A rename changes the path, and old paths keep resolving (the safer choice): each part may be a current title, a title the page had (the rename aliases `[[links]]` already keep) or the slug it got when made, which also covers a page moved elsewhere. The stored `slug` is unchanged (Markdown links use it). Tests: `server/tests/test_docs_slug_path.py`, `SharePopover.test.tsx`. Before: Skipped — Low (wave 4): pages have no slug field; needs a server field.

## Docs — search
- SR-1 · Fixed — while the find bar is open, the page view and the editor move down by the bar's height (it measures itself and sets `--dk-find-h`), so it no longer covers Share / Edit / ··· (`docs/FindInPage.tsx`, `docs/docs.css`, `DocsPageView.tsx`, `DocsEditScreen.tsx`). Comment numbers are skipped by find.
- SR-2 · Fixed (wave 4) — in ticket mode a key that matches exactly lists only that ticket; "1 page" is singular (`docs/SearchPalette.tsx`).
- SR-3 · Fixed (wave 4) — the footer count uses the same number as "Show all N results" (pages plus tickets) (`docs/SearchPalette.tsx`).
- SR-4 · Already fine (wave 4): the Ask tab is opened with the typed text (`initialQuestion={q}`). Not reproduced in code; not tried in a browser.

## Docs — comments
- CM-1 · Fixed — the comment number is an inline button right after the highlighted text (16 px, `vertical-align: 2px`, 3 px gap), so it never floats on the line above or on a table border; in the editor the number is `display: inline`, so it cannot wrap to its own line or grow the row (`docs/comments/useCommentHighlights.tsx`, `comments.css`; the rendered Markdown is keyed by its content in `DocsPageView.tsx` so React never edits a text node a number split).
- CM-2 · Fixed — composer header with the writer's avatar, "New comment" and ×; toolbar of 28 px tools B, I, code │ @, link, with attach / sketch / canvas / diagram behind "+"; hint "Enter to post · Shift Enter new line · Esc to cancel" (Enter is the real key) (`docs/comments/SelectionComment.tsx`, `CommentBox.tsx`, `comments.css`; test `CommentBox.more.test.tsx`).
- CM-3 · Fixed (wave 4) — the editor's Comments button has the tooltip "N inline · M on the page" (`docs/DocsEditScreen.tsx`).

## Diagrams — draw.io
- DG-1 · Fixed — the card says "Editor could not be reached" with the design copy for everyone, then Retry and "Download .drawio" (a new, unsaved drawing downloads what the editor holds); the docker / address hint folds into "For admins: no draw.io editor is running"; Use the built-in / public editor and Close are kept (`diagrams/DiagramEditor.tsx`, `Diagrams.module.css`; test updated).
- DG-2 · Fixed — the slash item reads "New draw.io drawing" ("diagram" kept as a keyword, so "/dia" still finds it) (`docs/editor/slashItems.ts`). The tile icon is unchanged (the slash tiles take Docs icon ids, not `DiagramIcon`).

## Docs AI
- AI-1 · Fixed (wave 5) — Docs AI is off by default for a new project: `create_project` writes the Docs AI row switched off (`server/services/projects.py`, model default `DocsAiSettings.enabled = False`). An existing project keeps its stored value, and one that never stored a row is given "on" on first use, as before (`services/docs_ai/settings.py`); no migration touches existing rows. Settings copy: "… Off by default." (`DocsAiSettings.tsx`). Tests: `server/tests/test_docs_ai_default_off.py`. Before: Skipped — the default is the server's (`server/models.py` `ai_enabled = True`); the copy matches the real default. Changing it is a server change.
- AI-2 · Fixed (wave 4) — hidden page: title "This page is hidden from AI", the design's hint, and a "Show to AI" button for editors (`docs/ai/PageAiMenu.tsx`, `useSetPageAiFlags`).
- AI-3 · Fixed (wave 4) — "Reads" and "Compare with" count only ticket keys that exist in the project (`docs/ai/PageAiMenu.tsx`).
- AI-4 · Skipped — Low (wave 4): not done.

## Canvas
- CA-1 · Skipped — server change (`server/services/canvases.py`, the canvas name drops the brackets). — Fixed (wave 5): a new canvas keeps the page title as typed for its name (line breaks and runs of spaces folded); the brackets are dropped only in the markdown alt text, on the server (`embed_line`) and in the canvas block's "link"/"embed" text. Existing canvases keep their names (`server/services/canvases.py` `canvas_name`, `canvas/useCanvasBlocks.tsx`).
- CA-2 · Fixed — one side panel at a time: opening History closes Boards / Comments, and opening either closes History (`canvas/CanvasEditor.tsx`).
- CA-3 · Fixed (wave 4) — a selected board has a 2 px blue outline (`canvas/Canvas.module.css`).
- CA-4 · Fixed (wave 4) — the "Empty frame" label is drawn in screen space at 14 px whatever the zoom (`canvas/CanvasEditor.tsx`, `BoardFrame.tsx` `hideEmptyLabel`).
