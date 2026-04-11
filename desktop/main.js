const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { registerMcpServer } = require('./vscode-setup');
const {
  buildBackendLaunchSpec,
  getMcpStdioBinaryPath,
  parseReadyPort,
  shouldRunVscodeSetup,
  shouldWriteSetupFlag,
  terminateBackendProcess,
} = require('./main-helpers');

let mainWindow = null;
let backendPort = null;
let backendProcess = null;

function startBackend() {
  return new Promise((resolve, reject) => {
    const spec = buildBackendLaunchSpec({
      isPackaged: app.isPackaged,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      desktopDir: __dirname,
      baseEnv: process.env,
      devPythonExists: fs.existsSync(path.join(__dirname, '..', 'server', '.venv', 'bin', 'python')),
    });

    const child = spawn(spec.command, spec.args, spec.options);

    backendProcess = child;
    let output = '';
    let settled = false;
    let timeoutId;

    child.stdout.on('data', (data) => {
      output += data.toString();
      const port = parseReadyPort(output);
      if (port && !settled) {
        settled = true;
        clearTimeout(timeoutId);
        backendPort = port;
        resolve(backendPort);
      }
    });

    child.stderr.on('data', (data) => {
      console.error('[backend]', data.toString());
    });

    child.on('exit', (code) => {
      console.log(`Backend exited with code ${code}`);
      backendProcess = null;
      backendPort = null;
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(new Error(`Backend exited before READY signal (code ${code})`));
      }
    });

    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Backend startup timeout (30s)'));
      }
    }, 30000);
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });

  // Load the React static build
  const uiPath = path.join(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
    'ui', 'dist', 'index.html'
  );
  mainWindow.loadFile(uiPath);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:*'}; img-src 'self' data: blob: base-uri 'self'; object-src 'none'`
        ]
      }
    });
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (process.env.ELECTRON_DEV === '1') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC: renderer asks for backend port
ipcMain.handle('get-backend-port', () => backendPort);

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (err) {
    console.error('Failed to start backend:', err);
  }

  // One-time VS Code MCP setup — only runs in packaged builds
  const setupFlag = path.join(app.getPath('userData'), '.vscode-mcp-setup-done');
  if (shouldRunVscodeSetup({ isPackaged: app.isPackaged, setupFlagExists: fs.existsSync(setupFlag) })) {
    const result = registerMcpServer(
      getMcpStdioBinaryPath({
        isPackaged: app.isPackaged,
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        desktopDir: __dirname,
      })
    );

    if (shouldWriteSetupFlag(result)) {
      try {
        fs.writeFileSync(setupFlag, new Date().toISOString(), 'utf8');
      } catch { /* non-fatal */ }
    }
  }

  createWindow(backendPort);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(backendPort);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (terminateBackendProcess(backendProcess)) {
    backendProcess = null;
  }
});
