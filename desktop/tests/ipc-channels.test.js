const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// The page can only call what preload.js exposes, and every exposed call needs a handler in the main process.
// A channel with no handler fails at runtime ("No handler registered"), which the viewer would show as a broken
// "Open in app" / "Show in folder".
test('every channel preload.js invokes has a handler in the main process', () => {
  const handled = new Set();
  for (const file of ['main.js', 'updater.js']) {
    for (const [, channel] of read(file).matchAll(/ipcMain\.handle\(\s*'([\w-]+)'/g)) handled.add(channel);
  }
  const missing = [];
  for (const [, channel] of read('preload.js').matchAll(/ipcRenderer\.invoke\(\s*'([\w-]+)'/g)) {
    if (!handled.has(channel)) missing.push(channel);
  }
  assert.deepStrictEqual(missing, []);
});

test('the viewer actions are exposed to the page', () => {
  const preload = read('preload.js');
  assert.match(preload, /openPath:/);
  assert.match(preload, /showItemInFolder:/);
});

test('the page gets the API secret only through a synchronous channel the main process answers', () => {
  const preload = read('preload.js');
  const main = read('main.js');
  assert.match(preload, /getApiSecret:\s*\(\)\s*=>\s*ipcRenderer\.sendSync\('get-api-secret'\)/);
  assert.match(main, /ipcMain\.on\('get-api-secret'/);
  // only the app's own window gets an answer
  assert.match(main, /event\.sender === mainWindow\.webContents/);
});

test('every channel preload.js sends to has a listener in the main process', () => {
  const listened = new Set();
  for (const [, channel] of read('main.js').matchAll(/ipcMain\.on\(\s*'([\w:-]+)'/g)) listened.add(channel);
  const missing = [];
  for (const [, channel] of read('preload.js').matchAll(/ipcRenderer\.send\(\s*'([\w:-]+)'/g)) {
    if (!listened.has(channel)) missing.push(channel);
  }
  assert.deepStrictEqual(missing, []);
});

test('the notifications API is exposed and its click channel is the one the main process sends', () => {
  const preload = read('preload.js');
  const main = read('main.js');
  for (const name of ['setActor', 'status', 'test', 'openSystemSettings', 'onOpen']) {
    assert.match(preload, new RegExp(`\\b${name}:`));
  }
  assert.match(preload, /ipcRenderer\.on\('notifications:open'/);
  assert.match(main, /webContents\.send\('notifications:open'/);
  assert.match(main, /\.send\('notifications:open'/);
});

// A link the page opens in a new window (target=_blank: a web link in a Docs page, a ticket, a comment) must reach the
// browser; a bare deny dropped it silently, so links "did not open" in the desktop app.
test('a link opened in a new window goes to the browser, never to a second app window', () => {
  const main = read('main.js');
  const handler = main.match(/setWindowOpenHandler\(\(\{ url \}\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(handler, 'setWindowOpenHandler takes the url');
  assert.match(handler[1], /openExternalSafely\(shell, url\)/);
  assert.match(handler[1], /return \{ action: 'deny' \}/);
});

// Settings › Diagrams offers the public draw.io editor; the window's policy blocked its frame, so "public" never opened.
test('the window may frame the public draw.io editor, and nothing else on the internet', () => {
  const frameSrc = read('main.js').match(/frame-src ([^;]*);/);
  assert.ok(frameSrc, 'the policy has a frame-src');
  const sources = frameSrc[1].split(/\s+/);
  assert.ok(sources.includes('https://embed.diagrams.net'));
  assert.ok(!sources.includes('https:') && !sources.includes('*'));
});
