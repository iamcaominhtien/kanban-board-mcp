// One scenario on one server: browser context, recording of requests / console / snapshots per step.
import { Normalizer } from './normalize.mjs';
import { snapshot } from './snapshot.mjs';
import fs from 'node:fs';
import path from 'node:path';

const STATIC = /\.(?:js|mjs|css|map|woff2?|ttf|ico|png|jpg|jpeg|gif|svg|webp|html)$/i;
const STEP_TIMEOUT_MS = 60_000;

export class Session {
  constructor({ browser, server, scenario, reportDir, apiFallback404 = false }) {
    this.apiFallback404 = apiFallback404;
    this.spaUrls = new Set();
    this.browser = browser;
    this.server = server;
    this.scenario = scenario;
    this.reportDir = reportDir;
    this.norm = new Normalizer(server.port);
    this.steps = [];
    this.cur = null;
    this.pages = [];
    this.pending = 0;
    this.idle = 0;
    this.failed = false;
    this.uploadsRoot = server.dirs.uploads;
  }

  async open() {
    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      acceptDownloads: true,
      permissions: ['clipboard-read', 'clipboard-write'],
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    this.context.setDefaultTimeout(8000);
    if (this.apiFallback404) {
      // The Rust server answers a route it does not serve yet with the UI's index.html (200). The UI crashes on that
      // (it expects JSON). To see what the rest of the screen does, such an answer is turned into a 404 for the page;
      // the exchange is still recorded and marked as `spa` (reported once in diff.md, not per step).
      await this.context.route((u) => u.origin === new URL(this.server.base).origin && !/\/events$|\.(?:js|css|png|svg|woff2?)$/.test(u.pathname), async (route) => {
        const req = route.request();
        if (!['fetch', 'xhr'].includes(req.resourceType()) || /event-stream/.test(req.headers()['accept'] || '')) return route.continue();
        let res;
        try { res = await route.fetch(); } catch { return route.abort(); }
        if ((res.headers()['content-type'] || '').includes('text/html')) {
          this.spaUrls.add(req.url());
          return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'x-e2e-spa-fallback': '1' }, body: '{"detail":"Not Found"}' });
        }
        return route.fulfill({ response: res });
      });
    }
    this.page = await this.newPage();
    return this;
  }

  async newPage() {
    const page = await this.context.newPage();
    page.setDefaultTimeout(8000);
    this.pages.push(page);
    const origin = new URL(this.server.base).origin;
    page.on('request', (req) => {
      if (!req.url().startsWith(origin)) return;
      const p = new URL(req.url()).pathname;
      if (p === '/events' || p.endsWith('/events') || STATIC.test(p)) return;
      req._tracked = true;
      this.pending++;
    });
    const done = (req) => { if (req._tracked) { req._tracked = false; this.pending--; } };
    page.on('requestfinished', done);
    page.on('requestfailed', (req) => {
      done(req);
      const p = new URL(req.url()).pathname;
      if (p.endsWith('/events')) return;
      const err = req.failure()?.errorText || 'failed';
      if (/ERR_ABORTED/.test(err)) return;
      this.cur?.failedRequests.push(`${req.method()} ${this.norm.path(req.url())}: ${err}`);
    });
    page.on('response', async (res) => {
      const req = res.request();
      const url = res.url();
      if (!url.startsWith(origin)) return;
      const p = new URL(url).pathname;
      if (p.endsWith('/events') || STATIC.test(p) || !this.cur) return;
      const cur = this.cur;
      const ex = { method: req.method(), path: this.norm.path(url), status: res.status(), type: (res.headers()['content-type'] || '').split(';')[0] };
      if (res.headers()['x-e2e-spa-fallback']) ex.spa = true;
      const rb = req.postData();
      if (rb && /json/.test(req.headers()['content-type'] || '')) {
        try { ex.request = this.norm.json(JSON.parse(rb)); } catch {}
      }
      cur.exchanges.push(ex);
      if (ex.type === 'application/json') {
        try {
          const txt = await Promise.race([res.text(), new Promise((r) => setTimeout(() => r(null), 5000))]);
          if (txt != null) ex.body = this.norm.json(JSON.parse(txt));
        } catch {}
      }
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      if (/Failed to load resource/.test(t) && /\/events/.test(msg.location()?.url || '')) return;
      if (/Failed to load resource/.test(t) && this.spaUrls.has(msg.location()?.url)) return;
      this.cur?.console.push(this.norm.text(t));
    });
    page.on('pageerror', (e) => this.cur?.pageErrors.push(this.norm.text(String(e.message || e))));
    return page;
  }

  async settle(max = 4000) {
    const t0 = Date.now();
    let quiet = 0;
    while (Date.now() - t0 < max) {
      if (this.pending <= 0) { quiet += 1; if (quiet >= 4) return; } else quiet = 0;
      await new Promise((r) => setTimeout(r, 75));
    }
  }

  async shot(name) {
    const file = path.join(this.reportDir, `${this.scenario.id}-${this.server.target}${name ? '-' + name : ''}.png`);
    try { await this.page.screenshot({ path: file, fullPage: false }); } catch {}
    return path.basename(file);
  }

  // A step: runs fn(ctx), then records what the page did.
  async step(name, fn, opts = {}) {
    if (this.failed) return;
    const rec = { name, exchanges: [], console: [], pageErrors: [], failedRequests: [], snapshot: null, error: null, expectedConsole: !!opts.expectConsole };
    this.cur = rec;
    this.steps.push(rec);
    const t0 = Date.now();
    let timer;
    try {
      await Promise.race([
        fn(this),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`step timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS); }),
      ]);
      await this.settle();
      await this.page.waitForTimeout(150);
      await this.settle();
    } catch (e) {
      rec.error = `[${this.scenario.id} / ${name}] ${String(e.message || e).split('\n').slice(0, 6).join(' | ')}`;
      this.failed = true;
      rec.shot = await this.shot('fail');
      try { rec.aria = (await this.page.locator('body').ariaSnapshot()).slice(0, 7000); } catch {}
    } finally {
      clearTimeout(timer);
    }
    try { rec.snapshot = await snapshot(this.page, this.norm); } catch (e) { rec.snapshot = { error: String(e.message) }; }
    rec.ms = Date.now() - t0;
    this.cur = null;
  }

  async close() {
    try { this.final = await this.shot('final'); } catch {}
    await this.context.close().catch(() => {});
  }

  result() {
    return {
      id: this.scenario.id, name: this.scenario.name, group: this.scenario.group || 'core', target: this.server.target,
      screenshot: this.final, steps: this.steps,
    };
  }
}
