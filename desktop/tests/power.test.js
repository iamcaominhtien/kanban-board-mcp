const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  POWER_POLL_MS,
  createPowerKeeper,
  decidePowerBlock,
  fetchActiveRuns,
  postWake,
  readPreferences,
  writePreferences,
} = require('../main-helpers');
const { buildMenuTemplate, flattenItems, resolveCommand } = require('../menu');

test('decidePowerBlock holds the computer only while runs go, the switch is on and nothing is held yet', () => {
  assert.equal(decidePowerBlock({ keepAwake: true, active: 2, blocking: false }), 'start');
  assert.equal(decidePowerBlock({ keepAwake: true, active: 3, blocking: true }), 'none');
  assert.equal(decidePowerBlock({ keepAwake: true, active: 0, blocking: true }), 'stop');
  assert.equal(decidePowerBlock({ keepAwake: true, active: 0, blocking: false }), 'none');
  assert.equal(decidePowerBlock({ keepAwake: false, active: 2, blocking: true }), 'stop');
  assert.equal(decidePowerBlock({ keepAwake: false, active: 2, blocking: false }), 'none');
  assert.equal(decidePowerBlock({ keepAwake: true, active: NaN, blocking: false }), 'none');
});

test('preferences default to keep awake on, survive a round trip, and ignore a broken file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-prefs-'));
  const file = path.join(dir, 'sub', 'preferences.json');
  assert.deepEqual(readPreferences(file), { keepAwake: true });
  assert.equal(writePreferences(file, { keepAwake: false }), true);
  assert.deepEqual(readPreferences(file), { keepAwake: false });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readPreferences(file), { keepAwake: true });
});

const reply = (body, ok = true) => async () => ({ ok, json: async () => body });

test('fetchActiveRuns reads the count and gives null for anything it cannot read', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push([url, init.headers]);
    return { ok: true, json: async () => ({ active: 2 }) };
  };
  assert.equal(await fetchActiveRuns({ port: 5173, apiSecret: 's', fetchFn }), 2);
  assert.deepEqual(seen[0], ['http://127.0.0.1:5173/ai/power', { 'X-Kanban-Secret': 's' }]);
  assert.equal(await fetchActiveRuns({ port: null, fetchFn }), null);
  assert.equal(await fetchActiveRuns({ port: 1, fetchFn: reply({}, false) }), null);
  assert.equal(await fetchActiveRuns({ port: 1, fetchFn: reply({ active: 'x' }) }), null);
  assert.equal(await fetchActiveRuns({ port: 1, fetchFn: async () => { throw new Error('down'); } }), null);
});

test('postWake posts to the board and says whether it went through', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push([url, init.method]);
    return { ok: true };
  };
  assert.equal(await postWake({ port: 9, fetchFn }), true);
  assert.deepEqual(seen[0], ['http://127.0.0.1:9/ai/power/wake', 'POST']);
  assert.equal(await postWake({ port: null, fetchFn }), false);
  assert.equal(await postWake({ port: 9, fetchFn: async () => { throw new Error('down'); } }), false);
});

function fakeBlocker() {
  const started = new Set();
  let next = 1;
  return {
    started,
    start: (type) => {
      assert.equal(type, 'prevent-app-suspension');
      started.add(next);
      return next++;
    },
    stop: (id) => started.delete(id),
    isStarted: (id) => started.has(id),
  };
}

test('the keeper starts the blocker when runs appear and stops it when they end', async () => {
  const blocker = fakeBlocker();
  let active = 0;
  let keepAwake = true;
  let port = 4000;
  const keeper = createPowerKeeper({
    powerSaveBlocker: blocker,
    getPort: () => port,
    getKeepAwake: () => keepAwake,
    fetchFn: async () => ({ ok: true, json: async () => ({ active }) }),
  });
  assert.equal(await keeper.tick(), 'none');
  active = 1;
  assert.equal(await keeper.tick(), 'start');
  assert.equal(blocker.started.size, 1);
  assert.equal(await keeper.tick(), 'none'); // already held, not started twice
  keepAwake = false; // the menu check mark switched off
  assert.equal(await keeper.tick(), 'stop');
  assert.equal(blocker.started.size, 0);
  keepAwake = true;
  assert.equal(await keeper.tick(), 'start');
  port = null; // the backend is gone: nothing is held
  assert.equal(await keeper.tick(), 'stop');
  assert.equal(keeper.isBlocking(), false);
});

test('the keeper polls every 30 seconds and stop() releases the computer', async () => {
  const blocker = fakeBlocker();
  const timers = [];
  const cleared = [];
  const keeper = createPowerKeeper({
    powerSaveBlocker: blocker,
    getPort: () => 1,
    getKeepAwake: () => true,
    fetchFn: async () => ({ ok: true, json: async () => ({ active: 1 }) }),
    setIntervalFn: (fn, ms) => {
      timers.push(ms);
      return 7;
    },
    clearIntervalFn: (t) => cleared.push(t),
  });
  keeper.start();
  keeper.start(); // once
  assert.deepEqual(timers, [POWER_POLL_MS]);
  assert.equal(POWER_POLL_MS, 30000);
  await keeper.tick();
  assert.equal(keeper.isBlocking(), true);
  keeper.stop();
  assert.deepEqual(cleared, [7]);
  assert.equal(keeper.isBlocking(), false);
});

test('the menu has the "Keep awake while AI runs" checkbox, on by default, handled by the main process', () => {
  const ctx = {
    platform: 'darwin', appName: 'Kanban Board', version: '1', backendRunning: true, windowOpen: true,
    currentView: 'board', update: { checking: false, availableVersion: null }, dispatch: () => {},
  };
  const item = (over) => flattenItems(buildMenuTemplate({ ...ctx, ...over })).find((i) => i.id === 'keep-awake');
  assert.equal(item({}).label, 'Keep awake while AI runs');
  assert.equal(item({}).type, 'checkbox');
  assert.equal(item({}).checked, true);
  assert.equal(item({ keepAwake: false }).checked, false);
  assert.deepEqual(resolveCommand('keep-awake'), { type: 'main', name: 'keep-awake' });
});
