const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { registerMcpServer } = require('./vscode-setup');

let mainWindow = null;
let backendPort = null;
let backendProcess = null;

function startBackend() {
  return new Promise((resolve, reject) => {
    const userData = app.getPath('userData');
    const dbPath = path.join(userData, 'kanban.db');
    const env = { ...process.env, KANBAN_DB_PATH: dbPath };

    let child;
    if (app.isPackaged) {
      const ext = process.platform === 'win32' ? '.exe' : '';
      const binaryPath = path.join(process.resourcesPath, `kanban-server${ext}`);
      child = spawn(binaryPath, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      const serverDir = path.join(__dirname, '..', 'server');
      const pythonPath = path.join(serverDir, '.venv', 'bin', 'python');
      const python = fs.existsSync(pythonPath) ? pythonPath : 'python3';
      child = spawn(python, [path.join(serverDir, 'main.py')], {
        env,
        cwd: serverDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    backendProcess = child;
    let output = '';
    let settled = false;
    let timeoutId;

    child.stdout.on('data', (data) => {
      output += data.toString();
      const match = output.match(/READY port=(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeoutId);
        backendPort = parseInt(match[1], 10);
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

function getMcpStdioBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, `kanban-mcp-stdio${ext}`);
  } else {
    // Dev mode: points to the raw Python script.
    // VS Code MCP registration will NOT work in dev mode (no Python interpreter configured).
    // This is intentional — only test MCP registration with a packaged build.
    return path.join(__dirname, '..', 'server', 'mcp_stdio.py');
  }
}

// IPC: renderer asks for backend port
ipcMain.handle('get-backend-port', () => backendPort);

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (err) {
    console.error('Failed to start backend:', err);
  }

  // One-time VS Code MCP setup
  const setupFlag = path.join(app.getPath('userData'), '.vscode-mcp-setup-done');
  if (!fs.existsSync(setupFlag)) {
    const result = registerMcpServer(getMcpStdioBinaryPath());
    const doneResults = ['registered', 'already-registered'];

    if (doneResults.includes(result)) {
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
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
});
