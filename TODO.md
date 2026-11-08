# TODO

Follow-ups from tuning the Designer AI (issue #265). Nothing here is started.

## Skills for any AI member

Today:
- The board's own design guide (`kanban-board:canvas-design`, with `craft.md` and the two exemplar boards) is loaded
  for every member that runs on Claude Code, whatever its role. It cannot be turned off (`services/ai/runs.py`,
  `board_skills.plugin_dir()`).
- Installed plugins are on for a member by its own switch, else the project default, else its role
  (`services/ai/plugins.py` `on_for`). The UI has the per-member switch (`MemberPluginsCard`) and "on for every
  member" (`InstalledTab`).
- Members on other providers (Gemini / Antigravity, adapters) get no skills or plugins. They can read the guide only
  through `docs_read(design_guide)`.

To do:
- [ ] **A switch for the board's own skills.** Treat `canvas-design` like an installed plugin: on by default for
  every Claude Code member, with a per-member and a project-wide switch in the same places as the other plugins.
  Someone may want it off for a member that never draws, to save context.
- [ ] **Show each member's skills on its page.** List the skills it will be told about at its next run (the same list
  as `skills_block`), with where each comes from: the board, its role, the project default or its own switch.
- [ ] **Skills for members on other providers.** Find out what Gemini / Antigravity can load (a skills folder, a
  system-prompt file). Give them the guide and the plugins they are switched on for, or say in the UI that skills are
  Claude Code only.
- [ ] **Suggest plugins by the work, not only by the role.** For example, a ticket that asks for 3D, a chart or
  motion would suggest turning on `threejs`, `tufte-data-viz` or `motion-design` for whoever takes it.

## Design guide

- [ ] **The canvas speaks the product's language everywhere.** v8c still used English for page names and board
  eyebrows ("Screens · Today", "DIRECTIONS · V1"). Say it in the guide and check it in the critique pass.
- [ ] **A fuller illustration board.** v8c drew only four pictures. Ask for the full set the screens use: the
  signature in each state, empty states, onboarding, the app icon at its sizes.
- [ ] **Keep checking that skills do not set the look.** A run that opened eleven rule-set skills came out one flat
  hue, no better than a run that opened none. The Designer pack (v8) keeps only motion, chart and checking skills.
  Rerun the Giọt brief after any change to the pack or the guide, and compare it with v8 / v8c.

## Open

- [ ] Open a PR for `claude/clever-volta-fv408y`, or fast-forward `claude/designer-tune` (PR #264) to it.
