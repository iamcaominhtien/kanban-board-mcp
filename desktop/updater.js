const { app, ipcMain, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { LATEST_RELEASE_URL, RELEASES_PAGE_URL, buildUpdateInfo, isTrustedDownloadUrl } = require('./updater-helpers');

const CHECK_DELAY_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let latestInfo = null;
let lastCheck = null; // { at, error } of the most recent check, automatic or manual
let downloading = false;

// Electron's net.fetch goes through Chromium's network stack, so it honours the system proxy
// and the OS certificate store. Node's global fetch does neither, which on Windows machines
// behind a proxy or HTTPS-scanning antivirus made every check fail silently.
async function checkForUpdate() {
  try {
    const res = await net.fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kanban-board-desktop' },
      // Revalidate instead of reusing GitHub's 60 s cached answer; a 304 does not count against the rate limit
      cache: 'no-cache',
    });
    if (!res.ok) {
      const limited = [403, 429].includes(res.status) && res.headers.get('x-ratelimit-remaining') === '0';
      throw new Error(limited ? 'GitHub rate limit reached, try again later' : `GitHub responded ${res.status}`);
    }
    const release = await res.json();
    latestInfo = buildUpdateInfo(release, {
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    });
    lastCheck = { at: new Date().toISOString(), error: null };
    return latestInfo;
  } catch (err) {
    lastCheck = { at: new Date().toISOString(), error: err.message };
    throw err;
  }
}

async function downloadInstaller(info, onProgress) {
  if (!isTrustedDownloadUrl(info.assetUrl)) throw new Error('Untrusted download URL');
  const dir = path.join(app.getPath('temp'), 'kanban-board-update');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(info.assetName));

  const res = await net.fetch(info.assetUrl, { headers: { 'User-Agent': 'kanban-board-desktop' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || info.assetSize || 0;

  const hash = crypto.createHash('sha256');
  let received = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    if (total) onProgress(Math.min(1, received / total));
  });
  await pipeline(source, fs.createWriteStream(target));

  if (info.sha256 && hash.digest('hex') !== info.sha256) {
    fs.rmSync(target, { force: true });
    throw new Error('Checksum mismatch — the download was discarded');
  }
  return target;
}

async function installUpdate(filePath) {
  if (typeof filePath !== 'string' || path.dirname(filePath) !== path.join(app.getPath('temp'), 'kanban-board-update')) {
    throw new Error('Invalid installer path');
  }
  if (process.platform === 'win32') {
    spawn(filePath, [], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return;
  }
  // macOS: mounts the disk image so the user can drag the app to Applications
  const err = await shell.openPath(filePath);
  if (err) throw new Error(err);
}

function setupUpdater(getWindow) {
  const notify = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const runCheck = async () => {
    try {
      const info = await checkForUpdate();
      if (info) notify('update-available', info);
    } catch (err) {
      console.warn('[updater] check failed:', err.message); // offline etc. — stay silent
    }
  };

  ipcMain.handle('update-get', () => latestInfo);
  ipcMain.handle('update-status', () => ({ currentVersion: app.getVersion(), lastCheck, info: latestInfo }));
  ipcMain.handle('update-check', async () => {
    try {
      const info = await checkForUpdate();
      // A manual check brings the notice back, even after "Later" or "Skip this version"
      if (info) notify('update-available', { ...info, manual: true });
      return { info, lastCheck };
    } catch (err) {
      return { info: null, lastCheck, error: err.message };
    }
  });
  ipcMain.handle('update-open-releases', () => shell.openExternal(RELEASES_PAGE_URL));
  ipcMain.handle('update-download', async () => {
    if (!latestInfo) return { error: 'No update available' };
    if (downloading) return { error: 'Already downloading' };
    downloading = true;
    try {
      const filePath = await downloadInstaller(latestInfo, (p) => notify('update-progress', p));
      return { filePath };
    } catch (err) {
      return { error: err.message };
    } finally {
      downloading = false;
    }
  });
  ipcMain.handle('update-install', async (_event, filePath) => {
    try {
      await installUpdate(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Packaged builds only: a dev checkout has no installers to compare against
  if (app.isPackaged) {
    setTimeout(runCheck, CHECK_DELAY_MS);
    setInterval(runCheck, CHECK_INTERVAL_MS).unref();
  }
}

module.exports = { setupUpdater };
