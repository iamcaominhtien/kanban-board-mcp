#!/usr/bin/env node
// End-to-end check: the real UI in headless Chromium against the Python and/or the Rust server.
//   node run.mjs --target python|rust|both [--only 03,05] [--group core|ai|all] [--keep-going]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer, stopAll, rustBinary, REPO } from './lib/servers.mjs';
import { Session } from './lib/session.mjs';
import { writeReports } from './lib/diff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  const g = (process.env.NODE_PATH || '').split(path.delimiter).concat(['/usr/lib/node_modules', '/usr/local/lib/node_modules']);
  for (const d of g) { try { ({ chromium } = require(path.join(d, 'playwright'))); break; } catch {} }
}
if (!chromium) { console.error('playwright is not resolvable; it must be installed globally'); process.exit(2); }

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const target = opt('target', 'both');
const only = opt('only', '') ? opt('only', '').split(',') : null;
const groupSel = opt('group', 'all');
if (!['python', 'rust', 'both'].includes(target)) { console.error('--target must be python, rust or both'); process.exit(2); }
const targets = target === 'both' ? ['python', 'rust'] : [target];

const reportDir = path.join(here, 'report');
fs.mkdirSync(reportDir, { recursive: true });
if (!fs.existsSync(path.join(REPO, 'ui/dist/index.html'))) { console.error('ui/dist is missing: cd ui && npm ci && npm run build'); process.exit(2); }

const scenarioFiles = fs.readdirSync(path.join(here, 'scenarios')).filter((f) => /^\d.*\.mjs$/.test(f)).sort();
const scenarios = [];
for (const f of scenarioFiles) {
  const m = (await import(path.join(here, 'scenarios', f))).default;
  m.id = f.replace(/\.mjs$/, '');
  m.group = m.group || 'core';
  if (only && !only.some((o) => m.id.startsWith(o))) continue;
  if (groupSel !== 'all' && m.group !== groupSel) continue;
  scenarios.push(m);
}

for (const f of fs.readdirSync(reportDir)) if (f.endsWith('.png') && (!only || only.some((o) => f.startsWith(o)))) fs.rmSync(path.join(reportDir, f));
const t0 = Date.now();
const browser = await chromium.launch();
const results = {};
let exitCode = 0;
try {
  const jobsN = Number(opt('jobs', '4'));
  for (const tg of targets) results[tg] = new Array(scenarios.length);
  if (targets.includes('rust')) console.log(`rust binary: ${rustBinary()}`);
  // every (target, scenario) is one job with its own server on its own temporary folders; a small pool runs them
  const jobs = [];
  for (const sc of scenarios.map((x, i) => [x, i])) for (const tg of targets) jobs.push({ tg, sc: sc[0], idx: sc[1] });
  const runJob = async ({ tg, sc, idx }) => {
    let server;
    const started = Date.now();
    try {
      server = await startServer(tg);
      const s = await new Session({ browser, server, scenario: sc, reportDir, apiFallback404: tg === 'rust' && !args.includes('--no-api-404') }).open();
      try {
        await sc.run(s);
      } catch (e) {
        s.steps.push({ name: 'scenario body', exchanges: [], console: [], pageErrors: [], failedRequests: [], notes: {}, error: `[${sc.id}] ${e.message}` });
      }
      await s.close();
      const r = s.result();
      r.ms = Date.now() - started;
      results[tg][idx] = r;
      const bad = r.steps.filter((x) => x.error).length;
      console.log(`${tg.padEnd(6)} ${sc.id.padEnd(20)} ${String(r.steps.length).padStart(2)} steps, ${bad} failed, ${(r.ms / 1000).toFixed(0)}s${sc.group === 'ai' ? ' (ai)' : ''}`);
      for (const st of r.steps.filter((x) => x.error)) console.log('   FAIL ' + st.error.slice(0, 300));
    } catch (e) {
      console.log(`${tg.padEnd(6)} ${sc.id.padEnd(20)} SETUP FAILED: ${e.message.split('\n')[0]}`);
      results[tg][idx] = { id: sc.id, name: sc.name, group: sc.group, target: tg, steps: [{ name: 'server start', exchanges: [], console: [], pageErrors: [], failedRequests: [], notes: {}, error: e.message }] };
    } finally {
      if (server) await server.stop();
    }
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobsN, jobs.length) }, async () => {
    while (next < jobs.length) await runJob(jobs[next++]);
  }));
  for (const tg of targets) {
    results[tg] = results[tg].filter(Boolean);
    fs.writeFileSync(path.join(reportDir, `${tg}.json`), JSON.stringify(results[tg], null, 1));
  }
  if (targets.length === 2) writeReports(results.python, results.rust, reportDir);
  for (const tg of targets) {
    const core = results[tg].filter((r) => r.group !== 'ai');
    const fails = core.flatMap((r) => r.steps).filter((s) => s.error).length;
    const errs = core.flatMap((r) => r.steps).filter((s) => (!s.expectedConsole && s.console.length) || s.pageErrors.length).length;
    console.log(`${tg}: core scenarios ${core.length}, failed steps ${fails}, steps with console/page errors ${errs}`);
    if (tg === 'python' && (fails || errs)) exitCode = 1;
    if (tg === 'rust' && fails) exitCode = 1;
  }
} finally {
  await browser.close().catch(() => {});
  stopAll();
  console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
process.exit(exitCode);
