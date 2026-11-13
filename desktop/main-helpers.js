const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// The Rust workspace that holds the server (kanban-server and kanban-mcp-stdio), relative to the repository root.
// The one place that names it: change this line when the folder is renamed.
const SERVER_DIR = 'server';

function resolveConfiguredUploadsDir(userDataPath, configPath = null) {
  if (configPath) {
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config && config.data_folder) {
          return path.join(config.data_folder, 'uploads');
        }
      }
    } catch {
      // fallback
    }
  }
  return path.join(userDataPath, 'uploads');
}

/**
 * The config file the server reads (the server's config module): KANBAN_CONFIG_DIR/config.json when that folder is set, else
 * ~/.kanban-board/config.json. A test instance with its own config folder never touches the person's file.
 */
function resolveConfigPath(env, homeDir) {
  const dir = env && env.KANBAN_CONFIG_DIR ? env.KANBAN_CONFIG_DIR : path.join(homeDir, '.kanban-board');
  return path.join(dir, 'config.json');
}

/**
 * Writes the uploads folder this app serves into the config file (key `uploads_dir`), so a server started without
 * KANBAN_UPLOADS_DIR (the stdio MCP of an outside Claude Code session) stores attachments in the same folder
 * (the server's uploads module). Other keys stay; the file is replaced atomically and only when the value changed. A config
 * file that cannot be parsed is left alone. Returns 'written', 'unchanged' or 'skipped' (never throws).
 */
function recordUploadsDir(configPath, uploadsDir) {
  try {
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) return 'skipped';
    }
    if (config.uploads_dir === uploadsDir) return 'unchanged';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...config, uploads_dir: uploadsDir }, null, 2), 'utf8');
    fs.renameSync(tmp, configPath);
    return 'written';
  } catch {
    return 'skipped';
  }
}

/**
 * StartupProfiler — records timestamps for key startup stages.
 * Usage: profiler.mark('stage-name') at each milestone.
 * Call profiler.summary() to get a human-readable report.
 */
class StartupProfiler {
  constructor() {
    this._t0 = Date.now();
    this._marks = [{ stage: 'process-start', ts: this._t0, delta: 0 }];
  }

  mark(stage) {
    const now = Date.now();
    this._marks.push({ stage, ts: now, delta: now - this._t0 });
    console.log(`[startup] ${stage} +${now - this._t0}ms`);
  }

  summary() {
    return this._marks.map((m) => ({
      stage: m.stage,
      offsetMs: m.delta,
    }));
  }
}

function getBinaryExtension(platform) {
  return platform === 'win32' ? '.exe' : '';
}

function buildBackendLaunchSpec({
  isPackaged,
  platform,
  resourcesPath,
  userDataPath,
  desktopDir,
  baseEnv,
  exportCommand,
  existsSync = fs.existsSync,
  configPath,
  apiSecret,
}) {
  const dbPath = path.join(userDataPath, 'kanban.db');
  const uploadsDir = resolveConfiguredUploadsDir(userDataPath, configPath);
  // API keys are encrypted with a key the server keeps in the OS keychain (the server's secret store)
  const env = { ...baseEnv, KANBAN_DB_PATH: dbPath, KANBAN_UPLOADS_DIR: uploadsDir, KANBAN_SECRET_STORE: 'keychain' };
  // lets the server ask this app (headless) to draw a diagram's SVG with the draw.io editor
  if (exportCommand) env.KANBAN_EXPORT_CMD = JSON.stringify(exportCommand);
  // The secret only this app's window knows (the server's API secret module) goes to the server on its standard input, not in
  // its environment, which `ps` shows to every program of the same user (an AI's shell, say). The flag tells the
  // server to read it.
  if (apiSecret) env.KANBAN_API_SECRET_STDIN = '1';
  const stdio = [apiSecret ? 'pipe' : 'ignore', 'pipe', 'pipe'];

  if (isPackaged) {
    // The server sits next to kanban-mcp-stdio in one folder (built by desktop/scripts/build-server.sh):
    // Resources/kanban-mcp-stdio/kanban-server[.exe]. The folder keeps the stdio program's old name because MCP
    // clients outside the app store the path of Resources/kanban-mcp-stdio/kanban-mcp-stdio.
    const binaryPath = path.join(resourcesPath, 'kanban-mcp-stdio', `kanban-server${getBinaryExtension(platform)}`);
    return {
      command: binaryPath,
      args: [],
      options: {
        env: {
          ...env,
          KANBAN_UI_DIST: path.join(resourcesPath, 'ui', 'dist'),
          // the draw.io editor shipped with the app (desktop/scripts/fetch-drawio.sh), served at /drawio
          KANBAN_DRAWIO_DIR: path.join(resourcesPath, 'drawio'),
        },
        stdio,
        windowsHide: true,             // a console program: no console window next to the app on Windows
        cwd: resourcesPath,            // explicit CWD so binary doesn't inherit Electron's CWD
      },
      dbPath,
    };
  }

  // Development: the debug build in the Rust workspace, or the program KANBAN_SERVER_BIN names
  const workspaceDir = path.join(desktopDir, '..', SERVER_DIR);
  const binaryPath = getDevBinaryPath('kanban-server', { platform, desktopDir, env: baseEnv });
  if (!existsSync(binaryPath)) {
    throw new Error(
      `The server is not built: ${binaryPath} does not exist. ` +
        `Run "cargo build -p kanban-server -p kanban-mcp-stdio" in ${workspaceDir}, ` +
        'or set KANBAN_SERVER_BIN to the kanban-server program to start.'
    );
  }

  return {
    command: binaryPath,
    args: [],
    options: {
      env,
      cwd: workspaceDir,
      stdio,
      windowsHide: true,
    },
    dbPath,
  };
}

/**
 * Where a program of the Rust workspace is in development: target/debug/<name> in the workspace, or, when
 * KANBAN_SERVER_BIN names the kanban-server program, that path (and the other program beside it).
 */
function getDevBinaryPath(name, { platform, desktopDir, env = {} }) {
  const file = `${name}${getBinaryExtension(platform)}`;
  const override = env && env.KANBAN_SERVER_BIN;
  if (override) {
    return name === 'kanban-server' ? override : path.join(path.dirname(override), file);
  }
  return path.join(desktopDir, '..', SERVER_DIR, 'target', 'debug', file);
}

/**
 * The command the server runs (plus `--export-svg ...`) to draw a diagram with the editor: this app's own executable,
 * or, in development, Electron pointed at the desktop folder.
 */
function buildExportCommand({ isPackaged, execPath, desktopDir }) {
  return isPackaged ? [execPath] : [execPath, desktopDir];
}

function parseReadyPort(output) {
  // Split on newlines so we match individual log lines, not the full accumulated buffer.
  for (const line of output.split('\n')) {
    const match = line.match(/READY port=(\d+)/);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

// Installs before the folder layout shipped a single `kanban-mcp-stdio` file in Resources; that path is now a folder, so MCP
// client entries written by those versions must be migrated (see registerMcpServer's migrateFromCommand). Existing
// installs may still have such an entry, so this stays.
function getLegacyMcpStdioBinaryPath({ platform, resourcesPath }) {
  return path.join(resourcesPath, `kanban-mcp-stdio${getBinaryExtension(platform)}`);
}

function getMcpStdioBinaryPath({
  isPackaged,
  platform,
  resourcesPath,
  desktopDir,
  env = process.env,
  existsSync = fs.existsSync,
}) {
  const ext = getBinaryExtension(platform);
  if (isPackaged) {
    const folderBinary = path.join(resourcesPath, 'kanban-mcp-stdio', `kanban-mcp-stdio${ext}`);
    if (existsSync(folderBinary)) {
      return folderBinary;
    }
    return getLegacyMcpStdioBinaryPath({ platform, resourcesPath });
  }

  return getDevBinaryPath('kanban-mcp-stdio', { platform, desktopDir, env });
}

function shouldRunVscodeSetup({ isPackaged, setupFlagExists }) {
  return isPackaged && !setupFlagExists;
}

function shouldWriteSetupFlag(result) {
  return ['registered', 'already-registered'].includes(result);
}

function terminateBackendProcess(processRef) {
  if (!processRef || typeof processRef.kill !== 'function') {
    return false;
  }

  processRef.kill();
  return true;
}

// File types "Open in app" hands to the system's default app straight away: documents, images, media and archives.
// Anything else (.exe, .sh, .js, .py, .html, macro-capable .doc/.xls/.ppt, unknown types …) could run code when
// opened, so the desktop app asks first in a system dialog, which a page that was tricked into asking cannot answer.
const OPENABLE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic', '.heif', '.avif', '.tif', '.tiff',
  '.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.md', '.markdown', '.pdf', '.rtf', '.epub',
  '.xlsx', '.docx', '.pptx', '.odt', '.ods', '.odp', '.pages', '.numbers', '.key',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi',
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z',
]);

/** A Windows network path (\\host\share\…, also written //host/share/…): opening one can send the user's
 * credentials to that host, so it is never opened from the app. */
function isNetworkPath(filePath) {
  return /^(\\\\|\/\/)/.test(filePath);
}

/**
 * Whether `filePath` may be opened with the system's default app without asking.
 * @param filePath - The path the page asked for.
 * @param realPath - Where it really points (a symlink's target); a link named report.pdf to a program is not a PDF.
 */
function isOpenablePath(filePath, realPath = filePath) {
  if (typeof filePath !== 'string' || !filePath || isNetworkPath(filePath)) return false;
  const known = (p) => OPENABLE_EXTENSIONS.has(path.extname(p).toLowerCase());
  return known(filePath) && known(realPath);
}

/** Whether `url` may be handed to the system: only web pages and mail links, never file:// or app protocols. */
function isOpenableUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The `open-path` IPC: open a file with its default app. A type that is not plainly a document is opened only after
 * the person says so in `confirm` (a system dialog in the app); a network path never.
 * @param shell - Electron's shell (or a stand-in in tests).
 * @param filePath - The path the page asked for.
 * @param options - `confirm(name)` resolves true to open anyway; `realpath(p)` resolves symlinks.
 */
async function openPathSafely(shell, filePath, { confirm = async () => false, realpath = (p) => p } = {}) {
  if (!filePath || typeof filePath !== 'string') return { success: false, error: 'Invalid path' };
  if (isNetworkPath(filePath)) {
    return { success: false, error: 'Files on a network share are not opened from the app. Use Show in folder.' };
  }
  let real = filePath;
  try {
    real = realpath(filePath);
  } catch {
    // a missing file: openPath says so below
  }
  if (!isOpenablePath(filePath, real) && !(await confirm(path.basename(filePath)))) {
    return { success: false, error: 'Not opened' };
  }
  try {
    const errorMsg = await shell.openPath(filePath);
    return { success: !errorMsg, error: errorMsg || null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** The `open-external` IPC: hand a web or mail link to the system, nothing else. */
async function openExternalSafely(shell, url) {
  if (!isOpenableUrl(url)) return { success: false, error: 'Only web and mail links can be opened' };
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Keeping the computer awake while an AI runs (plan: "Máy ngủ") ───────────────────────────────────────────────────
const POWER_POLL_MS = 30 * 1000;
const DEFAULT_PREFERENCES = { keepAwake: true };

/** The app's small preferences file (a JSON in the user data folder); a missing or broken file gives the defaults. */
function readPreferences(file) {
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) return { ...DEFAULT_PREFERENCES, ...stored };
  } catch {
    // no file yet, or unreadable: the defaults
  }
  return { ...DEFAULT_PREFERENCES };
}

function writePreferences(file, preferences) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(preferences, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** What to do with the power save blocker: 'start', 'stop' or 'none'. Runs need the computer awake while the person
 * allows it; with the switch off, or no run, or no backend to ask, nothing is held. */
function decidePowerBlock({ keepAwake, active, blocking }) {
  const want = Boolean(keepAwake) && Number.isFinite(active) && active > 0;
  if (want && !blocking) return 'start';
  if (!want && blocking) return 'stop';
  return 'none';
}

/** Asks the board how many AI runs are going: a number, or null when it cannot be reached. */
async function fetchActiveRuns({ port, apiSecret, fetchFn = globalThis.fetch, timeoutMs = 5000 }) {
  if (!port) return null;
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/ai/power`, {
      headers: apiSecret ? { 'X-Kanban-Secret': apiSecret } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Number.isFinite(body.active) ? body.active : null;
  } catch {
    return null;
  }
}

/** Tells the board the computer woke up so it looks at the runs it thinks are going. */
async function postWake({ port, apiSecret, fetchFn = globalThis.fetch, timeoutMs = 30000 }) {
  if (!port) return false;
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/ai/power/wake`, {
      method: 'POST',
      headers: apiSecret ? { 'X-Kanban-Secret': apiSecret } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Polls the board every 30 s and holds `prevent-app-suspension` while runs are going.
 * opts: { powerSaveBlocker, getPort(), getApiSecret(), getKeepAwake(), fetchFn?, setIntervalFn?, clearIntervalFn? }
 */
function createPowerKeeper(opts) {
  const {
    powerSaveBlocker,
    getPort,
    getApiSecret = () => '',
    getKeepAwake,
    fetchFn = globalThis.fetch,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = opts;
  let blockerId = null;
  let timer = null;

  const blocking = () => blockerId !== null && powerSaveBlocker.isStarted(blockerId);
  const release = () => {
    if (blockerId !== null) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  };

  async function tick() {
    const active = await fetchActiveRuns({ port: getPort(), apiSecret: getApiSecret(), fetchFn });
    // an unreachable board holds nothing
    const action = decidePowerBlock({ keepAwake: getKeepAwake(), active: active ?? 0, blocking: blocking() });
    if (action === 'start') blockerId = powerSaveBlocker.start('prevent-app-suspension');
    else if (action === 'stop') release();
    return action;
  }

  // A check that throws (the system refused the blocker) is logged and the next one tries again
  const safeTick = () => tick().catch((err) => console.error('[power] check failed:', err));

  return {
    tick,
    start() {
      if (timer) return;
      safeTick();
      timer = setIntervalFn(safeTick, POWER_POLL_MS);
      if (timer && timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
      release();
    },
    wake: () => postWake({ port: getPort(), apiSecret: getApiSecret(), fetchFn }),
    isBlocking: blocking,
  };
}

/**
 * Whether `url` is the app's own page opened as a Docs window (`index.html?docsWindow=1`, issue #268): the one window
 * the page may open as another app window. Anything else it opens goes to the browser.
 * @param {string} url - The address the page asked to open.
 * @param {string} appUrl - The app page's own file:// address (index.html).
 */
function isDocsWindowUrl(url, appUrl) {
  let target;
  let own;
  try {
    target = new URL(url);
    own = new URL(appUrl);
  } catch {
    return false;
  }
  return (
    target.protocol === own.protocol &&
    target.host === own.host &&
    target.pathname === own.pathname &&
    target.searchParams.get('docsWindow') === '1'
  );
}

/** Whether `url` is the app's own page (any query), e.g. the board a Docs window asks for. */
function isAppUrl(url, appUrl) {
  try {
    const target = new URL(url);
    const own = new URL(appUrl);
    return target.protocol === own.protocol && target.host === own.host && target.pathname === own.pathname;
  } catch {
    return false;
  }
}

module.exports = {
  isAppUrl,
  isDocsWindowUrl,
  DEFAULT_PREFERENCES,
  POWER_POLL_MS,
  createPowerKeeper,
  decidePowerBlock,
  fetchActiveRuns,
  postWake,
  readPreferences,
  writePreferences,
  StartupProfiler,
  buildBackendLaunchSpec,
  buildExportCommand,
  getBinaryExtension,
  SERVER_DIR,
  getDevBinaryPath,
  getLegacyMcpStdioBinaryPath,
  getMcpStdioBinaryPath,
  isNetworkPath,
  isOpenablePath,
  isOpenableUrl,
  openExternalSafely,
  openPathSafely,
  parseReadyPort,
  recordUploadsDir,
  resolveConfigPath,
  resolveConfiguredUploadsDir,
  shouldRunVscodeSetup,
  shouldWriteSetupFlag,
  terminateBackendProcess,
};