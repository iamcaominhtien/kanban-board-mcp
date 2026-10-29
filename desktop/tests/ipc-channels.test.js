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
