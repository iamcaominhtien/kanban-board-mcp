const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildMenuTemplate, flattenItems, resolveCommand, buildDiagnosticsText, LINKS, VIEWS } = require('../menu');

const base = {
  appName: 'Kanban Board',
  version: '3.15.0',
  backendRunning: true,
  windowOpen: true,
  currentView: 'board',
  update: { checking: false, availableVersion: null },
  dispatch: () => {},
};
const build = (platform, over = {}) => buildMenuTemplate({ ...base, platform, ...over });
const labels = (template, label) => template.find((m) => m.label === label).submenu;
const byId = (template, id) => flattenItems(template).find((i) => i.id === id);
const itemLabels = (submenu) => submenu.filter((i) => i.type !== 'separator').map((i) => i.label || i.role);

test('macOS: app menu, File, Edit, View, Window, Help in that order', () => {
  const t = build('darwin');
  assert.deepStrictEqual(t.map((m) => m.label), ['Kanban Board', 'File', 'Edit', 'View', 'Window', 'Help']);
});

test('Windows and Linux have no app menu', () => {
  for (const platform of ['win32', 'linux']) {
    assert.deepStrictEqual(build(platform).map((m) => m.label), ['File', 'Edit', 'View', 'Window', 'Help']);
  }
});

test('macOS app menu: About, Check for Updates, Settings, Services, Hide, Quit', () => {
  const app = build('darwin')[0].submenu;
  assert.deepStrictEqual(
    app.filter((i) => i.type !== 'separator').map((i) => i.role || i.id),
    ['about', 'check-updates', 'settings', 'services', 'hide', 'hideOthers', 'unhide', 'quit'],
  );
  assert.strictEqual(byId(build('darwin'), 'settings').accelerator, 'CmdOrCtrl+,');
});

test('macOS Help uses the standard Help role (system search box) and has no About or update item', () => {
  const help = build('darwin').find((m) => m.label === 'Help');
  assert.strictEqual(help.role, 'help');
  assert.ok(!help.submenu.some((i) => ['about', 'check-updates'].includes(i.id)));
  assert.strictEqual(help.submenu.find((i) => i.id === 'open-logs').label, 'Show Logs in Finder');
});

test('Windows and Linux: Settings and Exit in File; Check for Updates and About at the bottom of Help', () => {
  for (const platform of ['win32', 'linux']) {
    const t = build(platform);
    const file = labels(t, 'File');
    assert.ok(file.some((i) => i.id === 'settings'));
    assert.strictEqual(file[file.length - 1].label, 'Exit');
    const help = labels(t, 'Help').filter((i) => i.type !== 'separator');
    assert.deepStrictEqual(help.slice(-2).map((i) => i.id), ['check-updates', 'about']);
    assert.strictEqual(help.find((i) => i.id === 'open-logs').label, 'Open Logs Folder');
    assert.strictEqual(labels(t, 'Help').find((i) => i.role === 'help'), undefined);
  }
  assert.strictEqual(labels(build('win32'), 'File').at(-1).accelerator, 'Alt+F4');
});

test('Edit, Window and Services use standard roles', () => {
  const edit = labels(build('darwin'), 'Edit');
  for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']) {
    assert.ok(edit.some((i) => i.role === r), r);
  }
  assert.deepStrictEqual(itemLabels(labels(build('darwin'), 'Window')), ['minimize', 'zoom', 'front']);
  assert.ok(build('darwin')[0].submenu.some((i) => i.role === 'services'));
});

test('Help items follow the design', () => {
  const help = itemLabels(labels(build('darwin'), 'Help'));
  assert.deepStrictEqual(help, [
    'Keyboard Shortcuts',
    'Documentation',
    "What's New in 3.15.0",
    'Set Up AI…',
    'Set Up MCP…',
    'Report an Issue…',
    'Request a Feature…',
    'Show Logs in Finder',
    'Export Logs…',
    'Open Data Folder',
    'Copy Diagnostics Info',
  ]);
});

test('every link is a page of this project, never Electron', () => {
  for (const url of Object.values(LINKS)) assert.match(url, /^https:\/\/github\.com\/iamcaominhtien\/kanban-board-mcp/);
  assert.ok(!JSON.stringify(build('linux'), (k, v) => (typeof v === 'function' ? undefined : v)).includes('electronjs'));
});

test('developer tools are a menu item with an accelerator, and nothing registers a global shortcut', () => {
  const dev = byId(build('linux'), 'toggle-dev-tools');
  assert.strictEqual(dev.role, 'toggleDevTools');
  assert.strictEqual(dev.accelerator, 'CmdOrCtrl+Shift+I');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/globalShortcut/.test(main));
});

test('View lists the views with the current one checked', () => {
  const view = labels(build('darwin', { currentView: 'docs' }), 'View');
  const radios = view.filter((i) => i.type === 'radio');
  assert.deepStrictEqual(radios.map((i) => i.label), VIEWS.map((v) => v.label));
  assert.deepStrictEqual(radios.filter((i) => i.checked).map((i) => i.id), ['view-docs']);
  assert.deepStrictEqual(radios.map((i) => i.accelerator), ['1', '2', '3', '4', '5', '6'].map((n) => `CmdOrCtrl+${n}`));
});

test('items that need data are greyed while the backend is down, Help still works', () => {
  const t = build('darwin', { backendRunning: false });
  for (const id of ['new-ticket', 'new-idea', 'new-doc', 'new-project', 'import-data', 'export-data', 'settings', 'view-board', 'ask-ai', 'find-board']) {
    assert.strictEqual(byId(t, id).enabled, false, id);
  }
  for (const id of ['docs', 'report-issue', 'request-feature', 'open-logs', 'open-data', 'copy-diagnostics', 'shortcuts', 'check-updates']) {
    assert.notStrictEqual(byId(t, id).enabled, false, id);
  }
  assert.strictEqual(byId(build('darwin'), 'new-ticket').enabled, true);
});

test('macOS with no window open: only New Window is live in File; page items are greyed', () => {
  const t = build('darwin', { windowOpen: false });
  assert.strictEqual(byId(t, 'new-window').enabled, true);
  assert.strictEqual(byId(t, 'new-ticket').enabled, false);
  assert.strictEqual(byId(t, 'shortcuts').enabled, false);
  assert.strictEqual(byId(build('darwin'), 'new-window').enabled, false);
});

test('Check for Updates is greyed and renamed while a check runs, and offers the install when one exists', () => {
  const checking = byId(build('win32', { update: { checking: true, availableVersion: null } }), 'check-updates');
  assert.strictEqual(checking.label, 'Checking for Updates…');
  assert.strictEqual(checking.enabled, false);
  const ready = byId(build('win32', { update: { checking: false, availableVersion: '3.16.0' } }), 'check-updates');
  assert.strictEqual(ready.label, 'Install Update 3.16.0…');
  assert.strictEqual(ready.enabled, true);
});

test('clicking an item calls dispatch with its id and payload', () => {
  const calls = [];
  const t = build('linux', { dispatch: (...args) => calls.push(args) });
  byId(t, 'new-ticket').click();
  byId(t, 'view-list').click();
  byId(t, 'setup-ai').click();
  assert.deepStrictEqual(calls, [['new-ticket', undefined], ['view-list', { view: 'list' }], ['setup-ai', { page: 'ai' }]]);
});

test('ids are unique', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const ids = [];
    (function walk(items) {
      for (const i of items) {
        ids.push(i.id);
        if (i.submenu) walk(i.submenu);
      }
    })(build(platform));
    assert.strictEqual(new Set(ids).size, ids.length, platform);
  }
});

test('resolveCommand: links, main-process commands, Settings pages and page commands', () => {
  assert.deepStrictEqual(resolveCommand('open-link', { url: 'https://x' }), { type: 'link', url: 'https://x' });
  assert.deepStrictEqual(resolveCommand('check-updates'), { type: 'main', name: 'check-updates' });
  assert.deepStrictEqual(resolveCommand('check-updates', { page: 'updates' }), { type: 'renderer', message: { command: 'settings', page: 'updates' } });
  assert.deepStrictEqual(resolveCommand('export-logs').message, { command: 'settings', page: 'diagnostics', setting: 'logs' });
  assert.deepStrictEqual(resolveCommand('import-data').message, { command: 'settings', page: 'storage', setting: 'import' });
  assert.deepStrictEqual(resolveCommand('view-ideas').message, { command: 'view', view: 'ideas' });
  assert.deepStrictEqual(resolveCommand('new-ticket').message, { command: 'new-ticket' });
  assert.strictEqual(resolveCommand('open-logs').type, 'main');
});

test('diagnostics text has versions and system facts only', () => {
  const text = buildDiagnosticsText({
    appName: 'Kanban Board', version: '3.15.0', backendRunning: true, osName: 'macOS', osVersion: '24.1.0', arch: 'arm64',
    electron: '39.8.5', chrome: '140', language: 'en',
  });
  assert.match(text, /Kanban Board 3\.15\.0/);
  assert.match(text, /macOS 24\.1\.0 \(arm64\)/);
  assert.ok(!/\/Users|\\\\|token|key/i.test(text));
});

// Menu shortcuts must not take a key the page already uses, and must match the list the shortcut window and the guide read.
test('every menu accelerator is in the shared shortcut list, and Ctrl/Cmd+F is left to Docs', () => {
  const file = path.join(__dirname, '..', '..', 'ui', 'src', 'components', 'shortcuts', 'shortcuts.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fromList = new Map();
  for (const g of list.groups) for (const i of g.items) if (i.where.includes('desktop menu')) fromList.set(i.id, i.keys.join('+'));
  const seen = new Set();
  for (const item of flattenItems(build('darwin'))) {
    if (!item.accelerator || item.role) continue;
    assert.ok(fromList.has(item.id), `${item.id} is not in shortcuts.json`);
    assert.strictEqual(fromList.get(item.id), item.accelerator.replace('CmdOrCtrl', 'Mod'), item.id);
    seen.add(item.id);
  }
  assert.ok(!flattenItems(build('darwin')).some((i) => /^CmdOrCtrl\+F$/.test(i.accelerator || '')));
  for (const id of fromList.keys()) assert.ok(seen.has(id), `${id} is in shortcuts.json but not in the menu`);
});
