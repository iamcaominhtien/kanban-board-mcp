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
}) {
  const dbPath = path.join(userDataPath, 'kanban.db');
  const uploadsDir = resolveConfiguredUploadsDir(userDataPath, configPath);
  const env = { ...baseEnv, KANBAN_DB_PATH: dbPath, KANBAN_UPLOADS_DIR: uploadsDir };
  // lets the server ask this app (headless) to draw a diagram's SVG with the draw.io editor
  if (exportCommand) env.KANBAN_EXPORT_CMD = JSON.stringify(exportCommand);
  const stdio = ['ignore', 'pipe', 'pipe'];

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

module.exports = {
  StartupProfiler,
  buildBackendLaunchSpec,
  buildExportCommand,
  getBinaryExtension,
  getLegacyMcpStdioBinaryPath,
  getMcpStdioBinaryPath,
  parseReadyPort,
  resolveConfiguredUploadsDir,
  shouldRunVscodeSetup,
  shouldWriteSetupFlag,
  terminateBackendProcess,
};