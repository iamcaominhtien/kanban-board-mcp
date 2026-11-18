# Kanban Board desktop app

The Electron shell around the board: `main.js` starts the Rust server (`server/target/debug/kanban-server` in
development, or the program `KANBAN_SERVER_BIN` names) and loads the built UI (`ui/dist`) from disk. The main
process also owns what a browser tab cannot do: the OS notifications and the dock/taskbar number (`notifier.js`), the
application menu (`menu.js`) and the update check (`updater.js`).

```bash
cd desktop
npm ci
npm run dev          # the app in development (needs the built server and ui/dist, see below)
npm test             # unit tests (node --test), no Electron needed
npm run e2e          # the end-to-end check of the real app, see below
```

## End-to-end check (`npm run e2e`)

`server/e2e` drives the UI in headless Chromium and cannot reach what only the desktop app does. `desktop/e2e/run.mjs`
starts the real app (Electron, which starts the real server) and checks:

| Step | What it checks |
|---|---|
| 1 | The window loads the built UI, the server the app started answers `/health`, and a project made in the window is on that server |
| 3, 2 | A mention of the person by another member (`X-Actor: Ada`, the way `server/e2e` scenario 40 makes one) sends **no** OS notification while the window is focused and **one**, with the right title and body, when it is not |
| 4 | The 20 s limit: two more mentions right after a notice become one grouped notice ("2 things need you"), sent when the window ends |
| 5a, 5b | The launcher badge (`app.setBadgeCount`) follows the open "needs you" count: reading a row does not clear it (design J), dismissing does |
| 6a, 6b | A click on the grouped notice brings the window up at the Needs you list; a click on a single notice brings it up at the Docs page |
| 7, 7b, 7c | Settings › Notifications › Send a test shows the test notice at once, a refusal by the OS is reported, a click on it only focuses the window; with Desktop notifications switched off nothing is sent |
| 7d | Quiet hours hold every notice; the badge still counts (the other steps run with quiet hours off, which are on from 22:00 to 08:00 by default) |
| 8a–8d | The update flow: a failed check, up to date, a newer release (page, corner notice, Help menu), a download with a wrong checksum refused, a download that matches |
| 9 | A notice is withdrawn from the OS when its row is resolved |
| 10, 11 | The run sent exactly the notices above and left the person's own folders alone; quitting the app stops the server |

### Running it

Prerequisites (the same as `server/e2e`): the server built (`cd server && cargo build -p kanban-server`), a fresh
`ui/dist` (`cd ui && npm run build`), `npm ci` in `desktop/`, and Playwright installed globally (`npm i -g playwright`,
it is found through `NODE_PATH` or the usual global folders). On a machine with no display, run it under Xvfb:

```bash
cd desktop
xvfb-run -a npm run e2e
```

It takes about 50 seconds (20 s of it is the notifier's rate limit, which has no setting to shorten). The exit code is 0
when every check passed; the first failing step stops the run, prints the app's output and saves a screenshot in
`desktop/e2e/report/` (git-ignored). `KANBAN_SERVER_BIN` names another server binary.

### How it isolates and what it replaces

- The app gets its own temporary folder for `--user-data-dir` (which is where the server's database lives),
  `HOME`, `TMPDIR`, `KANBAN_CONFIG_DIR` and the logs; no `KANBAN_*` variable of the caller is passed on. Step 10 checks
  that `~/.kanban-board` and the app's usual `~/.config` folders were not touched.
- There is no notification daemon and no window manager under Xvfb, so the check sits on the main process
  (`electronApp.evaluate`, in `e2e/lib/app.mjs`) and records what the app hands to the OS: `Notification.prototype.show`
  and `close` (the OS never shows anything; `Notification.isSupported()` answers true), and `app.setBadgeCount` (recorded
  and passed on). A click is the `click` event of the recorded `Notification` object. "Not focused" is
  `BrowserWindow.blur()`, which works without a window manager.
- `updater.js` asks GitHub through Electron's `net.fetch` and has no setting for another address, and it offers an
  installer only on macOS and Windows. The check replaces `net.fetch` in the main process with a stand-in that serves a
  release and its installer from memory, and says `win32` for the instant `updater.js` reads the release. The app's own
  IPC, checksum, menu and page are what run. It does not press "Install and restart" (that starts the installer and quits).

### Not covered

- The OS side: that the notification daemon, the macOS dock or the Windows taskbar shows what the app handed over.
- The macOS and Windows branches: the dock bounce and the action buttons (macOS), the red-dot taskbar overlay (Windows).
  `notifier.js` takes its platform from the process, so on Linux only the launcher count runs; `tests/notifier*.test.js`
  cover the others with fakes.
- A real update: installing the downloaded file, and the 15 s / 6 h automatic checks (packaged builds only).
