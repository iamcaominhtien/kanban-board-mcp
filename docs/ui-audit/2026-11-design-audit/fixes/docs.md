# Wave 3 fixes — docs (Docs, Canvas, Diagrams)

Report: [docs.md](../docs.md). Before (5174) and after (5173) screenshots: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w3/docs/` (`<ID>-before.jpg` / `<ID>-after.jpg`; not in the repo).
Data added for the checks: the draft page **[docs] W3 editor check** (KAN, An Nguyen's draft). Nothing existing was changed; no AI action was pressed (the new "AI" item of the selection bar was opened, none of its actions).

## Docs — page view
- DP-1 · Fixed — the breadcrumb has its own row (with "On this page" at narrow widths); the page actions sit beside the title and wrap under it when they do not fit, as drawn (`docs/DocsPageView.tsx`).
- DP-2 · Already fixed (wave 1); re-checked at 1100 px with the new layout: breadcrumb whole, ··· visible.
- DP-3 · Skipped — Low.
- DP-4 · Fixed — the draft marker in the tree is the 7 px square (radius 2) (`docs/DocsTree.tsx`).

## Docs — editor
- ED-1 · Fixed — headings in the editor keep the reading view's top margins (the `* + *` reset zeroed them) and the first-child 6 px override is gone (`docs/editor/editor.css`).
- ED-2 · Fixed — one bar on a selection: the formatting bar gets an "AI ▾" item that swaps it for the AI selection bar (Improve, Shorten, Fix spelling, Explain, Ask…); the AI bar closes on a new selection or Esc (`docs/editor/BubbleToolbar.tsx`, `docs/editor/DocsEditor.tsx`). The AI bar component itself (`components/ai/editor/useEditorAi.tsx`) was not touched.
- ED-3 · Already fixed (wave 1).
- ED-4 · Fixed — UI serializer only: the editor's Markdown is written with compact tables (`| GET | /tickets |`, `| --- |`, alignment and `\|` kept) and single blank lines, fenced code untouched (`docs/editor/compactMarkdown.ts`, used in `DocsEditor.tsx`; test `compactMarkdown.test.ts`). No stored-data migration: pages saved before keep their padding until next edited.
- ED-5, ED-6, ED-7, ED-10 · Skipped — Low.
- ED-8 · Fixed — the "Enter inserts" preview is part of the suggester card, above its footer, instead of a strip over the page (`docs/editor/RefSuggester.tsx`).
- ED-9 · Partly fixed — not reproduced (three "/dia" runs, no error); an error boundary now keeps an editor failure inside the edit screen with "Reload the editor" (the draft is kept) instead of blanking the app (`docs/editor/EditorErrorBoundary.tsx`, `DocsEditScreen.tsx`). Root cause still unknown.

## Docs — references
- RF-1 · Skipped — Low.

## Docs — empty, loading and errors
- EM-1 · Fixed — the example key uses the project prefix ("tickets like MOB-12" in Mobile App) (`docs/DocsHero.tsx`, `docs/DocsView.tsx`).
- EM-2 · Skipped — Low.

## Docs — page actions and history
- AC-1 · Fixed — a shared blank line no longer makes a new section "Changed": only unchanged text does, so "Example request" reads "Added" (`docs/DiffView.tsx`; test `DiffView.test.ts`).
- AC-2 · Fixed — an edited callout is marked as a whole: bar and "Changed in vN" outside its box, the inner paragraph's mark hidden (`docs/DocsMarkdown.tsx`, `docs/docs.css`). Tables were already marked on a wrapper outside the table.
- AC-3, AC-4 · Skipped — Low.

## Docs — search
- SR-1 · Fixed — while the find bar is open, the page view and the editor move down by the bar's height (it measures itself and sets `--dk-find-h`), so it no longer covers Share / Edit / ··· (`docs/FindInPage.tsx`, `docs/docs.css`, `DocsPageView.tsx`, `DocsEditScreen.tsx`). Comment numbers are skipped by find.
- SR-2, SR-3, SR-4 · Skipped — Low.

## Docs — comments
- CM-1 · Fixed — the comment number is an inline button right after the highlighted text (16 px, `vertical-align: 2px`, 3 px gap), so it never floats on the line above or on a table border; in the editor the number is `display: inline`, so it cannot wrap to its own line or grow the row (`docs/comments/useCommentHighlights.tsx`, `comments.css`; the rendered Markdown is keyed by its content in `DocsPageView.tsx` so React never edits a text node a number split).
- CM-2 · Fixed — composer header with the writer's avatar, "New comment" and ×; toolbar of 28 px tools B, I, code │ @, link, with attach / sketch / canvas / diagram behind "+"; hint "Enter to post · Shift Enter new line · Esc to cancel" (Enter is the real key) (`docs/comments/SelectionComment.tsx`, `CommentBox.tsx`, `comments.css`; test `CommentBox.more.test.tsx`).
- CM-3 · Skipped — Low.

## Diagrams — draw.io
- DG-1 · Fixed — the card says "Editor could not be reached" with the design copy for everyone, then Retry and "Download .drawio" (a new, unsaved drawing downloads what the editor holds); the docker / address hint folds into "For admins: no draw.io editor is running"; Use the built-in / public editor and Close are kept (`diagrams/DiagramEditor.tsx`, `Diagrams.module.css`; test updated).
- DG-2 · Fixed — the slash item reads "New draw.io drawing" ("diagram" kept as a keyword, so "/dia" still finds it) (`docs/editor/slashItems.ts`). The tile icon is unchanged (the slash tiles take Docs icon ids, not `DiagramIcon`).

## Docs AI
- AI-1 · Skipped — the default is the server's (`server/models.py` `ai_enabled = True`); the copy matches the real default. Changing it is a server change.
- AI-2, AI-3, AI-4 · Skipped — Low.

## Canvas
- CA-1 · Skipped — server change (`server/services/canvases.py`, the canvas name drops the brackets).
- CA-2 · Fixed — one side panel at a time: opening History closes Boards / Comments, and opening either closes History (`canvas/CanvasEditor.tsx`).
- CA-3, CA-4 · Skipped — Low.
