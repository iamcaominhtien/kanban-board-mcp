# Design

Redesign reference for the Kanban Board app (React UI in `ui/`), exported from the Claude Design canvas so it can be reviewed and implemented against without opening the canvas.

- **Canvas (design source of truth):** https://claude.ai/artifact/B3jiFjnoEL9erRN7QYRHj2
- **Canvas version exported:** `1791209276-a0aa` (41 desktop/web artboards; docs for unchanged artboards keep their original header version, each `sha256` in the doc header and `MANIFEST.json` is authoritative) — see [`MANIFEST.json`](MANIFEST.json) for per-file sha256, size and export date.

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
- [Ticket Detail — with Sub-tickets](components/ticket-detail-parent.md)
- [Ticket Detail](components/ticket-detail.md)
- [Notification Toast](components/toast.md)
- [Workspace](components/workspace.md)

### Screens

- [App loading](screens/app-loading.md)
- [Docs — page actions & history](screens/docs-actions.md)
- [Docs — editor](screens/docs-editor.md)
- [Docs — empty, loading & errors](screens/docs-empty.md)
- [Docs — page view](screens/docs-page.md)
- [Docs — references](screens/docs-references.md)
- [Docs — search](screens/docs-search.md)
- [List View](screens/list-view.md)
- [Login](screens/login.md)
- [Main Board](screens/main-board.md)
- [Members](screens/members-view.md)
- [Forgot / Reset Password](screens/password-reset.md)
- [Settings — MCP integrations](screens/settings-mcp.md)
- [Settings](screens/settings-view.md)
- [Sign Up](screens/sign-up.md)
- [Splash - Cards animation (live)](screens/splash-animation.md)
- [Splash screen](screens/splash.md)
- [Timeline View](screens/timeline-view.md)

## Regenerating

Re-read the artboards from the canvas, compare sha256 against `MANIFEST.json`, and re-render any changed block with headless Chromium (`--no-sandbox --ignore-certificate-errors`, wait for `document.fonts.ready`, `deviceScaleFactor: 2`, clip to each visual block's bounding box). The canvas is the source of truth; if it changes, bump the version in `MANIFEST.json` and the doc headers.
