# Wave 3: app area (app.md, plus AP-2, AP-3 and AP-6 from ai-2)

Before/after screenshots (JPEG, `*-before.jpg` from 5174, `*-after.jpg` from 5173), with the script `shots.cjs`, are in
`/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w3/app/`. Every state that
would change data was stubbed with `page.route`: the add-member POST got a 500, the remove DELETE a 400, and the pause
was a patched `ai/board` / `ai/overview` answer plus a stubbed notification feed. No member was added or removed and
no AI was paused or resumed. The desktop windows were opened through a stubbed `window.electronAPI`.

## app.md

### Members
- MV-1 · Fixed: network and 5xx errors now say "Failed to add member. Please try again."; the server's own text is shown only for a 409 (duplicate name) (`MembersPanel.tsx`, test `MembersPanel.test.tsx`)
- MV-2 · Fixed: a blocked remove keeps its message per member id. The message shows under that row, and the row's ✕ stays tinted `#FBEAEA` / `#C4432A` (`MembersPanel.tsx`, `MembersPanel.module.css`)
- MV-3 · Skipped — Low
- MV-4 · Skipped: same as ai-1 AM-1 (avatars and the role field); left to that row

### Login, Sign up, Password reset
- LG-1 · Skipped: accounts are not built (FIX-BRIEF), and they need auth on the server
- SU-1 · Skipped: accounts are not built (FIX-BRIEF)
- PR-1 · Skipped: accounts are not built (FIX-BRIEF)

### Settings › Integrations › MCP
- MCP-1 · Skipped — Low
- MCP-2 · Skipped — Low
- MCP-3 · Skipped — Low
- MCP-4 · Skipped — Low
- MCP-5 · Skipped: the web build needs hosted mode with API tokens, which needs a server change and accounts

### Desktop menu bar
- DM-1 · Skipped — Low (this is app.md's Keyboard Shortcuts row, not comp-2's DM-1)
- DM-2 · Fixed: About now has the 64 px `#2E6F40` app tile and "Kanban Board" as its heading, and the window is named "About Kanban Board". Release notes and Copy diagnostics sit in the body with the external and copy icons. The ✕ and Close are kept (`DesktopWindows.tsx`, `.module.css`)
- DM-3 · Fixed: Report an issue shows only the mono facts block (`#FBFCFB`, radius 9). Under it, a green ✓ line "Included: …" (`#1F5A31`) and a red ✕ line "Never included: …" (`#A5321E`). Copy text and Open GitHub have icons. The full issue text is still what Copy text copies and what Open GitHub sends (`DesktopWindows.tsx`, new `reportIssueFacts` in `desktopHelpers.ts`, test `DesktopWindows.test.tsx`)
- DM-4 · Skipped — Low
- DM-5 · Skipped — Low

### Notifications
- NT-1 · Skipped — Low
- NT-2 · Fixed: when items wait in Needs you, the empty Updates tab says "No updates — Nothing new to read. N items need you in the other tab." "No notifications yet" now shows only for an empty feed (`NotificationPanel.tsx`, test in `notificationViews.test.tsx`)
- NT-3 · Skipped — Low
- NT-4 · Skipped: the All notifications page is mounted as `overlayPage` in `App.tsx`, which replaces the board and its top bar. Moving it under the top bar is a shell change in `App.tsx`, and my brief allows `App.tsx` only for AP-2 and AP-3
- NT-5 · Skipped — Low
- NT-6 · Skipped — Low
- NT-7 · Fixed: quiet hours and the day-card time are 24 h text fields (for example "22:00 – 08:00" and "☀ 18:00"), with no second browser clock icon. A complete time saves at once, as before. ↑ and ↓ step the hour or the minutes, depending on where the caret is, as the native field did. An unfinished value goes back to the saved one on blur (`NotificationsSettings.tsx`, `.module.css`, test added)
- NT-8 · Fixed: when the browser blocks notifications, the Desktop notifications switch shows off and is disabled, and the existing line explains how to allow them. The desktop app already showed the "Your computer is blocking notifications" card (`NotificationsSettings.tsx`, test added)
- NT-9 · Skipped: same as ai-1 AB-17 (selects); wave 2 already styled selects app-wide
- NT-10 · Skipped — Low

### Splash
- SP-1 · Skipped: dark theme is not built (FIX-BRIEF)
- SP-2 · Skipped — Low
- SP-3 · Skipped — Low
- SP-4 · Skipped — Low

### App loading
- AL-1 · Skipped: the lane-count skeleton is in `Column.tsx` and the filter bar in `FilterBar.tsx`, both outside my files
- AL-2 · Skipped — Low
- AL-3 · Skipped — Low
- AL-4 · Skipped: dark theme is not built (FIX-BRIEF)

### Preview: open and viewer
- PV-1 · Skipped: description files are drawn by `FileAttachmentCard.tsx` and `MarkdownRenderer.tsx`, both outside my files
- PV-2 · Fixed: the header now reads tile, name, chip and "kind · size · dimensions"; then ‹ 1 of N › with arrow buttons, a rule, and icon buttons with tooltips: info, download, open in app and show in folder (desktop only), copy link, full screen, close. Draw on it and Open on a canvas became purple icon buttons, with the same handler and `data-testid`. The web build hides Open in app (design E), and the download button is named "Download and open" there. The size is read from the server (a one-byte range request) when the opener does not pass it (`PreviewViewer.tsx`, `.module.css`, test `PreviewViewer.test.tsx`)
- PV-3 · Fixed in part: Details now has its own ✕, Type, Size (now always known), Dimensions, and Uploaded by / Uploaded when given. Used in rows have a page icon, Copy link, Open in app and Show in folder are kept, and a full-width primary Download is pinned at the bottom. Not done: the uploader, the date, Used in and "Show in ticket" for files opened from a description. They need the opener (`MarkdownRenderer.tsx` / `FileAttachmentCard.tsx`, outside my files) to pass them, and Show in ticket has no handler to call
- PV-4 · Fixed: the image controls are now the design's dark pill over the stage (`rgba(20,28,23,.86)`, radius 10): zoom out, Fit / %, zoom in, then Fit, 100 %, Rotate and Copy, as icons where the design draws icons. Background moved to a pill at the top right with an icon for the current choice; it still opens the same Dark / Light / Checkerboard menu with the same clicks. Keys are unchanged (`ImageReader.tsx`, `PreviewViewer.module.css`)
- PV-5 · Fixed: in the PDF view the left side arrow sits past the 120 px page rail (`.stage[data-kind='pdf'] .navPrev`, `PreviewViewer.module.css`)

### Preview: file types and states
- PT-1 · Already fixed (wave 2)
- PT-2 · Fixed: the viewer's subtitle and Details name CSV, TSV, Markdown, HTML, Audio, Video and code languages ("Shell", "TypeScript") with a new `kindLabel` in `preview/kinds.ts`, and show the size. The app-wide labels in `utils/fileIcons.tsx` are unchanged, because that file is not mine
- PT-3 · Fixed: no-preview files show a neutral mono tile ("BIN"), the name, the sentence, a facts table (Type, Size, Uploaded by when known), Open in app (desktop) and a primary Download, in place of the orange warning (`PreviewViewer.tsx`, `.module.css`)
- PT-4 · Skipped — Low
- PT-5 · Skipped — Low
- PT-6 · Skipped — Low

## From ai-2

- AP-2 · Fixed: on the board, the AI paused banner now sits under the top bar (a new `topBanner` prop on `Board`, rendered after the header) and pushes the page down. On the other pages it stays where it was (`App.tsx`, `Board.tsx`)
- AP-3 · Fixed: `PauseAllButton` (the paused label with Resume…, or Pause all AI) moved to the right action group, just before New Ticket (a new `headerActions` prop on `Board`). `AiKillSwitch.tsx` is unchanged (`App.tsx`, `Board.tsx`)
- AP-6 · Fixed: a Pause all AI row gives the person who paused no toast, because the banner says it. Everyone else gets an info toast with the zero counts removed ("Hoa Mai paused all AI. 2 queued runs held. Reason: …"). Because of AP-5 the server writes the pauser as "user", so today most viewers get the info toast (`useNotificationToasts.ts`, test in `notifications.test.tsx`)
