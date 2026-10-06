# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [2.4.0] - 2026-10-06

Docs space, complete: the editor is now a real WYSIWYG (Tiptap) that still stores Markdown, the UI follows the Docs boards, and the MCP covers every Docs action. Mobile layout and roles / access requests are intentionally not part of this release.

### Added
- **Visual editor** built on Tiptap: formatting and floating toolbars, `/` block menu, `[[` suggester (pages, sections, tickets), callouts, tables with grips and cell tools, task lists, code blocks with syntax colours, images, drag handle, "On this page" rail, Visual | Markdown toggle, Publish and Discard dialogs, conflict banner with "View their changes", offline and back-online banners.
- **Search**: full-text (SQLite FTS5, LIKE fallback) with phrase and `-exclude` syntax, Ctrl/Cmd+K palette, results page with filters, find-in-page (Ctrl/Cmd+F) with Replace in the editor.
- **Import Markdown** from files or whole folders (drag and drop, front matter, folders become parent pages, link check before importing).
- **Rename with link rewrite** (preview of affected pages, Undo), heading-rename aliases so `[[Page#Old]]` keeps working.
- **Per-project Docs switch** in Settings, **offline copy** of recently read pages, **notifications** when someone publishes (Follow space), **hover preview cards** for page and ticket chips, Share and Page info popovers, "Changes since you last viewed" banner, Undo on Move, combined Recycle Bin (pages and tickets), manual ticket-to-page links and a `[[` suggester in ticket descriptions.
- **MCP tools** (13 new): `search_docs`, `move_docs_page`, `duplicate_docs_page`, `delete_docs_page`, `restore_docs_page`, `list_docs_recycle_bin`, `list_docs_versions`, `get_docs_version`, `restore_docs_version`, `resolve_docs_links`, `import_docs`, `link_ticket_doc`, `unlink_ticket_doc`; `update_docs_page` can also rename.
- Migration `c0d1e2f3a4b5`: `projects.docs_enabled`, `docs_links.origin`, `docs_anchor_aliases`, FTS index.

### Changed
- Docs UI rebuilt from the design boards (tokens, icons, tree, rail with flyouts, page view, dialogs, history and diff).
- PyYAML is now a server dependency (Markdown front matter).

---

## [2.3.0] - 2026-10-05

Docs space (phase 1): a page tree per project with a rich-text editor stored as Markdown, per the Docs design boards.

### Added
- **Docs view** next to Board / List / Timeline: page tree (drag to reorder or nest, quick filter, inline rename, row menu, collapsible rail under 1200 px), page view with "On this page" and "Referenced by", empty-space hero with five templates (Blank, Requirements, Meeting notes, Decision log, Technical design).
- **Editor**: Visual / Markdown toggle, formatting and floating toolbars, `/` block menu, `[[` suggester for pages, sections (`[[Page#Section]]`) and tickets, callouts (`> [!WARNING]`), tables, task lists, images, autosaved per-author draft (about 3 s) and Publish with a version note.
- **Versions**: every publish adds a version; conflict detection (409) with Keep mine / Reload; history drawer with line and word diff (inline or side by side) and Restore, which creates a new version.
- **References**: `[[Page#Section|label]]` and ticket keys render as chips (missing page, missing section, in Recycle Bin states); backlinks ("Referenced by"), and a "Linked docs" section on the ticket detail.
- **Move to…**, **Duplicate** (with sub-pages) and soft delete into the Recycle Bin (30 days, restorable as a whole subtree).
- **MCP tools**: `list_docs_pages`, `get_docs_page`, `create_docs_page`, `update_docs_page` (rejects a stale `base_version`).
- REST API under `/projects/{id}/docs/...` and `/docs/pages/{id}/...`; migration `b9c0d1e2f3a4` adds `docs_page`, `docs_version`, `docs_draft`, `docs_link`.

### Not yet
Full-text search, Markdown import, offline copy, roles and access requests, per-project Docs switch, notifications, hover preview cards, rename-rewrite of links, mobile layout.

---

## [2.2.0] - 2026-10-05

Comprehensive file attachment overhaul, interactive Markdown image resizing, consolidated attachments zone, and desktop system app opening.

### Added
- **Multi-format attachment support**: Upload and embed any file type (Word, Excel, PowerPoint, PDF, JSON, text, code, audio, video, archives) across all Markdown editors (Ticket Description, Comments, Work Log, Test Cases).
- **Consolidated Attachments Zone**: Redesigned to strictly match `Attachments.dc.html`, placed after Comments with square image thumbnails, file chips with type badges and direct download buttons, dashed add tile (`+`), and provenance origin tags (Description / Comment author).
- **Interactive Lightbox Preview Modal**: Full-screen preview modal portaled to `document.body` with deep ink/forest darkened blurred backdrop (`rgba(25, 38, 28, 0.65)`), full keyboard navigation (`Esc`), text/code viewer with copy tools, PDF viewer, media player, and Desktop "Open in App" button.
- **Interactive Markdown Image Drag-to-Resize**: Direct drag resizing in the WYSIWYG editor with 6 corner/edge handles, real-time dimension badge, quick percentage presets (25%, 50%, 75%, 100%), natural reset, delete action, and serialized Markdown width persistence (`![alt|width](url)`).
- **Desktop System App Opening**: Electron IPC `openPath` and backend `X-File-Path` headers allowing local files to be opened directly in their default system application (Excel, Word, PowerPoint, Code editor).
- **Sub-tasks checklist** in Ticket Detail: lightweight to-do steps inside a ticket (REST `/tickets/{id}/sub-tasks`, MCP `add_sub_task` / `toggle_sub_task` / `delete_sub_task`, new `sub_tasks` column).

### Changed
- **Ticket Detail design match**: Child-ticket list styled as "Sub-tickets" with status marks and progress counts.
- **Design system alignment**: Unified colors, button styles, typography (`Plus Jakarta Sans`, `JetBrains Mono`), and language (English) across upload notifications, preview modals, and file chips.

---

## [2.1.1] - 2026-10-05

Fix for Claude Code CLI MCP addition syntax.

### Fixed
- **Claude Code MCP add failed with missing `commandOrUrl`**: updated argument ordering in `claude mcp add` to place the server name (`kanban`) immediately after `add`, matching Claude Code CLI syntax requirements.

---

## [2.1.0] - 2026-10-05

One-click MCP setup for AI tools.

### Added
- Settings → MCP integrations: install, update, test and remove the kanban MCP server for Claude Code (User, Project or Local scope, through `claude mcp add`) and Antigravity (Global or Workspace `mcp_config.json`). Only the `kanban` entry is ever changed.

---

## [2.0.2] - 2026-10-05

Fixes for opening and importing backups made by older builds.

### Fixed
- **Databases created by pre-release builds could not be opened** ("Try again" on the splash, or a failed import): they are stamped with a migration (`f6a7b8c9d0e1`, "add_idea_board_fields") that was removed before 1.4.2, and alembic stopped with "Can't locate revision". Such databases are now re-stamped to the nearest existing revision and upgraded normally; all projects and tickets are kept (checked with a real 217-ticket backup).
- **Data folder check recognised by code scanning**: `POST /settings/data-path` still only accepts folders inside your home directory, now written in the form CodeQL understands, which clears 8 "uncontrolled data used in path expression" alerts that this change would otherwise raise. The home folder itself is no longer accepted, only folders inside it.
- **Import of a backup failed with "database disk image is malformed"**: the old `kanban.db-wal` / `-shm` files were left next to the replaced database. Import now checks the uploaded database first (a broken file is rejected with a clear message before anything is changed), removes the old WAL files when swapping, and flushes the WAL into the backup it keeps for rollback.

---

## [2.0.1] - 2026-10-05

Fixes for the 2.0.0 desktop app, found on a fresh install.

### Fixed
- **Desktop app icon was still the old one**: `icon.icns`, `icon.ico` and `icon.png` are regenerated from the current logo, and `generate-icons.js` now reads `ui/public/logo.svg` (the app logo). macOS may keep showing the old icon from its cache until the app is reinstalled or the Dock is restarted (`killall Dock`).
- **Desktop: existing data not loaded after upgrading to 2.0.0** (the app opened on "Create your first project"). A data folder chosen in Settings must win over the desktop's default `KANBAN_DB_PATH`, as it did before 2.0.0; the order was accidentally reversed. Your data was not deleted: it is still in your data folder.
- **Splash "Kanban is taking longer than usual to start" appeared too early**: the wait before it is now 30 s (was 8 s).

---

## [2.0.0] - 2026-10-05

A redesigned interface, real git integration, per-ticket workspaces, a much richer ticket detail, and an MCP server reworked for AI agents. The MCP changes are breaking for anything that scripts against the MCP tools (see **Breaking changes**), which is why this is a major version.

### Breaking changes (MCP)
- **Failures are errors, not `null`**: not-found, validation and workflow errors (e.g. "Done requires…", invalid status moves) are raised as tool errors (`isError`) whose message says how to fix the call and lists the valid ids. Previously some tools returned `None` or `{"error": …}`, and deleting an unknown comment or criterion "succeeded" silently.
- **`list_tickets` returns paginated compact summaries** `{total, count, offset, has_more, tickets}` instead of a plain list of full tickets (`detail=true` returns full objects; `limit` / `offset` page through).
- **The full activity log is no longer returned**: it is about 80% of a typical ticket. `get_ticket` returns only the 10 most recent entries (long texts shortened) plus `activity_total`; `activity_limit=N` changes the number (0 = none, a negative number = the whole history in full), and `activity_since=<ISO time>` returns what changed since then. Tools that change a ticket return it without any activity. Duplicate camelCase keys on branches are dropped.
- **Idea Space tools are hidden from MCP by default** (13 of 47 tools). Set `KANBAN_MCP_IDEA_TOOLS=1` to expose them again. The Idea Space web UI and REST API are unchanged.

### Added
- **Redesigned UI** following the new design system: tokens, icons and logo, ticket card and tags, status menu, toasts, loading states, drag-and-drop motion, the dark sidebar with hover expand, board / list / timeline / members / settings screens, and a restyled Ticket Detail (sidebar, acceptance criteria, sub-tickets, relations, comments, fullscreen toggle, delete as a header action).
- **Review and Testing statuses** across the backend, UI and MCP tools.
- **WYSIWYG Markdown editor** for descriptions, comments and test cases: toolbar, undo/redo, smart bold/italic, tables, task lists, nested lists, code blocks with language, strikethrough, rules and quotes, image upload (picker, paste, drop) with clear error messages, and safe link/image URLs.
- **Git integration**: a git repository per project with a per-ticket override; real branches created through GitPython with live ahead/behind; git worktrees (project defaults, per-ticket customisation); rename, checkout and merge verification against git; honest cleanup and optional git branch deletion; a real commit graph with overview and all-commits views, legend and a commit detail panel.
- **Workspace tab**: a scratch folder per ticket with a real file manager (create folders, upload, drag and drop, preview, download, delete), a Workspace section in Settings (root path, retention), automatic cleanup of Done / Won't do tickets after the retention period (with "Clean now" preview), and "Open folder" on the server machine. Agents get the path from the new MCP tool `get_ticket_workspace_path` (and `workspace_path` in `get_ticket`) and read/write the folder directly.
- **Activity tab**: every entry records who made the change ("You", "AI agent", or a name) and covers comments, acceptance criteria, work log, test cases, blocks and links, branches and checkouts, parent changes, Won't do reasons and repo paths; filters for comments and branches. The REST API accepts an `X-Actor` header; everything done through MCP is attributed to the AI agent.
- **Debug Space**: edit entries, confirm before deleting, real file attachments (new `POST /uploads/files`), links to real branches and test cases, validated kinds/roles, and a red dot only while a `blocked` entry has no later `resolved` one.
- **Test cases**: Running status, rich fields (description, expected result, notes, proof) and real file attachments with their real size.
- **"Done requires" toggles** in the ticket sidebar (all acceptance criteria met / all test cases passed), wired to the guards the backend already enforced.
- **Splash screen**: the first thing painted when the app opens (web and desktop). The logo, wordmark and progress bar are in `index.html`, so they show from the first frame, before any JavaScript loads. The cards intro (1.2 s) plays once per cold start; reloads skip it. The splash stays at least 600 ms, fades into the app in 200 ms, and honours `prefers-reduced-motion`.
- **Server unreachable state**: if the server does not answer within 30 s the splash shows "Can't reach the server" with a Try again button, the last attempt time and a retry countdown (every 10 s, then backing off), and opens the app by itself once the server is back.
- **App loading states**: while data loads the app shows a real shell with skeleton rows and cards of the same size as the real ones (no layout shift), a small status pill (after 300 ms; "Still loading... Check your connection" + Retry after 3 s), "Couldn't load your projects/tickets" with Try again after 15 s, and "Create your first project" when there are no projects.
- **Update required screen**: new `GET /version` (`version`, `latest`, `min_supported_version`); a UI build older than the minimum shows a non-dismissible "A new version is available" screen with Reload now. `KANBAN_MIN_UI_VERSION` overrides the minimum.
- Desktop: **Try again** after a backend start-up failure (new `retry-backend` IPC).
- **MCP**: new tools `update_project`, `delete_ticket`, `block_ticket`, `unblock_ticket`, `link_tickets`, `unlink_tickets`, `delete_test_case`, `checkout_branch`, `delete_work_log` and `get_ticket_workspace_path`; `update_ticket` can set assignee, dates, repo path, Won't do reason and the Done guards and empty fields with `clear_fields`; status tools accept `wont_do` with a reason; `create_ticket` accepts `assignee` and `start_date`; `add_branch` accepts `create_worktree` / `worktree_path`; `delete_branch` accepts `remove_worktree` / `delete_git_branch` / `force`. Test cases can be addressed by code (`TC-2`) and branches by name as well as by id.

### Changed
- **MCP tools reworked for AI use** (names unchanged): every description says when to use the tool, what the arguments mean and what comes back; parameters carry schema descriptions and real enums (`idea_energy` was documented as `low|medium|high` but the valid values are `seed|concept|hot|big_bet`); all tools have read-only / destructive / idempotent annotations; the server sends usage instructions on connect (HTTP and stdio); redundant schema titles are removed. The default tool list is 34 tools, roughly 6.9k tokens.
- **Ticket detail validates input** (HTTP 400 instead of silently accepting): empty or over-long titles, invalid dates or a start after the due date, negative or absurd estimates, bad tags, parents that are the ticket itself, missing, in another project or nested too deep, block links across projects or forming a cycle, and empty or oversized comments, criteria and test-case titles. When the server refuses an edit the form rolls back to the saved value.
- **Deleting a ticket cleans up after itself**: sub-tickets are detached, block and link references on other tickets are removed, and its workspace folder is deleted.
- Description edits are saved once per pause (and on blur or close) instead of once per keystroke, so the Activity tab no longer gets an entry per key.
- Anonymous GUI comments are shown as "You"; the made-up fallback names in the ticket detail are gone.

### Fixed
- **Markdown editor**: switching bold or italic off while typing moved the caret and scrambled the text; merely opening and closing the editor rewrote the description (bold, tables, task lists and code languages could be lost); inline runs typed into an empty editor were saved as separate paragraphs; a rapid burst of saves could land out of order and drop the end of the text.
- **Debug Space** crashed the whole ticket modal on an entry with an unknown kind or role.
- Downloads of attachments now keep their original file name; non-image uploads are served only as downloads.
- Desktop: reloading the window after the backend was already up left the UI waiting for a ready event that never came again; it now asks for the backend port directly.
- Layout polish: ticket modal frame height across tabs, clipped tab icons and badge dots, board columns no longer force horizontal scroll, long branch / commit / author names are truncated, unset due date and estimate show a dash.

### Security
- Workspace paths are validated against the workspace root (real path, symlinks ignored); "Open folder" no longer puts any path on a command line; Markdown link and image URLs are limited to safe schemes and normalised before reaching the DOM; uploaded files that are not images are never served inline.

---

## [1.4.5] - 2026-09-16

### Fixed
- **Desktop app SSE reconnect stuck on the wrong port**: the live-update stream resolved the backend's origin once at mount and never re-checked it, so if that happened before Electron's backend-ready signal arrived (more likely the longer the backend takes to start), it stayed permanently stuck retrying the wrong fallback port every few seconds — each retry force-refetched everything, producing a repeating load/stall cycle. It now re-resolves the origin on every reconnect attempt so it self-corrects.

---

## [1.4.4] - 2026-09-13

### Added
- **Comment editing & deletion**: comments can now be edited and deleted, end-to-end — MCP tools `update_comment`/`delete_comment`, `PATCH`/`DELETE /tickets/{ticket_id}/comments/{comment_id}`, and edit/delete controls on each comment in the UI.
- **Full Markdown for comments**: comment text now gets the same Markdown treatment as ticket descriptions — tables, task lists, code blocks, links, images, headings, etc., rendered via the shared `MarkdownRenderer` and authored with the same toolbar-driven editor (shown on focus, collapses back to a plain box when idle).

### Fixed
- The MCP server's HTTP transport (`/mcp`) was completely broken — every tool call over HTTP raised `RuntimeError: Task group is not initialized`, because the mounted MCP sub-app's lifespan was never started. The stdio transport (used by VS Code/Claude Desktop) was unaffected. Also corrected the documented client URL to `/mcp/` (trailing slash required).

### Changed
- README's MCP tool count corrected (33 tools registered); `add_comment`/`update_comment` tool descriptions now note Markdown support.

---

## [1.4.3] - 2026-09-12

### Added
- **Fuzzy ticket search**: search now matches ticket id/code (e.g. searching `25` finds `MON-25`), title, description, and tags — not just an exact title substring. Matching runs server-side (`rapidfuzz`), ranked by relevance.

### Fixed
- Kanban columns (and List/Timeline views) can now be scrolled to see tickets beyond the visible area — the column container had no real height bound, so overflow was silently clipped instead of scrolling
- Search input no longer flashes the whole board to a blank "Loading tickets…" state and loses focus on every keystroke (ticket query now keeps showing previous results while a new search fetches)

### Changed
- Scrollbars are now hidden on the kanban column, list, and timeline scroll containers (scrolling still works, just no visible track/thumb)

---

## [1.4.2] - 2026-04-26

### Added
- **Idea Board Backend**: full backend integration for Idea Board — REST API + MCP tools for idea tickets (CRUD, status transitions, promote to ticket, microthoughts, assumptions, activity trail)
- **Idea Board API wiring**: React UI fully connected to backend API with SSE real-time invalidation, optimistic status updates with rollback

### Fixed
- Idea board columns now scroll correctly when cards overflow (flex-shrink + min-height fix)
- Idea status names aligned between backend and frontend (draft/in_review/approved/dropped)
- Vite proxy config updated to forward `/api/*` routes to backend

---

## [1.4.1] - 2026-04-22

### Fixed
- **BUG-01** Tags now persist after saving in IdeaTicketModal (missing field in API schema and service)
- **BUG-02** Promote to Board is now atomic and idempotent — dedicated `/promote` endpoint prevents duplicate tickets on retry
- **BUG-03** Full column is now the drag drop target (not just the inner card list), fixing silent no-op when dropping on empty Approved column
- IdeaTicketModal crash when `ideaStatus` is null or unexpected value (status style lookup now has safe fallback)

## [1.4.0] - 2025-07-17

### Added
- **Idea Board**: new per-project idea board with 3 columns (Draft, Approved, Dropped)
- **IdeaCard**: draggable cards with emoji, color accent, status badges, description preview
- **IdeaTicketModal**: full view/edit/approve/drop/promote workflow with 2-stage promotion confirm
- **BoardSwitcher**: pill-tab switcher between main Kanban board and Idea Board (persisted per project)
- **MCP tools**: `list_idea_tickets`, `create_idea_ticket`, `update_idea_ticket`, `promote_idea_ticket`, `drop_idea_ticket`
- **SSE**: targeted idea board cache invalidation via project-scoped `idea_ticket_*` events

---

## [1.3.13] - 2026-04-18

### Fixed
- Drag-and-drop snap-back: ticket no longer returns to original column after drop. Implemented local state synchronous update so the card stays in the destination column immediately.

---

## [1.3.12] - 2026-04-18

### Added
- **B&W TV theme toggle**: A grayscale filter mode inspired by classic black & white TV. Toggle available in the Settings panel; preference persisted across sessions.

---

## [1.3.11] - 2026-04-18

### Changed
- **Ticket Card redesign (IAM-111)**: Added type-color left border accent, hover-reveal drag handle icon, consolidated footer with priority dot, tags (max 2 + overflow), estimate/subtasks/due on one row; assignee avatar moved to header
- **Board layout improvements (IAM-114)**: Column headers with ticket count badge; empty columns show "No tickets" placeholder; board title hierarchy improved
- **Modal polish (IAM-115)**: Ticket detail modal 70/30 layout, create form fields grouped into sections (Basic info / Metadata / Dates), delete confirmation styled as warning strip; Jira-style grouped relations with inline add button and hover-reveal remove

---

## [1.3.10] - 2026-04-18

### Changed
- Redesigned Relations section in ticket detail: replaced 7 separate labeled sections with a compact unified list and single inline "Add relation" form with dropdown type selector and ticket search

---

## [1.3.9] - 2026-04-17

### Added
- **WorkLog (IAM-88)**: Markdown editing and image support for work log notes — supports bold, italic, lists, links, image paste (Ctrl+V), and image file upload
- **Test Case Proof (IAM-89)**: Markdown editing and image support for test case proof field — same capabilities as WorkLog
- Extracted shared `MarkdownRenderer` component for consistent markdown sanitization

---

## [1.3.8] - 2026-04-17

### Added
- Extended ticket relationship types: `relates_to`, `causes`/`caused_by`, `duplicates`/`duplicated_by`
- Bidirectional link management — adding a link auto-creates the inverse on the target ticket
- New API endpoints: POST/DELETE /tickets/{id}/links
- RelationsSection UI shows all relationship types with human-readable labels
- Cross-project links and self-links are blocked server-side

---

## [1.3.7] - 2026-04-17

### Added
- Per-ticket toggles to block Done transition when ACs or TCs are not fully passed (`block_done_if_acs_incomplete`, `block_done_if_tcs_incomplete`)
- Server-side validation returns combined error message when multiple guards fail
- UI toggle switches in ticket detail view for both guards
- Specific backend error messages surfaced in ticket modal (no more generic errors)

---

## [1.3.6] - 2026-04-16

### Improved
- Rename default project member from 'Quản trị viên' to 'Admin'
- Board columns now sort tickets newest-first so new tickets appear at the top; parent-child hierarchy is preserved

---

## [1.3.5] - 2026-04-16

### Improved
- Desktop app startup time on macOS: Electron window now appears immediately (<3s) while the Python MCP backend warms up in parallel. A loading overlay is shown during connection; a graceful error state is displayed if the backend fails to start.

---

## [1.3.4] - 2026-04-15

### Changed
- CI/CD: automated release pipeline via GitHub Actions

---

## [1.3.3] - 2026-04-15

### Fixed
- Markdown tables in ticket descriptions now display with borders, header background, and alternating row colors

---

## [1.3.2] - 2026-04-15

### Fixed
- Markdown tables now render correctly in ticket descriptions (added `remark-gfm` GFM support)

---

## [1.3.1] - 2026-04-14

### Fixed
- Fixed import restoring empty data — SQLite WAL was not checkpointed before export, causing the ZIP to capture an outdated snapshot. Export now runs `PRAGMA wal_checkpoint(TRUNCATE)` before zipping so all committed data is included.

## [1.3.0] - 2026-04-14

### Added
- Settings panel (⚙️ in sidebar) to change the data folder at any time — moves kanban.db and uploads to the new location, persists across restarts.
- Export all data as a ZIP file (database + attachments) from the Settings panel.
- Import a previously exported ZIP to fully replace all data.
- Electron desktop: native folder picker dialog for data folder selection.

### Security
- ZIP Slip protection on import (path traversal via crafted archive entries is blocked).
- ZIP bomb protection on import (500 MB upload cap, 50k file limit, 2 GB uncompressed limit enforced during extraction).
- Data folder path restricted to within the user's home directory.
- Conflict guard prevents overwriting an existing database when changing the data folder.

---

## [1.2.7] - 2026-04-14

### Fixed
- Fixed image file upload in ticket description editor — OS file picker no longer causes the editor to collapse and abort the upload.
- Fixed pasted images overflowing horizontally in the description view — images now scale to fit the container width.
- Added rapid-click guard on image upload button to prevent multiple focus listeners from accumulating.
- Sanitized image filenames in Markdown alt text to prevent malformed Markdown output.

---

## [1.2.6] - 2026-04-13

### Added
- Added support for pasting images from the clipboard into ticket descriptions.
- Added direct image file upload support for ticket descriptions.
- Uploaded images are automatically inserted as markdown at the cursor position.
- Preserved existing autosave and markdown preview behavior for image-rich content.

---

## [1.2.5] - 2026-04-11

### Fixed
- Fixed an issue causing disjoint database instances where the desktop UI hit the user's data directory while the MCP server proxy spawned by VS Code fell back to a localized sqlite instance. Path is now explicitly synced during IDE proxy-setup.

---

## [1.2.4] - 2026-04-11

### Changed
- Desktop app now uses the project's Kanban logo instead of the default Electron icon
- Web UI favicon updated to use the repo logo (SVG)
- Added `desktop/scripts/generate-icons.js` to regenerate icons from SVG source

---

## [1.2.2] - 2026-04-11

### Changed
- Dependency upgrades: Electron 34 → 39, electron-builder 25 → 26, Vite 5 → 8, axios 1.14 → 1.15, cryptography 46.06 → 46.0.7.

---

## [1.2.1] - 2026-04-11

### Fixed
- Fixed blank/white screen on Electron app launch (UI now served from backend HTTP, not `file://`).
- Fixed CORS and Chromium Private Network Access issues in packaged mode.
- Fixed Alembic migration: `blocks` and `blocked_by` missing columns causing 500 errors.
- API base URL routing fix for packaged builds using `window.location.origin`.
- SSE event source memory leak guard added for packaged Electron mode.
- Hardened path traversal protection in static file serving.
- Backend startup script now exits cleanly instead of blank window on failure.

---

## [1.2.0] - 2026-04-11

### Added
- First native installable desktop application release via Electron.
- No manual setup required — installs and runs immediately.
- React UI served from bundled static files via Electron.
- Python FastAPI backend bundled as a PyInstaller binary; spawned automatically on launch.
- MCP stdio binary bundled for VS Code integration.
- VS Code auto-setup: on first launch, automatically registers the `kanban-board` MCP server in VS Code's `mcp.json`.
- SQLite database stored in platform user data directory (persists across updates).
- Clean app quit (Python child process terminated gracefully).

---

## [1.1.0] - 2026-04-10

### Added
- ✨ SSE Auto-refresh: The UI now automatically refreshes when AI agents use MCP tools to create, update, or delete tickets — no manual page reload required.
- Added `GET /events` SSE endpoint to FastAPI backend.
- MCP mutation tools and REST API routes now publish `invalidate` events on a shared async event bus (`server/events.py`).
- React frontend connects via EventSource and calls `queryClient.invalidateQueries()` on events.
- Auto-reconnects after 3s on connection drop.

---

## [v1.0.0] — 2026-04-09

Stable release — promoted from v1.0.0-beta after full end-to-end QC verification (IAM-71).

### Fixed

- **Test Cases UI**: `proof` and `note` fields were not rendered in the ticket modal after `update_test_case` MCP tool updated them. Rows now auto-expand on mount when data is present, and also re-expand when live prop updates arrive while the modal is open. A 📎 indicator is shown in collapsed rows that have proof/note data. (IAM-72)

---

## [v1.0.0-beta] — 2026-04-08

First public beta release. The core Kanban board experience is complete — full MCP server, a polished React UI, and AI agent integration.

### MCP Server

- **15 MCP tools** exposed via streamable HTTP transport (`/mcp`)
- Projects: `list_projects`, `create_project`
- Members: `list_members`, `add_member`, `remove_member`
- Tickets: `create_ticket`, `list_tickets`, `get_ticket`, `update_ticket`, `update_ticket_status`, `create_child_ticket`
- Annotations: `add_comment`, `add_work_log`, `add_test_case`, `update_test_case`
- FastAPI + SQLModel + SQLite backend with Alembic migrations
- Async I/O (`aiosqlite`), auto-generating ticket IDs (`PREFIX-N`)
- Activity log on every ticket status change
- Health check endpoint (`GET /health`)

### UI (React)

- **Board view** — drag-and-drop columns (Backlog → To Do → In Progress → Done) via `@dnd-kit`
- **List view** — grouped by status, sortable by due date or created date, collapsible groups
- **Timeline / Gantt view** — Gantt chart + event timeline sub-views, overdue highlighting
- **Ticket modal** — full ticket detail with inline editing, acceptance criteria checklist, sub-tickets, tags, priority, type, story points, assignee, parent ticket
- **Comments & activity** — threaded comments, work log, test cases with pass/fail/proof
- **Project sidebar** — multi-project navigation, project color coding
- **Members management** — per-project member list with color avatars
- **Recycle bin** — soft-delete and restore tickets
- **Search & filter** — real-time ticket search, priority filter (Critical / High / Medium / Low)
- Connected to the MCP server via REST API (no mock data)
- Bento Grid design system: cream background (`#F5EFE0`), deep burgundy primary (`#3D0C11`), vibrant column accent colors

### Infrastructure

- `uv` for Python dependency management and running the server
- `ruff` for linting and formatting
- `pytest` + `httpx` + `ASGITransport` for async API tests
- Vite + TypeScript for the React build
