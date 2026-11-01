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
    // onedir layout: Resources/kanban-server/kanban-server[.exe] (no per-launch temp extraction)
    const binaryPath = path.join(resourcesPath, 'kanban-server', `kanban-server${getBinaryExtension(platform)}`);
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

// File types "Open in app" hands to the system's default app: documents, images, media and archives. Scripts and
// programs are left out (.js, .py, .sh, .bat, .exe, .html …): their default action on some systems is to run them,
// so a page that was tricked into asking would run code. Those are shown in their folder instead.
const OPENABLE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.md', '.markdown', '.pdf', '.rtf',
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.odt', '.ods', '.odp',
  '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z',
]);

/** Whether `filePath` is a file type that may be opened with the system's default app. */
function isOpenablePath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  return OPENABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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

/** The `open-path` IPC: open a file with its default app, unless it is a type that could run as a program. */
async function openPathSafely(shell, filePath) {
  if (!filePath || typeof filePath !== 'string') return { success: false, error: 'Invalid path' };
  if (!isOpenablePath(filePath)) {
    return {
      success: false,
      error: 'This kind of file is not opened from the app, because it could run as a program. Use Show in folder.',
    };
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