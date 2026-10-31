# Design

Redesign reference for the Kanban Board app (React UI in `ui/`), exported from the Claude Design canvas so it can be reviewed and implemented against without opening the canvas.

- **Canvas (design source of truth):** https://claude.ai/artifact/B3jiFjnoEL9erRN7QYRHj2
- **Canvas version exported:** `1793431332-0cc8` (73 desktop/web artboards; the newest — Docs comments, Diagrams, AI schedules, the two Preview boards, the two Settings boards (which replace the old Settings modal design), and the new Idea Space boards, the Sketch tool, AI where you work, the AI Team boards, the AI paused board, the Docs AI boards, the desktop menu bar and the guideline design — are proposals; docs for earlier ones keep their original header version; docs for unchanged artboards keep their original header version, each `sha256` in the doc header and `MANIFEST.json` is authoritative) — see [`MANIFEST.json`](MANIFEST.json) for per-file sha256, size and export date.

> The canvas also has a **Mobile** page (iOS-first designs for every screen). Those artboards are not exported to this folder yet.

## Layout

| Path | Contents |
|---|---|
| `foundations/`, `components/`, `screens/` | One Markdown doc per artboard: verbatim text, notes, and PNGs inserted at the right spots |
| `images/<doc-name>/` | 2x PNG renders of each visual block (real fonts) |
| `source/*.dc.html` | Verbatim snapshots of the artboards; open directly in a browser |
| `MANIFEST.json` | Canvas version + sha256 of every source file |
| `scripts/export-mainboard-example.js` | Reference Playwright script used to render the images (paths are sandbox-specific) |

Each doc's header links to its source file and records the canvas version and sha256; each image section has a `Source:` line pointing at the matching block (HTML comment name first, line numbers approximate).

## Index

### Foundations

- [Theme & Typography](foundations/theme-and-typography.md)

### Components

- [Account Menu](components/account-menu.md)
- [Activity](components/activity.md)
- [Add / Edit / Delete Acceptance Criterion](components/add-ac.md)
- [Add Sub-ticket](components/add-subticket.md)
- [AI work on tickets](components/ai-ticket-work.md)
- [Attachments](components/attachments.md)
- [Sub-task Grouping](components/board-grouping.md)
- [Branches](components/branches.md)
- [Debug Space](components/debug-space.md)
- [Description — Markdown](components/description-markdown.md)
- [Drag & Drop](components/drag-drop.md)
- [Ticket Type Icons](components/icons.md)
- [Loading States](components/loading.md)
- [New Ticket](components/new-ticket.md)
- [Relations](components/relations.md)
- [Status Menu](components/status-menu.md)
- [Tags](components/tags.md)
- [Test Cases](components/test-cases.md)
- [Ticket Card](components/ticket-card.md)
- [Comments](components/ticket-comments.md)
- [Ticket Detail — with Sub-tickets](components/ticket-detail-parent.md)
- [Ticket Detail](components/ticket-detail.md)
- [Doc references in tickets](components/ticket-doc-refs.md)
- [Pending ticket](components/ticket-pending.md)
- [Reopen ticket](components/ticket-reopen.md)
- [Notification Toast](components/toast.md)
- [Workspace](components/workspace.md)

### Screens

- [Board AI — assistant & suggestions](screens/ai-board-assistant.md)
- [AI members — list & register](screens/ai-members.md)
- [AI provider configuration](screens/ai-provider-config.md)
- [AI — schedules](screens/ai-schedules.md)
- [AI safety & cost](screens/ai-safety-cost.md)
- [AI paused — one clear state on every screen](screens/ai-paused.md) (supersedes D1 of AI safety & cost)
- [AI Team — what the AIs are doing and how work moves](screens/ai-team.md)
- [AI Team — where people stepped in, and AI health](screens/ai-team-review.md)
- [AI Team — Flow: the Timeline view](screens/ai-team-timeline.md)
- [AI Team — Timeline: time, scope, motion, states](screens/ai-team-timeline-cases.md)
- [AI where you work — ticket chat, @mentions & editor](screens/ai-where-you-work.md)
- [App loading](screens/app-loading.md)
- [Desktop — menu bar (macOS, Windows)](screens/desktop-menu.md)
- [Diagrams — draw.io](screens/diagrams-drawio.md)
- [Docs — page actions & history](screens/docs-actions.md)
- [Docs — comments](screens/docs-comments.md)
- [Docs — editor](screens/docs-editor.md)
- [Docs — empty, loading & errors](screens/docs-empty.md)
- [Docs — page view](screens/docs-page.md)
- [Docs — references](screens/docs-references.md)
- [Docs — search](screens/docs-search.md)
- [Docs AI — ask, write, read & edit](screens/docs-ai.md)
- [Docs AI — keeping docs true, proposals & control](screens/docs-ai-care.md)
- [Guideline — design of the user and administrator guide](screens/guideline-design.md)
- [List View](screens/list-view.md)
- [Login](screens/login.md)
- [Main Board](screens/main-board.md)
- [Members](screens/members-view.md)
- [Forgot / Reset Password](screens/password-reset.md)
- [Idea Space — AI help](screens/idea-ai-help.md)
- [Idea Space — capture & triage](screens/idea-capture-triage.md)
- [Idea Space — the idea page](screens/idea-page.md)
- [Idea Space — promote & migration](screens/idea-promote-migration.md)
- [Idea Space — research log, workspace & activity](screens/idea-research-log-workspace-activity.md)
- [Idea Space — list, stages & matrix](screens/idea-space-views.md)
- [Preview — file types & states](screens/preview-types.md)
- [Preview — open & viewer](screens/preview-viewer.md)
- [Settings — MCP integrations](screens/settings-mcp.md)
- [Settings — pages & states](screens/settings-pages.md)
- [Settings — structure & navigation](screens/settings-structure.md)
- [Sign Up](screens/sign-up.md)
- [Sketch — paint-style drawing tool](screens/sketch-tool.md)
- [Splash - Cards animation (live)](screens/splash-animation.md)
- [Splash screen](screens/splash.md)
- [Timeline View](screens/timeline-view.md)

## Regenerating

Re-read the artboards from the canvas, compare sha256 against `MANIFEST.json`, and re-render any changed block with headless Chromium (`--no-sandbox --ignore-certificate-errors`, wait for `document.fonts.ready`, `deviceScaleFactor: 2`, clip to each visual block's bounding box). The canvas is the source of truth; if it changes, bump the version in `MANIFEST.json` and the doc headers.
