// The desktop notifier (#253, design/screens/notifications.md section J): the main process follows the notification
// log itself and owns the OS notification and the dock/taskbar number, so notices keep coming with the window closed
// (macOS keeps the app running) and two windows never send two. Only this process sends; windows never do.
//
// This module does not require Electron: the pure parts (`shouldNotify`, `NotifierCore`, `badgePlan`, ...) are unit
// tested with plain fakes, and `startNotifier` takes the Electron objects it uses as arguments (main.js passes them).

const http = require('http');

const RATE_MS = 20000; // at most one notice every 20 s
const POLL_MS = 15000; // the feed is polled as a fallback for a dropped /events stream
const MAX_ACTIONS = 2; // macOS shows at most a couple of buttons; Windows/Linux show none through Electron
const TEST_TITLE = 'Kanban Board — Test notification';

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a feed row may become a desktop notice. Needs you rows when the person's desktop switch is on; information
 * rows only when they switched desktop on for that kind (off by default — the server writes it in `row.desktop`).
 * Never a closed or read row, never while the window is focused (a toast is enough), never in quiet hours (what was
 * held is in the panel). Do not disturb / Focus is left to the OS, which already holds notifications then.
 */
function shouldNotify(row, ctx = {}) {
  if (!row || !row.desktop || row.done || row.read || row.gone) return false;
  if (ctx.focused || ctx.quiet) return false;
  return true;
}

/** The text of one notice for a row (or for a group of rows that waited for the 20 s window). */
function noticeFor(rows) {
  if (rows.length === 1) {
    const row = rows[0];
    const where = row.ticket_id && !(row.body || '').includes(row.ticket_id) ? `${row.ticket_id} · ` : '';
    const actions = (row.actions || [])
      .filter((a) => a && a.id && a.label && a.id !== 'dismiss' && a.id !== 'expand')
      .slice(0, MAX_ACTIONS);
    return { title: row.title || 'Kanban Board', body: `${where}${row.body || ''}`.trim(), actions, open: row };
  }
  const needs = rows.filter((r) => r.needs).length;
  const title = needs > 0 ? `${rows.length} things need you` : `${rows.length} updates`;
  const titles = rows.slice(0, 3).map((r) => r.title).filter(Boolean);
  const more = rows.length > 3 ? ` and ${rows.length - 3} more` : '';
  // A grouped notice opens the panel's list rather than one thing: the page gets {group: true, ids, needs}
  return {
    title,
    body: `${titles.join(' · ')}${more}`,
    actions: [],
    open: { group: true, ids: rows.map((r) => r.id), needs: needs > 0, title },
  };
}

/** What to do with the Needs you count on this platform: a number on the dock (macOS) or launcher (Linux, Unity),
 * and on Windows, where the taskbar has no number, a red dot overlay with the count as its description. */
function badgePlan(platform, count) {
  const n = Math.max(0, Number(count) || 0);
  if (platform === 'win32') return { kind: 'overlay', show: n > 0, description: n > 0 ? `${n} need you` : '' };
  return { kind: 'count', count: n };
}

/** A red dot (BGRA bitmap, `size`×`size`) for the Windows taskbar overlay. */
function redDotBitmap(size = 16) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const alpha = Math.max(0, Math.min(1, r - d)); // anti-aliased edge
      const i = (y * size + x) * 4;
      buf[i] = 0x3b; buf[i + 1] = 0x3b; buf[i + 2] = 0xe0; buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

/** The OS page where notifications are allowed, or null where there is none to open (Linux). */
function systemSettingsUrl(platform) {
  if (platform === 'darwin') return 'x-apple.systempreferences:com.apple.preference.notifications';
  if (platform === 'win32') return 'ms-settings:notifications';
  return null;
}

/** Splits a text/event-stream chunk buffer into complete `data:` payloads; returns {events, rest}. */
function parseSse(buffer) {
  const events = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop();
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      events.push(data);
    }
  }
  return { events, rest };
}

/** Whether a board event concerns notifications (and so the feed and the badge should be refetched). */
function touchesNotifications(event) {
  return Boolean(event && typeof event === 'object' && Array.isArray(event.topics) && event.topics.includes('notifications'));
}

/** Reconnect delay for the /events stream: 1 s, 2 s, 4 s ... up to 30 s. */
function backoffMs(attempt) {
  return Math.min(30000, 1000 * 2 ** Math.max(0, attempt));
}

/**
 * The state of the notifier, without I/O: the cursor, which rows were already told, the 20 s rate limit and what
 * waits for it, and which notice stands for which row (to withdraw it).
 *
 * deps: { now(), setTimer(fn, ms) → handle, clearTimer(handle), show(notice) → handle, close(handle), context() →
 * {focused} }. `show` returns whatever the caller needs to close the notice later (an Electron Notification).
 */
const TOLD_MAX = 2000;
const LIVE_MAX = 50;

class NotifierCore {
  constructor(deps) {
    this.deps = deps;
    this.rateMs = deps.rateMs || RATE_MS;
    this.head = null; // the log id followed; null until the first feed (which only gives the head)
    this.quiet = false;
    this.told = new Map(); // rowId -> last_event_id already notified (a merged row is new once its last event moves)
    this.pending = new Map(); // rowId -> row waiting for the rate window
    this.timer = null;
    this.lastShownAt = -Infinity;
    this.shown = new Map(); // rowId -> handle
    this.handleRows = new Map(); // handle -> Set(rowId), a grouped notice stands for several rows
  }

  /** The `since` to ask the feed with; undefined means "only tell me the head". */
  since() {
    return this.head === null ? undefined : this.head;
  }

  /** Takes one feed response. The first one only sets the cursor: old news is never replayed. */
  applyFeed(feed) {
    if (!feed || typeof feed !== 'object') return;
    if (typeof feed.quiet === 'boolean') this.quiet = feed.quiet;
    const head = Number.isFinite(feed.head) ? feed.head : this.head;
    if (this.head === null || feed.cursor_too_old) {
      // first call, or the cursor was pruned: start from now
      this.head = head;
      return;
    }
    if (head !== null && head > this.head) this.head = head;

    for (const id of feed.resolved || []) this.withdraw(id);
    const ctx = { ...this.context(), quiet: this.quiet };
    for (const row of feed.items || []) {
      if (!row || !row.id) continue;
      if (row.done || row.read) {
        this.withdraw(row.id);
        continue;
      }
      const last = row.last_event_id ?? row.event_id ?? null;
      if (this.told.has(row.id) && this.told.get(row.id) === last) continue;
      this.told.delete(row.id);
      this.told.set(row.id, last);
      // what has been told is kept for the newest rows only (insertion order: the oldest go first)
      while (this.told.size > TOLD_MAX) this.told.delete(this.told.keys().next().value);
      if (!shouldNotify(row, ctx)) continue;
      this.enqueue(row);
    }
  }

  context() {
    return (this.deps.context && this.deps.context()) || {};
  }

  enqueue(row) {
    const now = this.deps.now();
    if (this.timer === null && this.pending.size === 0 && now - this.lastShownAt >= this.rateMs) {
      this.present([row], now);
      return;
    }
    this.pending.delete(row.id); // a merged row moves to the end with its newest text
    this.pending.set(row.id, row);
    if (this.timer === null) {
      const wait = Math.max(0, this.lastShownAt + this.rateMs - now);
      this.timer = this.deps.setTimer(() => this.flush(), wait);
    }
  }

  /** The 20 s window ended: what waited becomes one notice (or nothing if it was resolved, focused or quiet). */
  flush() {
    this.timer = null;
    const rows = [...this.pending.values()];
    this.pending.clear();
    const ctx = { ...this.context(), quiet: this.quiet };
    const still = rows.filter((r) => shouldNotify(r, ctx));
    if (still.length) this.present(still, this.deps.now());
  }

  present(rows, now) {
    this.lastShownAt = now;
    const handle = this.deps.show(noticeFor(rows));
    if (handle === undefined || handle === null) return;
    for (const r of rows) {
      const previous = this.shown.get(r.id);
      if (previous !== undefined) this.detach(r.id, previous);
      this.shown.set(r.id, handle);
    }
    this.handleRows.set(handle, new Set(rows.map((r) => r.id)));
  }

  /** A row was resolved or read: withdraw its notice (a grouped one once all its rows are), drop it from the queue. */
  withdraw(rowId) {
    this.pending.delete(rowId);
    const handle = this.shown.get(rowId);
    if (handle === undefined) return;
    this.shown.delete(rowId);
    this.detach(rowId, handle);
  }

  detach(rowId, handle) {
    const ids = this.handleRows.get(handle);
    if (!ids) return;
    ids.delete(rowId);
    if (ids.size === 0) {
      this.handleRows.delete(handle);
      this.deps.close(handle);
    }
  }

  /** The OS removed a notice (clicked, swiped away): forget it. */
  forget(handle) {
    const ids = this.handleRows.get(handle);
    if (!ids) return;
    for (const id of ids) if (this.shown.get(id) === handle) this.shown.delete(id);
    this.handleRows.delete(handle);
  }

  stop() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  /** Another person or another backend: nothing queued for the old one is shown, its notices are withdrawn, and the
   * next feed only gives the head again. */
  reset() {
    this.stop();
    for (const handle of [...this.handleRows.keys()]) this.deps.close(handle);
    this.handleRows.clear();
    this.shown.clear();
    this.told.clear();
    this.head = null;
  }
}

// ── The Electron side ───────────────────────────────────────────────────────────────────────────────────────────

/** GET a JSON document from the backend with the window's headers (X-Actor, X-Kanban-Secret). */
function getJson(port, path, headers, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { Accept: 'application/json', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode} for ${path}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Starts following the log for the backend on `port`. Returns the controller main.js keeps:
 * { setPort(port), setActor(name), status(), test(), refresh(), stop() }.
 *
 * opts: { Notification, app, nativeImage, platform, apiSecret, getWindow() → BrowserWindow|null, onOpen(payload) }.
 */
function startNotifier(opts) {
  const { Notification, app, nativeImage, platform = process.platform, apiSecret = '', getWindow, onOpen } = opts;
  let port = opts.port || null;
  let actor = 'user';
  let stopped = false;
  let stream = null;
  let streamAttempt = 0;
  let reconnectTimer = null;
  let pollTimer = null;
  let fetching = null;
  let again = false;
  let testFailed = false;
  let overlay = null;
  let soundOn = true; // the person's "Play a sound" setting, from the feed
  const live = new Set(); // keeps Notification objects referenced so their click handlers survive GC

  const headers = () => {
    const h = { 'X-Actor': actor };
    if (apiSecret) h['X-Kanban-Secret'] = apiSecret;
    return h;
  };

  const focused = () => {
    const win = getWindow && getWindow();
    return Boolean(win && !win.isDestroyed() && win.isVisible() && win.isFocused());
  };

  function makeNotification({ title, body, actions, open }, { silent = false } = {}) {
    if (!Notification || !Notification.isSupported()) return null;
    const n = new Notification({
      title,
      body,
      silent,
      actions: platform === 'darwin' ? actions.map((a) => ({ type: 'button', text: a.label })) : [],
    });
    live.add(n);
    // Linux often never sends 'close': keep only the newest notices referenced
    while (live.size > LIVE_MAX) live.delete(live.values().next().value);
    const done = () => {
      live.delete(n);
      core.forget(n);
    };
    n.on('click', () => {
      done();
      if (open && onOpen) onOpen(open);
    });
    n.on('action', (_e, index) => {
      done();
      const action = actions[index];
      if (open && onOpen) onOpen(action ? { ...open, action: action.id } : open);
    });
    n.on('close', done);
    n.on('failed', () => { live.delete(n); });
    n.show();
    return n;
  }

  const core = new NotifierCore({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    context: () => ({ focused: focused() }),
    show: (notice) => makeNotification(notice, { silent: !soundOn }),
    close: (n) => {
      live.delete(n);
      try { n.close(); } catch { /* already gone */ }
    },
  });

  function setBadge(count) {
    const plan = badgePlan(platform, count);
    try {
      if (plan.kind === 'count') {
        if (app && app.setBadgeCount) app.setBadgeCount(plan.count);
        return;
      }
      const win = getWindow && getWindow();
      if (!win || win.isDestroyed() || !win.setOverlayIcon) return;
      if (!plan.show) return void win.setOverlayIcon(null, '');
      if (!overlay && nativeImage) overlay = nativeImage.createFromBitmap(redDotBitmap(16), { width: 16, height: 16 });
      win.setOverlayIcon(overlay, plan.description);
    } catch (err) {
      console.error('[notifier] badge:', err.message);
    }
  }

  async function refreshOnce() {
    const since = core.since();
    const feed = await getJson(port, since === undefined ? '/notifications/feed' : `/notifications/feed?since=${since}`, headers());
    if (typeof feed.sound === 'boolean') soundOn = feed.sound;
    // feed.dnd ("follow the system Do not disturb"): nothing to do here — macOS Focus and Windows Do not disturb
    // already hold every notification an app sends, and Electron cannot read either state.
    core.applyFeed(feed);
    const counts = await getJson(port, '/notifications/counts', headers());
    setBadge(counts && counts.needs);
  }

  /** Fetches the feed and the count; calls made while one runs are folded into one more run after it. */
  function refresh() {
    if (stopped || !port) return Promise.resolve();
    if (fetching) {
      again = true;
      return fetching;
    }
    fetching = refreshOnce()
      .catch((err) => console.error('[notifier] feed:', err.message))
      .finally(() => {
        fetching = null;
        if (again) {
          again = false;
          refresh();
        }
      });
    return fetching;
  }

  function connect() {
    if (stopped || !port || stream) return;
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { Accept: 'text/event-stream', ...headers() } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return void scheduleReconnect();
      }
      streamAttempt = 0;
      refresh(); // anything missed while disconnected
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const parsed = parseSse(buffer + chunk);
        buffer = parsed.rest;
        if (parsed.events.some(touchesNotifications)) refresh();
      });
      res.on('end', scheduleReconnect);
      res.on('error', scheduleReconnect);
    });
    req.on('error', scheduleReconnect);
    stream = req;
  }

  function scheduleReconnect() {
    if (stream) {
      try { stream.destroy(); } catch { /* already closed */ }
    }
    stream = null;
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs(streamAttempt++));
  }

  function restartStream() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (stream) {
      const s = stream;
      stream = null;
      try { s.destroy(); } catch { /* closed */ }
    }
    streamAttempt = 0;
    connect();
  }

  function start() {
    if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
    refresh();
    connect();
  }

  if (port) start();

  return {
    /** The backend (re)started on a new port: follow it from its head. */
    setPort(p) {
      port = p;
      core.reset();
      if (!port) return;
      if (!pollTimer) start();
      else {
        refresh();
        restartStream();
      }
    },
    /** The person the page acts as (X-Actor). A different person starts from the head: their old rows are not news. */
    setActor(name) {
      const next = typeof name === 'string' && name.trim() ? name.trim() : 'user';
      if (next === actor) return;
      actor = next;
      core.reset();
      refresh();
    },
    status() {
      const supported = Boolean(Notification && Notification.isSupported());
      // Electron has no way to read the OS permission. On macOS a refused app's notifications are dropped silently
      // (no 'failed' event), so 'granted' means "supported and no test failed"; Windows/Linux report a refused or
      // missing notification server through 'failed', which the test turns into 'denied'.
      return { supported, permission: !supported || testFailed ? 'denied' : 'granted' };
    },
    /** Shows the test notice now, past the 20 s limit and quiet hours. */
    test() {
      return new Promise((resolve) => {
        if (!Notification || !Notification.isSupported()) {
          testFailed = true;
          return resolve({ ok: false, reason: 'Notifications are not supported on this computer.' });
        }
        const n = new Notification({ title: TEST_TITLE, body: 'Notifications from Kanban Board will look like this.' });
        live.add(n);
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          testFailed = !result.ok;
          resolve(result);
        };
        n.on('show', () => finish({ ok: true }));
        n.on('failed', (_e, error) => {
          live.delete(n);
          finish({ ok: false, reason: String(error || 'The system refused the notification.') });
        });
        n.on('close', () => live.delete(n));
        n.on('click', () => {
          live.delete(n);
          if (onOpen) onOpen(null);
        });
        n.show();
        // Some systems never confirm 'show'; no failure within 3 s counts as shown
        setTimeout(() => finish({ ok: true }), 3000);
      });
    },
    refresh,
    stop() {
      stopped = true;
      core.stop();
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (stream) {
        try { stream.destroy(); } catch { /* closed */ }
      }
      stream = null;
    },
  };
}

module.exports = {
  RATE_MS,
  POLL_MS,
  TEST_TITLE,
  shouldNotify,
  noticeFor,
  badgePlan,
  redDotBitmap,
  systemSettingsUrl,
  parseSse,
  touchesNotifications,
  backoffMs,
  NotifierCore,
  startNotifier,
};
