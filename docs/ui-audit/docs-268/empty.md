# Docs — empty, loading and errors (`design/source/DocsEmpty.dc.html`) — 1:1

Method as in `actions.md` (empty space: project "Mobile App" with An Nguyen as admin; no-access: the same project before An Nguyen was added).

| § | Design | Code today (before) | Gap | Fix |
|---|---|---|---|---|
| A. First visit: hero, templates, import | Hero, two buttons, template cards, import strip | All paired elements match | only project-specific copy | matches |
| B. New page dialog | 780 px, template + title + parent | All paired elements match | dialog taller: 14 templates (3.28.0) | matches; AI part restyled under docs-ai D1 |
| C. Import Markdown | Parse results, progress, drop zone | `ImportDialog.tsx` | colour of the AI tidy notes | **Fixed** palette (`#5B3AA6`); layout not re-measured |
| D. Loading | Skeletons, slow note | `DocsStates.tsx` | — | from code only |
| E. Errors (incl. E4 no access) | E4 "HM Admin: Hoa Mai gets the request" | Code shows the first admin with avatar; falls back to "The board owner gets the request" when the project has no admin | none (EM-2 was data: no admin in the project) | matches |
| F. Docs in Settings | Toggle and who can edit | Settings page (later SettingsPages design) | — | not checked (would change a shared project's settings) |
