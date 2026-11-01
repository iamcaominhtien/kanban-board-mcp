const test = require('node:test');
const assert = require('node:assert');
const n = require('../notifier');

const row = (id, extra = {}) => ({
  id, kind: 'question', needs: true, desktop: true, inapp: true, done: false, read: false,
  title: `Row ${id}`, body: 'Body', ticket_id: 'KAN-1', actions: [], count: 1, last_event_id: 1, ...extra,
});

function harness({ focused = false } = {}) {
  const h = { t: 0, timers: [], shown: [], closed: [], focused };
  h.core = new n.NotifierCore({
    now: () => h.t,
    setTimer: (fn, ms) => { const t = { fn, at: h.t + ms }; h.timers.push(t); return t; },
    clearTimer: (t) => { h.timers = h.timers.filter((x) => x !== t); },
    show: (notice) => { const handle = { notice }; h.shown.push(handle); return handle; },
    close: (handle) => h.closed.push(handle),
    context: () => ({ focused: h.focused }),
  });
  h.advance = (ms) => {
    h.t += ms;
    for (const t of [...h.timers]) if (t.at <= h.t) { h.timers = h.timers.filter((x) => x !== t); t.fn(); }
  };
  h.core.applyFeed({ head: 10 }); // first call: only the head
  return h;
}

test('the electron-free module loads without electron', () => {
  assert.strictEqual(typeof n.NotifierCore, 'function');
  assert.strictEqual(typeof n.startNotifier, 'function');
});

test('shouldNotify: needs + desktop, open and unread, not focused, not quiet', () => {
  assert.ok(n.shouldNotify(row('a'), {}));
  assert.ok(!n.shouldNotify(row('a', { desktop: false }), {}));
  assert.ok(!n.shouldNotify(row('a', { done: true }), {}));
  assert.ok(!n.shouldNotify(row('a', { read: true }), {}));
  assert.ok(!n.shouldNotify(row('a'), { focused: true }));
  assert.ok(!n.shouldNotify(row('a'), { quiet: true }));
  // information rows only when their desktop switch is on
  assert.ok(n.shouldNotify(row('i', { needs: false, desktop: true }), {}));
  assert.ok(!n.shouldNotify(row('i', { needs: false, desktop: false }), {}));
});

test('the first feed only sets the cursor and never notifies', () => {
  const h = harness();
  assert.strictEqual(h.core.since(), 10);
  const fresh = harness();
  fresh.core.head = null;
  fresh.core.applyFeed({ head: 20, items: [row('a')] });
  assert.strictEqual(fresh.shown.length, 0);
  assert.strictEqual(fresh.core.since(), 20);
});

test('a new row notifies once; the same event again does not; a merged row whose last event moved does', () => {
  const h = harness();
  h.core.applyFeed({ head: 11, items: [row('a', { last_event_id: 11 })], resolved: [] });
  assert.strictEqual(h.shown.length, 1);
  assert.strictEqual(h.shown[0].notice.title, 'Row a');
  assert.strictEqual(h.core.since(), 11);
  h.advance(30000);
  h.core.applyFeed({ head: 11, items: [row('a', { last_event_id: 11 })] });
  assert.strictEqual(h.shown.length, 1);
  h.core.applyFeed({ head: 13, items: [row('a', { last_event_id: 13, count: 3 })] });
  assert.strictEqual(h.shown.length, 2);
});

test('nothing while the window is focused or in quiet hours', () => {
  const h = harness({ focused: true });
  h.core.applyFeed({ head: 11, items: [row('a', { last_event_id: 11 })] });
  assert.strictEqual(h.shown.length, 0);
  h.focused = false;
  h.core.applyFeed({ head: 12, quiet: true, items: [row('b', { last_event_id: 12 })] });
  assert.strictEqual(h.shown.length, 0);
  // what was held is not replayed when quiet hours end
  h.core.applyFeed({ head: 12, quiet: false, items: [row('b', { last_event_id: 12 })] });
  assert.strictEqual(h.shown.length, 0);
});

test('at most one notice per 20 s; what waits becomes one grouped notice', () => {
  const h = harness();
  h.core.applyFeed({ head: 11, items: [row('a', { last_event_id: 11 })] });
  h.advance(5000);
  h.core.applyFeed({ head: 13, items: [row('b', { last_event_id: 12 }), row('c', { last_event_id: 13 })] });
  assert.strictEqual(h.shown.length, 1);
  h.advance(14999);
  assert.strictEqual(h.shown.length, 1);
  h.advance(1);
  assert.strictEqual(h.shown.length, 2);
  assert.strictEqual(h.shown[1].notice.title, '2 things need you');
  assert.deepStrictEqual(h.shown[1].notice.open.ids, ['b', 'c']);
  assert.strictEqual(h.shown[1].notice.open.group, true);
});

test('a single waiting row is shown with its own title when the window ends', () => {
  const h = harness();
  h.core.applyFeed({ head: 11, items: [row('a', { last_event_id: 11 })] });
  h.core.applyFeed({ head: 12, items: [row('g', { last_event_id: 12, needs: false, title: '8 AI finished work' })] });
  h.advance(20000);
  assert.strictEqual(h.shown.length, 2);
  assert.strictEqual(h.shown[1].notice.title, '8 AI finished work');
});

test('resolved withdraws the notice and drops it from the queue', () => {
  const h = harness();
  h.core.applyFeed({ head: 11, items: [row('a', { last_event_id: 11 })] });
  h.core.applyFeed({ head: 12, items: [row('b', { last_event_id: 12 })] });
  h.core.applyFeed({ head: 13, items: [], resolved: ['a', 'b'] });
  assert.deepStrictEqual(h.closed, [h.shown[0]]);
  h.advance(20000);
  assert.strictEqual(h.shown.length, 1); // b never shown
});

test('a row that comes back done withdraws its notice; a group closes when all its rows are resolved', () => {
  const h = harness();
  h.core.applyFeed({ head: 11, items: [row('a', { last_event_id: 11 })] });
  h.core.applyFeed({ head: 14, items: [row('b', { last_event_id: 12 }), row('c', { last_event_id: 13 })] });
  h.core.applyFeed({ head: 15, items: [row('a', { last_event_id: 15, done: true })] });
  assert.strictEqual(h.closed.length, 1);
  h.advance(20000);
  const group = h.shown[1];
  h.core.applyFeed({ head: 16, resolved: ['b'] });
  assert.strictEqual(h.closed.length, 1);
  h.core.applyFeed({ head: 17, resolved: ['c'] });
  assert.deepStrictEqual(h.closed[1], group);
});

test('cursor_too_old restarts from the head without notifying', () => {
  const h = harness();
  h.core.applyFeed({ head: 500, cursor_too_old: true, items: [row('a', { last_event_id: 400 })] });
  assert.strictEqual(h.shown.length, 0);
  assert.strictEqual(h.core.since(), 500);
});

test('notice text and actions (max 2, no dismiss)', () => {
  const notice = n.noticeFor([row('a', { body: 'Should we?', actions: [
    { id: 'answer', label: 'Answer' }, { id: 'dismiss', label: 'Dismiss' },
    { id: 'open_ticket', label: 'Open ticket' }, { id: 'x', label: 'X' },
  ] })]);
  assert.strictEqual(notice.body, 'KAN-1 · Should we?');
  assert.deepStrictEqual(notice.actions.map((a) => a.id), ['answer', 'open_ticket']);
  assert.strictEqual(n.noticeFor([row('a', { needs: false }), row('b', { needs: false })]).title, '2 updates');
});

test('badge: a number on macOS and Linux, a red dot overlay on Windows', () => {
  assert.deepStrictEqual(n.badgePlan('darwin', 5), { kind: 'count', count: 5 });
  assert.deepStrictEqual(n.badgePlan('linux', undefined), { kind: 'count', count: 0 });
  assert.deepStrictEqual(n.badgePlan('win32', 3), { kind: 'overlay', show: true, description: '3 need you' });
  assert.deepStrictEqual(n.badgePlan('win32', 0), { kind: 'overlay', show: false, description: '' });
  assert.strictEqual(n.redDotBitmap(16).length, 16 * 16 * 4);
});

test('system settings links and the event stream', () => {
  assert.match(n.systemSettingsUrl('darwin'), /^x-apple\.systempreferences:/);
  assert.strictEqual(n.systemSettingsUrl('win32'), 'ms-settings:notifications');
  assert.strictEqual(n.systemSettingsUrl('linux'), null);
  const { events, rest } = n.parseSse(': connected\n\ndata: {"type":"invalidate","topics":["notifications"],"head":3}\n\ndata: {"ty');
  assert.strictEqual(events.length, 1);
  assert.ok(n.touchesNotifications(events[0]));
  assert.ok(!n.touchesNotifications({ type: 'invalidate', topics: ['tickets'] }));
  assert.strictEqual(rest, 'data: {"ty');
  assert.strictEqual(n.backoffMs(0), 1000);
  assert.strictEqual(n.backoffMs(10), 30000);
});
