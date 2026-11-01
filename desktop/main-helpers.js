const path = require('path');
const fs = require('fs');
const os = require('os');

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
  devPythonExists,
  configPath,
  apiSecret,
}) {
  const dbPath = path.join(userDataPath, 'kanban.db');
  const uploadsDir = resolveConfiguredUploadsDir(userDataPath, configPath);
  // API keys are encrypted with a key the server keeps in the OS keychain (server/services/ai/secrets.py)
  const env = { ...baseEnv, KANBAN_DB_PATH: dbPath, KANBAN_UPLOADS_DIR: uploadsDir, KANBAN_SECRET_STORE: 'keychain' };
  // lets the server ask this app (headless) to draw a diagram's SVG with the draw.io editor
  if (exportCommand) env.KANBAN_EXPORT_CMD = JSON.stringify(exportCommand);
  // The secret only this app's window knows (server/api_secret.py) goes to the server on its standard input, not in
  // its environment, which `ps` shows to every program of the same user (an AI's shell, say). The flag tells the
  // server to read it.
  if (apiSecret) env.KANBAN_API_SECRET_STDIN = '1';
  const stdio = [apiSecret ? 'pipe' : 'ignore', 'pipe', 'pipe'];

  if (isPackaged) {
    // onedir layout (no per-launch temp extraction): the server sits next to kanban-mcp-stdio in one folder whose
    // _internal/ both share, Resources/kanban-mcp-stdio/kanban-server[.exe] (desktop/kanban-backend.spec)
    const binaryPath = path.join(resourcesPath, 'kanban-mcp-stdio', `kanban-server${getBinaryExtension(platform)}`);
    return {
      command: binaryPath,
      args: [],
      options: {
        env: {
          ...env,
          PYTHONUNBUFFERED: '1',       // force unbuffered stdout so READY signal is not held in Python's internal buffer
          PYTHONDONTWRITEBYTECODE: '1', // minor: skip .pyc writes in packaged binary
          KANBAN_UI_DIST: path.join(resourcesPath, 'ui', 'dist'),
        },
        stdio,
        cwd: resourcesPath,            // explicit CWD so binary doesn't inherit Electron's CWD
      },
      dbPath,
    };
  }

  const serverDir = path.join(desktopDir, '..', 'server');
  const pythonPath = path.join(serverDir, '.venv', 'bin', 'python');

  return {
    command: devPythonExists ? pythonPath : 'python3',
    args: [path.join(serverDir, 'main.py')],
    options: {
      env,
      cwd: serverDir,
      stdio,
    },
    dbPath,
  };
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
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

// Pre-onedir installs shipped a single `kanban-mcp-stdio` file in Resources; that
// path is now a directory, so configs written by older versions must be migrated.
function getLegacyMcpStdioBinaryPath({ platform, resourcesPath }) {
  return path.join(resourcesPath, `kanban-mcp-stdio${getBinaryExtension(platform)}`);
}

function getMcpStdioBinaryPath({
  isPackaged,
  platform,
  resourcesPath,
  desktopDir,
  existsSync = fs.existsSync,
}) {
  const ext = getBinaryExtension(platform);
  if (isPackaged) {
    const onedirBinary = path.join(resourcesPath, 'kanban-mcp-stdio', `kanban-mcp-stdio${ext}`);
    if (existsSync(onedirBinary)) {
      return onedirBinary;
    }
    return getLegacyMcpStdioBinaryPath({ platform, resourcesPath });
  }

  return path.join(desktopDir, '..', 'server', 'mcp_stdio.py');
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

module.exports = {
  StartupProfiler,
  buildBackendLaunchSpec,
  buildExportCommand,
  getBinaryExtension,
  getLegacyMcpStdioBinaryPath,
  getMcpStdioBinaryPath,
  isNetworkPath,
  isOpenablePath,
  isOpenableUrl,
  openExternalSafely,
  openPathSafely,
  parseReadyPort,
  resolveConfiguredUploadsDir,
  shouldRunVscodeSetup,
  shouldWriteSetupFlag,
  terminateBackendProcess,
};