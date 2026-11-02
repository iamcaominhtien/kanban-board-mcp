# App: account, start-up, previews, notifications — design audit

Demo video: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/audit/videos/app.mp4` (not in the repo)

Summary: 44 findings (1 critical, 5 high, 17 medium, 21 low), plus two "same as" rows. The worst is a security gap in the file preview: an uploaded HTML file runs its scripts with the app's own origin, where the design asks for a locked frame. The big structural gaps are things never built: the account screens (Login, Sign up, Password reset, and with them the hosted MCP variant) and any dark theme for the splash and loading states. What is built (Members, the MCP section, the desktop menu, the notification centre, splash timing, loading pill, previews for 15 file types) follows the design closely. The rest are details: missing file facts, text buttons where icon buttons are drawn, native time and select fields, and a few copy slips.

Notes on the run:
- Data I added: **KAN-39** "[app] Preview types: one file of each kind" (15 files: png, transparent png, svg, pdf, xlsx, csv, docx, log, json, md, html, zip, mp3, mp4, sh), **KAN-40** "[app] Preview: a 3-page PDF and a file with no preview", **KAN-41** "[app] Preview: an HTML page that reads the app window" (a harmless page that only prints what it can read). Nothing existing was edited or deleted.
- States that would change data or this machine were reached with Playwright route stubs only: the member add error (POST stubbed to 500), the blocked remove (DELETE stubbed to a 400 with the server's own message, so no member was removed), the slow and failed loads, Update required (`/version` stubbed). In Settings › Integrations › MCP every install, update and remove POST was blocked by a stub; Install was never pressed.
- The desktop windows (About, Keyboard Shortcuts, What's new, Report an issue) were opened in the browser with a stubbed `window.electronAPI` that sends the menu's `app-command` message. The native menu itself was audited from `desktop/menu.js` only.
- No AI run was started.
- The app has no dark theme at all (no `prefers-color-scheme` rule in `ui/`), so every dark frame below is one `missing` row per artboard.

## Members (`design/screens/members-view.md`)

Coverage: frames checked in the app: 1, 3 (pending and error, stubbed), 4 (blocked remove, stubbed). From code only: 2 (`No members yet.` is in `MembersPanel.tsx:307`). Extended by [ai-members](../../../design/screens/ai-members.md): the Humans / AI tabs and the count in the tab instead of beside the title are from that later doc, so they are not findings.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| MV-1 | 3 | Medium | copy | Add fails: "Failed to add member. Please try again." | "Request failed with status code 500": the raw axios message wins over the fallback | `ui/src/components/MembersPanel.tsx:72` | Use the design sentence for network and 5xx errors; keep the server `detail` only for 409 (duplicate name) |
| MV-2 | 4 | Medium | layout | The message sits under the blocked row, and that row's ✕ stays tinted red (`#FBEAE6` tile) | The message is under the whole list, above Add member; the ✕ is red only while hovered | `MembersPanel.tsx:310` | Keep `removeError` per member id and render it under that row with the tinted ✕ |
| MV-3 | 1 | Low | state | Add is a solid green button | Add is pale and disabled until a name is typed | `MembersPanel.tsx:340` | Fine as behaviour; if kept, say so in the design |
| MV-4 | 1 | — | component | Tinted initials avatars, no role control | Same as ai-1 AM-1 (solid avatars, native `<select>` for the Docs role on every row) | `MembersPanel.tsx:255-282` | See ai-1 AM-1 |

Images: [design 1](../../../design/images/members-view/members-view-1-full-screen.png) · [design 3](../../../design/images/members-view/members-view-3-add-pending-error.png) · [design 4](../../../design/images/members-view/members-view-4-remove-blocked.png) · [now 1](shots/app/members-view-1.jpg) · [now 3 pending](shots/app/members-view-3a.jpg) · [now 3 error](shots/app/members-view-3.jpg) · [now 4](shots/app/members-view-4.jpg)

## Login, Sign up, Forgot / reset password (`design/screens/login.md`, `sign-up.md`, `password-reset.md`)

Coverage: not built. There is no sign-in, account or password screen in `ui/src` (the only "Sign in" strings are for AI accounts). The app runs locally without accounts, which is also why the hosted parts of other boards (MCP web variant, account menu) are missing.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| LG-1 | 1–7 | High | missing | Login: split brand panel and form, email and password, Google / GitHub, wrong credentials, signing in, locked out, session expired | Not built | — | Build with the hosted mode (needs auth on the server) |
| SU-1 | 1–8 | High | missing | Sign up: name, email, password with strength meter, check inbox, resent, confirmed, link expired | Not built | — | Same |
| PR-1 | 1–7 | High | missing | Ask email, sending, link sent, new password, mismatch, updated, link invalid | Not built | — | Same |

Images: [design login 1](../../../design/images/login/login-1-full-page.png) · [design sign-up 1](../../../design/images/sign-up/sign-up-1-full-page.png) · [design reset 1](../../../design/images/password-reset/password-reset-1-ask-email.png)

## Settings › Integrations › MCP (`design/screens/settings-mcp.md`)

Coverage: frames checked in the app: 1, 2, 2b, 7, 9a (status call delayed by a stub). From code only: 3, 4, 5, 6a, 6b, 8, 9b (the chips "Installing…", "Installed", "Update available", "Error", "Not detected", the Remove confirm and "Check again" are all in `McpIntegrations.tsx:273-345,496-531`). Not built: 10a, 10b (web / hosted). Frame 0 (the whole modal) is replaced by the redrawn Settings page (#283) and is not compared. The tool count is real (14), so "33" is not a finding. The MCP section is close to the design.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| MCP-1 | 1, 2 | Low | component | Mono chip `kanban - 33 tools` beside the "MCP integrations" title | "kanban" chip and "· 14 tools." inside the subtitle line | `ui/src/components/McpIntegrations.tsx:701-705` | Render one mono chip `kanban · N tools` after the `<h2>` |
| MCP-2 | 2 | Low | copy | "`~/.claude.json` (top level). Available in all your projects." | "(top level)" is missing | `McpIntegrations.tsx:51` | Add it to the user scope note |
| MCP-3 | 2b | Low | missing | Project folder with Browse…; "Stored in `.mcp.json` in the project root. Shared with your team through git." | In the browser there is no Browse… (desktop only, fine), but the whole Stored in block disappears until a folder is typed | `McpIntegrations.tsx:626` | Show Stored in with "`.mcp.json` in the project root" before a folder is chosen |
| MCP-4 | 9a | Low | state | Spinner and "Checking which tools are installed…" above two row-shaped skeletons (tile, two lines, chip, button) | Two plain shimmer bars, the text under them and no spinner | `McpIntegrations.tsx:709-716` | Draw the skeleton as the row; move the status line above with the spinner |
| MCP-5 | 10a, 10b | Medium | missing | Web build: copy-only blocks plus an API token block (create, masked value, last used, revoke) | No hosted mode; the browser build shows the desktop rows with Install (it works because the server is local) | — | Build together with hosted mode (LG-1) |

Images: [design 2](../../../design/images/settings-mcp/settings-mcp-2-claude-code-user-scope.png) · [design 2b](../../../design/images/settings-mcp/settings-mcp-2b-claude-code-project-scope.png) · [design 7](../../../design/images/settings-mcp/settings-mcp-7-antigravity-expanded.png) · [design 9a](../../../design/images/settings-mcp/settings-mcp-9a-checking-status.png) · [now 1](shots/app/settings-mcp-1.jpg) · [now 2](shots/app/settings-mcp-2.jpg) · [now 2b](shots/app/settings-mcp-2b.jpg) · [now 7](shots/app/settings-mcp-7.jpg) · [now 9a](shots/app/settings-mcp-9a.jpg)

## Desktop menu bar (`design/screens/desktop-menu.md`)

Coverage: the menus (B, C, D, F, G, H) from `desktop/menu.js` only. The doc's own "Implementation notes (3.15.0)" section wins where it differs (Find in Board ⇧⌘F, no Show Sidebar, Idea Space always in View, the label change instead of the update dot), so those are not findings. The four in-page windows (E) were opened in the browser with a stubbed `electronAPI`. Section I (update toasts) is in `desktop/main.js:257,289,291` with the design copy. Every menu, item, order, platform split and greyed state of D and F matches. The extra View item "Keep awake while AI runs" is a later feature and does not break the menu.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| DM-1 | E Keyboard Shortcuts | Low | layout | Two columns (Go to, Search · Create, AI and editor), search field, footnote "On Windows and Linux the keys show as Ctrl, Shift and Alt." | One long scrolling column; each row has a second line "desktop menu" (its source, as the implementation notes ask) | `ui/src/components/desktop/DesktopWindows.tsx:82-125` | Lay the groups in two columns and show the source as a small right-aligned tag |
| DM-2 | E About | Medium | missing | Centred window: green app tile, name, version line, blurb, "Release notes ↗" and "Copy diagnostics ⧉" with icons, © line | A dialog titled "About" with ✕; no app tile; buttons without icons; Close added | `DesktopWindows.tsx:212-240` | Add the 64 px tile and the button icons; title the window with the app name |
| DM-3 | E Report an issue | Medium | component | A grey facts block (3 mono lines), a green ✓ line "Included: …" and a red ✕ line "Never included: …"; "Open GitHub" with an external icon | The whole issue template is shown as raw Markdown (`**What happened**`, `**Steps**`…); included / never included is one grey sentence; no icons | `DesktopWindows.tsx:163-210` | Show only the facts block; draw the two lines with the check and x icons in `#2E6F40` / `#C2410C`; add the icons |
| DM-4 | E What's new | Low | copy | "Released 29 Oct 2026"; "↗ Full changelog" and a primary Close | "Released 2026-11-02"; Full changelog has no icon; Close is secondary | `DesktopWindows.tsx:127-160` | Format the date as "2 Nov 2026"; add the icon; make Close primary |
| DM-5 | D | Low | copy | "What’s New in 3.10.0" (typographic apostrophe); Linux Exit Alt+F4 | "What's New in …" with a straight apostrophe; Exit is Ctrl+Q on Linux | `desktop/menu.js:158,101` | Use ’; check whether Ctrl+Q on Linux is intended and note it in the doc |

Images: [design E](../../../design/images/desktop-menu/10-e-the-windows-the-menu-opens.png) · [design D](../../../design/images/desktop-menu/08-d-all-the-menus.png) · [now E (Shortcuts, About, What's new, Report)](shots/app/desktop-menu-E.jpg)

## Notifications (`design/screens/notifications.md`)

Coverage: frames checked in the app: C1 and C2 (panel, both tabs), D1 (a row and its hover), H (All notifications), K (the bell on a ticket header is there), L (Settings › Notifications). From code only: E (grouping, "Show all"), F (done rows: seen live as "Done — …"), G (toasts and "+N more" in `Toast.tsx`), K menu (`FollowBell.tsx` has every option), M (offline "Not connected", snoozed "Bring back now", gone rows, "Your computer is blocking notifications" exist). I (the day card) appeared at 18:00 during the run and matches the design (numbers, lines, "Open the 3 waiting", "Board health"): [now I](shots/app/notifications-I-daycard.jpg). Not found in code: M "20+" over a large group. NT-2 was seen before the day card arrived; with the card the Updates tab is no longer empty. The "J, after #270" table in the doc wins over the board (sound on by default, browser notifications), so those are not findings. The data had three "Shape cannot start" rows and two done "AI is paused" rows (from the ai-2 audit).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| NT-1 | C1, F | Low | copy | Done rows say why in a sentence: "Done — you answered in the ticket" | "Done — aI was resumed" in the panel and "Done — ai was resumed" on the page: the first letter is lower-cased even for "AI"; the detail line says "user paused all AI" (the actor is "user", not a name) | `ui/src/components/notifications/NotificationRow.tsx:658`; `server/services/ai/runs.py:5096` | Lower-case only when the second letter is lower case; pass the person's name as `by` |
| NT-2 | C2, M | Medium | state | Updates tab empty: nothing to say beyond the tab count; "No notifications yet" is only for "nothing at all yet" | Updates 0 shows the bell and "No notifications yet — When an AI member needs an answer…" while 3 items need you in the other tab | `notifications/NotificationPanel.tsx:46-54` | For the Updates tab use "No updates" with a short line; keep "No notifications yet" for an empty feed |
| NT-3 | D1 | Low | component | Hover adds "Snooze" and "Mute this ticket" as labelled buttons beside the action | In the panel both are icon-only (the labels are hidden at panel width) | `NotificationRow.tsx:431-480`, `NotificationRow.module.css:451` | Show the labels, or at least the Snooze label, as drawn |
| NT-4 | H | Medium | layout | All notifications sits under the normal top bar (project title, Board / List / Timeline / Docs, Board health, Pause all AI, Ask AI, bell, avatar) | The page replaces the top bar with its own header (← All notifications), so the board tabs and AI controls are gone while it is open | `notifications/AllNotificationsPage.tsx` | Render the page in the main area below the app top bar |
| NT-5 | H | Low | missing | Kind filters: Needs you, For information, From AI members, From people, Docs, Schedules | No "Needs you" (it is only a chip) and no "Docs" | `AllNotificationsPage.tsx:20-25` | Add the two kinds |
| NT-6 | L | Low | copy | "From Resources" and "Exists today" are notes on the design board | Both are shipped as grey text in the table rows | `ui/src/components/settings/NotificationsSettings.tsx:38-39` | Drop "Exists today"; keep "From Resources" only if it links there |
| NT-7 | L | Medium | component | Quiet hours "22:00 – 08:00" in one field with a clock icon; day card "☀ 18:00" | Native `type="time"` fields: "10:00 PM – 08:00 AM" and "06:00 PM", each with the browser's own clock icon next to ours, while the caption above reads "Weekdays at 18:00" | `NotificationsSettings.tsx:448,455,563` | Use a 24 h text time field (or hide the native picker icon and force 24 h) |
| NT-8 | L, M | Medium | state | When notifications are blocked: the "Your computer is blocking notifications" card with Open System Settings and Send a test; the switch reflects it | The Desktop notifications switch is shown **on** while the line under it says the browser is blocking them | `NotificationsSettings.tsx:370-400` | Show the switch off (or disabled) while permission is denied, with the refused card |
| NT-9 | L | — | component | Custom fields for Sound, Remind and Keep for | Same as ai-1 / ai-3 (native `<select>`: Chime, After 15 min, 90 days) | `NotificationsSettings.tsx` | See ai-1 AB-17 |
| NT-10 | L | Low | layout | Two columns: table on the left, the switches on the right at full width | The settings under the table are a 430 px column, so "Quiet hours" wraps to four lines next to a 690 px table | `NotificationsSettings.tsx` (settings block) | Give the block the table's width |

Images: [design C](../../../design/images/notifications/06-c-the-bell-and-the-panel.png) · [design H](../../../design/images/notifications/16-h-all-notifications.png) · [design L](../../../design/images/notifications/24-l-settings-notifications.png) · [design M](../../../design/images/notifications/26-m-states-and-problems.png) · [now C1](shots/app/notifications-C1.jpg) · [now C2 empty](shots/app/notifications-C2-updates-empty.jpg) · [now D1 hover](shots/app/notifications-D1-hover.jpg) · [now H](shots/app/notifications-H.jpg) · [now L table](shots/app/notifications-L-table.jpg) · [now L settings](shots/app/notifications-L-settings.jpg)

## Splash and Splash animation (`design/screens/splash.md`, `splash-animation.md`)

Coverage: frames checked in the app (1280×800, `/health` delayed or aborted by a stub): intro stills at 150, 500, 900 and 1300 ms, 5 resting, 6 error / offline (after the 30 s wait), 7 update required (`/version` stubbed). The timing in `ui/index.html:31-45` follows the splash-animation table (tile 0–300, back card 300–800, front 500–900, lines 800–1000, wordmark 1000–1200, bar from 1300). Not built: 8, 9 (dark). 10 (hand-off to Login) cannot happen (no login); the hand-off to the board fades as drawn.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| SP-1 | 8, 9; animation 2 | High | missing | Dark splash on `#1E2A22` that follows `prefers-color-scheme` at first paint | Always the light ground, even with the system in dark mode | `ui/index.html:13-29` | Add the dark tokens under `@media (prefers-color-scheme: dark)` in the critical CSS |
| SP-2 | 5 | Low | color | Flat `#FBFCFB` ground; progress bar fill forest `#2E6F40` on a light track | A large green radial glow behind the mark; the moving fill is mint `#68BA7F`, so the bar reads as an empty line in most frames | `ui/index.html:15` (`.kb-glow`), `ui/index.html:27` (`.kb-slide`) | Drop the glow (or note it in the design); use `#2E6F40` for the fill |
| SP-3 | 5, 6, 7 | Low | type | Same scale in every state: the wordmark is about 0.42 of the tile, status text about 0.17 | Resting tile 120 px with a 34 px wordmark and 13 px status; the error and update screens shrink the tile to 40 px and the heading to about 22 px, so they look much smaller than the resting screen | `ui/index.html:20-28`, `ui/src/components/Splash.module.css` | Scale the error and update states with the resting frame (tile about 72 px, heading about 36 px at 1280×800) |
| SP-4 | 6, 9 | Low | missing | Footer "Work offline is not available yet." | No footer line | `ui/src/components/Splash.tsx:250-300` | Add the line (without the `TODO(backend)` tag) |

Images: [design 5](../../../design/images/splash/splash-5-normal-start.png) · [design 6](../../../design/images/splash/splash-6-error-offline.png) · [design 7](../../../design/images/splash/splash-7-update-required.png) · [design 8 dark](../../../design/images/splash/splash-8-dark-normal-start.png) · [now t150](shots/app/splash-1-t150.jpg) · [now t500](shots/app/splash-2-t500.jpg) · [now t900](shots/app/splash-3-t900.jpg) · [now t1300](shots/app/splash-4-t1300.jpg) · [now 5](shots/app/splash-5-resting.jpg) · [now 6](shots/app/splash-6-error.jpg) · [now 7](shots/app/splash-7-update.jpg) · [now, system dark](shots/app/splash-8-dark.jpg)

## App loading (`design/screens/app-loading.md`)

Coverage: frames checked in the app with stubs: 1 (projects delayed), 3 (slow, over 3 s), 2 (tickets delayed), 4 (projects aborted, after 15 s), 5 (empty project list). 6 (no layout shift) belongs to comp-1 (LD-1, card skeleton size). Not built: 7, 8 (dark). The pill, the slow state with Retry, the failed panel and First run match the design copy.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| AL-1 | 2 | Medium | state | Phase 2: lane headers are real, with their counts (3, 2, 3) over skeleton cards; the filter bar is a skeleton | On a first load the counts are grey skeleton pills. On a reload with the last project remembered it is worse: the pill says "Loading tickets…" while every lane shows 0 and "No tickets" (as comp-1 LD-1 found for a project switch). The filter bar (search, Type, Priority, Assignee, Reopened, Pending, Hide pending, Group by) is real and clickable | `ui/src/components/Column.tsx:100-101` (badge skeleton) | Show the counts from the lane response; draw the filter bar as skeletons until tickets arrive |
| AL-2 | 1 | Low | layout | Phase 1: only the title skeleton, the switcher and a disabled New Ticket; lanes as faint dashed outlines | The full filter bar and the bell are already drawn; lanes are solid pale outlines | `Board.tsx`, `LoadingStates.module.css` | Hide the filter bar in phase 1; dash the lane outlines |
| AL-3 | 4 | Low | layout | Sidebar row "Couldn't load projects · Retry" fits | "Couldn't load proje…" is cut at the sidebar width | `ui/src/components/ProjectSidebar.tsx:137` | Shorten to "Couldn't load" or let it wrap to two lines |
| AL-4 | 7, 8 | High | missing | Dark phases on `#1E2A22` with white 8–15 % skeletons | No dark theme | — | Same as SP-1 |

Images: [design 1](../../../design/images/app-loading/app-loading-1-phase-1-projects-loading.png) · [design 2](../../../design/images/app-loading/app-loading-2-phase-2-tickets-loading.png) · [design 3](../../../design/images/app-loading/app-loading-3-slow-state.png) · [design 4](../../../design/images/app-loading/app-loading-4-projects-failed.png) · [now 1](shots/app/app-loading-1-phase1.jpg) · [now 3](shots/app/app-loading-3-slow.jpg) · [now 2](shots/app/app-loading-2-phase2-slow.jpg) · [now 4](shots/app/app-loading-4-failed.jpg) · [now 5](shots/app/app-loading-5-first-run.jpg)

## Preview — open and viewer (`design/screens/preview-viewer.md`)

Coverage: frames checked in the app (KAN-39, files in the description): A, B (viewer and Details with I), C (image, Fit, 100 %, background), D (← → I Esc work), E (web: Download and open, Copy link). Not checked: E "Open setup.sh?" (asked only before Open in app, which is desktop only).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| PV-1 | A | Medium | component | Attachment cards: real thumbnail (page, sheet grid, log lines, slide, archive tree) above the name and facts ("1.2 MB · 8 pages") | Files linked in a description are small chips (icon, name, type tag, download); images are shown at full width inline | `ui/src/components/FileAttachmentCard.tsx`, `MarkdownRenderer.tsx` | Use the card with thumbnail and facts wherever a file is listed |
| PV-2 | B, E | Medium | layout | Header: tile, name, chip, "412 KB · 1280 × 800"; on the right ‹ 1 of 7 › then icon buttons (info, download, open, folder, link, ✕); on web only Download and open and Copy link | Text buttons "Draw on it", "Open on a canvas", "Open in app" (greyed on web), "Download and open", "Copy link"; no ‹ › around "1 of 15" (only the side arrows); no size in the subtitle | `ui/src/components/preview/PreviewViewer.tsx:240-420` | Use icon buttons with tooltips; hide Open in app on web; put the arrows around the counter; add the size |
| PV-3 | B | Medium | missing | Details: Type, Size, Dimensions, Uploaded by, Uploaded, USED IN (ticket, page), Show in ticket and a full-width primary Download | Type ("Image") and Dimensions only, then small Download / Copy link / Open in app buttons | `PreviewViewer.tsx:296-301` (facts only shown when the opener passes them; the description opener passes none) | Pass size, uploader and date from the upload record; add Used in and Show in ticket |
| PV-4 | C | Medium | component | Image controls: a dark floating pill on the image (zoom-out icon, Fit, zoom-in icon, full screen, rotate); Background toggle top right with sun / checker icons; mini map when zoomed | A white text bar under the image: "− Fit + │ Fit 100% ⟳ Copy Background" (Fit twice, a ⟳ glyph); Background is a text button | `ui/src/components/preview/ImageReader.tsx` | Draw the pill with icons over the stage; move Background to the top right |
| PV-5 | PDF | Medium | layout | Side arrows sit on the dark stage, clear of content | In the PDF view the left arrow sits on top of the page thumbnails column | `PreviewViewer.module.css` (side arrows), `PdfReader.tsx` | Offset the arrows past the thumbnail column, or hide them when the reader has its own sidebar |

Images: [design A](../../../design/images/preview-viewer/02-a-where-a-preview-opens.png) · [design B](../../../design/images/preview-viewer/04-b-the-viewer.png) · [design C](../../../design/images/preview-viewer/06-c-image-viewer.png) · [now A](shots/app/preview-viewer-A.jpg) · [now B](shots/app/preview-viewer-B.jpg) · [now PDF](shots/app/preview-types-K-pdf.jpg)

## Preview — file types and states (`design/screens/preview-types.md`)

Coverage: frames checked in the app: F (log, json, sh), G (md), H (html), I (xlsx, csv), J (docx), K (pdf, 3 pages), L (zip), M (mp3, mp4, a .bin with no preview). From code only: N (loading, too large, failed and offline states are in `StatePanel.tsx`). Not built: J PowerPoint was not tried (no pptx converter on this machine).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| PT-1 | H, F rules | Critical | behavior | "HTML opens in a locked frame: no scripts, forms, pop-ups or outside requests (it cannot reach the app or its data)" | The frame has no `sandbox` and uses `srcDoc`, so an uploaded page runs its scripts **with the app's origin**: page.html's `alert()` fired, and KAN-41's page printed the app's title and the number of the app's localStorage keys. It could call the API as the viewer. The chip even says "Live page" | `ui/src/components/preview/HtmlReader.tsx:15-18,69-75` | Add `sandbox=""` (no `allow-scripts`, no `allow-same-origin`) and a CSP meta that blocks remote loads; label it "Safe preview" as drawn |
| PT-2 | F–M | Medium | copy | Subtitle = kind and facts: "CSV · 1.8 MB", "Markdown · 2.4 KB", "HTML · 14 KB", "Video · 9.8 MB · 0:54", "File · 6.3 MB" | budget.csv "Excel Spreadsheet", notes.md "Plain Text", page.html and setup.sh "Source Code", mp3 and mp4 "Media", .bin "File"; never a size | `ui/src/utils/fileIcons.tsx:83` (and the other labels), `PreviewViewer.tsx:333` | Give CSV, Markdown, HTML, Audio and Video their own labels; show the size |
| PT-3 | M | Medium | component | No preview: a BIN tile, the name, "…or open it in an app on your computer.", a facts table (Type, Size, Uploaded by), Open in app and a primary Download | An orange "!" warning circle (reads as an error), "No preview available", one sentence, a secondary Download | `ui/src/components/preview/StatePanel.tsx` | Use the neutral tile and the facts table; make Download primary |
| PT-4 | M | Low | component | Video on a black stage with a slim custom bar; audio the same with a wave | Native player on the pale grey stage; audio has no wave | `ui/src/components/preview/MediaReader.tsx` | Use the dark stage (the native player is accepted by the summary O) |
| PT-5 | L | Low | missing | Archive: MODIFIED column, "Download selected", nested rows | Name and Size only; no Modified, no Download selected | `ui/src/components/preview/ArchiveReader.tsx` | Add the column and the action |
| PT-6 | C | Low | state | Transparent images show on a checkerboard when Background is chosen | Default is the dark stage (the logo is hard to see on a dark ground); checkerboard only after pressing Background | `ImageReader.tsx` | Default to the checkerboard for images with alpha |

Images: [design H](../../../design/images/preview-types/06-h-html-files.png) · [design M](../../../design/images/preview-types/16-m-audio-video-and-files-without-a-preview.png) · [design O](../../../design/images/preview-types/20-o-summary-what-opens-how.png) · [now HTML reads the app](shots/app/preview-types-H-html.jpg) · [now types 1](shots/app/preview-types-sheet-1.jpg) · [now types 2](shots/app/preview-types-sheet-2.jpg) · [now no preview](shots/app/preview-types-M-nopreview.jpg) · [now video](shots/app/preview-types-M-video.jpg)

## Patterns

- **No dark theme anywhere**: Splash, Splash animation and App loading all draw dark frames; the app has none (SP-1, AL-4).
- **No accounts or hosted mode**: Login, Sign up, Password reset, the MCP web variant and the account menu (comp-2 AM-1) all depend on it (LG-1, SU-1, PR-1, MCP-5).
- **Text buttons and glyphs where the design draws icon buttons**: the preview header and zoom bar, the desktop About and Report windows, the notification row hover (PV-2, PV-4, DM-2, DM-3, NT-3).
- **Native form controls**: `<select>` (same as ai-1 / ai-3) and now native `type="time"` fields with 12 h display in Settings › Notifications (NT-7, NT-9).
- **Copy that leaks implementation or design notes**: "Request failed with status code 500", "Exists today", "user paused all AI", "Done — aI was resumed" (MV-1, NT-6, NT-1).
- **File facts missing**: neither the description chips, the viewer header nor the Details panel show size, uploader or date (PV-1, PV-2, PV-3, PT-2).
