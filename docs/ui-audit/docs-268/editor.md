# Docs — editor: design 1:1 (#268)

Design: `design/source/DocsEditor.dc.html`, rendered live and measured against the app (1440 px). Screens: [header and toolbar before](../../screenshots/docs-268/editor-A-before.png) · [after](../../screenshots/docs-268/editor-A-after.png) · [last line before](../../screenshots/docs-268/editor-A-lastline-before.png) · [after](../../screenshots/docs-268/editor-A-lastline-after.png).

| § | Design | Code today | Gap (measured) | Fix |
|---|---|---|---|---|
| A — header | Breadcrumb; "Draft · based on v14" 22px 11/700 #7A4F08 on #FCEFD9; "Saved 12:41"; Visual/Markdown 26px tabs on #EEF3EF; Discard 76×34 and Publish 94×34 (12.5px, padding 8px 14px) | Same badge, save state and tabs; Discard 67×27, Publish 83×27, Comments 32px (`st-btn-sm`, 12px, 5px 10px) | Buttons 27px tall instead of 34, 12px instead of 12.5 | **Fixed**: Discard, Publish and Comments are full-size buttons (`DocsEditScreen.tsx`) |
| A — toolbar | B i S code │ H1 H2 H3 │ lists, task, quote │ table, code block, callout │ link, [[, ticket, image │ undo redo, "Type / for blocks"; 28px tools | Same tools plus attach, sketch, canvas, Ask AI; tooltips showed the name only | No highlight tool (issue task 2); tooltips did not say the key | **Fixed**: Highlight after inline code (`==text==`, Ctrl/⌘+Shift+H) in the toolbar and the selection bar; every tooltip names its shortcut ("Bold (Ctrl+B)", ⌘ on a Mac) and `aria-keyshortcuts` (`EditorToolbar.tsx`, `BubbleToolbar.tsx`) |
| A — empty last line | "Type / for blocks, or [[ to link a page or ticket" on the page's empty last line | Shown only on the empty line holding the caret (ED-6 skipped in wave 4) | Hint missing while the caret is elsewhere | **Fixed**: also shown on the trailing empty line the editor already keeps; nothing is added to the saved text (`extensions/Placeholder.ts`) |
| A — body, code block | Reading-view colours (curl green) | lowlight colours; strings/flags coloured, the command word plain | `curl` white instead of #68BA7F | **Not fixed** (Low): lowlight's bash grammar does not mark the command; needs the reading view's own tokenizer in the editor node view |
| B — selection bar, link field | Dark bar: B i S code, Text ▾, link, [[, ticket; Ctrl+K turns it into a URL field (Enter applies, Esc cancels) | Same bar plus AI ▾ and Comment; Ctrl+K opens the URL field and not the search palette | No highlight in the bar | **Fixed**: Highlight in the bar |
| C — "/" menu | Grouped list, first match selected, "/cal" filter, "No blocks match" | Same | **Bug (ED-9, found again)**: typing "/table" on a new line sometimes blanked the editor with "Maximum update depth exceeded" (5 of 6 runs in one session). Cause: the menu's position was set in a layout effect that ran after every render | **Fixed**: the menu follows its height with a ResizeObserver and sets its position only when the caret or the height changes (`SlashMenu.tsx`, also used by the [[ suggester); 0 errors in 13 runs after |
| D — Markdown view | Side-by-side source, line numbers, compact tables | Same (ED-4 fixed in wave 3) | None | — |
| E — Publish / Discard | "Publish changes", note 200, notify toggle; "Discard your changes?" | Same dialogs | ED-7 (reference count in the summary, chip-styled placeholder) | **Not checked again** — `PublishDialog.tsx` unchanged this round; ED-7 stays as listed in the wave 4 log |
| F — conflict, offline, reconnect | Amber conflict banner with View their changes / Keep mine / Reload; offline banner; back online | `ConflictBanner.tsx`, offline banners | — | **Not checked** in the browser (needs a second writer and a cut network); code unchanged |
| G — table and callout | Cell toolbar, + handles, Tab to the next cell; callout type pill | Table by toolbar and by "/table", Tab moves to the next cell (checked) | None found | — |
| H — [[ suggester | Pages, sections, create; Enter inserts a chip | "[[Data" + Enter inserts the Data model chip (checked) | None | — |
| Note — shortcuts | Ctrl/⌘ B, I, Shift+X, E, K, Alt+1/2/3, Shift+7/8/9, Shift+B, Alt+C, S, Enter, Shift+M | All present | Highlight had none | Ctrl/⌘+Shift+H added |

## Mouse and keyboard check (issue #268, task 2)

`/tmp` Playwright script driving the real app with key presses, toolbar clicks, real file choosers and clipboard events, on a scratch page. After the fixes: **44 checks, 44 pass** (one run in three loses the file chooser of "/image" in headless Chromium; the same step passes alone 3 of 3).

| Feature | Mouse | Keyboard / typing | Result |
|---|---|---|---|
| Bold | toolbar B, selection bar B | Ctrl+B | pass |
| Italic, strike, inline code | — | Ctrl+I, Ctrl+Shift+X, Ctrl+E, typing \`x\` | pass |
| **Highlight** (new) | toolbar, selection bar | Ctrl+Shift+H, typing `==x==` | pass; stored as `==text==`, kept through the Markdown view |
| Headings | toolbar H3 | Ctrl+Alt+2, typing "## " | pass |
| Lists | toolbar bulleted list | Ctrl+Shift+8 / 7 / 9, typing "- ", "[] " | pass |
| Quote | — | Ctrl+Shift+B | pass |
| Table | toolbar Table, "/table" + Enter | Tab to the next cell | pass (before: "/table" could crash the editor, see C) |
| Code block | — | Ctrl+Alt+C, typing \`\`\` + space | pass |
| Link | toolbar Link → URL field | Ctrl+K → type → Enter (search palette stays closed) | pass |
| Page link | toolbar [[ | typing `[[Data` + Enter | pass |
| Ticket link | toolbar Ticket | typing `KAN-1 ` | pass (chip with live status) |
| Image upload | toolbar Image → file chooser, "/image" | — | pass |
| File upload | toolbar Attach → file chooser | — | pass |
| Paste | pasted PNG → uploaded image; URL over a selection → link | — | pass |
| **Paste Markdown** | — | text with `## Title` / `- item` / tables from a plain-text source | **was text** ("## Pasted" as a paragraph); **fixed**: becomes headings, lists, tables (`editor/pasteMarkdown.ts`); HTML from a web page or Word is still pasted as HTML; never inside a code block |
| Undo / redo, Markdown view | — | Ctrl+Z, Ctrl+Shift+Z, Ctrl+Shift+M | pass |

Tests: `editor/highlight.test.ts` (round trip `==a==`, bold inside, `==` in code untouched, toggle), `utils/docsMarkdown.highlight.test.tsx` (reading view `<mark>`, not in code, unpaired `==` kept, headings / lists / cells), `editor/pasteMarkdown.test.ts`.
