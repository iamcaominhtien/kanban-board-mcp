# Rich Docs — overview, reading order and implementation notes

> Overview of the twelve **Rich Docs** boards (canvas `1794927884-e6a0`, page "Screens · Docs (rich documents)"). The boards are a design proposal. They live next to the older Docs boards (`DocsPage`, `DocsEditor`, `DocsEmpty`, `DocsSearch`, ...) and do not replace them. Each board's own doc ends with its frame list, the code that must change, and the decisions that need the owner's OK. **Check the code before building from any board: the board is a picture, the code is the truth for words that already exist.**

## What changes

Docs today stores a page as one Markdown string, so what it can show leans to what Markdown can hold. The Rich Docs boards show Docs as a **rich document editor**, close to Word or an HTML page, able to hold books, stories and blogs as well as specs:

- Text: colour, highlight, font and size, alignment (left, centre, right, justify), indent, spacing, drop cap, styles (Title, Subtitle, Heading 1-4, Quote, Caption), lists (bullet, numbered, task list, nested).
- Images that float left or right with the text wrapping round them, or sit inline or centred, with resize, crop, caption, alt text, border, radius and shadow.
- Tables with merged cells, shading, borders and column widths; columns layout; callouts, pull quotes, dividers.
- Embeds: HTML (sandboxed), video, draw.io, code, files, sketches, canvases, page and ticket references.
- Page settings: width (Narrow 560, Normal 680, Wide 880, Full), fonts, page background (White, Paper, Sepia, Mist, Night), cover, title style.
- Responsive: every main screen is drawn at desktop 1360, tablet 820 and phone 390 (touch targets 44 px, no hover-only actions).
- Export to Word, PDF, HTML and Markdown (simple dialog, no "what will be lost" preview); import from Markdown, Word and HTML.
- AI teams keep reading and writing Docs through MCP (`docs_read`, `docs_write`).

## The boards, in the order to read them

1. [App frame & responsive](rich-docs-shell.md): where everything sits on three sizes, drawers, touch rules.
2. [Editing text](rich-docs-editor.md): ribbon, pickers, "/" menu, paste, find, focus mode.
3. [Blocks & properties](rich-docs-blocks.md): images, tables, columns, callouts, the insert catalog.
4. [Embeds & files](rich-docs-embeds.md): HTML, video, draw.io, code, files, sketches, canvases, references, link embeds.
5. [New page, templates & page settings](rich-docs-start.md): first visit, template gallery, page settings, import, the "converted from Markdown" notice.
6. [Reading, sharing & print](rich-docs-reader.md): read views, reader settings, share and public link, print.
7. [Page tree, gallery & Recycle Bin](rich-docs-tree.md): organising pages, books, dialogs, Docs settings.
8. [Search, links & backlinks](rich-docs-links.md): quick open, search, suggesters, Referenced by, broken links, ticket side, Docs health.
9. [AI teams on rich pages](rich-docs-ai.md): suggestions, whole-object diffs, Ask the team, run states, since-viewed.
10. [History & comments](rich-docs-history.md): rendered block diffs, restore, comments that follow blocks.
11. [Export](rich-docs-export.md): export dialog, background and book mode.
12. [States](rich-docs-states.md): loading, saving, offline, conflict, access, limits, accessibility, dark mode (proposal).

## Implementation notes (what the design assumes of the code)

### New canonical format, and the migration it needs

Markdown cannot hold colour, alignment, float or merged cells, so the page needs a richer canonical format, with **a stable id on every block** (ProseMirror / TipTap JSON, or a hybrid; the editor is already TipTap v3). Markdown becomes an import and export converter. The design assumes this; the format itself is the developers' choice.

**When this is built, the migration must be planned, not an afterthought:**

- Convert every existing page (current content of `docs_page`, drafts in `docs_draft`) from Markdown to the new format, giving an id to every block. Keep each old version readable (versions are Markdown today: `docs_version.markdown`). The conversion appears in History as one extra version, "Converted from Markdown", authored by "Kanban Board".
- Keep what points into a page working: diagram, sketch and canvas references (they become embed blocks with the same ids); `[[Page#Section]]` links and heading anchors (`docs_link`, `docs_anchor_aliases`, `docs_title_aliases`); comment threads (`docs_comment_thread`) re-anchored to a block id plus a quote; version restore; Recycle Bin pages; `docs_page_seen` (since-viewed) counters.
- A page that fails to convert keeps its original Markdown read-only, with a clear message (States board).
- Write a plain-text projection of every page on each save (search, snippets, Docs health) and keep a Markdown projection for the MCP view and for export.
- The conversion must be restartable and checked page by page (page count before and after, links before and after) and must work on SQLite, PostgreSQL and MySQL/MariaDB (see the Databases board and the migrations folder).
- The converter Markdown ↔ rich format must run on the server (Rust) as well as in the UI, against one shared schema, with round-trip fixture tests so the two never drift.

### AI teams through MCP (design basis: a second opinion from Opus 5.5)

Chosen model: the page is stored as rich JSON with block ids; the AI **reads Markdown with a block id on each block** and **writes block by block**; the server merges text changes back so formatting survives.

- Read: Markdown plus block-id markers; formatting is shown only where it matters (alignment, float, highlight, colour), colours are **named** from the shared palette (12 text colours and 12 highlights); things Markdown cannot hold (merged-cell tables, HTML embeds, video, files, draw.io, sketches, canvases) appear as one-line placeholders, full detail on request.
- Write: `docs_write(edit)` keeps section and find; adds block-level replace, insert after, delete and set attributes. A placeholder cannot be dropped silently. `update(markdown)` becomes "replace the page", and untouched placeholders are kept. New content may use a small attribute syntax, so a team can write a blog post with a centred title, a pull quote and a floated image.
- What people see: AI writes arrive as **suggestions at block level** by default (a page or team setting "Apply directly" exists), with Accept and Reject per block, Accept all, a header chip "Docs team edited 3 blocks", rendered block diffs in History, comments anchored to a block id plus a quote.
- The design does not draw, because it cannot work: live AI typing or an AI cursor; an AI that chooses pixel positions, wrap distance, page breaks or print layout; edits inside a draw.io diagram, sketch or HTML embed (a team replaces, adds or removes the whole block); a promise of a lossless round trip to Word or Markdown; an AI that "sees" the page.
- The MCP contract change (read view with ids, block edits, `update` semantics) also changes the tool descriptions, the Docs guide that `docs_read(docs_guide)` returns, the AI team's role and skill text about Docs, and the tests of the MCP tool list (`test_mcp_tool_quality`).

### Other things that are new on the server

Sanitising and sandboxing embedded HTML (allow-list on save, sandboxed iframe, scripts only after "Ask before running"); a virus scan and size limits on uploads; a server export for four formats, a background whole-space export, 7-day files and a history of the last 20; public links (token, expiry, public route); templates stored per person and project; per-page settings; page icon, cover, status and book fields; the "Follow page" levels already in the code (`FollowBell`).

Fonts: the boards load Lora, Source Serif 4, Merriweather, Playfair Display, Caveat and Inter from Google Fonts only to render the pictures. The app must **bundle** the fonts it offers (the desktop app works offline).

## Decisions that need the owner's OK (collected from the boards)

The detail and the full lists are at the end of each board's doc.

- **Format and AI:** the new canonical format and the MCP model above; suggest-first is the default; a person's edit wins over a team's when both change the same block; a team never edits inside an embed; the warning "Left this block as it is".
- **Public links:** that "Anyone with the link can read" exists at all; the page owner turns it on, an admin can switch it off for the project; expiry default Never; author names default off; what outsiders see of page links, ticket chips and embeds (plain text).
- **Limits:** image 10 MB, video 200 MB, file 100 MB, HTML 512 KB, page 50 MB (warning at 75 %), import 20 MB, export 200 MB.
- **Look:** page widths 560 / 680 / 880 / Full; five page backgrounds; a palette of 12 text colours and 12 highlights that shifts per background; seven bundled fonts; page-settings font presets Sans, Serif, Editorial, Mono; dark mode is a **proposal** only (the app has no dark theme).
- **Editing:** "Match page style" as the default paste mode; offline editing is allowed with queued changes (the code's "Editing is off until you reconnect" is replaced); invented shortcuts (Ctrl Space clear formatting, Ctrl Shift F focus mode, Ctrl Alt C / V format painter, Ctrl K go to page while reading).
- **Pages and books:** templates (Blank, Blog post, Book chapter, Short story, Newsletter, README and the existing ones), "Paged" view as an option never forced, a book numbers its chapters, "Not for AI teams" as a per-page setting, a page is "May be outdated" after 6 months without a review.
- **Export:** files kept 7 days, 20 in history, whole-space export one at a time in the background, failed export goes to Needs you; book mode.
- **Safety wording that the board states and the code must really do:** HTML embeds run in a sandbox with no access to the board; uploads are virus-scanned; programs and scripts are refused; an embedded video loads only after Play.

## Not drawn

Mobile (iOS) versions of the old Docs boards; real-device checks (iOS keyboard heights, the browser's print dialog, Word or PDF opened in their programs); footnotes as a block (only used in samples; not in the code today); the Sepia and Night value shifts of every palette colour in the page-settings picker (the Editor board has them for the text colour and highlight pickers). The canvas was not opened in a browser by a person: only images exported from the files were looked at.
