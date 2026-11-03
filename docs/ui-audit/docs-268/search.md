# Docs — search (`design/source/DocsSearch.dc.html`) — 1:1

Method as in `actions.md`.

| § | Design | Code today (before) | Gap | Fix |
|---|---|---|---|---|
| A. Sidebar quick filter | Filter in the tree | `DocsTree.tsx` (tree, other fork) | — | not mine |
| B. Search palette | 620 px; header, scope pills, PAGES / IN PAGE CONTENT, footer | All paired elements match (query "auth") | the Search/Ask switch: two outlined pills vs the segmented control drawn in docs-ai C | **Fixed** (`SearchPalette.tsx`): same segmented control as the Ask tab |
| C. Full-page results | Result cards, section rule `2px #E3E8E5`, filters | All paired elements match (title 16/700, path 12px, `# heading` 12/700 `#2E6F40`, snippet 13.5/1.5, chips) | none | matches. Kept: the back arrow left of the field (code does more) |
| D. Special queries and syntax | `#`, `[[`, key, phrase, -word | `SearchPalette.tsx` mode chips | — | not re-measured (wave 3 checked D2/D3) |
| E. States | Searching, nothing, error, offline, indexing | `SearchPalette.tsx` | — | from code only (copy matches) |
| F. Find in page | Bar above the header | `FindInPage.tsx` (wave 3 SR-1 fixed) | — | not re-checked this run |
