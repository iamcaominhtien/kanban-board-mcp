# Docs — page actions and history (`design/source/DocsActions.dc.html`) — 1:1

Method: design rendered live, each block's card found in the design and in the app (http://127.0.0.1:5173, page "[UI-B] Rate limits API" v1 by An Nguyen, v2 by Hoa Mai, one child page), elements paired by text, computed styles compared. "matches" = no style difference on any paired element (only copy that depends on the data differs).

| § | Design | Code today (before) | Gap | Fix |
|---|---|---|---|---|
| A1. Page ··· menu | Menu 290 px, padding 5, radius 10; items with shortcuts | Same values (`PageMenu.tsx`) | last item "Delete page" vs "Delete" | **Kept** "Delete page" (wave 4 DP-3 decided it) — matches otherwise |
| A2. Share popover | 430 px, padding 14, gap 12; link field + Copied; reference `[[Architecture/API]]` | Same values; link is `…/?docs=<uuid>` | link form (AC-4) | **Listed**: pages have a `slug`, but `?docs=` resolves ids only; a slug link needs App routing (`App.tsx`, not mine) |
| B. Move to… | Dialog **560 px**; tree rows **32 px** high (pitch 33) | Dialog 668 px; rows squashed to **21 px** (flex rows shrank inside the 360 px list) | 560 vs 668; row 32 vs 21 | **Fixed** (`MoveToDialog.tsx`): width 560, rows and gaps `flexShrink: 0`, gap lines net −1 px so the pitch is 33 as drawn |
| C. Duplicate | 520 px dialog, "Include child pages" | Same values | none ("Include child pages" grey only when there are none) | matches |
| D. Delete with children, Recycle Bin | Delete dialog 540 px; bin section | `DeleteDialog.tsx`, `DocsRecycleSection.tsx` | — | not re-checked (nothing deleted on the shared board); wave 3 found it matching |
| E. History drawer, diff, Restore | Drawer with groups, Current chip, footer "n selected" + Compare | Same structure and values; "What changed since" summary at the top (docs-ai-care D1, later board) | none | matches; summary box restyled under ai-care D1 |
| F. Compare modes, "Changes since you last viewed" | Inline / side by side, banner | `DiffView.tsx`, `SinceViewedBanner.tsx` | — | not re-checked this run (wave 3 AC-1/AC-2 fixed) |
| G. Page info | Popover | `PageInfoPopover.tsx` | — | not re-checked this run |

Screenshots: `docs/screenshots/docs-268/actions-B-move-to-before.png` / `-after.png`.
