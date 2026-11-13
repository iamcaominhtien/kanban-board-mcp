#!/usr/bin/env node
// Stress check: several AI agents call the MCP server at once while a person works in the app, the measurement of
// release 4.0.2 (PR #343) made repeatable.
//
//   node stress.mjs [--target rust|python] [--db sqlite|postgres|mysql] [--agents 10] [--seconds 60]
//                   [--phases paced,flat] [--no-browser] [--json out.json]
//
// The board: one project with 81 tickets and 445 Docs pages (a few long ones), made through MCP so both servers get
// the same data. Then, for each phase, every agent loops over a mix of MCP calls (read tickets and pages, search, list,
// comment on one shared ticket, change tickets, edit pages):
//   paced  each agent calls at most once a second (10 agents: 10 calls/s asked);
//   flat   each agent calls again as soon as it has its answer.
// Meanwhile a browser has the shared ticket open: it types a comment, sends it and waits until it is shown, every few
// seconds. At the end every comment the agents and the browser were told was saved is looked for on the ticket.
//
// postgres / mysql: a fresh database for the run, on the server of KANBAN_TEST_POSTGRES_URL / KANBAN_TEST_MYSQL_URL
// (server/scripts/dev-databases.sh start). python: the Python server of 4.0.x, as for run.mjs (E2E_PYTHON_SERVER).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { startServer, stopAll } from './lib/servers.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  const g = (process.env.NODE_PATH || '').split(path.delimiter).concat(['/usr/lib/node_modules', '/usr/local/lib/node_modules']);
  for (const d of g) { try { ({ chromium } = require(path.join(d, 'playwright'))); break; } catch {} }
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const target = opt('target', 'rust');
const db = opt('db', 'sqlite');
const AGENTS = Number(opt('agents', '10'));
const SECONDS = Number(opt('seconds', '60'));
const PHASES = opt('phases', 'paced,flat').split(',');
const BROWSER = !args.includes('--no-browser');
const JSON_OUT = opt('json', '');
const TICKETS = 81;
const PAGES = 445;
if (!['rust', 'python'].includes(target)) throw new Error('--target must be rust or python');
if (!['sqlite', 'postgres', 'mysql'].includes(db)) throw new Error('--db must be sqlite, postgres or mysql');
if (BROWSER && !chromium) throw new Error('playwright is not resolvable (or pass --no-browser)');

// ---- deterministic text ----------------------------------------------------------------------------------------
let seed = 42;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pickOf = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ('board ticket page agent review deploy build cache index query latency schema migration release branch merge ' +
  'commit test fixture parser token stream session lock queue worker scheduler budget report summary design layout ' +
  'button modal panel sidebar search filter column status priority owner sprint estimate wave docs heading anchor link ' +
  'comment mention thread reply version diff history restore archive export import upload attachment image diagram').split(' ');
const words = (n) => Array.from({ length: n }, () => pickOf(WORDS)).join(' ');
const sentence = () => { const s = words(8 + Math.floor(rnd() * 12)); return s[0].toUpperCase() + s.slice(1) + '.'; };
const paragraph = () => Array.from({ length: 3 + Math.floor(rnd() * 4) }, sentence).join(' ');

function pageMarkdown(i, bytes) {
  const out = [`Page ${i} describes the ${words(3)}.`, ''];
  let section = 0;
  while (out.join('\n').length < bytes) {
    section++;
    out.push(`## ${section}. ${words(3)}`, '', paragraph(), '');
    const kind = section % 4;
    if (kind === 1) out.push(...Array.from({ length: 4 }, () => `- ${sentence()}`), '');
    if (kind === 2) out.push('```rust', `fn step_${section}(input: &str) -> usize {`, `    input.split_whitespace().count() // ${words(4)}`, '}', '```', '');
    if (kind === 3) out.push('| name | value | note |', '|---|---|---|', ...Array.from({ length: 4 }, (_, k) => `| ${pickOf(WORDS)} | ${k * section} | ${words(3)} |`), '');
    out.push(paragraph(), '');
  }
  return out.join('\n');
}

// ---- MCP over HTTP -----------------------------------------------------------------------------------------------
let rpcId = 0;
async function mcp(base, name, args) {
  const r = await fetch(base + '/mcp/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  if (r.status !== 200) return { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
  const line = text.split(/\r?\n/).find((l) => l.startsWith('data: '));
  const msg = JSON.parse(line ? line.slice(6) : text);
  if (msg.error) return { ok: false, error: JSON.stringify(msg.error).slice(0, 200) };
  const body = msg.result?.content?.[0]?.text ?? '';
  let data = body;
  try { data = JSON.parse(body); } catch {}
  if (msg.result?.isError) return { ok: false, error: String(body).slice(0, 200) };
  return { ok: true, data };
}
async function must(base, name, args) {
  const r = await mcp(base, name, args);
  if (!r.ok) throw new Error(`${name} ${JSON.stringify(args).slice(0, 120)}: ${r.error}`);
  return r.data;
}

// ---- the database of the run -------------------------------------------------------------------------------------
function freshDatabase() {
  if (db === 'sqlite') return { env: {}, drop() {} };
  const admin = db === 'postgres' ? process.env.KANBAN_TEST_POSTGRES_URL : process.env.KANBAN_TEST_MYSQL_URL;
  if (!admin) throw new Error(`--db ${db} needs ${db === 'postgres' ? 'KANBAN_TEST_POSTGRES_URL' : 'KANBAN_TEST_MYSQL_URL'}`);
  const u = new URL(admin);
  const name = `kanban_stress_${Date.now()}`;
  const sql = (q) => {
    if (db === 'postgres') {
      execFileSync('psql', ['-h', u.hostname, '-p', u.port, '-U', decodeURIComponent(u.username), '-d', 'postgres', '-qc', q], { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) } });
    } else {
      execFileSync('mysql', ['-h', u.hostname, '-P', u.port, '-u', decodeURIComponent(u.username), `-p${decodeURIComponent(u.password)}`, '-e', q]);
    }
  };
  sql(`CREATE DATABASE ${name}`);
  const url = new URL(admin);
  url.pathname = '/' + name;
  return { env: { KANBAN_DATABASE_URL: url.toString() }, drop() { try { sql(`DROP DATABASE ${name}`); } catch {} } };
}

// ---- the server's processes: CPU and memory ------------------------------------------------------------------------
function groupStats(leader) {
  let ticks = 0, rss = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); } catch { continue; }
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(f[2]) !== leader) continue; // the process group the server leads (its runner and helpers too)
    ticks += Number(f[11]) + Number(f[12]);
    rss += Number(f[21]) * 4096;
  }
  return { ticks, rss };
}
function sampler(leader) {
  const samples = [];
  let last = { ...groupStats(leader), at: performance.now() };
  const timer = setInterval(() => {
    const now = { ...groupStats(leader), at: performance.now() };
    samples.push({ cpu: ((now.ticks - last.ticks) / 100) / ((now.at - last.at) / 1000) * 100, rss: now.rss });
    last = now;
  }, 1000);
  return { stop() { clearInterval(timer); return samples; } };
}

// ---- numbers -----------------------------------------------------------------------------------------------------
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ms = (v) => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const sleep = (t) => new Promise((r) => setTimeout(r, t));

// ---- the run -----------------------------------------------------------------------------------------------------
const database = freshDatabase();
const startedAt = performance.now();
const server = await startServer(target, { env: database.env });
const startup = performance.now() - startedAt;
const base = server.base;
console.log(`${target} on ${db}: READY after ${ms(startup)} at ${base}`);
const result = { target, db, agents: AGENTS, seconds: SECONDS, startup_ms: Math.round(startup), phases: {} };
let browser;
try {
  // the board
  const t0 = performance.now();
  const project = await must(base, 'manage_project', { action: 'create', name: 'Stress', prefix: 'STR' });
  const pid = project.id;
  const tickets = [];
  for (let i = 1; i <= TICKETS; i++) {
    const t = await must(base, 'manage_ticket', {
      action: 'create', project_id: pid, title: i === 1 ? 'Shared ticket' : `Ticket ${i}: ${words(4)}`,
      description: Array.from({ length: 2 + (i % 4) }, paragraph).join('\n\n'), type: pickOf(['task', 'bug', 'feature', 'chore']),
      priority: pickOf(['low', 'medium', 'high']), tags: [pickOf(WORDS), pickOf(WORDS)],
    });
    tickets.push(t.id);
  }
  const shared = tickets[0];
  const pages = [];
  for (let i = 1; i <= PAGES; i++) {
    const r = rnd();
    const bytes = r < 0.05 ? 40_000 + Math.floor(rnd() * 40_000) : r < 0.2 ? 8_000 + Math.floor(rnd() * 12_000) : 1_000 + Math.floor(rnd() * 3_000);
    const parent = i > 40 ? pages[Math.floor(rnd() * 40)].id : undefined;
    const p = await must(base, 'docs_write', { action: 'create', project_id: pid, title: `Page ${i} ${words(2)}`, markdown: pageMarkdown(i, bytes), ...(parent ? { parent_id: parent } : {}) });
    pages.push({ id: p.id ?? p.page?.id, bytes });
  }
  const longPages = pages.filter((p) => p.bytes >= 40_000).map((p) => p.id);
  result.seed_s = Number(((performance.now() - t0) / 1000).toFixed(1));
  console.log(`board made in ${result.seed_s} s: ${TICKETS} tickets, ${PAGES} pages (${longPages.length} long)`);

  // the calls an agent makes (weight, label, arguments)
  const kept = new Set();
  const OPS = [
    [14, 'read the shared ticket', () => ['get_ticket', { ticket_id: shared }]],
    [10, 'read a ticket', () => ['get_ticket', { ticket_id: pickOf(tickets) }]],
    [8, 'list tickets', () => ['list_tickets', { project_id: pid }]],
    [12, 'read a page', () => ['docs_read', { action: 'get', page_id: pickOf(pages).id }]],
    [4, 'read a long page', () => ['docs_read', { action: 'get', page_id: pickOf(longPages) }]],
    [10, 'search the docs', () => ['docs_read', { action: 'search', project_id: pid, query: words(2) }]],
    [4, 'list the pages', () => ['docs_read', { action: 'list', project_id: pid }]],
    [16, 'comment on the shared ticket', (n, k) => ['ticket_items', { ticket_id: shared, item: 'comment', action: 'add', author: `Agent ${n}`, text: `agent-${n}-${k} ${words(8)}` }]],
    [6, 'comment on a ticket', (n, k) => ['ticket_items', { ticket_id: pickOf(tickets.slice(1)), item: 'comment', action: 'add', author: `Agent ${n}`, text: `note ${n}-${k} ${words(8)}` }]],
    [10, 'change a ticket', () => ['manage_ticket', { action: 'update', ticket_id: pickOf(tickets.slice(1)), priority: pickOf(['low', 'medium', 'high', 'critical']) }]],
    [6, 'edit a page', (n, k) => ['docs_write', { action: 'edit', page_id: pickOf(pages).id, mode: 'append', markdown: `\n\nAdded by agent ${n} (${k}): ${sentence()}` }]],
  ];
  const total = OPS.reduce((s, o) => s + o[0], 0);
  const pick = () => { let r = rnd() * total; for (const o of OPS) { if ((r -= o[0]) < 0) return o; } return OPS[0]; };

  // a person on the shared ticket
  let page;
  if (BROWSER) {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base);
    const card = page.getByRole('button', { name: /STR-1 / }).first();
    await card.waitFor({ timeout: 60_000 });
    await card.click();
    await page.getByRole('dialog', { name: 'Ticket STR-1' }).waitFor({ timeout: 30_000 });
    await page.evaluate(() => {
      window.__keys = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (/^key|^input|^beforeinput/.test(e.name)) window.__keys.push(e.duration); })
        .observe({ type: 'event', durationThreshold: 16, buffered: true });
    });
  }
  async function person(until, out) {
    const dlg = page.getByRole('dialog', { name: 'Ticket STR-1' });
    let k = 0;
    while (performance.now() < until) {
      k++;
      const marker = `browser-${out.phase}-${k}`;
      const box = page.getByPlaceholder('Add a comment…');
      if (!(await box.isVisible().catch(() => false))) await dlg.getByRole('button', { name: 'Add a comment…' }).click();
      await box.click();
      const typedAt = performance.now();
      await page.keyboard.type(`${marker} ${words(6)}`, { delay: 30 });
      out.typing_ms.push(performance.now() - typedAt);
      const sent = performance.now();
      await page.keyboard.press('Control+Enter');
      try {
        await dlg.getByText(marker).first().waitFor({ timeout: 60_000 });
        out.shown_ms.push(performance.now() - sent);
        kept.add(marker);
      } catch { out.not_shown++; }
      await sleep(3000);
    }
  }

  for (const phase of PHASES) {
    const paced = phase === 'paced';
    const calls = [];
    const pageOut = { phase, shown_ms: [], typing_ms: [], not_shown: 0 };
    if (BROWSER) await page.evaluate(() => { window.__keys = []; });
    const cpu = sampler(server.child.pid);
    const start = performance.now();
    const until = start + SECONDS * 1000;
    const agents = Array.from({ length: AGENTS }, async (_, i) => {
      const n = i + 1;
      let next = performance.now() + (paced ? (1000 * i) / AGENTS : 0);
      for (let k = 1; ; k++) {
        if (paced) { const wait = next - performance.now(); if (wait > 0) await sleep(wait); next += 1000; }
        if (performance.now() >= until) break;
        const [, label, make] = pick();
        const [name, a] = make(n, k);
        const t = performance.now();
        let r;
        try { r = await mcp(base, name, a); } catch (e) { r = { ok: false, error: String(e) }; }
        calls.push({ label, ms: performance.now() - t, ok: r.ok, error: r.error });
        if (r.ok && label === 'comment on the shared ticket') kept.add(a.text.split(' ')[0]);
      }
    });
    await Promise.all([...agents, BROWSER ? person(until, pageOut) : null]);
    const wall = (performance.now() - start) / 1000;
    const samples = cpu.stop();
    const lat = calls.map((c) => c.ms);
    const byOp = {};
    for (const c of calls) (byOp[c.label] ||= []).push(c.ms);
    const keys = BROWSER ? await page.evaluate(() => window.__keys) : [];
    result.phases[phase] = {
      asked_per_s: paced ? AGENTS : null,
      calls: calls.length,
      served_per_s: Number((calls.length / wall).toFixed(1)),
      p50_ms: Math.round(q(lat, 0.5)), p95_ms: Math.round(q(lat, 0.95)), p99_ms: Math.round(q(lat, 0.99)), max_ms: Math.round(Math.max(...lat)),
      errors: calls.filter((c) => !c.ok).length,
      first_errors: [...new Set(calls.filter((c) => !c.ok).map((c) => `${c.label}: ${c.error}`))].slice(0, 5),
      ops: Object.fromEntries(Object.entries(byOp).map(([k, v]) => [k, { n: v.length, p50_ms: Math.round(q(v, 0.5)), p95_ms: Math.round(q(v, 0.95)) }])),
      cpu_mean_pct: Math.round(samples.reduce((s, x) => s + x.cpu, 0) / Math.max(1, samples.length)),
      cpu_peak_pct: Math.round(Math.max(0, ...samples.map((x) => x.cpu))),
      rss_peak_mb: Math.round(Math.max(0, ...samples.map((x) => x.rss)) / 1048576),
      comment_shown_ms: BROWSER ? { n: pageOut.shown_ms.length, p50: Math.round(q(pageOut.shown_ms, 0.5)), max: Math.round(Math.max(0, ...pageOut.shown_ms)), not_shown: pageOut.not_shown } : null,
      longest_key_ms: BROWSER ? Math.round(Math.max(0, ...keys)) : null,
      keys_over_16ms: BROWSER ? keys.length : null,
    };
    const ph = result.phases[phase];
    console.log(`${phase}: ${ph.served_per_s} calls/s, p50 ${ms(ph.p50_ms)}, p95 ${ms(ph.p95_ms)}, max ${ms(ph.max_ms)}, ${ph.errors} errors, CPU ${ph.cpu_mean_pct}% (peak ${ph.cpu_peak_pct}%), RSS ${ph.rss_peak_mb} MB` +
      (BROWSER ? `; comment shown p50 ${ms(ph.comment_shown_ms.p50)} max ${ms(ph.comment_shown_ms.max)}, longest key ${ms(ph.longest_key_ms)}` : ''));
    await sleep(2000);
  }

  // every comment the agents and the browser were told was saved is on the ticket
  const t = await must(base, 'get_ticket', { ticket_id: shared, view: 'comments' });
  const text = JSON.stringify(t);
  const missing = [...kept].filter((m) => !text.includes(m));
  result.comments = { saved: kept.size, missing: missing.length, first_missing: missing.slice(0, 5) };
  console.log(`shared ticket: ${kept.size - missing.length} / ${kept.size} comments kept`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
  stopAll();
  database.drop();
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
