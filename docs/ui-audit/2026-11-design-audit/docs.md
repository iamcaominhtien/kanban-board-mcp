# Docs and Canvas (docs) — design audit

Demo video: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/audit/videos/docs.mp4` (not in the repo)

Summary: 38 findings (1 critical, 2 high, 15 medium, 20 low). The Docs space is built close to the boards. The tree, quick filter, search palette and results page, history drawer and diff, move/duplicate/delete dialogs, reference chips and hover cards, the empty space and the import dialog all match the source in structure and copy. The main gaps are in the page header and in overlays. The breadcrumb is squeezed into the button row, where it gets truncated (at 1100 px it disappears and the ··· button is cut off). Several floating layers sit on top of content instead of beside it: comment badges, the find bar, the two editor selection bars, the `[[` preview strip and the canvas side panels. There are also a few behaviour slips: Ctrl+K in the editor opens search, new diff sections are labelled "Changed", and the canvas name loses its brackets.

Notes on the run:
- Data I added (KAN): pages **[docs] Rate limits API** (under Architecture; v1 by An Nguyen, v2 by Hoa Mai, plus an unpublished draft by An Nguyen; two inline threads, one with a reply, and a page comment; broken references `[[Old rules]]`, `[[Requirements#Nope]]` and `KAN-404`), **[docs] Webhooks draft** (never published; a draw.io block was inserted while testing), **[docs] Linking page** and **[docs] Login canvas** (a Docs canvas page with two extra empty boards). I also set Tuan Vo's last-seen version of the Rate limits page to v1 for the "since you last viewed" banner. I changed no existing page.
- The UI acts as the person in `localStorage.kanbanActor`. I used An Nguyen (and Tuan Vo for the reader view). In MOB, An Nguyen is not a member, so the space shows the "no access" state (E4). The empty state (A) was taken with the board's own user.
- No AI was run. These were never pressed: Ask the docs, Docs health, the page AI menu items (the menu was only opened), Summarise/Explain/Ask in the selection bars, "Suggest a note", "Draw a diagram", the "Write with AI" entries and canvas "AI"/"Ask AI". The Docs AI boards (`docs-ai`, `docs-ai-care`) are audited from code, apart from the open AI menu and the AI rows in the tree and Settings.
- Destructive dialogs (Delete, Discard, Restore, Move, Duplicate, Publish) were opened and cancelled. Nothing was published, deleted or moved from the UI.
- `docs-comments`, `diagrams-drawio`, `docs-ai`, `docs-ai-care` and `canvas` are later boards (canvas `1793195406-cc1c`) that extend the Docs boards. Where they move things in the page header (the AI menu and the Comments button sit next to Share/Edit), the later board wins. Both still draw the breadcrumb on its own row above the title.
- Already filed elsewhere and not repeated: native `<select>`s in Settings › Docs › AI in Docs (same as ai-1/ai-3), "✦" glyph as the AI icon (same as ai-1 AB-4), board header overflow (same as ai-1 AB-2 / ai-3 SF-1), raw `[[…]]` markdown in search snippets (same as comp-2).

## Docs — page view (`design/screens/docs-page.md`)

Coverage: frames checked in the app: A, B (1100 px), C (hover and row menu), D (published, draft, unpublished changes, reader view as Tuan Vo). From code only: none. Not checked: C drag to reorder/nest and inline rename (not done, to avoid changing the shared tree).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| DP-1 | A, D | High | layout | Breadcrumb "Kanban Board › Architecture › API" on its own row. Title row below, with Share / Edit / ··· (and in the later boards AI and Comments) to the right of the title | The breadcrumb shares one row with AI ▾, the bell, Comments, Share, Edit/Continue editing and ···. It is truncated to "Kanban Bo" / "Architectu" (to "Kanb" when the Comments panel is open), and the page name never shows | `ui/src/components/docs/DocsPageView.tsx:293-470` | Put the `<nav aria-label="Breadcrumb">` in its own row. Move the button group into a flex row with the `<h1>` title, as drawn |
| DP-2 | B | Critical | layout | At 1100 px: the tree becomes the icon rail, "On this page" becomes a header button, and everything else stays visible | The breadcrumb has zero width (gone entirely). The ··· page menu button is cut off at the right edge of the card (x 1040–1072 of 1100) | `ui/src/components/docs/DocsPageView.tsx:293` (the actions group is `flexShrink: 0`) | Same fix as DP-1. Let the actions wrap, or fold Share/bell into ··· below about 1200 px |
| DP-3 | C | Low | copy | Tree row menu: Rename, Add child page, Duplicate, Copy link, Move to…, Export as Markdown, "Delete page". Page history and Copy as Markdown are only in the page menu | The tree row menu is the full page menu, with Copy as Markdown and Page history, and the last item reads "Delete" | `ui/src/components/docs/PageMenu.tsx:28-32` | Filter `copy-markdown` and `history` out of the tree variant. Label the last item "Delete page" there |
| DP-4 | A, C | Low | icon | Draft (never published) marker: a small orange square | A round orange dot | `ui/src/components/docs/DocsTree.tsx` (draft marker) | Use the 7 px square from the node-states legend |

Images: [design A](../../../design/images/docs-page/docs-page-1-full-app-frame.png) · [design B](../../../design/images/docs-page/docs-page-2-narrow-window.png) · [design C](../../../design/images/docs-page/docs-page-3-tree-interactions.png) · [design D](../../../design/images/docs-page/docs-page-4-page-header-status.png) · [now A](shots/docs/docs-page-A.jpg) · [now A lower](shots/docs/docs-page-A-lower.jpg) · [now B](shots/docs/docs-page-B.jpg) · [now C](shots/docs/docs-page-C.jpg) · [now D draft](shots/docs/docs-page-D.jpg)

## Docs — editor (`design/screens/docs-editor.md`)

Coverage: frames checked in the app: A, B (selection toolbar and link field), C (full, "/cal", "/zzz"), D, E (Publish and Discard, both cancelled), G (table grips and handles), H ("[[Req"). From code only: F (conflict, offline and reconnect: `ConflictBanner.tsx`, `OfflineBanners.tsx` exist with the banner copy). Not checked: callout type pill (the click selected the chip instead).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| ED-1 | A | Medium | spacing | About 40 px between the title rule and the first heading "Overview", with heading gaps as in view mode | The first heading is 6 px under the title rule (`margin-top: 6px`), so the title and "Overview" touch. Section gaps are visibly tighter than the reading view | `ui/src/components/docs/editor/editor.css:41-44` | Drop the `:first-child` override, or give it the reading view's `.dk-md h2` top margin |
| ED-2 | B | Medium | layout | One dark floating bar above the selection (B, i, strike, code, Text ▾, link, [[, ticket) | Two bars at once: the formatting bar above the selection and the AI bar (Improve, Shorten, Fix spelling, Explain, Ask AI…) below it. The second bar covers the next line of text | `ui/src/components/docs/editor/DocsEditor.tsx:818-831` | Show one bar: fold the AI actions into the formatting bar (an "AI ▾" item), or show the AI bar only when that item is pressed |
| ED-3 | B | High | behavior | Cmd/Ctrl+K = link: the bar turns into the URL field | Ctrl+K in the editor opens the URL field **and** the Docs search palette over it. The palette takes focus, so the link cannot be typed | `ui/src/components/docs/SearchPalette.tsx:86-89` (window keydown, ignores the editor) | Skip the palette hotkey when the event comes from `.ProseMirror` or another text field, or when `e.defaultPrevented` |
| ED-4 | D | Medium | behavior | Markdown pane shows compact GFM (`\| GET \| /tickets \| … \|`) with single blank lines | Saved markdown pads every table cell to the column width (rows wrap in the pane, e.g. `\| ------ \| -------------------- \|`) and writes double blank lines before headings. Each save of an untouched table shows as changed lines in history and diffs | markdown serializer used by `ui/src/components/docs/editor/MarkdownPane.tsx` | Serialize tables with single-space cell padding and collapse blank-line runs to one |
| ED-5 | A | Low | icon | "Visual" with an eye icon, "Markdown" with a `<>` icon | Text only | `ui/src/components/docs/DocsEditScreen.tsx` (Visual/Markdown toggle) | Add the two 14 px line icons |
| ED-6 | A | Low | missing | Empty last line placeholder: "Type / for blocks, or [[ to link a page or ticket" | No placeholder line under the last block | `ui/src/components/docs/editor/extensions/Placeholder.ts` | Show the hint on the trailing empty paragraph |
| ED-7 | E | Low | copy | Summary "+14 −3 lines changed · 2 references added". Placeholder is plain text. Notify toggle with "3 people who follow this space" and avatars | No "· N references added" part. The placeholder example shows "KAN-12" as a highlighted chip (a ticket that does not exist). "Notify members" is on while it says "No one else follows this space yet." | `ui/src/components/docs/PublishDialog.tsx:15, 345` | Add the reference count, render the placeholder without chip styling, and turn the toggle off (disabled) when there are no followers |
| ED-8 | H | Medium | layout | The suggester is one card. "AFTER ENTER" / "STORED AS MARKDOWN" is board commentary, not UI | An "ENTER INSERTS" strip is attached under the menu. Its label has no background and sits over the page text below (over the PATCH table row) | `ui/src/components/docs/editor/RefSuggester.tsx:538` | Move the preview inside the card footer, or drop it |
| ED-9 | C | Medium | behavior | Typing "/dia" on a new line opens the menu | Once (1 of 3 tries), typing "/dia" on a new line in **[docs] Webhooks draft** blanked the whole app with React "Maximum update depth exceeded". It did not happen on the next two tries | slash menu / diagram starter (`ui/src/components/docs/editor/SlashMenu.tsx`, `ui/src/components/diagrams/useDiagramStarter.tsx`) | Look for a setState loop when the filtered list or highlighted item changes; add an error boundary around the editor so a failure does not blank the app |
| ED-10 | A | Low | color | Code block keeps the reading view's syntax colours (`curl` in green) | In edit mode the code block is plain white text | `ui/src/components/docs/editor/extensions/CodeBlock.tsx` | Apply the same highlighter as `docsHighlight.tsx` in the editor node view |

Images: [design A](../../../design/images/docs-editor/docs-editor-1-full-edit-mode.png) · [design B](../../../design/images/docs-editor/docs-editor-2-floating-selection-toolbar.png) · [design C](../../../design/images/docs-editor/docs-editor-3-slash-block-menu.png) · [design D](../../../design/images/docs-editor/docs-editor-4-markdown-source-view.png) · [design E](../../../design/images/docs-editor/docs-editor-5-publish-and-discard-dialogs.png) · [design H](../../../design/images/docs-editor/docs-editor-8-reference-suggester.png) · [now A](shots/docs/docs-editor-A.jpg) · [now B, two bars](shots/docs/docs-editor-B.jpg) · [now B, Ctrl+K](shots/docs/docs-editor-B-ctrlk.jpg) · [now C](shots/docs/docs-editor-C.jpg) · [now D](shots/docs/docs-editor-D.jpg) · [now E](shots/docs/docs-editor-E.jpg) · [now H](shots/docs/docs-editor-H.jpg)

## Docs — references (`design/screens/docs-references.md`)

Coverage: frames checked in the app: A (pages and tickets suggester), B (chips in text, table cell and callout), C (page and ticket hover cards), D1, D2 and D6 (broken chips, "Page not found — Create it" tooltip), E (expanded on Data model, empty on my page). From code only: F (`RenameDialog.tsx`, `HeadingRenameNote.tsx`, `DeleteDialog.tsx` exist). Not checked: D3–D5 (needs a deleted page, a restricted page and duplicate titles), G (ticket Linked docs, covered by comp-2's ticket audit), H (cheat sheet, `RefCheatSheet.tsx`).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| RF-1 | E | Low | copy | "5 references from 2 pages and 3 tickets" counts distinct sources | On Data model: "3 references from 1 page and 2 tickets", but both ticket rows are KAN-30 (one in the description, one in a comment) | `ui/src/components/docs/ReferencedBy.tsx:141` | Count distinct ticket ids for "N tickets" |

Images: [design B](../../../design/images/docs-references/docs-references-2-rendered-reference-chips.png) · [design C](../../../design/images/docs-references/docs-references-3-hover-preview-cards.png) · [design D](../../../design/images/docs-references/docs-references-4-broken-and-ambiguous-references.png) · [design E](../../../design/images/docs-references/docs-references-5-backlinks-referenced-by.png) · [now C](shots/docs/docs-references-C.jpg) · [now D, broken chips](shots/docs/docs-references-D.jpg) · [now E](shots/docs/docs-references-E.jpg)

## Docs — empty, loading and errors (`design/screens/docs-empty.md`)

Coverage: frames checked in the app: A (MOB, no pages), B (New page dialog), C5 (Import, idle), E4 (no access, MOB as An Nguyen), F1 (Settings › Docs, now a full settings page). From code only: C1–C4, C6 (`ImportDialog.tsx`), D1–D3 and E1–E3, E5, E6 (`DocsStates.tsx`). Not checked: F2 (it would mean turning Docs off for a shared project).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| EM-1 | A | Medium | copy | "…and to tickets like `KAN-12`" in the Kanban Board space (the example uses the project key) | In Mobile App the hero still says "tickets like `KAN-12`" | `ui/src/components/docs/DocsHero.tsx:259` | Build the example from the project prefix (`${prefix}-12`) |
| EM-2 | E4 | Low | copy | "HM Admin: Hoa Mai gets the request" | "The board owner gets the request", with no avatar or name | `ui/src/components/docs/DocsStates.tsx` (access request) | Name the admin, with their avatar, when one is known |

Images: [design A](../../../design/images/docs-empty/docs-empty-1-first-visit-empty-space.png) · [design B](../../../design/images/docs-empty/docs-empty-2-new-page-dialog.png) · [design C](../../../design/images/docs-empty/docs-empty-3-import-markdown.png) · [design E](../../../design/images/docs-empty/docs-empty-5-error-states.png) · [design F](../../../design/images/docs-empty/docs-empty-6-docs-in-settings.png) · [now A](shots/docs/docs-empty-A.jpg) · [now B](shots/docs/docs-empty-B.jpg) · [now C5](shots/docs/docs-empty-C5.jpg) · [now E4](shots/docs/docs-empty-E4.jpg) · [now F1](shots/docs/docs-empty-F.jpg)

## Docs — page actions and history (`design/screens/docs-actions.md`)

Coverage: frames checked in the app: A1, A2, B1–B3, C1, D1 (single page), E1, E2 (inline and side by side), E3, F3 and F4 (as Tuan Vo), G. From code only: B4 and E4 toasts, D2–D4 (Recycle Bin: `DocsRecycleSection.tsx`). Not checked: C2/D1 with children (my pages have none, and I did not touch Architecture), side-by-side screenshot review.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| AC-1 | E2 | Medium | state | A section that did not exist in the older version gets the chip "Added" (+6 −0) | "Example request" and "Broken references" (new in v2) are labelled "Changed" because a blank context line counts as unchanged | `ui/src/components/docs/DiffView.tsx:60` | Ignore blank lines when deciding Added/Removed (`same` = non-empty unchanged rows) |
| AC-2 | F3, F4 | Medium | layout | "Changed in v14" label and green left bar beside the changed paragraph | On the warning callout the bar and label are drawn inside the callout, so the bar crosses the ⚠ icon and the label sits on the callout's top border | `ui/src/components/docs/docs.css:548` (`[data-changed-in]::before`) | Put the marker outside the block box (negative left offset) for callouts and tables too |
| AC-3 | B2 | Low | type | "Arch" highlighted inside the title and path. "Architecture" (title match) first | The path highlight leaves a gap ("Arch itecture › API"), and API (path match) is listed above Architecture (title match) | `ui/src/components/docs/MoveToDialog.tsx:44, 614` | Use an inline `<mark>` with no padding. Sort title matches before path matches |
| AC-4 | A2 | Low | copy | Link field `kanban.local/docs/architecture/api` and reference `[[Architecture/API]]` | Link field `localhost:5173/?docs=0cd8ce70-…` (a page uuid) | `ui/src/components/docs/SharePopover.tsx` | Share the slug path when one exists |

Images: [design A](../../../design/images/docs-actions/docs-actions-1-page-menu-and-share.png) · [design B](../../../design/images/docs-actions/docs-actions-2-move-to-dialog.png) · [design E1](../../../design/images/docs-actions/docs-actions-5-history-drawer.png) · [design E2](../../../design/images/docs-actions/docs-actions-6-history-diff.png) · [design F](../../../design/images/docs-actions/docs-actions-8-compare-modes-and-banner.png) · [now A](shots/docs/docs-actions-A.jpg) · [now B](shots/docs/docs-actions-B.jpg) · [now C](shots/docs/docs-actions-C.jpg) · [now D1 and G](shots/docs/docs-actions-D1.jpg) · [now E1](shots/docs/docs-actions-E1.jpg) · [now E2](shots/docs/docs-actions-E2.jpg) · [now E3 and F3](shots/docs/docs-actions-E3.jpg) · [now F4](shots/docs/docs-actions-F.jpg)

## Docs — search (`design/screens/docs-search.md`)

Coverage: frames checked in the app: A1–A4, B1 ("rate limit"), B2, D2 (#end), D3 (KAN-2), E2, E6, C (full results), F1, F4. From code only: E1, E3–E5 (`SearchPalette.tsx` states), F2 Replace (needs edit mode plus Ctrl+F). Not checked: B3–B5 scope chips by click, D1, D4–D6.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| SR-1 | F1 | Medium | layout | The find bar sits above the page header and pushes the page down | The bar is absolutely positioned at the top right and covers Share / Continue editing / ··· | `ui/src/components/docs/FindInPage.tsx:305` | Render it in the flow above the breadcrumb (sticky), or offset the page header while it is open |
| SR-2 | D3 | Low | behavior | A ticket key finds that ticket: "TICKET · 1" | "KAN-2" lists KAN-2, KAN-20 and KAN-21 under "TICKET · 3", each "mentioned in 1 pages" | `ui/src/components/docs/SearchPalette.tsx:996` | Match the full key exactly when the query is a key, and pluralise ("1 page") |
| SR-3 | B1, C | Low | copy | Footer count matches the list ("7 results", "Show all 7 results") | The footer says "3 results", the link says "Show all 4 results", and the results page says "5 matches in 3 pages" for the same query | `ui/src/components/docs/SearchPalette.tsx` | Use one count source for the footer and the link |
| SR-4 | B (with docs-ai C) | Low | behavior | Tab switches the box to Ask and keeps the question | Tab switches to Ask but empties the query ("rate limit" is gone) | `ui/src/components/docs/SearchPalette.tsx` (mode switch) | Carry the text across modes |

Images: [design A](../../../design/images/docs-search/docs-search-1-sidebar-quick-filter.png) · [design B](../../../design/images/docs-search/docs-search-2-search-palette-scopes.png) · [design C](../../../design/images/docs-search/docs-search-3-full-page-results.png) · [design D](../../../design/images/docs-search/docs-search-4-special-queries-and-syntax.png) · [design F](../../../design/images/docs-search/docs-search-6-find-in-page.png) · [now A](shots/docs/docs-search-A.jpg) · [now B](shots/docs/docs-search-B.jpg) · [now B Tab](shots/docs/docs-search-B-tab.jpg) · [now D, E2](shots/docs/docs-search-D.jpg) · [now C](shots/docs/docs-search-C.jpg) · [now F](shots/docs/docs-search-F.jpg)

## Docs — comments (`design/screens/docs-comments.md`)

Coverage: frames checked in the app: A (panel, tabs, selected thread), B1, B2 (selection bar, composer, cancelled), D (page comments). From code only: C (thread states and the actions menu, which did not open in the headless run), E (`CommentsPanel.tsx` states), F (`OrphanWarning.tsx`).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| CM-1 | A | Medium | layout | The number badge sits inline right after the highlighted text ("bearer token ❶;") | The badge floats 14 px above the end of the highlight. When the highlight wraps, it sits on the line above ("Ka❶nban"). In a table cell it sits on the row border. In the editor it wraps onto its own line and makes the row taller | `ui/src/components/docs/comments/useCommentHighlights.tsx:69` | Render the badge as an inline widget after the range end (vertically centred on the line), not at `top - 14` |
| CM-2 | B2 | Medium | spacing | Composer: "ME New comment" header with ×, then the quote and the field. Toolbar: B, I, code │ @, link, spaced, with Cancel and Comment. Hint "Ctrl Enter to post · Esc to cancel" | No avatar or close button. Eight toolbar icons are packed with no gaps (`BI<>@…`). Hint "Enter to post" | `ui/src/components/docs/comments/SelectionComment.tsx:170-182`, `ui/src/components/docs/comments/CommentBox.tsx` | Use 28 px icon buttons with an 8 px gap and a divider (move the extras behind "+"). Add the header avatar and ×. Match the hint to the real key |
| CM-3 | A | Low | copy | Comments button "Comments 4" counts the inline threads and the page thread | Shows "3" with 2 inline threads and 1 page comment, which matches. The panel tab reads "All · 2" because it lists inline threads only | `ui/src/components/docs/comments/CommentsPanel.tsx` | Say which count the button shows (tooltip "2 inline · 1 on the page") |

Images: [design A](../../../design/images/docs-comments/02-a-page-view-with-the-comments-panel-open.png) · [design B](../../../design/images/docs-comments/04-b-adding-an-inline-comment.png) · [now A](shots/docs/docs-comments-A.jpg) · [now B](shots/docs/docs-comments-B.jpg)

## Diagrams — draw.io (`design/screens/diagrams-drawio.md`)

Coverage: frames checked in the app: A (Docs slash menu "/dia"), F (editor unreachable: no draw.io in this sandbox). From code only: B, D, E (`DiagramEmbed.tsx`, `DiagramViewer.tsx`, `DiagramMenu.tsx`). Not checked: C (the draw.io editor does not load here).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| DG-1 | F | Medium | copy | "Editor could not be reached" / "The diagram is still shown below and can be downloaded. Editing needs the draw.io service. Ask an admin to check the editor address in Settings." with Retry and "Download .drawio" | "No draw.io editor is running", then a paragraph with `http://localhost:8080` and a `docker run -d -p 8080:8080 jgraph/drawio` command. Buttons Use the public editor, Retry, Close. No Download | `ui/src/components/diagrams/DiagramEditor.tsx:546-600` | Use the design copy for members. Keep the docker hint for admins (or in Settings › Integrations). Add "Download .drawio" |
| DG-2 | A | Low | copy | Group "INSERT": "New draw.io drawing" (Enter), "Import .drawio file" "Also drop a file onto the page", with the draw.io icon | "Diagram — Boxes and arrows (draw.io)" with a `<>` code icon, under BLOCKS | `ui/src/components/docs/editor/slashItems.ts` | Rename it to "New draw.io drawing" and use `DiagramIcon` |

Images: [design A](../../../design/images/diagrams-drawio/02-a-where-you-start-a-drawing.png) · [design F](../../../design/images/diagrams-drawio/12-f-states.png) · [now A](shots/docs/diagrams-drawio-A.jpg) · [now F](shots/docs/diagrams-drawio-F.jpg)

## Docs AI — ask, write, read and edit / keeping docs true (`design/screens/docs-ai.md`, `design/screens/docs-ai-care.md`)

Coverage: frames checked in the app: docs-ai B (AI menu opened, nothing pressed; tree rows), docs-ai-care F1 (Settings › Docs › AI in Docs). From code only: docs-ai C–F and docs-ai-care A–E, G (`ui/src/components/docs/ai/*`: `FreshnessBanner.tsx` "This page may be out of date" / "Still correct" / "hides this for 30 days", `SummaryBlock.tsx` "not part of the page", `HistorySummary.tsx` "WHAT CHANGED SINCE", `ProposalBanner.tsx`, `CreateTicketsDialog.tsx`, `AskPanel.tsx` "No AI is set up for Docs"; the copy matches). Not checked: anything that needs a run.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| AI-1 | care F1 | Medium | copy | "Use AI in Docs — Ask the docs, the AI menu, Check this page and Docs health. **Off by default.**" | "…Docs health. **On by default; turn it off here.**" (and it is on for KAN) | `ui/src/components/docs/ai/DocsAiSettings.tsx:51` | Make the default off as designed, or update the design; the copy and the default must agree |
| AI-2 | care G | Low | copy | Hidden page: "This page is hidden from AI" / "Ask, summaries and AI runs skip it. People can still read and edit it." with a "Show to AI" button | The AI menu shows the title "Hidden from AI" and a hint, with no "Show to AI" action | `ui/src/components/docs/ai/PageAiMenu.tsx:136-143` | Use the design copy and add the button (for editors) |
| AI-3 | B | Low | behavior | "Reads … 3 tickets" / "Compare with KAN-9, KAN-12, KAN-31" | Counts the broken reference too: "Compare with KAN-2, KAN-1, KAN-3, 1 more", "Reads 4 tickets" (the 4th is KAN-404, which does not exist) | `ui/src/components/docs/ai/PageAiMenu.tsx` | Count only resolved ticket references |
| AI-4 | B | Low | component | Tree: "Ask the docs" as a tinted, bordered button. "Docs health" with a count badge (3) | Both are plain text rows with a small icon and no count | `ui/src/components/docs/DocsTree.tsx` (AI rows) | Style "Ask the docs" as the outlined purple row; show the health count |

Images: [design docs-ai B](../../../design/images/docs-ai/04-b-one-ai-menu-on-every-page.png) · [design care F](../../../design/images/docs-ai-care/12-f-control-and-docs-as-the-ai-s-memory.png) · [design care G](../../../design/images/docs-ai-care/14-g-states.png) · [now AI menu](shots/docs/docs-ai-B.jpg) · [now settings](shots/docs/docs-empty-F.jpg)

## Canvas (`design/screens/canvas.md`)

Coverage: frames checked in the app (Docs canvas page): C1 (header, page tabs, plane, map, tool bar, zoom), D1 (hover and selected board toolbar), F (comments panel, empty), H (Present), J (history panel). From code only: B (`useCanvasStarter.ts`, slash "Canvas /canvas" seen in the menu), E (`SourceEditor.tsx`), G (`CanvasEmbed.tsx`), K (download menu: the button did not open in the headless run), L. Not checked: E2 Ask AI (needs a run), I (shortcuts only).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| CA-1 | C1 | Medium | copy | Header shows the canvas name as written ("Login redesign") | The page "[docs] Login canvas" gets a canvas named "docs  Login canvas" (brackets removed, double space). The header and history show that name while the tree shows the page title | `server/services/canvases.py:531` (`svc_sketches._title`) | Keep the title as typed for the canvas name. Strip brackets only where the alt text is written into markdown |
| CA-2 | C2, J | Medium | layout | One side panel at a time (Boards / Comments tabs). History replaces it | Opening History and then Comments shows both panels side by side. History is not closed and the plane shrinks to a strip | `ui/src/components/canvas/CanvasEditor.tsx:171, 2390` | Make the panels exclusive (one `panel` state: boards, comments or history) |
| CA-3 | D1 | Low | state | Selected board: 2px blue border plus handles, name in blue | Handles and a blue name, but the frame keeps its thin grey border | `ui/src/components/canvas/BoardFrame.tsx` | Add the 2px `#2F6FD6` selection border |
| CA-4 | L | Low | type | Empty board placeholder is readable at any zoom | "Empty board" is drawn inside the board and scales with zoom: at 22% it is about 3 px, unreadable | `ui/src/components/canvas/BoardFrame.tsx` | Draw the empty label at screen size (counter-scale), as for the board name |

Images: [design C](../../../design/images/canvas/06-c-the-canvas-editor.png) · [design D](../../../design/images/canvas/08-d-what-is-on-the-plane.png) · [design J](../../../design/images/canvas/20-j-history.png) · [now C](shots/docs/canvas-C.jpg) · [now D](shots/docs/canvas-D.jpg) · [now J + comments](shots/docs/canvas-J.jpg)

## Patterns

- **Floating layers cover content** (6 places): comment badges (CM-1), the find bar (SR-1), the second selection bar (ED-2), the `[[` "Enter inserts" strip (ED-8), the "Changed in" marker inside callouts (AC-2) and the stacked canvas panels (CA-2). Each layer is positioned absolutely without reserving space.
- **Page header overload** (DP-1, DP-2): the later boards added AI, Comments and the follow bell to the header. The breadcrumb row was not split off as drawn, so the breadcrumb is what gives way, at every width.
- **Counts that disagree with what is listed** (RF-1, SR-2, SR-3, AI-3, CM-3): duplicates, prefix matches and broken refs are counted.
- **Hard-coded KAN examples** (EM-1, ED-7): example copy uses `KAN-12` in every project and as a chip-styled placeholder.
- **Developer copy shown to members** (DG-1).
