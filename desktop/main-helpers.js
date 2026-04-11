const path = require('path');

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
  devPythonExists,
}) {
  const dbPath = path.join(userDataPath, 'kanban.db');
  const env = { ...baseEnv, KANBAN_DB_PATH: dbPath };
  const stdio = ['ignore', 'pipe', 'pipe'];

  if (isPackaged) {
    const binaryPath = path.join(resourcesPath, `kanban-server${getBinaryExtension(platform)}`);
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

function parseReadyPort(output) {
  const match = output.match(/READY port=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function getMcpStdioBinaryPath({ isPackaged, platform, resourcesPath, desktopDir }) {
  const ext = getBinaryExtension(platform);
  if (isPackaged) {
    return path.join(resourcesPath, `kanban-mcp-stdio${ext}`);
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
  buildBackendLaunchSpec,
  getBinaryExtension,
  getMcpStdioBinaryPath,
  parseReadyPort,
  shouldRunVscodeSetup,
  shouldWriteSetupFlag,
  terminateBackendProcess,
};