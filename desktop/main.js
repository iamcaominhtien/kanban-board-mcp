const { app, BrowserWindow, ipcMain, dialog, globalShortcut } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { registerMcpServer } = require('./vscode-setup');
const {
  StartupProfiler,
  buildBackendLaunchSpec,
  getMcpStdioBinaryPath,
  parseReadyPort,
  shouldRunVscodeSetup,
  shouldWriteSetupFlag,
  terminateBackendProcess,
} = require('./main-helpers');

// Profiler records timestamps for each startup milestone.
// Logs are emitted to the console as [startup] <stage> +<N>ms
const profiler = new StartupProfiler();

let mainWindow = null;
let backendPort = null;
let backendProcess = null;

function startBackend() {
  profiler.mark('backend-spawn-start');
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

    // Strip macOS quarantine attribute from packaged binary so it can be spawned
    if (process.platform === 'darwin' && app.isPackaged) {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('xattr', ['-d', 'com.apple.quarantine', spec.command], { stdio: 'ignore' });
      } catch { /* attribute may not exist — non-fatal */ }
    }

    // Ensure binary is executable (electron-builder may drop +x bit on some builds)
    if (process.platform !== 'win32' && app.isPackaged) {
      try { fs.chmodSync(spec.command, 0o755); } catch { /* non-fatal */ }
    }

    let stderrOutput = '';
    let child;
    try {
      child = spawn(spec.command, spec.args, spec.options);
      profiler.mark('backend-spawned');
    } catch (spawnErr) {
      return reject(new Error(`spawn failed: ${spawnErr.code} — path: ${spec.command}`));
    }

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
        profiler.mark('backend-ready');
        resolve(backendPort);
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderrOutput += text;
      console.error('[backend]', text);
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(new Error(`spawn error: ${err.code} (${err.message}) — path: ${spec.command}`));
      }
    });

    child.on('exit', (code, signal) => {
      console.log(`Backend exited with code ${code} signal ${signal}`);
      backendProcess = null;
      backendPort = null;
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        const detail = stderrOutput ? `\nStderr: ${stderrOutput.slice(0, 500)}` : '';
        reject(new Error(`Backend exited before READY signal (code ${code}, signal ${signal}) — path: ${spec.command}${detail}`));
      }
    });

    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Backend startup timeout (120s) — path: ${spec.command}\nStderr so far: ${stderrOutput.slice(0, 500)}`));
      }
    }, 120000);
  });
}

function createWindow() {
  profiler.mark('window-create-start');
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

  // Always load from the local file — this is safe because:
  //   • The CSP header (injected via onHeadersReceived below) explicitly allows
  //     connect-src http://127.0.0.1:* so API calls to the Python backend work.
  //   • Loading from file:// means the window shows immediately without waiting
  //     for the Python server to boot.  The renderer handles the "backend not ready"
  //     state by showing a connecting overlay until it receives the backend-ready IPC.
  const uiPath = path.join(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
    'ui', 'dist', 'index.html'
  );
  mainWindow.loadFile(uiPath);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('file://') || url.startsWith('http://127.0.0.1:');
    if (!allowed) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*; img-src 'self' data: blob:; base-uri 'self'; object-src 'none'"
        ]
      }
    });
  });

  mainWindow.once('ready-to-show', () => {
    profiler.mark('window-first-paint');
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

// IPC: renderer asks to open a folder picker dialog
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Data Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(() => {
  profiler.mark('app-ready');
  createWindow();

  startBackend()
    .then((port) => {
      backendPort = port; // Set the global port immediately for any future lookups

      // VS Code MCP setup — one-time, packaged builds only
      const setupFlag = path.join(app.getPath('userData'), '.vscode-mcp-setup-done');
      if (shouldRunVscodeSetup({ isPackaged: app.isPackaged, setupFlagExists: fs.existsSync(setupFlag) })) {
        const dbPath = path.join(app.getPath('userData'), 'kanban.db');
        const result = registerMcpServer(
          getMcpStdioBinaryPath({
            isPackaged: app.isPackaged,
            platform: process.platform,
            resourcesPath: process.resourcesPath,
            desktopDir: __dirname,
          }),
          dbPath
        );
        if (shouldWriteSetupFlag(result)) {
          try {
            fs.writeFileSync(setupFlag, new Date().toISOString(), 'utf8');
          } catch { /* non-fatal */ }
        }
      }

      // Notify renderer that the backend is accepting requests
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('backend-ready', port);
      }

      profiler.mark('backend-ready-sent');
      console.log('[startup] summary', JSON.stringify(profiler.summary()));
    })
    .catch((err) => {
      console.error('[startup] backend failed:', err.message);
      profiler.mark('backend-error');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('backend-error', err.message);
      }
      // Do not quit — the renderer shows an error state so the user
      // can see what went wrong instead of the app silently disappearing.
    });

  globalShortcut.register('CommandOrControl+Shift+I', () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) focused.webContents.toggleDevTools();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
