// Pictures for the desktop chapter. The menus are native, so they cannot be photographed outside the app: they are
// DRAWN from the real menu template (desktop/menu.js), so they always list the real items, order, shortcuts and
// check marks (the look is an illustration, not a screenshot). The small windows, the toast and the update card are
// real screenshots of the page, with a stand-in for the `electronAPI` the desktop shell provides.
//
//   Start the demo server as described in take_screenshots.js, then:  node take_menu_shots.js
const { chromium } = require('playwright');
const path = require('path');
const { buildMenuTemplate } = require('../../../../desktop/menu.js');

const BASE = process.env.BASE || 'http://localhost:8765';
const OUT = path.join(__dirname, '..', 'images');
const VERSION = require('fs').readFileSync(path.join(__dirname, '../../../../server/version.py'), 'utf8').match(/APP_VERSION = "([^"]+)"/)[1];

const ROLE_LABEL = { undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteAndMatchStyle: 'Paste and Match Style', selectAll: 'Select All',
  minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front', services: 'Services', hide: 'Hide Kanban Board', hideOthers: 'Hide Others', unhide: 'Show All',
  quit: 'Quit Kanban Board', close: 'Close Window', resetZoom: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', togglefullscreen: 'Toggle Full Screen', about: 'About Kanban Board', toggleDevTools: 'Toggle Developer Tools' };
const ROLE_KEYS = { undo: '⌘Z', redo: '⇧⌘Z', cut: '⌘X', copy: '⌘C', paste: '⌘V', selectAll: '⌘A', hide: '⌘H', hideOthers: '⌥⌘H', quit: '⌘Q', close: '⌘W', minimize: '⌘M', resetZoom: '⌘0', zoomIn: '⌘+', zoomOut: '⌘−', togglefullscreen: '⌃⌘F' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function keysFor(item, mac) {
  if (item.accelerator) {
    const a = item.accelerator.split('+').map((k) => ({ CmdOrCtrl: mac ? '⌘' : 'Ctrl', Shift: mac ? '⇧' : 'Shift', Alt: mac ? '⌥' : 'Alt' }[k] || k));
    if (!mac) return a.join('+');
    const mods = ['⌃', '⌥', '⇧', '⌘'].filter((m) => a.includes(m));
    return mods.join('') + a.filter((k) => !'⌃⌥⇧⌘'.includes(k)).join('');
  }
  return mac && item.role ? ROLE_KEYS[item.role] || '' : '';
}

function dropdown(menu, mac) {
  const rows = menu.submenu.map((it) => {
    if (it.type === 'separator') return '<div class="sep"></div>';
    const label = it.label || ROLE_LABEL[it.role] || it.role;
    const mark = it.type === 'radio' && it.checked ? '✓' : '';
    const arrow = it.role === 'services' ? '▸' : '';
    return `<div class="it ${it.enabled === false ? 'off' : ''}"><span class="mk">${mark}</span><span class="lb">${esc(label)}</span><span class="ky">${esc(keysFor(it, mac) || arrow)}</span></div>`;
  });
  return `<div class="dd">${rows.join('')}</div>`;
}

function menuPage(platform, openLabel) {
  const mac = platform === 'darwin';
  const tpl = buildMenuTemplate({ platform, appName: 'Kanban Board', version: VERSION, backendRunning: true, windowOpen: true, currentView: 'board', update: { checking: false, availableVersion: null }, dispatch: () => {} });
  const bar = tpl.map((m, i) => `<span class="mn ${m.label === openLabel ? 'open' : ''} ${mac && i === 0 ? 'app' : ''}">${esc(m.label)}</span>`).join('');
  const open = tpl.find((m) => m.label === openLabel);
  const left = tpl.slice(0, tpl.indexOf(open)).reduce((w, m, i) => w + (mac && i === 0 ? 0 : 0) + 0, 0);
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;font:13px -apple-system,'Segoe UI','Plus Jakarta Sans',sans-serif;background:${mac ? '#d9e4dc' : '#e9eeea'};width:760px;height:560px;position:relative;color:#111}
  .bar{display:flex;gap:${mac ? 18 : 4}px;padding:${mac ? '5px 14px' : '4px 8px'};background:${mac ? 'rgba(255,255,255,.7)' : '#fff'};border-bottom:1px solid #c5d0c8}
  .mn{padding:${mac ? '1px 7px' : '3px 9px'};border-radius:${mac ? 5 : 0}px}.mn.app{font-weight:700}.mn.open{background:${mac ? '#2e6f40;color:#fff' : '#cfe5d5'}}
  .win{padding:6px 10px;background:#fff;font-size:12px;color:#555;border-bottom:1px solid #ddd}
  .dd{position:absolute;top:${mac ? 30 : 56}px;left:__LEFT__px;min-width:300px;background:${mac ? 'rgba(250,250,250,.97)' : '#fff'};border:1px solid #b9c5bc;border-radius:${mac ? 8 : 0}px;box-shadow:0 8px 28px rgba(0,0,0,.28);padding:5px 0}
  .it{display:flex;gap:6px;padding:3px 12px 3px 6px;line-height:20px}.mk{width:14px;text-align:center}.lb{flex:1}.ky{color:#666;padding-left:30px}.off{color:#aaa}.sep{height:1px;background:#d8ded9;margin:4px 0}
  </style>${win_title(mac)}<div class="bar">${bar}</div>${dropdown(open, mac).replace('__LEFT__', '0')}`;
  function win_title(m) { return m ? '' : '<div class="win">Kanban Board</div>'; }
}

// Position the open menu under its title by measuring in the page
async function drawMenu(page, platform, openLabel, name) {
  await page.setViewportSize({ width: 760, height: 560 });
  await page.setContent(menuPage(platform, openLabel).replace('__LEFT__', '0'));
  await page.evaluate(() => {
    const open = document.querySelector('.mn.open');
    document.querySelector('.dd').style.left = open.getBoundingClientRect().left - 4 + 'px';
  });
  const box = await page.evaluate(() => {
    const d = document.querySelector('.dd').getBoundingClientRect();
    return { w: Math.ceil(Math.max(d.right, 520)) + 14, h: Math.ceil(d.bottom) + 14 };
  });
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: box.w, height: box.h } });
  console.log('  ' + name);
}

const MOCK = (platform, version) => `
  window.__handlers = { cmd: null, upd: null };
  window.electronAPI = {
    platform: ${JSON.stringify(platform)},
    getBackendPort: async () => 8765,
    onBackendReady: (cb) => { setTimeout(() => cb(8765), 0); return () => {}; },
    onBackendError: () => () => {},
    retryBackend: async () => 8765,
    onAppCommand: (cb) => { window.__handlers.cmd = cb; return () => {}; },
    setAppState: () => {},
    getAppInfo: async () => ({ appName: 'Kanban Board', version: ${JSON.stringify(version)}, backendRunning: true, osName: ${JSON.stringify(platform === 'darwin' ? 'macOS' : 'Windows')},
      osVersion: ${JSON.stringify(platform === 'darwin' ? '15.1' : '11 (10.0.26100)')}, arch: ${JSON.stringify(platform === 'darwin' ? 'arm64' : 'x64')}, electron: '39.8.5', chrome: '140.0', language: 'en', window: [1400, 900] }),
    openExternal: async () => ({ success: true }), openReleasesPage: async () => {},
    getUpdateInfo: async () => null, getUpdateStatus: async () => ({ currentVersion: ${JSON.stringify(version)}, lastCheck: null, info: null }),
    checkForUpdate: async () => ({ info: null, lastCheck: null }),
    onUpdateAvailable: (cb) => { window.__handlers.upd = cb; return () => {}; }, onUpdateProgress: () => () => {},
  };`;

(async () => {
  const browser = await chromium.launch();
  const menuPageCtx = await browser.newPage({ deviceScaleFactor: 1.6 });
  await drawMenu(menuPageCtx, 'darwin', 'Kanban Board', 'menu-macos-app');
  await drawMenu(menuPageCtx, 'darwin', 'Help', 'menu-macos-help');
  await drawMenu(menuPageCtx, 'win32', 'Help', 'menu-windows-help');
  await drawMenu(menuPageCtx, 'darwin', 'View', 'menu-macos-view');

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(MOCK('darwin', VERSION));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((id) => localStorage.setItem('activeProjectId', id), (await (await fetch(BASE + '/projects')).json())[0].id);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__handlers.cmd, null, { timeout: 15000 });
  // `what` is 'dialog' (cropped around the window), 'corner' (the bottom right, for the toast and the update card)
  const shot = async (name, what) => {
    await page.waitForTimeout(900);
    let clip;
    if (what === 'dialog') {
      const b = await page.locator('[role="dialog"]').first().boundingBox();
      clip = { x: Math.max(0, b.x - 36), y: Math.max(0, b.y - 36), width: b.width + 72, height: b.height + 72 };
    } else if (what === 'corner') {
      clip = { x: 1440 - 520, y: 900 - 330, width: 520, height: 330 };
    }
    await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 82, ...(clip ? { clip } : {}) });
    console.log('  ' + name);
  };
  const send = (msg) => page.evaluate((m) => window.__handlers.cmd(m), msg);
  const close = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); };

  await send({ command: 'shortcuts' }); await shot('dlg-shortcuts', 'dialog'); await close();
  await send({ command: 'whats-new' }); await shot('dlg-whats-new', 'dialog'); await close();
  await send({ command: 'report-issue' }); await shot('dlg-report-issue', 'dialog'); await close();
  await send({ command: 'about' }); await shot('dlg-about', 'dialog'); await close();
  await send({ command: 'toast', variant: 'success', title: "You're up to date", message: `Kanban Board ${VERSION} is the latest version.` }); await shot('toast-up-to-date', 'corner');
  await page.waitForTimeout(4500);
  await page.evaluate((v) => window.__handlers.upd({ version: v, notes: '- Fix: the Idea Space list no longer jumps when a ticket moves.\n- Docs search keeps the filter when you go back.', releaseUrl: 'https://github.com/iamcaominhtien/kanban-board-mcp/releases', assetName: 'x', assetSize: 1, manual: true }), '3.15.1');
  await shot('update-card', 'corner');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
