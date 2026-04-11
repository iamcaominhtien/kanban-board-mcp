const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

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

    child.stdout.on('data', (data) => {
      output += data.toString();
      const match = output.match(/READY port=(\d+)/);
      if (match) {
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
    });

    setTimeout(() => reject(new Error('Backend startup timeout')), 30000);
  });
}

function createWindow() {
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
          // TODO(IAM-77): narrow connect-src to the actual backend port once Python process is wired up
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*; img-src 'self' data: blob:"
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
    // Still show the window — it will show an error state
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
