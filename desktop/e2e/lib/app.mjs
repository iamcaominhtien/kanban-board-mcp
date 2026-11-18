// Starts the real desktop app (Electron + the Rust server it spawns) with its own temporary folders, and gives the
// checks what they need: the REST API as the window calls it, and a recorder in the main process for what the app
// hands to the operating system (notifications, the launcher badge, the network calls of the updater).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DESKTOP = path.resolve(here, '../..');
export const REPO = path.resolve(DESKTOP, '..');
const require = createRequire(import.meta.url);

/** Playwright is installed globally (the browser suite in server/e2e resolves it the same way). */
function loadPlaywright() {
  try { return require('playwright'); } catch { /* look in the global folders */ }
  const dirs = (process.env.NODE_PATH || '').split(path.delimiter).concat(['/usr/lib/node_modules', '/usr/local/lib/node_modules']);
  for (const d of dirs) {
    if (!d) continue;
    try { return require(path.join(d, 'playwright')); } catch { /* next */ }
  }
  throw new Error('playwright is not resolvable; it must be installed globally (npm i -g playwright)');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns something truthy; returns that value. */
export async function until(fn, what, ms = 20000, every = 100) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
    await sleep(every);
  }
}

/** The server binary the app starts in development (main-helpers.js: KANBAN_SERVER_BIN or target/debug). */
export function serverBinary() {
  const p = (process.env.KANBAN_SERVER_BIN || '').trim();
  return p || path.join(REPO, 'server/target/debug/kanban-server');
}

/**
 * Launches the app. Its Electron `userData` (which holds the server's database), `HOME`, the server's config and log
 * folders are all inside one temporary folder, and no KANBAN_* variable of the caller is passed on, so the person's
 * own board is never opened (the same rule as server/e2e/lib/servers.mjs and the testkit crate).
 */
export async function launchApp() {
  const bin = serverBinary();
  if (!fs.existsSync(bin)) throw new Error(`the server is not built: ${bin} (cd server && cargo build -p kanban-server)`);
  if (!fs.existsSync(path.join(REPO, 'ui/dist/index.html'))) throw new Error('ui/dist is missing: cd ui && npm ci && npm run build');
  const electronBin = createRequire(path.join(DESKTOP, 'package.json'))('electron');
  if (typeof electronBin !== 'string' || !fs.existsSync(electronBin)) throw new Error('electron is not installed: cd desktop && npm ci');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-desktop-e2e-'));
  const dirs = { root, userData: path.join(root, 'userData'), home: path.join(root, 'home'), config: path.join(root, 'config'), logs: path.join(root, 'logs'), claude: path.join(root, 'claude'), accounts: path.join(root, 'accounts'), workspace: path.join(root, 'workspace'), tmp: path.join(root, 'tmp') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('KANBAN_') && !k.startsWith('ELECTRON_')) env[k] = v;
  Object.assign(env, {
    KANBAN_SERVER_BIN: bin,
    KANBAN_CONFIG_DIR: dirs.config,
    KANBAN_LOG_DIR: dirs.logs,
    KANBAN_WORKSPACE_ROOT: dirs.workspace,
    KANBAN_DIAGRAM_EXPORT: 'off',
    KANBAN_RUNNER: 'inprocess',
    KANBAN_AI_KEY_FILE: path.join(root, 'ai.key'),
    KANBAN_AI_ACCOUNTS_HOME: dirs.accounts,
    CLAUDE_CONFIG_DIR: dirs.claude,
    HOME: dirs.home,
    TMPDIR: dirs.tmp, // Electron's app.getPath('temp'): where the updater puts a downloaded installer
    XDG_CONFIG_HOME: path.join(dirs.home, '.config'),
    XDG_CACHE_HOME: path.join(dirs.home, '.cache'),
    XDG_DATA_HOME: path.join(dirs.home, '.local/share'),
  });
  // The server itself writes the day card by the computer's clock (see server/e2e/lib/servers.mjs); nothing here depends on it
  const { _electron } = loadPlaywright();
  const electron = await _electron.launch({
    executablePath: electronBin,
    // no sandbox: the container runs as root; no GPU: there is none under Xvfb
    args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${dirs.userData}`, DESKTOP],
    env,
    timeout: 60000,
  });
  const log = [];
  const keep = (tag) => (d) => { for (const l of d.toString().split('\n')) if (l.trim() && !/dbus\//.test(l)) { log.push(`[${tag}] ${l}`); if (log.length > 200) log.shift(); } };
  electron.process().stdout.on('data', keep('out'));
  electron.process().stderr.on('data', keep('err'));
  const page = await electron.firstWindow();

  const app = { electron, page, dirs, log, port: 0, secret: '', base: '' };
  try {
    // the window asks the main process for the backend port, which is null until the server printed READY
    app.port = await until(() => page.evaluate(() => window.electronAPI?.getBackendPort?.()), 'the backend port', 60000, 200);
    app.secret = await page.evaluate(() => window.electronAPI.getApiSecret());
    app.base = `http://127.0.0.1:${app.port}`;
  } catch (e) {
    await electron.close().catch(() => {});
    throw new Error(`${e.message}\n${log.slice(-20).join('\n')}`);
  }
  return app;
}

/**
 * One call to the REST API of the app's own server, as the window makes it: with the API secret only this app's window
 * knows (it asks the main process for it), and `actor` makes it another person's call (the X-Actor header).
 */
export async function api(app, method, url, data, actor) {
  const headers = { 'content-type': 'application/json', 'X-Kanban-Secret': app.secret };
  if (actor) headers['X-Actor'] = actor;
  const r = await fetch(app.base + url, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

// ── The recorder in the main process ────────────────────────────────────────────────────────────────────────────
// Everything below runs inside Electron's main process (`electron.evaluate`): the functions are serialised, so they
// use nothing of this file. They sit on the objects main.js and notifier.js already hold: the `Notification` class
// (main.js took it from `require('electron')` at start, so its prototype is changed, not the binding), `app` and `net`.
// Nothing in desktop/*.js is touched or reached around: the app calls exactly what it calls in production.

/**
 * Records what the app hands to the OS. A notification is recorded instead of shown (there is no notification
 * daemon here, and `Notification.isSupported()` is false on a bare Linux); the stand-in answers like a daemon that
 * accepted it ('show') or, with `mode: 'refuse'`, like one that refused it ('failed'). `app.setBadgeCount` is
 * recorded and passed on. `http.get` is logged so a check can tell when the notifier has read the feed.
 */
export function installRecorder(app) {
  return app.electron.evaluate(({ Notification, app: electronApp }) => {
    if (globalThis.__e2e) return;
    const state = (globalThis.__e2e = { notes: [], badge: [], http: [], mode: 'accept', objects: [] });
    Notification.isSupported = () => true;
    const proto = Notification.prototype;
    proto.show = function show() {
      const rec = { id: state.notes.length, title: this.title, body: this.body, silent: this.silent, actions: (this.actions || []).map((a) => a.text), at: Date.now(), closed: false, clicked: false };
      state.notes.push(rec);
      state.objects.push(this);
      if (state.mode === 'refuse') setImmediate(() => this.emit('failed', {}, 'The notification service refused it.'));
      else setImmediate(() => this.emit('show'));
    };
    proto.close = function close() {
      const i = state.objects.indexOf(this);
      if (i >= 0) state.notes[i].closed = true;
      setImmediate(() => this.emit('close'));
    };
    const setBadgeCount = electronApp.setBadgeCount.bind(electronApp);
    electronApp.setBadgeCount = (n) => {
      state.badge.push(n);
      return setBadgeCount(n);
    };
    const http = process.getBuiltinModule('node:http');
    const get = http.get;
    http.get = function recordedGet(options, ...rest) {
      if (options && typeof options === 'object' && options.path) state.http.push({ path: options.path, actor: options.headers?.['X-Actor'], at: Date.now() });
      return get.call(http, options, ...rest);
    };
  });
}

/** What the OS has been handed so far: { notes: [{id, title, body, silent, closed, clicked, at}], badge: [counts], http: [{path, actor}] }. */
export function recorded(app) {
  return app.electron.evaluate(() => {
    const { notes, badge, http, mode } = globalThis.__e2e;
    return { notes: notes.map((n) => ({ ...n })), badge: [...badge], http: [...http], mode };
  });
}

/** Switches what the stand-in daemon does with the next notifications: 'accept' (shows them) or 'refuse'. */
export function setDaemon(app, mode) {
  return app.electron.evaluate((_electron, m) => { globalThis.__e2e.mode = m; }, mode);
}

/** The person clicks a notice (the OS tells the app: the `click` event of the Notification object). */
export function clickNote(app, id) {
  return app.electron.evaluate((_electron, i) => {
    const e2e = globalThis.__e2e;
    e2e.notes[i].clicked = true;
    e2e.objects[i].emit('click', {});
  }, id);
}

/** The state of the main window as the notifier sees it (it asks `isVisible()` and `isFocused()`). */
export function windowState(app) {
  return app.electron.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized(), url: w.webContents.getURL() };
  });
}

/** Takes the focus away from the window (as another application coming to the front does) or gives it back. */
export async function setFocus(app, focused) {
  await app.electron.evaluate(({ BrowserWindow }, f) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (f) w.focus(); else w.blur();
  }, focused);
  await until(async () => (await windowState(app)).focused === focused, `the window to be ${focused ? '' : 'un'}focused`, 5000, 50);
}

/** The launcher badge count: the last value handed to `app.setBadgeCount`, or null before any. */
export async function lastBadge(app) {
  const { badge } = await recorded(app);
  return badge.length ? badge[badge.length - 1] : null;
}

export async function closeApp(app) {
  if (!app) return;
  await app.electron.close().catch(() => {});
  try { fs.rmSync(app.dirs.root, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── The update feed ─────────────────────────────────────────────────────────────────────────────────────────────
// updater.js asks GitHub's "latest release" through Electron's `net.fetch` and has no setting for another address (and
// it offers an installer only on macOS and Windows, a Linux build has none). So the stand-in answers in place of
// GitHub: `net.fetch` is replaced in the main process by a function that serves a release and its installer from
// memory, and for the instant `updater.js` reads the release (`buildUpdateInfo`) `process.platform` says 'win32'. The
// rest of the flow is the app's own: the IPC, the download with its checksum, the state in the menu, the page.

export const UPDATE = { version: '9.9.9', asset: 'Kanban-Board-Setup-9.9.9.exe', notes: '- Faster boards\n- A new Settings page', size: 300_000 };

/**
 * Serves the release from now on. `mode` (see `setUpdateFeed`): 'newer' offers UPDATE.version, 'same' offers the
 * installed version, 'error' answers HTTP 500, and the installer is served with a wrong checksum when `badDigest`.
 */
export function installUpdateFeed(app) {
  return app.electron.evaluate(({ net, app: electronApp }, update) => {
    if (globalThis.__e2eFeed) return;
    const feed = (globalThis.__e2eFeed = { mode: 'newer', badDigest: false, calls: [] });
    const crypto = process.getBuiltinModule('node:crypto');
    const bytes = Buffer.alloc(update.size, 7);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const realPlatform = process.platform;
    const base = 'https://github.com/iamcaominhtien/kanban-board-mcp/releases/download/';
    net.fetch = async (url) => {
      feed.calls.push(String(url));
      if (String(url).startsWith('https://api.github.com/repos/iamcaominhtien/kanban-board-mcp/releases/latest')) {
        if (feed.mode === 'error') return new Response('{}', { status: 500 });
        const tag = feed.mode === 'same' ? `v${electronApp.getVersion()}` : `v${update.version}`;
        const release = {
          tag_name: tag, draft: false, prerelease: false, body: update.notes, html_url: 'https://github.com/iamcaominhtien/kanban-board-mcp/releases/tag/' + tag,
          assets: [
            { name: update.asset, size: bytes.length, browser_download_url: `${base}${tag}/${update.asset}`, digest: `sha256:${feed.badDigest ? '0'.repeat(64) : sha}` },
            { name: `Kanban-Board-${update.version}-arm64.dmg`, size: 1, browser_download_url: `${base}${tag}/Kanban-Board-${update.version}-arm64.dmg` },
          ],
        };
        const res = new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } });
        const json = res.json.bind(res);
        res.json = async () => {
          const value = await json();
          // read right after this returns (same microtask run): the Windows asset is picked; restored before any timer
          Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
          setTimeout(() => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }), 0);
          return value;
        };
        return res;
      }
      if (String(url).startsWith(base)) return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
      throw new Error(`the stand-in feed was asked for something else: ${url}`);
    };
  }, UPDATE);
}

/** 'newer' | 'same' | 'error' for the next checks, and whether the installer comes with a wrong checksum. */
export function setUpdateFeed(app, mode, { badDigest = false } = {}) {
  return app.electron.evaluate((_electron, change) => { Object.assign(globalThis.__e2eFeed, change); }, { mode, badDigest });
}

/** The labels of the application menu's update item, and the URLs the updater fetched. */
export function updateState(app) {
  return app.electron.evaluate(({ Menu }) => ({
    menuLabel: Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.label ?? null,
    calls: [...globalThis.__e2eFeed.calls],
  }));
}

/** Clicks an item of the application menu by its id, as the person does (the main process runs its command). */
export function clickMenu(app, id) {
  return app.electron.evaluate(({ Menu }, i) => {
    const item = Menu.getApplicationMenu().getMenuItemById(i);
    if (!item) throw new Error(`no menu item ${i}`);
    item.click();
  }, id);
}
