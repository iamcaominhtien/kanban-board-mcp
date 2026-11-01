const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { startNotifier } = require("../notifier");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out");
}

const row = (extra = {}) => ({
  id: "r1",
  kind: "question",
  needs: true,
  desktop: true,
  done: false,
  read: false,
  title: "Approve?",
  body: "Please",
  ticket_id: "KAN-1",
  actions: [
    { id: "approve", label: "Approve" },
    { id: "dismiss", label: "Dismiss" },
  ],
  last_event_id: 11,
  ...extra,
});

/** A local backend: feed, counts and an SSE /events stream, all steerable from the test. */
async function backend() {
  const b = {
    requests: [],
    sse: [],
    needs: 3,
    items: [],
    resolved: [],
    feedStatus: 200,
    eventsStatus: 200,
    feedBody: null,
    sound: true,
  };
  b.server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    b.requests.push({
      path: url.pathname,
      since: url.searchParams.get("since"),
      headers: req.headers,
    });
    if (url.pathname === "/events") {
      if (b.eventsStatus !== 200) {
        res.writeHead(b.eventsStatus);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": hello\n\n");
      b.sse.push(res);
      return undefined;
    }
    if (url.pathname === "/notifications/counts") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ needs: b.needs }));
    }
    if (b.feedStatus !== 200) {
      res.writeHead(b.feedStatus);
      return res.end("no");
    }
    if (b.feedBody !== null) {
      res.writeHead(200);
      return res.end(b.feedBody);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    const first = url.searchParams.get("since") === null;
    return res.end(
      JSON.stringify(
        first
          ? { head: 10, sound: b.sound }
          : { head: 11, items: b.items, resolved: b.resolved, sound: b.sound },
      ),
    );
  });
  await new Promise((r) => b.server.listen(0, "127.0.0.1", r));
  b.port = b.server.address().port;
  b.count = (p) => b.requests.filter((r) => r.path === p).length;
  b.invalidate = () => {
    for (const c of b.sse)
      c.write(
        'data: {"type":"invalidate","topics":["notifications"],"head":11}\n\n',
      );
  };
  b.close = () =>
    new Promise((r) => {
      for (const c of b.sse) c.destroy();
      b.server.closeAllConnections();
      b.server.close(r);
    });
  return b;
}

function fakeNotification({ supported = true } = {}) {
  class N {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.shown = false;
      this.closed = false;
      N.all.push(this);
    }
    static isSupported() {
      return supported;
    }
    on(ev, fn) {
      this.handlers[ev] = fn;
    }
    emit(ev, ...args) {
      if (this.handlers[ev]) this.handlers[ev](...args);
    }
    show() {
      this.shown = true;
    }
    close() {
      this.closed = true;
    }
  }
  N.all = [];
  return N;
}

function fakeWindow({ focused = false, destroyed = false } = {}) {
  const w = { overlays: [], destroyed, focused };
  w.isDestroyed = () => w.destroyed;
  w.isVisible = () => true;
  w.isFocused = () => w.focused;
  w.setOverlayIcon = (img, d) => w.overlays.push([img, d]);
  return w;
}

async function setup(
  t,
  {
    platform = "darwin",
    notification,
    win = fakeWindow(),
    port,
    apiSecret = "s3cret",
    start = true,
  } = {},
) {
  const b = await backend();
  const Notification = notification || fakeNotification();
  const badges = [];
  const opened = [];
  const nativeImage = { createFromBitmap: (buf, o) => ({ buf, o }) };
  const h = { b, Notification, badges, opened, win, nativeImage };
  const opts = {
    Notification,
    app: { setBadgeCount: (n) => badges.push(n) },
    nativeImage,
    platform,
    apiSecret,
    getWindow: () => win,
    onOpen: (p) => opened.push(p),
    port: port === undefined ? b.port : port,
  };
  h.opts = opts;
  if (start) h.n = startNotifier(opts);
  t.after(async () => {
    if (h.n) h.n.stop();
    await b.close();
  });
  return h;
}

// Move a started notifier past the first feed (head only) and the stream connection
async function ready(h) {
  await waitFor(
    () =>
      h.b.count("/notifications/feed") >= 1 &&
      h.b.sse.length >= 1 &&
      h.b.count("/notifications/counts") >= 1,
  );
  await sleep(100); // the stream's own catch-up refresh and the badge settle
}

test("darwin: first feed never notifies, SSE triggers a fetch and a notice with buttons; headers and badge", async (t) => {
  const h = await setup(t);
  await ready(h);
  assert.strictEqual(
    h.b.requests.find((r) => r.path === "/notifications/feed").since,
    null,
  );
  assert.strictEqual(h.Notification.all.length, 0);
  assert.ok(h.badges.length >= 1 && h.badges.every((x) => x === 3));
  const first = h.b.requests[0].headers;
  assert.strictEqual(first["x-actor"], "user");
  assert.strictEqual(first["x-kanban-secret"], "s3cret");

  h.b.items = [row()];
  h.b.invalidate();
  await waitFor(() => h.Notification.all.length === 1);
  const feeds = h.b.requests.filter((r) => r.path === "/notifications/feed");
  assert.ok(feeds[feeds.length - 1].since !== null);
  const nt = h.Notification.all[0];
  assert.strictEqual(nt.shown, true);
  assert.strictEqual(nt.opts.silent, false);
  assert.deepStrictEqual(nt.opts.actions, [
    { type: "button", text: "Approve" },
  ]);

  nt.emit("click");
  assert.strictEqual(h.opened.length, 1);
  assert.strictEqual(h.opened[0].id, "r1");
});

test("darwin: action button opens with the action; unknown index opens plain; close and failed are tolerated", async (t) => {
  const h = await setup(t);
  await ready(h);
  h.b.items = [row()];
  h.b.invalidate();
  await waitFor(() => h.Notification.all.length === 1);
  const nt = h.Notification.all[0];
  nt.emit("action", {}, 0);
  assert.strictEqual(h.opened[0].action, "approve");
  nt.emit("action", {}, 9);
  assert.strictEqual(h.opened[1].action, undefined);
  nt.emit("close");
  nt.emit("failed");
});

test("win32: no buttons, taskbar overlay follows the count; linux: no buttons", async (t) => {
  const h = await setup(t, { platform: "win32" });
  await ready(h);
  const last = () => h.win.overlays[h.win.overlays.length - 1];
  assert.strictEqual(last()[1], "3 need you");
  assert.deepStrictEqual(last()[0].o, { width: 16, height: 16 });
  h.b.needs = 0;
  await h.n.refresh();
  assert.deepStrictEqual(last(), [null, ""]);
  h.b.needs = 2;
  await h.n.refresh();
  assert.strictEqual(last()[1], "2 need you");
  h.win.destroyed = true;
  const n = h.win.overlays.length;
  await h.n.refresh();
  assert.strictEqual(h.win.overlays.length, n);
  h.win.destroyed = false;
  h.b.items = [row()];
  h.b.invalidate();
  await waitFor(() => h.Notification.all.length === 1);
  assert.deepStrictEqual(h.Notification.all[0].opts.actions, []);

  const l = await setup(t, { platform: "linux" });
  await ready(l);
  assert.ok(l.badges.every((x) => x === 3));
  l.b.items = [row()];
  l.b.invalidate();
  await waitFor(() => l.Notification.all.length === 1);
  assert.deepStrictEqual(l.Notification.all[0].opts.actions, []);
});

test("a resolved row closes its notice; a focused window and a quiet sound flag are honoured", async (t) => {
  const h = await setup(t);
  h.b.sound = false;
  await ready(h);
  h.b.items = [row()];
  h.b.invalidate();
  await waitFor(() => h.Notification.all.length === 1);
  assert.strictEqual(h.Notification.all[0].opts.silent, true);
  h.b.items = [];
  h.b.resolved = ["r1"];
  h.b.invalidate();
  await waitFor(() => h.Notification.all[0].closed);

  const f = await setup(t, { win: fakeWindow({ focused: true }) });
  await ready(f);
  f.b.items = [row()];
  f.b.invalidate();
  await waitFor(() => f.b.count("/notifications/feed") >= 2);
  await sleep(50);
  assert.strictEqual(f.Notification.all.length, 0);
});

test("setActor sends the new actor and asks from the head again; same or blank names are handled", async (t) => {
  const h = await setup(t);
  await ready(h);
  h.n.setActor("user"); // unchanged: nothing
  h.n.setActor("  ");
  await sleep(50);
  const base = h.b.count("/notifications/feed");
  h.n.setActor(" alice ");
  await waitFor(() => h.b.count("/notifications/feed") > base);
  const feeds = h.b.requests.filter((r) => r.path === "/notifications/feed");
  assert.strictEqual(feeds[base].since, null);
  assert.strictEqual(feeds[base].headers["x-actor"], "alice");
  h.n.setActor(42); // not a string: back to user
  await waitFor(() => h.b.count("/notifications/feed") > base + 1);
  assert.strictEqual(
    h.b.requests.filter((r) => r.path === "/notifications/feed")[base + 1]
      .headers["x-actor"],
    "user",
  );
});

test("no secret header without a secret; setPort starts a notifier created without a port and follows a new server", async (t) => {
  const h = await setup(t, { port: null, apiSecret: "" });
  assert.strictEqual(h.b.requests.length, 0);
  assert.strictEqual(await h.n.refresh(), undefined);
  h.n.setPort(null);
  h.n.setPort(h.b.port);
  await ready(h);
  assert.strictEqual(h.b.requests[0].headers["x-kanban-secret"], undefined);

  const b2 = await backend();
  t.after(() => b2.close());
  h.n.setPort(b2.port);
  await waitFor(
    () => b2.count("/notifications/feed") >= 1 && b2.sse.length >= 1,
  );
  assert.strictEqual(
    b2.requests.find((r) => r.path === "/notifications/feed").since,
    null,
  );
  b2.items = [row()];
  b2.invalidate();
  await waitFor(() => h.Notification.all.length === 1);
});

test("the stream reconnects after the server closes it and after a bad status", async (t) => {
  const h = await setup(t);
  h.b.eventsStatus = 503;
  await waitFor(() => h.b.count("/events") >= 1);
  h.b.eventsStatus = 200;
  await waitFor(() => h.b.sse.length === 1, 4000); // retry after the 1 s backoff
  for (const c of h.b.sse.splice(0)) c.end();
  const before = h.b.count("/events");
  await waitFor(
    () => h.b.count("/events") > before && h.b.sse.length === 1,
    4000,
  );
  assert.strictEqual(h.b.sse.length, 1);
});

test("feed errors (HTTP status, bad JSON) are logged and do not stop the notifier", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...a) => logged.push(a.join(" ")));
  const h = await setup(t);
  h.b.feedStatus = 500;
  await h.n.refresh();
  h.b.feedStatus = 200;
  h.b.feedBody = "not json";
  await h.n.refresh();
  assert.ok(logged.some((l) => l.includes("HTTP 500")));
  assert.ok(logged.length >= 2);
  const dead = await setup(t, { port: 1 }); // nothing listens: connection refused
  await dead.n.refresh();
  assert.ok(logged.length >= 3);
});

test("refresh calls made while one runs are folded into one more run", async (t) => {
  const h = await setup(t, { start: false });
  h.n = startNotifier({ ...h.opts, port: h.b.port });
  const p1 = h.n.refresh();
  const p2 = h.n.refresh();
  assert.strictEqual(p1, p2);
  await p1;
  await waitFor(() => h.b.count("/notifications/counts") >= 2);
});

test("badge and notices are skipped without Notification or app/window support", async (t) => {
  const h = await setup(t, { start: false });
  h.n = startNotifier({
    ...h.opts,
    Notification: null,
    app: null,
    getWindow: null,
  });
  await ready(h);
  h.b.items = [row()];
  h.b.invalidate();
  await waitFor(() => h.b.count("/notifications/feed") >= 2);
  assert.deepStrictEqual(h.badges, []);
  assert.deepStrictEqual(h.n.status(), {
    supported: false,
    permission: "denied",
  });
  const r = await h.n.test();
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not supported/);
});

test("status and test: ok on show, failed turns permission to denied, click opens null", async (t) => {
  const h = await setup(t, { start: false });
  h.n = startNotifier({ ...h.opts, port: null });
  assert.deepStrictEqual(h.n.status(), {
    supported: true,
    permission: "granted",
  });
  const ok = h.n.test();
  h.Notification.all[0].emit("show");
  h.Notification.all[0].emit("show"); // settles once
  assert.deepStrictEqual(await ok, { ok: true });
  h.Notification.all[0].emit("click");
  assert.deepStrictEqual(h.opened, [null]);
  h.Notification.all[0].emit("close");

  const bad = h.n.test();
  h.Notification.all[1].emit("failed", {}, "refused");
  assert.deepStrictEqual(await bad, { ok: false, reason: "refused" });
  assert.deepStrictEqual(h.n.status(), {
    supported: true,
    permission: "denied",
  });
  const bad2 = h.n.test();
  h.Notification.all[2].emit("failed");
  assert.match((await bad2).reason, /refused/);
});

test("test counts as shown when the system never confirms (3 s)", async (t) => {
  const h = await setup(t, { start: false });
  h.n = startNotifier({ ...h.opts, port: null });
  assert.deepStrictEqual(await h.n.test(), { ok: true });
});

test("stop ends timers and the stream and later refreshes do nothing", async (t) => {
  const h = await setup(t);
  await ready(h);
  h.n.stop();
  const count = h.b.requests.length;
  await h.n.refresh();
  await sleep(1200);
  assert.strictEqual(h.b.requests.length, count);
});

test("setPort(null) when the backend exits: no request reaches the old port, the badge clears, a new port resumes", async (t) => {
  const h = await setup(t);
  await ready(h);
  h.n.setPort(null);
  assert.strictEqual(h.badges.at(-1), 0);
  const count = h.b.requests.length;
  await h.n.refresh();
  await sleep(1200); // past the stream's 1 s reconnect backoff
  assert.strictEqual(h.b.requests.length, count);
  h.n.setPort(h.b.port);
  await waitFor(() => h.b.requests.length > count && h.b.sse.length >= 2);
  assert.ok(h.b.count("/notifications/feed") >= 2);
});
