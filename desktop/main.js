const { app, BrowserWindow, Menu, Notification, clipboard, ipcMain, dialog, nativeImage, powerMonitor, powerSaveBlocker, shell } = require('electron');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { registerMcpServer } = require('./vscode-setup');
const { parseExportArgs, runExportCli } = require('./export-svg');
const { setupUpdater, getUpdateState, checkNow } = require('./updater');
const { startNotifier, systemSettingsUrl } = require('./notifier');
const { buildMenuTemplate, buildDiagnosticsText, resolveCommand, VIEWS } = require('./menu');
const {
  StartupProfiler,
  buildBackendLaunchSpec,
  buildExportCommand,
  createPowerKeeper,
  getLegacyMcpStdioBinaryPath,
  getMcpStdioBinaryPath,
  openExternalSafely,
  openPathSafely,
  parseReadyPort,
  readPreferences,
  shouldRunVscodeSetup,
  shouldWriteSetupFlag,
  terminateBackendProcess,
  writePreferences,
} = require('./main-helpers');

// Profiler records timestamps for each startup milestone.
// Logs are emitted to the console as [startup] <stage> +<N>ms
const profiler = new StartupProfiler();

// Only this app's window gets it (preload.js asks for it); the server reads it from its standard input
// (KANBAN_NO_API_SECRET=1 starts the app without it, should a window ever be locked out of its own board)
const apiSecret = process.env.KANBAN_NO_API_SECRET ? '' : crypto.randomBytes(24).toString('hex');
let mainWindow = null;
let backendPort = null;
let backendProcess = null;
// What the page tells the menu so the check mark follows the view on screen
let currentView = null;
// The desktop notifier (notifier.js): started once the backend port is known, the only sender of OS notifications
let notifier = null;
// A notification clicked while no page was listening yet (the window had to be created): delivered when it is
let pendingOpen = null;
// "Keep awake while AI runs" (View menu), kept in a small JSON in the user data folder
let preferences = null;
const preferencesFile = () => path.join(app.getPath('userData'), 'preferences.json');
const keepAwakeOn = () => (preferences || (preferences = readPreferences(preferencesFile()))).keepAwake !== false;
// Polls the board while it is up and holds the computer awake while an AI runs; told when the computer wakes
let powerKeeper = null;

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
      exportCommand: buildExportCommand({ isPackaged: app.isPackaged, execPath: process.execPath, desktopDir: __dirname }),
      devPythonExists: fs.existsSync(path.join(__dirname, '..', 'server', '.venv', 'bin', 'python')),
      configPath: path.join(app.getPath('home'), '.kanban-board', 'config.json'),
      apiSecret,
    });

    // Strip macOS quarantine attribute from packaged binary so it can be spawned
    if (process.platform === 'darwin' && app.isPackaged) {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', spec.command], { stdio: 'ignore' });
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
      if (apiSecret && child.stdin) {
        child.stdin.on('error', () => { /* the server exited before it read the secret */ });
        child.stdin.write(`${apiSecret}\n`);
      }
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
        refreshMenu();
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
      // The notifier stops calling the old port; launchBackend gives it the new one once the backend is ready
      if (notifier) notifier.setPort(null);
      refreshMenu();
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
  //     connect-src http://127.0.0.1:* (and ws:// for the sign-in terminal) so API calls to the Python backend work.
  //   • Loading from file:// means the window shows immediately without waiting
  //     for the Python server to boot.  The renderer handles the "backend not ready"
  //     state by showing a connecting overlay until it receives the backend-ready IPC.
  const uiPath = path.join(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
    'ui', 'dist', 'index.html'
  );
  mainWindow.loadFile(uiPath);

  // No second app window: a web or mail link the page opens in a new window (a link in a Docs page, a ticket, a
  // comment) goes to the person's browser instead of being dropped silently
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(shell, url);
    return { action: 'deny' };
  });

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
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*; media-src 'self' data: blob: http://127.0.0.1:* http://localhost:*; frame-src 'self' http://127.0.0.1:* http://localhost:* https://embed.diagrams.net; base-uri 'self'; object-src 'none'"
        ]
      }
    });
  });

  mainWindow.once('ready-to-show', () => {
    profiler.mark('window-first-paint');
    mainWindow.show();
    if (notifier) notifier.refresh(); // the Windows taskbar overlay belongs to the window
  });

  if (process.env.ELECTRON_DEV === '1') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    refreshMenu();
  });
  refreshMenu();
}

// ── Application menu ────────────────────────────────────────────────────────────────────────────────────────────
// The template is built in menu.js (pure, tested per platform); this part applies it and runs the commands.

function refreshMenu() {
  if (exportArgs) return; // the headless `--export-svg` run has no menu
  const template = buildMenuTemplate({
    platform: process.platform,
    appName: app.name || 'Kanban Board',
    version: app.getVersion(),
    backendRunning: Boolean(backendPort && backendProcess),
    windowOpen: Boolean(mainWindow && !mainWindow.isDestroyed()),
    currentView,
    keepAwake: keepAwakeOn(),
    update: getUpdateState(),
    dispatch: handleMenuCommand,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendToPage(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('app-command', message);
}

const toastInPage = (variant, title, message, action) =>
  sendToPage({ command: 'toast', variant, title, message, action });

/** Opens a link in the browser; when that fails the address is copied instead (and a toast says so). */
async function openLink(url) {
  try {
    await shell.openExternal(url);
  } catch {
    clipboard.writeText(url);
    toastInPage('warning', 'Could not open the browser', 'The address is copied instead. Paste it in a browser.');
  }
}

function logsDir() {
  return process.env.KANBAN_LOG_DIR || path.join(os.homedir(), '.kanban-board', 'logs');
}

/** Versions and system facts only. Used by Copy Diagnostics Info and the Report an Issue and About windows. */
function collectDiagnostics() {
  return {
    appName: app.name || 'Kanban Board',
    version: app.getVersion(),
    backendRunning: Boolean(backendPort && backendProcess),
    osName: { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform,
    osVersion: os.release(),
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    language: app.getSystemLocale(), // the OS locale: the app ships only a few Chromium locales (package.json electronLanguages)
  };
}

async function openFolder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const error = await shell.openPath(dir);
  if (error) toastInPage('error', 'Could not open the folder', error);
}

async function checkForUpdatesFromMenu() {
  const result = await checkNow();
  if (result.error) {
    toastInPage('error', "Couldn't check for updates", result.error, { label: 'Open releases page', command: 'open-releases' });
  } else if (!result.info) {
    toastInPage('success', "You're up to date", `Kanban Board ${app.getVersion()} is the latest version.`);
  } // else: the corner notice was sent by the updater
}

function handleMenuCommand(id, payload) {
  const action = resolveCommand(id, payload);
  if (action.type === 'link') return void openLink(action.url);
  if (action.type === 'renderer') return sendToPage(action.message);
  switch (action.name) {
    case 'open-logs':
      return void openFolder(logsDir());
    case 'open-data':
      return void openFolder(app.getPath('userData'));
    case 'copy-diagnostics':
      clipboard.writeText(buildDiagnosticsText(collectDiagnostics()));
      return toastInPage('success', 'Copied', 'Diagnostics info is on the clipboard.');
    case 'new-window':
      return void (mainWindow ? mainWindow.show() : createWindow());
    case 'maximize':
      if (mainWindow) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
      return undefined;
    case 'check-updates':
      return void checkForUpdatesFromMenu();
    case 'keep-awake':
      return void setKeepAwake(!keepAwakeOn());
    default:
      return undefined;
  }
}

// View › Keep awake while AI runs, and the chip in the page that mirrors it (design ai-story-flow R2)
function setKeepAwake(on) {
  preferences = { ...(preferences || readPreferences(preferencesFile())), keepAwake: Boolean(on) };
  writePreferences(preferencesFile(), preferences);
  if (powerKeeper) powerKeeper.tick(); // switching it off releases the computer at once
  refreshMenu();
  return keepAwakeOn();
}

ipcMain.handle('keep-awake-get', () => keepAwakeOn());
ipcMain.handle('keep-awake-set', (_event, on) => setKeepAwake(on));

// IPC: the page reports which view is on screen (for the check mark in View)
ipcMain.on('app-state', (_event, state) => {
  const view = state && typeof state.view === 'string' && VIEWS.some((v) => v.id === state.view) ? state.view : null;
  if (view !== currentView) {
    currentView = view;
    refreshMenu();
  }
});

// IPC: facts for the About and Report an Issue windows (the same as Copy Diagnostics Info)
ipcMain.handle('get-app-info', () => ({
  ...collectDiagnostics(),
  window: mainWindow && !mainWindow.isDestroyed() ? mainWindow.getSize() : null,
}));

// ── Desktop notifications ───────────────────────────────────────────────────────────────────────────────────────
// Clicking a notice brings the window up (created again if it was closed, macOS) and hands the row to the page, which
// opens the thing itself (ticket, run, account). `payload` is the feed row ({...row, action} for a button), a group
// ({group: true, ids, needs, title}), or null for the test notice.
function openFromNotification(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingOpen = payload;
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (payload) mainWindow.webContents.send('notifications:open', payload);
}

function ensurePowerKeeper() {
  if (powerKeeper) return;
  powerKeeper = createPowerKeeper({
    powerSaveBlocker,
    getPort: () => backendPort,
    getApiSecret: () => apiSecret,
    getKeepAwake: keepAwakeOn,
  });
  powerKeeper.start();
  // After the computer slept the board looks at the runs it thinks are going and ends the ones whose CLI is gone
  powerMonitor.on('resume', () => void powerKeeper.wake());
}

function ensureNotifier(port) {
  if (notifier) return void notifier.setPort(port);
  notifier = startNotifier({
    Notification,
    app,
    nativeImage,
    platform: process.platform,
    apiSecret,
    port,
    getWindow: () => mainWindow,
    onOpen: openFromNotification,
  });
}

const fromOwnWindow = (event) => Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);

// IPC: the page says who the person is (sent as X-Actor); kept in memory only
ipcMain.handle('notifications-set-actor', (event, name) => {
  if (!fromOwnWindow(event) || !notifier) return false;
  notifier.setActor(name);
  return true;
});

// IPC: {supported, permission: 'granted' | 'denied' | 'default'} for Settings › Notifications
ipcMain.handle('notifications-status', () => {
  if (notifier) return notifier.status();
  const supported = Notification.isSupported();
  return { supported, permission: supported ? 'granted' : 'denied' };
});

// IPC: Send a test — shown now, past the 20 s limit and quiet hours; {ok, reason?}
ipcMain.handle('notifications-test', async () => {
  if (!notifier) ensureNotifier(backendPort);
  return notifier.test();
});

// IPC: the system page where notifications are allowed; false where there is none (Linux)
ipcMain.handle('notifications-open-settings', async () => {
  const url = systemSettingsUrl(process.platform);
  if (!url) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

// The page started listening for notifications:open: deliver a click that arrived before it did
ipcMain.on('notifications-ready', (event) => {
  if (!fromOwnWindow(event) || !pendingOpen) return;
  const payload = pendingOpen;
  pendingOpen = null;
  event.sender.send('notifications:open', payload);
});

// IPC: renderer asks for backend port
ipcMain.handle('get-backend-port', () => backendPort);

// IPC: the page asks for the secret that lets it change the board (server/api_secret.py). Synchronous, so the first
// request already carries it; only the app's own window gets an answer.
ipcMain.on('get-api-secret', (event) => {
  event.returnValue = mainWindow && event.sender === mainWindow.webContents ? apiSecret : '';
});

// IPC: renderer asks to start the backend again after a failure ("Try again" on the splash)
let backendLaunching = false;
ipcMain.handle('retry-backend', async () => {
  if (backendLaunching) return;
  if (backendPort && backendProcess) {
    // Already running: just tell the (possibly reloaded) renderer again
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backend-ready', backendPort);
    return;
  }
  backendLaunching = true;
  try {
    await launchBackend();
  } finally {
    backendLaunching = false;
  }
});

// IPC: renderer asks to open a folder picker dialog
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Data Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

// IPC: open a file with system default application
ipcMain.handle('open-path', (_event, filePath) =>
  openPathSafely(shell, filePath, { confirm: confirmOpenAnyway, realpath: fs.realpathSync }),
);

/** Ask, in a system dialog the page cannot answer, before opening a file that could run a program. */
async function confirmOpenAnyway(name) {
  const options = {
    type: 'warning',
    buttons: ['Cancel', 'Open anyway'],
    defaultId: 0,
    cancelId: 0,
    message: `Open ${name}?`,
    detail: 'This kind of file can run programs on your computer. Open it only if you trust the person who added it.',
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

// IPC: reveal a file in Finder / Explorer
ipcMain.handle('show-item-in-folder', async (_event, filePath) => {
  if (!filePath || typeof filePath !== 'string') return { success: false, error: 'Invalid path' };
  try {
    shell.showItemInFolder(filePath);
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: open external URL in default browser
ipcMain.handle('open-external', (_event, url) => openExternalSafely(shell, url));

function launchBackend() {
  return startBackend()
    .then((port) => {
      backendPort = port; // Set the global port immediately for any future lookups
      ensureNotifier(port);
      ensurePowerKeeper();

      // VS Code MCP setup — one-time, packaged builds only
      const setupFlag = path.join(app.getPath('userData'), '.vscode-mcp-setup-done');
      const setupFlagExists = fs.existsSync(setupFlag);
      const dbPath = path.join(app.getPath('userData'), 'kanban.db');
      const exportCommand = buildExportCommand({ isPackaged: app.isPackaged, execPath: process.execPath, desktopDir: __dirname });
      const binaryOptions = {
        isPackaged: app.isPackaged,
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        desktopDir: __dirname,
      };
      if (shouldRunVscodeSetup({ isPackaged: app.isPackaged, setupFlagExists })) {
        const result = registerMcpServer(getMcpStdioBinaryPath(binaryOptions), dbPath, { exportCommand });
        if (shouldWriteSetupFlag(result)) {
          try {
            fs.writeFileSync(setupFlag, new Date().toISOString(), 'utf8');
          } catch { /* non-fatal */ }
        }
      } else if (app.isPackaged) {
        // Older versions registered the single-file binary, which is now a folder.
        registerMcpServer(getMcpStdioBinaryPath(binaryOptions), dbPath, {
          migrateFromCommand: getLegacyMcpStdioBinaryPath(binaryOptions),
          exportCommand,
        });
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
}

// `--export-svg` / `--export-png`: a headless run the backend asks for to draw a diagram's picture with the editor itself, or a page an AI drew (no window,
// no backend of its own). Every other start is the normal app.
const exportArgs = parseExportArgs(process.argv);

if (exportArgs) {
  app.whenReady().then(() => runExportCli(require('electron'), exportArgs));
} else {
  app.whenReady().then(() => {
    profiler.mark('app-ready');
    // Windows shows an app's notifications only under its App User Model ID (the installer's appId)
    if (process.platform === 'win32') app.setAppUserModelId('com.kanbanboard.app');
    // macOS shows the system About window (Linux uses these too); Windows gets the in-app one
    app.setAboutPanelOptions({
      applicationName: app.name || 'Kanban Board',
      applicationVersion: app.getVersion(),
      copyright: '© 2026 Cao Minh Tiến · MIT licence',
      website: 'https://github.com/iamcaominhtien/kanban-board-mcp',
    });
    setupUpdater(() => mainWindow, refreshMenu);
    // The menu is set before the window opens. Developer tools are View › Toggle Developer Tools, which only
    // works while this app is in front (it used to be a system-wide shortcut)
    refreshMenu();
    createWindow();

    launchBackend();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// macOS keeps the app — and the notifier — running with every window closed; quitting stops both
app.on('window-all-closed', () => {
  if (!exportArgs && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (notifier) notifier.stop();
  if (powerKeeper) powerKeeper.stop();
  if (terminateBackendProcess(backendProcess)) {
    backendProcess = null;
  }
});
