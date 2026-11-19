// Recording for the coverage measure (E2E_MEASURE=1): what each step touched on the page, what it showed, and the
// V8 coverage of the UI's scripts. report.mjs turns the files written here into the coverage report.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { mergeScriptCovs } = createRequire(import.meta.url)('@bcoe/v8-coverage');

/** True when the run should record (E2E_MEASURE=1). */
export const measuring = () => process.env.E2E_MEASURE === '1';

// Runs in the page: reports each click, change and shortcut with the labels of the control it reached.
const PAGE_SCRIPT = `(() => {
  if (window.__e2eMeasure) return; window.__e2eMeasure = true;
  const CONTROL = 'button,a,input,select,textarea,summary,label,[role=button],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=checkbox],[role=switch],[role=radio],[role=combobox],[role=slider],[role=treeitem],[contenteditable=true],[tabindex]';
  const labels = (el) => {
    const out = [];
    const stop = el && el.closest ? el.closest(CONTROL) : null;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      for (const a of ['aria-label', 'placeholder', 'title']) { const v = n.getAttribute(a); if (v) out.push(v); }
      const by = n.getAttribute('aria-labelledby');
      if (by) for (const id of by.split(/\\s+/)) { const t = document.getElementById(id); if (t) out.push(t.textContent.trim()); }
      if (n === stop) break;
    }
    if (stop) { const t = (stop.innerText || stop.value || '').trim().replace(/\\s+/g, ' '); if (t && t.length <= 80) out.push(t); }
    return { labels: [...new Set(out)], role: stop ? (stop.getAttribute('role') || stop.tagName.toLowerCase()) : null };
  };
  const send = (kind, el, extra) => { try { window.__e2eRec({ kind, ...labels(el), ...extra }); } catch {} };
  addEventListener('click', (e) => send('click', e.target), true);
  addEventListener('change', (e) => {
    // choosing an option of a <select> (selectOption) acts on that option too
    const t = e.target;
    const opts = t && t.tagName === 'SELECT' ? [...t.selectedOptions].map((o) => o.textContent.trim()).filter(Boolean) : [];
    const rec = labels(t);
    try { window.__e2eRec({ kind: 'change', role: rec.role, labels: [...new Set([...rec.labels, ...opts])] }); } catch {}
  }, true);
  let last = null;
  addEventListener('input', (e) => { if (e.target !== last) { last = e.target; send('input', e.target); } }, true);
  addEventListener('keydown', (e) => {
    const editing = e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (editing && !mod && e.key !== 'Escape' && e.key !== 'Enter') return;
    const k = (e.ctrlKey ? 'Ctrl+' : '') + (e.metaKey ? 'Meta+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey && e.key.length > 1 ? 'Shift+' : '') + e.key;
    send('key', e.target, { key: k });
  }, true);
})()`;

/** Labels on a page: every aria-label and placeholder, and the text of the buttons, links, tabs and menu items. */
const SEEN_SCRIPT = `[
  ...[...document.querySelectorAll('[aria-label],[placeholder]')].flatMap((n) => [n.getAttribute('aria-label'), n.getAttribute('placeholder')]),
  ...[...document.querySelectorAll('button,a,summary,option,[role=tab],[role=menuitem],[role=button]')].map((n) => (n.innerText || n.textContent || '').trim().replace(/\\s+/g, ' ')).filter((t) => t.length <= 60),
].filter(Boolean)`;

/** Collects one scenario's recording; one per Session. */
export class Recorder {
  constructor(session) {
    this.s = session;
    this.acts = [];
    this.seen = new Set();
    this.v8 = new Map(); // script path → merged V8 script coverage
    this.covering = new Set();
  }

  /** Installs the page script and the binding it reports to on the browser context. */
  async attachContext(context) {
    await context.exposeBinding('__e2eRec', (_src, rec) => { this.acts.push({ step: this.s.cur?.name || null, ...rec }); });
    await context.addInitScript(PAGE_SCRIPT);
    // pages the app opens itself (a popped-out window) are measured from when they show up
    context.on('page', (p) => { this.startCoverage(p).catch(() => {}); });
  }

  /**
   * Starts JS coverage on a page (before it loads anything when called from Session.newPage).
   * Chromium drops the counts of a document when the page navigates away from it, so goto, reload and close first
   * take what was counted so far (flush) and start again.
   */
  async startCoverage(page) {
    if (this.covering.has(page)) return;
    this.covering.add(page);
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    for (const name of ['goto', 'reload', 'goBack', 'goForward']) {
      const orig = page[name].bind(page);
      page[name] = async (...a) => { await this.flush(page, true); return orig(...a); };
    }
    const close = page.close.bind(page);
    page.close = async (...a) => { await this.flush(page, false); this.covering.delete(page); return close(...a); };
    page.once('close', () => this.covering.delete(page));
  }

  /** Adds what a page counted so far to the merged coverage; `restart` starts counting again. */
  async flush(page, restart) {
    if (!this.covering.has(page)) return;
    const origin = new URL(this.s.server.base).origin;
    let entries = [];
    try { entries = await page.coverage.stopJSCoverage(); } catch {}
    for (const e of entries) {
      if (!e.url.startsWith(origin)) continue;
      const u = new URL(e.url).pathname;
      if (!/\.js$/.test(u)) continue;
      const cov = { scriptId: '0', url: u, functions: e.functions };
      const prev = this.v8.get(u);
      this.v8.set(u, prev ? mergeScriptCovs([prev, cov]) : mergeScriptCovs([cov]));
    }
    if (restart) { try { await page.coverage.startJSCoverage({ resetOnNavigation: false }); } catch {} }
  }

  /** Records what the open pages show at the end of a step. */
  async afterStep() {
    for (const p of this.s.context.pages()) {
      try { for (const l of await p.evaluate(SEEN_SCRIPT)) this.seen.add(l); } catch {}
    }
  }

  /** Stops coverage on every open page and writes the scenario's files to <reportDir>/measure. */
  async finish() {
    for (const p of [...this.covering]) await this.flush(p, false);
    const dir = path.join(this.s.reportDir, 'measure');
    fs.mkdirSync(dir, { recursive: true });
    const base = `${this.s.scenario.id}-${this.s.server.target}`;
    fs.writeFileSync(path.join(dir, `${base}.acts.json`), JSON.stringify({ acts: this.acts, seen: [...this.seen] }));
    fs.writeFileSync(path.join(dir, `${base}.v8.json`), JSON.stringify([...this.v8.values()].map((c) => ({ path: c.url, functions: c.functions }))));
  }
}
