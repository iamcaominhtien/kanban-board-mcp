# Docs — references: design 1:1 (#268)

Design: `design/source/DocsRefs.dc.html`, rendered live; chips measured with `getComputedStyle` in the design and in the app on a page with every kind of reference. Screens: [Referenced by before](../../screenshots/docs-268/references-E-before.png) · [after](../../screenshots/docs-268/references-E-after.png).

| § | Design | Code today | Gap (measured) | Fix |
|---|---|---|---|---|
| A — [[ suggester | Pages, then sections after #, tickets after KAN-; Enter inserts | "[[Data" + Enter inserts the chip; toolbar [[ + "Auth" + Enter too (checked) | None found | — |
| B — chips | Page chip 22px 13/600 #2E6F40 on #F1F8F3, 1px #D7E8DC, r 6, padding 0 8px; ticket chip white, 1px #E3E8E5, padding 0 8px 0 7px; in a table cell, a callout and a heading (heading drops the title) | Identical (measured: height, font, colours, border, radius, padding); heading chip shows the key only | None | — |
| C — hover cards | Page: breadcrumb, title, excerpt, author, "edited 2h ago", v8, Open, Open in side panel. Ticket: key, status, title, Open ticket, Copy key | Page card has the same parts (checked on "Auth › Rotation"); ticket card not captured | — | Page card checked; ticket card **not checked** |
| D — broken references | Not found: red dashed (#A5321E on #FBE7E4, 1px dashed #E8A99B); section not found: amber dashed (#7A4F08 on #FEF6E7, #E3C27A); in bin: grey, line-through; ticket not found: red dashed | Identical values (measured on `[[Old rules]]`, `[[Auth#Nope]]`, a deleted page, `KAN-404`) | None. D4 (no permission) and D5 (duplicate titles) not set up | D1–D3, D6 checked; D4, D5 **not checked** (need a restricted page and two pages with one title). Note: a page title with `]` in it cannot be written as `[[…]]` (it renders as text) |
| E — Referenced by | "5 references from 2 pages and 3 tickets", "PAGES · 2": counts the pages and tickets that link here | Counted one per link: a page linking twice read "3 references from 3 pages", "PAGES · 3" with 2 pages | Page count (RF-1 had fixed tickets only) | **Fixed**: pages and tickets are counted once each; the rows still list every link (`ReferencedBy.tsx`) |
| F — rename, move, delete | Rename dialog with affected pages, Undo toast, heading redirect note, delete dialog | `RenameDialog.tsx`, `HeadingRenameNote.tsx`, `DeleteDialog.tsx` | — | **Not checked** (dialogs belong to the other half of this audit; renaming would change shared pages) |
| G — ticket Linked docs | "LINKED DOCS", mentioned / manual / from docs, "+ Link a doc" | `TicketDocsSection.tsx` | — | **Not checked** in the browser this round |
| H — cheat sheet | Syntax table, anchors, rename rules | `RefCheatSheet.tsx` | — | **Not checked** |
